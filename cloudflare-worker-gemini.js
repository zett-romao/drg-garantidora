// =============================================================
// DRG-Garantidora — Cloudflare Worker: IA via Gemini
//
// Quatro modos (campo "modo" do corpo da requisição):
//  - contrato (padrão): recebe um PDF e extrai condomínio + contrato.
//  - planilha: recebe os cabeçalhos/amostras de uma planilha e mapeia
//    as colunas para os campos de unidade/condômino.
//  - valores: mapeia as colunas de uma planilha de valores da competência
//    (identificação da unidade, bloco, valor a cobrar).
//  - conciliar-unidades: casa os rótulos das unidades de uma planilha com
//    as unidades já cadastradas no sistema.
//
// SEGURANÇA: exige um ID token do Firebase válido no corpo (campo idToken) —
// sem login, 401. Fecha o uso por terceiros (gasto indevido de créditos da IA).
//
// COMO ATUALIZAR (passo a passo):
//  1. https://dash.cloudflare.com → Workers & Pages → drg-garantidora-gemini
//  2. "Edit code" → apague tudo → cole TODO este arquivo → "Deploy"
//  3. O secret GEMINI_API_KEY já está configurado (não precisa refazer).
// =============================================================

const ALLOWED_ORIGINS = [
  'http://localhost:8123',
  'http://127.0.0.1:8123',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'https://zett-romao.github.io',
];

const FIREBASE_PROJECT_ID = 'drg-garantidora';

const GEMINI_MODEL = 'gemini-2.5-flash';
const MAX_BYTES = 15 * 1024 * 1024; // 15 MB

const PROMPT_CONTRATO = `Você é um especialista em contratos de PRESTAÇÃO DE SERVIÇOS DE COBRANÇA GARANTIDA DE CONTRIBUIÇÕES CONDOMINIAIS no Brasil.

Analise o documento enviado (PDF de um contrato assinado) e extraia os dados do CONDOMÍNIO e do CONTRATO.

CONTEXTO IMPORTANTE — neste tipo de contrato há duas partes:
- O CONDOMÍNIO (também chamado CONTRATANTE) — é DELE que você extrai nome, CNPJ, endereço e síndico.
- A COBRADORA / CONTRATADA (a empresa "D.R. Global") — NÃO extraia os dados dela; ela apenas presta o serviço.

REGRAS:
- NUNCA invente dados. Campo ausente no contrato → null.
- Datas no formato "YYYY-MM-DD".
- CNPJ e CPF: APENAS dígitos (sem pontos, traços ou barras).
- Telefone: apenas dígitos, com DDD.
- CEP: 8 dígitos.
- UF: 2 letras maiúsculas.
- Valores e percentuais: número decimal com ponto (ex: 8, 3.5, 29000). Nunca string com "R$" ou "%".

Responda APENAS com JSON válido, sem markdown:

{
  "condominio": {
    "nome": <nome do condomínio ou null>,
    "cnpj": <só dígitos ou null>,
    "endereco": {
      "logradouro": <string ou null>,
      "numero": <string ou null>,
      "complemento": <string ou null>,
      "bairro": <string ou null>,
      "cidade": <string ou null>,
      "uf": <2 letras ou null>,
      "cep": <8 dígitos ou null>
    },
    "sindico": {
      "nome": <string ou null>,
      "cpf": <só dígitos ou null>,
      "telefone": <só dígitos ou null>,
      "email": <string ou null>
    }
  },
  "contrato": {
    "numero": <número/identificação do contrato, se houver, ou null>,
    "taxaAdmPct": <percentual da taxa de administração da cobradora, ex: 8>,
    "tarifaBoleto": <valor cobrado por boleto emitido, ex: 3.5>,
    "vigenciaInicio": <"YYYY-MM-DD" ou null>,
    "vigenciaFim": <"YYYY-MM-DD" ou null>,
    "prazoMeses": <prazo do contrato em meses, ex: 24>,
    "avisoDenunciaDias": <dias de antecedência exigidos para denúncia/não-renovação, ex: 75>,
    "renovacaoAuto": <true se o contrato renova automaticamente, senão false>,
    "regua": {
      "multaPct": <percentual da multa por atraso, ex: 2>,
      "jurosMoraMesPct": <percentual de juros de mora ao mês, ex: 1>,
      "indexador": <código do índice de correção monetária — um de: "INPC", "IPCA", "IGPM", "IGPDI", "SELIC", "TJSP" — ou null>,
      "faixas": [
        { "apartir": <número desta faixa — dias OU meses de atraso conforme a unidade, ex: 11 ou 1>, "unidade": <"dias" ou "meses" — a unidade em que o contrato expressa esta faixa>, "encargoPct": <encargo de cobrança TOTAL acumulado nesta faixa, ex: 10>, "aplicaCorrecao": <true se a partir desta faixa incide correção monetária, senão false>, "rubrica": <nome que o contrato dá a este encargo, ex: "Honorários de cobrança"; null se o contrato não nomear> }
      ]
    },
    "descontoPontualidadePct": <percentual de desconto de pontualidade, se houver, ou null>,
    "carteiraAdquirida": {
      "valor": <valor pago pela compra da carteira de inadimplentes, ou null>,
      "dataCorte": <"YYYY-MM-DD" — data de corte dos débitos comprados, ou null>,
      "dataPagamento": <"YYYY-MM-DD" ou null>
    }
  },
  "confianca": <número de 0 a 1 — sua confiança geral na extração>,
  "observacoes": <string com avisos ao operador (campos ilegíveis, ambiguidades) ou null>
}

ONDE ENCONTRAR CADA DADO:
- taxaAdmPct: cláusula da remuneração da cobradora ("X% do valor bruto das antecipações").
- tarifaBoleto: tarifa cobrada pela emissão de cada boleto.
- regua.faixas: cláusula da forma de cobrança — cada degrau de encargo por atraso. "apartir" + "unidade": se o contrato fala em DIAS de atraso, unidade "dias"; se fala em MESES, unidade "meses" e "apartir" é o número de meses (ex.: "após 1 mês de atraso" → apartir 1, unidade "meses"; "a partir de 11 dias" → apartir 11, unidade "dias"). "encargoPct" é o TOTAL acumulado da faixa (se o contrato diz "10%" e depois "mais 10%", a faixa seguinte tem 20). "aplicaCorrecao" = true a partir da faixa em que o contrato manda incidir correção monetária. "rubrica" = o nome que o contrato dá a esse encargo (ex.: "honorários de cobrança", "encargos de cobrança extrajudicial"); copie o termo do contrato, ou null se não houver.
- regua.indexador: o índice citado no contrato, convertido para o código (ex.: "INPC/IBGE" vira "INPC").
- carteiraAdquirida: cláusula de compra da carteira de inadimplentes (valor único e data de corte dos débitos).
- avisoDenunciaDias: cláusula do prazo do contrato — antecedência mínima para denúncia.

NÃO inclua nada fora do JSON.`;

