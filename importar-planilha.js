// =============================================================
// DRG-Garantidora — importar-planilha.js
// Módulo: importar planilha (Excel/CSV) de unidades/condôminos.
// A IA mapeia as colunas; o operador escolhe quais linhas importar
// (uma, algumas ou todas). Carregado depois de cadastros.js e
// importar-ia.js. Usa WORKER_GEMINI_URL (de importar-ia.js) e o
// SheetJS (XLSX).
// =============================================================

window.SECTION_RENDERERS = window.SECTION_RENDERERS || {};

// Campos do sistema que a IA mapeia a partir das colunas da planilha.
const CAMPOS_PLANILHA = [
  { id: 'identificacao',     label: 'Identificação da unidade' },
  { id: 'bloco',             label: 'Bloco / Torre' },
  { id: 'fracaoIdeal',       label: 'Fração ideal' },
  { id: 'condominoNome',     label: 'Nome do condômino' },
  { id: 'condominoCpfCnpj',  label: 'CPF / CNPJ do condômino' },
  { id: 'condominoTelefone', label: 'Telefone' },
  { id: 'condominoEmail',    label: 'E-mail' },
  { id: 'condominoTipo',     label: 'Tipo (proprietário/inquilino)' },
];

let plLinhas = null;        // todas as linhas da planilha (objetos)
let plCabecalhos = null;    // array de cabeçalhos
let plCondominioId = null;  // condomínio em contexto
let plMapaFixo = null;      // mapeamento fixo (modo PDF — sem editor de colunas)

// -------------------------------------------------------------
// Helpers
// -------------------------------------------------------------
function plStatus(msg, tipo) {
  const el = document.getElementById('pl-status');
  if (!el) return;
  if (!msg) { el.innerHTML = ''; return; }
  const cls = tipo === 'erro' ? 'alert-error' : tipo === 'ok' ? 'alert-success' : 'alert-info';
  el.innerHTML = `<div class="alert ${cls}">${escapeHtml(msg)}</div>`;
}

function normalizaTipo(v) {
  const s = String(v || '').toLowerCase();
  if (s.includes('inquil') || s.includes('locat')) return 'inquilino';
  if (s.includes('respons')) return 'responsavel';
  return 'proprietario';
}

function lerMapeamentoAtual() {
  if (plMapaFixo) return Object.assign({}, plMapaFixo);
  const m = {};
  CAMPOS_PLANILHA.forEach((c) => {
    const el = document.getElementById('map-' + c.id);
    m[c.id] = el ? el.value : '';
  });
  return m;
}

function plValor(linha, campo, mapa) {
  return mapa[campo] ? String(linha[mapa[campo]] || '').trim() : '';
}

// -------------------------------------------------------------
// 1. Tela de upload (com seletor de condomínio)
// -------------------------------------------------------------
function renderImportarPlanilha() {
  return renderComContexto(
    'Importar planilha (IA)',
    'Suba a planilha de unidades e condôminos — a IA mapeia as colunas e você escolhe quem importar.',
    async (cid) => {
      plCondominioId = cid;
      plLinhas = null;
      plCabecalhos = null;
      plMapaFixo = null;
      document.getElementById('ctx-conteudo').innerHTML = `
        <div class="card">
          <h3>Planilha de unidades / condôminos</h3>
          <p class="muted" style="margin-bottom:14px;">
            Aceita <strong>Excel (.xlsx), CSV ou PDF</strong>. Na planilha: uma linha por unidade, 1ª linha com o cabeçalho. No PDF: a IA lê a lista direto do documento.
          </p>
          <div class="form-group">
            <input type="file" id="pl-arquivo" accept=".xlsx,.xls,.csv,.pdf,application/pdf">
          </div>
          <button class="btn btn-primary" id="pl-btn" onclick="analisarPlanilha()">Analisar arquivo</button>
          <div id="pl-status" style="margin-top:16px;"></div>
        </div>`;
    }
  );
}

