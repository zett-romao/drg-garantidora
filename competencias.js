// =============================================================
// DRG-Garantidora — competencias.js
// Fase 2 — Competência mensal + emissão de boletos via Asaas.
// Carregado depois de cadastros.js. Usa State, helpers e Firebase globais.
// =============================================================

window.SECTION_RENDERERS = window.SECTION_RENDERERS || {};

// Worker do Asaas (emissão de boletos).
const WORKER_ASAAS_URL = 'https://drg-garantidora-asaas.zett-romao.workers.dev';

// Token de identidade do usuário logado — exigido pelos endpoints do Worker.
// Vai no corpo (POST) ou no header Authorization (GET). Lança se sem sessão.
async function tokenAtual() {
  const u = (typeof auth !== 'undefined' && auth && auth.currentUser) ? auth.currentUser : null;
  if (!u) throw new Error('Sessão expirada — entre novamente.');
  return u.getIdToken();
}

let cacheCompetencias = {};
let fatCtx = null; // contexto carregado ao abrir uma competência (p/ o faturamento)

const MESES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

function rotuloCompetencia(c) {
  return `${MESES[(c.mes || 1) - 1] || '?'} / ${c.ano || '?'}`;
}

function badgeStatusCompetencia(s) {
  return s === 'faturada'
    ? '<span class="badge badge-success">Faturada</span>'
    : '<span class="badge badge-warning">Aberta</span>';
}

// Status do boleto (Asaas) — vem da conciliação (webhook) ou do botão
// "Atualizar status dos boletos".
const BOLETO_STATUS_PAGO = ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'];

function boletoEstaPago(b) {
  return !!b && BOLETO_STATUS_PAGO.includes(b.status);
}

function badgeBoleto(b) {
  const s = (b && b.status) || 'PENDING';
  if (BOLETO_STATUS_PAGO.includes(s)) {
    return `<span class="badge badge-success">Pago${b && b.pagoEm ? ' · ' + fmtData(b.pagoEm) : ''}</span>`;
  }
  if (s === 'OVERDUE') return '<span class="badge badge-danger">Vencido</span>';
  if (s === 'REFUNDED' || s === 'REFUND_REQUESTED') return '<span class="badge badge-muted">Estornado</span>';
  if (s === 'PENDING' || s === 'AWAITING_RISK_ANALYSIS') return '<span class="badge badge-warning">Aguardando</span>';
  return `<span class="badge badge-muted">${escapeHtml(s)}</span>`;
}

// Soma das despesas/cotas de todas as unidades da competência — o "balancete"
// que serve de base para o honorário da D.R. Global.
function totalDaCompetencia(ctx) {
  const valores = (ctx.comp && ctx.comp.valores) || {};
  const padrao = ctx.comp ? ctx.comp.valorPadrao : 0;
  let total = 0;
  (ctx.unidades || []).forEach((u) => {
    const v = valores[u.id] != null ? valores[u.id] : padrao;
    const n = Number(v);
    if (!isNaN(n)) total += n;
  });
  return total;
}

// Card de honorários — o percentual do contrato que a D.R. Global cobra do
// condomínio sobre o balancete das despesas das unidades da competência.
function montarCardHonorarios(ctx) {
  const taxa = ctx.taxaAdmPct;
  if (taxa == null) {
    return `<div class="card">
      <h3>Honorários da D.R. Global</h3>
      <p class="muted">Cadastre um contrato ativo com a taxa de administração para cobrar os honorários do condomínio.</p>
    </div>`;
  }
  const base = totalDaCompetencia(ctx);
  const valor = Math.round(base * taxa) / 100;
  const hb = ctx.honorarioBoleto;
  const corpo = hb
    ? `<p>Cobrança emitida: ${badgeBoleto(hb)}${hb.invoiceUrl ? ` <a href="${escapeHtml(hb.invoiceUrl)}" target="_blank" rel="noopener">2ª via</a>` : ''}</p>`
    : `${campo('Vencimento da cobrança', `<input type="date" id="hon-venc" value="${escapeHtml(ctx.comp.vencimento || '')}">`)}
       <button class="btn btn-success" id="comp-btn-honorario" onclick="emitirHonorario()">Emitir cobrança de honorários (${escapeHtml(fmtMoeda(valor))})</button>`;
  return `<div class="card">
    <h3>Honorários da D.R. Global</h3>
    <p class="muted" style="font-size:12px;">${taxa}% sobre o balancete das despesas das unidades (${escapeHtml(fmtMoeda(base))}).</p>
    <p>Honorário a cobrar do condomínio: <strong>${escapeHtml(fmtMoeda(valor))}</strong></p>
    ${corpo}
    <div id="hon-status" style="margin-top:10px;"></div>
  </div>`;
}

