export function renderLibraryManagerStyles(): string {
  return `
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      height: 100vh;
      overflow: hidden;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    .wrap {
      height: 100vh;
      min-height: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 8px 10px;
    }
    .topbar {
      min-width: 0;
      display: grid;
      grid-template-columns: auto minmax(180px, 1fr) auto auto;
      gap: 6px;
      align-items: center;
      flex: 0 0 auto;
    }
    .title {
      min-width: 0;
      font-size: 14px;
      font-weight: 760;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    input, select, button {
      max-width: 100%;
      min-height: 30px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 5px;
      padding: 4px 8px;
      font: inherit;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
    }
    button { cursor: pointer; }
    button:disabled { opacity: .5; cursor: default; }
    .primary {
      border-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }
    .danger {
      border-color: var(--sb-danger);
      color: var(--sb-danger);
    }
    .ghost {
      color: var(--vscode-descriptionForeground);
    }
    .tabs, .subtabs, .filters, .actions, .row-actions, .chips, .button-strip {
      min-width: 0;
      display: flex;
      gap: 5px;
      align-items: center;
      flex-wrap: wrap;
      flex: 0 0 auto;
    }
    .tab, .subtab, .chip {
      min-height: 26px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 4px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-descriptionForeground);
    }
    .tab.active, .subtab.active, .chip.active {
      border-color: var(--sb-accent);
      color: var(--vscode-foreground);
      box-shadow: inset 0 0 0 1px var(--sb-accent);
    }
    .button-strip {
      gap: 4px;
    }
    .panel-head .actions {
      justify-content: flex-end;
    }
    .subtabs {
      padding: 5px 7px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      background: color-mix(in oklab, var(--vscode-editor-background) 95%, var(--vscode-editor-foreground) 5%);
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(4, minmax(104px, 1fr));
      gap: 5px;
      flex: 0 0 auto;
      align-items: start;
    }
    .metric {
      min-width: 0;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 5px 8px;
      background: color-mix(in oklab, var(--vscode-editor-background) 96%, var(--vscode-editor-foreground) 4%);
    }
    .metric span {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .metric strong {
      display: block;
      margin-top: 1px;
      font-size: 15px;
      line-height: 1.1;
    }
    .metric-button {
      width: 100%;
      min-height: 42px;
      text-align: left;
      color: var(--vscode-foreground);
      cursor: pointer;
    }
    .metric-button.active {
      border-color: var(--sb-accent);
      box-shadow: inset 0 0 0 1px var(--sb-accent);
      background: var(--vscode-list-activeSelectionBackground);
    }
    .panel {
      min-height: 0;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 7px;
      overflow: hidden;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      background: color-mix(in oklab, var(--vscode-editor-background) 97%, var(--vscode-editor-foreground) 3%);
    }
    .compare-pane.panel,
    .detail-pane.panel {
      flex: 1 1 auto;
    }
    .detail-panel {
      grid-template-rows: auto auto minmax(0, 1fr);
    }
    .panel-head {
      min-width: 0;
      display: grid;
      grid-template-columns: minmax(180px, 1fr) auto;
      gap: 6px;
      align-items: center;
      padding: 6px 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
    }
    .panel-title {
      min-width: 0;
      display: grid;
      gap: 2px;
    }
    .panel-title strong {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
    }
    .panel-title span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .table-wrap {
      min-height: 0;
      overflow: auto;
    }
    .detail-summary {
      grid-template-columns: repeat(6, minmax(120px, 1fr));
      padding: 5px 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: color-mix(in oklab, var(--vscode-editor-background) 98%, var(--vscode-editor-foreground) 2%);
    }
    .detail-summary .metric {
      padding: 5px 7px;
    }
    .detail-summary .metric strong {
      font-size: 14px;
      line-height: 1.15;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      font-size: 12px;
    }
    thead {
      position: sticky;
      top: 0;
      z-index: 1;
      background: var(--vscode-sideBar-background);
    }
    th, td {
      border-bottom: 1px solid var(--vscode-panel-border);
      padding: 5px 7px;
      vertical-align: middle;
      text-align: left;
    }
    th {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
    }
    .check-col { width: 34px; }
    .check-col input,
    td:first-child input {
      display: block;
      width: 14px;
      height: 14px;
      min-height: 14px;
      margin: 0 auto;
      padding: 0;
    }
    .status-col { width: 120px; }
    .agent-col { width: 100px; }
    .count-col { width: 96px; }
    .date-col { width: 136px; }
    .action-col { width: 160px; }
    .detail-table {
      min-width: 1040px;
    }
    .date-cell {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--vscode-descriptionForeground);
      font-variant-numeric: tabular-nums;
    }
    .path {
      min-width: 0;
      display: grid;
      gap: 2px;
    }
    .path strong, .truncate {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .muted {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 20px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 11px;
      font-weight: 700;
      white-space: nowrap;
    }
    .b-new { color: var(--sb-success); border-color: var(--sb-success); }
    .b-modified { color: var(--sb-warning); border-color: var(--sb-warning); }
    .b-same { color: var(--vscode-descriptionForeground); border-color: var(--vscode-panel-border); }
    .b-target { color: var(--sb-accent); border-color: var(--sb-accent); }
    .empty {
      padding: 18px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .detail-pane {
      display: none;
      min-height: 0;
    }
    body.view-workspace .compare-pane,
    body.view-central .compare-pane { display: none; }
    body.view-workspace .workspace-detail,
    body.view-central .central-detail { display: grid; }
    .status {
      min-width: 0;
      flex: 0 0 auto;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 4px 7px;
      color: var(--vscode-descriptionForeground);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .status.warn { border-color: var(--sb-warning); color: var(--sb-warning); }
    .status.error { border-color: var(--sb-danger); color: var(--sb-danger); }
    @media (max-width: 980px) {
      .topbar, .panel-head { grid-template-columns: minmax(0, 1fr); }
      .summary, .detail-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .action-col, .count-col { width: auto; }
      table { min-width: 760px; }
    }
    @media (max-width: 640px) {
      .summary, .detail-summary { grid-template-columns: minmax(0, 1fr); }
      .tabs, .subtabs, .filters, .actions, .row-actions, .chips, .button-strip { align-items: stretch; }
      .status { white-space: normal; }
      input, select, button { min-height: 36px; }
      .panel-head .actions > #runSelectedBtn { flex: 1 1 100%; order: -1; }
      .panel-head .actions > #selectVisibleBtn,
      .panel-head .actions > #clearSelectionBtn { flex: 1 1 calc(50% - 3px); }
      table { min-width: 680px; }
    }
  `;
}
