// =============================================================
// DRG-Garantidora — acordos.js
// Acordos de pagamento com inadimplentes: extrajudicial ou judicial
// (com nº do processo e tribunal) e as parcelas negociadas.
// Carregado depois de cadastros.js. Usa os helpers globais.
// =============================================================

window.SECTION_RENDERERS = window.SECTION_RENDERERS || {};

let acCtx = null; // { cid, condominos, unidades, acordos }

const AC_SITUACOES = { ativo: 'Ativo', quitado: 'Quitado', rompido: 'Rompido' };

function acHojeISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// "Nome do condômino — Unidade", a partir do contexto carregado.
function acRotuloCondomino(condId) {
  const c = (acCtx && acCtx.condominos[condId]) || {};
  const uni = (c.unidadeId && acCtx && acCtx.unidades[c.unidadeId]) || null;
  return (c.nome || '—') + (uni ? ` — ${uni.identificacao || ''}` : '');
}

function acBadgeTipo(tipo) {
  return tipo === 'judicial'
    ? '<span class="badge badge-warning">Judicial</span>'
    : '<span class="badge badge-info">Extrajudicial</span>';
}

function acBadgeSituacao(s) {
  const cls = s === 'quitado' ? 'badge-success' : s === 'rompido' ? 'badge-danger' : 'badge-info';
  return `<span class="badge ${cls}">${escapeHtml(AC_SITUACOES[s] || 'Ativo')}</span>`;
}

function acTotalParcelas(parcelas) {
  return (parcelas || []).reduce((s, p) => s + (Number(p.valor) || 0), 0);
}

// Quantos dias antes do fim do lote atual o sistema avisa p/ emitir o próximo.
const ACORDO_AVISO_DIAS = 20;

// Situação dos lotes de um acordo: total acordado, parcelas já geradas, quantas
// faltam e se está na hora de emitir o próximo lote (faltam ≤ 20 dias).
function acordoStatusLote(a) {
  a = a || {};
  const geradas = (a.parcelas || []).length;
  const total = Number(a.numeroParcelas) > 0 ? Number(a.numeroParcelas) : geradas;
  const faltam = Math.max(0, total - geradas);
  let ultimaVenc = '';
  (a.parcelas || []).forEach((p) => {
    if (p && p.vencimento && p.vencimento > ultimaVenc) ultimaVenc = p.vencimento;
  });
  const diasAteUltima = ultimaVenc ? diasEntreDatas(acHojeISO(), ultimaVenc) : null;
  const ativo = (a.situacao || 'ativo') === 'ativo';
  const precisaEmitir = ativo && faltam > 0 &&
    diasAteUltima != null && diasAteUltima <= ACORDO_AVISO_DIAS;
  return { total, geradas, faltam, ultimaVenc, diasAteUltima, precisaEmitir };
}

// -------------------------------------------------------------
// Lista de acordos
// -------------------------------------------------------------
function renderAcordos() {
  return renderComContexto(
    'Acordos',
    'Acordos de pagamento com inadimplentes — extrajudiciais e judiciais.',
    async (cid) => {
      const [snapA, snapC, snapU] = await Promise.all([
        refSub(cid, 'acordos').get(),
        refSub(cid, 'condominos').get(),
        refSub(cid, 'unidades').get(),
      ]);
      const condominos = {};
      snapC.docs.forEach((d) => { condominos[d.id] = d.data(); });
      const unidades = {};
      snapU.docs.forEach((d) => { unidades[d.id] = d.data(); });
      const acordos = snapA.docs.map((d) => Object.assign({ _id: d.id }, d.data()));
      acCtx = { cid, condominos, unidades, acordos };
      renderTelaAcordos();
    },
  );
}