const PROMPT_PLANILHA = `Você recebe os CABEÇALHOS e algumas LINHAS DE AMOSTRA de uma planilha de um condomínio — uma lista de unidades e seus proprietários/responsáveis. As planilhas vêm de fontes variadas e os nomes das colunas mudam.

Sua tarefa: identificar qual coluna da planilha corresponde a cada campo do sistema. Use o nome do cabeçalho E os valores de amostra (ex.: uma coluna com valores como "123.456.789-00" é CPF, mesmo que o cabeçalho seja estranho ou vazio).

Campos do sistema:
- identificacao: identificação da unidade (ex.: "Apto 101", "Casa 11", "Loja 3")
- bloco: bloco ou torre, quando for uma coluna separada
- fracaoIdeal: fração ideal da unidade
- condominoNome: nome do proprietário ou responsável pela unidade
- condominoCpfCnpj: CPF ou CNPJ do proprietário/responsável
- condominoTelefone: telefone de contato
- condominoEmail: e-mail
- condominoTipo: coluna que indica proprietário, inquilino ou responsável

REGRAS:
- Para cada campo, retorne o NOME EXATO de um dos cabeçalhos fornecidos, ou null se não existir.
- Não invente cabeçalhos — use exatamente os da lista CABEÇALHOS.
- Uma mesma coluna não deve ser usada em dois campos.

Responda APENAS com JSON válido, sem markdown:
{
  "mapeamento": {
    "identificacao": <cabeçalho ou null>,
    "bloco": <cabeçalho ou null>,
    "fracaoIdeal": <cabeçalho ou null>,
    "condominoNome": <cabeçalho ou null>,
    "condominoCpfCnpj": <cabeçalho ou null>,
    "condominoTelefone": <cabeçalho ou null>,
    "condominoEmail": <cabeçalho ou null>,
    "condominoTipo": <cabeçalho ou null>
  },
  "confianca": <número de 0 a 1>,
  "observacoes": <avisos ao operador, ou null>
}

NÃO inclua nada fora do JSON.`;

