export function renderWebviewCommonStyles(): string {
  return `
    .sb-root {
      --sb-accent: var(--vscode-focusBorder, var(--vscode-button-background));
      --sb-success: var(--vscode-charts-green, var(--vscode-testing-iconPassed));
      --sb-warning: var(--vscode-editorWarning-foreground, var(--vscode-charts-yellow));
      --sb-danger: var(--vscode-errorForeground, var(--vscode-charts-red));
      height: 100vh;
      min-height: 0;
      box-sizing: border-box;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
    }
    .sb-root *, .sb-root *::before, .sb-root *::after { box-sizing: border-box; }
    .sb-topbar, .sb-toolbar {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      flex: 0 0 auto;
    }
    .sb-topbar { justify-content: space-between; }
    .sb-panel {
      min-height: 0;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 7px;
      background: color-mix(in oklab, var(--vscode-editor-background) 97%, var(--vscode-editor-foreground) 3%);
      overflow: hidden;
    }
    .sb-panel-head {
      min-width: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      padding: 6px 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
    }
    .sb-table-wrap {
      min-height: 0;
      overflow: auto;
      scrollbar-gutter: stable;
    }
    .sb-status-bar {
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
    .sb-status-bar.info { border-color: var(--vscode-panel-border); color: var(--vscode-descriptionForeground); }
    .sb-status-bar.warn { border-color: var(--sb-warning); color: var(--sb-warning); }
    .sb-status-bar.error { border-color: var(--sb-danger); color: var(--sb-danger); }
    .sb-button {
      max-width: 100%;
      min-height: 30px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 5px;
      padding: 4px 8px;
      font: inherit;
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      background: var(--vscode-button-secondaryBackground, var(--vscode-input-background));
      cursor: pointer;
    }
    .sb-button:disabled { opacity: .55; cursor: not-allowed; }
    .sb-button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
    .sb-button:focus-visible, .sb-chip:focus-visible {
      outline: 2px solid var(--sb-accent);
      outline-offset: 1px;
    }
    .sb-button-primary {
      border-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }
    .sb-button-primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    .sb-button-danger {
      border-color: var(--sb-danger);
      color: var(--sb-danger);
    }
    .sb-button-ghost {
      background: transparent;
      color: var(--vscode-descriptionForeground);
    }
    .sb-badge, .sb-chip {
      display: inline-flex;
      align-items: center;
      min-height: 20px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 11px;
      white-space: nowrap;
    }
    .sb-chip {
      min-height: 26px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-input-background);
    }
    .sb-chip.active {
      border-color: var(--sb-accent);
      color: var(--vscode-foreground);
      box-shadow: inset 0 0 0 1px var(--sb-accent);
    }
    .sb-muted {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .sb-empty {
      padding: 14px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    @media (max-width: 640px) {
      .sb-status-bar { white-space: normal; }
      .sb-button { min-height: 36px; }
      .sb-toolbar { align-items: stretch; }
      .sb-toolbar > input, .sb-toolbar > select { flex: 1 1 100%; min-width: 0; }
    }
  `;
}
