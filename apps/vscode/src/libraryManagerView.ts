import type * as vscode from "vscode";
import type { UiLanguage } from "./uiLanguage";
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
  const title = lang === "ko" ? "스킬 라이브러리" : "Skill Library";
  const searchPlaceholder = lang === "ko" ? "스킬, 에이전트, 그룹 검색..." : "Search skills, agents, or groups...";

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
      <button id="refreshBtn">${lang === "ko" ? "새로고침" : "Refresh"}</button>
      <button id="languageBtn">${lang === "ko" ? "English" : "한국어"}</button>
    </div>

    <div class="tabs" role="tablist">
      <button class="tab active" data-view="compare">${lang === "ko" ? "비교" : "Compare"}</button>
      <button class="tab" data-view="workspace">${lang === "ko" ? "작업공간 상세" : "Workspace detail"}</button>
      <button class="tab" data-view="central">${lang === "ko" ? "중앙 상세" : "Central detail"}</button>
    </div>

    <div class="subtabs compare-pane">
      <button class="subtab active" data-mode="send">${lang === "ko" ? "작업공간을 중앙에 반영" : "Save Workspace to Central"}</button>
      <button class="subtab" data-mode="bring">${lang === "ko" ? "중앙에서 작업공간으로 가져오기" : "Bring Central to Workspace"}</button>
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
          <button id="selectVisibleBtn" class="ghost">${lang === "ko" ? "보이는 항목 선택" : "Select visible"}</button>
          <button id="clearSelectionBtn" class="ghost">${lang === "ko" ? "선택 해제" : "Clear"}</button>
          <button id="runSelectedBtn" class="primary">${lang === "ko" ? "선택 항목 반영" : "Apply selected"}</button>
        </div>
      </div>
      <div id="compareTable" class="table-wrap"></div>
    </section>

    <section class="panel detail-pane detail-panel workspace-detail">
      <div class="panel-head">
        <div class="panel-title">
          <strong>${lang === "ko" ? "작업공간 상세" : "Workspace detail"}</strong>
          <span>${lang === "ko" ? "현재 작업공간에 있는 스킬 목록입니다." : "Skills currently present in this workspace."}</span>
        </div>
        <div class="actions">
          <button class="primary" data-install-side="workspace" type="button">${lang === "ko" ? "작업공간에 스킬 추가" : "Add skills to Workspace"}</button>
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
          <strong>${lang === "ko" ? "중앙 상세" : "Central detail"}</strong>
          <span>${lang === "ko" ? "중앙 라이브러리에 있는 스킬 목록입니다." : "Skills currently present in the central library."}</span>
        </div>
        <div class="actions">
          <button class="primary" data-install-side="central" type="button">${lang === "ko" ? "중앙에 스킬 추가" : "Add skills to Central"}</button>
          <select id="centralAgentFilter"></select>
          <select id="centralGroupFilter"></select>
          <select id="centralStatusFilter"></select>
          <select id="centralSortFilter"></select>
        </div>
      </div>
      <div id="centralSummary" class="summary detail-summary"></div>
      <div id="centralDetail" class="table-wrap"></div>
    </section>

    <div id="statusLine" class="status sb-status-bar info">${lang === "ko" ? "준비 완료" : "Ready"}</div>
  </div>

  <script nonce="${nonce}">${renderLibraryManagerClientScript(initial, lang)}</script>
</body>
</html>`;
}
