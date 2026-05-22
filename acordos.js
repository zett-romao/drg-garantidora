// =============================================================
// DRG-Garantidora — acordos.js
// Acordos de pagamento com inadimplentes: extrajudicial ou judicial
// (com nº do processo e tribunal) e as parcelas negociadas.
// Carregado depois de cadastros.js. Usa os helpers globais.
// =============================================================

window.SECTION_RENDERERS = window.SECTION_RENDERERS || {};

let acCtx = null; // { cid, condominos, unidades, acordos }

const AC_SITUACOES = { ativo: 'Ativo', quitado: 'Quitado', rompido: 'Rompido' };

function acHojeISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// "Nome do condômino — Unidade", a partir do contexto carregado.
function acRotuloCondomino(condId) {
  const c = (acCtx && acCtx.condominos[condId]) || {};
  const uni = (c.unidadeId && acCtx && acCtx.unidades[c.unidadeId]) || null;
  return (c.nome || '—') + (uni ? ` — ${uni.identificacao || ''}` : '');
}

function acBadgeTipo(tipo) {
  return tipo === 'judicial'
    ? '<span class="badge badge-warning">Judicial</span>'
    : '<span class="badge badge-info">Extrajudicial</span>';
}

function acBadgeSituacao(s) {
  const cls = s === 'quitado' ? 'badge-success' : s === 'rompido' ? 'badge-danger' : 'badge-info';
  return `<span class="badge ${cls}">${escapeHtml(AC_SITUACOES[s] || 'Ativo')}</span>`;
}

function acTotalParcelas(parcelas) {
  return (parcelas || []).reduce((s, p) => s + (Number(p.valor) || 0), 0);
}

// -------------------------------------------------------------
// Lista de acordos
// -------------------------------------------------------------
function renderAcordos() {
  return renderComContexto(
    'Acordos',
    'Acordos de pagamento com inadimplentes — extrajudiciais e judiciais.',
    async (cid) => {
      const [snapA, snapC, snapU] = await Promise.all([
        refSub(cid, 'acordos').get(),
        refSub(cid, 'condominos').get(),
        refSub(cid, 'unidades').get(),
      ]);
      const condominos = {};
      snapC.docs.forEach((d) => { condominos[d.id] = d.data(); });
      const unidades = {};
      snapU.docs.forEach((d) => { unidades[d.id] = d.data(); });
      const acordos = snapA.docs.map((d) => Object.assign({ _id: d.id }, d.data()));
      acCtx = { cid, condominos, unidades, acordos };
      renderTelaAcordos();
    },
  );
}

function renderTelaAcordos() {
  const ctx = acCtx;
  const linhas = ctx.acordos
    .slice()
    .sort((a, z) => String(z.dataAcordo || '').localeCompare(String(a.dataAcordo || '')))
    .map((a) => {
      const np = (a.parcelas || []).length;
      const proc = (a.tipo === 'judicial' && a.numeroProcesso)
        ? `<div class="muted" style="font-size:11px;">Proc. ${escapeHtml(a.numeroProcesso)}${a.tribunal ? ' · ' + escapeHtml(a.tribunal) : ''}</div>`
        : '';
      const acoes = podeEditar('acordos')
        ? `<button class="btn btn-secondary btn-sm" onclick="abrirFormAcordo('${a._id}')">Editar</button>
           <button class="btn btn-danger btn-sm" onclick="excluirAcordo('${a._id}')">Excluir</button>`
        : '';
      return `<tr>
        <td>${escapeHtml(acRotuloCondomino(a.condominoId))}</td>
        <td>${acBadgeTipo(a.tipo)}${proc}</td>
        <td>${escapeHtml(fmtData(a.dataAcordo))}</td>
        <td class="col-num">${np} parc. · ${escapeHtml(fmtMoeda(acTotalParcelas(a.parcelas)))}</td>
        <td>${acBadgeSituacao(a.situacao)}</td>
        <td class="acoes">${acoes}</td>
      </tr>`;
    }).join('');

  const tabela = ctx.acordos.length
    ? `<div class="tabela-wrap"><table class="tabela">
         <thead><tr><th>Condômino</th><th>Tipo</th><th>Data</th><th>Parcelas</th><th>Situação</th><th>Ações</th></tr></thead>
         <tbody>${linhas}</tbody></table></div>`
    : '<div class="empty-state">Nenhum acordo registrado.</div>';

  const novo = podeEditar('acordos')
    ? `<div style="display:flex;justify-content:flex-end;margin-bottom:12px;">
         <button class="btn btn-primary" onclick="abrirFormAcordo()">+ Novo acordo</button>
       </div>`
    : '';
  document.getElementById('ctx-conteudo').innerHTML = `${novo}<div class="card">${tabela}</div>`;
}

