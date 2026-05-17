// =============================================================
// DRG-Garantidora — faturamento.js
// Faturamento & Boletos: registro de TODOS os boletos emitidos de um
// condomínio (cotas + honorários), de todas as competências, com filtro
// por situação. Só leitura — a emissão é feita em Competências.
// Carregado depois de competencias.js (usa badgeBoleto).
// =============================================================

window.SECTION_RENDERERS = window.SECTION_RENDERERS || {};

const FAT_PAGO = ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'];
let fatBolCtx = null;

function fatHojeISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fatSituacao(b) {
  if (FAT_PAGO.indexOf(b.status || 'PENDING') !== -1) return 'pago';
  if (b.vencimento && b.vencimento < fatHojeISO()) return 'vencido';
  return 'aberto';
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
      snapComp.docs.forEach((d) => { comp[d.id] = d.data(); });
      const boletos = snapB.docs.map((d) => Object.assign({ _id: d.id }, d.data()));

      fatBolCtx = { boletos, uni, cond, comp };
      document.getElementById('ctx-conteudo').innerHTML = `
        <div class="card">
          <div class="form-group" style="max-width:240px;margin-bottom:4px;">
            <label>Filtrar por situação</label>
            <select id="fat-filtro" onchange="renderTabelaFaturamento()">
              <option value="todos">Todos</option>
              <option value="aberto">Em aberto</option>
              <option value="vencido">Vencidos</option>
              <option value="pago">Pagos</option>
            </select>
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

  const lista = ctx.boletos
    .filter((b) => filtro === 'todos' || fatSituacao(b) === filtro)
    .sort((a, z) => String(z.vencimento || '').localeCompare(String(a.vencimento || '')));

  if (!lista.length) {
    alvo.innerHTML = '<div class="empty-state">Nenhum boleto nesta situação.</div>';
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
    return `<tr>
      <td>${escapeHtml(compTxt)}</td>
      <td>${escapeHtml(destino)}${honorario ? '' : ''}</td>
      <td>${escapeHtml(fmtData(b.vencimento))}</td>
      <td class="col-num">${escapeHtml(fmtMoeda(b.valor))}</td>
      <td>${badgeBoleto(b)}${link}</td>
    </tr>`;
  }).join('');

  alvo.innerHTML = `
    <div class="tabela-wrap" style="max-height:480px;overflow-y:auto;">
      <table class="tabela">
        <thead><tr><th>Competência</th><th>Destino</th><th>Vencimento</th><th>Valor</th><th>Situação</th></tr></thead>
        <tbody>${linhas}</tbody>
      </table>
    </div>
    <p style="margin-top:12px;">${lista.length} boleto(s) · total ${escapeHtml(fmtMoeda(totalValor))}</p>`;
}

SECTION_RENDERERS.faturamento = renderFaturamento;
