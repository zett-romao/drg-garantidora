// =============================================================
// DRG-Garantidora — cobranca.js
// Motor da régua de cobrança: calcula o valor atualizado dos boletos
// vencidos (multa + juros de mora + encargo por faixa de atraso) e
// mostra a inadimplência do condomínio na seção "Régua de Cobrança".
// Carregado depois de competencias.js. Usa os helpers globais.
//
// A correção monetária ainda não entra (v1 = 0) — depende do módulo
// de atualização automática dos índices, que vem em seguida.
// =============================================================

window.SECTION_RENDERERS = window.SECTION_RENDERERS || {};

let cobCtx = null; // dados carregados ao abrir a seção

// Status de boleto que NÃO entram na cobrança (pago ou estornado).
const COB_STATUS_FORA = ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH', 'REFUNDED', 'REFUND_REQUESTED'];

// Indexador da régua → código da série no SGS do Banco Central.
// TJSP não tem API; a Tabela Prática do TJSP corrige pelo IPCA (Lei 14.905/24).
const INDICE_SGS = { INPC: 188, IPCA: 433, IGPM: 189, IGPDI: 190, SELIC: 4390, TJSP: 433 };
const INDICE_ROTULO = {
  INPC: 'INPC', IPCA: 'IPCA', IGPM: 'IGP-M', IGPDI: 'IGP-DI', SELIC: 'SELIC', TJSP: 'TJSP (IPCA)',
};

// -------------------------------------------------------------
// Cálculo da régua
// -------------------------------------------------------------
function diasEntreDatas(de, ate) {
  const ms = (s) => {
    const p = String(s || '').split('-').map(Number);
    return Date.UTC(p[0], (p[1] || 1) - 1, p[2] || 1);
  };
  return Math.round((ms(ate) - ms(de)) / 86400000);
}

function hojeISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Converte 'YYYY-MM-DD' para 'dd/MM/aaaa' (formato da API do Banco Central).
function dataParaBR(iso) {
  const p = String(iso || '').split('-');
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : String(iso || '');
}

// Busca a série mensal de um índice no SGS do Banco Central (datas em dd/MM/aaaa).
// Devolve [{ data:'dd/MM/aaaa', valor:'0.81' }, ...] ou null se falhar.
async function buscarSerieBCB(indexador, dataIniBR, dataFimBR) {
  const cod = INDICE_SGS[indexador];
  if (!cod) return null;
  const url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${cod}/dados` +
    `?formato=json&dataInicial=${dataIniBR}&dataFinal=${dataFimBR}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const arr = await r.json();
    return Array.isArray(arr) ? arr : null;
  } catch (_) {
    return null;
  }
}

// Correção monetária: acumula a variação do índice dos meses posteriores ao
// vencimento até o mês da data de referência. serie = [{data:'dd/MM/aaaa',valor}].
function calcularCorrecao(valor, vencimento, dataRef, serie) {
  if (!serie || !serie.length || !vencimento || !dataRef) return 0;
  const v = Number(valor) || 0;
  const pv = String(vencimento).split('-').map(Number);   // [aaaa, mm, dd]
  const pr = String(dataRef).split('-').map(Number);
  const ymVenc = pv[0] * 12 + pv[1];
  const ymRef = pr[0] * 12 + pr[1];
  let fator = 1;
  serie.forEach((it) => {
    const p = String((it && it.data) || '').split('/').map(Number); // [dd, mm, aaaa]
    if (p.length < 3) return;
    const ym = p[2] * 12 + p[1];
    if (ym > ymVenc && ym <= ymRef) {
      const x = parseFloat(String(it.valor).replace(',', '.'));
      if (!isNaN(x)) fator *= (1 + x / 100);
    }
  });
  return Math.round(v * (fator - 1) * 100) / 100;
}

// Faixa de encargo aplicável: a de maior "apartirDias" que já foi atingida.
function faixaDaRegua(regua, diasAtraso) {
  const faixas = ((regua && regua.faixas) || [])
    .filter((f) => f && f.apartirDias != null)
    .slice()
    .sort((a, b) => a.apartirDias - b.apartirDias);
  let aplicavel = null;
  faixas.forEach((f) => { if (diasAtraso >= f.apartirDias) aplicavel = f; });
  return aplicavel;
}

