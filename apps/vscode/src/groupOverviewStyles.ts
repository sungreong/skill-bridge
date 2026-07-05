export function renderGroupOverviewStyles(): string {
  return `
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; height: 100vh; overflow: hidden; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    .wrap { height: 100vh; min-height: 0; display: grid; grid-template-rows: auto auto minmax(0, 1fr); gap: 7px; padding: 8px 10px; overflow: hidden; }
    .top { display: flex; justify-content: space-between; align-items: center; gap: 8px; min-width: 0; }
    .top-actions, .toolbar, .agent-filter, .actions, .meta, .folder-summary, .batch-actions { min-width: 0; display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
    .top-actions, .actions { justify-content: flex-end; }
    h1, h2, h3 { margin: 0; font-weight: 650; }
    h1 { min-width: 0; font-size: 17px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    h2 { font-size: 14px; }
    h3 { font-size: 13px; }
    .summary { color: var(--vscode-descriptionForeground); font-size: 12px; white-space: nowrap; }
    .controls { min-height: 0; display: grid; gap: 5px; }
    input, textarea, button { font: inherit; border: 1px solid var(--vscode-panel-border); border-radius: 5px; }
    input, textarea { background: var(--vscode-input-background); color: var(--vscode-input-foreground); padding: 5px 8px; }
    #search { width: min(520px, 100%); min-width: 0; flex: 1 1 260px; }
    button { min-height: 28px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); padding: 4px 8px; cursor: pointer; }
    button:disabled { opacity: .55; cursor: not-allowed; }
    button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: var(--vscode-button-background); }
    .chip { min-height: 26px; border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 3px 9px; background: var(--vscode-input-background); color: var(--vscode-descriptionForeground); }
    .chip.active { border-color: #60a5fa; color: var(--vscode-foreground); box-shadow: inset 0 0 0 1px rgba(96,165,250,.28); }
    .agent-filter { max-height: 60px; overflow: auto; padding-right: 2px; scrollbar-gutter: stable; }
    .content { min-height: 0; min-width: 0; display: grid; grid-template-rows: minmax(112px, min(28vh, 230px)) minmax(0, 1fr); gap: 7px; }
    .group-list, .detail-shell { min-height: 0; border: 1px solid var(--vscode-panel-border); border-radius: 7px; overflow: hidden; background: color-mix(in oklab, var(--vscode-editor-background) 97%, var(--vscode-editor-foreground) 3%); }
    .group-list, .detail-shell, .skill-section, .skill-folders { scrollbar-gutter: stable; }
    .group-list { overflow: auto; }
    .detail-shell { overflow: hidden; }
    .group-list table { min-width: 1040px; }
    .group-row { cursor: pointer; }
    .group-row:hover { background: color-mix(in oklab, var(--vscode-editor-background) 92%, #60a5fa 8%); }
    .group-row.active { background: color-mix(in oklab, var(--vscode-editor-background) 86%, #60a5fa 14%); }
    .group-check { width: 34px; }
    .group-check input { width: 14px; height: 14px; min-height: 14px; margin: 0; padding: 0; }
    .group-name { font-weight: 700; color: var(--vscode-foreground); }
    .group-desc { max-width: 560px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); }
    .agent-label { color: #bfdbfe; font-weight: 700; }
    .badge { display: inline-flex; align-items: center; min-height: 20px; border-radius: 999px; border: 1px solid var(--vscode-panel-border); padding: 1px 7px; font-size: 11px; white-space: nowrap; }
    .badge.workspace, .badge.manual { color: #bfdbfe; border-color: rgba(96,165,250,.6); }
    .badge.central, .badge.npx { color: #bbf7d0; border-color: rgba(52,211,153,.65); }
    .badge.mixed, .badge.different, .badge.needsDescription { color: #fde68a; border-color: rgba(250,204,21,.7); }
    .badge.brokenTargets { color: #fecaca; border-color: rgba(248,113,113,.75); }
    .badge.same { color: #cbd5e1; }
    .source-detail { max-width: min(520px, 80vw); overflow: hidden; text-overflow: ellipsis; }
    .group-detail { height: 100%; min-height: 0; display: grid; grid-template-rows: auto auto minmax(0, 1fr); gap: 7px; padding: 8px; overflow: hidden; }
    .group-detail.hidden { display: none; }
    .group-head { min-height: 0; display: grid; grid-template-columns: minmax(180px, 1fr) auto; gap: 7px; align-items: start; }
    .pill { border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 1px 7px; white-space: nowrap; }
    .meta { font-size: 11px; }
    .meta-inline { margin-left: 4px; color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 400; }
    .edit { display: grid; grid-template-columns: minmax(150px, 210px) minmax(220px, 1fr) auto; gap: 6px; align-items: start; }
    textarea { min-height: 30px; max-height: 92px; resize: vertical; }
    .skill-section { min-height: 0; overflow: auto; }
    .skill-section > summary { position: sticky; top: 0; z-index: 2; padding: 4px 0; background: var(--vscode-editor-background); cursor: pointer; }
    .skill-folders { display: grid; gap: 5px; padding-top: 5px; }
    .skill-folder { border: 1px solid var(--vscode-panel-border); border-radius: 6px; overflow: auto; background: color-mix(in oklab, var(--vscode-editor-background) 97%, var(--vscode-editor-foreground) 3%); }
    .skill-folder > summary { display: flex; gap: 7px; align-items: center; padding: 6px 8px; cursor: pointer; background: color-mix(in oklab, var(--vscode-editor-background) 94%, var(--vscode-editor-foreground) 6%); }
    .skill-folder input[type="checkbox"] { flex: 0 0 auto; }
    .folder-name, .folder-path, .path, .group-desc { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .folder-name { font-weight: 700; }
    .folder-path { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .folder-summary { padding: 6px 8px; border-top: 1px solid var(--vscode-panel-border); }
    table { width: 100%; border-collapse: collapse; font-size: 12px; table-layout: fixed; }
    thead { position: sticky; top: 0; z-index: 1; background: var(--vscode-sideBar-background); }
    th, td { text-align: left; padding: 5px 7px; border-top: 1px solid var(--vscode-panel-border); vertical-align: top; }
    th { color: var(--vscode-descriptionForeground); font-weight: 500; }
    .path { max-width: 360px; }
    .skill-folder table { min-width: 900px; }
    .skill-desc { max-width: 420px; overflow: hidden; text-overflow: ellipsis; }
    .empty { padding: 12px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; }
    .hidden { display: none; }
    @media (max-width: 960px) {
      .top { align-items: flex-start; flex-wrap: wrap; }
      .top-actions, .actions { justify-content: flex-start; }
      .toolbar { align-items: stretch; }
      #search { flex-basis: 100%; }
      .content { grid-template-rows: minmax(104px, min(24vh, 190px)) minmax(0, 1fr); }
      .group-head, .edit { grid-template-columns: 1fr; }
      .path { max-width: 68vw; }
    }
  `;
}
