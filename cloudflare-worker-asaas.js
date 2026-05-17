// =============================================================
// DRG-Garantidora — Cloudflare Worker: Asaas
//
// Faz:
//  1) Emite boletos (com Pix) das competências condominiais via Asaas.
//  2) APROVA repasses: verifica identidade + senha recente + 2FA (Google
//     Authenticator) + perfil, e só então dispara o Pix ao condomínio.
//  3) Cadastro/checagem do 2FA (TOTP): /mfa/enroll, /mfa/confirm, /mfa/status.
//  4) Recebe o webhook do Asaas e CONCILIA pagamentos e transferências.
//
// SEGURANÇA: os endpoints chamados pelo site exigem um ID token do Firebase
// válido — sem login, 401. /aprovar-repasse exige, além disso, senha recente
// (auth_time), código TOTP e o perfil com a ação "aprovar repasse".
// O /webhook usa o WEBHOOK_TOKEN (é o Asaas que chama).
//
// COMO INSTALAR / ATUALIZAR:
//  1. https://dash.cloudflare.com → Workers & Pages → drg-garantidora-asaas
//  2. "Edit code" → apague tudo → cole TODO este arquivo → "Deploy"
//  3. Settings → Variables and Secrets:
//     - Secret   ASAAS_API_KEY = chave de API de PRODUÇÃO do Asaas
//     - Variable ASAAS_ENV     = production
//     - Secret   WEBHOOK_TOKEN = token do webhook (o mesmo do painel Asaas)
//     - Secret   FIREBASE_SA   = JSON inteiro da conta de serviço do Firebase
//  4. No painel do Asaas, no webhook do /webhook, habilite os eventos de
//     cobrança e de TRANSFERÊNCIA (TRANSFER_*).
// =============================================================

const ALLOWED_ORIGINS = [
  'http://localhost:8123',
  'http://127.0.0.1:8123',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'https://zett-romao.github.io',
];

const FIREBASE_PROJECT_ID = 'drg-garantidora';

function asaasBase(env) {
  return env.ASAAS_ENV === 'sandbox'
    ? 'https://sandbox.asaas.com/api/v3'
    : 'https://api.asaas.com/v3';
}

async function asaasFetch(url, env, method, body) {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'DRG-Garantidora/1.0 (Cloudflare-Worker)',
    'access_token': env.ASAAS_API_KEY,
  };
  const opts = { method: method || 'GET', headers };
  if (body) opts.body = JSON.stringify(body);
  return fetch(url, opts);
}

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResp(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(origin) },
  });
}

function soDigitos(v) {
  return String(v || '').replace(/\D/g, '');
}

function erroAsaas(data) {
  return (data && data.errors && data.errors[0] && data.errors[0].description) || 'Erro no Asaas';
}

// =============================================================
// Autenticação no Google + acesso ao Firestore (REST)
// =============================================================

// Token de acesso do Google, reaproveitado entre requisições do worker.
let _tokenCache = null; // { token, exp }

