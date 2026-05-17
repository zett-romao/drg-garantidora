// =============================================================
// DRG-Garantidora — perfis.js
// Perfis & Permissões: o super_admin cria perfis nomeados e define,
// por módulo, o "Acesso" e o "Editar" — além de ações como "Aprovar
// repasse". Cada usuário recebe um perfil (campo perfilId em users).
//
// O perfil controla o MENU e os BOTÕES (camada de UI). O tier (role) e
// as regras do Firestore continuam controlando o acesso ao DADO.
// Carregado depois de usuarios.js.
// =============================================================

window.SECTION_RENDERERS = window.SECTION_RENDERERS || {};

let cachePerfis = {};

// Perfis-semente: id fixo, derivados dos perfis fixos de hoje.
const SEED_ROLES = ['super_admin', 'operador_drg', 'sindico', 'condomino'];

// Quantos módulos um perfil libera (acesso = true).
function contarModulosPerfil(p) {
  const perm = (p && p.permissoes) || {};
  return Object.keys(perm).filter((id) => perm[id] && perm[id].acesso).length;
}

// -------------------------------------------------------------
// Lista de perfis
// -------------------------------------------------------------
async function renderPerfis() {
  const content = $('content');
  content.innerHTML = `<div class="loader">Carregando perfis…</div>`;
  try {
    const [snapP, snapU] = await Promise.all([
      db.collection('perfis').get(),
      db.collection('users').get(),
    ]);

    const usoPorPerfil = {};
    snapU.docs.forEach((d) => {
      const u = d.data();
      const pid = u.perfilId || ('seed_' + (u.role || 'condomino'));
      usoPorPerfil[pid] = (usoPorPerfil[pid] || 0) + 1;
    });

    cachePerfis = {};
    const docs = snapP.docs.slice().sort((a, z) =>
      String(a.data().nome || '').localeCompare(String(z.data().nome || '')));

    if (!docs.length) {
      content.innerHTML = `
        <div class="section-head">
          <div><h2>Perfis & Permissões</h2>
          <p>Perfis de acesso — defina o que cada um enxerga e edita.</p></div>
        </div>
        <div class="card"><div class="empty-state">
          Nenhum perfil cadastrado ainda.
          <div style="margin-top:14px;">
            <button class="btn btn-primary" onclick="semearPerfisPadrao()">Criar perfis padrão</button>
          </div>
          <p class="muted" style="font-size:12px;margin-top:10px;">
            Cria os 4 perfis-base (admin, operador, síndico, condômino) com as permissões de hoje.
            Depois você ajusta cada um ou cria perfis novos.</p>
        </div></div>`;
      return;
    }

    const linhas = docs.map((d) => {
      cachePerfis[d.id] = d.data();
      const p = d.data();
      const uso = usoPorPerfil[d.id] || 0;
      const aprova = (p.acoes && p.acoes.aprovarRepasse) ? ' · aprova repasse' : '';
      const btnExcluir = p.sistema
        ? '<span class="muted" style="font-size:11px;">perfil base</span>'
        : `<button class="btn btn-danger btn-sm" onclick="excluirPerfil('${d.id}')">Excluir</button>`;
      return `<tr>
        <td>${escapeHtml(p.nome || '—')}${p.sistema ? ' <span class="badge badge-muted">base</span>' : ''}</td>
        <td class="col-num">${contarModulosPerfil(p)}${escapeHtml(aprova)}</td>
        <td class="col-num">${uso}</td>
        <td class="acoes">
          <button class="btn btn-secondary btn-sm" onclick="abrirFormPerfil('${d.id}')">Editar</button>
          ${btnExcluir}
        </td>
      </tr>`;
    }).join('');

    content.innerHTML = `
      <div class="section-head">
        <div><h2>Perfis & Permissões</h2>
        <p>Perfis de acesso — defina o que cada um enxerga e edita.</p></div>
        <button class="btn btn-primary" onclick="abrirFormPerfil()">+ Novo perfil</button>
      </div>
      <div class="card"><div class="tabela-wrap"><table class="tabela">
        <thead><tr><th>Perfil</th><th>Módulos liberados</th><th>Usuários</th><th>Ações</th></tr></thead>
        <tbody>${linhas}</tbody></table></div></div>`;
  } catch (err) {
    content.innerHTML = cardErro('Falha ao carregar os perfis. Confira se as regras do Firestore liberam a coleção "perfis".', err);
  }
}