// -------------------------------------------------------------
// 2. Análise — lê a planilha e pede o mapeamento à IA
// -------------------------------------------------------------
async function analisarPlanilha() {
  const input = document.getElementById('pl-arquivo');
  const file = input && input.files && input.files[0];
  if (!file) { plStatus('Selecione o arquivo primeiro.', 'erro'); return; }

  const ehPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  if (!ehPdf && typeof XLSX === 'undefined') {
    plStatus('A biblioteca de planilha ainda não carregou — recarregue a página e tente de novo.', 'erro');
    return;
  }

  const btn = document.getElementById('pl-btn');
  btn.disabled = true;
  btn.textContent = 'Analisando…';

  try {
    if (ehPdf) {
      plStatus('A IA está lendo a lista no PDF. Pode levar até um minuto…', 'info');
      const fileBase64 = await lerArquivoBase64(file);
      const res = await fetch(WORKER_GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: await tokenAtual(), modo: 'planilha-pdf', fileBase64, mimeType: 'application/pdf' }),
      });
      const jr = await res.json().catch(() => ({}));
      if (!res.ok || !jr.success) throw new Error(jr.error || `erro ${res.status}`);
      const d = jr.data || {};
      const linhas = Array.isArray(d.linhas) ? d.linhas : [];
      if (!linhas.length) throw new Error('a IA não encontrou nenhuma unidade no PDF');
      plLinhas = linhas;
      plCabecalhos = CAMPOS_PLANILHA.map((c) => c.id);
      plMapaFixo = {};
      CAMPOS_PLANILHA.forEach((c) => { plMapaFixo[c.id] = c.id; });
      renderRevisaoPlanilha({ mapeamento: plMapaFixo, confianca: d.confianca, observacoes: d.observacoes }, true);
      return;
    }

    plStatus('Lendo a planilha e mapeando as colunas com a IA…', 'info');
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const linhas = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    if (!linhas.length) throw new Error('a planilha está vazia');

    plLinhas = linhas;
    plCabecalhos = Object.keys(linhas[0]);
    plMapaFixo = null;

    const res = await fetch(WORKER_GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: await tokenAtual(), modo: 'planilha', cabecalhos: plCabecalhos, amostras: linhas.slice(0, 5) }),
    });
    const jr = await res.json().catch(() => ({}));
    if (!res.ok || !jr.success) throw new Error(jr.error || `erro ${res.status}`);

    renderRevisaoPlanilha(jr.data || {});
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Analisar arquivo';
    plStatus('Falha: ' + (err.message || err) + '. Tente novamente.', 'erro');
  }
}

// -------------------------------------------------------------
// 3. Revisão — mapeamento editável + seleção de linhas
// -------------------------------------------------------------
function renderRevisaoPlanilha(d, pdfMode) {
  const mapa = d.mapeamento || {};
  const confPct = d.confianca != null ? Math.round(d.confianca * 100) : null;
  let nota = '';
  if (confPct != null || d.observacoes) {
    const cls = confPct != null && confPct < 70 ? 'alert-warning' : 'alert-info';
    const partes = [];
    if (confPct != null) partes.push(`Confiança da IA: <strong>${confPct}%</strong>`);
    if (d.observacoes) partes.push(escapeHtml(d.observacoes));
    nota = `<div class="alert ${cls}">${partes.join(' — ')}</div>`;
  }

  const opcoes = (selecionado) => ['<option value="">— ignorar —</option>']
    .concat(plCabecalhos.map((h) =>
      `<option value="${escapeHtml(h)}" ${selecionado === h ? 'selected' : ''}>${escapeHtml(h)}</option>`))
    .join('');

  const linhasMap = CAMPOS_PLANILHA.map((c) => `
    <div class="form-group">
      <label class="${c.id === 'identificacao' ? 'required' : ''}">${escapeHtml(c.label)}</label>
      <select id="map-${c.id}" onchange="renderTabelaPlanilha()">${opcoes(mapa[c.id])}</select>
    </div>`).join('');

  document.getElementById('ctx-conteudo').innerHTML = `
    ${nota}
    ${pdfMode ? `
    <div class="card">
      <h3>Lista lida do PDF</h3>
      <p class="muted" style="margin:0;">A IA extraiu as unidades e condôminos direto do PDF. Confira na tabela abaixo e selecione quem importar.</p>
    </div>` : `
    <div class="card">
      <h3>Mapeamento das colunas</h3>
      <p class="muted" style="margin-bottom:14px;">A IA associou cada campo do sistema a uma coluna da planilha. Ajuste o que estiver errado.</p>
      ${linhasMap}
    </div>`}
    <div class="card">
      <h3>Quem importar</h3>
      <p class="muted" style="margin-bottom:12px;">Marque as linhas que deseja importar — uma, algumas ou todas. <span id="pl-contador"></span></p>
      <div id="pl-tabela"></div>
    </div>
    <div class="card">
      <div id="pl-status" style="margin-bottom:12px;"></div>
      <div style="display:flex;gap:10px;justify-content:flex-end;">
        <button class="btn btn-secondary" onclick="renderSection('importarPlanilha')">Recomeçar</button>
        <button class="btn btn-success" id="pl-btn-importar" onclick="confirmarImportacaoPlanilha()">Importar selecionados</button>
      </div>
    </div>`;
  renderTabelaPlanilha();
}