function renderTelaAcordos() {
  const ctx = acCtx;
  const linhas = ctx.acordos
    .slice()
    .sort((a, z) => String(z.dataAcordo || '').localeCompare(String(a.dataAcordo || '')))
    .map((a) => {
      const st = acordoStatusLote(a);
      const proc = (a.tipo === 'judicial' && a.numeroProcesso)
        ? `<div class="muted" style="font-size:11px;">Proc. ${escapeHtml(a.numeroProcesso)}${a.tribunal ? ' · ' + escapeHtml(a.tribunal) : ''}</div>`
        : '';
      const acoes = podeEditar('acordos')
        ? `<button class="btn btn-secondary btn-sm" onclick="abrirFormAcordo('${a._id}')">Editar</button>
           <button class="btn btn-danger btn-sm" onclick="excluirAcordo('${a._id}')">Excluir</button>`
        : '';
      const parcTxt = st.total > st.geradas ? `${st.geradas}/${st.total} parc.` : `${st.geradas} parc.`;
      const avisoLote = st.precisaEmitir
        ? '<div style="margin-top:3px;"><span class="badge badge-warning">Emitir próximo lote</span></div>'
        : '';
      return `<tr>
        <td>${escapeHtml(acRotuloCondomino(a.condominoId))}</td>
        <td>${acBadgeTipo(a.tipo)}${proc}</td>
        <td>${escapeHtml(fmtData(a.dataAcordo))}</td>
        <td class="col-num">${parcTxt} · ${escapeHtml(fmtMoeda(acTotalParcelas(a.parcelas)))}${avisoLote}</td>
        <td>${acBadgeSituacao(a.situacao)}</td>
        <td class="acoes">${acoes}</td>
      </tr>`;
    }).join('');

  const tabela = ctx.acordos.length
    ? `<div class="tabela-wrap"><table class="tabela">
         <thead><tr><th>Condômino</th><th>Tipo</th><th>Data</th><th>Parcelas</th><th>Situação</th><th>Ações</th></tr></thead>
         <tbody>${linhas}</tbody></table></div>`
    : '<div class="empty-state">Nenhum acordo registrado.</div>';

  const precisam = ctx.acordos.filter((a) => acordoStatusLote(a).precisaEmitir);
  const cardAviso = precisam.length
    ? `<div class="card" style="border-left:3px solid var(--warning,#C2410C);">
         <h3 style="margin-top:0;">Parcelas remanescentes a emitir</h3>
         <p class="muted" style="font-size:13px;">${precisam.length} acordo(s) com o lote atual perto do fim — abra o acordo, gere o próximo lote (já corrigido) e emita as parcelas:</p>
         <ul style="margin:6px 0 0;padding-left:18px;font-size:13px;">
           ${precisam.map((a) => {
             const st = acordoStatusLote(a);
             return `<li><strong>${escapeHtml(acRotuloCondomino(a.condominoId))}</strong> — faltam ${st.faltam} de ${st.total} parcela(s); última gerada vence ${escapeHtml(fmtData(st.ultimaVenc))}</li>`;
           }).join('')}
         </ul>
       </div>`
    : '';

  const acEdit = podeEditar('acordos')
    ? '<button class="btn btn-primary" onclick="abrirFormAcordo()">+ Novo acordo</button>'
    : '';
  const novo = `<div style="display:flex;gap:10px;justify-content:flex-end;margin-bottom:12px;">
       <button class="btn btn-secondary" onclick="relatorioAcordos()">Relatório</button>${acEdit}
     </div>`;
  document.getElementById('ctx-conteudo').innerHTML = `${novo}${cardAviso}<div class="card">${tabela}</div>`;
}