// Valor atualizado de um boleto na data de referência, conforme a régua.
// serieIndice (opcional) — série do Banco Central p/ a correção monetária.
function calcularReguaCobranca(valor, vencimento, regua, dataRef, serieIndice) {
  const v = Number(valor) || 0;
  const r2 = (n) => Math.round(n * 100) / 100;
  regua = regua || {};
  const out = {
    diasAtraso: 0, valorOriginal: v,
    multa: 0, juros: 0, encargo: 0, encargoPct: 0,
    faixaAplicada: null, pedeCorrecao: false, correcao: 0, total: v,
  };
  if (!vencimento || !dataRef) return out;

  out.diasAtraso = diasEntreDatas(vencimento, dataRef);
  if (out.diasAtraso <= 0) return out; // em dia — sem encargos

  out.multa = r2(v * (Number(regua.multaPct) || 0) / 100);
  out.juros = r2(v * (Number(regua.jurosMoraMesPct) || 0) / 100 * (out.diasAtraso / 30));

  const faixa = faixaDaRegua(regua, out.diasAtraso);
  if (faixa) {
    out.faixaAplicada = faixa;
    out.encargoPct = Number(faixa.encargoPct) || 0;
    out.encargo = r2(v * out.encargoPct / 100);
    out.pedeCorrecao = !!faixa.aplicaCorrecao;
  }
  // Correção monetária — só nas faixas que pedem, com a série do índice.
  if (out.pedeCorrecao && serieIndice) {
    out.correcao = calcularCorrecao(v, vencimento, dataRef, serieIndice);
  }

  out.total = r2(v + out.multa + out.juros + out.encargo + out.correcao);
  return out;
}

function cobEmAberto(b) {
  return COB_STATUS_FORA.indexOf(b.status || 'PENDING') === -1;
}

function resumoRegua(regua) {
  const m = regua.multaPct != null ? regua.multaPct : 0;
  const j = regua.jurosMoraMesPct != null ? regua.jurosMoraMesPct : 0;
  const faixasTxt = ((regua.faixas) || [])
    .filter((f) => f && f.apartirDias != null)
    .map((f) => `${f.apartirDias}d→${f.encargoPct != null ? f.encargoPct : 0}%${f.aplicaCorrecao ? ' +correção' : ''}`)
    .join(' · ');
  return `Multa ${m}% · juros ${j}%/mês` + (faixasTxt ? ` · faixas: ${faixasTxt}` : '');
}

// -------------------------------------------------------------
// Seção "Régua de Cobrança"
// -------------------------------------------------------------
function renderCobranca() {
  return renderComContexto(
    'Régua de Cobrança',
    'Inadimplência do condomínio com os valores atualizados pela régua de cobrança.',
    async (cid) => {
      const [snapCond, snapB, snapU, snapC] = await Promise.all([
        refCondominios().doc(cid).get(),
        refSub(cid, 'boletos').get(),
        refSub(cid, 'unidades').get(),
        refSub(cid, 'condominos').get(),
      ]);
      const regua = (snapCond.exists && snapCond.data().regua) || {};
      const unidadePorId = {};
      snapU.docs.forEach((d) => { unidadePorId[d.id] = d.data(); });
      const condominoPorId = {};
      snapC.docs.forEach((d) => { condominoPorId[d.id] = d.data(); });
      const boletos = snapB.docs
        .map((d) => Object.assign({ _id: d.id }, d.data()))
        .filter((b) => b.tipo !== 'honorario' && b.vencimento && cobEmAberto(b));

      // Série do índice no Banco Central — só se a régua tem indexador e
      // alguma faixa pede correção, e há boleto efetivamente vencido.
      let serieIndice = null;
      let indiceErro = false;
      const pedeCorrecao = !!regua.indexador &&
        ((regua.faixas) || []).some((f) => f && f.aplicaCorrecao);
      const vencidos = boletos.filter((b) => b.vencimento < hojeISO());
      if (pedeCorrecao && vencidos.length) {
        let maisAntigo = vencidos[0].vencimento;
        vencidos.forEach((b) => { if (b.vencimento < maisAntigo) maisAntigo = b.vencimento; });
        serieIndice = await buscarSerieBCB(regua.indexador, dataParaBR(maisAntigo), dataParaBR(hojeISO()));
        if (!serieIndice) indiceErro = true;
      }

      cobCtx = { cid, regua, boletos, unidadePorId, condominoPorId, serieIndice, indiceErro };
      renderTelaCobranca();
    },
  );
}

