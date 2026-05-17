// =============================================================
// DRG-Garantidora — repasses.js
// Antecipação / Repasses: a D.R. Global garante e repassa ao condomínio
// 100% das cotas de cada competência.
//
// Fluxo com separação de funções:
//  - SOLICITAR (lançar): quem tem "editar" no módulo cria a solicitação —
//    a competência fica AGUARDANDO_APROVACAO. Não move dinheiro.
//  - APROVAR: quem tem a ação "aprovar repasse" autoriza com senha +
//    Google Authenticator. O Pix só sai aí (validado no Worker).
//  - Registrar manual: nota de repasse feito por fora (não move dinheiro).
// Carregado depois de competencias.js — usa WORKER_ASAAS_URL e refCondominios.
// =============================================================

window.SECTION_RENDERERS = window.SECTION_RENDERERS || {};

// Situação do repasse, a partir do status gravado na competência.
const REP_OK = ['DONE', 'MANUAL'];
const REP_PROCESSANDO = ['PENDING', 'BANK_PROCESSING', 'CREATED'];
const REP_FALHA = ['FAILED', 'CANCELLED', 'BLOCKED'];

let repCondominio = {};      // { nome, repasse:{pixTipo,pixChave} } do condomínio em contexto
let repComps = {};           // id -> dados da competência (para os handlers de onclick)
let repEmAndamento = false;  // trava anti-disparo-duplo na aprovação

function repHojeISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function rotuloPixTipo(t) {
  return { CPF: 'CPF', CNPJ: 'CNPJ', EMAIL: 'e-mail', PHONE: 'telefone', EVP: 'aleatória' }[t] || (t || '—');
}

// Classifica a situação do repasse de uma competência.
function repClassificar(c) {
  const st = c.repasseStatus || '';
  if (st === 'AGUARDANDO_APROVACAO') return 'aguardando';
  if (REP_OK.indexOf(st) !== -1) return 'ok';
  if (REP_PROCESSANDO.indexOf(st) !== -1) return 'processando';
  if (REP_FALHA.indexOf(st) !== -1) return 'falha';
  if (c.repasseEm) return 'ok';   // legado: repasseEm gravado sem status
  return 'pendente';
}

function badgeRepasse(c, valor) {
  const classe = repClassificar(c);
  if (classe === 'ok') {
    const quando = c.repasseEfetivadoEm || c.repasseEm;
    const via = c.repasseStatus === 'MANUAL' ? ' (manual)' : '';
    return `<span class="badge badge-success">Repassado${via}${quando ? ' · ' + escapeHtml(fmtData(quando)) : ''}</span>`;
  }
  if (classe === 'processando') {
    return '<span class="badge badge-warning">Repassando…</span>';
  }
  if (classe === 'aguardando') {
    return '<span class="badge badge-info">Aguardando aprovação</span>';
  }
  if (classe === 'falha') {
    const motivo = c.repasseFalhaMotivo ? ' · ' + escapeHtml(c.repasseFalhaMotivo) : '';
    return `<span class="badge badge-danger">Falhou${motivo}</span>`;
  }
  return valor > 0
    ? '<span class="badge badge-warning">A repassar</span>'
    : '<span class="badge badge-muted">Sem boletos</span>';
}

function montarAcoesRepasse(cid, id, c, valor, classe) {
  const podeLancar = pode('repasses', 'editar');
  const podeAprov = pode('aprovarRepasse');
  const comprov = c.repasseComprovanteUrl
    ? `<a class="btn btn-secondary btn-sm" href="${escapeHtml(c.repasseComprovanteUrl)}" target="_blank" rel="noopener">Comprovante</a> `
    : '';

  if (classe === 'ok') {
    if (!podeLancar) return comprov;
    return comprov + `<button class="btn btn-secondary btn-sm" onclick="desfazerRepasse('${cid}','${id}')">Desfazer registro</button>`;
  }
  if (classe === 'processando') {
    return comprov || '<span class="muted" style="font-size:12px;">aguardando confirmação do Asaas…</span>';
  }
  if (classe === 'aguardando') {
    let btns = '';
    if (podeAprov) {
      btns += `<button class="btn btn-success btn-sm" onclick="abrirAprovacaoRepasse('${cid}','${id}')">Aprovar repasse</button> `;
    }
    if (podeLancar) {
      btns += `<button class="btn btn-secondary btn-sm" onclick="desfazerRepasse('${cid}','${id}')">Cancelar</button>`;
    }
    return btns || '<span class="muted" style="font-size:12px;">aguardando aprovação</span>';
  }
  // pendente ou falha
  if (valor > 0 && podeLancar) {
    return `<button class="btn btn-success btn-sm" onclick="solicitarRepasse('${cid}','${id}',${valor})">Solicitar repasse</button>
            <button class="btn btn-secondary btn-sm" onclick="registrarRepasse('${cid}','${id}',${valor})">Registrar manual</button>`;
  }
  return '';
}

