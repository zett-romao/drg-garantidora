// =============================================================
// DRG-Garantidora — conta.js
// "Minha conta" — cadastro da verificação em duas etapas (2FA) com o
// Google Authenticator. O 2FA é exigido para aprovar repasses.
// O segredo TOTP fica só no Worker (coleção mfa); aqui só conversamos
// com /mfa/enroll, /mfa/confirm e /mfa/status.
// Carregado depois de competencias.js (usa WORKER_ASAAS_URL, tokenAtual).
// =============================================================

let contaOtpauth = null; // otpauth do cadastro em andamento

async function abrirMinhaConta() {
  abrirModalForm('Minha conta', '<div class="loader">Carregando…</div>', () => fecharModalForm(), 'Fechar');
  let ativo = false;
  try {
    const r = await fetch(`${WORKER_ASAAS_URL}/mfa/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: await tokenAtual() }),
    });
    const j = await r.json().catch(() => ({}));
    if (j && j.success) ativo = !!j.ativo;
  } catch (_) { /* trata como não configurado */ }
  renderMinhaConta(ativo);
}

function renderMinhaConta(ativo) {
  const u = auth.currentUser || {};
  const nome = (State.userDoc && State.userDoc.nome) || u.email || '—';
  const corpo = `
    <p>Conta: <strong>${escapeHtml(nome)}</strong></p>
    <p class="muted" style="font-size:12px;">${escapeHtml(u.email || '')}</p>
    <div style="margin-top:14px;border-top:1px solid var(--border);padding-top:14px;">
      <h3 style="font-size:14px;margin-bottom:8px;">Verificação em duas etapas (2FA)</h3>
      <p>Status: ${ativo
        ? '<span class="badge badge-success">Ativo</span>'
        : '<span class="badge badge-warning">Não configurado</span>'}</p>
      <p class="muted" style="font-size:12px;margin-top:8px;">
        O 2FA com o Google Authenticator é exigido para <strong>aprovar repasses</strong>
        (movimentação de dinheiro). ${ativo ? 'Reconfigure se trocou de celular.' : ''}
      </p>
    </div>`;
  abrirModalForm('Minha conta', corpo, iniciarConfig2FA, ativo ? 'Reconfigurar 2FA' : 'Configurar 2FA');
}

async function iniciarConfig2FA() {
  travarSalvar(true);
  let dados;
  try {
    const r = await fetch(`${WORKER_ASAAS_URL}/mfa/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: await tokenAtual() }),
    });
    dados = await r.json().catch(() => ({}));
    if (!r.ok || !dados.success) throw new Error(dados.error || 'falha ao iniciar o cadastro');
  } catch (err) {
    travarSalvar(false, 'Configurar 2FA');
    erroModal('Falha: ' + ((err && err.message) || err));
    return;
  }
  contaOtpauth = dados.otpauth;
  const corpo = `
    <p style="font-size:13px;">1. No celular, abra o <strong>Google Authenticator</strong> e escaneie o QR:</p>
    <div id="conta-qr" style="display:flex;justify-content:center;margin:14px 0;"></div>
    <p class="muted" style="font-size:12px;">Sem como escanear? Adicione manualmente esta chave no app:</p>
    <p style="font-family:monospace;font-size:13px;word-break:break-all;background:var(--bg);border:1px solid var(--border);padding:8px;border-radius:6px;">${escapeHtml(dados.secret)}</p>
    <p style="font-size:13px;margin-top:12px;">2. Digite o código de 6 dígitos que o app mostrar:</p>
    ${campo('Código do app', '<input type="text" id="conta-totp" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="6 dígitos">', true)}`;
  abrirModalForm('Configurar 2FA', corpo, confirmar2FA, 'Ativar 2FA');

  const div = document.getElementById('conta-qr');
  if (div && typeof QRCode !== 'undefined') {
    try {
      new QRCode(div, { text: contaOtpauth, width: 184, height: 184 });
    } catch (_) {
      div.innerHTML = '<p class="muted" style="font-size:12px;">QR indisponível — use a chave acima.</p>';
    }
  } else if (div) {
    div.innerHTML = '<p class="muted" style="font-size:12px;">QR indisponível — use a chave acima.</p>';
  }
}

async function confirmar2FA() {
  const totp = (valId('conta-totp') || '').replace(/\D/g, '');
  if (totp.length !== 6) { erroModal('Informe o código de 6 dígitos do app.'); return; }
  travarSalvar(true);
  try {
    const r = await fetch(`${WORKER_ASAAS_URL}/mfa/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: await tokenAtual(), totp }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.success) throw new Error(j.error || 'falha ao ativar');
    fecharModalForm();
    alert('2FA ativado. Agora você pode aprovar repasses.');
  } catch (err) {
    travarSalvar(false, 'Ativar 2FA');
    erroModal('Falha: ' + ((err && err.message) || err));
  }
}