// -------------------------------------------------------------
// Formulário de acordo
// -------------------------------------------------------------
function abrirFormAcordo(id) {
  const ctx = acCtx;
  if (!ctx) return;
  const a = id ? (ctx.acordos.find((x) => x._id === id) || {}) : {};
  const sel = (v, atual) => (v === atual ? ' selected' : '');

  const optsCond = Object.keys(ctx.condominos)
    .sort((x, z) => String((ctx.condominos[x] || {}).nome || '')
      .localeCompare(String((ctx.condominos[z] || {}).nome || ''), 'pt-BR'))
    .map((cid) => `<option value="${cid}"${a.condominoId === cid ? ' selected' : ''}>${escapeHtml(acRotuloCondomino(cid))}</option>`)
    .join('');

  const corpo = `
    ${campo('Condômino', `<select id="ac-condomino">${optsCond || '<option value="">— nenhum condômino cadastrado —</option>'}</select>`, true)}
    ${campo('Tipo do acordo', `<select id="ac-tipo" onchange="acordoToggleJudicial()">
       <option value="extrajudicial"${sel('extrajudicial', a.tipo || 'extrajudicial')}>Extrajudicial</option>
       <option value="judicial"${sel('judicial', a.tipo)}>Judicial</option>
     </select>`, true)}
    <div id="ac-judicial" style="display:${a.tipo === 'judicial' ? 'block' : 'none'};">
      <div class="form-row">
        ${campo('Nº do processo', inputTexto('ac-processo', a.numeroProcesso))}
        ${campo('Tribunal competente', inputTexto('ac-tribunal', a.tribunal))}
      </div>
    </div>
    <div class="form-row">
      ${campo('Data do acordo', `<input type="date" id="ac-data" value="${escapeHtml(a.dataAcordo || acHojeISO())}">`)}
      ${campo('Situação', `<select id="ac-situacao">
        <option value="ativo"${sel('ativo', a.situacao || 'ativo')}>Ativo</option>
        <option value="quitado"${sel('quitado', a.situacao)}>Quitado</option>
        <option value="rompido"${sel('rompido', a.situacao)}>Rompido</option>
      </select>`)}
    </div>
    ${separadorForm('Parcelas do acordo')}
    <p class="muted" style="font-size:12px;margin-bottom:10px;">Informe o início, o número de parcelas (ou a data em "Repetir até") e o valor de cada uma — depois clique em "Gerar parcelas". A lista gerada continua editável.</p>
    <div class="form-row-3">
      ${campo('Início dos pagamentos', '<input type="date" id="ac-pc-inicio">')}
      ${campo('Número de parcelas', '<input type="number" id="ac-pc-num" min="1" step="1" placeholder="Ex: 24">')}
      ${campo('Valor de cada parcela (R$)', '<input type="number" id="ac-pc-valor" step="0.01" placeholder="Ex: 250">')}
    </div>
    <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;margin-bottom:12px;">
      <div class="form-group" style="margin:0;max-width:200px;">
        <label>Repetir até (opcional)</label>
        <input type="date" id="ac-pc-ate">
      </div>
      <button type="button" class="btn btn-primary btn-sm" style="margin-bottom:9px;" onclick="acordoGerarParcelas()">Gerar parcelas</button>
    </div>
    <div id="ac-parcelas"></div>
    <button type="button" class="btn btn-secondary btn-sm" onclick="acordoParcelaAdd()" style="margin-bottom:6px;">+ Adicionar parcela avulsa</button>
    ${campo('Observações', `<textarea id="ac-obs" rows="2">${escapeHtml(a.observacoes || '')}</textarea>`)}`;

  abrirModalForm(id ? 'Editar acordo' : 'Novo acordo', corpo, () => salvarAcordo(id), 'Salvar acordo');
  acordoParcelasRender((a.parcelas && a.parcelas.length) ? a.parcelas : [{ vencimento: '', valor: null }]);
}

// Mostra/esconde os campos de processo e tribunal conforme o tipo.
function acordoToggleJudicial() {
  const t = document.getElementById('ac-tipo');
  const div = document.getElementById('ac-judicial');
  if (div) div.style.display = (t && t.value === 'judicial') ? 'block' : 'none';
}

// -------------------------------------------------------------
// Editor de parcelas
// -------------------------------------------------------------
function acordoParcelasRender(parcelas) {
  const cont = document.getElementById('ac-parcelas');
  if (!cont) return;
  if (!parcelas || !parcelas.length) {
    cont.innerHTML = '<p class="muted" style="font-size:12px;margin-bottom:8px;">Nenhuma parcela — clique em “+ Adicionar parcela”.</p>';
    return;
  }
  cont.innerHTML = parcelas.map((p, i) => `
    <div class="parcela-row" style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:8px;">
      <div class="form-group" style="margin:0;flex:1;min-width:150px;">
        <label>Vencimento ${i + 1}ª</label>
        <input type="date" class="pc-venc" value="${escapeHtml(p.vencimento || '')}">
      </div>
      <div class="form-group" style="margin:0;flex:1;min-width:120px;">
        <label>Valor (R$)</label>
        <input type="number" step="0.01" class="pc-valor" value="${p.valor != null ? p.valor : ''}">
      </div>
      <button type="button" class="btn btn-danger btn-sm" style="margin-bottom:9px;" onclick="acordoParcelaRemover(${i})">Remover</button>
    </div>`).join('');
}