function renderRepasses() {
  return renderComContexto(
    'Antecipação / Repasses',
    'A D.R. Global garante e repassa ao condomínio 100% das cotas de cada competência.',
    async (cid) => {
      const [snapComp, snapB, snapCond] = await Promise.all([
        refSub(cid, 'competencias').get(),
        refSub(cid, 'boletos').get(),
        refCondominios().doc(cid).get(),
      ]);

      const cond = snapCond.exists ? snapCond.data() : {};
      repCondominio = { nome: cond.nome || '', repasse: cond.repasse || {} };
      repComps = {};

      // Σ das cotas (boletos, menos os de honorário) por competência.
      const cotaPorComp = {};
      snapB.docs.forEach((d) => {
        const b = d.data();
        if (b.tipo === 'honorario') return;
        if (b.status === 'CANCELADO') return;   // boleto cancelado não entra no repasse
        cotaPorComp[b.competenciaId] = (cotaPorComp[b.competenciaId] || 0) + (Number(b.valor) || 0);
      });

      const comps = snapComp.docs
        .map((d) => ({ id: d.id, c: d.data() }))
        .sort((a, z) => ((z.c.ano || 0) * 100 + (z.c.mes || 0)) - ((a.c.ano || 0) * 100 + (a.c.mes || 0)));

      let totalAReprassar = 0;
      let totalRepassado = 0;
      let nAguardando = 0;
      const semChavePix = !(repCondominio.repasse && repCondominio.repasse.pixChave);

      const linhas = comps.map(({ id, c }) => {
        repComps[id] = c;
        const valor = cotaPorComp[id] || 0;
        const classe = repClassificar(c);
        const valorRepasse = (c.repasseValor != null ? c.repasseValor : valor);
        if (classe === 'ok' || classe === 'processando') totalRepassado += valorRepasse;
        else totalAReprassar += valor;
        if (classe === 'aguardando') nAguardando++;

        return `<tr>
          <td>${escapeHtml(rotuloCompetencia(c))}</td>
          <td>${escapeHtml(fmtData(c.vencimento))}</td>
          <td class="col-num">${escapeHtml(fmtMoeda(valor))}</td>
          <td>${badgeRepasse(c, valor)}</td>
          <td class="acoes">${montarAcoesRepasse(cid, id, c, valor, classe)}</td>
        </tr>`;
      }).join('');

      const tabela = comps.length
        ? `<div class="tabela-wrap"><table class="tabela">
             <thead><tr><th>Competência</th><th>Vencimento</th><th>Valor a repassar</th><th>Status</th><th>Ações</th></tr></thead>
             <tbody>${linhas}</tbody></table></div>`
        : '<div class="empty-state">Nenhuma competência cadastrada.</div>';

      const avisoAprovar = (pode('aprovarRepasse') && nAguardando)
        ? `<div class="card" style="border-left:3px solid var(--info,#1D4ED8);">
             <p class="muted" style="margin:0;font-size:13px;">
               <strong>${nAguardando} repasse(s) aguardando aprovação.</strong>
               Clique em “Aprovar repasse” na linha — vai pedir sua senha e o código do Google Authenticator.
             </p>
           </div>`
        : '';

      const avisoPix = (pode('repasses', 'editar') && comps.length && semChavePix)
        ? `<div class="card" style="border-left:3px solid var(--warning,#C2410C);">
             <p class="muted" style="margin:0;font-size:13px;">
               <strong>Sem chave Pix cadastrada.</strong> Cadastre em Cadastros → Condomínios → Editar →
               seção “Repasse ao condomínio” — sem ela o repasse não pode ser aprovado.
             </p>
           </div>`
        : '';

      document.getElementById('ctx-conteudo').innerHTML = `
        ${avisoAprovar}
        ${avisoPix}
        <div class="card">
          ${tabela}
          ${comps.length ? `<p style="margin-top:12px;">
            A repassar: <strong>${escapeHtml(fmtMoeda(totalAReprassar))}</strong> ·
            já repassado: <strong>${escapeHtml(fmtMoeda(totalRepassado))}</strong>
          </p>` : ''}
        </div>`;
    },
  );
}

