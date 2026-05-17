// =============================================================
// DRG-Garantidora — cadastros.js
// Fase 1 — Módulo Cadastros: condomínios, unidades, condôminos, contratos
// Carregado depois de app.js. Usa State, helpers e Firebase globais.
// =============================================================

window.SECTION_RENDERERS = window.SECTION_RENDERERS || {};

// Caches do último render (evita passar strings em onclick)
let cacheCondominios = {};
let cacheUnidades = {};
let cacheCondominos = {};
let cacheContratos = {};
let unidadesDoContexto = [];   // [{id, identificacao}] do condomínio em contexto

// =============================================================
// Helpers
// =============================================================
function refCondominios() { return db.collection('condominios'); }
function refSub(cid, sub) { return db.collection('condominios').doc(cid).collection(sub); }
function carimboCriacao() {
  return {
    criadoEm: firebase.firestore.FieldValue.serverTimestamp(),
    criadoPor: State.user ? State.user.uid : null,
  };
}

// Próximo número de contrato do condomínio — formato AAAA/NNN.
async function proximoNumeroContrato(cid) {
  const ano = new Date().getFullYear();
  try {
    const snap = await refSub(cid, 'contratos').get();
    return `${ano}/${String(snap.size + 1).padStart(3, '0')}`;
  } catch (e) {
    return `${ano}/001`;
  }
}

function podeEditar() { return isEquipe(); }

// =============================================================
// Régua de cobrança — indexadores e editor de faixas de atraso
// =============================================================
const INDEXADORES = [
  { id: 'INPC',  label: 'INPC (IBGE)' },
  { id: 'IPCA',  label: 'IPCA (IBGE)' },
  { id: 'IGPM',  label: 'IGP-M (FGV)' },
  { id: 'IGPDI', label: 'IGP-DI (FGV)' },
  { id: 'SELIC', label: 'SELIC' },
  { id: 'TJSP',  label: 'Tabela Prática do TJSP' },
];

// Faixas padrão de um contrato novo (modelo do contrato de referência).
const FAIXAS_PADRAO = [
  { apartirDias: 11, encargoPct: 10, aplicaCorrecao: false },
  { apartirDias: 31, encargoPct: 20, aplicaCorrecao: true },
];

// Editor de faixas reaproveitável (recebe o id do container).
function faixasRender(containerId, faixas) {
  const cont = document.getElementById(containerId);
  if (!cont) return;
  if (!faixas || !faixas.length) {
    cont.innerHTML = '<p class="muted" style="font-size:12px;margin-bottom:8px;">Nenhuma faixa — clique em “+ Adicionar faixa”.</p>';
    return;
  }
  cont.innerHTML = faixas.map((f, i) => `
    <div class="faixa-row" style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:8px;">
      <div class="form-group" style="margin:0;flex:1;min-width:110px;">
        <label>A partir de (dias)</label>
        <input type="number" class="fx-dias" value="${f.apartirDias != null ? f.apartirDias : ''}">
      </div>
      <div class="form-group" style="margin:0;flex:1;min-width:110px;">
        <label>Encargo total (%)</label>
        <input type="number" step="0.01" class="fx-enc" value="${f.encargoPct != null ? f.encargoPct : ''}">
      </div>
      <label style="font-size:13px;white-space:nowrap;margin-bottom:9px;">
        <input type="checkbox" class="fx-corr" ${f.aplicaCorrecao ? 'checked' : ''}> correção
      </label>
      <button type="button" class="btn btn-danger btn-sm" style="margin-bottom:9px;" onclick="faixaRemover('${containerId}', ${i})">Remover</button>
    </div>`).join('');
}

function faixasLer(containerId) {
  const cont = document.getElementById(containerId);
  const faixas = [];
  if (!cont) return faixas;
  cont.querySelectorAll('.faixa-row').forEach((row) => {
    const dias = row.querySelector('.fx-dias').value;
    const enc = row.querySelector('.fx-enc').value;
    faixas.push({
      apartirDias: dias === '' ? null : Number(dias),
      encargoPct: enc === '' ? null : Number(enc),
      aplicaCorrecao: row.querySelector('.fx-corr').checked,
    });
  });
  return faixas;
}

function faixaAdd(containerId) {
  const f = faixasLer(containerId);
  f.push({ apartirDias: null, encargoPct: null, aplicaCorrecao: false });
  faixasRender(containerId, f);
}

function faixaRemover(containerId, i) {
  const f = faixasLer(containerId);
  f.splice(i, 1);
  faixasRender(containerId, f);
}

function condominioAtivoId() {
  if (State.role === 'sindico' || State.role === 'condomino') return State.condominioId;
  return State.condominioSelecionadoId;
}

// Só os condomínios ativos. Os inativos ficam fora de todo o sistema —
// aparecem apenas no painel master "Gestão de Condomínios". Condomínio
// sem o campo "ativo" conta como ativo.
async function condominiosAtivos() {
  const snap = await refCondominios().orderBy('nome').get();
  return snap.docs.filter((d) => d.data().ativo !== false);
}

function cardErro(msg, err) {
  if (err) console.error('[cadastros]', err);
  return `<div class="card"><div class="empty-state">${escapeHtml(msg)}</div></div>`;
}

