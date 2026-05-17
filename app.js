// =============================================================
// DRG-Garantidora — app.js
// Fase 1: fundação — Auth Firebase + 3 perfis + navegação + shell
// =============================================================

const APP_VERSION = '0.1.0';

// =============================================================
// State
// =============================================================
const State = {
  user: null,           // Firebase Auth user
  userDoc: null,        // documento Firestore users/{uid}
  role: null,           // 'super_admin' | 'operador_drg' | 'sindico' | 'condomino'
  condominioId: null,   // escopo do síndico / condômino
  unidadeId: null,      // escopo do condômino
  condominioSelecionadoId: null, // condomínio em contexto (escolhido pela equipe)
  perfilId: null,       // id do perfil de permissões (coleção perfis)
  perfil: null,         // documento do perfil resolvido no login
  currentSection: 'dashboard',
  navHistory: [],       // pilha de seções (botão Voltar)
};

// =============================================================
// Catálogo de módulos da plataforma
// fase = em qual fase o módulo passa a ser funcional
// =============================================================
const MODULOS = {
  dashboard:   { label: 'Dashboard',                grupo: 'Visão Geral',    fase: 1 },
  condominios: { label: 'Condomínios',              grupo: 'Cadastros',      fase: 1 },
  unidades:    { label: 'Unidades',                 grupo: 'Cadastros',      fase: 1 },
  condominos:  { label: 'Condôminos',               grupo: 'Cadastros',      fase: 1 },
  contratos:   { label: 'Contratos',                grupo: 'Cadastros',      fase: 1 },
  importarIA:       { label: 'Importar contrato (IA)', grupo: 'Cadastros', fase: 1 },
  importarPlanilha: { label: 'Importar planilha (IA)', grupo: 'Cadastros', fase: 1 },
  competencias: { label: 'Competências (mensal)',   grupo: 'Operação',       fase: 2 },
  faturamento: { label: 'Faturamento & Boletos',    grupo: 'Operação',       fase: 2 },
  cobranca:    { label: 'Régua de Cobrança',        grupo: 'Operação',       fase: 2 },
  conciliacao: { label: 'Conciliação',              grupo: 'Operação',       fase: 2 },
  repasses:    { label: 'Antecipação / Repasses',   grupo: 'Operação',       fase: 3 },
  repassesGeral: { label: 'Painel de Repasses',     grupo: 'Operação',       fase: 3 },
  financeiro:  { label: 'Painel Financeiro',        grupo: 'Financeiro',     fase: 3 },
  carteira:    { label: 'Carteira Adquirida',       grupo: 'Financeiro',     fase: 3 },
  juridico:    { label: 'Cobrança Judicial',        grupo: 'Financeiro',     fase: 4 },
  calculadora: { label: 'Calculadora de Antecipação', grupo: 'Ferramentas',  fase: 3 },
  proposta:    { label: 'Simulador de Proposta',    grupo: 'Ferramentas',    fase: 3 },
  gestaoCondominios: { label: 'Gestão de Condomínios', grupo: 'Administração', fase: 2 },
  usuarios:    { label: 'Usuários',                 grupo: 'Administração',  fase: 1 },
  perfis:      { label: 'Perfis & Permissões',      grupo: 'Administração',  fase: 1 },
  auditoria:   { label: 'Auditoria',                grupo: 'Administração',  fase: 4 },
};

// Ordem dos grupos no menu lateral
const ORDEM_GRUPOS = ['Visão Geral', 'Cadastros', 'Operação', 'Financeiro', 'Ferramentas', 'Administração'];

// Módulos que têm a sub-permissão "Editar" no editor de perfil.
// Os demais módulos do menu são só "Acesso"; o dashboard é sempre liberado.
const MODULOS_COM_EDITAR = [
  'condominios', 'unidades', 'condominos', 'contratos', 'competencias',
  'faturamento', 'cobranca', 'conciliacao', 'repasses', 'carteira',
  'juridico', 'gestaoCondominios', 'usuarios', 'perfis',
];
// Módulos do catálogo que NÃO viram card no editor (ações contextuais —
// liberadas junto do "Editar" do módulo pai).
const MODULOS_SEM_CARD = ['importarIA', 'importarPlanilha'];
// Permissões de ação — cards próprios no editor de perfil, sem "Editar".
const ACOES_PERM = {
  aprovarRepasse: {
    label: 'Aprovar repasse',
    grupo: 'Operação',
    descricao: 'Autorizar a transferência do repasse ao condomínio (dinheiro real).',
  },
};