// -------------------------------------------------------------
// Solicitar (lançar) — cria a solicitação; não move dinheiro.
// -------------------------------------------------------------
async function solicitarRepasse(cid, compId, valor) {
  if (!(valor > 0)) { alert('Não há valor a repassar nesta competência.'); return; }
  const rep = repCondominio.repasse || {};
  const semChave = !rep.pixChave || !rep.pixTipo;
  const ok = await confirmar({
    titulo: 'Solicitar repasse',
    mensagem: `Criar uma solicitação de repasse de ${fmtMoeda(valor)} ao condomínio? `
      + 'O dinheiro só sai depois que alguém autorizado aprovar (senha + Google Authenticator).'
      + (semChave ? ' Atenção: o condomínio ainda não tem chave Pix cadastrada.' : ''),
    okLabel: 'Solicitar',
  });
  if (!ok) return;
  try {
    await refSub(cid, 'competencias').doc(compId).update({
      repasseStatus: 'AGUARDANDO_APROVACAO',
      repasseValor: valor,
      repasseSolicitadoPor: State.user ? State.user.uid : null,
      repasseSolicitadoEmail: State.user ? State.user.email : null,
      repasseSolicitadoEm: firebase.firestore.FieldValue.serverTimestamp(),
      repasseTransferId: null,
      repasseEm: null,
      repasseEfetivadoEm: null,
      repasseFalhaMotivo: null,
      repasseComprovanteUrl: null,
    });
    renderRepasses();
  } catch (err) {
    alert('Falha ao solicitar: ' + (err.message || err));
  }
}

// -------------------------------------------------------------
// Aprovar — senha + Google Authenticator; o Pix é disparado no Worker.
// -------------------------------------------------------------
function abrirAprovacaoRepasse(cid, compId) {
  const c = repComps[compId] || {};
  const valor = c.repasseValor != null ? c.repasseValor : 0;
  const rep = repCondominio.repasse || {};
  const corpo = `
    <p>Competência: <strong>${escapeHtml(rotuloCompetencia(c))}</strong></p>
    <p>Condomínio: <strong>${escapeHtml(repCondominio.nome || '—')}</strong></p>
    <p>Valor do repasse: <strong>${escapeHtml(fmtMoeda(valor))}</strong></p>
    <p class="muted" style="font-size:12px;">Destino: chave Pix ${escapeHtml(rotuloPixTipo(rep.pixTipo))} — ${escapeHtml(rep.pixChave || 'não cadastrada')}.</p>
    ${c.repasseSolicitadoEmail ? `<p class="muted" style="font-size:12px;">Solicitado por ${escapeHtml(c.repasseSolicitadoEmail)}.</p>` : ''}
    ${campo('Sua senha', '<input type="password" id="aprov-senha" autocomplete="current-password">', true)}
    ${campo('Código do Google Authenticator', '<input type="text" id="aprov-totp" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="6 dígitos">', true)}
    <p class="muted" style="font-size:12px;">Aprovar dispara o Pix de verdade ao condomínio — é irreversível.</p>`;
  abrirModalForm('Aprovar repasse', corpo, () => confirmarAprovacaoRepasse(cid, compId), 'Aprovar e repassar');
}

