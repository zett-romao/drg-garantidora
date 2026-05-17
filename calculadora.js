// =============================================================
// DRG-Garantidora — calculadora.js
// Calculadora de Antecipação: ferramenta avulsa para a equipe estimar,
// a partir do valor bruto das cotas, o honorário da D.R. Global, as
// tarifas de boleto e o líquido. Não grava nada — é só cálculo.
// Carregado depois de competencias.js.
// =============================================================

window.SECTION_RENDERERS = window.SECTION_RENDERERS || {};

function renderCalculadora() {
  $('content').innerHTML = `
    <div class="section-head">
      <div><h2>Calculadora de Antecipação</h2>
      <p>Estime os números de uma antecipação a partir do valor bruto das cotas.</p></div>
    </div>
    <div class="card">
      <div class="form-row-3">
        ${campo('Valor bruto das cotas (R$)', '<input type="number" step="0.01" id="calc-bruto" placeholder="Ex: 45000" oninput="calcularAntecipacao()">', true)}
        ${campo('Taxa de administração (%)', '<input type="number" step="0.01" id="calc-taxa" value="8" oninput="calcularAntecipacao()">')}
        ${campo('Tarifa por boleto (R$)', '<input type="number" step="0.01" id="calc-tarifa" value="3.50" oninput="calcularAntecipacao()">')}
      </div>
      ${campo('Quantidade de boletos', '<input type="number" id="calc-qtd" placeholder="Ex: 100" oninput="calcularAntecipacao()">')}
      <div id="calc-resultado" style="margin-top:18px;"></div>
    </div>`;
  calcularAntecipacao();
}

function calcularAntecipacao() {
  const num = (id) => parseFloat((($(id) || {}).value) || '') || 0;
  const bruto = num('calc-bruto');
  const taxa = num('calc-taxa');
  const tarifa = num('calc-tarifa');
  const qtd = num('calc-qtd');

  const honorario = bruto * taxa / 100;
  const tarifas = tarifa * qtd;
  const liquido = bruto - honorario - tarifas;

  const grid = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;';
  const card = (label, valor, sub, cor) => `<div class="stat-card">
    <span class="stat-label">${escapeHtml(label)}</span>
    <span class="stat-value"${cor ? ` style="color:${cor};"` : ''}>${escapeHtml(fmtMoeda(valor))}</span>
    ${sub ? `<span class="stat-sub">${escapeHtml(sub)}</span>` : ''}
  </div>`;

  $('calc-resultado').innerHTML = `
    <div style="${grid}">
      ${card('Valor bruto', bruto, 'total das cotas')}
      ${card('Honorário D.R. Global', honorario, `${taxa}% do bruto`, 'var(--success)')}
      ${card('Tarifas de boleto', tarifas, `${qtd} boleto(s) × ${fmtMoeda(tarifa)}`)}
      ${card('Líquido', liquido, 'bruto − honorário − tarifas')}
    </div>
    <p class="muted" style="font-size:12px;margin-top:10px;">Ferramenta de estimativa — não grava nada no sistema.</p>`;
}

SECTION_RENDERERS.calculadora = renderCalculadora;
