export function renderGroupOverviewStyles(): string {
  return `
    /* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V3 */
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; height: 100vh; overflow: hidden; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    .wrap { height: 100vh; min-height: 0; display: grid; grid-template-rows: auto auto auto minmax(0, 1fr) auto; gap: 7px; padding: 8px 10px; overflow: hidden; }
    .top { display: flex; justify-content: space-between; align-items: center; gap: 8px; min-width: 0; }
    .top-actions, .toolbar, .agent-filter, .actions, .action-buttons, .meta, .folder-summary, .batch-actions { min-width: 0; display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
    .top-actions, .actions { justify-content: flex-end; }
    h1, h2, h3 { margin: 0; font-weight: 650; }
    h1 { min-width: 0; font-size: 17px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    h2 { font-size: 14px; }
    h3 { font-size: 13px; }
    .summary { color: var(--vscode-descriptionForeground); font-size: 12px; white-space: nowrap; }
    .controls { min-height: 0; display: grid; gap: 5px; }
    .batch-actions { display: none; }
    .wrap[data-selection-mode="multiple"] .batch-actions { display: flex; }
    input, textarea, button { font: inherit; border: 1px solid var(--vscode-panel-border); border-radius: 5px; }
    input, textarea { background: var(--vscode-input-background); color: var(--vscode-input-foreground); padding: 5px 8px; }
    #search { width: min(520px, 100%); min-width: 0; flex: 1 1 260px; }
    button { min-height: 30px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); padding: 4px 8px; cursor: pointer; white-space: nowrap; }
    button:disabled { opacity: .55; cursor: not-allowed; }
    button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: var(--vscode-button-background); }
    .chip { min-height: 26px; border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 3px 9px; background: var(--vscode-input-background); color: var(--vscode-descriptionForeground); }
    .chip.active { border-color: var(--sb-accent); color: var(--vscode-foreground); box-shadow: inset 0 0 0 1px var(--sb-accent); }
    .agent-filter { max-height: 42px; overflow: auto; padding-right: 2px; scrollbar-gutter: stable; }
    .content { min-height: 0; min-width: 0; display: grid; grid-template-rows: minmax(112px, min(28vh, 230px)) minmax(0, 1fr); gap: 7px; }
    .single-group-view .controls,
    .single-group-view .agent-filter,
    .single-group-view .group-list,
    .single-group-view #summary { display: none; }
    .single-group-view .content { grid-template-rows: minmax(0, 1fr); }
    .single-group-view .detail-shell { border: 0; border-radius: 0; background: transparent; }
    .single-group-view .group-detail { padding: 3px 0 0; }
    .group-list, .detail-shell { min-height: 0; border: 1px solid var(--vscode-panel-border); border-radius: 7px; overflow: hidden; background: color-mix(in oklab, var(--vscode-editor-background) 97%, var(--vscode-editor-foreground) 3%); }
    .group-list, .detail-shell, .skill-section, .skill-folders { scrollbar-gutter: stable; }
    .group-list { overflow: auto; }
    .detail-shell { overflow: hidden; }
    .group-list table { min-width: 760px; }
    .filtered-agent-view .group-list table { min-width: 660px; }
    .filtered-agent-view .group-list th:first-child,
    .filtered-agent-view .group-list td:first-child { display: none; }
    .group-row { cursor: pointer; }
    .group-row:hover { background: var(--vscode-list-hoverBackground); }
    .group-row.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .group-row:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; }
    .group-check { width: 34px; }
    .group-check input { width: 14px; height: 14px; min-height: 14px; margin: 0; padding: 0; }
    .group-name { font-weight: 700; color: var(--vscode-foreground); }
    .group-title-line { min-width: 0; display: flex; align-items: baseline; gap: 6px; }
    .group-compact-meta { display: none; flex: 0 0 auto; color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 400; }
    .group-desc { max-width: 560px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); }
    .agent-label { color: var(--vscode-foreground); font-weight: 700; }
    .badge { display: inline-flex; align-items: center; min-height: 20px; border-radius: 999px; border: 1px solid var(--vscode-panel-border); padding: 1px 7px; font-size: 11px; white-space: nowrap; }
    .badge.workspace, .badge.manual { color: var(--sb-accent); border-color: var(--sb-accent); }
    .badge.central, .badge.npx { color: var(--sb-success); border-color: var(--sb-success); }
    .badge.mixed, .badge.different, .badge.needsDescription { color: var(--sb-warning); border-color: var(--sb-warning); }
    .badge.brokenTargets { color: var(--sb-danger); border-color: var(--sb-danger); }
    .badge.same { color: var(--vscode-descriptionForeground); }
    .actions { flex-direction: column; align-items: flex-end; gap: 3px; }
    .action-buttons { justify-content: flex-end; }
    .more-actions { position: relative; z-index: 4; }
    .more-actions > summary { min-height: 30px; display: inline-flex; align-items: center; cursor: pointer; color: var(--vscode-descriptionForeground); }
    .more-actions[open] > .more-actions-panel { position: absolute; top: calc(100% + 3px); right: 0; width: max-content; max-width: min(480px, 82vw); display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 5px; padding: 6px; border: 1px solid var(--vscode-panel-border); border-radius: 5px; background: var(--vscode-menu-background, var(--vscode-editor-background)); }
    .group-source-detail { max-width: min(640px, 72vw); margin-top: 4px; overflow: hidden; color: var(--vscode-textLink-foreground); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
    .group-facts { display: flex; align-items: center; gap: 0; margin-top: 5px; flex-wrap: wrap; font-size: 11px; }
    .group-facts > span + span::before { content: "·"; margin: 0 6px; color: var(--vscode-descriptionForeground); }
    .group-detail { height: 100%; min-height: 0; display: grid; grid-template-rows: auto auto minmax(0, 1fr); gap: 7px; padding: 8px; overflow: hidden; }
    .group-detail.hidden { display: none; }
    .group-head { min-height: 0; display: grid; grid-template-columns: minmax(180px, 1fr) auto; gap: 7px; align-items: start; }
    .pill { border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 1px 7px; white-space: nowrap; }
    .meta { font-size: 11px; }
    .transfer-help { max-width: 300px; font-size: 11px; text-align: right; }
    .meta-inline { margin-left: 4px; color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 400; }
    .group-edit > summary { color: var(--vscode-descriptionForeground); cursor: pointer; font-size: 12px; }
    .group-edit[open] > summary { margin-bottom: 8px; }
    .edit { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 12px; align-items: end; padding: 0 2px 4px; }
    .edit-field { min-width: 0; display: grid; gap: 4px; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .edit-field > input, .edit-field > textarea { width: 100%; color: var(--vscode-input-foreground); font-size: 12px; }
    .edit-name { grid-column: 1; }
    .edit-actions { grid-column: 2; display: flex; align-items: flex-end; }
    .edit-description { grid-column: 1 / -1; }
    .edit-description textarea { min-height: 88px; max-height: 220px; padding: 8px; line-height: 1.45; resize: vertical; }
    .edit-help { min-height: 1lh; line-height: 1.35; }
    .skill-section { min-height: 0; overflow: auto; }
    .skill-section > summary { position: sticky; top: 0; z-index: 2; padding: 4px 0; background: var(--vscode-editor-background); cursor: pointer; }
    .skill-folders { display: grid; gap: 0; padding-top: 5px; }
    .skill-folder { border-top: 1px solid var(--vscode-panel-border); overflow: hidden; background: transparent; }
    .skill-folder:last-child { border-bottom: 1px solid var(--vscode-panel-border); }
    .skill-folder > summary { display: flex; gap: 7px; align-items: center; padding: 7px 4px; cursor: pointer; background: transparent; }
    .skill-folder > summary:hover { background: var(--vscode-list-hoverBackground); }
    .skill-folder[open] > summary { background: color-mix(in oklab, var(--vscode-editor-background) 94%, var(--vscode-editor-foreground) 6%); }
    .skill-folder input[type="checkbox"] { flex: 0 0 auto; }
    .folder-name, .folder-path, .path, .group-desc { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .folder-name { font-weight: 700; }
    .folder-path { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .folder-summary { padding: 6px 4px; border-top: 1px solid var(--vscode-panel-border); }
    .skill-file-structure { border-top: 1px solid var(--vscode-panel-border); }
    .main-skill-file { display: grid; gap: 5px; padding: 9px 6px; background: color-mix(in oklab, var(--vscode-editor-background) 96%, var(--vscode-editor-foreground) 4%); }
    .main-file-heading, .main-file-meta { min-width: 0; display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
    .main-file-name { font-weight: 700; }
    .main-file-description { max-width: 78ch; display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; color: var(--vscode-foreground); line-height: 1.45; }
    .main-file-meta, .file-history { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .missing-main { color: var(--sb-warning); }
    .file-directory { border-top: 1px solid var(--vscode-panel-border); }
    .file-directory > summary { min-height: 30px; display: flex; align-items: center; gap: 5px; padding: 5px 6px; cursor: pointer; }
    .file-directory > summary:hover { background: var(--vscode-list-hoverBackground); }
    .file-directory-name { font-weight: 600; }
    .file-table { table-layout: fixed; }
    .file-table th:nth-child(1) { width: 34%; }
    .file-table th:nth-child(2) { width: 190px; }
    .file-table .skill-desc { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; table-layout: fixed; }
    thead { position: sticky; top: 0; z-index: 1; background: var(--vscode-sideBar-background); }
    th, td { text-align: left; padding: 5px 7px; border-top: 1px solid var(--vscode-panel-border); vertical-align: top; }
    th { color: var(--vscode-descriptionForeground); font-weight: 500; }
    .path { max-width: 360px; }
    .skill-folder .file-table { min-width: 0; table-layout: fixed; }
    .skill-desc { max-width: 420px; overflow: hidden; text-overflow: ellipsis; }
    .empty { padding: 12px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; }
    .hidden { display: none; }
    @media (min-width: 960px) {
      .multi-group-view .content { grid-template-columns: minmax(400px, .78fr) minmax(500px, 1.22fr); grid-template-rows: minmax(0, 1fr); gap: 8px; }
      .multi-group-view.filtered-agent-view .content { grid-template-columns: minmax(340px, .68fr) minmax(500px, 1.32fr); }
      .multi-group-view .group-list table { min-width: 0; }
      .multi-group-view .group-list th:nth-child(4),
      .multi-group-view .group-list td:nth-child(4),
      .multi-group-view .group-list th:nth-child(6),
      .multi-group-view .group-list td:nth-child(6),
      .multi-group-view .group-list th:nth-child(7),
      .multi-group-view .group-list td:nth-child(7) { display: none; }
      .multi-group-view .group-compact-meta { display: inline; }
      .multi-group-view .group-desc { max-width: 280px; }
    }
    @media (max-width: 960px) {
      .top { align-items: flex-start; flex-wrap: wrap; }
      .top-actions, .actions { justify-content: flex-start; }
      .toolbar { align-items: stretch; }
      #search { flex-basis: 100%; }
      .content { grid-template-rows: minmax(104px, min(24vh, 190px)) minmax(0, 1fr); }
      .group-head { grid-template-columns: 1fr; }
      .actions { align-items: flex-start; }
      .action-buttons { justify-content: flex-start; }
      .transfer-help { max-width: none; text-align: left; }
      .path { max-width: 68vw; }
    }
    @media (max-width: 640px) {
      .wrap { padding: 6px; }
      button { min-height: 36px; }
      .batch-actions .primary { flex: 1 1 100%; order: -1; }
      .group-list table { min-width: 720px; }
      .filtered-agent-view .group-list table { min-width: 620px; }
      .group-head .actions { display: grid; grid-template-columns: 1fr; }
      .action-buttons { display: grid; grid-template-columns: minmax(0, 1fr) auto; width: 100%; }
      .action-buttons > .primary { width: 100%; }
      .more-actions[open] > .more-actions-panel { justify-content: stretch; }
      .more-actions-panel button { flex: 1 1 100%; }
      .edit { grid-template-columns: minmax(0, 1fr); }
      .edit-name, .edit-actions, .edit-description { grid-column: 1; }
      .edit-actions { justify-content: flex-end; }
    }
  `;
}