async function confirmarAprovacaoRepasse(cid, compId) {
  if (repEmAndamento) return;
  const senha = valId('aprov-senha');
  const totp = (valId('aprov-totp') || '').replace(/\D/g, '');
  if (!senha) { erroModal('Informe sua senha.'); return; }
  if (totp.length !== 6) { erroModal('Informe o código de 6 dígitos do Google Authenticator.'); return; }
  const user = auth.currentUser;
  if (!user) { erroModal('Sessão expirada — entre novamente.'); return; }

  repEmAndamento = true;
  travarSalvar(true);
  try {
    // Reautentica (prova a senha) e pega um ID token fresco (auth_time recente).
    const cred = firebase.auth.EmailAuthProvider.credential(user.email, senha);
    await user.reauthenticateWithCredential(cred);
    const idToken = await user.getIdToken(true);

    const r = await fetch(`${WORKER_ASAAS_URL}/aprovar-repasse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken, totp, cid, compId }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.success) throw new Error(j.error || 'falha na aprovação');
    fecharModalForm();
    renderSection(State.currentSection);
  } catch (err) {
    const code = err && err.code;
    const msg = (code === 'auth/wrong-password' || code === 'auth/invalid-credential')
      ? 'Senha incorreta.'
      : ((err && err.message) || err);
    travarSalvar(false, 'Aprovar e repassar');
    erroModal('Falha: ' + msg);
  } finally {
    repEmAndamento = false;
  }
}

// -------------------------------------------------------------
// Registro manual — repasse feito por fora do sistema (não move dinheiro).
// -------------------------------------------------------------
function registrarRepasse(cid, compId, valor) {
  const corpo = `
    <p>Valor a repassar ao condomínio: <strong>${escapeHtml(fmtMoeda(valor))}</strong></p>
    ${campo('Data do repasse', `<input type="date" id="rep-data" value="${repHojeISO()}">`, true)}
    <p class="muted" style="font-size:12px;">Use quando o repasse foi feito por fora do sistema (TED, dinheiro, Pix manual). Só registra a data — não transfere nada pelo Asaas.</p>`;
  abrirModalForm('Registrar repasse manual', corpo, () => salvarRepasse(cid, compId, valor), 'Registrar repasse');
}

async function salvarRepasse(cid, compId, valor) {
  const data = valId('rep-data');
  if (!data) { erroModal('Informe a data do repasse.'); return; }
  travarSalvar(true);
  try {
    await refSub(cid, 'competencias').doc(compId).update({
      repasseEm: data,
      repasseValor: valor,
      repasseStatus: 'MANUAL',
      repasseTransferId: null,
      repasseEfetivadoEm: null,
      repasseFalhaMotivo: null,
      repasseComprovanteUrl: null,
    });
    fecharModalForm();
    renderRepasses();
  } catch (err) {
    travarSalvar(false, 'Registrar repasse');
    erroModal('Falha ao registrar: ' + (err.message || err));
  }
}

async function desfazerRepasse(cid, compId) {
  const ok = await confirmar({
    titulo: 'Desfazer / cancelar repasse',
    mensagem: 'Remove o registro de repasse desta competência (volta para "a repassar"). Se um Pix já foi enviado pelo Asaas, ele NÃO é cancelado — isso afeta só o controle interno.',
    okLabel: 'Confirmar', perigo: true,
  });
  if (!ok) return;
  try {
    await refSub(cid, 'competencias').doc(compId).update({
      repasseEm: null,
      repasseValor: null,
      repasseStatus: null,
      repasseTransferId: null,
      repasseEfetivadoEm: null,
      repasseFalhaMotivo: null,
      repasseComprovanteUrl: null,
      repasseAsaasEvent: null,
      repasseAtualizadoEm: null,
      repasseSolicitadoPor: null,
      repasseSolicitadoEmail: null,
      repasseSolicitadoEm: null,
    });
    renderRepasses();
  } catch (err) {
    alert('Falha ao desfazer: ' + (err.message || err));
  }
}

SECTION_RENDERERS.repasses = renderRepasses;

// =============================================================
// Painel de Repasses — visão consolidada de TODOS os condomínios.
// Pro gestor que aprova: junta os repasses de todos os condomínios numa
// tela só, já filtrada nos que aguardam aprovação. A aprovação reaproveita
// o mesmo fluxo (senha + Google Authenticator) da tela por condomínio.
// =============================================================
let repGeralCtx = null;

async function renderRepassesGeral() {
  const content = $('content');
  content.innerHTML = '<div class="loader">Carregando repasses…</div>';
  try {
    const snapCond = await refCondominios().get();
    const conds = snapCond.docs
      .map((d) => Object.assign({ _id: d.id }, d.data()))
      .filter((c) => c.ativo !== false);

    const snaps = await Promise.all(
      conds.map((c) => refSub(c._id, 'competencias').get()),
    );

    const itens = [];
    conds.forEach((c, i) => {
      snaps[i].docs.forEach((d) => {
        const comp = d.data();
        const classe = repClassificar(comp);
        if (classe === 'pendente') return;   // sem repasse lançado — fora do painel
        itens.push({
          cid: c._id,
          condNome: c.nome || '—',
          condRepasse: c.repasse || {},
          compId: d.id,
          comp,
          classe,
          valor: comp.repasseValor != null ? comp.repasseValor : 0,
        });
      });
    });
    repGeralCtx = { itens };

    const nAguardando = itens.filter((it) => it.classe === 'aguardando').length;
    const filtroInicial = nAguardando ? 'aguardando' : 'todos';
    const sel = (v) => (v === filtroInicial ? ' selected' : '');
    const aviso = (pode('aprovarRepasse') && nAguardando)
      ? `<div class="card" style="border-left:3px solid var(--info,#1D4ED8);">
           <p class="muted" style="margin:0;font-size:13px;">
             <strong>${nAguardando} repasse(s) aguardando aprovação</strong> no total.
             Clique em “Aprovar repasse” na linha — vai pedir sua senha e o código do Google Authenticator.
           </p></div>`
      : '';

    content.innerHTML = `
      <div class="section-head">
        <div><h2>Painel de Repasses</h2>
        <p>Repasses de todos os condomínios numa tela só.</p></div>
      </div>
      ${aviso}
      <div class="card">
        <div class="form-group" style="max-width:240px;margin-bottom:4px;">
          <label>Situação</label>
          <select id="repg-filtro" onchange="renderTabelaRepassesGeral()">
            <option value="todos"${sel('todos')}>Todas</option>
            <option value="aguardando"${sel('aguardando')}>Aguardando aprovação</option>
            <option value="ok"${sel('ok')}>Repassados</option>
            <option value="processando"${sel('processando')}>Processando</option>
            <option value="falha"${sel('falha')}>Falharam</option>
          </select>
        </div>
        <div id="repg-tabela" style="margin-top:14px;"></div>
      </div>`;
    renderTabelaRepassesGeral();
  } catch (err) {
    content.innerHTML = cardErro('Falha ao carregar o painel de repasses.', err);
  }
}

function renderTabelaRepassesGeral() {
  const ctx = repGeralCtx;
  const alvo = document.getElementById('repg-tabela');
  if (!ctx || !alvo) return;
  const filtro = (($('repg-filtro') || {}).value) || 'todos';
  const podeAprov = pode('aprovarRepasse');

  const lista = ctx.itens
    .filter((it) => filtro === 'todos' || it.classe === filtro)
    .sort((a, z) => {
      if (a.classe === 'aguardando' && z.classe !== 'aguardando') return -1;
      if (z.classe === 'aguardando' && a.classe !== 'aguardando') return 1;
      return String(z.comp.vencimento || '').localeCompare(String(a.comp.vencimento || ''));
    });

  if (!lista.length) {
    alvo.innerHTML = '<div class="empty-state">Nenhum repasse nesta seleção.</div>';
    return;
  }

  let total = 0;
  const linhas = lista.map((it) => {
    total += Number(it.valor) || 0;
    const comprov = it.comp.repasseComprovanteUrl
      ? `<a class="btn btn-secondary btn-sm" href="${escapeHtml(it.comp.repasseComprovanteUrl)}" target="_blank" rel="noopener">Comprovante</a>`
      : '';
    const aprovar = (it.classe === 'aguardando' && podeAprov)
      ? `<button class="btn btn-success btn-sm" onclick="abrirAprovacaoGeral('${it.cid}','${it.compId}')">Aprovar repasse</button>`
      : '';
    const acao = [aprovar, comprov].filter(Boolean).join(' ')
      || '<span class="muted" style="font-size:12px;">—</span>';
    return `<tr>
      <td>${escapeHtml(it.condNome)}</td>
      <td>${escapeHtml(rotuloCompetencia(it.comp))}</td>
      <td class="col-num">${escapeHtml(fmtMoeda(it.valor))}</td>
      <td>${badgeRepasse(it.comp, it.valor)}</td>
      <td class="acoes">${acao}</td>
    </tr>`;
  }).join('');

  alvo.innerHTML = `
    <div class="tabela-wrap" style="max-height:480px;overflow-y:auto;">
      <table class="tabela">
        <thead><tr><th>Condomínio</th><th>Competência</th><th>Valor</th><th>Status</th><th>Ações</th></tr></thead>
        <tbody>${linhas}</tbody>
      </table>
    </div>
    <p style="margin-top:12px;">${lista.length} repasse(s) · total ${escapeHtml(fmtMoeda(total))}</p>`;
}

// Aprova a partir do painel consolidado: prepara os globais que o fluxo de
// aprovação por condomínio espera (repCondominio, repComps) e abre o modal.
function abrirAprovacaoGeral(cid, compId) {
  const ctx = repGeralCtx;
  if (!ctx) return;
  const it = ctx.itens.find((x) => x.cid === cid && x.compId === compId);
  if (!it) return;
  repCondominio = { nome: it.condNome, repasse: it.condRepasse };
  repComps[compId] = it.comp;
  abrirAprovacaoRepasse(cid, compId);
}

SECTION_RENDERERS.repassesGeral = renderRepassesGeral;
