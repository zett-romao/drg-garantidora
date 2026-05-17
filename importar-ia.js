// =============================================================
// DRG-Garantidora — importar-ia.js
// Módulo: importar contrato em PDF via IA (Gemini) e auto-criar
// o condomínio + o contrato. Carregado depois de cadastros.js.
// =============================================================

window.SECTION_RENDERERS = window.SECTION_RENDERERS || {};

// URL do Cloudflare Worker que faz a ponte com o Gemini.
const WORKER_GEMINI_URL = 'https://drg-garantidora-gemini.zett-romao.workers.dev';
const IA_MAX_MB = 15;

let iaResultado = null; // último JSON extraído pela IA

// -------------------------------------------------------------
// Helpers
// -------------------------------------------------------------
function iaStatus(msg, tipo) {
  const el = $('ia-status');
  if (!el) return;
  if (!msg) { el.innerHTML = ''; return; }
  const cls = tipo === 'erro' ? 'alert-error' : tipo === 'ok' ? 'alert-success' : 'alert-info';
  el.innerHTML = `<div class="alert ${cls}">${escapeHtml(msg)}</div>`;
}

function lerArquivoBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const r = String(reader.result || '');
      const virg = r.indexOf(',');
      resolve(virg >= 0 ? r.slice(virg + 1) : r);
    };
    reader.onerror = () => reject(new Error('não foi possível ler o arquivo'));
    reader.readAsDataURL(file);
  });
}

function iaNumInput(id, val) {
  return `<input type="number" step="0.01" id="${id}" value="${val == null ? '' : val}">`;
}
function iaDateInput(id, val) {
  return `<input type="date" id="${id}" value="${val == null ? '' : escapeHtml(val)}">`;
}

// -------------------------------------------------------------
// 1. Tela de upload
// -------------------------------------------------------------
function renderImportarIA() {
  iaResultado = null;
  $('content').innerHTML = `
    <div class="section-head">
      <div>
        <h2>Importar contrato (IA)</h2>
        <p>Suba o PDF do contrato assinado — a IA extrai os dados e monta o condomínio e o contrato pra você conferir.</p>
      </div>
    </div>
    <div class="card">
      <h3>Contrato em PDF</h3>
      <p class="muted" style="margin-bottom:14px;">
        Selecione o arquivo do contrato de cobrança garantida (PDF, até ${IA_MAX_MB} MB).
      </p>
      <div class="form-group">
        <input type="file" id="ia-arquivo" accept="application/pdf,.pdf">
      </div>
      <button class="btn btn-primary" id="ia-btn" onclick="analisarContratoIA()">Analisar com IA</button>
      <div id="ia-status" style="margin-top:16px;"></div>
    </div>`;
}

// -------------------------------------------------------------
// 2. Análise — envia o PDF ao Worker/Gemini
// -------------------------------------------------------------
async function analisarContratoIA() {
  const input = $('ia-arquivo');
  const file = input && input.files && input.files[0];
  if (!file) { iaStatus('Selecione um arquivo PDF primeiro.', 'erro'); return; }

  const ehPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  if (!ehPdf) { iaStatus('O arquivo precisa ser um PDF.', 'erro'); return; }
  if (file.size > IA_MAX_MB * 1024 * 1024) {
    iaStatus(`O arquivo tem ${(file.size / 1024 / 1024).toFixed(1)} MB — o limite é ${IA_MAX_MB} MB.`, 'erro');
    return;
  }

  const btn = $('ia-btn');
  btn.disabled = true;
  btn.textContent = 'Analisando…';
  iaStatus('A IA está lendo o contrato. Isso leva de 20 a 60 segundos — não feche a página.', 'info');

  try {
    const fileBase64 = await lerArquivoBase64(file);
    const res = await fetch(WORKER_GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileBase64, mimeType: 'application/pdf' }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.success) {
      throw new Error(json.error || `erro ${res.status} na análise`);
    }
    iaResultado = json.data || {};
    renderRevisaoIA(iaResultado);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Analisar com IA';
    iaStatus('Falha na análise: ' + (err.message || err) + '. Tente novamente.', 'erro');
  }
}

