// =============================================================
// DRG-Garantidora — conciliacao.js
// Conciliação: acompanha o pagamento dos boletos do condomínio e
// sincroniza o status com o Asaas (rede de segurança do webhook).
// Carregado depois de competencias.js (usa WORKER_ASAAS_URL e badgeBoleto).
// =============================================================

window.SECTION_RENDERERS = window.SECTION_RENDERERS || {};

const CONC_PAGO = ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'];
const CONC_FINAL = ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH', 'REFUNDED', 'REFUND_REQUESTED', 'CANCELADO'];
let concCtx = null;

function renderConciliacao() {
  return renderComContexto(
    'Conciliação',
    'Acompanha o pagamento dos boletos e sincroniza o status com o Asaas.',
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
      const boletos = snapB.docs
        .map((d) => Object.assign({ _id: d.id }, d.data()))
        .filter((b) => b.asaasPaymentId);

      concCtx = { cid, boletos, uni, cond };
      renderTelaConciliacao();
    },
  );
}

function renderTelaConciliacao() {
  const ctx = concCtx;
  let pagos = 0;
  let pendentes = 0;
  ctx.boletos.forEach((b) => {
    const s = b.status || 'PENDING';
    if (CONC_PAGO.indexOf(s) !== -1) pagos++;
    else if (CONC_FINAL.indexOf(s) === -1) pendentes++;
  });

  const aSincronizar = ctx.boletos.filter((b) => CONC_FINAL.indexOf(b.status || 'PENDING') === -1);
  const linhas = aSincronizar
    .sort((a, z) => String(a.vencimento || '').localeCompare(String(z.vencimento || '')))
    .map((b) => {
      const honorario = b.tipo === 'honorario';
      const destino = honorario
        ? 'Honorários — condomínio'
        : ((ctx.uni[b.unidadeId] || {}).identificacao || '—');
      const nome = honorario ? '—' : ((ctx.cond[b.condominoId] || {}).nome || '—');
      const acao = podeEditar()
        ? `<button class="btn btn-danger btn-sm" onclick="cancelarBoletoConc('${ctx.cid}','${b._id}','${b.asaasPaymentId}')">Cancelar</button>`
        : '';
      return `<tr>
        <td>${escapeHtml(destino)}</td>
        <td>${escapeHtml(nome)}</td>
        <td>${escapeHtml(fmtData(b.vencimento))}</td>
        <td class="col-num">${escapeHtml(fmtMoeda(b.valor))}</td>
        <td>${badgeBoleto(b)}</td>
        <td class="acoes">${acao}</td>
      </tr>`;
    }).join('');

  const tabela = aSincronizar.length
    ? `<div class="tabela-wrap" style="max-height:420px;overflow-y:auto;"><table class="tabela">
         <thead><tr><th>Destino</th><th>Condômino</th><th>Vencimento</th><th>Valor</th><th>Status</th><th>Ações</th></tr></thead>
         <tbody>${linhas}</tbody></table></div>`
    : '<div class="empty-state">Todos os boletos já estão num status final (pago ou estornado).</div>';

  const grid = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;';
  document.getElementById('ctx-conteudo').innerHTML = `
    <div class="card">
      <div style="${grid}">
        <div class="stat-card"><span class="stat-label">Boletos</span><span class="stat-value">${ctx.boletos.length}</span></div>
        <div class="stat-card"><span class="stat-label">Pagos</span><span class="stat-value" style="color:var(--success);">${pagos}</span></div>
        <div class="stat-card"><span class="stat-label">Pendentes</span><span class="stat-value">${pendentes}</span></div>
      </div>
      <p class="muted" style="font-size:12px;margin-top:12px;">A conciliação é automática pelo webhook do Asaas. Use o botão abaixo se algum pagamento não tiver sido baixado.</p>
      <div id="conc-status" style="margin:12px 0;"></div>
      <div style="text-align:right;">
        <button class="btn btn-primary" id="conc-btn-sync" onclick="sincronizarConciliacao()">Sincronizar com o Asaas</button>
      </div>
    </div>
    <div class="card"><h3>Boletos em aberto</h3>${tabela}</div>`;
}

async function sincronizarConciliacao() {
  const ctx = concCtx;
  if (!ctx) return;
  const alvos = ctx.boletos.filter((b) => b.asaasPaymentId && CONC_FINAL.indexOf(b.status || 'PENDING') === -1);
  if (!alvos.length) {
    showAlert('conc-status', 'Nada a sincronizar — todos os boletos já estão num status final.', 'info');
    return;
  }
  const btn = document.getElementById('conc-btn-sync');
  if (btn) btn.disabled = true;

  let atualizados = 0;
  const falhas = [];
  for (let i = 0; i < alvos.length; i++) {
    const b = alvos[i];
    showAlert('conc-status', `Consultando ${i + 1} de ${alvos.length} no Asaas…`, 'info');
    try {
      const r = await fetch(`${WORKER_ASAAS_URL}/boletos/${encodeURIComponent(b.asaasPaymentId)}`, {
        headers: { 'Authorization': 'Bearer ' + (await tokenAtual()) },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.success) throw new Error(j.error || 'falha na consulta');
      const bol = j.boleto || {};
      const novoStatus = bol.status || b.status;
      const dataPag = bol.paymentDate || bol.clientPaymentDate || bol.confirmedDate || null;
      if (novoStatus !== b.status || (dataPag && dataPag !== b.pagoEm)) {
        const upd = { status: novoStatus };
        if (dataPag) upd.pagoEm = dataPag;
        await refSub(ctx.cid, 'boletos').doc(b._id).update(upd);
        atualizados++;
      }
    } catch (err) {
      falhas.push(`${b.asaasPaymentId}: ${err.message || err}`);
    }
  }

  await renderConciliacao();
  const resumo = `${atualizados} boleto(s) atualizado(s).` +
    (falhas.length ? ` ${falhas.length} falha(s): ${falhas.join(' | ')}` : '');
  showAlert('conc-status', resumo, falhas.length ? 'error' : 'success');
}

// Cancela um boleto: exclui no Asaas e marca como CANCELADO no Firestore.
async function cancelarBoletoConc(cid, docId, asaasPaymentId) {
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
    await refSub(cid, 'boletos').doc(docId).update({
      status: 'CANCELADO',
      atualizadoEm: firebase.firestore.FieldValue.serverTimestamp(),
    });
    renderConciliacao();
  } catch (err) {
    showAlert('conc-status', 'Falha ao cancelar: ' + (err.message || err), 'error');
  }
}

SECTION_RENDERERS.conciliacao = renderConciliacao;