const PROMPT_PLANILHA_PDF = `Você recebe um PDF com a lista de UNIDADES e CONDÔMINOS de um condomínio (apartamentos, casas ou lojas e seus proprietários/responsáveis). Pode ser uma tabela, uma lista ou um relatório.

Sua tarefa: extrair CADA unidade como uma linha, com os campos abaixo.

Campos de cada linha:
- identificacao: identificação da unidade (ex.: "Apto 101", "Casa 11", "Loja 3", "101"). Se uma linha não tiver identificação, não a inclua.
- bloco: bloco ou torre, se houver
- fracaoIdeal: fração ideal, se houver
- condominoNome: nome do proprietário/responsável
- condominoCpfCnpj: CPF ou CNPJ — APENAS dígitos
- condominoTelefone: telefone com DDD — apenas dígitos
- condominoEmail: e-mail
- condominoTipo: "proprietario", "inquilino" ou "responsavel", se o documento indicar

REGRAS:
- NUNCA invente dados. Campo ausente → null.
- Extraia TODAS as unidades do documento, não pare nas primeiras.
- Não repita a mesma unidade.

Responda APENAS com JSON válido, sem markdown:
{
  "linhas": [
    { "identificacao": <string>, "bloco": <string ou null>, "fracaoIdeal": <string ou null>, "condominoNome": <string ou null>, "condominoCpfCnpj": <só dígitos ou null>, "condominoTelefone": <só dígitos ou null>, "condominoEmail": <string ou null>, "condominoTipo": <string ou null> }
  ],
  "confianca": <número de 0 a 1>,
  "observacoes": <avisos ao operador, ou null>
}

NÃO inclua nada fora do JSON.`;

const PROMPT_VALORES = `Você recebe os CABEÇALHOS e algumas LINHAS DE AMOSTRA de uma planilha enviada pela administradora de um condomínio — a lista de unidades e o valor a cobrar de cada uma na competência (mês) atual.

Sua tarefa: identificar qual coluna da planilha corresponde a cada campo do sistema. Use o nome do cabeçalho E os valores de amostra.

Campos do sistema:
- identificacao: a identificação da unidade (ex.: "Apto 101", "Casa 11", "Loja 3", "101")
- bloco: bloco ou torre, quando for uma coluna separada
- valor: o valor em dinheiro a cobrar da unidade na competência (a cota / contribuição). Escolha a coluna do TOTAL a cobrar de cada unidade (ex.: "Valor", "Total", "Cota", "Contribuição", "A pagar"). Se houver várias colunas de valor, prefira a do total.

REGRAS:
- Para cada campo, retorne o NOME EXATO de um dos cabeçalhos fornecidos, ou null se não existir.
- Não invente cabeçalhos — use exatamente os da lista CABEÇALHOS.
- Uma mesma coluna não deve ser usada em dois campos.

Responda APENAS com JSON válido, sem markdown:
{
  "mapeamento": {
    "identificacao": <cabeçalho ou null>,
    "bloco": <cabeçalho ou null>,
    "valor": <cabeçalho ou null>
  },
  "confianca": <número de 0 a 1>,
  "observacoes": <avisos ao operador, ou null>
}

NÃO inclua nada fora do JSON.`;

const PROMPT_CONCILIAR = `Você recebe a lista de UNIDADES CADASTRADAS de um condomínio e a lista de UNIDADES DA PLANILHA enviada pela administradora. Os rótulos das unidades podem divergir entre as duas listas (ex.: "AP 101" e "Apartamento 101"; "101-A" e "101 Bloco A"; "101" e "Unidade 101").

Sua tarefa: para cada unidade da planilha, identificar qual unidade cadastrada é a mesma — comparando a identificação e o bloco/torre.

REGRAS:
- A resposta "matches" é um array POSICIONAL: um item para cada UNIDADE DA PLANILHA, na MESMA ORDEM e com o MESMO tamanho da lista recebida.
- Cada item é o "id" da unidade cadastrada correspondente, ou null se nenhuma corresponder com segurança.
- Não invente ids — use exatamente os "id" da lista UNIDADES CADASTRADAS.
- Um mesmo id não deve ser usado para duas unidades da planilha diferentes.
- Considere "101", "Apto 101", "AP-101", "Unidade 101" como a mesma unidade. Leve o bloco/torre em conta quando houver.

Responda APENAS com JSON válido, sem markdown:
{
  "matches": [ <id da unidade cadastrada ou null>, ... ],
  "confianca": <número de 0 a 1>,
  "observacoes": <avisos ao operador, ou null>
}

NÃO inclua nada fora do JSON.`;

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Max-Age': '86400',
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

// Chama o Gemini com as "parts" informadas; devolve o JSON já parseado.
async function chamarGemini(parts, env) {
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: 65536, thinkingConfig: { thinkingBudget: 0 } },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data && data.error && data.error.message ? data.error.message : 'Erro no Gemini');
  }
  const text = (((data.candidates || [])[0] || {}).content || {}).parts;
  const raw = text && text[0] ? text[0].text : '';
  try {
    return JSON.parse(raw);
  } catch (_) {
    throw new Error('A IA não retornou um JSON válido.');
  }
}