function acordoParcelasLer() {
  const cont = document.getElementById('ac-parcelas');
  const out = [];
  if (!cont) return out;
  cont.querySelectorAll('.parcela-row').forEach((row) => {
    const v = row.querySelector('.pc-venc').value;
    const val = row.querySelector('.pc-valor').value;
    out.push({ vencimento: v || '', valor: val === '' ? null : Number(val) });
  });
  return out;
}

function acordoParcelaAdd() {
  const p = acordoParcelasLer();
  p.push({ vencimento: '', valor: null });
  acordoParcelasRender(p);
}

function acordoParcelaRemover(i) {
  const p = acordoParcelasLer();
  p.splice(i, 1);
  acordoParcelasRender(p);
}

// Gera a lista de parcelas mensais — início + número (ou "repetir até") + valor.
function acordoGerarParcelas() {
  const inicio = valId('ac-pc-inicio');
  const valor = Number(valId('ac-pc-valor')) || 0;
  const ate = valId('ac-pc-ate');
  let num = parseInt(valId('ac-pc-num'), 10);
  if (!inicio) { erroModal('Informe o início dos pagamentos.'); return; }
  if (!(valor > 0)) { erroModal('Informe o valor de cada parcela.'); return; }
  if (!(num > 0) && ate) {
    const pi = inicio.split('-').map(Number);
    const pa = ate.split('-').map(Number);
    num = (pa[0] * 12 + pa[1]) - (pi[0] * 12 + pi[1]) + 1;
  }
  if (!(num > 0)) { erroModal('Informe o número de parcelas ou a data em "Repetir até".'); return; }
  if (num > 240) { erroModal('Número de parcelas muito alto (máximo 240).'); return; }
  const parcelas = [];
  for (let i = 0; i < num; i++) {
    parcelas.push({ vencimento: somarMeses(inicio, i), valor });
  }
  acordoParcelasRender(parcelas);
  const numEl = document.getElementById('ac-pc-num');
  if (numEl) numEl.value = num;
  const ateEl = document.getElementById('ac-pc-ate');
  if (ateEl) ateEl.value = somarMeses(inicio, num - 1);
}

// -------------------------------------------------------------
// Salvar / excluir
// -------------------------------------------------------------
async function salvarAcordo(id) {
  const ctx = acCtx;
  if (!ctx) return;
  const condominoId = valId('ac-condomino');
  if (!condominoId) { erroModal('Selecione o condômino do acordo.'); return; }
  const tipo = valId('ac-tipo') || 'extrajudicial';
  const parcelas = acordoParcelasLer().filter((p) => p.vencimento || p.valor != null);
  if (!parcelas.length) { erroModal('Adicione pelo menos uma parcela.'); return; }

  const cond = ctx.condominos[condominoId] || {};
  const dados = {
    condominoId,
    unidadeId: cond.unidadeId || null,
    tipo,
    numeroProcesso: tipo === 'judicial' ? valId('ac-processo') : '',
    tribunal: tipo === 'judicial' ? valId('ac-tribunal') : '',
    dataAcordo: valId('ac-data') || null,
    parcelas,
    observacoes: valId('ac-obs'),
    situacao: valId('ac-situacao') || 'ativo',
  };

  travarSalvar(true);
  try {
    if (id) {
      await refSub(ctx.cid, 'acordos').doc(id).update(dados);
    } else {
      await refSub(ctx.cid, 'acordos').add(Object.assign(dados, carimboCriacao()));
    }
    fecharModalForm();
    renderAcordos();
  } catch (err) {
    travarSalvar(false, 'Salvar acordo');
    erroModal('Falha ao salvar: ' + (err.message || err));
  }
}

async function excluirAcordo(id) {
  const ctx = acCtx;
  if (!ctx) return;
  const ok = await confirmar({
    titulo: 'Excluir acordo',
    mensagem: 'Excluir este acordo? Não dá pra desfazer.',
    okLabel: 'Excluir', perigo: true,
  });
  if (!ok) return;
  try {
    await refSub(ctx.cid, 'acordos').doc(id).delete();
    renderAcordos();
  } catch (err) {
    alert('Falha ao excluir: ' + (err.message || err));
  }
}

SECTION_RENDERERS.acordos = renderAcordos;
