// =============================================================
// DRG-Garantidora — repasses.js
// Antecipação / Repasses: a D.R. Global garante e repassa ao condomínio
// 100% das cotas de cada competência. Este módulo controla, por
// competência, o valor a repassar e o registro do repasse efetuado.
// (A transferência bancária em si é feita fora do sistema por enquanto.)
// Carregado depois de competencias.js.
// =============================================================

window.SECTION_RENDERERS = window.SECTION_RENDERERS || {};

function repHojeISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function renderRepasses() {
  return renderComContexto(
    'Antecipação / Repasses',
    'A D.R. Global garante e repassa ao condomínio 100% das cotas de cada competência.',
    async (cid) => {
      const [snapComp, snapB] = await Promise.all([
        refSub(cid, 'competencias').get(),
        refSub(cid, 'boletos').get(),
      ]);

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
      const linhas = comps.map(({ id, c }) => {
        const valor = cotaPorComp[id] || 0;
        const repassado = !!c.repasseEm;
        if (repassado) totalRepassado += (c.repasseValor != null ? c.repasseValor : valor);
        else totalAReprassar += valor;

        const statusCol = repassado
          ? `<span class="badge badge-success">Repassado · ${escapeHtml(fmtData(c.repasseEm))}</span>`
          : (valor > 0
            ? '<span class="badge badge-warning">A repassar</span>'
            : '<span class="badge badge-muted">Sem boletos</span>');

        let acao = '';
        if (podeEditar()) {
          acao = repassado
            ? `<button class="btn btn-secondary btn-sm" onclick="desfazerRepasse('${cid}','${id}')">Desfazer</button>`
            : (valor > 0
              ? `<button class="btn btn-success btn-sm" onclick="registrarRepasse('${cid}','${id}',${valor})">Registrar repasse</button>`
              : '');
        }
        return `<tr>
          <td>${escapeHtml(rotuloCompetencia(c))}</td>
          <td>${escapeHtml(fmtData(c.vencimento))}</td>
          <td class="col-num">${escapeHtml(fmtMoeda(valor))}</td>
          <td>${statusCol}</td>
          <td class="acoes">${acao}</td>
        </tr>`;
      }).join('');

      const tabela = comps.length
        ? `<div class="tabela-wrap"><table class="tabela">
             <thead><tr><th>Competência</th><th>Vencimento</th><th>Valor a repassar</th><th>Status</th><th>Ações</th></tr></thead>
             <tbody>${linhas}</tbody></table></div>`
        : '<div class="empty-state">Nenhuma competência cadastrada.</div>';

      document.getElementById('ctx-conteudo').innerHTML = `
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

function registrarRepasse(cid, compId, valor) {
  const corpo = `
    <p>Valor a repassar ao condomínio: <strong>${escapeHtml(fmtMoeda(valor))}</strong></p>
    ${campo('Data do repasse', `<input type="date" id="rep-data" value="${repHojeISO()}">`, true)}
    <p class="muted" style="font-size:12px;">Registra que a D.R. Global repassou as cotas ao condomínio. A transferência bancária em si é feita fora do sistema.</p>`;
  abrirModalForm('Registrar repasse', corpo, () => salvarRepasse(cid, compId, valor), 'Registrar repasse');
}

async function salvarRepasse(cid, compId, valor) {
  const data = valId('rep-data');
  if (!data) { erroModal('Informe a data do repasse.'); return; }
  travarSalvar(true);
  try {
    await refSub(cid, 'competencias').doc(compId).update({ repasseEm: data, repasseValor: valor });
    fecharModalForm();
    renderRepasses();
  } catch (err) {
    travarSalvar(false, 'Registrar repasse');
    erroModal('Falha ao registrar: ' + (err.message || err));
  }
}

async function desfazerRepasse(cid, compId) {
  const ok = await confirmar({
    titulo: 'Desfazer repasse',
    mensagem: 'Remover o registro de repasse desta competência?',
    okLabel: 'Desfazer', perigo: true,
  });
  if (!ok) return;
  try {
    await refSub(cid, 'competencias').doc(compId).update({ repasseEm: null, repasseValor: null });
    renderRepasses();
  } catch (err) {
    alert('Falha ao desfazer: ' + (err.message || err));
  }
}

SECTION_RENDERERS.repasses = renderRepasses;