// =============================================================
// Autenticação — verifica o ID token do Firebase do usuário logado.
// =============================================================
const FIREBASE_JWK_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

let _firebaseKeys = null; // { mapa: {kid: CryptoKey}, exp }

function b64urlDecode(str) {
  let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

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

// Verifica um ID token do Firebase. Retorna { uid, email } ou lança.
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

  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key,
    b64urlDecode(partes[2]),
    new TextEncoder().encode(partes[0] + '.' + partes[1]),
  );
  if (!ok) throw new Error('assinatura inválida');

  const agora = Math.floor(Date.now() / 1000);
  if (payload.aud !== FIREBASE_PROJECT_ID) throw new Error('token de outro projeto');
  if (payload.iss !== 'https://securetoken.google.com/' + FIREBASE_PROJECT_ID) {
    throw new Error('emissor inválido');
  }
  if (!payload.sub) throw new Error('token sem usuário');
  if (!payload.exp || payload.exp <= agora) throw new Error('token expirado');

  return { uid: payload.sub, email: payload.email || '' };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405, origin);
    }
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return json({ error: 'Origin not allowed' }, 403, origin);
    }
    if (!env.GEMINI_API_KEY) {
      return json({ error: 'GEMINI_API_KEY não configurada no Worker' }, 500, origin);
    }

    let payload;
    try {
      payload = await request.json();
    } catch (e) {
      return json({ error: 'JSON inválido no corpo da requisição' }, 400, origin);
    }

    // Exige um login Firebase válido (idToken no corpo).
    try {
      await verificarIdToken(payload.idToken);
    } catch (e) {
      return json({ error: 'Acesso negado: ' + ((e && e.message) || e) }, 401, origin);
    }

    try {
      let parts;

      if (payload.modo === 'planilha') {
        const { cabecalhos, amostras } = payload;
        if (!Array.isArray(cabecalhos) || !cabecalhos.length) {
          return json({ error: 'Faltam os cabeçalhos da planilha' }, 400, origin);
        }
        const texto = PROMPT_PLANILHA +
          '\n\nCABEÇALHOS:\n' + JSON.stringify(cabecalhos) +
          '\n\nLINHAS DE AMOSTRA:\n' + JSON.stringify(amostras || []);
        parts = [{ text: texto }];
      } else if (payload.modo === 'valores') {
        const { cabecalhos, amostras } = payload;
        if (!Array.isArray(cabecalhos) || !cabecalhos.length) {
          return json({ error: 'Faltam os cabeçalhos da planilha' }, 400, origin);
        }
        const texto = PROMPT_VALORES +
          '\n\nCABEÇALHOS:\n' + JSON.stringify(cabecalhos) +
          '\n\nLINHAS DE AMOSTRA:\n' + JSON.stringify(amostras || []);
        parts = [{ text: texto }];
      } else if (payload.modo === 'conciliar-unidades') {
        const { unidades, planilha } = payload;
        if (!Array.isArray(unidades) || !Array.isArray(planilha)) {
          return json({ error: 'Faltam as listas de unidades' }, 400, origin);
        }
        const texto = PROMPT_CONCILIAR +
          '\n\nUNIDADES CADASTRADAS:\n' + JSON.stringify(unidades) +
          '\n\nUNIDADES DA PLANILHA:\n' + JSON.stringify(planilha);
        parts = [{ text: texto }];
      } else if (payload.modo === 'planilha-pdf') {
        const { fileBase64, mimeType } = payload;
        if (!fileBase64 || !mimeType) {
          return json({ error: 'Faltam campos: fileBase64, mimeType' }, 400, origin);
        }
        if ((fileBase64.length * 3) / 4 > MAX_BYTES) {
          return json({ error: `Arquivo excede ${(MAX_BYTES / 1024 / 1024).toFixed(0)}MB` }, 413, origin);
        }
        parts = [
          { text: PROMPT_PLANILHA_PDF },
          { inline_data: { mime_type: mimeType, data: fileBase64 } },
        ];
      } else {
        const { fileBase64, mimeType } = payload;
        if (!fileBase64 || !mimeType) {
          return json({ error: 'Faltam campos: fileBase64, mimeType' }, 400, origin);
        }
        if ((fileBase64.length * 3) / 4 > MAX_BYTES) {
          return json({ error: `Arquivo excede ${(MAX_BYTES / 1024 / 1024).toFixed(0)}MB` }, 413, origin);
        }
        parts = [
          { text: PROMPT_CONTRATO },
          { inline_data: { mime_type: mimeType, data: fileBase64 } },
        ];
      }

      const data = await chamarGemini(parts, env);
      return json({ success: true, data }, 200, origin);
    } catch (err) {
      return json({ error: (err && err.message) || 'Falha ao processar' }, 500, origin);
    }
  },
};
