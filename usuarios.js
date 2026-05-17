// =============================================================
// DRG-Garantidora — usuarios.js
// Gestão de contas de acesso (só super_admin). Lista, cria e edita
// usuários. A criação usa uma instância Firebase secundária para não
// derrubar a sessão do admin. Carregado depois de competencias.js.
//
// OBS: depende das regras do Firestore permitirem o super_admin
// escrever em /users — se a gravação falhar com "permissão", ajuste
// as regras (snippet entregue no chat).
// =============================================================

window.SECTION_RENDERERS = window.SECTION_RENDERERS || {};

let cacheUsuarios = {};
let usuariosCondominios = [];

const PERFIS_USUARIO = ['super_admin', 'operador_drg', 'sindico', 'condomino'];

function perfilOptions(sel) {
  return PERFIS_USUARIO
    .map((r) => `<option value="${r}" ${sel === r ? 'selected' : ''}>${escapeHtml(ROTULO_PERFIL[r] || r)}</option>`)
    .join('');
}

function condOptionsUsuario(sel) {
  return ['<option value="">— nenhum —</option>']
    .concat(usuariosCondominios.map((c) =>
      `<option value="${c.id}" ${sel === c.id ? 'selected' : ''}>${escapeHtml(c.nome || c.id)}</option>`))
    .join('');
}

async function renderUsuarios() {
  const content = $('content');
  content.innerHTML = `<div class="loader">Carregando usuários…</div>`;
  try {
    const [snapU, conds] = await Promise.all([
      db.collection('users').get(),
      condominiosAtivos(),
    ]);
    usuariosCondominios = conds.map((d) => ({ id: d.id, nome: d.data().nome }));
    const condNome = {};
    usuariosCondominios.forEach((c) => { condNome[c.id] = c.nome; });

    cacheUsuarios = {};
    const docs = snapU.docs.slice().sort((a, z) =>
      String(a.data().nome || '').localeCompare(String(z.data().nome || '')));
    const linhas = docs.map((d) => {
      cacheUsuarios[d.id] = d.data();
      const u = d.data();
      const st = u.ativo === false
        ? '<span class="badge badge-danger">Inativo</span>'
        : '<span class="badge badge-success">Ativo</span>';
      return `<tr>
        <td>${escapeHtml(u.nome || '—')}</td>
        <td>${escapeHtml(u.email || '—')}</td>
        <td>${escapeHtml(ROTULO_PERFIL[u.role] || u.role || '—')}</td>
        <td>${escapeHtml(u.condominioId ? (condNome[u.condominioId] || u.condominioId) : '—')}</td>
        <td>${st}</td>
        <td class="acoes"><button class="btn btn-secondary btn-sm" onclick="abrirFormUsuario('${d.id}')">Editar</button></td>
      </tr>`;
    }).join('');

    const tabela = docs.length
      ? `<div class="tabela-wrap"><table class="tabela">
           <thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Condomínio</th><th>Status</th><th>Ações</th></tr></thead>
           <tbody>${linhas}</tbody></table></div>`
      : '<div class="empty-state">Nenhum usuário cadastrado.</div>';

    content.innerHTML = `
      <div class="section-head">
        <div><h2>Usuários</h2><p>Contas de acesso à plataforma.</p></div>
        <button class="btn btn-primary" onclick="abrirFormUsuario()">+ Novo usuário</button>
      </div>
      <div class="card">${tabela}</div>`;
  } catch (err) {
    content.innerHTML = cardErro('Falha ao carregar os usuários.', err);
  }
}

function abrirFormUsuario(uid) {
  const u = uid ? (cacheUsuarios[uid] || {}) : {};
  const novo = !uid;
  const corpo = `
    ${campo('Nome', inputTexto('usr-nome', u.nome), true)}
    ${novo
      ? `${campo('E-mail', '<input type="email" id="usr-email" autocomplete="off">', true)}
         ${campo('Senha provisória', '<input type="text" id="usr-senha" placeholder="mín. 6 caracteres">', true)}`
      : `<div class="form-group"><label>E-mail</label><input type="email" value="${escapeHtml(u.email || '')}" disabled></div>`}
    ${campo('Perfil', `<select id="usr-perfil">${perfilOptions(u.role)}</select>`, true)}
    ${campo('Condomínio (síndico / condômino)', `<select id="usr-cond">${condOptionsUsuario(u.condominioId)}</select>`)}
    ${novo ? '' : `<label class="check-linha"><input type="checkbox" id="usr-ativo" ${u.ativo === false ? '' : 'checked'}> Usuário ativo</label>`}`;
  abrirModalForm(novo ? 'Novo usuário' : 'Editar usuário', corpo, () => salvarUsuario(uid), 'Salvar usuário');
}

// Cria o usuário no Firebase Auth via uma instância secundária, pra não
// trocar a sessão do admin logado. Devolve o uid.
async function criarAuthSecundario(email, senha) {
  let sec;
  try { sec = firebase.app('secondary'); }
  catch (_) { sec = firebase.initializeApp(firebase.app().options, 'secondary'); }
  const cred = await sec.auth().createUserWithEmailAndPassword(email, senha);
  const uid = cred.user.uid;
  await sec.auth().signOut();
  return uid;
}

async function salvarUsuario(uid) {
  const nome = valId('usr-nome');
  const role = valId('usr-perfil');
  const condominioId = valId('usr-cond') || null;
  if (!nome) { erroModal('Informe o nome.'); return; }
  if ((role === 'sindico' || role === 'condomino') && !condominioId) {
    erroModal('Síndico e condômino precisam de um condomínio vinculado.'); return;
  }
  let email;
  let senha;
  if (!uid) {
    email = valId('usr-email');
    senha = valId('usr-senha');
    if (!email) { erroModal('Informe o e-mail.'); return; }
    if (!senha || senha.length < 6) { erroModal('A senha provisória precisa de ao menos 6 caracteres.'); return; }
  }

  travarSalvar(true);
  try {
    if (uid) {
      await db.collection('users').doc(uid).update({
        nome, role, condominioId, ativo: valCheck('usr-ativo'),
      });
    } else {
      const novoUid = await criarAuthSecundario(email, senha);
      await db.collection('users').doc(novoUid).set(Object.assign({
        nome, email, role, condominioId, ativo: true,
      }, carimboCriacao()));
    }
    fecharModalForm();
    renderUsuarios();
  } catch (err) {
    travarSalvar(false, 'Salvar usuário');
    erroModal('Falha ao salvar: ' + ((err && err.message) || err));
  }
}

SECTION_RENDERERS.usuarios = renderUsuarios;