// -------------------------------------------------------------
// 3. Revisão — formulário pré-preenchido pela IA
// -------------------------------------------------------------
function renderRevisaoIA(d) {
  const c = d.condominio || {};
  const e = c.endereco || {};
  const s = c.sindico || {};
  const ct = d.contrato || {};
  const r = ct.regua || {};
  const ca = ct.carteiraAdquirida || {};
  const optsIndexador = INDEXADORES.map((x) =>
    `<option value="${x.id}" ${(r.indexador || 'INPC') === x.id ? 'selected' : ''}>${escapeHtml(x.label)}</option>`
  ).join('');
  const faixasIniciais = (r.faixas && r.faixas.length) ? r.faixas : FAIXAS_PADRAO;

  const confPct = d.confianca != null ? Math.round(d.confianca * 100) : null;
  let nota = '';
  if (confPct != null || d.observacoes) {
    const cls = confPct != null && confPct < 70 ? 'alert-warning' : 'alert-info';
    const partes = [];
    if (confPct != null) partes.push(`Confiança da IA: <strong>${confPct}%</strong>`);
    if (d.observacoes) partes.push(escapeHtml(d.observacoes));
    nota = `<div class="alert ${cls}">${partes.join(' — ')}</div>`;
  }

  $('content').innerHTML = `
    <div class="section-head">
      <div>
        <h2>Conferir dados extraídos</h2>
        <p>Revise e ajuste o que precisar. Campos em branco a IA não encontrou no contrato.</p>
      </div>
    </div>
    ${nota}
    <div class="card">
      <h3>Condomínio</h3>
      <div class="form-row">
        ${campo('Nome', inputTexto('ia-nome', c.nome), true)}
        ${campo('CNPJ', inputTexto('ia-cnpj', c.cnpj ? maskCNPJ(c.cnpj) : '', 'oninput="this.value=maskCNPJ(this.value)"'))}
      </div>
      <div class="form-row">
        ${campo('Logradouro', inputTexto('ia-logradouro', e.logradouro))}
        ${campo('Número', inputTexto('ia-numero', e.numero))}
      </div>
      <div class="form-row">
        ${campo('Complemento', inputTexto('ia-complemento', e.complemento))}
        ${campo('Bairro', inputTexto('ia-bairro', e.bairro))}
      </div>
      <div class="form-row-3">
        ${campo('Cidade', inputTexto('ia-cidade', e.cidade))}
        ${campo('UF', inputTexto('ia-uf', e.uf, 'maxlength="2" style="text-transform:uppercase"'))}
        ${campo('CEP', inputTexto('ia-cep', e.cep ? maskCEP(e.cep) : '', 'oninput="this.value=maskCEP(this.value)"'))}
      </div>
      ${separadorForm('Síndico')}
      <div class="form-row">
        ${campo('Nome do síndico', inputTexto('ia-sind-nome', s.nome))}
        ${campo('CPF', inputTexto('ia-sind-cpf', s.cpf ? maskCPF(s.cpf) : '', 'oninput="this.value=maskCPF(this.value)"'))}
      </div>
      <div class="form-row">
        ${campo('Telefone', inputTexto('ia-sind-tel', s.telefone ? maskTelefone(s.telefone) : '', 'oninput="this.value=maskTelefone(this.value)"'))}
        ${campo('E-mail', inputTexto('ia-sind-email', s.email))}
      </div>
      ${separadorForm('Régua de cobrança')}
      <p class="muted" style="font-size:12px;margin-bottom:10px;">Regras do boleto vencido do condômino — multa/juros (da convenção) e os encargos por atraso (do contrato). Ficam no condomínio, não no contrato.</p>
      <div class="form-row-3">
        ${campo('Multa (%)', iaNumInput('ia-multa', r.multaPct))}
        ${campo('Juros de mora (% a.m.)', iaNumInput('ia-juros', r.jurosMoraMesPct))}
        ${campo('Desconto pontualidade (%)', iaNumInput('ia-desconto', ct.descontoPontualidadePct))}
      </div>
      ${campo('Indexador de correção monetária', `<select id="ia-indexador">${optsIndexador}</select>`)}
      <label style="display:block;font-size:13px;font-weight:600;color:var(--text);margin:6px 0 4px;">Faixas de encargos por atraso</label>
      <p class="muted" style="font-size:12px;margin-bottom:10px;">A partir de quantos dias de atraso, o encargo total e se aplica correção.</p>
      <div id="ia-faixas"></div>
      <button type="button" class="btn btn-secondary btn-sm" onclick="faixaAdd('ia-faixas')" style="margin-bottom:6px;">+ Adicionar faixa</button>
    </div>
    <div class="card">
      <h3>Contrato</h3>
      ${campo('Número do contrato', inputTexto('ia-numero-contrato', ct.numero || (new Date().getFullYear() + '/001')))}
      <div class="form-row">
        ${campo('Taxa de administração (%)', iaNumInput('ia-taxa', ct.taxaAdmPct))}
        ${campo('Tarifa por boleto (R$)', iaNumInput('ia-tarifa', ct.tarifaBoleto))}
      </div>
      <div class="form-row">
        ${campo('Início da vigência', iaDateInput('ia-vig-inicio', ct.vigenciaInicio))}
        ${campo('Fim da vigência', iaDateInput('ia-vig-fim', ct.vigenciaFim))}
      </div>
      <div class="form-row">
        ${campo('Prazo (meses)', iaNumInput('ia-prazo', ct.prazoMeses))}
        ${campo('Aviso de denúncia (dias)', iaNumInput('ia-aviso', ct.avisoDenunciaDias))}
      </div>
      <label class="check-linha"><input type="checkbox" id="ia-renovacao" ${ct.renovacaoAuto === false ? '' : 'checked'}> Renovação automática</label>
      ${separadorForm('Carteira de inadimplentes adquirida')}
      <div class="form-row-3">
        ${campo('Valor pago (R$)', iaNumInput('ia-cart-valor', ca.valor))}
        ${campo('Data de corte', iaDateInput('ia-cart-corte', ca.dataCorte))}
        ${campo('Data do pagamento', iaDateInput('ia-cart-pgto', ca.dataPagamento))}
      </div>
    </div>
    <div class="card">
      <div id="ia-status" style="margin-bottom:12px;"></div>
      <div style="display:flex;gap:10px;justify-content:flex-end;">
        <button class="btn btn-secondary" onclick="renderImportarIA()">Recomeçar</button>
        <button class="btn btn-success" id="ia-btn-criar" onclick="confirmarCriacaoIA()">Criar condomínio e contrato</button>
      </div>
    </div>`;
  faixasRender('ia-faixas', faixasIniciais);
}