// -------------------------------------------------------------
// Formulário de acordo
// -------------------------------------------------------------
function abrirFormAcordo(id) {
  const ctx = acCtx;
  if (!ctx) return;
  const a = id ? (ctx.acordos.find((x) => x._id === id) || {}) : {};
  const sel = (v, atual) => (v === atual ? ' selected' : '');

  const optsCond = Object.keys(ctx.condominos)
    .sort((x, z) => String((ctx.condominos[x] || {}).nome || '')
      .localeCompare(String((ctx.condominos[z] || {}).nome || ''), 'pt-BR'))
    .map((cid) => `<option value="${cid}"${a.condominoId === cid ? ' selected' : ''}>${escapeHtml(acRotuloCondomino(cid))}</option>`)
    .join('');

  const corpo = `
    ${campo('Condômino', `<select id="ac-condomino">${optsCond || '<option value="">— nenhum condômino cadastrado —</option>'}</select>`, true)}
    ${campo('Tipo do acordo', `<select id="ac-tipo" onchange="acordoToggleJudicial()">
       <option value="extrajudicial"${sel('extrajudicial', a.tipo || 'extrajudicial')}>Extrajudicial</option>
       <option value="judicial"${sel('judicial', a.tipo)}>Judicial</option>
     </select>`, true)}
    <div id="ac-judicial" style="display:${a.tipo === 'judicial' ? 'block' : 'none'};">
      <div class="form-row">
        ${campo('Nº do processo', inputTexto('ac-processo', a.numeroProcesso))}
        ${campo('Tribunal competente', inputTexto('ac-tribunal', a.tribunal))}
      </div>
    </div>
    <div class="form-row">
      ${campo('Data do acordo', `<input type="date" id="ac-data" value="${escapeHtml(a.dataAcordo || acHojeISO())}">`)}
      ${campo('Situação', `<select id="ac-situacao">
        <option value="ativo"${sel('ativo', a.situacao || 'ativo')}>Ativo</option>
        <option value="quitado"${sel('quitado', a.situacao)}>Quitado</option>
        <option value="rompido"${sel('rompido', a.situacao)}>Rompido</option>
      </select>`)}
    </div>
    ${separadorForm('Parcelas do acordo')}
    <p class="muted" style="font-size:12px;margin-bottom:10px;">Informe o número total de parcelas acordadas e gere em lotes — o recomendado é 12 por vez. A correção costuma incidir só nas 12 primeiras; os lotes seguintes você gera depois (já corrigidos) e o sistema avisa ${ACORDO_AVISO_DIAS} dias antes de cada lote terminar.</p>
    ${campo('Número total de parcelas acordadas', `<input type="number" id="ac-num-total" min="1" step="1" placeholder="Ex: 48" value="${a.numeroParcelas || ''}" onchange="acordoAtualizarResumo()">`)}
    <div class="form-row-3">
      ${campo('Início do lote', '<input type="date" id="ac-pc-inicio">')}
      ${campo('Parcelas neste lote', '<input type="number" id="ac-pc-num" min="1" step="1" placeholder="12">')}
      ${campo('Valor de cada parcela (R$)', '<input type="number" id="ac-pc-valor" step="0.01" placeholder="Ex: 250">')}
    </div>
    <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;margin-bottom:12px;">
      <div class="form-group" style="margin:0;max-width:200px;">
        <label>Repetir até (opcional)</label>
        <input type="date" id="ac-pc-ate">
      </div>
      <button type="button" class="btn btn-primary btn-sm" style="margin-bottom:9px;" onclick="acordoGerarParcelas()">Gerar / adicionar lote</button>
    </div>
    <div id="ac-parcelas"></div>
    <div id="ac-parcelas-resumo" style="font-size:12px;margin:2px 0 10px;"></div>
    <button type="button" class="btn btn-secondary btn-sm" onclick="acordoParcelaAdd()" style="margin-bottom:6px;">+ Adicionar parcela avulsa</button>
    ${campo('Observações', `<textarea id="ac-obs" rows="2">${escapeHtml(a.observacoes || '')}</textarea>`)}`;

  abrirModalForm(id ? 'Editar acordo' : 'Novo acordo', corpo, () => salvarAcordo(id), 'Salvar acordo');
  acordoParcelasRender(a.parcelas || []);
}

// Mostra/esconde os campos de processo e tribunal conforme o tipo.
function acordoToggleJudicial() {
  const t = document.getElementById('ac-tipo');
  const div = document.getElementById('ac-judicial');
  if (div) div.style.display = (t && t.value === 'judicial') ? 'block' : 'none';
}

