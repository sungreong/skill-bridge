export function renderWebviewCommonStyles(): string {
  return `
    .sb-root {
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
    .sb-status-bar.warn { border-color: #f59e0b; color: #fbbf24; }
    .sb-status-bar.error { border-color: #ef4444; color: #fca5a5; }
    .sb-button {
      max-width: 100%;
      min-height: 28px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 5px;
      padding: 4px 8px;
      font: inherit;
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      background: var(--vscode-button-secondaryBackground, var(--vscode-input-background));
      cursor: pointer;
    }
    .sb-button:disabled { opacity: .55; cursor: not-allowed; }
    .sb-button-primary {
      border-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }
    .sb-button-danger {
      border-color: #ef4444;
      color: var(--vscode-errorForeground, #fca5a5);
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
      border-color: #60a5fa;
      color: var(--vscode-foreground);
      box-shadow: inset 0 0 0 1px rgba(96,165,250,.28);
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
    }
  `;
}