// Quais módulos cada perfil enxerga
const NAV_POR_PERFIL = {
  super_admin:  ['dashboard','condominios','unidades','condominos','contratos','competencias','faturamento','cobranca','conciliacao','repasses','repassesGeral','financeiro','carteira','juridico','calculadora','proposta','gestaoCondominios','usuarios','perfis','auditoria'],
  operador_drg: ['dashboard','condominios','unidades','condominos','contratos','competencias','faturamento','cobranca','conciliacao','repasses','repassesGeral','financeiro','carteira','juridico','calculadora','proposta'],
  sindico:      ['dashboard','condominios','unidades','condominos','faturamento','cobranca','repasses'],
  condomino:    ['dashboard','faturamento'],
};

const ROTULO_PERFIL = {
  super_admin:  'Equipe D.R. Global (admin)',
  operador_drg: 'Equipe D.R. Global',
  sindico:      'Síndico',
  condomino:    'Condômino',
};

function isEquipe() { return State.role === 'super_admin' || State.role === 'operador_drg'; }

// =============================================================
// Perfis de permissão — camada de UI (menu + botões) sobre o tier (role).
// O tier e as regras do Firestore controlam o acesso ao DADO; o perfil
// controla o que aparece na tela.
// =============================================================

// Carrega o perfil do usuário, com fallback: perfilId -> seed_<role> -> null.
async function carregarPerfil(perfilId, role) {
  const tentar = async (id) => {
    try {
      const d = await db.collection('perfis').doc(id).get();
      return d.exists ? Object.assign({ _id: d.id }, d.data()) : null;
    } catch (_) { return null; }
  };
  let p = perfilId ? await tentar(perfilId) : null;
  if (!p && perfilId !== 'seed_' + role) p = await tentar('seed_' + role);
  return p; // null -> pode() cai no fallback fixo (NAV_POR_PERFIL)
}

// Módulos que o usuário enxerga no menu — derivado do perfil (ou do fallback).
function modulosVisiveis() {
  const p = State.perfil;
  if (p && p.permissoes) {
    const liberados = {};
    Object.keys(p.permissoes).forEach((id) => {
      if (MODULOS[id] && p.permissoes[id] && p.permissoes[id].acesso) liberados[id] = true;
    });
    liberados.dashboard = true; // sempre visível
    return Object.keys(MODULOS).filter((id) => liberados[id]);
  }
  return NAV_POR_PERFIL[State.role] || ['dashboard'];
}

// Checa permissão. pode('x','acesso') | pode('x','editar') | pode('aprovarRepasse').
function pode(chave, nivel) {
  if (chave === 'dashboard') return true;
  // Piso anti-lockout: o tier super_admin nunca perde as telas de administração.
  if (State.role === 'super_admin'
      && (nivel === 'acesso' || nivel === 'editar')
      && ['perfis', 'usuarios', 'auditoria', 'gestaoCondominios'].indexOf(chave) !== -1) {
    return true;
  }
  const p = State.perfil;
  if (!p) {
    // Sem perfil resolvido -> comportamento legado (como antes dos perfis).
    if (nivel === 'editar') return isEquipe();
    if (nivel === 'acesso') return (NAV_POR_PERFIL[State.role] || []).indexOf(chave) !== -1;
    return isEquipe(); // permissão de ação
  }
  if (nivel === undefined) {
    return !!(p.acoes && p.acoes[chave]); // permissão de ação
  }
  const m = (p.permissoes && p.permissoes[chave]) || {};
  if (nivel === 'editar') return !!(m.acesso && m.editar);
  return !!m.acesso;
}

// =============================================================
// Helpers de UI
// =============================================================
function $(id) { return document.getElementById(id); }

function showScreen(id) {
  ['screen-login', 'screen-app'].forEach((s) => {
    const el = $(s);
    if (el) el.classList.toggle('active', s === id);
  });
}

