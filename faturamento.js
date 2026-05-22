// =============================================================
// DRG-Garantidora — faturamento.js
// Faturamento & Boletos: registro de TODOS os boletos emitidos de um
// condomínio (cotas + honorários), de todas as competências, com filtros
// por situação, tipo e competência. Só leitura — a emissão é em Competências.
// Carregado depois de competencias.js (usa badgeBoleto).
// =============================================================

window.SECTION_RENDERERS = window.SECTION_RENDERERS || {};

const FAT_PAGO = ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'];
let fatBolCtx = null;
// Filtros pré-selecionados ao chegar de outra tela (ex.: Painel Financeiro).
let fatFiltroInicial = null;
let fatTipoInicial = null;
let fatCompInicial = null;

function fatHojeISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fatSituacao(b) {
  if (b.status === 'CANCELADO') return 'cancelado';
  if (FAT_PAGO.indexOf(b.status || 'PENDING') !== -1) return 'pago';
  if (b.vencimento && b.vencimento < fatHojeISO()) return 'vencido';
  return 'aberto';
}

// Abre o Faturamento & Boletos já filtrado — chamado pelo Painel Financeiro.
function abrirFaturamentoFiltrado(situacao, tipo, compId) {
  fatFiltroInicial = situacao || 'todos';
  fatTipoInicial = tipo || 'todos';
  fatCompInicial = compId || 'todas';
  navegarPara('faturamento');
}

function renderFaturamento() {
  return renderComContexto(
    'Faturamento & Boletos',
    'Todos os boletos emitidos do condomínio — cotas e honorários.',
    async (cid) => {
      const [snapB, snapU, snapC, snapComp] = await Promise.all([
        refSub(cid, 'boletos').get(),
        refSub(cid, 'unidades').get(),
        refSub(cid, 'condominos').get(),
        refSub(cid, 'competencias').get(),
      ]);
      const uni = {};
      snapU.docs.forEach((d) => { uni[d.id] = d.data(); });
      const cond = {};
      snapC.docs.forEach((d) => { cond[d.id] = d.data(); });
      const comp = {};
      const compOrdem = {};
      snapComp.docs.forEach((d) => {
        const c = d.data();
        comp[d.id] = c;
        compOrdem[d.id] = (c.ano || 0) * 100 + (c.mes || 0);
      });
      const boletos = snapB.docs.map((d) => Object.assign({ _id: d.id }, d.data()));

      fatBolCtx = { cid, boletos, uni, cond, comp };

      // filtros vindos de outra tela (consumidos uma vez)
      const fSit = fatFiltroInicial || 'todos';
      const fTipo = fatTipoInicial || 'todos';
      const fComp = fatCompInicial || 'todas';
      fatFiltroInicial = null;
      fatTipoInicial = null;
      fatCompInicial = null;

      const sel = (v, atual) => (v === atual ? ' selected' : '');
      const optsComp = Object.keys(comp)
        .sort((a, z) => (compOrdem[z] || 0) - (compOrdem[a] || 0))
        .map((id) => `<option value="${id}"${sel(id, fComp)}>${escapeHtml(rotuloCompetencia(comp[id]))}</option>`)
        .join('');

      document.getElementById('ctx-conteudo').innerHTML = `
        <div style="display:flex;justify-content:flex-end;margin-bottom:12px;">
          <button class="btn btn-secondary" onclick="relatorioFaturamento()">Relatório</button>
        </div>
        <div class="card">
          <div style="display:flex;gap:14px;flex-wrap:wrap;">
            <div class="form-group" style="max-width:220px;margin-bottom:4px;">
              <label>Situação</label>
              <select id="fat-filtro" onchange="renderTabelaFaturamento()">
                <option value="todos"${sel('todos', fSit)}>Todas</option>
                <option value="aberto"${sel('aberto', fSit)}>Em aberto</option>
                <option value="vencido"${sel('vencido', fSit)}>Vencidos</option>
                <option value="pago"${sel('pago', fSit)}>Pagos</option>
                <option value="cancelado"${sel('cancelado', fSit)}>Cancelados</option>
              </select>
            </div>
            <div class="form-group" style="max-width:220px;margin-bottom:4px;">
              <label>Tipo</label>
              <select id="fat-tipo" onchange="renderTabelaFaturamento()">
                <option value="todos"${sel('todos', fTipo)}>Cotas + honorários</option>
                <option value="cota"${sel('cota', fTipo)}>Só cotas</option>
                <option value="honorario"${sel('honorario', fTipo)}>Só honorários</option>
              </select>
            </div>
            <div class="form-group" style="max-width:240px;margin-bottom:4px;">
              <label>Competência</label>
              <select id="fat-comp" onchange="renderTabelaFaturamento()">
                <option value="todas"${sel('todas', fComp)}>Todas</option>
                ${optsComp}
              </select>
            </div>
          </div>
          <div id="fat-tabela" style="margin-top:14px;"></div>
        </div>`;
      renderTabelaFaturamento();
    },
  );
}

