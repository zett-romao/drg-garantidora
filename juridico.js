// =============================================================
// DRG-Garantidora — juridico.js
// Cobrança Judicial: lista os boletos muito atrasados (candidatos) e
// controla os que foram enviados para cobrança judicial — data de
// envio, nº do processo, advogado. Carregado depois de competencias.js.
// =============================================================

window.SECTION_RENDERERS = window.SECTION_RENDERERS || {};

const JUR_DIAS_MIN = 60;                                   // atraso mínimo p/ candidato
const JUR_PAGO = ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'];
let cacheJuridico = {};
let jurCtx = null; // { uni, cond } do último render — para o relatório

function jurHojeISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function jurDiasAtraso(venc) {
  if (!venc) return 0;
  const ms = (s) => { const p = String(s).split('-').map(Number); return Date.UTC(p[0], (p[1] || 1) - 1, p[2] || 1); };
  return Math.round((ms(jurHojeISO()) - ms(venc)) / 86400000);
}

function renderJuridico() {
  return renderComContexto(
    'Cobrança Judicial',
    'Boletos muito atrasados e o controle dos casos enviados para cobrança judicial.',
    async (cid) => {
      const [snapB, snapU, snapC] = await Promise.all([
        refSub(cid, 'boletos').get(),
        refSub(cid, 'unidades').get(),
        refSub(cid, 'condominos').get(),
      ]);
      const uni = {};
      snapU.docs.forEach((d) => { uni[d.id] = d.data(); });
      const cond = {};
      snapC.docs.forEach((d) => { cond[d.id] = d.data(); });
      jurCtx = { uni, cond };

      cacheJuridico = {};
      const noJuridico = [];
      const candidatos = [];
      snapB.docs.forEach((d) => {
        const b = Object.assign({ _id: d.id }, d.data());
        if (b.tipo === 'honorario') return;
        cacheJuridico[d.id] = b;
        if (b.juridicoEm) { noJuridico.push(b); return; }
        const pago = JUR_PAGO.indexOf(b.status || 'PENDING') !== -1;
        if (!pago && jurDiasAtraso(b.vencimento) >= JUR_DIAS_MIN) candidatos.push(b);
      });
      candidatos.sort((a, z) => jurDiasAtraso(z.vencimento) - jurDiasAtraso(a.vencimento));
      noJuridico.sort((a, z) => String(z.juridicoEm).localeCompare(String(a.juridicoEm)));

      const nome = (b) => escapeHtml((cond[b.condominoId] || {}).nome || '—');
      const ident = (b) => escapeHtml((uni[b.unidadeId] || {}).identificacao || '—');

      const linhasJur = noJuridico.map((b) => `<tr>
        <td>${ident(b)}</td><td>${nome(b)}</td>
        <td>${escapeHtml(fmtData(b.vencimento))}</td>
        <td class="col-num">${escapeHtml(fmtMoeda(b.valor))}</td>
        <td>${escapeHtml(b.juridicoProcesso || '—')}</td>
        <td>${escapeHtml(fmtData(b.juridicoEm))}</td>
        <td class="acoes">${podeEditar() ? `<button class="btn btn-secondary btn-sm" onclick="retirarJuridico('${cid}','${b._id}')">Retirar</button>` : ''}</td>
      </tr>`).join('');

      const linhasCand = candidatos.map((b) => `<tr>
        <td>${ident(b)}</td><td>${nome(b)}</td>
        <td>${escapeHtml(fmtData(b.vencimento))}</td>
        <td>${jurDiasAtraso(b.vencimento)} dia(s)</td>
        <td class="col-num">${escapeHtml(fmtMoeda(b.valor))}</td>
        <td class="acoes">${podeEditar() ? `<button class="btn btn-danger btn-sm" onclick="enviarJuridico('${cid}','${b._id}')">Enviar ao jurídico</button>` : ''}</td>
      </tr>`).join('');

      const tabJur = noJuridico.length
        ? `<div class="tabela-wrap"><table class="tabela">
             <thead><tr><th>Unidade</th><th>Condômino</th><th>Vencimento</th><th>Valor</th><th>Processo</th><th>Enviado em</th><th>Ações</th></tr></thead>
             <tbody>${linhasJur}</tbody></table></div>`
        : '<div class="empty-state">Nenhum caso em cobrança judicial.</div>';

      const tabCand = candidatos.length
        ? `<div class="tabela-wrap"><table class="tabela">
             <thead><tr><th>Unidade</th><th>Condômino</th><th>Vencimento</th><th>Atraso</th><th>Valor</th><th>Ações</th></tr></thead>
             <tbody>${linhasCand}</tbody></table></div>`
        : `<div class="empty-state">Nenhum boleto vencido há mais de ${JUR_DIAS_MIN} dias.</div>`;

      document.getElementById('ctx-conteudo').innerHTML = `
        <div style="display:flex;justify-content:flex-end;margin-bottom:12px;">
          <button class="btn btn-secondary" onclick="relatorioJuridico()">Relatório</button>
        </div>
        <div class="card"><h3>Em cobrança judicial</h3>${tabJur}</div>
        <div class="card">
          <h3>Candidatos — vencidos há mais de ${JUR_DIAS_MIN} dias</h3>
          ${tabCand}
        </div>`;
    },
  );
}

