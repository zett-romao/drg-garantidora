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

// Status de boleto que NÃO entram na cobrança (pago, estornado ou cancelado).
const COB_STATUS_FORA = ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH', 'REFUNDED', 'REFUND_REQUESTED', 'CANCELADO'];

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

// Soma N meses a uma data ISO pelo calendário real, clampando o dia
// (31/01 + 1 mês = 28/02). Assim a régua trata meses de 28/29/30/31 sozinha.
function somarMeses(iso, n) {
  const p = String(iso || '').split('-').map(Number); // [aaaa, mm, dd]
  if (p.length < 3) return iso;
  const d = new Date(Date.UTC(p[0], (p[1] - 1) + n, 1));
  const ultimo = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(p[2], ultimo));
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${mm}-${dd}`;
}

// Dias de atraso que uma faixa exige, para um boleto com este vencimento.
// 'dias' → o próprio número; 'meses' → dias reais até vencimento + N meses.
function faixaLimiteDias(faixa, vencimento) {
  const a = faixaApartir(faixa);
  if (a.num == null) return null;
  if (a.unidade === 'meses') return diasEntreDatas(vencimento, somarMeses(vencimento, a.num));
  return a.num;
}

// Faixa de encargo aplicável: a de maior limiar que o atraso já atingiu.
function faixaDaRegua(regua, vencimento, dataRef) {
  const diasAtraso = diasEntreDatas(vencimento, dataRef);
  const faixas = ((regua && regua.faixas) || [])
    .map((f) => ({ faixa: f, limite: faixaLimiteDias(f, vencimento) }))
    .filter((x) => x.limite != null)
    .sort((a, b) => a.limite - b.limite);
  let aplicavel = null;
  faixas.forEach((x) => { if (diasAtraso >= x.limite) aplicavel = x.faixa; });
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

  const faixa = faixaDaRegua(regua, vencimento, dataRef);
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
    .filter((f) => f && faixaApartir(f).num != null)
    .map((f) => {
      const a = faixaApartir(f);
      return `${a.num}${a.unidade === 'meses' ? 'm' : 'd'}→${f.encargoPct != null ? f.encargoPct : 0}%${f.aplicaCorrecao ? ' +correção' : ''}`;
    })
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
      const condominio = snapCond.exists ? snapCond.data() : {};
      const regua = condominio.regua || {};
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

      cobCtx = { cid, condominio, regua, boletos, unidadePorId, condominoPorId, serieIndice, indiceErro };
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
    const rubricaTxt = (calc.faixaAplicada && calc.faixaAplicada.rubrica)
      ? ` (${calc.faixaAplicada.rubrica})` : '';
    const detalhe = `+ multa ${fmtMoeda(calc.multa)} · juros ${fmtMoeda(calc.juros)} · encargo ${fmtMoeda(calc.encargo)}${rubricaTxt}` + correcaoTxt;
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
      <td class="acoes"><button class="btn btn-secondary btn-sm" onclick="gerarDemonstrativo('${b._id}')">Demonstrativo</button></td>
    </tr>`;
  }).join('');

  alvo.innerHTML = `
    <div class="tabela-wrap" style="max-height:460px;overflow-y:auto;">
      <table class="tabela">
        <thead><tr>
          <th>Unidade</th><th>Condômino</th><th>Vencimento</th>
          <th>Atraso</th><th>Valor original</th><th>Valor atualizado</th><th>Ações</th>
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
// Demonstrativo de débito imprimível — abre numa nova janela.
// Itemiza cota + multa + juros + encargo (com a rubrica) + correção.
// -------------------------------------------------------------
function gerarDemonstrativo(boletoId) {
  const ctx = cobCtx;
  if (!ctx) return;
  const b = ctx.boletos.find((x) => x._id === boletoId);
  if (!b) return;
  const dataRef = (document.getElementById('cob-data') || {}).value || hojeISO();
  const calc = calcularReguaCobranca(b.valor, b.vencimento, ctx.regua, dataRef, ctx.serieIndice);
  const uni = ctx.unidadePorId[b.unidadeId] || {};
  const cond = ctx.condominoPorId[b.condominoId] || {};
  const cdm = ctx.condominio || {};
  const regua = ctx.regua || {};

  const linha = (desc, valor) =>
    `<tr><td>${escapeHtml(desc)}</td><td class="num">${escapeHtml(fmtMoeda(valor))}</td></tr>`;
  const linhas = [linha('Contribuição condominial', calc.valorOriginal)];
  if (calc.multa > 0) {
    linhas.push(linha(`Multa por atraso (${regua.multaPct || 0}%)`, calc.multa));
  }
  if (calc.juros > 0) {
    linhas.push(linha(`Juros de mora (${regua.jurosMoraMesPct || 0}% ao mês · ${calc.diasAtraso} dia(s))`, calc.juros));
  }
  if (calc.encargo > 0) {
    const nome = (calc.faixaAplicada && calc.faixaAplicada.rubrica) || 'Encargo de cobrança';
    linhas.push(linha(`${nome} (${calc.encargoPct}%)`, calc.encargo));
  }
  if (calc.correcao > 0) {
    linhas.push(linha(`Correção monetária (${INDICE_ROTULO[regua.indexador] || regua.indexador || '—'})`, calc.correcao));
  }

  const cnpjTxt = cdm.cnpj ? ' — CNPJ ' + escapeHtml(maskCNPJ(cdm.cnpj)) : '';
  const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<title>Demonstrativo de Débito</title>
<style>
  body{font-family:Arial,Helvetica,sans-serif;color:#1e293b;max-width:720px;margin:24px auto;padding:0 24px;}
  h1{font-size:16px;margin:0 0 4px;color:#334155;letter-spacing:.5px;}
  .topo{border-bottom:2px solid #475569;padding-bottom:10px;margin-bottom:14px;}
  .cdm{font-size:15px;font-weight:bold;}
  .info{margin:3px 0;font-size:13px;}
  table{width:100%;border-collapse:collapse;margin-top:14px;font-size:13px;}
  th,td{padding:8px 6px;border-bottom:1px solid #e2e8f0;text-align:left;}
  th{color:#64748b;font-size:11px;text-transform:uppercase;}
  .num{text-align:right;}
  tr.total td{border-top:2px solid #475569;border-bottom:none;font-weight:bold;font-size:15px;padding-top:10px;}
  .rodape{margin-top:22px;font-size:11px;color:#64748b;line-height:1.5;}
  .btn-print{background:#475569;color:#fff;border:none;padding:9px 16px;border-radius:6px;font-size:13px;cursor:pointer;margin-bottom:18px;}
  @media print{.btn-print{display:none;}body{margin:0;}}
</style></head><body>
<button class="btn-print" onclick="window.print()">Imprimir / Salvar como PDF</button>
<div class="topo">
  <h1>DEMONSTRATIVO DE DÉBITO</h1>
  <div class="cdm">${escapeHtml(cdm.nome || 'Condomínio')}${cnpjTxt}</div>
</div>
<p class="info">Condômino: <strong>${escapeHtml(cond.nome || '—')}</strong></p>
<p class="info">Unidade: <strong>${escapeHtml(uni.identificacao || '—')}</strong></p>
<p class="info">Vencimento original: <strong>${escapeHtml(fmtData(b.vencimento))}</strong> &nbsp;·&nbsp; Atraso: <strong>${calc.diasAtraso} dia(s)</strong></p>
<p class="info">Débito apurado na posição de <strong>${escapeHtml(fmtData(dataRef))}</strong>.</p>
<table>
  <thead><tr><th>Discriminação</th><th class="num">Valor</th></tr></thead>
  <tbody>
    ${linhas.join('')}
    <tr class="total"><td>TOTAL ATUALIZADO</td><td class="num">${escapeHtml(fmtMoeda(calc.total))}</td></tr>
  </tbody>
</table>
<p class="rodape">
  Valores apurados pela régua de cobrança do condomínio — multa, juros de mora e encargos por faixa de atraso${calc.correcao > 0 ? ', com correção monetária' : ''}.<br>
  Documento gerado em ${escapeHtml(fmtData(hojeISO()))} pela plataforma DRG-Garantidora — D.R. Global.
</p>
</body></html>`;

  const w = window.open('', '_blank');
  if (!w) { alert('Não foi possível abrir o demonstrativo — permita pop-ups para este site.'); return; }
  w.document.write(html);
  w.document.close();
}

// -------------------------------------------------------------
SECTION_RENDERERS.cobranca = renderCobranca;