function soDigitos(v) { return (v || '').replace(/\D/g, ''); }
function valNum(id, padrao) {
  const el = document.getElementById(id);
  if (!el || el.value === '') return (padrao === undefined ? null : padrao);
  const n = parseFloat(String(el.value).replace(',', '.'));
  return isNaN(n) ? (padrao === undefined ? null : padrao) : n;
}
function valId(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : '';
}
function valCheck(id) {
  const el = document.getElementById(id);
  return !!(el && el.checked);
}

function rotuloTipoCondomino(t) {
  return { proprietario: 'Proprietário', inquilino: 'Inquilino', responsavel: 'Responsável' }[t] || '—';
}
function rotuloStatusContrato(s) {
  return { ativo: 'Ativo', suspenso: 'Suspenso', encerrado: 'Encerrado' }[s] || '—';
}
function badgeStatusContrato(s) {
  const cls = { ativo: 'badge-success', suspenso: 'badge-warning', encerrado: 'badge-danger' }[s] || 'badge-muted';
  return `<span class="badge ${cls}">${escapeHtml(rotuloStatusContrato(s))}</span>`;
}

// =============================================================
// Modal de formulário (criado dinamicamente)
// =============================================================
function abrirModalForm(titulo, corpoHtml, onSalvar, salvarLabel) {
  fecharModalForm();
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.id = 'modal-form-overlay';
  ov.innerHTML = `
    <div class="modal-card">
      <div class="modal-head">
        <h3>${escapeHtml(titulo)}</h3>
        <button class="modal-close" type="button" onclick="fecharModalForm()" aria-label="Fechar">&times;</button>
      </div>
      <div class="modal-body">
        <div id="modal-alert" class="alert alert-error" style="display:none;"></div>
        ${corpoHtml}
      </div>
      <div class="modal-foot">
        <button class="btn btn-secondary" type="button" onclick="fecharModalForm()">Cancelar</button>
        <button class="btn btn-primary" type="button" id="btn-modal-salvar">${escapeHtml(salvarLabel || 'Salvar')}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  document.getElementById('btn-modal-salvar').onclick = onSalvar;
}

function fecharModalForm() {
  const ov = document.getElementById('modal-form-overlay');
  if (ov) ov.remove();
}

function erroModal(msg) {
  showAlert('modal-alert', msg, 'error');
}

function travarSalvar(travar, label) {
  const b = document.getElementById('btn-modal-salvar');
  if (!b) return;
  b.disabled = travar;
  b.textContent = travar ? 'Salvando…' : (label || 'Salvar');
}

// Componentes de formulário
function campo(label, inner, obrigatorio) {
  return `<div class="form-group"><label class="${obrigatorio ? 'required' : ''}">${escapeHtml(label)}</label>${inner}</div>`;
}
function inputTexto(id, valor, extra) {
  return `<input type="text" id="${id}" value="${escapeHtml(valor || '')}" ${extra || ''}>`;
}
function separadorForm(texto) {
  return `<div style="font-weight:700;color:var(--primary-dark);margin:20px 0 12px;border-bottom:1px solid var(--border);padding-bottom:6px;">${escapeHtml(texto)}</div>`;
}

// =============================================================
// Contexto de condomínio (selector p/ equipe; fixo p/ síndico)
// =============================================================
function trocarCondominio(id) {
  State.condominioSelecionadoId = id;
  renderSection(State.currentSection);
}

async function renderComContexto(titulo, subtitulo, fnConteudo) {
  const content = $('content');
  content.innerHTML = `<div class="loader">Carregando…</div>`;

  let cid = condominioAtivoId();
  let seletorHtml = '';

  if (isEquipe()) {
    let conds;
    try {
      conds = await condominiosAtivos();
    } catch (err) {
      content.innerHTML = cardErro('Falha ao carregar os condomínios.', err);
      return;
    }
    if (!conds.length) {
      content.innerHTML = `
        <div class="section-head"><div><h2>${escapeHtml(titulo)}</h2></div></div>
        <div class="card"><div class="empty-state">
          Cadastre um condomínio primeiro.
          <div style="margin-top:14px;"><button class="btn btn-primary" onclick="navegarPara('condominios')">Ir para Condomínios</button></div>
        </div></div>`;
      return;
    }
    if (!cid || !conds.some((c) => c.id === cid)) {
      cid = conds[0].id;
      State.condominioSelecionadoId = cid;
    }
    const opts = conds.map((c) =>
      `<option value="${c.id}" ${c.id === cid ? 'selected' : ''}>${escapeHtml(c.data().nome || c.id)}</option>`
    ).join('');
    seletorHtml = `
      <div class="form-group" style="max-width:360px;margin-bottom:0;">
        <label>Condomínio</label>
        <select id="sel-condominio" onchange="trocarCondominio(this.value)">${opts}</select>
      </div>`;
  } else {
    cid = State.condominioId;
  }

  if (!cid) {
    content.innerHTML = cardErro('Nenhum condomínio associado ao seu acesso.');
    return;
  }

  content.innerHTML = `
    <div class="section-head">
      <div><h2>${escapeHtml(titulo)}</h2><p>${escapeHtml(subtitulo)}</p></div>
      ${seletorHtml}
    </div>
    <div id="ctx-conteudo"><div class="loader">Carregando…</div></div>`;

  try {
    await fnConteudo(cid);
  } catch (err) {
    const alvo = document.getElementById('ctx-conteudo');
    if (alvo) alvo.innerHTML = cardErro('Falha ao carregar os dados.', err);
  }
}

// =============================================================
// CONDOMÍNIOS
// =============================================================
async function renderCondominios() {
  const content = $('content');
  content.innerHTML = `<div class="loader">Carregando condomínios…</div>`;

  let docs = [];
  try {
    if (isEquipe()) {
      docs = await condominiosAtivos();
    } else if (State.condominioId) {
      const d = await refCondominios().doc(State.condominioId).get();
      if (d.exists) docs = [d];
    }
  } catch (err) {
    content.innerHTML = cardErro('Não foi possível carregar os condomínios.', err);
    return;
  }

  cacheCondominios = {};
  const linhas = docs.map((d) => {
    cacheCondominios[d.id] = d.data();
    const c = d.data();
    const cidade = c.endereco ? `${c.endereco.cidade || '—'}/${c.endereco.uf || ''}` : '—';
    const acoes = podeEditar()
      ? `<button class="btn btn-secondary btn-sm" onclick="gerenciarCondominio('${d.id}')">Gerenciar</button>
         <button class="btn btn-secondary btn-sm" onclick="abrirFormCondominio('${d.id}')">Editar</button>
         <button class="btn btn-danger btn-sm" onclick="excluirCondominio('${d.id}')">Excluir</button>`
      : `<button class="btn btn-secondary btn-sm" onclick="gerenciarCondominio('${d.id}')">Abrir</button>`;
    return `<tr>
      <td>${escapeHtml(c.nome || '—')}</td>
      <td>${escapeHtml(cidade)}</td>
      <td>${escapeHtml(c.cnpj ? maskCNPJ(c.cnpj) : '—')}</td>
      <td class="acoes">${acoes}</td>
    </tr>`;
  }).join('');

  const tabela = docs.length
    ? `<div class="tabela-wrap"><table class="tabela">
         <thead><tr><th>Nome</th><th>Cidade/UF</th><th>CNPJ</th><th>Ações</th></tr></thead>
         <tbody>${linhas}</tbody></table></div>`
    : `<div class="empty-state">Nenhum condomínio cadastrado${podeEditar() ? ' — clique em “Novo condomínio”.' : '.'}</div>`;

  const novoBtn = podeEditar()
    ? `<div style="display:flex;gap:10px;flex-wrap:wrap;">
         <button class="btn btn-secondary" onclick="navegarPara('importarIA')">Importar contrato (IA)</button>
         <button class="btn btn-primary" onclick="abrirFormCondominio()">+ Novo condomínio</button>
       </div>` : '';

  content.innerHTML = `
    <div class="section-head">
      <div><h2>Condomínios</h2><p>Clientes da cobrança garantida.</p></div>
      ${novoBtn}
    </div>
    <div class="card">${tabela}</div>`;
}

function gerenciarCondominio(id) {
  State.condominioSelecionadoId = id;
  navegarPara('unidades');
}

function abrirFormCondominio(id) {
  const c = id ? (cacheCondominios[id] || {}) : {};
  const e = c.endereco || {};
  const s = c.sindico || {};
  const r = c.regua || {};
  const num = (v, def) => (v != null ? v : def);
  const faixasIniciais = (r.faixas && r.faixas.length) ? r.faixas : FAIXAS_PADRAO;
  const optsIndexador = INDEXADORES.map((x) =>
    `<option value="${x.id}" ${(r.indexador || 'INPC') === x.id ? 'selected' : ''}>${escapeHtml(x.label)}</option>`
  ).join('');
  const corpo = `
    <div class="form-row">
      ${campo('Nome do condomínio', inputTexto('f-nome', c.nome), true)}
      ${campo('CNPJ', inputTexto('f-cnpj', c.cnpj ? maskCNPJ(c.cnpj) : '', 'oninput="this.value=maskCNPJ(this.value)" placeholder="00.000.000/0000-00"'))}
    </div>
    ${separadorForm('Endereço')}
    <div class="form-row">
      ${campo('Logradouro', inputTexto('f-logradouro', e.logradouro))}
      ${campo('Número', inputTexto('f-numero', e.numero))}
    </div>
    <div class="form-row">
      ${campo('Complemento', inputTexto('f-complemento', e.complemento))}
      ${campo('Bairro', inputTexto('f-bairro', e.bairro))}
    </div>
    <div class="form-row-3">
      ${campo('Cidade', inputTexto('f-cidade', e.cidade))}
      ${campo('UF', inputTexto('f-uf', e.uf, 'maxlength="2" style="text-transform:uppercase"'))}
      ${campo('CEP', inputTexto('f-cep', e.cep ? maskCEP(e.cep) : '', 'oninput="this.value=maskCEP(this.value)" placeholder="00000-000"'))}
    </div>
    ${separadorForm('Síndico')}
    <div class="form-row">
      ${campo('Nome do síndico', inputTexto('f-sind-nome', s.nome))}
      ${campo('CPF do síndico', inputTexto('f-sind-cpf', s.cpf ? maskCPF(s.cpf) : '', 'oninput="this.value=maskCPF(this.value)" placeholder="000.000.000-00"'))}
    </div>
    <div class="form-row">
      ${campo('Telefone', inputTexto('f-sind-tel', s.telefone ? maskTelefone(s.telefone) : '', 'oninput="this.value=maskTelefone(this.value)"'))}
      ${campo('E-mail', inputTexto('f-sind-email', s.email))}
    </div>
    ${separadorForm('Régua de cobrança')}
    <p class="muted" style="font-size:12px;margin-bottom:10px;">Regras aplicadas ao boleto vencido do condômino: multa e juros (da convenção) e os encargos crescentes por atraso (do contrato).</p>
    <div class="form-row-3">
      ${campo('Multa (%)', `<input type="number" step="0.01" id="f-multa" value="${num(r.multaPct, 2)}">`)}
      ${campo('Juros de mora (% a.m.)', `<input type="number" step="0.01" id="f-juros" value="${num(r.jurosMoraMesPct, 1)}">`)}
      ${campo('Desconto pontualidade (%)', `<input type="number" step="0.01" id="f-desconto" value="${num(c.descontoPontualidadePct, 0)}">`)}
    </div>
    ${campo('Indexador de correção monetária', `<select id="f-indexador">${optsIndexador}</select>`)}
    <label style="display:block;font-size:13px;font-weight:600;color:var(--text);margin:6px 0 4px;">Faixas de encargos por atraso</label>
    <p class="muted" style="font-size:12px;margin-bottom:10px;">Cada faixa: a partir de quantos dias de atraso, o encargo de cobrança total e se aplica correção monetária.</p>
    <div id="f-faixas"></div>
    <button type="button" class="btn btn-secondary btn-sm" onclick="faixaAdd('f-faixas')" style="margin-bottom:6px;">+ Adicionar faixa</button>`;

  abrirModalForm(id ? 'Editar condomínio' : 'Novo condomínio', corpo, () => salvarCondominio(id), 'Salvar condomínio');
  faixasRender('f-faixas', faixasIniciais);
}

async function salvarCondominio(id) {
  const nome = valId('f-nome');
  const cnpj = soDigitos(valId('f-cnpj'));
  const sindCpf = soDigitos(valId('f-sind-cpf'));

  if (!nome) { erroModal('Informe o nome do condomínio.'); return; }
  if (cnpj && !isCNPJValid(cnpj)) { erroModal('CNPJ inválido.'); return; }
  if (sindCpf && !isCPFValid(sindCpf)) { erroModal('CPF do síndico inválido.'); return; }

  const dados = {
    nome,
    cnpj,
    endereco: {
      logradouro: valId('f-logradouro'),
      numero: valId('f-numero'),
      complemento: valId('f-complemento'),
      bairro: valId('f-bairro'),
      cidade: valId('f-cidade'),
      uf: valId('f-uf').toUpperCase(),
      cep: soDigitos(valId('f-cep')),
    },
    sindico: {
      nome: valId('f-sind-nome'),
      cpf: sindCpf,
      telefone: soDigitos(valId('f-sind-tel')),
      email: valId('f-sind-email'),
    },
    descontoPontualidadePct: valNum('f-desconto', 0),
    regua: {
      multaPct: valNum('f-multa', 0),
      jurosMoraMesPct: valNum('f-juros', 0),
      indexador: valId('f-indexador') || 'INPC',
      faixas: faixasLer('f-faixas')
        .filter((f) => f.apartirDias != null && f.encargoPct != null)
        .sort((a, b) => a.apartirDias - b.apartirDias),
    },
  };

  travarSalvar(true);
  try {
    if (id) {
      await refCondominios().doc(id).update(dados);
    } else {
      await refCondominios().add(Object.assign(dados, carimboCriacao()));
    }
    fecharModalForm();
    renderCondominios();
  } catch (err) {
    travarSalvar(false, 'Salvar condomínio');
    erroModal('Falha ao salvar: ' + (err.message || err));
  }
}

async function excluirCondominio(id) {
  const c = cacheCondominios[id] || {};
  const ok = await confirmar({
    titulo: 'Excluir condomínio',
    mensagem: `Excluir “${c.nome || 'este condomínio'}”? As unidades, condôminos e contratos vinculados NÃO são removidos automaticamente.`,
    okLabel: 'Excluir',
    perigo: true,
  });
  if (!ok) return;
  try {
    await refCondominios().doc(id).delete();
    renderCondominios();
  } catch (err) {
    alert('Falha ao excluir: ' + (err.message || err));
  }
}

// =============================================================
// UNIDADES
// =============================================================
function renderUnidades() {
  return renderComContexto('Unidades', 'Unidades do condomínio.', async (cid) => {
    const snap = await refSub(cid, 'unidades').orderBy('identificacao').get();
    cacheUnidades = {};
    const linhas = snap.docs.map((d) => {
      cacheUnidades[d.id] = d.data();
      const u = d.data();
      const st = u.ativa === false
        ? '<span class="badge badge-danger">Inativa</span>'
        : '<span class="badge badge-success">Ativa</span>';
      const acoes = podeEditar()
        ? `<button class="btn btn-secondary btn-sm" onclick="abrirFormUnidade('${cid}','${d.id}')">Editar</button>
           <button class="btn btn-danger btn-sm" onclick="excluirUnidade('${cid}','${d.id}')">Excluir</button>`
        : '';
      return `<tr>
        <td>${escapeHtml(u.identificacao || '—')}</td>
        <td>${escapeHtml(u.bloco || '—')}</td>
        <td>${escapeHtml(u.fracaoIdeal || '—')}</td>
        <td>${st}</td>
        <td class="acoes">${acoes}</td>
      </tr>`;
    }).join('');

    const tabela = snap.size
      ? `<div class="tabela-wrap"><table class="tabela">
           <thead><tr><th>Identificação</th><th>Bloco</th><th>Fração ideal</th><th>Status</th><th>Ações</th></tr></thead>
           <tbody>${linhas}</tbody></table></div>`
      : `<div class="empty-state">Nenhuma unidade cadastrada.</div>`;

    const novo = podeEditar()
      ? `<div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end;margin-bottom:12px;">
           <button class="btn btn-secondary" onclick="navegarPara('importarPlanilha')">Importar planilha (IA)</button>
           <button class="btn btn-primary" onclick="abrirFormUnidade('${cid}')">+ Nova unidade</button>
         </div>`
      : '';
    document.getElementById('ctx-conteudo').innerHTML = `${novo}<div class="card">${tabela}</div>`;
  });
}

function abrirFormUnidade(cid, id) {
  const u = id ? (cacheUnidades[id] || {}) : {};
  const corpo = `
    <div class="form-row">
      ${campo('Identificação', inputTexto('f-identificacao', u.identificacao, 'placeholder="Ex: Apto 14"'), true)}
      ${campo('Bloco / Torre', inputTexto('f-bloco', u.bloco))}
    </div>
    ${campo('Fração ideal', inputTexto('f-fracao', u.fracaoIdeal, 'placeholder="Ex: 0,0125 ou 1,25%"'))}
    <label class="check-linha"><input type="checkbox" id="f-ativa" ${u.ativa === false ? '' : 'checked'}> Unidade ativa</label>`;
  abrirModalForm(id ? 'Editar unidade' : 'Nova unidade', corpo, () => salvarUnidade(cid, id), 'Salvar unidade');
}

async function salvarUnidade(cid, id) {
  const identificacao = valId('f-identificacao');
  if (!identificacao) { erroModal('Informe a identificação da unidade.'); return; }

  const dados = {
    identificacao,
    bloco: valId('f-bloco'),
    fracaoIdeal: valId('f-fracao'),
    ativa: valCheck('f-ativa'),
  };

  travarSalvar(true);
  try {
    if (id) {
      await refSub(cid, 'unidades').doc(id).update(dados);
    } else {
      await refSub(cid, 'unidades').add(Object.assign(dados, carimboCriacao()));
    }
    fecharModalForm();
    renderUnidades();
  } catch (err) {
    travarSalvar(false, 'Salvar unidade');
    erroModal('Falha ao salvar: ' + (err.message || err));
  }
}

async function excluirUnidade(cid, id) {
  const u = cacheUnidades[id] || {};
  const ok = await confirmar({
    titulo: 'Excluir unidade',
    mensagem: `Excluir a unidade “${u.identificacao || ''}”?`,
    okLabel: 'Excluir', perigo: true,
  });
  if (!ok) return;
  try {
    await refSub(cid, 'unidades').doc(id).delete();
    renderUnidades();
  } catch (err) {
    alert('Falha ao excluir: ' + (err.message || err));
  }
}

// =============================================================
// CONDÔMINOS
// =============================================================
function renderCondominos() {
  return renderComContexto('Condôminos', 'Proprietários e responsáveis pelas unidades.', async (cid) => {
    const [snapU, snapC] = await Promise.all([
      refSub(cid, 'unidades').orderBy('identificacao').get(),
      refSub(cid, 'condominos').orderBy('nome').get(),
    ]);

    unidadesDoContexto = snapU.docs.map((d) => ({ id: d.id, identificacao: d.data().identificacao || d.id }));
    const mapaUnid = {};
    unidadesDoContexto.forEach((u) => { mapaUnid[u.id] = u.identificacao; });

    cacheCondominos = {};
    const linhas = snapC.docs.map((d) => {
      cacheCondominos[d.id] = d.data();
      const c = d.data();
      const unid = c.unidadeId ? (mapaUnid[c.unidadeId] || '—') : '—';
      const acoes = podeEditar()
        ? `<button class="btn btn-secondary btn-sm" onclick="abrirFormCondomino('${cid}','${d.id}')">Editar</button>
           <button class="btn btn-danger btn-sm" onclick="excluirCondomino('${cid}','${d.id}')">Excluir</button>`
        : '';
      return `<tr>
        <td>${escapeHtml(c.nome || '—')}</td>
        <td>${escapeHtml(c.cpfCnpj ? maskCPFCNPJ(c.cpfCnpj) : '—')}</td>
        <td>${escapeHtml(c.telefone ? maskTelefone(c.telefone) : '—')}</td>
        <td>${escapeHtml(unid)}</td>
        <td>${escapeHtml(rotuloTipoCondomino(c.tipo))}</td>
        <td class="acoes">${acoes}</td>
      </tr>`;
    }).join('');

    const tabela = snapC.size
      ? `<div class="tabela-wrap"><table class="tabela">
           <thead><tr><th>Nome</th><th>CPF/CNPJ</th><th>Telefone</th><th>Unidade</th><th>Tipo</th><th>Ações</th></tr></thead>
           <tbody>${linhas}</tbody></table></div>`
      : `<div class="empty-state">Nenhum condômino cadastrado.</div>`;

    const novo = podeEditar()
      ? `<div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end;margin-bottom:12px;">
           <button class="btn btn-secondary" onclick="navegarPara('importarPlanilha')">Importar planilha (IA)</button>
           <button class="btn btn-primary" onclick="abrirFormCondomino('${cid}')">+ Novo condômino</button>
         </div>`
      : '';
    document.getElementById('ctx-conteudo').innerHTML = `${novo}<div class="card">${tabela}</div>`;
  });
}

function abrirFormCondomino(cid, id) {
  const c = id ? (cacheCondominos[id] || {}) : {};
  const tipos = ['proprietario', 'inquilino', 'responsavel'];
  const optsTipo = tipos.map((t) =>
    `<option value="${t}" ${c.tipo === t ? 'selected' : ''}>${escapeHtml(rotuloTipoCondomino(t))}</option>`
  ).join('');
  const optsUnid = ['<option value="">— sem unidade —</option>'].concat(
    unidadesDoContexto.map((u) =>
      `<option value="${u.id}" ${c.unidadeId === u.id ? 'selected' : ''}>${escapeHtml(u.identificacao)}</option>`
    )
  ).join('');

  const corpo = `
    ${campo('Nome completo / Razão social', inputTexto('f-nome', c.nome), true)}
    <div class="form-row">
      ${campo('CPF / CNPJ', inputTexto('f-doc', c.cpfCnpj ? maskCPFCNPJ(c.cpfCnpj) : '', 'oninput="this.value=maskCPFCNPJ(this.value)"'))}
      ${campo('RG', inputTexto('f-rg', c.rg))}
    </div>
    <div class="form-row">
      ${campo('Telefone', inputTexto('f-tel', c.telefone ? maskTelefone(c.telefone) : '', 'oninput="this.value=maskTelefone(this.value)"'))}
      ${campo('E-mail', inputTexto('f-email', c.email))}
    </div>
    <div class="form-row">
      ${campo('Tipo', `<select id="f-tipo">${optsTipo}</select>`)}
      ${campo('Unidade', `<select id="f-unidade">${optsUnid}</select>`)}
    </div>
    ${campo('Endereço de correspondência', inputTexto('f-end-corresp', c.enderecoCorrespondencia, 'placeholder="Se diferente da unidade"'))}`;

  abrirModalForm(id ? 'Editar condômino' : 'Novo condômino', corpo, () => salvarCondomino(cid, id), 'Salvar condômino');
}

async function salvarCondomino(cid, id) {
  const nome = valId('f-nome');
  const doc = soDigitos(valId('f-doc'));
  if (!nome) { erroModal('Informe o nome do condômino.'); return; }
  if (doc) {
    const valido = doc.length <= 11 ? isCPFValid(doc) : isCNPJValid(doc);
    if (!valido) { erroModal('CPF/CNPJ inválido.'); return; }
  }

  const dados = {
    nome,
    cpfCnpj: doc,
    rg: valId('f-rg'),
    telefone: soDigitos(valId('f-tel')),
    email: valId('f-email'),
    tipo: valId('f-tipo') || 'proprietario',
    unidadeId: valId('f-unidade') || null,
    enderecoCorrespondencia: valId('f-end-corresp'),
  };

  travarSalvar(true);
  try {
    if (id) {
      await refSub(cid, 'condominos').doc(id).update(dados);
    } else {
      await refSub(cid, 'condominos').add(Object.assign(dados, carimboCriacao()));
    }
    fecharModalForm();
    renderCondominos();
  } catch (err) {
    travarSalvar(false, 'Salvar condômino');
    erroModal('Falha ao salvar: ' + (err.message || err));
  }
}

async function excluirCondomino(cid, id) {
  const c = cacheCondominos[id] || {};
  const ok = await confirmar({
    titulo: 'Excluir condômino',
    mensagem: `Excluir o condômino “${c.nome || ''}”?`,
    okLabel: 'Excluir', perigo: true,
  });
  if (!ok) return;
  try {
    await refSub(cid, 'condominos').doc(id).delete();
    renderCondominos();
  } catch (err) {
    alert('Falha ao excluir: ' + (err.message || err));
  }
}

// =============================================================
// CONTRATOS (de cobrança garantida)
// =============================================================
function renderContratos() {
  return renderComContexto('Contratos', 'Contratos de cobrança garantida do condomínio.', async (cid) => {
    const snap = await refSub(cid, 'contratos').orderBy('criadoEm', 'desc').get();
    cacheContratos = {};
    const linhas = snap.docs.map((d) => {
      cacheContratos[d.id] = d.data();
      const c = d.data();
      const vig = `${fmtData(c.vigenciaInicio)} — ${fmtData(c.vigenciaFim)}`;
      const acoes = podeEditar()
        ? `<button class="btn btn-secondary btn-sm" onclick="abrirFormContrato('${cid}','${d.id}')">Editar</button>
           <button class="btn btn-danger btn-sm" onclick="excluirContrato('${cid}','${d.id}')">Excluir</button>`
        : '';
      return `<tr>
        <td>${escapeHtml(c.numero || '—')}</td>
        <td>${escapeHtml(vig)}</td>
        <td class="col-num">${escapeHtml((c.taxaAdmPct != null ? c.taxaAdmPct : '—') + '%')}</td>
        <td>${badgeStatusContrato(c.status)}</td>
        <td class="acoes">${acoes}</td>
      </tr>`;
    }).join('');

    const tabela = snap.size
      ? `<div class="tabela-wrap"><table class="tabela">
           <thead><tr><th>Número</th><th>Vigência</th><th>Taxa adm.</th><th>Status</th><th>Ações</th></tr></thead>
           <tbody>${linhas}</tbody></table></div>`
      : `<div class="empty-state">Nenhum contrato cadastrado.</div>`;

    const novo = podeEditar()
      ? `<div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end;margin-bottom:12px;">
           <button class="btn btn-secondary" onclick="navegarPara('importarIA')">Importar contrato (IA)</button>
           <button class="btn btn-primary" onclick="abrirFormContrato('${cid}')">+ Novo contrato</button>
         </div>`
      : '';
    document.getElementById('ctx-conteudo').innerHTML = `${novo}<div class="card">${tabela}</div>`;
  });
}

async function abrirFormContrato(cid, id) {
  const c = id ? (cacheContratos[id] || {}) : {};
  const numeroDefault = (!id && !c.numero) ? await proximoNumeroContrato(cid) : (c.numero || '');
  const ca = c.carteiraAdquirida || {};
  const num = (v, def) => (v != null ? v : def);
  const statusOpts = ['ativo', 'suspenso', 'encerrado'].map((s) =>
    `<option value="${s}" ${(c.status || 'ativo') === s ? 'selected' : ''}>${escapeHtml(rotuloStatusContrato(s))}</option>`
  ).join('');

  const corpo = `
    <div class="form-row">
      ${campo('Número do contrato', inputTexto('f-numero', numeroDefault, 'placeholder="Ex: 2026/001"'))}
      ${campo('Status', `<select id="f-status">${statusOpts}</select>`)}
    </div>
    <div class="form-row">
      ${campo('Taxa de administração (%)', `<input type="number" step="0.01" id="f-taxa" value="${num(c.taxaAdmPct, 8)}">`, true)}
      ${campo('Tarifa por boleto (R$)', `<input type="number" step="0.01" id="f-tarifa" value="${num(c.tarifaBoleto, 3.5)}">`, true)}
    </div>
    ${separadorForm('Vigência')}
    <div class="form-row">
      ${campo('Início da vigência', `<input type="date" id="f-vig-inicio" value="${escapeHtml(c.vigenciaInicio || '')}">`)}
      ${campo('Fim da vigência', `<input type="date" id="f-vig-fim" value="${escapeHtml(c.vigenciaFim || '')}">`)}
    </div>
    <div class="form-row">
      ${campo('Prazo (meses)', `<input type="number" id="f-prazo" value="${num(c.prazoMeses, 24)}">`)}
      ${campo('Aviso de denúncia (dias)', `<input type="number" id="f-aviso" value="${num(c.avisoDenunciaDias, 75)}">`)}
    </div>
    <label class="check-linha"><input type="checkbox" id="f-renovacao" ${c.renovacaoAuto === false ? '' : 'checked'}> Renovação automática</label>
    ${separadorForm('Carteira de inadimplentes adquirida (opcional)')}
    <div class="form-row-3">
      ${campo('Valor pago (R$)', `<input type="number" step="0.01" id="f-cart-valor" value="${num(ca.valor, 0)}">`)}
      ${campo('Data de corte', `<input type="date" id="f-cart-corte" value="${escapeHtml(ca.dataCorte || '')}">`)}
      ${campo('Data do pagamento', `<input type="date" id="f-cart-pgto" value="${escapeHtml(ca.dataPagamento || '')}">`)}
    </div>`;

  abrirModalForm(id ? 'Editar contrato' : 'Novo contrato', corpo, () => salvarContrato(cid, id), 'Salvar contrato');
}

async function salvarContrato(cid, id) {
  const taxa = valNum('f-taxa');
  const tarifa = valNum('f-tarifa');
  if (taxa == null || taxa < 0) { erroModal('Informe uma taxa de administração válida.'); return; }
  if (tarifa == null || tarifa < 0) { erroModal('Informe uma tarifa de boleto válida.'); return; }

  const vIni = valId('f-vig-inicio');
  const vFim = valId('f-vig-fim');
  if (vIni && vFim && vFim < vIni) { erroModal('O fim da vigência é anterior ao início.'); return; }

  const dados = {
    numero: valId('f-numero'),
    status: valId('f-status') || 'ativo',
    taxaAdmPct: taxa,
    tarifaBoleto: tarifa,
    vigenciaInicio: vIni || null,
    vigenciaFim: vFim || null,
    prazoMeses: valNum('f-prazo', null),
    avisoDenunciaDias: valNum('f-aviso', null),
    renovacaoAuto: valCheck('f-renovacao'),
    carteiraAdquirida: {
      valor: valNum('f-cart-valor', 0),
      dataCorte: valId('f-cart-corte') || null,
      dataPagamento: valId('f-cart-pgto') || null,
    },
  };

  if (!id && !dados.numero) dados.numero = await proximoNumeroContrato(cid);

  travarSalvar(true);
  try {
    if (id) {
      await refSub(cid, 'contratos').doc(id).update(dados);
    } else {
      await refSub(cid, 'contratos').add(Object.assign(dados, carimboCriacao()));
    }
    fecharModalForm();
    renderContratos();
  } catch (err) {
    travarSalvar(false, 'Salvar contrato');
    erroModal('Falha ao salvar: ' + (err.message || err));
  }
}

async function excluirContrato(cid, id) {
  const c = cacheContratos[id] || {};
  const ok = await confirmar({
    titulo: 'Excluir contrato',
    mensagem: `Excluir o contrato “${c.numero || 'sem número'}”?`,
    okLabel: 'Excluir', perigo: true,
  });
  if (!ok) return;
  try {
    await refSub(cid, 'contratos').doc(id).delete();
    renderContratos();
  } catch (err) {
    alert('Falha ao excluir: ' + (err.message || err));
  }
}

// =============================================================
// PAINEL MASTER — Gestão de condomínios (ativar / inativar)
// =============================================================
async function renderGestaoCondominios() {
  const content = $('content');
  content.innerHTML = `<div class="loader">Carregando…</div>`;
  try {
    const snap = await refCondominios().orderBy('nome').get();
    snap.docs.forEach((d) => { cacheCondominios[d.id] = d.data(); });

    const linhas = snap.docs.map((d) => {
      const c = d.data();
      const ativo = c.ativo !== false;
      const badge = ativo
        ? '<span class="badge badge-success">Ativo</span>'
        : '<span class="badge badge-danger">Inativo</span>';
      const btn = ativo
        ? `<button class="btn btn-danger btn-sm" onclick="alternarAtivoCondominio('${d.id}', false)">Inativar</button>`
        : `<button class="btn btn-success btn-sm" onclick="alternarAtivoCondominio('${d.id}', true)">Reativar</button>`;
      const cidade = c.endereco ? `${c.endereco.cidade || '—'}/${c.endereco.uf || ''}` : '—';
      return `<tr>
        <td>${escapeHtml(c.nome || '—')}</td>
        <td>${escapeHtml(cidade)}</td>
        <td>${escapeHtml(c.cnpj ? maskCNPJ(c.cnpj) : '—')}</td>
        <td>${badge}</td>
        <td class="acoes">${btn}</td>
      </tr>`;
    }).join('');

    const tabela = snap.size
      ? `<div class="tabela-wrap"><table class="tabela">
           <thead><tr><th>Condomínio</th><th>Cidade/UF</th><th>CNPJ</th><th>Status</th><th>Ações</th></tr></thead>
           <tbody>${linhas}</tbody></table></div>`
      : '<div class="empty-state">Nenhum condomínio cadastrado.</div>';

    content.innerHTML = `
      <div class="section-head">
        <div><h2>Gestão de Condomínios</h2>
        <p>Ative ou inative os condomínios da carteira. Inativar não exclui nada — preserva todo o histórico (contratos, competências, boletos).</p></div>
      </div>
      <div class="card">${tabela}</div>`;
  } catch (err) {
    content.innerHTML = cardErro('Falha ao carregar os condomínios.', err);
  }
}

async function alternarAtivoCondominio(id, ativar) {
  const c = cacheCondominios[id] || {};
  const ok = await confirmar({
    titulo: ativar ? 'Reativar condomínio' : 'Inativar condomínio',
    mensagem: ativar
      ? `Reativar “${c.nome || 'este condomínio'}”? Ele volta a constar como ativo.`
      : `Inativar “${c.nome || 'este condomínio'}”? Ele continua no sistema com todo o histórico — só fica marcado como fora de operação.`,
    okLabel: ativar ? 'Reativar' : 'Inativar',
    perigo: !ativar,
  });
  if (!ok) return;
  try {
    await refCondominios().doc(id).update({ ativo: !!ativar });
    renderGestaoCondominios();
  } catch (err) {
    alert('Falha ao atualizar: ' + (err.message || err));
  }
}

// =============================================================
// Registro das seções
// =============================================================
SECTION_RENDERERS.condominios = renderCondominios;
SECTION_RENDERERS.unidades = renderUnidades;
SECTION_RENDERERS.condominos = renderCondominos;
SECTION_RENDERERS.contratos = renderContratos;
SECTION_RENDERERS.gestaoCondominios = renderGestaoCondominios;
