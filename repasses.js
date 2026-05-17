// =============================================================
// DRG-Garantidora — repasses.js
// Antecipação / Repasses: a D.R. Global garante e repassa ao condomínio
// 100% das cotas de cada competência. Este módulo controla, por
// competência, o valor a repassar e dispara o repasse via Pix (Asaas).
// Também aceita registro manual (repasse feito por fora do sistema).
// Carregado depois de competencias.js — usa WORKER_ASAAS_URL e refCondominios.
// =============================================================

window.SECTION_RENDERERS = window.SECTION_RENDERERS || {};

// Situação do repasse, a partir do status da transferência no Asaas.
const REP_OK = ['DONE', 'MANUAL'];
const REP_PROCESSANDO = ['PENDING', 'BANK_PROCESSING', 'CREATED'];
const REP_FALHA = ['FAILED', 'CANCELLED', 'BLOCKED'];

let repCondominio = {};      // { nome, repasse:{pixTipo,pixChave} } do condomínio em contexto
let repComps = {};           // id -> dados da competência (para os handlers de onclick)
let repEmAndamento = false;  // trava anti-disparo-duplo durante a transferência

function repHojeISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function rotuloPixTipo(t) {
  return { CPF: 'CPF', CNPJ: 'CNPJ', EMAIL: 'e-mail', PHONE: 'telefone', EVP: 'aleatória' }[t] || (t || '—');
}

// Classifica a situação do repasse de uma competência.
function repClassificar(c) {
  const st = c.repasseStatus || '';
  if (REP_OK.indexOf(st) !== -1) return 'ok';
  if (REP_PROCESSANDO.indexOf(st) !== -1) return 'processando';
  if (REP_FALHA.indexOf(st) !== -1) return 'falha';
  if (c.repasseEm) return 'ok';   // legado: repasseEm gravado sem status
  return 'pendente';
}

function badgeRepasse(c, valor) {
  const classe = repClassificar(c);
  if (classe === 'ok') {
    const quando = c.repasseEfetivadoEm || c.repasseEm;
    const via = c.repasseStatus === 'MANUAL' ? ' (manual)' : '';
    return `<span class="badge badge-success">Repassado${via}${quando ? ' · ' + escapeHtml(fmtData(quando)) : ''}</span>`;
  }
  if (classe === 'processando') {
    return '<span class="badge badge-warning">Repassando…</span>';
  }
  if (classe === 'falha') {
    const motivo = c.repasseFalhaMotivo ? ' · ' + escapeHtml(c.repasseFalhaMotivo) : '';
    return `<span class="badge badge-danger">Falhou${motivo}</span>`;
  }
  return valor > 0
    ? '<span class="badge badge-warning">A repassar</span>'
    : '<span class="badge badge-muted">Sem boletos</span>';
}

function montarAcoesRepasse(cid, id, c, valor, classe) {
  if (classe === 'ok') {
    const comp = c.repasseComprovanteUrl
      ? `<a class="btn btn-secondary btn-sm" href="${escapeHtml(c.repasseComprovanteUrl)}" target="_blank" rel="noopener">Comprovante</a> `
      : '';
    return comp + `<button class="btn btn-secondary btn-sm" onclick="desfazerRepasse('${cid}','${id}')">Desfazer registro</button>`;
  }
  if (classe === 'processando') {
    return '<span class="muted" style="font-size:12px;">aguardando confirmação do Asaas…</span>';
  }
  if (valor > 0) {
    // pendente ou falha → permite (re)transferir ou registrar manualmente
    return `<button class="btn btn-success btn-sm" onclick="repassarViaPix('${cid}','${id}',${valor})">Repassar via Pix</button>
            <button class="btn btn-secondary btn-sm" onclick="registrarRepasse('${cid}','${id}',${valor})">Registrar manual</button>`;
  }
  return '';
}

