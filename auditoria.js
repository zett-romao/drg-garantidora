// =============================================================
// DRG-Garantidora — auditoria.js
// Auditoria: visualizador dos eventos registrados na coleção
// "auditoria". O registro automático de eventos é escrito pelo
// back-end (a coleção é somente-leitura pelo cliente), então a tela
// fica vazia até o back-end de auditoria entrar.
// Carregado depois de competencias.js.
// =============================================================

window.SECTION_RENDERERS = window.SECTION_RENDERERS || {};

async function renderAuditoria() {
  const content = $('content');
  content.innerHTML = `<div class="loader">Carregando auditoria…</div>`;
  try {
    let snap;
    try {
      snap = await db.collection('auditoria').orderBy('criadoEm', 'desc').limit(200).get();
    } catch (_) {
      snap = await db.collection('auditoria').limit(200).get();
    }

    const linhas = snap.docs.map((d) => {
      const a = d.data();
      const quando = (a.criadoEm && a.criadoEm.toDate)
        ? a.criadoEm.toDate().toLocaleString('pt-BR')
        : '—';
      return `<tr>
        <td>${escapeHtml(quando)}</td>
        <td>${escapeHtml(a.usuario || a.usuarioEmail || '—')}</td>
        <td>${escapeHtml(a.acao || '—')}</td>
        <td>${escapeHtml(a.detalhe || '—')}</td>
      </tr>`;
    }).join('');

    const tabela = snap.size
      ? `<div class="tabela-wrap"><table class="tabela">
           <thead><tr><th>Quando</th><th>Usuário</th><th>Ação</th><th>Detalhe</th></tr></thead>
           <tbody>${linhas}</tbody></table></div>`
      : `<div class="empty-state">Nenhum registro de auditoria ainda.
         O registro automático de eventos será ligado junto com o back-end.</div>`;

    content.innerHTML = `
      <div class="section-head">
        <div><h2>Auditoria</h2><p>Registro de eventos da plataforma.</p></div>
      </div>
      <div class="card">${tabela}</div>`;
  } catch (err) {
    content.innerHTML = cardErro('Falha ao carregar a auditoria.', err);
  }
}

SECTION_RENDERERS.auditoria = renderAuditoria;
