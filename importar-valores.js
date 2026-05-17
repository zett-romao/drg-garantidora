// =============================================================
// DRG-Garantidora — importar-valores.js
// Importa, para uma competência, os valores de cada unidade a partir
// da planilha enviada pela administradora. A IA mapeia as colunas e
// concilia as unidades da planilha com as cadastradas; o operador
// revisa e aplica. NÃO emite boletos — só preenche os valores.
//
// Carregado depois de competencias.js. Usa WORKER_GEMINI_URL
// (de importar-ia.js), o SheetJS (XLSX) e os helpers globais.
// =============================================================

let ivCid = null;        // condomínio em contexto
let ivCompId = null;     // competência em contexto
let ivComp = null;       // dados da competência
let ivUnidades = [];     // unidades cadastradas [{id, identificacao, bloco}]
let ivLinhas = null;     // linhas da planilha (objetos)
let ivCabecalhos = null; // cabeçalhos da planilha
let ivMapa = null;       // mapa de colunas sugerido pela IA
let ivMatches = [];      // conciliação posicional (uma unidadeId|null por linha)

// -------------------------------------------------------------
// Helpers
// -------------------------------------------------------------
function ivStatus(msg, tipo) {
  const el = $('iv-status');
  if (!el) return;
  if (!msg) { el.innerHTML = ''; return; }
  const cls = tipo === 'erro' ? 'alert-error' : tipo === 'ok' ? 'alert-success' : 'alert-info';
  el.innerHTML = `<div class="alert ${cls}">${escapeHtml(msg)}</div>`;
}

function lerMapaValores() {
  return {
    identificacao: (($('iv-map-identificacao') || {}).value) || '',
    bloco: (($('iv-map-bloco') || {}).value) || '',
    valor: (($('iv-map-valor') || {}).value) || '',
  };
}

// Converte um valor da planilha em número, tratando o formato BR
// ("R$ 1.234,56", "1.234,56", "450,00") e células já numéricas.
function parseValorBR(v) {
  if (v == null || v === '') return NaN;
  if (typeof v === 'number') return v;
  let s = String(v).replace(/[^\d.,-]/g, '').trim();
  if (!s) return NaN;
  if (s.indexOf(',') > -1 && s.indexOf('.') > -1) {
    s = s.replace(/\./g, '').replace(',', '.');   // ponto = milhar, vírgula = decimal
  } else if (s.indexOf(',') > -1) {
    s = s.replace(',', '.');                       // só vírgula = decimal
  }
  const n = parseFloat(s);
  return isNaN(n) ? NaN : n;
}

// -------------------------------------------------------------
// 1. Entrada — carrega a competência e as unidades
// -------------------------------------------------------------
async function abrirImportarValores(cid, compId) {
  ivCid = cid;
  ivCompId = compId;
  ivComp = null;
  ivLinhas = null;
  ivCabecalhos = null;
  ivMapa = null;
  ivMatches = [];

  const content = $('content');
  content.innerHTML = `<div class="loader">Carregando…</div>`;
  try {
    const [snapComp, snapU] = await Promise.all([
      refSub(cid, 'competencias').doc(compId).get(),
      refSub(cid, 'unidades').orderBy('identificacao').get(),
    ]);
    if (!snapComp.exists) { content.innerHTML = cardErro('Competência não encontrada.'); return; }
    ivComp = snapComp.data();
    ivUnidades = snapU.docs
      .filter((d) => d.data().ativa !== false)
      .map((d) => ({ id: d.id, identificacao: d.data().identificacao || '', bloco: d.data().bloco || '' }));
    renderUploadValores();
  } catch (err) {
    content.innerHTML = cardErro('Falha ao carregar a competência.', err);
  }
}

function renderUploadValores() {
  $('content').innerHTML = `
    <div class="section-head">
      <div><h2>Importar valores — ${escapeHtml(rotuloCompetencia(ivComp))}</h2>
      <p>Suba a planilha da administradora; a IA mapeia as colunas e concilia as unidades.</p></div>
      <button class="btn-voltar-topbar" onclick="abrirCompetencia('${ivCid}','${ivCompId}')">&larr; Competência</button>
    </div>
    <div class="card">
      <h3>Planilha de valores</h3>
      <p class="muted" style="margin-bottom:14px;">
        Aceita Excel (.xlsx/.xls) ou CSV. Uma linha por unidade, e a 1ª linha deve ser o cabeçalho das colunas.
        Os valores não emitem boleto — só preenchem a competência.
      </p>
      <div class="form-group">
        <input type="file" id="iv-arquivo" accept=".xlsx,.xls,.csv">
      </div>
      <button class="btn btn-primary" id="iv-btn" onclick="analisarValores()">Analisar planilha</button>
      <div id="iv-status" style="margin-top:16px;"></div>
    </div>`;
}