// -------------------------------------------------------------
// 1. Lista de competências
// -------------------------------------------------------------
function renderCompetencias() {
  return renderComContexto('Competências', 'Faturamento mensal — os valores a cobrar de cada unidade.', async (cid) => {
    const snap = await refSub(cid, 'competencias').orderBy('criadoEm', 'desc').get();
    cacheCompetencias = {};
    const linhas = snap.docs.map((d) => {
      cacheCompetencias[d.id] = d.data();
      const c = d.data();
      const acoes = podeEditar()
        ? `<button class="btn btn-secondary btn-sm" onclick="abrirCompetencia('${cid}','${d.id}')">Abrir</button>
           <button class="btn btn-danger btn-sm" onclick="excluirCompetencia('${cid}','${d.id}')">Excluir</button>`
        : `<button class="btn btn-secondary btn-sm" onclick="abrirCompetencia('${cid}','${d.id}')">Abrir</button>`;
      return `<tr>
        <td>${escapeHtml(rotuloCompetencia(c))}</td>
        <td>${escapeHtml(fmtData(c.vencimento))}</td>
        <td class="col-num">${escapeHtml(fmtMoeda(c.valorPadrao))}</td>
        <td>${badgeStatusCompetencia(c.status)}</td>
        <td class="acoes">${acoes}</td>
      </tr>`;
    }).join('');

    const tabela = snap.size
      ? `<div class="tabela-wrap"><table class="tabela">
           <thead><tr><th>Competência</th><th>Vencimento</th><th>Valor padrão</th><th>Status</th><th>Ações</th></tr></thead>
           <tbody>${linhas}</tbody></table></div>`
      : `<div class="empty-state">Nenhuma competência cadastrada.</div>`;

    const novo = podeEditar()
      ? `<div style="text-align:right;margin-bottom:12px;"><button class="btn btn-primary" onclick="abrirFormCompetencia('${cid}')">+ Nova competência</button></div>`
      : '';
    document.getElementById('ctx-conteudo').innerHTML = `${novo}<div class="card">${tabela}</div>`;
  });
}

// -------------------------------------------------------------
// 2. Criar competência
// -------------------------------------------------------------
function abrirFormCompetencia(cid) {
  const hoje = new Date();
  const mesAtual = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
  const corpo = `
    <div class="form-row">
      ${campo('Mês de referência', `<input type="month" id="f-comp-mes" value="${mesAtual}">`, true)}
      ${campo('Vencimento dos boletos', `<input type="date" id="f-comp-venc">`, true)}
    </div>
    ${campo('Valor padrão por unidade (R$)', `<input type="number" step="0.01" id="f-comp-valor" placeholder="Ex: 450,00">`, true)}
    ${campo('Descrição (opcional)', inputTexto('f-comp-desc', '', 'placeholder="Ex: Contribuição ordinária + fundo de reserva"'))}
    <p class="muted" style="font-size:12px;">O valor padrão é aplicado a todas as unidades ativas. Você ajusta unidade por unidade ao abrir a competência.</p>`;
  abrirModalForm('Nova competência', corpo, () => salvarCompetencia(cid), 'Criar competência');
}

async function salvarCompetencia(cid) {
  const mesRef = valId('f-comp-mes');
  const venc = valId('f-comp-venc');
  const valor = valNum('f-comp-valor');

  if (!mesRef) { erroModal('Informe o mês de referência.'); return; }
  if (!venc) { erroModal('Informe a data de vencimento.'); return; }
  if (valor == null || valor <= 0) { erroModal('Informe um valor padrão válido.'); return; }

  const [ano, mes] = mesRef.split('-').map(Number);
  const dados = {
    ano, mes,
    vencimento: venc,
    valorPadrao: valor,
    descricao: valId('f-comp-desc'),
    valores: {},
    status: 'aberta',
  };

  travarSalvar(true);
  try {
    await refSub(cid, 'competencias').add(Object.assign(dados, carimboCriacao()));
    fecharModalForm();
    renderCompetencias();
  } catch (err) {
    travarSalvar(false, 'Criar competência');
    erroModal('Falha ao salvar: ' + (err.message || err));
  }
}