// Monta a tabela de seleção conforme o mapeamento atual.
function renderTabelaPlanilha() {
  const alvo = document.getElementById('pl-tabela');
  if (!alvo || !plLinhas) return;
  const mapa = lerMapeamentoAtual();

  const corpo = plLinhas.map((l, i) => {
    const ident = plValor(l, 'identificacao', mapa);
    const semId = !ident;
    return `<tr${semId ? ' style="opacity:0.45"' : ''}>
      <td><input type="checkbox" class="pl-row" data-idx="${i}" ${semId ? 'disabled' : 'checked'} onchange="atualizarContadorPlanilha()"></td>
      <td>${escapeHtml(ident || '— sem identificação —')}</td>
      <td>${escapeHtml(plValor(l, 'bloco', mapa) || '—')}</td>
      <td>${escapeHtml(plValor(l, 'condominoNome', mapa) || '—')}</td>
      <td>${escapeHtml(plValor(l, 'condominoCpfCnpj', mapa) || '—')}</td>
      <td>${escapeHtml(plValor(l, 'condominoTelefone', mapa) || '—')}</td>
    </tr>`;
  }).join('');

  alvo.innerHTML = `
    <div class="tabela-wrap" style="max-height:440px;overflow-y:auto;">
      <table class="tabela">
        <thead><tr>
          <th><input type="checkbox" id="pl-todos" checked onclick="togglePlTodos(this)" title="Marcar/desmarcar todos"></th>
          <th>Unidade</th><th>Bloco</th><th>Condômino</th><th>CPF/CNPJ</th><th>Telefone</th>
        </tr></thead>
        <tbody>${corpo}</tbody>
      </table>
    </div>`;
  atualizarContadorPlanilha();
}

function togglePlTodos(master) {
  document.querySelectorAll('.pl-row').forEach((cb) => {
    if (!cb.disabled) cb.checked = master.checked;
  });
  atualizarContadorPlanilha();
}

function atualizarContadorPlanilha() {
  const n = document.querySelectorAll('.pl-row:checked').length;
  const el = document.getElementById('pl-contador');
  if (el) el.textContent = `(${n} de ${plLinhas ? plLinhas.length : 0} selecionada(s))`;
}

// -------------------------------------------------------------
// 4. Importação — cria unidades e condôminos das linhas marcadas
// -------------------------------------------------------------
async function confirmarImportacaoPlanilha() {
  const mapa = lerMapeamentoAtual();
  if (!mapa.identificacao) {
    plStatus('Indique qual coluna tem a identificação da unidade.', 'erro');
    return;
  }

  const selecionadas = Array.from(document.querySelectorAll('.pl-row:checked'))
    .map((cb) => parseInt(cb.dataset.idx, 10));
  if (!selecionadas.length) {
    plStatus('Marque pelo menos uma linha para importar.', 'erro');
    return;
  }

  const cid = plCondominioId;
  const registros = [];
  for (const i of selecionadas) {
    const l = plLinhas[i];
    const ident = plValor(l, 'identificacao', mapa);
    if (!ident) continue;
    const unidade = {
      identificacao: ident,
      bloco: plValor(l, 'bloco', mapa),
      fracaoIdeal: plValor(l, 'fracaoIdeal', mapa),
      ativa: true,
    };
    const nome = plValor(l, 'condominoNome', mapa);
    let condomino = null;
    if (nome) {
      condomino = {
        nome,
        cpfCnpj: soDigitos(plValor(l, 'condominoCpfCnpj', mapa)),
        telefone: soDigitos(plValor(l, 'condominoTelefone', mapa)),
        email: plValor(l, 'condominoEmail', mapa),
        tipo: mapa.condominoTipo ? normalizaTipo(plValor(l, 'condominoTipo', mapa)) : 'proprietario',
      };
    }
    registros.push({ unidade, condomino });
  }

  if (!registros.length) {
    plStatus('Nenhuma linha válida (com identificação) entre as selecionadas.', 'erro');
    return;
  }

  const btn = document.getElementById('pl-btn-importar');
  btn.disabled = true;
  btn.textContent = 'Importando…';
  plStatus(`Criando ${registros.length} unidade(s)…`, 'info');

  try {
    let batch = db.batch();
    let ops = 0;
    let nUnid = 0;
    let nCond = 0;
    for (const reg of registros) {
      const uRef = refSub(cid, 'unidades').doc();
      batch.set(uRef, Object.assign({}, reg.unidade, carimboCriacao()));
      ops++; nUnid++;
      if (reg.condomino) {
        const cRef = refSub(cid, 'condominos').doc();
        batch.set(cRef, Object.assign({}, reg.condomino, { unidadeId: uRef.id }, carimboCriacao()));
        ops++; nCond++;
      }
      if (ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; }
    }
    if (ops > 0) await batch.commit();

    document.getElementById('ctx-conteudo').innerHTML = `
      <div class="card">
        <div class="placeholder-section">
          <h3>Importação concluída</h3>
          <p>${nUnid} unidade(s) e ${nCond} condômino(s) criados a partir da planilha.</p>
          <div style="margin-top:16px;display:flex;gap:10px;justify-content:center;">
            <button class="btn btn-secondary" onclick="renderSection('importarPlanilha')">Importar outra planilha</button>
            <button class="btn btn-primary" onclick="navegarPara('condominos')">Ver os condôminos</button>
          </div>
        </div>
      </div>`;
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Importar selecionados';
    plStatus('Falha ao importar: ' + (err.message || err), 'erro');
  }
}

// -------------------------------------------------------------
SECTION_RENDERERS.importarPlanilha = renderImportarPlanilha;