function renderRepasses() {
  return renderComContexto(
    'Antecipação / Repasses',
    'A D.R. Global garante e repassa ao condomínio 100% das cotas de cada competência.',
    async (cid) => {
      const [snapComp, snapB, snapCond] = await Promise.all([
        refSub(cid, 'competencias').get(),
        refSub(cid, 'boletos').get(),
        refCondominios().doc(cid).get(),
      ]);

      const cond = snapCond.exists ? snapCond.data() : {};
      repCondominio = { nome: cond.nome || '', repasse: cond.repasse || {} };
      repComps = {};

      // Σ das cotas (boletos, menos os de honorário) por competência.
      const cotaPorComp = {};
      snapB.docs.forEach((d) => {
        const b = d.data();
        if (b.tipo === 'honorario') return;
        cotaPorComp[b.competenciaId] = (cotaPorComp[b.competenciaId] || 0) + (Number(b.valor) || 0);
      });

      const comps = snapComp.docs
        .map((d) => ({ id: d.id, c: d.data() }))
        .sort((a, z) => ((z.c.ano || 0) * 100 + (z.c.mes || 0)) - ((a.c.ano || 0) * 100 + (a.c.mes || 0)));

      let totalAReprassar = 0;
      let totalRepassado = 0;
      const semChavePix = !(repCondominio.repasse && repCondominio.repasse.pixChave);

      const linhas = comps.map(({ id, c }) => {
        repComps[id] = c;
        const valor = cotaPorComp[id] || 0;
        const classe = repClassificar(c);
        const valorRepasse = (c.repasseValor != null ? c.repasseValor : valor);
        if (classe === 'ok' || classe === 'processando') totalRepassado += valorRepasse;
        else totalAReprassar += valor;

        const acao = podeEditar() ? montarAcoesRepasse(cid, id, c, valor, classe) : '';
        return `<tr>
          <td>${escapeHtml(rotuloCompetencia(c))}</td>
          <td>${escapeHtml(fmtData(c.vencimento))}</td>
          <td class="col-num">${escapeHtml(fmtMoeda(valor))}</td>
          <td>${badgeRepasse(c, valor)}</td>
          <td class="acoes">${acao}</td>
        </tr>`;
      }).join('');

      const tabela = comps.length
        ? `<div class="tabela-wrap"><table class="tabela">
             <thead><tr><th>Competência</th><th>Vencimento</th><th>Valor a repassar</th><th>Status</th><th>Ações</th></tr></thead>
             <tbody>${linhas}</tbody></table></div>`
        : '<div class="empty-state">Nenhuma competência cadastrada.</div>';

      const aviso = (podeEditar() && comps.length && semChavePix)
        ? `<div class="card" style="border-left:3px solid var(--warning,#d97706);">
             <p class="muted" style="margin:0;font-size:13px;">
               <strong>Sem chave Pix cadastrada.</strong> O repasse via Pix fica indisponível para este condomínio —
               cadastre em Cadastros → Condomínios → Editar → seção “Repasse ao condomínio”.
               O registro manual continua disponível.
             </p>
           </div>`
        : '';

      document.getElementById('ctx-conteudo').innerHTML = `
        ${aviso}
        <div class="card">
          ${tabela}
          ${comps.length ? `<p style="margin-top:12px;">
            A repassar: <strong>${escapeHtml(fmtMoeda(totalAReprassar))}</strong> ·
            já repassado: <strong>${escapeHtml(fmtMoeda(totalRepassado))}</strong>
          </p>` : ''}
        </div>`;
    },
  );
}