// -------------------------------------------------------------
// Editor de parcelas
// -------------------------------------------------------------
function acordoParcelasRender(parcelas) {
  const cont = document.getElementById('ac-parcelas');
  if (!cont) return;
  if (!parcelas || !parcelas.length) {
    cont.innerHTML = '<p class="muted" style="font-size:12px;margin-bottom:8px;">Nenhuma parcela gerada — preencha o gerador acima e clique em “Gerar / adicionar lote”.</p>';
    acordoAtualizarResumo();
    return;
  }
  cont.innerHTML = parcelas.map((p, i) => {
    const lote = Math.floor(i / 12) + 1;
    return `
    <div class="parcela-row" style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:8px;">
      <div class="form-group" style="margin:0;flex:1;min-width:150px;">
        <label>Vencimento ${i + 1}ª <span class="muted" style="font-weight:normal;">· lote ${lote}</span></label>
        <input type="date" class="pc-venc" value="${escapeHtml(p.vencimento || '')}">
      </div>
      <div class="form-group" style="margin:0;flex:1;min-width:120px;">
        <label>Valor (R$)</label>
        <input type="number" step="0.01" class="pc-valor" value="${p.valor != null ? p.valor : ''}">
      </div>
      <button type="button" class="btn btn-danger btn-sm" style="margin-bottom:9px;" onclick="acordoParcelaRemover(${i})">Remover</button>
    </div>`;
  }).join('');
  acordoAtualizarResumo();
}

// Resumo "X de Y parcelas geradas" logo abaixo do editor de parcelas.
function acordoAtualizarResumo() {
  const el = document.getElementById('ac-parcelas-resumo');
  if (!el) return;
  const cont = document.getElementById('ac-parcelas');
  const geradas = cont ? cont.querySelectorAll('.parcela-row').length : 0;
  const total = parseInt(valId('ac-num-total'), 10) || 0;
  if (!total && !geradas) { el.innerHTML = ''; return; }
  if (!total) {
    el.innerHTML = `<span class="muted">${geradas} parcela(s) gerada(s). Informe o número total para o controle de lotes.</span>`;
    return;
  }
  const faltam = Math.max(0, total - geradas);
  el.innerHTML = faltam
    ? `<span class="muted"><strong>${geradas} de ${total}</strong> parcelas geradas — faltam <strong>${faltam}</strong>. Gere o próximo lote quando for emitir as parcelas remanescentes.</span>`
    : `<span style="color:var(--success);"><strong>${geradas} de ${total}</strong> — todas as parcelas do acordo já foram geradas.</span>`;
}

function acordoParcelasLer() {
  const cont = document.getElementById('ac-parcelas');
  const out = [];
  if (!cont) return out;
  cont.querySelectorAll('.parcela-row').forEach((row) => {
    const v = row.querySelector('.pc-venc').value;
    const val = row.querySelector('.pc-valor').value;
    out.push({ vencimento: v || '', valor: val === '' ? null : Number(val) });
  });
  return out;
}

function acordoParcelaAdd() {
  const p = acordoParcelasLer();
  p.push({ vencimento: '', valor: null });
  acordoParcelasRender(p);
}

function acordoParcelaRemover(i) {
  const p = acordoParcelasLer();
  p.splice(i, 1);
  acordoParcelasRender(p);
}

// Gera um lote de parcelas mensais e ACRESCENTA às já existentes. Sem início,
// começa no mês seguinte à última parcela; sem número, completa um lote de 12
// (ou o que faltar para o total acordado).
function acordoGerarParcelas() {
  const existentes = acordoParcelasLer().filter((p) => p.vencimento || p.valor != null);
  let inicio = valId('ac-pc-inicio');
  const valor = Number(valId('ac-pc-valor')) || 0;
  const ate = valId('ac-pc-ate');
  let num = parseInt(valId('ac-pc-num'), 10);

  if (!inicio && existentes.length) {
    let ultima = '';
    existentes.forEach((p) => { if (p.vencimento && p.vencimento > ultima) ultima = p.vencimento; });
    if (ultima) inicio = somarMeses(ultima, 1);
  }
  if (!inicio) { erroModal('Informe o início do lote.'); return; }
  if (!(valor > 0)) { erroModal('Informe o valor de cada parcela.'); return; }

  if (!(num > 0) && ate) {
    const pi = inicio.split('-').map(Number);
    const pa = ate.split('-').map(Number);
    num = (pa[0] * 12 + pa[1]) - (pi[0] * 12 + pi[1]) + 1;
  }
  if (!(num > 0)) {
    const total = parseInt(valId('ac-num-total'), 10);
    num = total > 0 ? Math.min(12, total - existentes.length) : 12;
  }
  if (!(num > 0)) { erroModal('Não há parcelas a gerar — confira o número total acordado.'); return; }
  if (existentes.length + num > 240) { erroModal('Número de parcelas muito alto (máximo 240).'); return; }

  const novas = [];
  for (let i = 0; i < num; i++) novas.push({ vencimento: somarMeses(inicio, i), valor });
  acordoParcelasRender(existentes.concat(novas));

  ['ac-pc-inicio', 'ac-pc-num', 'ac-pc-valor', 'ac-pc-ate'].forEach((cid) => {
    const el = document.getElementById(cid);
    if (el) el.value = '';
  });
}