function renderTabelaFaturamento() {
  const ctx = fatBolCtx;
  const alvo = document.getElementById('fat-tabela');
  if (!ctx || !alvo) return;
  const filtro = (($('fat-filtro') || {}).value) || 'todos';
  const tipo = (($('fat-tipo') || {}).value) || 'todos';
  const compFiltro = (($('fat-comp') || {}).value) || 'todas';

  const lista = ctx.boletos
    .filter((b) => {
      if (filtro !== 'todos' && fatSituacao(b) !== filtro) return false;
      if (tipo === 'cota' && b.tipo === 'honorario') return false;
      if (tipo === 'honorario' && b.tipo !== 'honorario') return false;
      if (compFiltro !== 'todas' && b.competenciaId !== compFiltro) return false;
      return true;
    })
    .sort((a, z) => String(z.vencimento || '').localeCompare(String(a.vencimento || '')));

  if (!lista.length) {
    alvo.innerHTML = '<div class="empty-state">Nenhum boleto nesta seleção.</div>';
    return;
  }

  let totalValor = 0;
  const linhas = lista.map((b) => {
    totalValor += Number(b.valor) || 0;
    const honorario = b.tipo === 'honorario';
    const destino = honorario
      ? 'Honorários — condomínio'
      : ((ctx.uni[b.unidadeId] || {}).identificacao || '—');
    const compTxt = b.competenciaId && ctx.comp[b.competenciaId]
      ? rotuloCompetencia(ctx.comp[b.competenciaId]) : '—';
    const link = b.invoiceUrl
      ? ` <a href="${escapeHtml(b.invoiceUrl)}" target="_blank" rel="noopener">2ª via</a>` : '';
    const sit = fatSituacao(b);
    const acaoFat = (podeEditar() && (sit === 'aberto' || sit === 'vencido') && b.asaasPaymentId)
      ? `<button class="btn btn-danger btn-sm" onclick="cancelarBoletoFat('${b._id}','${b.asaasPaymentId}')">Cancelar</button>`
      : '';
    return `<tr>
      <td>${escapeHtml(compTxt)}</td>
      <td>${escapeHtml(destino)}</td>
      <td>${escapeHtml(fmtData(b.vencimento))}</td>
      <td class="col-num">${escapeHtml(fmtMoeda(b.valor))}</td>
      <td>${badgeBoleto(b)}${link}</td>
      <td class="acoes">${acaoFat}</td>
    </tr>`;
  }).join('');

  alvo.innerHTML = `
    <div class="tabela-wrap" style="max-height:480px;overflow-y:auto;">
      <table class="tabela">
        <thead><tr><th>Competência</th><th>Destino</th><th>Vencimento</th><th>Valor</th><th>Situação</th><th>Ações</th></tr></thead>
        <tbody>${linhas}</tbody>
      </table>
    </div>
    <p style="margin-top:12px;">${lista.length} boleto(s) · total ${escapeHtml(fmtMoeda(totalValor))}</p>`;
}

// Cancela um boleto: exclui no Asaas e marca como CANCELADO no Firestore.
async function cancelarBoletoFat(docId, asaasPaymentId) {
  const ctx = fatBolCtx;
  if (!ctx) return;
  const ok = await confirmar({
    titulo: 'Cancelar boleto',
    mensagem: 'Cancelar este boleto? Ele é excluído no Asaas e marcado como cancelado aqui. Não dá pra desfazer.',
    okLabel: 'Cancelar boleto', perigo: true,
  });
  if (!ok) return;
  try {
    const r = await fetch(`${WORKER_ASAAS_URL}/cancelar-boleto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: await tokenAtual(), asaasPaymentId }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.success) throw new Error(j.error || 'falha ao cancelar');
    await refSub(ctx.cid, 'boletos').doc(docId).update({
      status: 'CANCELADO',
      atualizadoEm: firebase.firestore.FieldValue.serverTimestamp(),
    });
    renderFaturamento();
  } catch (err) {
    alert('Falha ao cancelar: ' + (err.message || err));
  }
}

function relatorioFaturamento() {
  const ctx = fatBolCtx;
  if (!ctx) return;
  const filtro = (($('fat-filtro') || {}).value) || 'todos';
  const tipo = (($('fat-tipo') || {}).value) || 'todos';
  const compFiltro = (($('fat-comp') || {}).value) || 'todas';
  const lista = ctx.boletos.filter((b) => {
    if (filtro !== 'todos' && fatSituacao(b) !== filtro) return false;
    if (tipo === 'cota' && b.tipo === 'honorario') return false;
    if (tipo === 'honorario' && b.tipo !== 'honorario') return false;
    if (compFiltro !== 'todas' && b.competenciaId !== compFiltro) return false;
    return true;
  }).sort((a, z) => String(z.vencimento || '').localeCompare(String(a.vencimento || '')));
  const rotSit = { aberto: 'Em aberto', vencido: 'Vencido', pago: 'Pago', cancelado: 'Cancelado' };
  let total = 0;
  const linhas = lista.map((b) => {
    total += Number(b.valor) || 0;
    const destino = b.tipo === 'honorario'
      ? 'Honorários — condomínio'
      : ((ctx.uni[b.unidadeId] || {}).identificacao || '—');
    const compTxt = (b.competenciaId && ctx.comp[b.competenciaId])
      ? rotuloCompetencia(ctx.comp[b.competenciaId]) : '—';
    return [compTxt, destino, fmtData(b.vencimento), fmtMoeda(b.valor), rotSit[fatSituacao(b)] || '—'];
  });
  abrirRelatorio('Relatório de Faturamento & Boletos', condominioContextoNome(),
    ['Competência', 'Destino', 'Vencimento', 'Valor', 'Situação'], linhas,
    `Total dos boletos listados: ${fmtMoeda(total)}`, 'faturamento');
}

SECTION_RENDERERS.faturamento = renderFaturamento;