// -------------------------------------------------------------
// 4. Criação — grava o condomínio e o contrato no Firestore
// -------------------------------------------------------------
async function confirmarCriacaoIA() {
  const nome = valId('ia-nome');
  if (!nome) { iaStatus('O condomínio precisa de um nome.', 'erro'); return; }

  const cnpj = soDigitos(valId('ia-cnpj'));
  if (cnpj && !isCNPJValid(cnpj)) { iaStatus('CNPJ inválido — corrija ou apague o campo.', 'erro'); return; }
  const sindCpf = soDigitos(valId('ia-sind-cpf'));
  if (sindCpf && !isCPFValid(sindCpf)) { iaStatus('CPF do síndico inválido — corrija ou apague.', 'erro'); return; }

  const vIni = valId('ia-vig-inicio');
  const vFim = valId('ia-vig-fim');
  if (vIni && vFim && vFim < vIni) { iaStatus('O fim da vigência é anterior ao início.', 'erro'); return; }

  const condominio = {
    nome,
    cnpj,
    endereco: {
      logradouro: valId('ia-logradouro'),
      numero: valId('ia-numero'),
      complemento: valId('ia-complemento'),
      bairro: valId('ia-bairro'),
      cidade: valId('ia-cidade'),
      uf: valId('ia-uf').toUpperCase(),
      cep: soDigitos(valId('ia-cep')),
    },
    sindico: {
      nome: valId('ia-sind-nome'),
      cpf: sindCpf,
      telefone: soDigitos(valId('ia-sind-tel')),
      email: valId('ia-sind-email'),
    },
    descontoPontualidadePct: valNum('ia-desconto', null),
    regua: {
      multaPct: valNum('ia-multa', null),
      jurosMoraMesPct: valNum('ia-juros', null),
      indexador: valId('ia-indexador') || 'INPC',
      faixas: faixasLer('ia-faixas')
        .filter((f) => f.apartirDias != null && f.encargoPct != null)
        .sort((a, b) => a.apartirDias - b.apartirDias),
    },
    ativo: true,
  };

  const contrato = {
    numero: valId('ia-numero-contrato'),
    status: 'ativo',
    taxaAdmPct: valNum('ia-taxa', 0),
    tarifaBoleto: valNum('ia-tarifa', 0),
    vigenciaInicio: vIni || null,
    vigenciaFim: vFim || null,
    prazoMeses: valNum('ia-prazo', null),
    avisoDenunciaDias: valNum('ia-aviso', null),
    renovacaoAuto: valCheck('ia-renovacao'),
    carteiraAdquirida: {
      valor: valNum('ia-cart-valor', null),
      dataCorte: valId('ia-cart-corte') || null,
      dataPagamento: valId('ia-cart-pgto') || null,
    },
    origem: 'importacao-ia',
  };

  const btn = $('ia-btn-criar');
  btn.disabled = true;
  btn.textContent = 'Criando…';
  try {
    const ref = await refCondominios().add(Object.assign(condominio, carimboCriacao()));
    if (!contrato.numero) contrato.numero = await proximoNumeroContrato(ref.id);
    await refSub(ref.id, 'contratos').add(Object.assign(contrato, carimboCriacao()));

    $('content').innerHTML = `
      <div class="card">
        <div class="placeholder-section">
          <h3>Condomínio criado</h3>
          <p>“${escapeHtml(nome)}” foi cadastrado, com o contrato extraído do PDF.</p>
          <div style="margin-top:16px;display:flex;gap:10px;justify-content:center;">
            <button class="btn btn-secondary" onclick="renderImportarIA()">Importar outro contrato</button>
            <button class="btn btn-primary" onclick="gerenciarCondominio('${ref.id}')">Abrir o condomínio</button>
          </div>
        </div>
      </div>`;
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Criar condomínio e contrato';
    iaStatus('Falha ao criar: ' + (err.message || err), 'erro');
  }
}

// -------------------------------------------------------------
SECTION_RENDERERS.importarIA = renderImportarIA;