// -------------------------------------------------------------
// 3. Abrir competência — valores, seleção e faturamento
// -------------------------------------------------------------
async function abrirCompetencia(cid, compId) {
  const content = $('content');
  content.innerHTML = `<div class="loader">Carregando competência…</div>`;

  try {
    const [snapComp, snapU, snapC, snapCt, snapB, snapCond] = await Promise.all([
      refSub(cid, 'competencias').doc(compId).get(),
      refSub(cid, 'unidades').orderBy('identificacao').get(),
      refSub(cid, 'condominos').get(),
      refSub(cid, 'contratos').get(),
      refSub(cid, 'boletos').where('competenciaId', '==', compId).get(),
      refCondominios().doc(cid).get(),
    ]);
    if (!snapComp.exists) { content.innerHTML = cardErro('Competência não encontrada.'); return; }

    const comp = snapComp.data();
    const unidades = snapU.docs.filter((d) => d.data().ativa !== false).map((d) => ({ id: d.id, data: d.data() }));

    // condômino por unidade (prefere o proprietário)
    const condominoPorUnidade = {};
    snapC.docs.forEach((d) => {
      const c = d.data();
      if (!c.unidadeId) return;
      if (!condominoPorUnidade[c.unidadeId] || c.tipo === 'proprietario') {
        condominoPorUnidade[c.unidadeId] = { id: d.id, data: c };
      }
    });

    const dadosCond = snapCond.exists ? snapCond.data() : {};
    const sind = dadosCond.sindico || {};

    // régua de cobrança — agora é configuração do condomínio
    const regua = dadosCond.regua || {};

    // taxa de administração — cláusula do contrato ativo
    let taxaAdmPct = null;
    const ativo = snapCt.docs.find((d) => (d.data().status || 'ativo') === 'ativo');
    if (ativo && ativo.data().taxaAdmPct != null) taxaAdmPct = Number(ativo.data().taxaAdmPct);

    // boletos desta competência — separa os das unidades do de honorários
    const boletoPorUnidade = {};
    let honorarioBoleto = null;
    snapB.docs.forEach((d) => {
      const b = Object.assign({ _id: d.id }, d.data());
      if (b.tipo === 'honorario') { honorarioBoleto = b; return; }
      boletoPorUnidade[b.unidadeId] = b;
    });

    fatCtx = {
      cid, compId, comp, unidades, condominoPorUnidade, regua, boletoPorUnidade,
      taxaAdmPct, honorarioBoleto,
      condominioNome: dadosCond.nome || 'Condomínio',
      condominioCnpj: dadosCond.cnpj || '',
      condominioEmail: sind.email || '',
      condominioTelefone: sind.telefone || '',
      condominioAsaasCustomerId: dadosCond.asaasCustomerId || '',
    };

    renderTelaCompetencia();
  } catch (err) {
    content.innerHTML = cardErro('Falha ao carregar a competência.', err);
  }
}