// Cria os 4 perfis-base a partir do mapa fixo NAV_POR_PERFIL.
async function semearPerfisPadrao() {
  const ok = await confirmar({
    titulo: 'Criar perfis padrão',
    mensagem: 'Criar os 4 perfis-base com as permissões equivalentes às de hoje? Se já existirem, são sobrescritos.',
    okLabel: 'Criar',
  });
  if (!ok) return;
  try {
    for (let i = 0; i < SEED_ROLES.length; i++) {
      const role = SEED_ROLES[i];
      const mods = NAV_POR_PERFIL[role] || ['dashboard'];
      const permissoes = {};
      mods.forEach((id) => {
        if (!MODULOS[id]) return;
        permissoes[id] = { acesso: true, editar: MODULOS_COM_EDITAR.indexOf(id) !== -1 };
      });
      const acoes = { aprovarRepasse: (role === 'super_admin' || role === 'operador_drg') };
      await db.collection('perfis').doc('seed_' + role).set({
        nome: ROTULO_PERFIL[role] || role,
        permissoes,
        acoes,
        sistema: true,
        criadoEm: firebase.firestore.FieldValue.serverTimestamp(),
        criadoPor: State.user ? State.user.uid : null,
      });
    }
    renderPerfis();
  } catch (err) {
    alert('Falha ao criar os perfis padrão: ' + ((err && err.message) || err));
  }
}

// -------------------------------------------------------------
// Modal "Editar Perfil"
// -------------------------------------------------------------
function abrirFormPerfil(id) {
  const p = id ? (cachePerfis[id] || {}) : {};
  const perm = p.permissoes || {};
  const acoes = p.acoes || {};

  let grade = '';
  ORDEM_GRUPOS.forEach((grupo) => {
    const cards = [];
    Object.keys(MODULOS).forEach((mid) => {
      if (MODULOS[mid].grupo !== grupo) return;
      if (MODULOS_SEM_CARD.indexOf(mid) !== -1) return;
      cards.push(cardModuloPerfil(mid, perm[mid] || {}));
    });
    Object.keys(ACOES_PERM).forEach((aid) => {
      if (ACOES_PERM[aid].grupo !== grupo) return;
      cards.push(cardAcaoPerfil(aid, !!acoes[aid]));
    });
    if (cards.length) {
      grade += `<div class="perfil-grupo-titulo">${escapeHtml(grupo)}</div>
        <div class="perfil-grid">${cards.join('')}</div>`;
    }
  });

  const corpo = `
    ${campo('Nome do perfil', inputTexto('perfil-nome', p.nome), true)}
    <label style="display:block;font-size:13px;font-weight:600;color:var(--text);margin:6px 0 4px;">Módulos e permissões</label>
    <p class="muted" style="font-size:12px;margin-bottom:8px;">Marque o acesso a cada módulo. "Editar" libera criar/alterar/excluir; sem ela, o módulo fica só de leitura.</p>
    ${grade}`;
  abrirModalForm(id ? 'Editar perfil' : 'Novo perfil', corpo, () => salvarPerfil(id), 'Salvar perfil');
}

function cardModuloPerfil(mid, estado) {
  const m = MODULOS[mid];
  const travado = mid === 'dashboard';
  const temEditar = MODULOS_COM_EDITAR.indexOf(mid) !== -1;
  const acesso = travado || !!estado.acesso;
  const linhaEditar = temEditar
    ? `<label class="perfil-check"><input type="checkbox" class="perm-editar" data-mod="${mid}" ${estado.editar ? 'checked' : ''} ${acesso ? '' : 'disabled'}> Pode editar</label>`
    : '';
  return `<div class="perfil-modulo-card${acesso ? ' ativo' : ''}">
    <div class="perfil-modulo-titulo">${escapeHtml(m.label)}</div>
    <label class="perfil-check">
      <input type="checkbox" class="perm-acesso" data-mod="${mid}" ${acesso ? 'checked' : ''} ${travado ? 'disabled' : ''} onchange="perfilSincronizarCard(this)">
      ${travado ? 'Sempre liberado' : 'Acesso ao módulo'}
    </label>
    ${linhaEditar}
  </div>`;
}