function enviarJuridico(cid, boletoId) {
  const corpo = `
    ${campo('Data do envio', `<input type="date" id="jur-data" value="${jurHojeISO()}">`, true)}
    ${campo('Nº do processo', inputTexto('jur-processo', '', 'placeholder="opcional"'))}
    ${campo('Advogado / escritório', inputTexto('jur-adv', '', 'placeholder="opcional"'))}
    ${campo('Observação', inputTexto('jur-obs', ''))}`;
  abrirModalForm('Enviar ao jurídico', corpo, () => salvarJuridico(cid, boletoId), 'Enviar ao jurídico');
}

async function salvarJuridico(cid, boletoId) {
  const data = valId('jur-data');
  if (!data) { erroModal('Informe a data do envio.'); return; }
  travarSalvar(true);
  try {
    await refSub(cid, 'boletos').doc(boletoId).update({
      juridicoEm: data,
      juridicoProcesso: valId('jur-processo') || null,
      juridicoAdvogado: valId('jur-adv') || null,
      juridicoObs: valId('jur-obs') || null,
    });
    fecharModalForm();
    renderJuridico();
  } catch (err) {
    travarSalvar(false, 'Enviar ao jurídico');
    erroModal('Falha ao enviar: ' + (err.message || err));
  }
}

async function retirarJuridico(cid, boletoId) {
  const ok = await confirmar({
    titulo: 'Retirar do jurídico',
    mensagem: 'Tirar este boleto da cobrança judicial?',
    okLabel: 'Retirar', perigo: true,
  });
  if (!ok) return;
  try {
    await refSub(cid, 'boletos').doc(boletoId).update({
      juridicoEm: null, juridicoProcesso: null, juridicoAdvogado: null, juridicoObs: null,
    });
    renderJuridico();
  } catch (err) {
    alert('Falha ao retirar: ' + (err.message || err));
  }
}

function relatorioJuridico() {
  const ctx = jurCtx || { uni: {}, cond: {} };
  const lista = Object.keys(cacheJuridico)
    .map((id) => cacheJuridico[id])
    .filter((b) => b.juridicoEm)
    .sort((a, z) => String(z.juridicoEm || '').localeCompare(String(a.juridicoEm || '')));
  let total = 0;
  const linhas = lista.map((b) => {
    total += Number(b.valor) || 0;
    return [
      (ctx.uni[b.unidadeId] || {}).identificacao || '',
      (ctx.cond[b.condominoId] || {}).nome || '',
      fmtData(b.vencimento),
      fmtMoeda(b.valor),
      b.juridicoProcesso || '',
      b.juridicoAdvogado || '',
      fmtData(b.juridicoEm),
    ];
  });
  abrirRelatorio('Relatório — Cobrança Judicial', condominioContextoNome(),
    ['Unidade', 'Condômino', 'Vencimento', 'Valor', 'Nº processo', 'Advogado', 'Enviado em'], linhas,
    `Total em cobrança judicial: ${fmtMoeda(total)}`, 'cobranca-judicial');
}

SECTION_RENDERERS.juridico = renderJuridico;