function renderTelaCompetencia() {
  const ctx = fatCtx;
  const comp = ctx.comp;
  const valores = comp.valores || {};
  const boletoPorUnidade = ctx.boletoPorUnidade || {};
  const temBoletos = Object.keys(boletoPorUnidade).length > 0 || !!ctx.honorarioBoleto;

  const linhas = ctx.unidades.map((u) => {
    const cond = ctx.condominoPorUnidade[u.id];
    const boleto = boletoPorUnidade[u.id];
    const v = valores[u.id] != null ? valores[u.id] : comp.valorPadrao;
    let statusCol = '—';
    let podeSelecionar = !!cond && !boleto;
    if (boleto) {
      const link = boleto.invoiceUrl ? ` <a href="${escapeHtml(boleto.invoiceUrl)}" target="_blank" rel="noopener">2ª via</a>` : '';
      statusCol = `${badgeBoleto(boleto)}${link}`;
    } else if (!cond) {
      statusCol = '<span class="badge badge-danger">Sem condômino</span>';
    }
    return `<tr>
      <td><input type="checkbox" class="fat-row" data-uid="${u.id}" ${podeSelecionar ? 'checked' : 'disabled'} onchange="atualizarSelecaoFat()"></td>
      <td>${escapeHtml(u.data.identificacao || '—')}</td>
      <td>${escapeHtml(cond ? (cond.data.nome || '—') : '—')}</td>
      <td><input type="number" step="0.01" class="comp-val" data-uid="${u.id}" value="${v != null ? v : ''}" style="max-width:130px;" oninput="atualizarTotalCompetencia()"></td>
      <td>${statusCol}</td>
    </tr>`;
  }).join('');

  const reguaTxt = (ctx.regua.multaPct != null || ctx.regua.jurosMoraMesPct != null)
    ? `Multa ${ctx.regua.multaPct != null ? ctx.regua.multaPct : 0}% · juros ${ctx.regua.jurosMoraMesPct != null ? ctx.regua.jurosMoraMesPct : 0}%/mês (régua do condomínio)`
    : 'Régua de cobrança não configurada no condomínio — boletos sairão sem multa/juros.';

  const honorariosCard = montarCardHonorarios(ctx);

  $('content').innerHTML = `
    <div class="section-head">
      <div><h2>Competência ${escapeHtml(rotuloCompetencia(comp))}</h2>
      <p>Vencimento ${escapeHtml(fmtData(comp.vencimento))} · ${badgeStatusCompetencia(comp.status)}</p></div>
      <button class="btn-voltar-topbar" onclick="renderSection('competencias')">&larr; Competências</button>
    </div>
    <div class="card">
      <h3>Unidades e valores</h3>
      ${ctx.unidades.length ? `
        <p class="muted" style="font-size:12px;margin-bottom:10px;">${escapeHtml(reguaTxt)}</p>
        <div class="tabela-wrap" style="max-height:440px;overflow-y:auto;">
          <table class="tabela">
            <thead><tr>
              <th><input type="checkbox" id="fat-todos" checked onclick="toggleFatTodos(this)"></th>
              <th>Unidade</th><th>Condômino</th><th>Valor (R$)</th><th>Boleto</th>
            </tr></thead>
            <tbody>${linhas}</tbody>
          </table>
        </div>
        <p style="margin-top:12px;">Total: <strong><span id="comp-total"></span></strong> · <span id="fat-contador"></span></p>
        <div id="comp-status" style="margin:12px 0;"></div>
        <div style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;">
          ${temBoletos ? '<button class="btn btn-secondary" id="comp-btn-sync" onclick="sincronizarBoletos()">Atualizar status dos boletos</button>' : ''}
          <button class="btn btn-secondary" onclick="abrirImportarValores('${ctx.cid}','${ctx.compId}')">Importar valores (planilha)</button>
          <button class="btn btn-secondary" id="comp-btn-salvar" onclick="salvarValoresCompetencia()">Salvar valores</button>
          <button class="btn btn-success" id="comp-btn-faturar" onclick="faturarCompetencia()">Faturar selecionadas (emitir boletos)</button>
        </div>`
        : '<div class="empty-state">Este condomínio não tem unidades ativas. Cadastre ou importe unidades antes de faturar.</div>'}
    </div>
    ${honorariosCard}`;
  atualizarTotalCompetencia();
  atualizarSelecaoFat();
}

function atualizarTotalCompetencia() {
  let total = 0;
  document.querySelectorAll('.comp-val').forEach((inp) => {
    const n = parseFloat(inp.value);
    if (!isNaN(n)) total += n;
  });
  const el = document.getElementById('comp-total');
  if (el) el.textContent = fmtMoeda(total);
}

function toggleFatTodos(master) {
  document.querySelectorAll('.fat-row').forEach((cb) => {
    if (!cb.disabled) cb.checked = master.checked;
  });
  atualizarSelecaoFat();
}

