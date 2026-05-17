// =============================================================
// DRG-Garantidora — proposta.js
// Simulador de Proposta: ferramenta avulsa para a equipe montar uma
// proposta comercial para um condomínio prospect — o que a D.R. Global
// garante, quanto ganha e a projeção. Não grava nada.
// Carregado depois de competencias.js.
// =============================================================

window.SECTION_RENDERERS = window.SECTION_RENDERERS || {};

function renderProposta() {
  $('content').innerHTML = `
    <div class="section-head">
      <div><h2>Simulador de Proposta</h2>
      <p>Monte a proposta comercial para um condomínio — garantia, honorários e projeção.</p></div>
    </div>
    <div class="card">
      ${campo('Condomínio (prospect)', inputTexto('prop-nome', '', 'placeholder="Nome do condomínio"'))}
      <div class="form-row-3">
        ${campo('Nº de unidades', '<input type="number" id="prop-unidades" placeholder="Ex: 100" oninput="simularProposta()">', true)}
        ${campo('Arrecadação mensal (R$)', '<input type="number" step="0.01" id="prop-arrecadacao" placeholder="Ex: 45000" oninput="simularProposta()">', true)}
        ${campo('Inadimplência estimada (%)', '<input type="number" step="0.01" id="prop-inadimplencia" value="15" oninput="simularProposta()">')}
      </div>
      <div class="form-row">
        ${campo('Taxa de administração (%)', '<input type="number" step="0.01" id="prop-taxa" value="8" oninput="simularProposta()">')}
        ${campo('Tarifa por boleto (R$)', '<input type="number" step="0.01" id="prop-tarifa" value="3.50" oninput="simularProposta()">')}
      </div>
      <div id="prop-resultado" style="margin-top:18px;"></div>
    </div>`;
  simularProposta();
}

function simularProposta() {
  const num = (id) => parseFloat((($(id) || {}).value) || '') || 0;
  const unidades = num('prop-unidades');
  const arrecadacao = num('prop-arrecadacao');
  const inadPct = num('prop-inadimplencia');
  const taxa = num('prop-taxa');
  const tarifa = num('prop-tarifa');

  const garantido = arrecadacao;                       // o condomínio recebe 100%
  const honorarioMes = arrecadacao * taxa / 100;        // receita da D.R. Global
  const inadAbsorvida = arrecadacao * inadPct / 100;    // risco que a D.R. assume
  const tarifasMes = tarifa * unidades;
  const honorarioAno = honorarioMes * 12;

  const grid = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;';
  const card = (label, valor, sub, cor) => `<div class="stat-card">
    <span class="stat-label">${escapeHtml(label)}</span>
    <span class="stat-value"${cor ? ` style="color:${cor};"` : ''}>${escapeHtml(fmtMoeda(valor))}</span>
    ${sub ? `<span class="stat-sub">${escapeHtml(sub)}</span>` : ''}
  </div>`;

  $('prop-resultado').innerHTML = `
    <h3>Para o condomínio</h3>
    <div style="${grid}">
      ${card('Receita garantida/mês', garantido, '100% da arrecadação, todo mês', 'var(--success)')}
      ${card('Inadimplência absorvida', inadAbsorvida, `${inadPct}% que a D.R. assume`)}
    </div>
    <h3 style="margin-top:18px;">Para a D.R. Global</h3>
    <div style="${grid}">
      ${card('Honorário/mês', honorarioMes, `${taxa}% da arrecadação`)}
      ${card('Honorário/ano', honorarioAno, '12 meses')}
      ${card('Tarifas de boleto/mês', tarifasMes, `${unidades} unidade(s)`)}
    </div>
    <p class="muted" style="font-size:12px;margin-top:10px;">Simulação comercial — não grava nada no sistema. A inadimplência absorvida é o risco que a D.R. Global assume ao garantir 100% da arrecadação.</p>`;
}

SECTION_RENDERERS.proposta = renderProposta;