// Dispara a transferência de verdade (Pix via Asaas).
async function repassarViaPix(cid, compId, valor) {
  if (repEmAndamento) return;
  const rep = repCondominio.repasse || {};
  if (!rep.pixChave || !rep.pixTipo) {
    alert('Cadastre a chave Pix do condomínio antes de repassar.\n\n'
      + 'Vá em Cadastros → Condomínios → Editar → seção "Repasse ao condomínio".');
    return;
  }
  if (!(valor > 0)) {
    alert('Não há valor a repassar nesta competência.');
    return;
  }
  const ok = await confirmar({
    titulo: 'Repassar via Pix',
    mensagem: `Transferir agora ${fmtMoeda(valor)} via Pix para a chave `
      + `${rotuloPixTipo(rep.pixTipo)} "${rep.pixChave}" do condomínio? `
      + 'Isso movimenta dinheiro de verdade e é irreversível.',
    okLabel: 'Repassar agora',
    perigo: true,
  });
  if (!ok || repEmAndamento) return;
  repEmAndamento = true;
  try {
    const comp = repComps[compId] || {};
    const rotulo = rotuloCompetencia(comp);
    const r = await fetch(`${WORKER_ASAAS_URL}/transferencias`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        valor,
        pixChave: rep.pixChave,
        pixTipo: rep.pixTipo,
        descricao: `Repasse ${rotulo}${repCondominio.nome ? ' — ' + repCondominio.nome : ''}`,
        refExterna: `garantidora|${cid}|${compId}|repasse`,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.success) throw new Error(j.error || 'falha na transferência');
    const t = j.transferencia || {};
    await refSub(cid, 'competencias').doc(compId).update({
      repasseEm: repHojeISO(),
      repasseValor: valor,
      repasseTransferId: t.id || null,
      repasseStatus: t.status || 'PENDING',
      repasseComprovanteUrl: t.transactionReceiptUrl || null,
      repasseEfetivadoEm: null,
      repasseFalhaMotivo: null,
    });
    renderRepasses();
  } catch (err) {
    alert('Falha no repasse via Pix: ' + (err.message || err));
  } finally {
    repEmAndamento = false;
  }
}

// Registro manual — quando o repasse foi feito por fora do sistema.
function registrarRepasse(cid, compId, valor) {
  const corpo = `
    <p>Valor a repassar ao condomínio: <strong>${escapeHtml(fmtMoeda(valor))}</strong></p>
    ${campo('Data do repasse', `<input type="date" id="rep-data" value="${repHojeISO()}">`, true)}
    <p class="muted" style="font-size:12px;">Use quando o repasse foi feito por fora do sistema (TED, dinheiro, Pix manual). Só registra a data — não transfere nada pelo Asaas.</p>`;
  abrirModalForm('Registrar repasse manual', corpo, () => salvarRepasse(cid, compId, valor), 'Registrar repasse');
}

async function salvarRepasse(cid, compId, valor) {
  const data = valId('rep-data');
  if (!data) { erroModal('Informe a data do repasse.'); return; }
  travarSalvar(true);
  try {
    await refSub(cid, 'competencias').doc(compId).update({
      repasseEm: data,
      repasseValor: valor,
      repasseStatus: 'MANUAL',
      repasseTransferId: null,
      repasseEfetivadoEm: null,
      repasseFalhaMotivo: null,
      repasseComprovanteUrl: null,
    });
    fecharModalForm();
    renderRepasses();
  } catch (err) {
    travarSalvar(false, 'Registrar repasse');
    erroModal('Falha ao registrar: ' + (err.message || err));
  }
}

async function desfazerRepasse(cid, compId) {
  const ok = await confirmar({
    titulo: 'Desfazer registro de repasse',
    mensagem: 'Remove apenas o REGISTRO do repasse desta competência. Se um Pix já foi enviado pelo Asaas, ele NÃO é cancelado — isso afeta só o controle interno.',
    okLabel: 'Desfazer registro', perigo: true,
  });
  if (!ok) return;
  try {
    await refSub(cid, 'competencias').doc(compId).update({
      repasseEm: null,
      repasseValor: null,
      repasseStatus: null,
      repasseTransferId: null,
      repasseEfetivadoEm: null,
      repasseFalhaMotivo: null,
      repasseComprovanteUrl: null,
      repasseAsaasEvent: null,
      repasseAtualizadoEm: null,
    });
    renderRepasses();
  } catch (err) {
    alert('Falha ao desfazer: ' + (err.message || err));
  }
}

SECTION_RENDERERS.repasses = renderRepasses;