function atualizarSelecaoFat() {
  const n = document.querySelectorAll('.fat-row:checked').length;
  const el = document.getElementById('fat-contador');
  if (el) el.textContent = `${n} unidade(s) selecionada(s) para faturar`;
}

async function salvarValoresCompetencia() {
  const ctx = fatCtx;
  const valores = {};
  document.querySelectorAll('.comp-val').forEach((inp) => {
    const n = parseFloat(inp.value);
    if (!isNaN(n)) valores[inp.dataset.uid] = n;
  });
  const btn = document.getElementById('comp-btn-salvar');
  if (btn) { btn.disabled = true; btn.textContent = 'Salvando…'; }
  try {
    await refSub(ctx.cid, 'competencias').doc(ctx.compId).update({ valores });
    ctx.comp.valores = valores;
    showAlert('comp-status', 'Valores salvos.', 'success');
  } catch (err) {
    showAlert('comp-status', 'Falha ao salvar: ' + (err.message || err), 'error');
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Salvar valores'; }
}

// -------------------------------------------------------------
// 3b. Conciliação manual — consulta o Asaas e atualiza os boletos.
//     Rede de segurança caso o webhook de conciliação não chegue.
// -------------------------------------------------------------
async function sincronizarBoletos() {
  const ctx = fatCtx;
  if (!ctx) return;
  const boletos = Object.values(ctx.boletoPorUnidade || {}).filter((b) => b.asaasPaymentId);
  if (ctx.honorarioBoleto && ctx.honorarioBoleto.asaasPaymentId) boletos.push(ctx.honorarioBoleto);
  if (!boletos.length) {
    showAlert('comp-status', 'Nenhum boleto emitido nesta competência ainda.', 'info');
    return;
  }

  const btn = document.getElementById('comp-btn-sync');
  if (btn) btn.disabled = true;

  let atualizados = 0;
  const falhas = [];
  for (let i = 0; i < boletos.length; i++) {
    const b = boletos[i];
    showAlert('comp-status', `Consultando ${i + 1} de ${boletos.length} no Asaas…`, 'info');
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

  await abrirCompetencia(ctx.cid, ctx.compId);
  const resumo = `${atualizados} boleto(s) atualizado(s).` +
    (falhas.length ? ` ${falhas.length} falha(s): ${falhas.join(' | ')}` : '');
  showAlert('comp-status', resumo, falhas.length ? 'error' : 'success');
}

// -------------------------------------------------------------
// 4. Faturamento — emite boletos no Asaas das unidades selecionadas
// -------------------------------------------------------------
async function faturarCompetencia() {
  const ctx = fatCtx;
  if (!ctx) return;

  const selecionadas = Array.from(document.querySelectorAll('.fat-row:checked')).map((cb) => cb.dataset.uid);
  if (!selecionadas.length) {
    showAlert('comp-status', 'Selecione ao menos uma unidade para faturar.', 'error');
    return;
  }

  // valores atuais dos inputs
  const valorDe = {};
  document.querySelectorAll('.comp-val').forEach((inp) => {
    const n = parseFloat(inp.value);
    if (!isNaN(n)) valorDe[inp.dataset.uid] = n;
  });

  const ok = await confirmar({
    titulo: 'Emitir boletos',
    mensagem: `Emitir ${selecionadas.length} boleto(s) REAIS no Asaas, com vencimento ${fmtData(ctx.comp.vencimento)}? Cada um vira uma cobrança de verdade.`,
    okLabel: 'Emitir boletos',
  });
  if (!ok) return;

  const btn = document.getElementById('comp-btn-faturar');
  if (btn) btn.disabled = true;

  let emitidos = 0;
  const falhas = [];

  for (let i = 0; i < selecionadas.length; i++) {
    const uid = selecionadas[i];
    const unidade = ctx.unidades.find((u) => u.id === uid);
    const ident = unidade ? (unidade.data.identificacao || uid) : uid;
    showAlert('comp-status', `Emitindo ${i + 1} de ${selecionadas.length} — ${ident}…`, 'info');
    try {
      const cond = ctx.condominoPorUnidade[uid];
      if (!cond) throw new Error('unidade sem condômino vinculado');
      const valor = valorDe[uid];
      if (valor == null || valor <= 0) throw new Error('valor inválido');
      if (!cond.data.cpfCnpj) throw new Error('condômino sem CPF/CNPJ (obrigatório no Asaas)');

      // 1. cliente no Asaas (cria uma vez, reaproveita)
      let customerId = cond.data.asaasCustomerId;
      if (!customerId) {
        const rc = await fetch(`${WORKER_ASAAS_URL}/customers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            idToken: await tokenAtual(),
            nome: cond.data.nome, cpfCnpj: cond.data.cpfCnpj,
            email: cond.data.email, telefone: cond.data.telefone, refExterna: cond.id,
          }),
        });
        const jc = await rc.json().catch(() => ({}));
        if (!rc.ok || !jc.success) throw new Error(jc.error || 'falha ao criar cliente no Asaas');
        customerId = jc.customer.id;
        await refSub(ctx.cid, 'condominos').doc(cond.id).update({ asaasCustomerId: customerId });
        cond.data.asaasCustomerId = customerId;
      }

      // 2. boleto no Asaas
      const descricao = `${ctx.condominioNome} — ${ident} — ${rotuloCompetencia(ctx.comp)}`;
      const rb = await fetch(`${WORKER_ASAAS_URL}/boletos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idToken: await tokenAtual(),
          customerId, valor, vencimento: ctx.comp.vencimento, descricao,
          multaPct: ctx.regua.multaPct, jurosMesPct: ctx.regua.jurosMoraMesPct,
          refExterna: `garantidora|${ctx.cid}|${ctx.compId}|${uid}`,
        }),
      });
      const jb = await rb.json().catch(() => ({}));
      if (!rb.ok || !jb.success) throw new Error(jb.error || 'falha ao criar boleto no Asaas');
      const bol = jb.boleto || {};
      if (!bol.id) throw new Error('o Asaas não retornou o id do boleto');

      // 3. grava o boleto no Firestore — o id do doc é o id do pagamento no
      //    Asaas, pra o webhook de conciliação localizar o boleto direto.
      await refSub(ctx.cid, 'boletos').doc(bol.id).set(Object.assign({
        competenciaId: ctx.compId,
        unidadeId: uid,
        condominoId: cond.id,
        valor,
        vencimento: ctx.comp.vencimento,
        status: bol.status || 'PENDING',
        asaasPaymentId: bol.id,
        bankSlipUrl: bol.bankSlipUrl || null,
        invoiceUrl: bol.invoiceUrl || null,
      }, carimboCriacao()));

      emitidos++;
    } catch (err) {
      falhas.push(`${ident}: ${err.message || err}`);
    }
  }

  // marca a competência como faturada se todas as unidades faturáveis já têm boleto
  try {
    const snapB = await refSub(ctx.cid, 'boletos').where('competenciaId', '==', ctx.compId).get();
    const comBoleto = new Set(
      snapB.docs.filter((d) => d.data().tipo !== 'honorario').map((d) => d.data().unidadeId),
    );
    const faturaveis = ctx.unidades.filter((u) => ctx.condominoPorUnidade[u.id]).length;
    if (comBoleto.size >= faturaveis && faturaveis > 0) {
      await refSub(ctx.cid, 'competencias').doc(ctx.compId).update({ status: 'faturada' });
    }
  } catch (_) { /* não crítico */ }

  await abrirCompetencia(ctx.cid, ctx.compId);
  const resumo = `${emitidos} boleto(s) emitido(s).` + (falhas.length ? ` ${falhas.length} falha(s): ${falhas.join(' | ')}` : '');
  showAlert('comp-status', resumo, falhas.length ? 'error' : 'success');
}