// -------------------------------------------------------------
// Salvar / excluir
// -------------------------------------------------------------
async function salvarAcordo(id) {
  const ctx = acCtx;
  if (!ctx) return;
  const condominoId = valId('ac-condomino');
  if (!condominoId) { erroModal('Selecione o condômino do acordo.'); return; }
  const tipo = valId('ac-tipo') || 'extrajudicial';
  const parcelas = acordoParcelasLer().filter((p) => p.vencimento || p.valor != null);
  if (!parcelas.length) { erroModal('Adicione pelo menos uma parcela.'); return; }

  const cond = ctx.condominos[condominoId] || {};
  const numTotal = parseInt(valId('ac-num-total'), 10);
  const dados = {
    condominoId,
    unidadeId: cond.unidadeId || null,
    tipo,
    numeroProcesso: tipo === 'judicial' ? valId('ac-processo') : '',
    tribunal: tipo === 'judicial' ? valId('ac-tribunal') : '',
    dataAcordo: valId('ac-data') || null,
    parcelas,
    numeroParcelas: numTotal > 0 ? numTotal : parcelas.length,
    observacoes: valId('ac-obs'),
    situacao: valId('ac-situacao') || 'ativo',
  };

  travarSalvar(true);
  try {
    if (id) {
      await refSub(ctx.cid, 'acordos').doc(id).update(dados);
    } else {
      await refSub(ctx.cid, 'acordos').add(Object.assign(dados, carimboCriacao()));
    }
    fecharModalForm();
    renderAcordos();
  } catch (err) {
    travarSalvar(false, 'Salvar acordo');
    erroModal('Falha ao salvar: ' + (err.message || err));
  }
}

async function excluirAcordo(id) {
  const ctx = acCtx;
  if (!ctx) return;
  const ok = await confirmar({
    titulo: 'Excluir acordo',
    mensagem: 'Excluir este acordo? Não dá pra desfazer.',
    okLabel: 'Excluir', perigo: true,
  });
  if (!ok) return;
  try {
    await refSub(ctx.cid, 'acordos').doc(id).delete();
    renderAcordos();
  } catch (err) {
    alert('Falha ao excluir: ' + (err.message || err));
  }
}

function relatorioAcordos() {
  const ctx = acCtx;
  if (!ctx) return;
  const linhas = ctx.acordos.slice()
    .sort((a, z) => String(z.dataAcordo || '').localeCompare(String(a.dataAcordo || '')))
    .map((a) => [
      acRotuloCondomino(a.condominoId),
      a.tipo === 'judicial' ? 'Judicial' : 'Extrajudicial',
      a.tipo === 'judicial' ? (a.numeroProcesso || '') : '',
      a.tipo === 'judicial' ? (a.tribunal || '') : '',
      fmtData(a.dataAcordo),
      String((a.parcelas || []).length),
      fmtMoeda(acTotalParcelas(a.parcelas)),
      AC_SITUACOES[a.situacao] || 'Ativo',
    ]);
  abrirRelatorio('Relatório de Acordos', condominioContextoNome(),
    ['Condômino', 'Tipo', 'Nº processo', 'Tribunal', 'Data', 'Parcelas', 'Valor total', 'Situação'],
    linhas, '', 'acordos');
}

SECTION_RENDERERS.acordos = renderAcordos;
