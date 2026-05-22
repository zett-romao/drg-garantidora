// =============================================================
// DRG-Garantidora — relatorios.js
// Motor de relatórios reaproveitável. Cada seção monta colunas + linhas
// e chama abrirRelatorio(); o usuário escolhe Imprimir/PDF ou Excel.
// Carregado depois de app.js. Usa escapeHtml (global) e o SheetJS (XLSX).
// =============================================================

let _relCtx = null; // { titulo, subtitulo, colunas, linhas, rodape, arquivo }

// Nome do condomínio em contexto (lê o seletor de renderComContexto).
function condominioContextoNome() {
  const sel = document.getElementById('sel-condominio');
  if (sel && sel.selectedIndex >= 0) return sel.options[sel.selectedIndex].text || '';
  return '';
}

// Data/hora atual em dd/MM/aaaa HH:mm.
function relDataHora() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Abre o seletor de relatório. colunas = ['Col',...]; linhas = [['v',...],...].
function abrirRelatorio(titulo, subtitulo, colunas, linhas, rodape, arquivo) {
  _relCtx = {
    titulo: titulo || 'Relatório',
    subtitulo: subtitulo || '',
    colunas: colunas || [],
    linhas: linhas || [],
    rodape: rodape || '',
    arquivo: arquivo || 'relatorio',
  };
  let ov = document.getElementById('rel-modal');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'rel-modal';
    ov.className = 'modal-confirm-overlay';
    document.body.appendChild(ov);
  }
  const n = _relCtx.linhas.length;
  ov.innerHTML = `
    <div class="modal-confirm-card" role="dialog" aria-modal="true">
      <h3>${escapeHtml(_relCtx.titulo)}</h3>
      <p>${escapeHtml(_relCtx.subtitulo)}${_relCtx.subtitulo ? ' · ' : ''}${n} registro(s)</p>
      <div class="modal-confirm-actions" style="flex-wrap:wrap;">
        <button type="button" class="btn btn-secondary" onclick="relatorioFechar()">Cancelar</button>
        <button type="button" class="btn btn-primary" onclick="relatorioImprimir()">Imprimir / PDF</button>
        <button type="button" class="btn btn-primary" onclick="relatorioExcel()">Baixar Excel</button>
      </div>
    </div>`;
  ov.style.display = 'flex';
}

function relatorioFechar() {
  const ov = document.getElementById('rel-modal');
  if (ov) ov.style.display = 'none';
}

// Abre o relatório numa janela imprimível (Imprimir / Salvar PDF).
function relatorioImprimir() {
  const r = _relCtx;
  if (!r) return;
  relatorioFechar();
  const ths = r.colunas.map((c) => `<th>${escapeHtml(String(c))}</th>`).join('');
  const trs = r.linhas.map((lin) =>
    `<tr>${lin.map((c) => `<td>${escapeHtml(c == null ? '' : String(c))}</td>`).join('')}</tr>`).join('');
  const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<title>${escapeHtml(r.titulo)}</title>
<style>
  body{font-family:Arial,Helvetica,sans-serif;color:#1e293b;max-width:1000px;margin:24px auto;padding:0 24px;}
  h1{font-size:17px;margin:0 0 2px;color:#334155;}
  .sub{font-size:12px;color:#64748b;margin-bottom:14px;}
  table{width:100%;border-collapse:collapse;font-size:12px;}
  th,td{padding:6px 8px;border-bottom:1px solid #e2e8f0;text-align:left;vertical-align:top;}
  th{background:#f1f5f9;color:#334155;font-size:11px;text-transform:uppercase;}
  tr:nth-child(even) td{background:#f8fafc;}
  .rodape{margin-top:18px;font-size:11px;color:#64748b;line-height:1.5;}
  .vazio{color:#64748b;font-size:13px;}
  .btn-print{background:#475569;color:#fff;border:none;padding:9px 16px;border-radius:6px;font-size:13px;cursor:pointer;margin-bottom:16px;}
  @media print{.btn-print{display:none;}body{margin:0;max-width:none;}}
</style></head><body>
<button class="btn-print" onclick="window.print()">Imprimir / Salvar como PDF</button>
<h1>${escapeHtml(r.titulo)}</h1>
<div class="sub">${escapeHtml(r.subtitulo)}${r.subtitulo ? ' — ' : ''}gerado em ${escapeHtml(relDataHora())}</div>
${r.linhas.length ? `<table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>` : '<p class="vazio">Nenhum registro nesta seleção.</p>'}
<p class="rodape">${escapeHtml(r.rodape)}${r.rodape ? '<br>' : ''}${r.linhas.length} registro(s) · DRG-Garantidora — D.R. Global.</p>
</body></html>`;
  const w = window.open('', '_blank');
  if (!w) { alert('Não foi possível abrir o relatório — permita pop-ups para este site.'); return; }
  w.document.write(html);
  w.document.close();
}

// Baixa o relatório como planilha Excel (.xlsx).
function relatorioExcel() {
  const r = _relCtx;
  if (!r) return;
  relatorioFechar();
  if (typeof XLSX === 'undefined') {
    alert('A biblioteca de planilha ainda não carregou — recarregue a página e tente de novo.');
    return;
  }
  const aoa = [r.colunas].concat(r.linhas.map((lin) => lin.map((c) => (c == null ? '' : c))));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Relatorio');
  XLSX.writeFile(wb, `${r.arquivo}-${new Date().toISOString().slice(0, 10)}.xlsx`);
}
