// =============================================================
// DRG-Garantidora — financeiro.js
// Painel Financeiro: visão consolidada da cobrança de um condomínio
// — cotas faturadas / recebidas / em aberto / vencidas + honorários.
// Só leitura. Carregado depois de competencias.js.
// =============================================================

window.SECTION_RENDERERS = window.SECTION_RENDERERS || {};

const FIN_STATUS_PAGO = ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'];

function finHojeISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function finCard(label, valor, sub, cor) {
  return `<div class="stat-card">
    <span class="stat-label">${escapeHtml(label)}</span>
    <span class="stat-value"${cor ? ` style="color:${cor};"` : ''}>${escapeHtml(fmtMoeda(valor))}</span>
    ${sub ? `<span class="stat-sub">${escapeHtml(sub)}</span>` : ''}
  </div>`;
}

function renderFinanceiro() {
  return renderComContexto(
    'Painel Financeiro',
    'Visão consolidada da cobrança do condomínio.',
    async (cid) => {
      const [snapB, snapComp] = await Promise.all([
        refSub(cid, 'boletos').get(),
        refSub(cid, 'competencias').get(),
      ]);
      const hoje = finHojeISO();
      const compRotulo = {};
      const compOrdem = {};
      snapComp.docs.forEach((d) => {
        const c = d.data();
        compRotulo[d.id] = rotuloCompetencia(c);
        compOrdem[d.id] = (c.ano || 0) * 100 + (c.mes || 0);
      });

      const acc = { cotaEmit: 0, cotaReceb: 0, cotaAberto: 0, cotaVencido: 0, honEmit: 0, honReceb: 0 };
      const porComp = {};
      snapB.docs.forEach((d) => {
        const b = d.data();
        const v = Number(b.valor) || 0;
        const pago = FIN_STATUS_PAGO.indexOf(b.status || 'PENDING') !== -1;
        if (b.tipo === 'honorario') {
          acc.honEmit += v;
          if (pago) acc.honReceb += v;
          return;
        }
        acc.cotaEmit += v;
        const pc = porComp[b.competenciaId] ||
          (porComp[b.competenciaId] = { faturado: 0, recebido: 0, aberto: 0, vencido: 0 });
        pc.faturado += v;
        if (pago) {
          acc.cotaReceb += v; pc.recebido += v;
        } else if (b.vencimento && b.vencimento < hoje) {
          acc.cotaVencido += v; pc.vencido += v;
        } else {
          acc.cotaAberto += v; pc.aberto += v;
        }
      });

      const linhasComp = Object.keys(porComp)
        .sort((a, z) => (compOrdem[z] || 0) - (compOrdem[a] || 0))
        .map((id) => {
          const pc = porComp[id];
          return `<tr>
            <td>${escapeHtml(compRotulo[id] || '—')}</td>
            <td class="col-num">${escapeHtml(fmtMoeda(pc.faturado))}</td>
            <td class="col-num">${escapeHtml(fmtMoeda(pc.recebido))}</td>
            <td class="col-num">${escapeHtml(fmtMoeda(pc.aberto))}</td>
            <td class="col-num">${escapeHtml(fmtMoeda(pc.vencido))}</td>
          </tr>`;
        }).join('');

      const tabela = linhasComp
        ? `<div class="tabela-wrap"><table class="tabela">
             <thead><tr><th>Competência</th><th>Faturado</th><th>Recebido</th><th>Em aberto</th><th>Vencido</th></tr></thead>
             <tbody>${linhasComp}</tbody></table></div>`
        : '<div class="empty-state">Nenhum boleto de cota emitido ainda.</div>';

      const grid = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;';
      document.getElementById('ctx-conteudo').innerHTML = `
        <div class="card">
          <h3>Cotas condominiais</h3>
          <div style="${grid}">
            ${finCard('Faturado', acc.cotaEmit, 'total emitido')}
            ${finCard('Recebido', acc.cotaReceb, 'cotas pagas', 'var(--success)')}
            ${finCard('Em aberto', acc.cotaAberto, 'a vencer')}
            ${finCard('Vencido', acc.cotaVencido, 'inadimplência', 'var(--danger)')}
          </div>
        </div>
        <div class="card">
          <h3>Honorários da D.R. Global</h3>
          <div style="${grid}">
            ${finCard('Emitido', acc.honEmit, 'honorários cobrados')}
            ${finCard('Recebido', acc.honReceb, 'honorários pagos', 'var(--success)')}
          </div>
        </div>
        <div class="card">
          <h3>Por competência</h3>
          ${tabela}
        </div>`;
    },
  );
}

SECTION_RENDERERS.financeiro = renderFinanceiro;