// -------------------------------------------------------------
// 2. Análise — lê a planilha, mapeia colunas e concilia (IA)
// -------------------------------------------------------------
async function analisarValores() {
  const input = $('iv-arquivo');
  const file = input && input.files && input.files[0];
  if (!file) { ivStatus('Selecione a planilha primeiro.', 'erro'); return; }
  if (typeof XLSX === 'undefined') {
    ivStatus('A biblioteca de planilha ainda não carregou — recarregue a página e tente de novo.', 'erro');
    return;
  }

  const btn = $('iv-btn');
  btn.disabled = true;
  btn.textContent = 'Analisando…';
  ivStatus('Lendo a planilha e mapeando as colunas com a IA…', 'info');

  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const linhas = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    if (!linhas.length) throw new Error('a planilha está vazia');

    ivLinhas = linhas;
    ivCabecalhos = Object.keys(linhas[0]);

    // IA 1 — mapeamento de colunas
    const r1 = await fetch(WORKER_GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modo: 'valores', cabecalhos: ivCabecalhos, amostras: linhas.slice(0, 5) }),
    });
    const j1 = await r1.json().catch(() => ({}));
    if (!r1.ok || !j1.success) throw new Error(j1.error || `erro ${r1.status}`);
    const mapData = j1.data || {};
    ivMapa = mapData.mapeamento || {};

    // IA 2 — conciliação das unidades da planilha com as cadastradas
    let matchData = {};
    if (ivUnidades.length) {
      ivStatus('Conciliando as unidades da planilha com as cadastradas (IA)…', 'info');
      const r2 = await fetch(WORKER_GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modo: 'conciliar-unidades', unidades: ivUnidades, planilha: planilhaUnidades() }),
      });
      const j2 = await r2.json().catch(() => ({}));
      if (!r2.ok || !j2.success) throw new Error(j2.error || `erro ${r2.status}`);
      matchData = j2.data || {};
    }
    ivMatches = Array.isArray(matchData.matches) ? matchData.matches : [];

    renderRevisaoValores(mapData, matchData);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Analisar planilha';
    ivStatus('Falha: ' + (err.message || err) + '. Tente novamente.', 'erro');
  }
}

// Rótulos de unidade extraídos da planilha, na ordem das linhas (p/ conciliar).
function planilhaUnidades() {
  const mapa = ivMapa || {};
  return ivLinhas.map((l) => ({
    identificacao: mapa.identificacao ? String(l[mapa.identificacao] || '').trim() : '',
    bloco: mapa.bloco ? String(l[mapa.bloco] || '').trim() : '',
  }));
}

// -------------------------------------------------------------
// 3. Revisão — mapa de colunas + tabela de conciliação
// -------------------------------------------------------------
function notaIAValores(mapData, matchData) {
  const partes = [];
  const c1 = mapData ? mapData.confianca : null;
  const c2 = matchData ? matchData.confianca : null;
  if (c1 != null) partes.push(`mapeamento ${Math.round(c1 * 100)}%`);
  if (c2 != null) partes.push(`conciliação ${Math.round(c2 * 100)}%`);
  const obs = [];
  if (mapData && mapData.observacoes) obs.push(mapData.observacoes);
  if (matchData && matchData.observacoes) obs.push(matchData.observacoes);
  if (!partes.length && !obs.length) return '';
  const txt = [
    partes.length ? 'Confiança da IA — ' + partes.join(' · ') : '',
    obs.join(' '),
  ].filter(Boolean).join(' — ');
  const baixa = (c1 != null && c1 < 0.7) || (c2 != null && c2 < 0.7);
  return `<div class="alert ${baixa ? 'alert-warning' : 'alert-info'}">${escapeHtml(txt)}</div>`;
}