function cardAcaoPerfil(aid, ativo) {
  const a = ACOES_PERM[aid];
  return `<div class="perfil-modulo-card perfil-acao${ativo ? ' ativo' : ''}">
    <div class="perfil-modulo-titulo">${escapeHtml(a.label)}</div>
    <label class="perfil-check">
      <input type="checkbox" class="perm-acao" data-acao="${aid}" ${ativo ? 'checked' : ''} onchange="this.closest('.perfil-modulo-card').classList.toggle('ativo', this.checked)">
      Permitir
    </label>
    <p class="muted" style="font-size:11px;margin:4px 0 0;">${escapeHtml(a.descricao)}</p>
  </div>`;
}

// "Editar" depende de "Acesso": desmarcar o acesso desabilita/zera o editar.
function perfilSincronizarCard(chk) {
  const card = chk.closest('.perfil-modulo-card');
  const editar = card ? card.querySelector('.perm-editar') : null;
  if (editar) {
    editar.disabled = !chk.checked;
    if (!chk.checked) editar.checked = false;
  }
  if (card) card.classList.toggle('ativo', chk.checked);
}

async function salvarPerfil(id) {
  const nome = valId('perfil-nome');
  if (!nome) { erroModal('Informe o nome do perfil.'); return; }

  const permissoes = {};
  document.querySelectorAll('.perm-acesso').forEach((chk) => {
    const mid = chk.dataset.mod;
    const acesso = chk.checked;
    const editEl = document.querySelector(`.perm-editar[data-mod="${mid}"]`);
    const editar = !!(editEl && editEl.checked && acesso);
    if (acesso || editar) permissoes[mid] = { acesso, editar };
  });
  const acoes = {};
  document.querySelectorAll('.perm-acao').forEach((chk) => {
    acoes[chk.dataset.acao] = chk.checked;
  });

  travarSalvar(true);
  try {
    const existente = id ? (cachePerfis[id] || {}) : {};
    const dados = { nome, permissoes, acoes, sistema: !!existente.sistema };
    if (id) {
      await db.collection('perfis').doc(id).update(dados);
    } else {
      dados.criadoEm = firebase.firestore.FieldValue.serverTimestamp();
      dados.criadoPor = State.user ? State.user.uid : null;
      await db.collection('perfis').add(dados);
    }
    fecharModalForm();
    renderPerfis();
  } catch (err) {
    travarSalvar(false, 'Salvar perfil');
    erroModal('Falha ao salvar: ' + ((err && err.message) || err));
  }
}

async function excluirPerfil(id) {
  const p = cachePerfis[id] || {};
  if (p.sistema) { alert('Os perfis-base não podem ser excluídos.'); return; }
  try {
    const snap = await db.collection('users').where('perfilId', '==', id).get();
    if (!snap.empty) {
      alert(`Este perfil está em uso por ${snap.size} usuário(s). Troque o perfil deles antes de excluir.`);
      return;
    }
  } catch (_) { /* sem o índice/permissão segue — a confirmação ainda protege */ }
  const ok = await confirmar({
    titulo: 'Excluir perfil',
    mensagem: `Excluir o perfil "${p.nome || ''}"?`,
    okLabel: 'Excluir', perigo: true,
  });
  if (!ok) return;
  try {
    await db.collection('perfis').doc(id).delete();
    renderPerfis();
  } catch (err) {
    alert('Falha ao excluir: ' + ((err && err.message) || err));
  }
}

SECTION_RENDERERS.perfis = renderPerfis;
