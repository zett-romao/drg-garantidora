// =============================================================
// DRG-Garantidora — carteira.js
// Carteira de inadimplentes adquirida: a D.R. Global compra do
// condomínio os débitos vencidos antes da data de corte (por um valor
// descontado) e passa a ser a titular dessas cobranças.
// Mostra os dados da compra (do contrato) e registra os títulos.
// Carregado depois de competencias.js.
// =============================================================

window.SECTION_RENDERERS = window.SECTION_RENDERERS || {};

let cacheCarteira = {};

function renderCarteira() {
  return renderComContexto(
    'Carteira Adquirida',
    'Débitos inadimplentes comprados do condomínio — titularidade da D.R. Global.',
    async (cid) => {
      const [snapCt, snapTit] = await Promise.all([
        refSub(cid, 'contratos').get(),
        refSub(cid, 'carteira').orderBy('criadoEm', 'desc').get(),
      ]);
      const ativo = snapCt.docs.find((d) => (d.data().status || 'ativo') === 'ativo');
      const ca = (ativo && ativo.data().carteiraAdquirida) || {};

      cacheCarteira = {};
      let totalTitulos = 0;
      const linhas = snapTit.docs.map((d) => {
        cacheCarteira[d.id] = d.data();
        const t = d.data();
        totalTitulos += Number(t.valor) || 0;
        const acao = podeEditar()
          ? `<button class="btn btn-danger btn-sm" onclick="excluirTituloCarteira('${cid}','${d.id}')">Excluir</button>`
          : '';
        return `<tr>
          <td>${escapeHtml(t.devedor || '—')}</td>
          <td>${escapeHtml(t.unidade || '—')}</td>
          <td>${escapeHtml(fmtData(t.vencimentoOriginal))}</td>
          <td class="col-num">${escapeHtml(fmtMoeda(t.valor))}</td>
          <td>${escapeHtml(t.observacao || '—')}</td>
          <td class="acoes">${acao}</td>
        </tr>`;
      }).join('');

      const temCompra = ca.valor != null || ca.dataCorte || ca.dataPagamento;
      const resumo = temCompra
        ? `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;">
             <div class="stat-card"><span class="stat-label">Valor pago pela carteira</span>
               <span class="stat-value">${escapeHtml(fmtMoeda(ca.valor || 0))}</span></div>
             <div class="stat-card"><span class="stat-label">Data de corte</span>
               <span class="stat-value" style="font-size:18px;">${escapeHtml(fmtData(ca.dataCorte))}</span>
               <span class="stat-sub">débitos vencidos até aqui</span></div>
             <div class="stat-card"><span class="stat-label">Data do pagamento</span>
               <span class="stat-value" style="font-size:18px;">${escapeHtml(fmtData(ca.dataPagamento))}</span></div>
             <div class="stat-card"><span class="stat-label">Total dos títulos lançados</span>
               <span class="stat-value">${escapeHtml(fmtMoeda(totalTitulos))}</span>
               <span class="stat-sub">${snapTit.size} título(s)</span></div>
           </div>`
        : '<div class="alert alert-info">Nenhuma carteira adquirida registrada no contrato ativo. A compra da carteira (valor, data de corte) vem do contrato — edite o contrato em Cadastros.</div>';

      const novo = podeEditar()
        ? `<div style="text-align:right;margin-bottom:12px;"><button class="btn btn-primary" onclick="abrirFormTituloCarteira('${cid}')">+ Novo título</button></div>`
        : '';

      const tabela = snapTit.size
        ? `<div class="tabela-wrap"><table class="tabela">
             <thead><tr><th>Devedor</th><th>Unidade</th><th>Vencimento original</th><th>Valor</th><th>Observação</th><th>Ações</th></tr></thead>
             <tbody>${linhas}</tbody></table></div>`
        : '<div class="empty-state">Nenhum título lançado na carteira.</div>';

      document.getElementById('ctx-conteudo').innerHTML = `
        <div class="card"><h3>Compra da carteira</h3>${resumo}</div>
        ${novo}
        <div class="card"><h3>Títulos da carteira</h3>${tabela}</div>`;
    },
  );
}

function abrirFormTituloCarteira(cid) {
  const corpo = `
    ${campo('Devedor', inputTexto('cart-devedor', ''), true)}
    <div class="form-row">
      ${campo('Unidade', inputTexto('cart-unidade', '', 'placeholder="Ex: Apto 101"'))}
      ${campo('Valor do débito (R$)', '<input type="number" step="0.01" id="cart-valor">', true)}
    </div>
    ${campo('Vencimento original', '<input type="date" id="cart-venc">')}
    ${campo('Observação', inputTexto('cart-obs', ''))}`;
  abrirModalForm('Novo título da carteira', corpo, () => salvarTituloCarteira(cid), 'Salvar título');
}

async function salvarTituloCarteira(cid) {
  const devedor = valId('cart-devedor');
  const valor = valNum('cart-valor');
  if (!devedor) { erroModal('Informe o devedor.'); return; }
  if (valor == null || valor <= 0) { erroModal('Informe um valor válido.'); return; }
  const dados = {
    devedor,
    unidade: valId('cart-unidade'),
    valor,
    vencimentoOriginal: valId('cart-venc') || null,
    observacao: valId('cart-obs'),
  };
  travarSalvar(true);
  try {
    await refSub(cid, 'carteira').add(Object.assign(dados, carimboCriacao()));
    fecharModalForm();
    renderCarteira();
  } catch (err) {
    travarSalvar(false, 'Salvar título');
    erroModal('Falha ao salvar: ' + (err.message || err));
  }
}

async function excluirTituloCarteira(cid, id) {
  const t = cacheCarteira[id] || {};
  const ok = await confirmar({
    titulo: 'Excluir título',
    mensagem: `Excluir o título de ${t.devedor || 'devedor'} (${fmtMoeda(t.valor)})?`,
    okLabel: 'Excluir', perigo: true,
  });
  if (!ok) return;
  try {
    await refSub(cid, 'carteira').doc(id).delete();
    renderCarteira();
  } catch (err) {
    alert('Falha ao excluir: ' + (err.message || err));
  }
}

SECTION_RENDERERS.carteira = renderCarteira;