function renderRevisaoValores(mapData, matchData) {
  const campos = [
    { id: 'identificacao', label: 'Identificação da unidade', req: true },
    { id: 'bloco', label: 'Bloco / Torre', req: false },
    { id: 'valor', label: 'Valor a cobrar', req: true },
  ];
  const opcoesCol = (sel) => ['<option value="">— ignorar —</option>']
    .concat(ivCabecalhos.map((h) =>
      `<option value="${escapeHtml(h)}" ${sel === h ? 'selected' : ''}>${escapeHtml(h)}</option>`))
    .join('');
  const mapaHtml = campos.map((c) => `
    <div class="form-group">
      <label class="${c.req ? 'required' : ''}">${escapeHtml(c.label)}</label>
      <select id="iv-map-${c.id}" onchange="renderTabelaValores()">${opcoesCol((ivMapa || {})[c.id])}</select>
    </div>`).join('');

  $('content').innerHTML = `
    <div class="section-head">
      <div><h2>Importar valores — ${escapeHtml(rotuloCompetencia(ivComp))}</h2>
      <p>Revise o mapeamento e a conciliação antes de aplicar.</p></div>
      <button class="btn-voltar-topbar" onclick="abrirCompetencia('${ivCid}','${ivCompId}')">&larr; Competência</button>
    </div>
    ${notaIAValores(mapData, matchData)}
    <div class="card">
      <h3>Mapeamento das colunas</h3>
      <p class="muted" style="margin-bottom:14px;">A IA associou as colunas da planilha. Ajuste o que estiver errado.</p>
      ${mapaHtml}
    </div>
    <div class="card">
      <h3>Conciliação das unidades</h3>
      <p class="muted" style="margin-bottom:10px;">
        Cada linha da planilha foi casada com uma unidade cadastrada. Corrija no seletor o que estiver errado;
        linhas sem unidade ou sem valor válido vêm desmarcadas. <span id="iv-contador"></span>
      </p>
      <div style="text-align:right;margin-bottom:8px;">
        <button class="btn btn-secondary btn-sm" onclick="reconciliarValores()">Reconciliar com a IA</button>
      </div>
      <div id="iv-tabela"></div>
    </div>
    <div class="card">
      <div id="iv-status" style="margin-bottom:12px;"></div>
      <div style="display:flex;gap:10px;justify-content:flex-end;">
        <button class="btn btn-secondary" onclick="abrirCompetencia('${ivCid}','${ivCompId}')">Cancelar</button>
        <button class="btn btn-success" id="iv-btn-aplicar" onclick="aplicarValores()">Aplicar valores</button>
      </div>
    </div>`;
  renderTabelaValores();
}

// Monta a tabela de conciliação conforme o mapeamento atual.
function renderTabelaValores() {
  const alvo = $('iv-tabela');
  if (!alvo || !ivLinhas) return;
  const mapa = lerMapaValores();

  const opcoesUnidade = (sel) => ['<option value="">— nenhuma —</option>']
    .concat(ivUnidades.map((u) => {
      const rot = (u.identificacao || '(sem identificação)') + (u.bloco ? ' — ' + u.bloco : '');
      return `<option value="${escapeHtml(u.id)}" ${sel === u.id ? 'selected' : ''}>${escapeHtml(rot)}</option>`;
    })).join('');

  const corpo = ivLinhas.map((l, i) => {
    const rotuloPlan = [
      mapa.identificacao ? String(l[mapa.identificacao] || '').trim() : '',
      mapa.bloco ? String(l[mapa.bloco] || '').trim() : '',
    ].filter(Boolean).join(' — ') || '— sem identificação —';
    const valor = parseValorBR(mapa.valor ? l[mapa.valor] : '');
    const valorOk = valor > 0;
    const matchId = ivMatches[i] || '';
    const aplicavel = !!matchId && valorOk;
    return `<tr${aplicavel ? '' : ' style="background:var(--warning-light)"'}>
      <td><input type="checkbox" class="iv-row" data-idx="${i}" ${aplicavel ? 'checked' : ''} onchange="atualizarContadorValores()"></td>
      <td>${escapeHtml(rotuloPlan)}</td>
      <td><select class="iv-match" data-idx="${i}" onchange="aoMudarMatchValores(this)">${opcoesUnidade(matchId)}</select></td>
      <td>${valorOk ? escapeHtml(fmtMoeda(valor)) : '<span class="badge badge-danger">valor inválido</span>'}</td>
    </tr>`;
  }).join('');

  alvo.innerHTML = `
    <div class="tabela-wrap" style="max-height:440px;overflow-y:auto;">
      <table class="tabela">
        <thead><tr>
          <th><input type="checkbox" id="iv-todos" checked onclick="toggleIvTodos(this)" title="Marcar/desmarcar todos"></th>
          <th>Unidade na planilha</th><th>Unidade cadastrada</th><th>Valor</th>
        </tr></thead>
        <tbody>${corpo}</tbody>
      </table>
    </div>`;
  atualizarContadorValores();
}