// Codifica em base64url (string ou ArrayBuffer/TypedArray).
function b64url(input) {
  let bytes;
  if (typeof input === 'string') {
    bytes = new TextEncoder().encode(input);
  } else {
    bytes = new Uint8Array(input);
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Decodifica base64url em bytes (Uint8Array).
function b64urlDecode(str) {
  let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Converte a chave privada PEM (PKCS#8) da conta de serviço em ArrayBuffer.
function pemParaArrayBuffer(pem) {
  const b64 = String(pem)
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// Gera um access token do Google a partir da conta de serviço (JWT RS256).
async function gerarTokenGoogle(sa) {
  const agora = Math.floor(Date.now() / 1000);
  const cabecalho = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: agora,
    exp: agora + 3600,
  };
  const semAssinatura = b64url(JSON.stringify(cabecalho)) + '.' + b64url(JSON.stringify(claim));
  const chave = await crypto.subtle.importKey(
    'pkcs8',
    pemParaArrayBuffer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const assinatura = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', chave, new TextEncoder().encode(semAssinatura),
  );
  const jwt = semAssinatura + '.' + b64url(assinatura);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + encodeURIComponent(jwt),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error('Falha ao autenticar no Google: ' + (data.error_description || data.error || res.status));
  }
  return { token: data.access_token, exp: agora + (data.expires_in || 3600) - 60 };
}

async function tokenGoogle(sa) {
  const agora = Math.floor(Date.now() / 1000);
  if (_tokenCache && _tokenCache.exp > agora) return _tokenCache.token;
  _tokenCache = await gerarTokenGoogle(sa);
  return _tokenCache.token;
}

function firestoreUrl(sa, caminho) {
  return `https://firestore.googleapis.com/v1/projects/${sa.project_id}` +
    `/databases/(default)/documents/${caminho}`;
}

// Atualiza (merge) os campos informados de um documento — cria se não existir.
async function firestoreUpdate(sa, caminhoDoc, fields) {
  const token = await tokenGoogle(sa);
  const masks = Object.keys(fields)
    .map((f) => 'updateMask.fieldPaths=' + encodeURIComponent(f))
    .join('&');
  return fetch(firestoreUrl(sa, caminhoDoc) + '?' + masks, {
    method: 'PATCH',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
}

// Cria um documento numa coleção (id automático).
async function firestoreCreate(sa, caminhoColecao, fields) {
  const token = await tokenGoogle(sa);
  return fetch(firestoreUrl(sa, caminhoColecao), {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
}

// Converte um valor do formato REST do Firestore para JS.
function fsValor(f) {
  if (!f || typeof f !== 'object') return null;
  if ('stringValue' in f) return f.stringValue;
  if ('integerValue' in f) return Number(f.integerValue);
  if ('doubleValue' in f) return Number(f.doubleValue);
  if ('booleanValue' in f) return f.booleanValue;
  if ('timestampValue' in f) return f.timestampValue;
  if ('nullValue' in f) return null;
  if ('mapValue' in f) {
    const o = {};
    const ff = (f.mapValue && f.mapValue.fields) || {};
    Object.keys(ff).forEach((k) => { o[k] = fsValor(ff[k]); });
    return o;
  }
  if ('arrayValue' in f) {
    return ((f.arrayValue && f.arrayValue.values) || []).map(fsValor);
  }
  return null;
}

// Lê um documento do Firestore. Retorna um objeto JS, ou null se não existir.
async function firestoreGet(sa, caminhoDoc) {
  const token = await tokenGoogle(sa);
  const res = await fetch(firestoreUrl(sa, caminhoDoc), {
    headers: { 'Authorization': 'Bearer ' + token },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Firestore GET ' + res.status);
  const data = await res.json();
  const obj = {};
  const fields = data.fields || {};
  Object.keys(fields).forEach((k) => { obj[k] = fsValor(fields[k]); });
  return obj;
}

// =============================================================
// Verificação do ID token do Firebase (login do usuário)
// =============================================================
const FIREBASE_JWK_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

let _firebaseKeys = null; // { mapa: {kid: CryptoKey}, exp }

async function getFirebaseKeys() {
  const agora = Date.now();
  if (_firebaseKeys && _firebaseKeys.exp > agora) return _firebaseKeys.mapa;
  const res = await fetch(FIREBASE_JWK_URL);
  if (!res.ok) throw new Error('Falha ao buscar as chaves do Firebase');
  const data = await res.json();
  const mapa = {};
  for (const jwk of (data.keys || [])) {
    mapa[jwk.kid] = await crypto.subtle.importKey(
      'jwk', jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false, ['verify'],
    );
  }
  const cc = res.headers.get('Cache-Control') || '';
  const m = cc.match(/max-age=(\d+)/);
  const ttl = (m ? parseInt(m[1], 10) : 3600) * 1000;
  _firebaseKeys = { mapa, exp: agora + ttl };
  return mapa;
}

// Verifica um ID token do Firebase. Retorna { uid, email, authTime } ou lança.
async function verificarIdToken(idToken) {
  if (!idToken) throw new Error('token ausente');
  const partes = String(idToken).split('.');
  if (partes.length !== 3) throw new Error('token malformado');

  const header = JSON.parse(new TextDecoder().decode(b64urlDecode(partes[0])));
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(partes[1])));
  if (header.alg !== 'RS256') throw new Error('algoritmo inválido');

  const keys = await getFirebaseKeys();
  const key = keys[header.kid];
  if (!key) throw new Error('chave do token não encontrada');

  const assinaturaOk = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key,
    b64urlDecode(partes[2]),
    new TextEncoder().encode(partes[0] + '.' + partes[1]),
  );
  if (!assinaturaOk) throw new Error('assinatura inválida');

  const agora = Math.floor(Date.now() / 1000);
  if (payload.aud !== FIREBASE_PROJECT_ID) throw new Error('token de outro projeto');
  if (payload.iss !== 'https://securetoken.google.com/' + FIREBASE_PROJECT_ID) {
    throw new Error('emissor inválido');
  }
  if (!payload.sub) throw new Error('token sem usuário');
  if (!payload.exp || payload.exp <= agora) throw new Error('token expirado');
  if (payload.iat && payload.iat > agora + 300) throw new Error('token com data futura');

  return { uid: payload.sub, email: payload.email || '', authTime: payload.auth_time || 0 };
}

// Extrai e verifica o ID token: do corpo JSON (POST) ou do header Authorization.
async function exigirAuth(corpo, request) {
  let idToken = corpo && corpo.idToken;
  if (!idToken) {
    const h = request.headers.get('Authorization') || '';
    if (h.indexOf('Bearer ') === 0) idToken = h.slice(7);
  }
  return verificarIdToken(idToken);
}

// Exige que o usuário tenha permissão de faturamento (perfil com
// permissoes.competencias.editar). Se os perfis ainda não foram criados,
// cai no tier — equipe D.R. (super_admin/operador_drg) pode faturar.
// Retorna uma resposta de erro (jsonResp) ou null se autorizado.
async function exigirFaturamento(auth, env, origin) {
  if (!env.FIREBASE_SA) {
    return jsonResp({ error: 'FIREBASE_SA não configurada no Worker' }, 500, origin);
  }
  const sa = JSON.parse(env.FIREBASE_SA);
  const usr = await firestoreGet(sa, `users/${auth.uid}`);
  if (!usr || usr.ativo === false) {
    return jsonResp({ error: 'Acesso negado.' }, 403, origin);
  }
  const role = usr.role || 'condomino';
  const perfilId = usr.perfilId || ('seed_' + role);
  let perfil = await firestoreGet(sa, `perfis/${perfilId}`);
  if (!perfil) perfil = await firestoreGet(sa, `perfis/seed_${role}`);
  let permitido;
  if (perfil && perfil.permissoes) {
    const perm = perfil.permissoes.competencias;
    permitido = !!(perm && perm.editar);
  } else {
    permitido = (role === 'super_admin' || role === 'operador_drg');
  }
  if (!permitido) {
    return jsonResp({ error: 'Seu perfil não permite emitir cobranças.' }, 403, origin);
  }
  return null;
}

// =============================================================
// TOTP (Google Authenticator) — RFC 6238, HMAC-SHA1
// =============================================================
const BASE32_ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(bytes) {
  let bits = 0, valor = 0, out = '';
  for (let i = 0; i < bytes.length; i++) {
    valor = (valor << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALFABETO[(valor >> bits) & 31];
    }
  }
  if (bits > 0) out += BASE32_ALFABETO[(valor << (5 - bits)) & 31];
  return out;
}

function base32Decode(s) {
  s = String(s).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0, valor = 0;
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const idx = BASE32_ALFABETO.indexOf(s[i]);
    if (idx === -1) continue;
    valor = (valor << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((valor >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

// Código TOTP de 6 dígitos para um contador (passo de 30s).
async function totpCodigo(keyBytes, contador) {
  const buf = new ArrayBuffer(8);
  const dv = new DataView(buf);
  dv.setUint32(0, Math.floor(contador / 0x100000000));
  dv.setUint32(4, contador >>> 0);
  const chave = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', chave, buf));
  const offset = mac[19] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16)
    | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 1000000).padStart(6, '0');
}

// Verifica um código TOTP (janela de ±1 passo de 30s p/ tolerar relógio).
async function verificarTotp(secretBase32, code) {
  code = String(code || '').replace(/\D/g, '');
  if (code.length !== 6) return false;
  const key = base32Decode(secretBase32);
  if (!key.length) return false;
  const passo = Math.floor(Date.now() / 1000 / 30);
  for (let d = -1; d <= 1; d++) {
    if (await totpCodigo(key, passo + d) === code) return true;
  }
  return false;
}

// =============================================================
// Roteamento
// =============================================================
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const path = new URL(request.url).pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (path === '/webhook' && request.method === 'POST') {
      return receberWebhook(request, env);
    }

    if (path === '/' || path === '') {
      return new Response('DRG-Garantidora — Worker Asaas. Online.', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return jsonResp({ error: 'Origin not allowed' }, 403, origin);
    }
    if (!env.ASAAS_API_KEY) {
      return jsonResp({ error: 'ASAAS_API_KEY não configurada no Worker' }, 500, origin);
    }

    try {
      if (path === '/customers' && request.method === 'POST') {
        return await criarCustomer(request, env, origin);
      }
      if (path === '/boletos' && request.method === 'POST') {
        return await criarBoleto(request, env, origin);
      }
      if (path === '/aprovar-repasse' && request.method === 'POST') {
        return await aprovarRepasse(request, env, origin);
      }
      if (path === '/mfa/enroll' && request.method === 'POST') {
        return await mfaEnroll(request, env, origin);
      }
      if (path === '/mfa/confirm' && request.method === 'POST') {
        return await mfaConfirm(request, env, origin);
      }
      if (path === '/mfa/status' && request.method === 'POST') {
        return await mfaStatus(request, env, origin);
      }
      const m = path.match(/^\/boletos\/([^/]+)$/);
      if (m && request.method === 'GET') {
        return await buscarBoleto(m[1], request, env, origin);
      }
      return jsonResp({ error: 'Endpoint não encontrado: ' + path }, 404, origin);
    } catch (err) {
      return jsonResp({ error: 'Erro interno: ' + ((err && err.message) || err) }, 500, origin);
    }
  },
};

// Cria um cliente (condômino) no Asaas.
async function criarCustomer(request, env, origin) {
  const p = await request.json();
  let auth;
  try { auth = await exigirAuth(p, request); }
  catch (e) { return jsonResp({ error: 'Acesso negado: ' + (e.message || e) }, 401, origin); }
  const negado = await exigirFaturamento(auth, env, origin);
  if (negado) return negado;

  if (!p.nome || !p.cpfCnpj) {
    return jsonResp({ error: 'Campos obrigatórios: nome, cpfCnpj' }, 400, origin);
  }
  const body = {
    name: p.nome,
    cpfCnpj: soDigitos(p.cpfCnpj),
    email: p.email || undefined,
    mobilePhone: soDigitos(p.telefone) || undefined,
    externalReference: p.refExterna || undefined,
    notificationDisabled: false,
  };
  Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);

  const res = await asaasFetch(`${asaasBase(env)}/customers`, env, 'POST', body);
  const data = await res.json();
  if (!res.ok) return jsonResp({ error: erroAsaas(data), details: data }, res.status, origin);
  return jsonResp({ success: true, customer: data }, 200, origin);
}

// Emite um boleto (com Pix) para um cliente.
async function criarBoleto(request, env, origin) {
  const p = await request.json();
  let auth;
  try { auth = await exigirAuth(p, request); }
  catch (e) { return jsonResp({ error: 'Acesso negado: ' + (e.message || e) }, 401, origin); }
  const negado = await exigirFaturamento(auth, env, origin);
  if (negado) return negado;

  if (!p.customerId || !p.valor || !p.vencimento) {
    return jsonResp({ error: 'Campos obrigatórios: customerId, valor, vencimento' }, 400, origin);
  }
  const body = {
    customer: p.customerId,
    billingType: 'BOLETO',
    value: Number(p.valor),
    dueDate: p.vencimento,            // YYYY-MM-DD
    description: p.descricao || 'Contribuição condominial',
    externalReference: p.refExterna || undefined,
  };
  if (p.multaPct != null) body.fine = { value: Number(p.multaPct) };
  if (p.jurosMesPct != null) body.interest = { value: Number(p.jurosMesPct) };
  Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);

  const res = await asaasFetch(`${asaasBase(env)}/payments`, env, 'POST', body);
  const data = await res.json();
  if (!res.ok) return jsonResp({ error: erroAsaas(data), details: data }, res.status, origin);
  return jsonResp({ success: true, boleto: data }, 200, origin);
}

// Consulta o status de um boleto.
async function buscarBoleto(id, request, env, origin) {
  try { await exigirAuth(null, request); }
  catch (e) { return jsonResp({ error: 'Acesso negado: ' + (e.message || e) }, 401, origin); }

  const res = await asaasFetch(`${asaasBase(env)}/payments/${id}`, env, 'GET');
  const data = await res.json();
  if (!res.ok) return jsonResp({ error: erroAsaas(data), details: data }, res.status, origin);
  return jsonResp({ success: true, boleto: data }, 200, origin);
}

// =============================================================
// APROVAR REPASSE — a trava real do dinheiro.
// Verifica, em ordem: ID token + senha recente (auth_time) + perfil com
// "aprovar repasse" + código TOTP + competência aguardando + valor/chave
// lidos do servidor + aprovador != solicitante. Só então dispara o Pix.
// =============================================================
async function aprovarRepasse(request, env, origin) {
  const p = await request.json();

  let auth;
  try { auth = await verificarIdToken(p.idToken); }
  catch (e) { return jsonResp({ error: 'Acesso negado: ' + (e.message || e) }, 401, origin); }

  // senha recente: o cliente reautentica e manda um token fresco (auth_time)
  const agora = Math.floor(Date.now() / 1000);
  if (!auth.authTime || (agora - auth.authTime) > 300) {
    return jsonResp({ error: 'Sessão de aprovação expirada — digite a senha novamente.' }, 401, origin);
  }
  if (!p.cid || !p.compId) {
    return jsonResp({ error: 'Campos obrigatórios: cid, compId' }, 400, origin);
  }
  if (!env.FIREBASE_SA) {
    return jsonResp({ error: 'FIREBASE_SA não configurada no Worker' }, 500, origin);
  }
  const sa = JSON.parse(env.FIREBASE_SA);

  // perfil do aprovador → ação "aprovar repasse"
  const usr = await firestoreGet(sa, `users/${auth.uid}`);
  if (!usr) return jsonResp({ error: 'Usuário não encontrado.' }, 403, origin);
  if (usr.ativo === false) return jsonResp({ error: 'Acesso desativado.' }, 403, origin);
  const role = usr.role || 'condomino';
  const perfilId = usr.perfilId || ('seed_' + role);
  let perfil = await firestoreGet(sa, `perfis/${perfilId}`);
  if (!perfil) perfil = await firestoreGet(sa, `perfis/seed_${role}`);
  const podeAprovar = !!(perfil && perfil.acoes && perfil.acoes.aprovarRepasse);
  if (!podeAprovar) {
    return jsonResp({ error: 'Seu perfil não permite aprovar repasses.' }, 403, origin);
  }

  // 2FA — código TOTP
  const mfa = await firestoreGet(sa, `mfa/${auth.uid}`);
  if (!mfa || !mfa.ativo || !mfa.secretBase32) {
    return jsonResp({ error: 'Configure o 2FA (Google Authenticator) em "Minha conta" antes de aprovar.' }, 403, origin);
  }
  if (!(await verificarTotp(mfa.secretBase32, p.totp))) {
    return jsonResp({ error: 'Código do Google Authenticator inválido.' }, 401, origin);
  }

  // competência — estado + valor lido do SERVIDOR (não do cliente)
  const compPath = `condominios/${p.cid}/competencias/${p.compId}`;
  const comp = await firestoreGet(sa, compPath);
  if (!comp) return jsonResp({ error: 'Competência não encontrada.' }, 404, origin);
  if (comp.repasseStatus !== 'AGUARDANDO_APROVACAO') {
    return jsonResp({ error: 'Esta competência não está aguardando aprovação.' }, 409, origin);
  }
  const valor = Number(comp.repasseValor) || 0;
  if (!(valor > 0)) {
    return jsonResp({ error: 'Valor do repasse inválido.' }, 409, origin);
  }
  if (comp.repasseSolicitadoPor && comp.repasseSolicitadoPor === auth.uid) {
    return jsonResp({ error: 'Quem solicitou o repasse não pode aprová-lo (separação de funções).' }, 403, origin);
  }

  // chave Pix do condomínio — lida do SERVIDOR
  const cond = await firestoreGet(sa, `condominios/${p.cid}`);
  const rep = (cond && cond.repasse) || {};
  if (!rep.pixChave || !rep.pixTipo) {
    return jsonResp({ error: 'O condomínio não tem chave Pix cadastrada.' }, 409, origin);
  }

  // dispara o Pix no Asaas
  const asaasBody = {
    value: valor,
    pixAddressKey: String(rep.pixChave),
    pixAddressKeyType: String(rep.pixTipo),
    operationType: 'PIX',
    description: 'Repasse de cotas condominiais — ' + ((cond && cond.nome) || p.cid),
    externalReference: `garantidora|${p.cid}|${p.compId}|repasse`,
  };
  const res = await asaasFetch(`${asaasBase(env)}/transfers`, env, 'POST', asaasBody);
  const data = await res.json();
  if (!res.ok) return jsonResp({ error: erroAsaas(data), details: data }, res.status, origin);

  // atualiza a competência
  const hoje = new Date().toISOString().slice(0, 10);
  await firestoreUpdate(sa, compPath, {
    repasseStatus: { stringValue: String(data.status || 'PENDING') },
    repasseTransferId: { stringValue: String(data.id || '') },
    repasseEm: { stringValue: hoje },
    repasseAprovadoPor: { stringValue: auth.uid },
    repasseAprovadoEmail: { stringValue: auth.email || '' },
    repasseAprovadoEm: { timestampValue: new Date().toISOString() },
    repasseComprovanteUrl: { stringValue: String(data.transactionReceiptUrl || '') },
    repasseFalhaMotivo: { stringValue: '' },
  });

  // auditoria (gravada pela conta de serviço — passa por cima de write:false)
  try {
    await firestoreCreate(sa, 'auditoria', {
      criadoEm: { timestampValue: new Date().toISOString() },
      usuario: { stringValue: auth.uid },
      usuarioEmail: { stringValue: auth.email || '' },
      acao: { stringValue: 'repasse.aprovado' },
      detalhe: { stringValue: `Repasse de R$ ${valor.toFixed(2)} aprovado — competência ${p.compId}, condomínio ${(cond && cond.nome) || p.cid}; transferência Asaas ${data.id || '?'}.` },
    });
  } catch (_) { /* auditoria não bloqueia o repasse */ }

  return jsonResp({ success: true, transferencia: data }, 200, origin);
}

// =============================================================
// 2FA — cadastro e checagem do Google Authenticator (TOTP)
// =============================================================
async function mfaEnroll(request, env, origin) {
  const p = await request.json();
  let auth;
  try { auth = await verificarIdToken(p.idToken); }
  catch (e) { return jsonResp({ error: 'Acesso negado: ' + (e.message || e) }, 401, origin); }
  if (!env.FIREBASE_SA) return jsonResp({ error: 'FIREBASE_SA não configurada no Worker' }, 500, origin);
  const sa = JSON.parse(env.FIREBASE_SA);

  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const secret = base32Encode(bytes);
  await firestoreUpdate(sa, `mfa/${auth.uid}`, {
    secretBase32: { stringValue: secret },
    ativo: { booleanValue: false },
    criadoEm: { timestampValue: new Date().toISOString() },
  });
  const label = encodeURIComponent('DRG-Garantidora:' + (auth.email || auth.uid));
  const otpauth = `otpauth://totp/${label}?secret=${secret}&issuer=DRG-Garantidora&algorithm=SHA1&digits=6&period=30`;
  return jsonResp({ success: true, secret, otpauth }, 200, origin);
}

async function mfaConfirm(request, env, origin) {
  const p = await request.json();
  let auth;
  try { auth = await verificarIdToken(p.idToken); }
  catch (e) { return jsonResp({ error: 'Acesso negado: ' + (e.message || e) }, 401, origin); }
  if (!env.FIREBASE_SA) return jsonResp({ error: 'FIREBASE_SA não configurada no Worker' }, 500, origin);
  const sa = JSON.parse(env.FIREBASE_SA);

  const mfa = await firestoreGet(sa, `mfa/${auth.uid}`);
  if (!mfa || !mfa.secretBase32) {
    return jsonResp({ error: 'Inicie o cadastro do 2FA primeiro.' }, 409, origin);
  }
  if (!(await verificarTotp(mfa.secretBase32, p.totp))) {
    return jsonResp({ error: 'Código inválido. Use o código atual mostrado no app.' }, 401, origin);
  }
  await firestoreUpdate(sa, `mfa/${auth.uid}`, {
    ativo: { booleanValue: true },
    confirmadoEm: { timestampValue: new Date().toISOString() },
  });
  return jsonResp({ success: true }, 200, origin);
}

async function mfaStatus(request, env, origin) {
  const p = await request.json();
  let auth;
  try { auth = await verificarIdToken(p.idToken); }
  catch (e) { return jsonResp({ error: 'Acesso negado: ' + (e.message || e) }, 401, origin); }
  if (!env.FIREBASE_SA) return jsonResp({ error: 'FIREBASE_SA não configurada no Worker' }, 500, origin);
  const sa = JSON.parse(env.FIREBASE_SA);

  const mfa = await firestoreGet(sa, `mfa/${auth.uid}`);
  return jsonResp({ success: true, ativo: !!(mfa && mfa.ativo) }, 200, origin);
}

// =============================================================
// Webhook do Asaas — conciliação no Firestore.
//
// Recebe DOIS tipos de evento:
//  - cobrança      (body.payment)  → atualiza o boleto
//  - transferência (body.transfer) → atualiza o repasse da competência
//
// A conta Asaas é compartilhada com o DRG-Rently — só processamos os
// objetos cuja externalReference começa com "garantidora":
//  - boleto:        "garantidora|cid|competenciaId|unidadeId"
//  - transferência: "garantidora|cid|competenciaId|repasse"
//
// SEMPRE responde 200 (menos token inválido) pra o webhook não "Interromper".
// =============================================================
async function receberWebhook(request, env) {
  const ok200 = (obj) => new Response(JSON.stringify(obj), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });

  const token = request.headers.get('asaas-access-token');
  if (env.WEBHOOK_TOKEN && token !== env.WEBHOOK_TOKEN) {
    return new Response('Unauthorized', { status: 401 });
  }

  let body;
  try { body = await request.json(); } catch (_) { body = {}; }

  const transferencia = body.transfer || null;
  const pagamento = body.payment || null;
  const objeto = transferencia || pagamento || {};
  const ref = String(objeto.externalReference || '');
  const partes = ref.split('|');

  if (partes[0] !== 'garantidora' || partes.length < 4 || !objeto.id) {
    return ok200({ received: true, ignorado: true });
  }
  if (!env.FIREBASE_SA) {
    return ok200({ received: true, erro: 'FIREBASE_SA não configurada no Worker' });
  }

  try {
    const sa = JSON.parse(env.FIREBASE_SA);
    const cid = partes[1];

    // ---- Evento de transferência (repasse via Pix) ----
    if (transferencia) {
      const compId = partes[2];
      const caminhoDoc = `condominios/${cid}/competencias/${compId}`;
      const fields = {
        repasseStatus: { stringValue: String(transferencia.status || 'UNKNOWN') },
        repasseAtualizadoEm: { timestampValue: new Date().toISOString() },
        repasseAsaasEvent: { stringValue: String(body.event || '') },
      };
      if (transferencia.failReason) {
        fields.repasseFalhaMotivo = { stringValue: String(transferencia.failReason) };
      }
      if (transferencia.effectiveDate) {
        fields.repasseEfetivadoEm = { stringValue: String(transferencia.effectiveDate) };
      }
      if (transferencia.transactionReceiptUrl) {
        fields.repasseComprovanteUrl = { stringValue: String(transferencia.transactionReceiptUrl) };
      }
      const res = await firestoreUpdate(sa, caminhoDoc, fields);
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        return ok200({ received: true, erro: 'Firestore ' + res.status, detalhe: txt.slice(0, 300) });
      }
      return ok200({ received: true, conciliado: true, tipo: 'transferencia', status: transferencia.status || null });
    }

    // ---- Evento de cobrança (boleto) ----
    const caminhoDoc = `condominios/${cid}/boletos/${pagamento.id}`;
    const fields = {
      status: { stringValue: String(pagamento.status || 'UNKNOWN') },
      atualizadoEm: { timestampValue: new Date().toISOString() },
      asaasEvent: { stringValue: String(body.event || '') },
    };
    if (pagamento.value != null) {
      fields.valorPago = { doubleValue: Number(pagamento.value) };
    }
    const dataPag = pagamento.paymentDate || pagamento.clientPaymentDate || pagamento.confirmedDate;
    if (dataPag) {
      fields.pagoEm = { stringValue: String(dataPag) };
    }

    const res = await firestoreUpdate(sa, caminhoDoc, fields);
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return ok200({ received: true, erro: 'Firestore ' + res.status, detalhe: txt.slice(0, 300) });
    }
    return ok200({ received: true, conciliado: true, status: pagamento.status || null });
  } catch (err) {
    return ok200({ received: true, erro: String((err && err.message) || err) });
  }
}