function renderTelaCobranca() {
  const regua = (cobCtx && cobCtx.regua) || {};
  const temRegua = regua.multaPct != null || regua.jurosMoraMesPct != null ||
    (regua.faixas && regua.faixas.length);

  const aviso = temRegua
    ? `<p class="muted" style="font-size:12px;">Régua do condomínio: ${escapeHtml(resumoRegua(regua))}</p>`
    : `<div class="alert alert-warning">Este condomínio ainda não tem régua de cobrança configurada — defina em Cadastros → Condomínios (seção "Régua de cobrança"). Sem ela, os boletos aparecem só com o valor original.</div>`;

  let indiceNota = '';
  if (cobCtx && cobCtx.indiceErro) {
    indiceNota = '<div class="alert alert-warning">Não foi possível buscar os índices no Banco Central agora — a correção monetária está indisponível. Multa, juros e encargo seguem corretos.</div>';
  } else if (cobCtx && cobCtx.serieIndice && regua.indexador) {
    indiceNota = `<p class="muted" style="font-size:12px;">Correção monetária pelo ${escapeHtml(INDICE_ROTULO[regua.indexador] || regua.indexador)} — índices atualizados do Banco Central.</p>`;
  }

  document.getElementById('ctx-conteudo').innerHTML = `
    <div class="card">
      ${aviso}
      ${indiceNota}
      <div class="form-group" style="max-width:220px;margin-top:12px;margin-bottom:4px;">
        <label>Data de referência</label>
        <input type="date" id="cob-data" value="${hojeISO()}" onchange="renderTabelaCobranca()">
      </div>
      <p class="muted" style="font-size:12px;">Simula quanto o débito vale na data escolhida.</p>
      <div id="cob-tabela" style="margin-top:14px;"></div>
    </div>`;
  renderTabelaCobranca();
}

function renderTabelaCobranca() {
  const ctx = cobCtx;
  const alvo = document.getElementById('cob-tabela');
  if (!ctx || !alvo) return;
  const dataRef = (document.getElementById('cob-data') || {}).value || hojeISO();

  const itens = [];
  ctx.boletos.forEach((b) => {
    const calc = calcularReguaCobranca(b.valor, b.vencimento, ctx.regua, dataRef, ctx.serieIndice);
    if (calc.diasAtraso > 0) itens.push({ b, calc });
  });
  itens.sort((a, z) => z.calc.diasAtraso - a.calc.diasAtraso);

  if (!itens.length) {
    alvo.innerHTML = '<div class="empty-state">Nenhum boleto vencido em aberto nesta data de referência.</div>';
    return;
  }

  let totalOriginal = 0;
  let totalAtualizado = 0;
  const linhas = itens.map(({ b, calc }) => {
    totalOriginal += calc.valorOriginal;
    totalAtualizado += calc.total;
    const uni = ctx.unidadePorId[b.unidadeId] || {};
    const cond = ctx.condominoPorId[b.condominoId] || {};
    const correcaoTxt = !calc.pedeCorrecao ? ''
      : (ctx.serieIndice ? ` · correção ${fmtMoeda(calc.correcao)}` : ' · correção indisponível');
    const detalhe = `+ multa ${fmtMoeda(calc.multa)} · juros ${fmtMoeda(calc.juros)} · encargo ${fmtMoeda(calc.encargo)}` +
      (calc.faixaAplicada ? ` (faixa ${calc.faixaAplicada.apartirDias}d)` : '') + correcaoTxt;
    return `<tr>
      <td>${escapeHtml(uni.identificacao || '—')}</td>
      <td>${escapeHtml(cond.nome || '—')}</td>
      <td>${escapeHtml(fmtData(b.vencimento))}</td>
      <td>${calc.diasAtraso} dia(s)</td>
      <td class="col-num">${escapeHtml(fmtMoeda(calc.valorOriginal))}</td>
      <td class="col-num">
        <strong>${escapeHtml(fmtMoeda(calc.total))}</strong>
        <div class="muted" style="font-size:11px;">${escapeHtml(detalhe)}</div>
      </td>
    </tr>`;
  }).join('');

  alvo.innerHTML = `
    <div class="tabela-wrap" style="max-height:460px;overflow-y:auto;">
      <table class="tabela">
        <thead><tr>
          <th>Unidade</th><th>Condômino</th><th>Vencimento</th>
          <th>Atraso</th><th>Valor original</th><th>Valor atualizado</th>
        </tr></thead>
        <tbody>${linhas}</tbody>
      </table>
    </div>
    <p style="margin-top:12px;">
      ${itens.length} boleto(s) vencido(s) · original <strong>${escapeHtml(fmtMoeda(totalOriginal))}</strong>
      · atualizado <strong>${escapeHtml(fmtMoeda(totalAtualizado))}</strong>
    </p>`;
}

// -------------------------------------------------------------
SECTION_RENDERERS.cobranca = renderCobranca;
