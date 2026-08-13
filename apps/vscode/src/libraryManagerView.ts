import type * as vscode from "vscode";
import { localize, type UiLanguage } from "./uiLanguage";
import { renderLibraryManagerClientScript } from "./libraryManagerClientScript";
import { renderLibraryManagerStyles } from "./libraryManagerStyles";
import type { LibraryPayload } from "./libraryManagerTypes";
import { createWebviewNonce } from "./webviewCommon";
import { renderWebviewCommonStyles } from "./webviewCommonStyles";

export function renderLibraryManagerHtml(
  webview: vscode.Webview,
  data: LibraryPayload,
  language: UiLanguage = "en"
): string {
  void webview;
  const nonce = createWebviewNonce();
  const initial = JSON.stringify(data).replace(/</g, "\\u003c");
  const lang = language === "ko" ? "ko" : "en";
  const title = localize("Skill Library");
  const searchPlaceholder = localize("Search skills, agents, or groups...");

  return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>${renderWebviewCommonStyles()}${renderLibraryManagerStyles()}</style>
</head>
<body>
  <div class="wrap sb-root">
    <div class="topbar sb-topbar">
      <div class="title">${title}</div>
      <input id="searchInput" placeholder="${searchPlaceholder}" />
      <button id="refreshBtn" class="sb-button sb-button-ghost">${localize("Refresh")}</button>
    </div>

    <div class="tabs" role="tablist">
      <button class="tab active" data-view="compare">${localize("Compare")}</button>
      <button class="tab" data-view="workspace">${localize("Workspace detail")}</button>
      <button class="tab" data-view="central">${localize("Central detail")}</button>
    </div>

    <div class="subtabs compare-pane">
      <button class="subtab active" data-mode="send">${localize("Save Workspace to Central")}</button>
      <button class="subtab" data-mode="bring">${localize("Bring Central to Workspace")}</button>
    </div>

    <div id="summary" class="summary compare-pane"></div>

    <section class="panel compare-pane">
      <div class="panel-head">
        <div class="panel-title">
          <strong id="panelTitle"></strong>
          <span id="panelSubtitle"></span>
        </div>
        <div class="actions">
          <div id="statusButtons" class="button-strip"></div>
          <div id="agentButtons" class="button-strip"></div>
          <button id="selectVisibleBtn" class="ghost">${localize("Select visible")}</button>
          <button id="clearSelectionBtn" class="ghost">${localize("Clear")}</button>
          <button id="runSelectedBtn" class="primary sb-button sb-button-primary">${localize("Apply selected")}</button>
        </div>
      </div>
      <div id="compareTable" class="table-wrap"></div>
    </section>

    <section class="panel detail-pane detail-panel workspace-detail">
      <div class="panel-head">
        <div class="panel-title">
          <strong>${localize("Workspace detail")}</strong>
          <span>${localize("Skills currently present in this workspace.")}</span>
        </div>
        <div class="actions">
          <button class="primary" data-install-side="workspace" type="button">${localize("Add skills to Workspace")}</button>
          <select id="workspaceAgentFilter"></select>
          <select id="workspaceGroupFilter"></select>
          <select id="workspaceStatusFilter"></select>
          <select id="workspaceSortFilter"></select>
        </div>
      </div>
      <div id="workspaceSummary" class="summary detail-summary"></div>
      <div id="workspaceDetail" class="table-wrap"></div>
    </section>

    <section class="panel detail-pane detail-panel central-detail">
      <div class="panel-head">
        <div class="panel-title">
          <strong>${localize("Central detail")}</strong>
          <span>${localize("Skills currently present in the central library.")}</span>
        </div>
        <div class="actions">
          <button class="primary" data-install-side="central" type="button">${localize("Add skills to Central")}</button>
          <select id="centralAgentFilter"></select>
          <select id="centralGroupFilter"></select>
          <select id="centralStatusFilter"></select>
          <select id="centralSortFilter"></select>
        </div>
      </div>
      <div id="centralSummary" class="summary detail-summary"></div>
      <div id="centralDetail" class="table-wrap"></div>
    </section>

    <div id="statusLine" class="status sb-status-bar info">${localize("Ready")}</div>
  </div>

  <script nonce="${nonce}">${renderLibraryManagerClientScript(initial, lang)}</script>
</body>
</html>`;
}