function showAlert(targetId, msg, kind = 'error') {
  const el = $(targetId);
  if (!el) return;
  el.textContent = msg;
  el.className = `alert alert-${kind}`;
  el.style.display = 'block';
  if (kind !== 'error') setTimeout(() => { el.style.display = 'none'; }, 4000);
}

function clearAlert(targetId) {
  const el = $(targetId);
  if (el) el.style.display = 'none';
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// =============================================================
// Formatação
// =============================================================
function fmtData(value) {
  if (!value) return '—';
  const d = value.toDate ? value.toDate() : new Date(value);
  return isNaN(d) ? '—' : d.toLocaleDateString('pt-BR');
}

function fmtDataHora(value) {
  if (!value) return '—';
  const d = value.toDate ? value.toDate() : new Date(value);
  return isNaN(d) ? '—' : d.toLocaleString('pt-BR');
}

function fmtMoeda(v) {
  const n = Number(v);
  if (isNaN(n)) return 'R$ 0,00';
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// =============================================================
// Máscaras (documentos/telefone/CEP são salvos só com dígitos)
// =============================================================
function maskCPF(v) {
  v = (v || '').replace(/\D/g, '').slice(0, 11);
  if (v.length > 9) return `${v.slice(0,3)}.${v.slice(3,6)}.${v.slice(6,9)}-${v.slice(9)}`;
  if (v.length > 6) return `${v.slice(0,3)}.${v.slice(3,6)}.${v.slice(6)}`;
  if (v.length > 3) return `${v.slice(0,3)}.${v.slice(3)}`;
  return v;
}

function maskCNPJ(v) {
  v = (v || '').replace(/\D/g, '').slice(0, 14);
  if (v.length > 12) return `${v.slice(0,2)}.${v.slice(2,5)}.${v.slice(5,8)}/${v.slice(8,12)}-${v.slice(12)}`;
  if (v.length > 8)  return `${v.slice(0,2)}.${v.slice(2,5)}.${v.slice(5,8)}/${v.slice(8)}`;
  if (v.length > 5)  return `${v.slice(0,2)}.${v.slice(2,5)}.${v.slice(5)}`;
  if (v.length > 2)  return `${v.slice(0,2)}.${v.slice(2)}`;
  return v;
}

function maskCPFCNPJ(v) {
  const d = (v || '').replace(/\D/g, '');
  return d.length <= 11 ? maskCPF(d) : maskCNPJ(d);
}

function maskTelefone(v) {
  v = (v || '').replace(/\D/g, '').slice(0, 11);
  if (v.length === 0) return '';
  if (v.length <= 2)  return `(${v}`;
  if (v.length <= 6)  return `(${v.slice(0,2)}) ${v.slice(2)}`;
  if (v.length <= 10) return `(${v.slice(0,2)}) ${v.slice(2,6)}-${v.slice(6)}`;
  return `(${v.slice(0,2)}) ${v.slice(2,7)}-${v.slice(7)}`;
}

function maskCEP(v) {
  v = (v || '').replace(/\D/g, '').slice(0, 8);
  return v.length > 5 ? `${v.slice(0,5)}-${v.slice(5)}` : v;
}

// =============================================================
// Validadores
// =============================================================
function isCPFValid(cpf) {
  cpf = (cpf || '').replace(/\D/g, '');
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(cpf[i]) * (10 - i);
  let d1 = 11 - (sum % 11); if (d1 >= 10) d1 = 0;
  if (d1 !== parseInt(cpf[9])) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(cpf[i]) * (11 - i);
  let d2 = 11 - (sum % 11); if (d2 >= 10) d2 = 0;
  return d2 === parseInt(cpf[10]);
}

function isCNPJValid(cnpj) {
  cnpj = (cnpj || '').replace(/\D/g, '');
  if (cnpj.length !== 14 || /^(\d)\1{13}$/.test(cnpj)) return false;
  const calc = (base) => {
    let pos = base.length - 7, sum = 0;
    for (let i = base.length; i >= 1; i--) {
      sum += base[base.length - i] * pos--;
      if (pos < 2) pos = 9;
    }
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const nums = cnpj.split('').map(Number);
  if (calc(nums.slice(0, 12)) !== nums[12]) return false;
  return calc(nums.slice(0, 13)) === nums[13];
}

// =============================================================
// Modal de confirmação — retorna Promise<boolean>
// =============================================================
function confirmar({ titulo = 'Confirmar?', mensagem = 'Tem certeza?', okLabel = 'Confirmar', perigo = false } = {}) {
  return new Promise((resolve) => {
    $('modal-confirm-titulo').textContent = titulo;
    $('modal-confirm-mensagem').textContent = mensagem;
    const btnOk = $('btn-modal-confirm-ok');
    const btnCancel = $('btn-modal-confirm-cancelar');
    btnOk.textContent = okLabel;
    btnOk.className = perigo ? 'btn btn-danger' : 'btn btn-primary';
    $('modal-confirmar').style.display = 'flex';
    const fechar = (resultado) => {
      $('modal-confirmar').style.display = 'none';
      btnOk.onclick = null;
      btnCancel.onclick = null;
      resolve(resultado);
    };
    btnOk.onclick = () => fechar(true);
    btnCancel.onclick = () => fechar(false);
  });
}

// =============================================================
// Autenticação
// =============================================================
function togglePasswordVisibility(inputId, btn) {
  const inp = $(inputId);
  if (!inp) return;
  const mostrar = inp.type === 'password';
  inp.type = mostrar ? 'text' : 'password';
  btn.textContent = mostrar ? 'Ocultar' : 'Ver';
}

function abrirEsqueciSenha() {
  $('forgot-password-box').style.display = 'block';
  const email = $('login-email').value.trim();
  if (email) $('forgot-email').value = email;
}

function fecharEsqueciSenha() {
  $('forgot-password-box').style.display = 'none';
  clearAlert('forgot-alert');
}

async function enviarResetSenha() {
  const email = $('forgot-email').value.trim();
  if (!email) { showAlert('forgot-alert', 'Informe o e-mail.', 'error'); return; }
  const btn = $('btn-enviar-reset');
  btn.disabled = true;
  try {
    await auth.sendPasswordResetEmail(email);
    showAlert('forgot-alert', 'Link enviado. Confira seu e-mail.', 'success');
  } catch (err) {
    showAlert('forgot-alert', traduzErroAuth(err), 'error');
  } finally {
    btn.disabled = false;
  }
}

async function login() {
  if (!window.FIREBASE_CONFIGURADO) {
    showAlert('login-alert', 'Firebase ainda não configurado. Edite firebase-config.js.', 'error');
    return;
  }
  const email = $('login-email').value.trim();
  const senha = $('login-senha').value;
  if (!email || !senha) {
    showAlert('login-alert', 'Preencha e-mail e senha.', 'error');
    return;
  }
  const btn = $('btn-login');
  btn.disabled = true;
  btn.textContent = 'Entrando...';
  clearAlert('login-alert');
  try {
    await auth.signInWithEmailAndPassword(email, senha);
    // o onAuthStateChanged assume daqui
  } catch (err) {
    showAlert('login-alert', traduzErroAuth(err), 'error');
    btn.disabled = false;
    btn.textContent = 'Entrar';
  }
}

async function logout() {
  const ok = await confirmar({ titulo: 'Sair', mensagem: 'Deseja encerrar a sessão?', okLabel: 'Sair' });
  if (ok) await auth.signOut();
}

function traduzErroAuth(err) {
  const mapa = {
    'auth/invalid-email': 'E-mail inválido.',
    'auth/user-disabled': 'Usuário desativado.',
    'auth/user-not-found': 'Usuário não encontrado.',
    'auth/wrong-password': 'Senha incorreta.',
    'auth/invalid-credential': 'E-mail ou senha incorretos.',
    'auth/too-many-requests': 'Muitas tentativas. Tente mais tarde.',
    'auth/network-request-failed': 'Falha de conexão. Verifique a internet.',
    'auth/invalid-api-key': 'Configuração do Firebase inválida.',
  };
  return mapa[err && err.code] || (err && err.message) || 'Erro inesperado.';
}

// =============================================================
// Pós-login — carrega o perfil e monta o app
// =============================================================
async function aoEntrar(user) {
  State.user = user;
  let snap;
  try {
    snap = await db.collection('users').doc(user.uid).get();
  } catch (err) {
    showAlert('login-alert', 'Falha ao carregar o perfil. Tente novamente.', 'error');
    await auth.signOut();
    return;
  }

  if (!snap.exists) {
    showAlert('login-alert', 'Seu usuário não tem perfil cadastrado. Contate a D.R. Global.', 'error');
    await auth.signOut();
    return;
  }

  const doc = snap.data();
  if (doc.ativo === false) {
    showAlert('login-alert', 'Seu acesso está desativado. Contate a D.R. Global.', 'error');
    await auth.signOut();
    return;
  }

  // Síndico/condômino: se o condomínio vinculado ao acesso foi inativado,
  // o vínculo com a D.R. Global acabou — bloqueia o login. A equipe D.R.
  // Global (super_admin/operador) nunca é bloqueada por isso.
  if ((doc.role === 'sindico' || doc.role === 'condomino') && doc.condominioId) {
    try {
      const cdoc = await db.collection('condominios').doc(doc.condominioId).get();
      if (cdoc.exists && cdoc.data().ativo === false) {
        showAlert('login-alert', 'O condomínio vinculado ao seu acesso não está mais em operação na D.R. Global. Em caso de dúvida, fale com a nossa equipe.', 'error');
        await auth.signOut();
        return;
      }
    } catch (_) {
      // Falha ao verificar (rede) — não bloqueia por um erro transitório.
    }
  }

  State.userDoc = doc;
  State.role = doc.role || 'condomino';
  State.condominioId = doc.condominioId || null;
  State.unidadeId = doc.unidadeId || null;
  State.perfilId = doc.perfilId || ('seed_' + State.role);
  State.perfil = await carregarPerfil(State.perfilId, State.role);

  $('topbar-user-info').textContent = `${doc.nome || user.email} · ${ROTULO_PERFIL[State.role] || State.role}`;
  $('brand-sub').textContent = isEquipe() ? 'Cobrança garantida' : (ROTULO_PERFIL[State.role] || '');
  $('sidebar-footer').textContent = `DRG-Garantidora v${APP_VERSION}`;

  renderSidebar();
  showScreen('screen-app');

  // deep-link via ?section=
  const secInicial = new URLSearchParams(location.search).get('section');
  const permitidas = modulosVisiveis();
  navegarPara(permitidas.indexOf(secInicial) !== -1 ? secInicial : 'dashboard', true);
}

// =============================================================
// Menu lateral
// =============================================================
function renderSidebar() {
  const ids = modulosVisiveis();
  const porGrupo = {};
  ids.forEach((id) => {
    const m = MODULOS[id];
    if (!m) return;
    (porGrupo[m.grupo] = porGrupo[m.grupo] || []).push(id);
  });

  let html = '';
  ORDEM_GRUPOS.forEach((grupo) => {
    const itens = porGrupo[grupo];
    if (!itens || !itens.length) return;
    html += `<div class="nav-group"><div class="nav-group-title">${escapeHtml(grupo)}</div>`;
    itens.forEach((id) => {
      html += `<div class="nav-link" data-sec="${id}" onclick="navegarPara('${id}')">${escapeHtml(MODULOS[id].label)}</div>`;
    });
    html += `</div>`;
  });
  $('sidebar-nav').innerHTML = html;
}

function marcarNavAtiva(secId) {
  document.querySelectorAll('#sidebar-nav .nav-link').forEach((el) => {
    el.classList.toggle('active', el.dataset.sec === secId);
  });
}

// =============================================================
// Navegação entre seções
// =============================================================
function navegarPara(secId, semHistorico = false) {
  if (!MODULOS[secId]) secId = 'dashboard';
  if (secId !== 'dashboard' && !pode(secId, 'acesso')) secId = 'dashboard';
  if (!semHistorico && State.currentSection && State.currentSection !== secId) {
    State.navHistory.push(State.currentSection);
  }
  State.currentSection = secId;
  $('topbar-title').textContent = MODULOS[secId].label;
  $('btn-voltar').disabled = State.navHistory.length === 0;
  marcarNavAtiva(secId);
  renderSection(secId);
}

function voltarSecao() {
  if (!State.navHistory.length) return;
  const anterior = State.navHistory.pop();
  navegarPara(anterior, true);
}

function renderSection(secId) {
  const content = $('content');
  const mod = MODULOS[secId];
  if (secId === 'dashboard') {
    renderDashboard();
    return;
  }
  // Seções com renderer registrado (cadastros.js e fases seguintes)
  const renderer = (window.SECTION_RENDERERS || {})[secId];
  if (renderer) {
    renderer();
    return;
  }
  // Módulos ainda não construídos — placeholder honesto com a fase prevista
  content.innerHTML = `
    <div class="card">
      <div class="placeholder-section">
        <h3>${escapeHtml(mod.label)}</h3>
        <p>Módulo previsto para a <strong>Fase ${mod.fase}</strong> da plataforma.</p>
        <p class="muted">Em construção.</p>
      </div>
    </div>`;
}

// =============================================================
// Dashboard
// =============================================================
async function renderDashboard() {
  const content = $('content');
  const nome = (State.userDoc && State.userDoc.nome) || 'bem-vindo';

  content.innerHTML = `
    <div class="card">
      <h3>Olá, ${escapeHtml(nome)}</h3>
      <p class="muted">Plataforma de cobrança garantida de condomínios — DRG-Garantidora v${APP_VERSION}.</p>
    </div>
    <div class="dashboard-grid" id="dash-stats">
      <div class="stat-card"><span class="stat-label">Carregando…</span></div>
    </div>
    <div class="card">
      <h3>Próximos passos</h3>
      <p class="muted">A Fase 1 entrega os cadastros (condomínios, unidades, condôminos, contratos) e a importação por Excel/CSV. As fases seguintes abrem faturamento, cobrança e o painel financeiro.</p>
    </div>`;

  if (!isEquipe()) {
    $('dash-stats').innerHTML = `
      <div class="stat-card">
        <span class="stat-label">Perfil</span>
        <span class="stat-value" style="font-size:18px;">${escapeHtml(ROTULO_PERFIL[State.role] || '')}</span>
        <span class="stat-sub">Seus dados aparecem nas seções do menu.</span>
      </div>`;
    return;
  }

  try {
    const snap = await db.collection('condominios').get();
    let ativos = 0;
    snap.forEach((d) => { if (d.data().ativo !== false) ativos++; });
    const inativos = snap.size - ativos;
    $('dash-stats').innerHTML = `
      <div class="stat-card">
        <span class="stat-label">Condomínios</span>
        <span class="stat-value">${ativos}</span>
        <span class="stat-sub">${inativos ? inativos + ' inativo(s) — ver no painel master' : 'em operação'}</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Contratos vigentes</span>
        <span class="stat-value">—</span>
        <span class="stat-sub">Disponível com o módulo Contratos</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Repasses do mês</span>
        <span class="stat-value">—</span>
        <span class="stat-sub">Disponível na Fase 3</span>
      </div>`;
  } catch (err) {
    $('dash-stats').innerHTML = `<div class="stat-card"><span class="stat-label">Indicadores</span><span class="stat-sub">Cadastre o primeiro condomínio para ver os números.</span></div>`;
  }
}

// =============================================================
// PWA
// =============================================================
let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  const banner = $('pwa-install-banner');
  if (banner && !localStorage.getItem('pwa-banner-fechado')) banner.style.display = 'flex';
});

async function acionarInstalacaoPWA() {
  fecharBannerInstalar();
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  deferredInstallPrompt = null;
}

function fecharBannerInstalar() {
  const banner = $('pwa-install-banner');
  if (banner) banner.style.display = 'none';
  localStorage.setItem('pwa-banner-fechado', '1');
}

// =============================================================
// Inicialização
// =============================================================
function init() {
  // Service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js?v=20260516b').catch(() => {});
  }

  // Enter envia o login
  ['login-email', 'login-senha'].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
  });

  if (!window.FIREBASE_CONFIGURADO) {
    $('config-alert').style.display = 'block';
    $('btn-login').disabled = true;
    showScreen('screen-login');
    return;
  }

  // Fluxo normal de autenticação
  auth.onAuthStateChanged((user) => {
    if (user) {
      aoEntrar(user);
    } else {
      State.user = null;
      State.userDoc = null;
      State.role = null;
      State.perfilId = null;
      State.perfil = null;
      State.navHistory = [];
      const btn = $('btn-login');
      if (btn) { btn.disabled = false; btn.textContent = 'Entrar'; }
      showScreen('screen-login');
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