function aoMudarMatchValores(sel) {
  const cb = document.querySelector(`.iv-row[data-idx="${sel.dataset.idx}"]`);
  if (cb && sel.value) cb.checked = true;   // escolheu uma unidade → marca a linha
  atualizarContadorValores();
}

function toggleIvTodos(master) {
  document.querySelectorAll('.iv-row').forEach((cb) => { cb.checked = master.checked; });
  atualizarContadorValores();
}

function atualizarContadorValores() {
  const n = document.querySelectorAll('.iv-row:checked').length;
  const el = $('iv-contador');
  if (el) el.textContent = `(${n} de ${ivLinhas ? ivLinhas.length : 0} marcada(s))`;
}

// Refaz só a conciliação (IA) com o mapeamento de colunas atual.
async function reconciliarValores() {
  const mapa = lerMapaValores();
  if (!mapa.identificacao) { ivStatus('Defina a coluna de identificação antes de reconciliar.', 'erro'); return; }
  if (!ivUnidades.length) { ivStatus('Não há unidades cadastradas para conciliar.', 'erro'); return; }
  ivStatus('Reconciliando as unidades com a IA…', 'info');
  try {
    const r = await fetch(WORKER_GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modo: 'conciliar-unidades', unidades: ivUnidades, planilha: planilhaUnidades() }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.success) throw new Error(j.error || `erro ${r.status}`);
    ivMatches = Array.isArray((j.data || {}).matches) ? j.data.matches : [];
    renderTabelaValores();
    ivStatus('Unidades reconciliadas pela IA.', 'ok');
  } catch (err) {
    ivStatus('Falha ao reconciliar: ' + (err.message || err), 'erro');
  }
}

// -------------------------------------------------------------
// 4. Aplicar — grava os valores nas unidades da competência
// -------------------------------------------------------------
async function aplicarValores() {
  const mapa = lerMapaValores();
  if (!mapa.identificacao) { ivStatus('Indique a coluna de identificação da unidade.', 'erro'); return; }
  if (!mapa.valor) { ivStatus('Indique a coluna do valor a cobrar.', 'erro'); return; }

  const marcadas = Array.from(document.querySelectorAll('.iv-row:checked'));
  if (!marcadas.length) { ivStatus('Marque ao menos uma linha para aplicar.', 'erro'); return; }

  const novos = {};       // unidadeId -> valor
  let ignoradas = 0;
  marcadas.forEach((cb) => {
    const i = parseInt(cb.dataset.idx, 10);
    const sel = document.querySelector(`.iv-match[data-idx="${i}"]`);
    const uid = sel ? sel.value : '';
    const valor = parseValorBR(mapa.valor ? ivLinhas[i][mapa.valor] : '');
    if (!uid || !(valor > 0)) { ignoradas++; return; }
    novos[uid] = valor;   // se a mesma unidade aparecer duas vezes, a última vence
  });

  const qtd = Object.keys(novos).length;
  if (!qtd) {
    ivStatus('Nenhuma linha aplicável — cada linha precisa de uma unidade e um valor válido.', 'erro');
    return;
  }

  const ok = await confirmar({
    titulo: 'Aplicar valores',
    mensagem: `Preencher o valor de ${qtd} unidade(s) na competência` +
      (ignoradas ? ` (${ignoradas} linha(s) ignorada(s) por falta de unidade ou valor válido)` : '') +
      `? Isso substitui o valor atual dessas unidades.`,
    okLabel: 'Aplicar',
  });
  if (!ok) return;

  const btn = $('iv-btn-aplicar');
  if (btn) { btn.disabled = true; btn.textContent = 'Aplicando…'; }
  try {
    const valores = Object.assign({}, ivComp.valores || {}, novos);
    await refSub(ivCid, 'competencias').doc(ivCompId).update({ valores });
    await abrirCompetencia(ivCid, ivCompId);
    showAlert('comp-status', `${qtd} valor(es) importado(s) da planilha.`, 'success');
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = 'Aplicar valores'; }
    ivStatus('Falha ao aplicar: ' + (err.message || err), 'erro');
  }
}