// -------------------------------------------------------------
// 5. Honorários — emite ao condomínio a cobrança do percentual do contrato
// -------------------------------------------------------------
async function emitirHonorario() {
  const ctx = fatCtx;
  if (!ctx) return;
  if (ctx.taxaAdmPct == null) {
    showAlert('hon-status', 'Sem contrato ativo com taxa de administração definida.', 'error');
    return;
  }
  if (!ctx.condominioCnpj) {
    showAlert('hon-status', 'O condomínio precisa de CNPJ cadastrado para a cobrança no Asaas.', 'error');
    return;
  }
  const base = totalDaCompetencia(ctx);
  const valor = Math.round(base * ctx.taxaAdmPct) / 100;
  if (!(valor > 0)) {
    showAlert('hon-status', 'O honorário calculado ficou em zero — confira os valores das unidades.', 'error');
    return;
  }
  const venc = valId('hon-venc') || ctx.comp.vencimento;
  if (!venc) { showAlert('hon-status', 'Informe o vencimento da cobrança.', 'error'); return; }

  const ok = await confirmar({
    titulo: 'Emitir honorários',
    mensagem: `Emitir um boleto REAL de ${fmtMoeda(valor)} para ${ctx.condominioNome}, referente aos honorários de cobrança (${ctx.taxaAdmPct}% de ${fmtMoeda(base)})?`,
    okLabel: 'Emitir cobrança',
  });
  if (!ok) return;

  const btn = document.getElementById('comp-btn-honorario');
  if (btn) btn.disabled = true;
  showAlert('hon-status', 'Emitindo a cobrança de honorários…', 'info');

  try {
    // 1. cliente do condomínio no Asaas (cria uma vez, reaproveita)
    let customerId = ctx.condominioAsaasCustomerId;
    if (!customerId) {
      const rc = await fetch(`${WORKER_ASAAS_URL}/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idToken: await tokenAtual(),
          nome: ctx.condominioNome, cpfCnpj: ctx.condominioCnpj,
          email: ctx.condominioEmail, telefone: ctx.condominioTelefone,
          refExterna: ctx.cid,
        }),
      });
      const jc = await rc.json().catch(() => ({}));
      if (!rc.ok || !jc.success) throw new Error(jc.error || 'falha ao cadastrar o condomínio no Asaas');
      customerId = jc.customer.id;
      await refCondominios().doc(ctx.cid).update({ asaasCustomerId: customerId });
      ctx.condominioAsaasCustomerId = customerId;
    }

    // 2. boleto de honorários
    const descricao = `Honorários de cobrança — ${ctx.condominioNome} — ${rotuloCompetencia(ctx.comp)}`;
    const rb = await fetch(`${WORKER_ASAAS_URL}/boletos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idToken: await tokenAtual(),
        customerId, valor, vencimento: venc, descricao,
        refExterna: `garantidora|${ctx.cid}|${ctx.compId}|honorario`,
      }),
    });
    const jb = await rb.json().catch(() => ({}));
    if (!rb.ok || !jb.success) throw new Error(jb.error || 'falha ao criar o boleto no Asaas');
    const bol = jb.boleto || {};
    if (!bol.id) throw new Error('o Asaas não retornou o id do boleto');

    // 3. grava no Firestore — mesma coleção dos boletos, marcado como honorário
    await refSub(ctx.cid, 'boletos').doc(bol.id).set(Object.assign({
      tipo: 'honorario',
      competenciaId: ctx.compId,
      unidadeId: null,
      valor,
      baseCalculo: base,
      taxaAdmPct: ctx.taxaAdmPct,
      vencimento: venc,
      status: bol.status || 'PENDING',
      asaasPaymentId: bol.id,
      bankSlipUrl: bol.bankSlipUrl || null,
      invoiceUrl: bol.invoiceUrl || null,
    }, carimboCriacao()));

    await abrirCompetencia(ctx.cid, ctx.compId);
    showAlert('hon-status', `Cobrança de honorários emitida: ${fmtMoeda(valor)}.`, 'success');
  } catch (err) {
    if (btn) btn.disabled = false;
    showAlert('hon-status', 'Falha: ' + (err.message || err), 'error');
  }
}

async function excluirCompetencia(cid, compId) {
  const c = cacheCompetencias[compId] || {};
  const ok = await confirmar({
    titulo: 'Excluir competência',
    mensagem: `Excluir a competência ${rotuloCompetencia(c)}? Os boletos já emitidos no Asaas NÃO são cancelados.`,
    okLabel: 'Excluir', perigo: true,
  });
  if (!ok) return;
  try {
    await refSub(cid, 'competencias').doc(compId).delete();
    renderCompetencias();
  } catch (err) {
    alert('Falha ao excluir: ' + (err.message || err));
  }
}

// -------------------------------------------------------------
SECTION_RENDERERS.competencias = renderCompetencias;
