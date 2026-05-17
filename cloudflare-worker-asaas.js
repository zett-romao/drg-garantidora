// =============================================================
// DRG-Garantidora — Cloudflare Worker: Asaas
//
// Faz três coisas:
//  1) Emite boletos (com Pix) das competências condominiais via Asaas.
//  2) Transfere os repasses ao condomínio via Pix (API de transferências).
//  3) Recebe o webhook do Asaas e CONCILIA pagamentos e transferências:
//     - boleto pago/vencido/estornado → condominios/{cid}/boletos/{idPagamento}
//     - transferência concluída/falha → condominios/{cid}/competencias/{compId}
//
// Usa a conta Asaas da D.R. Global — a mesma já usada no DRG-Rently.
//
// COMO INSTALAR / ATUALIZAR (passo a passo):
//  1. https://dash.cloudflare.com → Workers & Pages → drg-garantidora-asaas
//  2. "Edit code" → apague tudo → cole TODO este arquivo → "Deploy"
//  3. Settings → Variables and Secrets → confira/adicione:
//     - Secret   ASAAS_API_KEY = a chave de API de PRODUÇÃO do Asaas
//     - Variable ASAAS_ENV     = production
//     - Secret   WEBHOOK_TOKEN = o token do webhook (o mesmo do painel Asaas)
//     - Secret   FIREBASE_SA   = o JSON INTEIRO da conta de serviço do Firebase
//                 (Firebase Console → Configurações do projeto → Contas de
//                  serviço → "Gerar nova chave privada" → cole o arquivo todo)
//  4. No painel do Asaas, no webhook já configurado para /webhook, habilite
//     também os eventos de TRANSFERÊNCIA (TRANSFER_*) — assim o repasse via
//     Pix é conciliado automaticamente.
//
// O FIREBASE_SA é usado só pela conciliação: o worker autentica no Google
// com essa conta de serviço e atualiza o documento direto no Firestore.
// Sem ele, a emissão de boletos e os repasses continuam funcionando — só a
// baixa automática (do pagamento e do repasse) deixa de acontecer.
// =============================================================

const ALLOWED_ORIGINS = [
  'http://localhost:8123',
  'http://127.0.0.1:8123',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'https://zett-romao.github.io',
];

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
    'Access-Control-Allow-Headers': 'Content-Type',
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
// Conciliação — autenticação no Google + escrita no Firestore (REST)
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

// Atualiza (merge) os campos informados de um documento do Firestore.
async function firestoreUpdate(sa, caminhoDoc, fields) {
  const token = await tokenGoogle(sa);
  const masks = Object.keys(fields)
    .map((f) => 'updateMask.fieldPaths=' + encodeURIComponent(f))
    .join('&');
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}` +
    `/databases/(default)/documents/${caminhoDoc}?${masks}`;
  return fetch(url, {
    method: 'PATCH',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const path = new URL(request.url).pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Webhook do Asaas — o Asaas chama; concilia pagamento/transferência.
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
      if (path === '/transferencias' && request.method === 'POST') {
        return await criarTransferencia(request, env, origin);
      }
      const m = path.match(/^\/boletos\/([^/]+)$/);
      if (m && request.method === 'GET') {
        return await buscarBoleto(m[1], env, origin);
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
async function buscarBoleto(id, env, origin) {
  const res = await asaasFetch(`${asaasBase(env)}/payments/${id}`, env, 'GET');
  const data = await res.json();
  if (!res.ok) return jsonResp({ error: erroAsaas(data), details: data }, res.status, origin);
  return jsonResp({ success: true, boleto: data }, 200, origin);
}

// Cria uma transferência (repasse) via Pix para a chave Pix do condomínio.
// O front envia: valor, pixChave, pixTipo, descricao, refExterna.
// Pix não-agendado é processado na hora; o Asaas rejeita se faltar saldo.
async function criarTransferencia(request, env, origin) {
  const p = await request.json();
  const valor = Number(p.valor);
  if (!valor || valor <= 0) {
    return jsonResp({ error: 'Valor inválido para a transferência' }, 400, origin);
  }
  if (!p.pixChave || !p.pixTipo) {
    return jsonResp({ error: 'Campos obrigatórios: pixChave, pixTipo' }, 400, origin);
  }
  const body = {
    value: valor,
    pixAddressKey: String(p.pixChave),
    pixAddressKeyType: String(p.pixTipo),
    operationType: 'PIX',
    description: p.descricao || 'Repasse de cotas condominiais',
    externalReference: p.refExterna || undefined,
  };
  Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);

  const res = await asaasFetch(`${asaasBase(env)}/transfers`, env, 'POST', body);
  const data = await res.json();
  if (!res.ok) return jsonResp({ error: erroAsaas(data), details: data }, res.status, origin);
  return jsonResp({ success: true, transferencia: data }, 200, origin);
}

// =============================================================
// Webhook do Asaas — conciliação no Firestore.
//
// Recebe DOIS tipos de evento:
//  - cobrança      (body.payment)  → atualiza o boleto
//  - transferência (body.transfer) → atualiza o repasse da competência
//
// A conta Asaas é compartilhada com o DRG-Rently, então este endpoint
// recebe eventos dos dois sistemas. Só processamos os objetos cuja
// externalReference começa com "garantidora":
//  - boleto:        "garantidora|cid|competenciaId|unidadeId"
//  - transferência: "garantidora|cid|competenciaId|repasse"
//
// Importante: este endpoint SEMPRE responde 200 (menos token inválido).
// Se a conciliação falhar, o erro vai no corpo da resposta — assim o
// webhook do Asaas nunca entra em estado "Interrompido".
// =============================================================
async function receberWebhook(request, env) {
  const ok200 = (obj) => new Response(JSON.stringify(obj), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });

  // Autentica que é o Asaas chamando (token próprio do webhook).
  const token = request.headers.get('asaas-access-token');
  if (env.WEBHOOK_TOKEN && token !== env.WEBHOOK_TOKEN) {
    return new Response('Unauthorized', { status: 401 });
  }

  let body;
  try { body = await request.json(); } catch (_) { body = {}; }

  // O evento é de transferência (body.transfer) ou de cobrança (body.payment).
  const transferencia = body.transfer || null;
  const pagamento = body.payment || null;
  const objeto = transferencia || pagamento || {};
  const ref = String(objeto.externalReference || '');
  const partes = ref.split('|');

  // Só os eventos da DRG-Garantidora. O resto (ex.: DRG-Rently) é ignorado.
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
    // externalReference = "garantidora|cid|competenciaId|repasse"
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
    // externalReference = "garantidora|cid|competenciaId|unidadeId"
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
