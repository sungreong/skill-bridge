import type * as vscode from "vscode";
import { buildTransferReviewMeta } from "./reviewPrompt";
import type { TransferPlan } from "./types";
import { localize, type UiLanguage } from "./uiLanguage";
import { createWebviewNonce, renderWebviewL10nRuntime } from "./webviewCommon";
import { renderWebviewClientCommonScript } from "./webviewClientCommon";
import { renderWebviewCommonStyles } from "./webviewCommonStyles";

export function renderTransferManagerHtml(webview: vscode.Webview, plan: TransferPlan, language: UiLanguage = "en"): string {
  void webview;
  const nonce = createWebviewNonce();
  const initial = JSON.stringify(plan).replace(/</g, "\\u003c");
  const reviewInitial = JSON.stringify(buildTransferReviewMeta(plan)).replace(/</g, "\\u003c");
  const workspaceToCentralTitle = JSON.stringify(localize("Workspace <span class=\"arrow\">→</span> Save to Central")).replace(/</g, "\\u003c");
  const centralToWorkspaceTitle = JSON.stringify(localize("Central <span class=\"arrow\">→</span> Bring to Workspace")).replace(/</g, "\\u003c");
  const isKo = language === "ko";
  return `<!doctype html>
<html lang="${language}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${localize("Review Changes")}</title>
  <style>
    /* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4 */
    /* Hallmark · macrostructure: Workbench · tone: utilitarian technical · anchor hue: VS Code semantic accent */
    ${renderWebviewCommonStyles()}
    html, body { height: 100%; overflow: clip; }
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; }
    .wrap { padding: 8px 10px; display: grid; gap: 6px; height: 100vh; height: 100dvh; box-sizing: border-box; grid-template-areas: "head" "error" "direction" "review" "toolbar" "table" "foot"; grid-template-rows: auto auto auto auto auto minmax(0, 1fr) auto; }
    .head { grid-area: head; }
    .fatal-error { grid-area: error; border: 1px solid var(--vscode-inputValidation-errorBorder, var(--sb-danger)); border-radius: 6px; padding: 8px 10px; color: var(--vscode-inputValidation-errorForeground, var(--vscode-foreground)); background: var(--vscode-inputValidation-errorBackground, var(--vscode-editor-background)); white-space: pre-wrap; overflow-wrap: anywhere; }
    .fatal-error[hidden] { display: none; }
    .direction-panel { grid-area: direction; }
    .review-panel { grid-area: review; }
    .toolbar { grid-area: toolbar; }
    .table-wrap { grid-area: table; }
    .foot { grid-area: foot; }
    .head { min-width: 0; display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
    .head h2 { min-width: 0; font-size: 17px; line-height: 1.2; overflow-wrap: anywhere; }
    .meta { font-size: 11px; opacity: 0.9; display: flex; gap: 8px; flex-wrap: wrap; }
    .direction-panel { min-width: 0; border: 1px solid var(--sb-accent); border-radius: 6px; padding: 6px 8px; display: grid; grid-template-columns: minmax(180px, auto) minmax(0, 1fr) auto auto; gap: 7px; align-items: center; background: var(--vscode-sideBar-background); }
    .direction-panel.import { background: var(--vscode-sideBar-background); }
    .direction-title { font-weight: 800; font-size: 13px; white-space: nowrap; }
    .direction-title .arrow { padding: 0 6px; color: var(--sb-accent); }
    .direction-panel.import .direction-title .arrow { color: var(--sb-accent); }
    .scope-line { min-width: 0; display: flex; flex-wrap: wrap; gap: 4px; align-items: center; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .scope-chip { border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 2px 7px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); max-width: min(620px, 60vw); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .scope-chip.locked { border-color: var(--sb-accent); color: var(--vscode-foreground); }
    .direction-panel.import .scope-chip.locked { border-color: var(--sb-accent); color: var(--vscode-foreground); }
    .scope-action, .compact-button { min-height: 26px; padding-block: 2px; font-size: 12px; white-space: nowrap; }
    .change-summary { display: inline-flex; align-items: center; gap: 0; color: var(--vscode-descriptionForeground); font-size: 11px; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .change-summary span { padding-inline: 7px; }
    .change-summary span + span { border-inline-start: 1px solid var(--vscode-panel-border); }
    .change-summary b { color: var(--vscode-foreground); font-size: 12px; }
    .review-panel { border-block: 1px solid var(--vscode-panel-border); padding-block: 5px; display: grid; gap: 4px; }
    .review-row, .review-strip { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; min-width: 0; font-size: 12px; }
    .review-row > .review-strip { flex: 1 1 420px; }
    .review-strip strong { margin-right: 2px; }
    .review-note { color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 180px; flex: 1 1 240px; }
    .risk-chip { display: inline-flex; align-items: center; gap: 4px; border-radius: 999px; border: 1px solid var(--vscode-panel-border); padding: 1px 7px; font-size: 11px; white-space: nowrap; }
    .risk-high { border-color: var(--sb-danger); color: var(--sb-danger); }
    .risk-medium { border-color: var(--sb-warning); color: var(--sb-warning); }
    .risk-low { border-color: var(--sb-success); color: var(--sb-success); }
    .risk-tags { display: flex; flex-wrap: wrap; gap: 4px; max-width: 360px; }
    .asset-details { border-top: 1px solid var(--vscode-panel-border); padding-top: 4px; }
    .asset-details summary { cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 12px; user-select: none; }
    .asset-details summary:hover { color: var(--vscode-foreground); }
    .asset-details summary:active { color: var(--sb-accent); }
    .asset-details summary:focus-visible { outline: 2px solid var(--sb-accent); outline-offset: 1px; }
    .asset-strip { display: grid; margin-top: 5px; max-height: 112px; overflow: auto; }
    .asset-row { min-width: 0; display: grid; grid-template-columns: minmax(160px, 1fr) auto auto; gap: 8px; align-items: center; padding: 5px 2px; border-top: 1px solid var(--vscode-panel-border); }
    .asset-row:first-child { border-top: 0; }
    .asset-row .name { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .asset-row .line { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; font-size: 11px; }
    .asset-empty { color: var(--vscode-descriptionForeground); font-size: 12px; padding: 4px 0; }
    .recommend-apply { color: var(--sb-success); border-color: var(--sb-success); }
    .recommend-inspect { color: var(--sb-warning); border-color: var(--sb-warning); }
    .recommend-skip { color: var(--sb-danger); border-color: var(--sb-danger); }
    .toolbar { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
    .toolbar input, .toolbar select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 4px 7px; min-height: 30px; font: inherit; }
    .toolbar input:hover, .toolbar select:hover { border-color: var(--vscode-focusBorder, var(--vscode-input-border)); }
    .toolbar input:focus-visible, .toolbar select:focus-visible, input[type="checkbox"]:focus-visible { outline: 2px solid var(--sb-accent); outline-offset: 1px; }
    .toolbar input:disabled, .toolbar select:disabled { opacity: .55; cursor: not-allowed; }
    .toolbar input { flex: 1 1 280px; min-width: 200px; }
    .selection-count { margin-inline-start: auto; color: var(--vscode-descriptionForeground); font-size: 12px; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .selection-count b { color: var(--vscode-foreground); }
    .table-wrap { border: 1px solid var(--vscode-panel-border); border-radius: 6px; overflow: auto; min-height: 160px; scrollbar-gutter: stable; }
    table { width: max-content; min-width: 100%; border-collapse: collapse; font-size: 12px; }
    thead { background: var(--vscode-sideBar-background); }
    thead th { position: sticky; top: 0; z-index: 1; background: var(--vscode-sideBar-background); white-space: nowrap; }
    th, td { padding: 5px 7px; border-bottom: 1px solid var(--vscode-panel-border); text-align: left; }
    tbody tr:hover { background: var(--vscode-list-hoverBackground); }
    tbody tr.group-row td { background: var(--vscode-sideBar-background); border-top: 1px solid var(--vscode-panel-border); }
    tbody tr.group-row:first-child td { border-top: 0; }
    .group-row .path-main { font-weight: 800; }
    .group-row .path-sub { color: var(--vscode-descriptionForeground); }
    .group-select { display: inline-flex; align-items: center; gap: 4px; }
    .expand-toggle { width: 22px; min-width: 22px; height: 22px; padding: 0; border: 0; color: var(--vscode-foreground); background: transparent; cursor: pointer; border-radius: 3px; }
    .expand-toggle:hover { background: var(--vscode-toolbar-hoverBackground); }
    .expand-toggle:focus-visible { outline: 2px solid var(--sb-accent); outline-offset: 1px; }
    .file-row .item-cell { padding-inline-start: 30px; position: relative; }
    .file-row .item-cell::before { content: "└"; position: absolute; inset-inline-start: 12px; color: var(--vscode-descriptionForeground); }
    .status-added { color: var(--sb-success); }
    .status-removed { color: var(--sb-danger); }
    .status-modified { color: var(--sb-warning); }
    .status-typeChanged { color: var(--sb-danger); }
    .status-same { color: var(--vscode-descriptionForeground); }
    .change-code { font-weight: 800; font-size: 13px; }
    .path-main { max-width: 420px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: inline-block; vertical-align: bottom; }
    .path-sub { opacity: 0.85; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; max-width: 580px; }
    .time-cell { white-space: nowrap; font-variant-numeric: tabular-nums; }
    .row-action { min-height: 26px; padding-block: 2px; font-size: 12px; white-space: nowrap; }
    .action-empty { display: inline-block; min-width: 32px; color: var(--vscode-descriptionForeground); text-align: center; }
    .foot { position: sticky; bottom: 0; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 7px 2px 0; border-top: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); }
    .foot-copy { min-width: 0; display: grid; gap: 3px; }
    .impact-summary { color: var(--vscode-foreground); font-size: 12px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
    .feedback.sb-status-bar { border: 0; border-radius: 0; padding: 0; font-size: 11px; }
    .feedback.warn { color: var(--sb-warning); }
    .feedback.info { color: var(--vscode-descriptionForeground); }
    .foot-actions { display: inline-flex; justify-content: flex-end; gap: 8px; align-items: center; }
    .foot-actions .sb-button { padding-inline: 12px; font-weight: 700; white-space: nowrap; }
    .sb-button:active:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-activeSelectionBackground)); }
    .sb-button-primary:active:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    @media (pointer: coarse) {
      .sb-button, .toolbar input, .toolbar select { min-height: 44px; }
    }
    @media (max-width: 60rem) {
      .direction-panel { grid-template-columns: minmax(0, 1fr) auto; align-items: start; }
      .direction-title { white-space: normal; }
      .scope-chip { max-width: 100%; }
      .scope-line { grid-column: 1 / -1; }
      .change-summary { justify-self: start; }
      .foot { grid-template-columns: 1fr; }
      .foot-actions { justify-content: stretch; }
      .foot-actions .sb-button { flex: 1 1 0; }
    }
    @media (max-width: 40rem) {
      .wrap { padding: 6px; }
      .meta { display: none; }
      .direction-panel { grid-template-columns: minmax(0, 1fr) auto; }
      .scope-line, .change-summary { grid-column: 1 / -1; }
      .asset-row { grid-template-columns: minmax(0, 1fr); gap: 4px; }
      .review-note { min-width: 100%; white-space: normal; }
      .toolbar input { min-width: 100%; }
      .selection-count { margin-inline-start: 0; flex: 1 1 100%; }
      .toolbar .sb-button { flex: 1 1 calc(50% - 3px); }
      table, tbody { display: block; width: 100%; min-width: 0; }
      thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
      tbody { display: grid; gap: 6px; padding: 6px; }
      tbody tr { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; grid-template-areas: "select item action" ". status action" ". review review" ". source source" ". target target"; gap: 4px 8px; padding: 7px; border: 1px solid var(--vscode-panel-border); border-radius: 5px; }
      tbody tr:hover { background: var(--vscode-list-hoverBackground); }
      tbody td { min-width: 0; padding: 0; border-bottom: 0; }
      .row-select { grid-area: select; }
      .item-cell { grid-area: item; }
      .status-cell { grid-area: status; }
      .review-cell { grid-area: review; }
      .source-time { grid-area: source; }
      .target-time { grid-area: target; }
      .action-cell { grid-area: action; align-self: start; }
      .status-cell::before, .review-cell::before, .time-cell::before { content: attr(data-label) ": "; color: var(--vscode-descriptionForeground); font-weight: 400; }
      .path-main, .path-sub { max-width: 100%; }
      .risk-tags { display: inline-flex; max-width: 100%; vertical-align: middle; }
      .foot-actions { flex-direction: column-reverse; }
      .foot-actions .sb-button { width: 100%; min-height: 40px; }
      .impact-summary { white-space: normal; }
    }
  </style>
</head>
<body>
  <div class="wrap sb-root">
    <div class="head sb-topbar">
      <h2 style="margin:0;">${localize("Review Changes")}</h2>
      <div class="meta">
        <span id="groupLabel"></span>
        <span id="repoLabel"></span>
      </div>
    </div>
    <div id="fatalError" class="fatal-error" role="alert" aria-live="assertive" hidden></div>
    <div id="directionPanel" class="direction-panel">
      <div id="directionTitle" class="direction-title"></div>
      <div class="scope-line">
        <span>${localize("Current scope")}</span>
        <span id="scopeLabel" class="scope-chip"></span>
        <span id="scopeCount"></span>
      </div>
      <div class="change-summary" aria-label="${localize("Change summary")}">
        <span>${localize("New")} <b id="sumAdded">0</b></span>
        <span>${localize("Changed")} <b id="sumChanged">0</b></span>
      </div>
      <button id="expandScopeBtn" class="scope-action sb-button sb-button-ghost">${localize("Show All")}</button>
    </div>
    <div class="review-panel">
      <div class="review-row">
        <div id="reviewStrip" class="review-strip">${localize("Calculating review summary…")}</div>
        <button id="copyReviewPrompt" class="compact-button sb-button sb-button-ghost">${localize("Copy for AI Review")}</button>
      </div>
      <details id="assetDetails" class="asset-details">
        <summary id="assetSummary">${localize("Show per-skill review hints")}</summary>
        <div id="assetStrip" class="asset-strip"></div>
      </details>
    </div>
    <div class="toolbar sb-toolbar">
      <input id="search" aria-label="${localize("Search skill or file path")}" placeholder="${localize("Search skill or file path…")}" />
      <select id="statusFilter" aria-label="${localize("Change status filter")}">
        <option value="">${localize("All statuses")}</option>
        <option value="added">${localize("New")}</option>
        <option value="removed">${localize("Delete")}</option>
        <option value="modified">${localize("Modified")}</option>
        <option value="typeChanged">${localize("Type conflict")}</option>
      </select>
      <span class="selection-count">${localize("Selected")} <b id="sumSelectedApply">0</b> ${localize("skills")} · <b id="sumSelectedFiles">0</b> ${localize("files")}</span>
      <button id="bulkSelectAll" class="sb-button">${localize("Select All")}</button>
      <button id="bulkConflict" class="sb-button">${localize("Select Changes")}</button>
      <button id="refreshPlan" class="sb-button sb-button-ghost">${localize("Refresh")}</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th><input id="toggleAllRows" type="checkbox" aria-label="${localize("Select or clear all visible rows")}" title="${localize("Select or clear all visible rows")}"></th>
            <th>${localize("Item and change")}</th>
            <th>${localize("Status")}</th>
            <th>${localize("Review hint")}</th>
            <th class="source-time">${localize("Source modified")}</th>
            <th class="target-time">${localize("Target modified")}</th>
            <th>${localize("Action")}</th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
    <div class="foot">
      <div class="foot-copy">
        <div class="impact-summary" id="predictText">${localize("Expected result: create 0 / overwrite 0 / delete 0")}</div>
        <div id="feedback" class="feedback sb-status-bar info" aria-live="polite">${localize("Select changes, then review the expected result.")}</div>
      </div>
      <div class="foot-actions">
        <button id="cancelBtn" class="sb-button sb-button-ghost">${localize("Cancel")}</button>
        <button id="applyBtn" class="sb-button sb-button-primary">${localize("Apply Selected Changes")}</button>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">
    (() => {
      const vscode = acquireVsCodeApi();
      const errorPrefix = ${JSON.stringify(localize("Change review screen error: {0}", "{0}"))};
      const fallbackMessage = ${JSON.stringify(localize("Unknown error"))};
      let lastReport = "";
      const report = (detail) => {
        const message = String(detail?.message || fallbackMessage);
        const line = Number(detail?.line || 0);
        const column = Number(detail?.column || 0);
        const location = line > 0 ? " (line " + line + (column > 0 ? ", column " + column : "") + ")" : "";
        const reportKey = message + location;
        if (reportKey === lastReport) return;
        lastReport = reportKey;
        const element = document.getElementById("fatalError");
        if (element) {
          element.hidden = false;
          element.textContent = errorPrefix.replace("{0}", message + location);
        }
        try {
          vscode.postMessage({ type: "clientError", payload: { message, line, column } });
        } catch {
          // The visible error remains available even if host messaging fails.
        }
      };
      window.addEventListener("error", (event) => report({
        message: event.message,
        line: event.lineno,
        column: event.colno
      }));
      window.addEventListener("unhandledrejection", (event) => report({
        message: event.reason?.message || event.reason
      }));
      window.__skillBridgeTransferManager = { vscode, report };
    })();
  </script>
  <script nonce="${nonce}">
    ${renderWebviewClientCommonScript()}
    const vscode = window.__skillBridgeTransferManager.vscode;
    const state = ${initial};
    const reviewMeta = ${reviewInitial};
    const language = ${JSON.stringify(language)};
    vscode.postMessage({ type: "initPlan" });
    const ui = {
      rows: document.getElementById("rows"),
      search: document.getElementById("search"),
      status: document.getElementById("statusFilter"),
      sumAdded: document.getElementById("sumAdded"),
      sumChanged: document.getElementById("sumChanged"),
      sumSelectedApply: document.getElementById("sumSelectedApply"),
      sumSelectedFiles: document.getElementById("sumSelectedFiles"),
      reviewStrip: document.getElementById("reviewStrip"),
      assetSummary: document.getElementById("assetSummary"),
      assetStrip: document.getElementById("assetStrip"),
      directionPanel: document.getElementById("directionPanel"),
      directionTitle: document.getElementById("directionTitle"),
      scopeLabel: document.getElementById("scopeLabel"),
      scopeCount: document.getElementById("scopeCount"),
      expandScopeBtn: document.getElementById("expandScopeBtn"),
      groupLabel: document.getElementById("groupLabel"),
      repoLabel: document.getElementById("repoLabel"),
      feedback: document.getElementById("feedback"),
      predictText: document.getElementById("predictText")
    };
    ${renderWebviewL10nRuntime()}
    function fmtDate(v){
      if (!v) return "-";
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) return String(v);
      const p = (n) => String(n).padStart(2, "0");
      return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    }
    function esc(v){ return String(v ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;"); }
    function getSkillFolderName(rel){
      const normalized = String(rel || "").replaceAll("\\\\", "/");
      const parts = normalized.split("/").filter(Boolean);
      const idx = parts.indexOf("skills");
      if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
      return normalized;
    }
    function getDisplayPath(it){
      const base = getSkillFolderName(it.relativePath);
      if (it.entryKind === "folder") return it.tool + " / " + base;
      const fileName = String(it.relativePath || "").replaceAll("\\\\", "/").split("/").pop() || "";
      return fileName ? (it.tool + " / " + base + " / " + fileName) : (it.tool + " / " + base);
    }
    function getChildDisplayPath(it){
      const normalized = String(it.relativePath || "").replaceAll("\\\\", "/");
      const parts = normalized.split("/").filter(Boolean);
      const skillIndex = parts.indexOf("skills");
      return skillIndex >= 0 ? parts.slice(skillIndex + 2).join("/") || getSkillFolderName(normalized) : normalized;
    }
    function getEntryKindLabel(kind){
      if (kind === "folder") return t("folder");
      if (kind === "file") return t("file");
      return String(kind || "");
    }
    function getStatusLabel(status){
      if (status === "added") return t("New");
      if (status === "removed") return t("Delete");
      if (status === "modified") return t("Modified");
      if (status === "typeChanged") return t("Type conflict");
      return t("Same");
    }
    function getStatusClass(status){
      if (status === "added") return "status-added";
      if (status === "removed") return "status-removed";
      if (status === "modified") return "status-modified";
      if (status === "typeChanged") return "status-typeChanged";
      return "status-same";
    }
    function getReview(it){
      return reviewMeta.items[it.key] || { severity: "low", tags: [t("General change")], notes: [], checklist: [] };
    }
    function getRiskCounts(items){
      return items.reduce((acc, it) => {
        const sev = getReview(it).severity;
        acc[sev] = (acc[sev] || 0) + 1;
        return acc;
      }, { high: 0, medium: 0, low: 0 });
    }
    function renderRiskTags(it){
      const review = getReview(it);
      const tags = Array.isArray(review.tags) && review.tags.length > 0 ? review.tags : [t("General change")];
      const severityLabel = review.severity === "high"
        ? t("High")
        : review.severity === "medium"
          ? t("Medium")
          : t("Low");
      return '<div class="risk-tags"><span class="risk-chip risk-' + esc(review.severity) + '">' + esc(severityLabel) + '</span>' + tags.slice(0, 3).map(tag => '<span class="risk-chip">' + esc(tag) + '</span>').join("") + '</div>';
    }
    function getSourceTargetLabels(){
      if (state.mode === "workspaceToCentral") {
        return { source: t("Workspace (current)"), target: t("Central (after apply)") };
      }
      return { source: t("Central (current)"), target: t("Workspace (after apply)") };
    }
    function getDecisionText(it){
      const labels = getSourceTargetLabels();
      if (it.status === "added") return labels.source + t(" exists; ") + labels.target + t(" is missing");
      if (it.status === "removed") return labels.source + t(" is missing; ") + labels.target + t(" exists");
      if (it.status === "modified") return t("Both sides exist; content differs");
      if (it.status === "typeChanged") return t("Type mismatch (file/folder)");
      return t("Both sides match");
    }
    function getStatsBaseItems(items){
      const files = items.filter(it => it.entryKind === "file");
      return files.length > 0 ? files : items;
    }
    const expandedGroups = new Set();
    function buildSkillGroups(items){
      const groups = new Map();
      for (const it of items) {
        const folder = getSkillFolderName(it.relativePath);
        const key = it.tool + "::" + folder;
        const group = groups.get(key) || { key, tool: it.tool, folder, items: [], folderItems: [], files: [] };
        group.items.push(it);
        if (it.entryKind === "folder") group.folderItems.push(it);
        else group.files.push(it);
        groups.set(key, group);
      }
      return Array.from(groups.values()).map(group => {
        group.folderItems.sort((left, right) => left.relativePath.length - right.relativePath.length || left.relativePath.localeCompare(right.relativePath));
        group.files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
        group.primaryFolder = group.folderItems[0] || null;
        return group;
      }).sort((left, right) => left.tool.localeCompare(right.tool) || left.folder.localeCompare(right.folder));
    }
    function groupBaseItems(group){
      return group.files.length > 0 ? group.files : group.primaryFolder ? [group.primaryFolder] : [];
    }
    function summarizeGroupStatus(group){
      const statuses = new Set(groupBaseItems(group).map(it => it.status));
      if (statuses.has("typeChanged")) return "typeChanged";
      if (statuses.has("modified")) return "modified";
      if (statuses.has("added") && statuses.has("removed")) return "modified";
      if (statuses.has("added")) return "added";
      if (statuses.has("removed")) return "removed";
      return "same";
    }
    function groupSelection(group){
      if (group.primaryFolder?.selected) return { checked: true, indeterminate: false };
      const selectable = groupBaseItems(group).filter(it => it.status !== "same");
      const selected = selectable.filter(it => it.selected).length;
      return {
        checked: selectable.length > 0 && selected === selectable.length,
        indeterminate: selected > 0 && selected < selectable.length
      };
    }
    function setGroupSelected(group, selected){
      for (const it of group.items) it.selected = selected && it.status !== "same";
    }
    function syncGroupParentSelection(group){
      for (const folder of group.folderItems) folder.selected = false;
      const selectableFiles = group.files.filter(it => it.status !== "same");
      if (group.primaryFolder && selectableFiles.length > 0 && selectableFiles.every(it => it.selected)) {
        group.primaryFolder.selected = true;
      }
    }
    function selectedReviewItems(groups){
      return groups.flatMap(group => {
        const selectedFiles = group.files.filter(it => it.selected && it.status !== "same");
        if (selectedFiles.length > 0) return selectedFiles;
        return group.primaryFolder?.selected && group.primaryFolder.status !== "same" ? [group.primaryFolder] : [];
      });
    }
    function groupSeverity(group, selectedOnly = false){
      const candidates = groupBaseItems(group).filter(it => !selectedOnly || it.selected || group.primaryFolder?.selected);
      const severities = candidates.map(it => getReview(it).severity);
      return severities.includes("high") ? "high" : severities.includes("medium") ? "medium" : "low";
    }
    function groupRiskCounts(groups){
      return groups.reduce((counts, group) => {
        if (!groupSelection(group).checked && !groupSelection(group).indeterminate) return counts;
        const severity = groupSeverity(group, true);
        counts[severity] += 1;
        return counts;
      }, { high: 0, medium: 0, low: 0 });
    }
    function latestGroupTime(group, field){
      const timestamps = groupBaseItems(group).map(it => Date.parse(it[field] || "")).filter(Number.isFinite);
      return timestamps.length > 0 ? new Date(Math.max(...timestamps)).toISOString() : null;
    }
    function filteredGroups(){
      const q = ui.search.value.trim().toLowerCase();
      const status = ui.status.value;
      return buildSkillGroups(state.items).filter(group => {
        const baseItems = groupBaseItems(group);
        const statusMatch = !status || baseItems.some(it => it.status === status);
        const searchMatch = !q
          || (group.tool + " / " + group.folder).toLowerCase().includes(q)
          || group.items.some(it => String(it.relativePath).toLowerCase().includes(q));
        return statusMatch && searchMatch;
      });
    }
    function visibleGroupFiles(group){
      const q = ui.search.value.trim().toLowerCase();
      const status = ui.status.value;
      if (!expandedGroups.has(group.key) && !q && !status) return [];
      return group.files.filter(it => {
        if (status && it.status !== status) return false;
        if (q && !String(it.relativePath).toLowerCase().includes(q) && !(group.tool + " / " + group.folder).toLowerCase().includes(q)) return false;
        return true;
      });
    }
    function buildAssetSummaries(items){
      const groups = new Map();
      for (const it of items) {
        const folder = getSkillFolderName(it.relativePath);
        const key = it.tool + "::" + folder;
        const bucket = groups.get(key) || { tool: it.tool, folder, items: [] };
        bucket.items.push(it);
        groups.set(key, bucket);
      }
      return Array.from(groups.values()).map(group => {
        const changed = group.items.filter(it => it.status !== "same");
        const statuses = new Set(changed.map(it => it.status));
        const reviewItems = group.items.map(it => getReview(it));
        const hasHigh = reviewItems.some(item => item.severity === "high");
        const hasMedium = reviewItems.some(item => item.severity === "medium");
        let status = t("Same");
        if (statuses.has("typeChanged")) status = t("Type conflict");
        else if (statuses.has("removed")) status = t("Delete candidate");
        else if (statuses.has("modified")) status = t("Modified");
        else if (statuses.has("added")) status = t("New skill");
        let recommendation = t("Safe to apply");
        let recommendClass = "recommend-apply";
        if (statuses.has("removed")) {
          recommendation = t("Skip recommended");
          recommendClass = "recommend-skip";
        } else if (statuses.has("typeChanged") || hasHigh || hasMedium) {
          recommendation = t("Inspect diff first");
          recommendClass = "recommend-inspect";
        }
        return {
          key: group.tool + "/" + group.folder,
          tool: group.tool,
          folder: group.folder,
          status,
          changedCount: changed.length,
          highCount: reviewItems.filter(item => item.severity === "high").length,
          mediumCount: reviewItems.filter(item => item.severity === "medium").length,
          recommendation,
          recommendClass
        };
      }).sort((a, b) => {
        const rank = (item) => item.highCount > 0 ? 0 : item.mediumCount > 0 ? 1 : item.changedCount > 0 ? 2 : 3;
        const diff = rank(a) - rank(b);
        if (diff !== 0) return diff;
        return a.key.localeCompare(b.key);
      });
    }
    function syncMasterToggle(){
      const visible = filteredGroups().filter(group => summarizeGroupStatus(group) !== "same");
      const master = document.getElementById("toggleAllRows");
      if (!(master instanceof HTMLInputElement)) return;
      if (visible.length === 0) {
        master.checked = false;
        master.indeterminate = false;
        return;
      }
      const states = visible.map(groupSelection);
      const selected = states.filter(item => item.checked).length;
      master.checked = selected === visible.length;
      master.indeterminate = states.some(item => item.indeterminate) || (selected > 0 && selected < visible.length);
    }
    function syncRenderedGroupToggles(){
      const groups = buildSkillGroups(state.items);
      ui.rows.querySelectorAll('input[data-kind="toggle-group"]').forEach(input => {
        if (!(input instanceof HTMLInputElement)) return;
        const group = groups.find(item => item.key === input.dataset.groupKey);
        if (!group) return;
        const selection = groupSelection(group);
        input.checked = selection.checked;
        input.indeterminate = selection.indeterminate;
      });
    }
    function renderGroupRows(group){
      const status = summarizeGroupStatus(group);
      const statusLabel = getStatusLabel(status);
      const statusClass = getStatusClass(status);
      const selection = groupSelection(group);
      const checked = selection.checked ? "checked" : "";
      const expanded = expandedGroups.has(group.key) || !!ui.search.value.trim() || !!ui.status.value;
      const changedFiles = group.files.filter(it => it.status !== "same").length;
      const detail = group.files.length > 0
        ? t("Changed ") + changedFiles + " " + t("files")
        : t("Folder-level apply");
      const severity = groupSeverity(group);
      const severityLabel = severity === "high" ? t("High") : severity === "medium" ? t("Medium") : t("Low");
      const summaryKeys = group.items.map(it => it.key);
      const expandControl = group.files.length > 0
        ? '<button class="expand-toggle" data-kind="toggle-expand" data-group-key="' + esc(group.key) + '" aria-expanded="' + String(expanded) + '" title="' + esc(expanded ? t("Collapse skill details") : t("Expand skill details")) + '">' + (expanded ? "▾" : "▸") + '</button>'
        : '<span class="expand-toggle" aria-hidden="true"></span>';
      const actionHtml = status === "same"
        ? '<span class="action-empty" title="' + esc(t("No differences")) + '">—</span>'
        : '<button class="row-action sb-button" data-kind="diff-folder-summary" data-tool="' + esc(group.tool) + '" data-folder="' + esc(group.folder) + '" data-summary-keys="' + esc(summaryKeys.join(",")) + '">' + esc(t("Summary Diff")) + '</button>';
      const sourceTime = latestGroupTime(group, "srcMtime");
      const targetTime = latestGroupTime(group, "dstMtime");
      const groupRow = \`<tr class="group-row" data-group-key="\${esc(group.key)}" aria-level="1">
        <td class="row-select"><span class="group-select">\${expandControl}<input type="checkbox" aria-label="\${esc(group.tool + " / " + group.folder + t(" select"))}" data-kind="toggle-group" data-group-key="\${esc(group.key)}" \${checked}></span></td>
        <td class="item-cell" title="\${esc(group.tool + " / " + group.folder)}"><span class="path-main">📁 \${esc(group.tool)} / \${esc(group.folder)}</span><span class="path-sub">\${esc(detail)}</span></td>
        <td class="status-cell change-code \${esc(statusClass)}" data-label="\${esc(t("Status"))}">\${esc(statusLabel)}</td>
        <td class="review-cell" data-label="\${esc(t("Review"))}"><div class="risk-tags"><span class="risk-chip risk-\${esc(severity)}">\${esc(severityLabel)}</span><span class="risk-chip">\${esc(detail)}</span></div></td>
        <td class="time-cell source-time" data-label="\${esc(t("Source"))}" title="\${esc(sourceTime ?? "-")}">\${esc(fmtDate(sourceTime))}</td>
        <td class="time-cell target-time" data-label="\${esc(t("Target"))}" title="\${esc(targetTime ?? "-")}">\${esc(fmtDate(targetTime))}</td>
        <td class="action-cell">\${actionHtml}</td>
      </tr>\`;
      const fileRows = visibleGroupFiles(group).map(it => {
        const fileChecked = it.selected ? "checked" : "";
        const fileStatusLabel = getStatusLabel(it.status);
        const fileStatusClass = getStatusClass(it.status);
        const fileAction = it.status === "same"
          ? '<span class="action-empty" title="' + esc(t("No differences")) + '">—</span>'
          : '<button class="row-action sb-button" data-kind="diff" data-key="' + esc(it.key) + '">' + esc(t("View Diff")) + '</button>';
        return \`<tr class="file-row" data-parent-group="\${esc(group.key)}" aria-level="2">
          <td class="row-select"><input type="checkbox" aria-label="\${esc(getChildDisplayPath(it) + t(" select"))}" data-kind="toggle-file" data-key="\${esc(it.key)}" \${fileChecked} \${it.status === "same" ? "disabled" : ""}></td>
          <td class="item-cell" title="\${esc(it.relativePath)} | \${esc(it.src)} -> \${esc(it.dst)}"><span class="path-main">\${esc(getChildDisplayPath(it))}</span><span class="path-sub">\${esc(getDecisionText(it))}</span></td>
          <td class="status-cell change-code \${esc(fileStatusClass)}" data-label="\${esc(t("Status"))}">\${esc(fileStatusLabel)}</td>
          <td class="review-cell" data-label="\${esc(t("Review"))}">\${renderRiskTags(it)}</td>
          <td class="time-cell source-time" data-label="\${esc(t("Source"))}" title="\${esc(it.srcMtime ?? "-")}">\${esc(fmtDate(it.srcMtime))}</td>
          <td class="time-cell target-time" data-label="\${esc(t("Target"))}" title="\${esc(it.dstMtime ?? "-")}">\${esc(fmtDate(it.dstMtime))}</td>
          <td class="action-cell">\${fileAction}</td>
        </tr>\`;
      }).join("");
      return groupRow + fileRows;
    }
    function setFeedback(message, tone){
      ui.feedback.textContent = message;
      ui.feedback.className = "feedback sb-status-bar " + (tone || "info");
    }
    function render(){
      const isExport = state.mode === "workspaceToCentral";
      ui.directionPanel.className = "direction-panel" + (isExport ? "" : " import");
      ui.directionTitle.innerHTML = isExport
        ? ${workspaceToCentralTitle}
        : ${centralToWorkspaceTitle};
      const scope = state.scopeContext || { type: "all", label: isExport ? t("All Workspace") : t("All Central"), count: 0, expandable: false };
      ui.scopeLabel.textContent = scope.label || (isExport ? t("All Workspace") : t("All Central"));
      ui.scopeLabel.className = "scope-chip" + (scope.type === "all" ? "" : " locked");
      ui.scopeCount.textContent = scope.count ? t("Targets ") + scope.count : t("Full scope");
      ui.expandScopeBtn.style.display = scope.expandable ? "" : "none";
      ui.groupLabel.textContent = state.groupContext ? (t("Group: ") + state.groupContext.name) : "";
      ui.repoLabel.textContent = state.repoContext ? (t("Repo: ") + state.repoContext.repo) : "";
      const baseSummaryItems = getStatsBaseItems(state.items);
      const added = baseSummaryItems.filter(it => it.status === "added").length;
      const modified = baseSummaryItems.filter(it => it.status === "modified").length;
      const typeChanged = baseSummaryItems.filter(it => it.status === "typeChanged").length;
      const skillGroups = buildSkillGroups(state.items);
      const selectedGroups = skillGroups.filter(group => {
        const selection = groupSelection(group);
        return selection.checked || selection.indeterminate;
      });
      const selectedItems = selectedReviewItems(skillGroups);
      const selectedCount = selectedGroups.length;
      const selectedFileCount = selectedItems.filter(it => it.entryKind === "file").length;
      const selectedBaseItems = getStatsBaseItems(selectedItems);
      const predictedCreate = selectedBaseItems.filter(it => it.status === "added").length;
      const predictedOverwrite = selectedBaseItems.filter(it => it.status === "modified" || it.status === "typeChanged").length;
      const predictedDelete = selectedBaseItems.filter(it => it.status === "removed").length;
      const riskCounts = groupRiskCounts(skillGroups);
      ui.sumAdded.textContent = String(added);
      ui.sumChanged.textContent = String(modified + typeChanged);
      ui.sumSelectedApply.textContent = String(selectedCount);
      ui.sumSelectedFiles.textContent = String(selectedFileCount);
      ui.reviewStrip.innerHTML = '<strong>' + esc(t("Change risk summary")) + '</strong>'
        + '<span class="risk-chip risk-high">' + esc(t("High ")) + riskCounts.high + '</span>'
        + '<span class="risk-chip risk-medium">' + esc(t("Medium ")) + riskCounts.medium + '</span>'
        + '<span class="risk-chip risk-low">' + esc(t("Low ")) + riskCounts.low + '</span>'
        + '<span class="review-note">' + esc(t("Based on selected rows. The AI review copy excludes file contents and absolute paths.")) + '</span>';
      const allAssetSummaries = buildAssetSummaries(selectedItems);
      const assetSummaries = allAssetSummaries.slice(0, 8);
      ui.assetSummary.textContent = t("Per-skill review hints ") + allAssetSummaries.length + (allAssetSummaries.length > 8 ? t(" (showing top 8)") : "");
      ui.assetStrip.innerHTML = assetSummaries.length
        ? assetSummaries.map(asset => '<div class="asset-row"><div class="name" title="' + esc(asset.key) + '">' + esc(asset.tool) + ' / ' + esc(asset.folder) + '</div><div class="line"><span class="risk-chip">' + esc(asset.status) + '</span><span class="risk-chip risk-high">' + esc(t("High ")) + asset.highCount + '</span><span class="risk-chip risk-medium">' + esc(t("Medium ")) + asset.mediumCount + '</span></div><div class="line"><span class="risk-chip ' + esc(asset.recommendClass) + '">' + esc(asset.recommendation) + '</span><span class="risk-chip">' + esc(t("Changed ")) + asset.changedCount + '</span></div></div>').join("")
        : '<div class="asset-empty">' + esc(t("No selected items.")) + '</div>';
      ui.predictText.textContent = t("Expected result: create ") + predictedCreate + t(" · overwrite ") + predictedOverwrite + t(" · delete ") + predictedDelete + t(" (hard to undo after apply)");
      const promptButton = document.getElementById("copyReviewPrompt");
      if (promptButton instanceof HTMLButtonElement) promptButton.disabled = selectedCount === 0;
      const applyButton = document.getElementById("applyBtn");
      if (applyButton instanceof HTMLButtonElement) {
        applyButton.disabled = selectedCount === 0;
        applyButton.title = selectedCount === 0 ? t("Select items to apply first.") : t("Apply selected changes.");
      }
      ui.rows.innerHTML = filteredGroups().map(renderGroupRows).join("");
      if (selectedCount === 0) {
        setFeedback(t("No rows selected. Nothing will be copied in the current state."), "warn");
      } else {
        setFeedback(t("{0} selected skill(s) · {1} file(s) will be applied. Check the expected result before applying.", selectedCount, selectedFileCount), "info");
      }
      syncRenderedGroupToggles();
      syncMasterToggle();
      vscode.postMessage({ type: "filterChanged", payload: { status: ui.status.value, search: ui.search.value } });
    }
    function setBulk(kind){
      if (kind === "selectAll") buildSkillGroups(state.items).forEach(group => setGroupSelected(group, true));
      if (kind === "conflict") state.items.forEach(it => { it.selected = it.status === "added" || it.status === "modified" || it.status === "typeChanged"; });
      const afterSelected = buildSkillGroups(state.items).filter(group => {
        const selection = groupSelection(group);
        return selection.checked || selection.indeterminate;
      }).length;
      if (kind === "selectAll") {
        setFeedback(t("Select all applied: every item is selected."), "info");
      } else if (kind === "conflict" && afterSelected === 0) {
        setFeedback(t("Select changes found nothing: there are no new, modified, or type-conflict items."), "warn");
      } else {
        setFeedback(t("Bulk action applied: ") + afterSelected + t(" selected rows"), "info");
      }
      vscode.postMessage({ type: "bulkAction", payload: { kind } });
      render();
    }
    ui.search.addEventListener("input", render);
    ui.status.addEventListener("change", render);
    document.getElementById("bulkSelectAll").addEventListener("click", () => setBulk("selectAll"));
    document.getElementById("bulkConflict").addEventListener("click", () => setBulk("conflict"));
    document.getElementById("copyReviewPrompt").addEventListener("click", () => {
      const keys = selectedReviewItems(buildSkillGroups(state.items)).map(it => it.key);
      if (keys.length === 0) {
        setFeedback(t("There are no items to include in the review prompt."), "warn");
        return;
      }
      vscode.postMessage({ type: "copyReviewPrompt", payload: { selectedKeys: keys } });
    });
    document.getElementById("refreshPlan").addEventListener("click", () => {
      const keys = state.items.filter(it => it.selected).map(it => it.key);
      setFeedback(t("Checking file state again..."), "info");
      vscode.postMessage({ type: "refreshPlan", payload: { selectedKeys: keys } });
    });
    document.getElementById("expandScopeBtn").addEventListener("click", () => {
      setFeedback(t("Removing the scope filter and loading the full apply plan..."), "info");
      vscode.postMessage({ type: "expandScope" });
    });
    document.getElementById("cancelBtn").addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
    document.getElementById("applyBtn").addEventListener("click", () => {
      const keys = state.items.filter(it => it.selected).map(it => it.key);
      if (keys.length === 0) {
        setFeedback(t("There are no items to apply. Select items and try again."), "warn");
        return;
      }
      vscode.postMessage({ type: "apply", payload: { selectedKeys: keys } });
    });
    ui.rows.addEventListener("change", (ev) => {
      const el = ev.target;
      if (!(el instanceof HTMLInputElement)) return;
      if (el.dataset.kind === "toggle-group") {
        const group = buildSkillGroups(state.items).find(item => item.key === el.dataset.groupKey);
        if (!group) return;
        setGroupSelected(group, el.checked);
        vscode.postMessage({ type: "toggleItem", payload: { key: group.key, selected: el.checked } });
      }
      if (el.dataset.kind === "toggle-file") {
        const key = el.dataset.key || "";
        const target = state.items.find(it => it.key === key);
        if (!target) return;
        target.selected = el.checked;
        const groupKey = target.tool + "::" + getSkillFolderName(target.relativePath);
        const group = buildSkillGroups(state.items).find(item => item.key === groupKey);
        if (group) syncGroupParentSelection(group);
        vscode.postMessage({ type: "toggleItem", payload: { key, selected: el.checked } });
      }
      render();
    });
    ui.rows.addEventListener("click", (ev) => {
      const el = ev.target;
      if (!(el instanceof HTMLButtonElement)) return;
      if (el.dataset.kind === "toggle-expand") {
        const key = el.dataset.groupKey || "";
        if (expandedGroups.has(key)) expandedGroups.delete(key);
        else expandedGroups.add(key);
        render();
        return;
      }
      if (el.dataset.kind === "diff") {
        const key = el.dataset.key || "";
        vscode.postMessage({ type: "openDiff", payload: { key } });
        return;
      }
      if (el.dataset.kind === "diff-folder-summary") {
        const tool = el.dataset.tool || "";
        const folder = el.dataset.folder || "";
        const keyCsv = el.dataset.summaryKeys || "";
        const itemKeys = keyCsv.split(",").map(v => v.trim()).filter(Boolean);
        if (itemKeys.length === 0) {
          setFeedback(t("This group has no diff to show."), "warn");
          return;
        }
        vscode.postMessage({
          type: "openFolderDiffSummary",
          payload: {
            tool,
            relativePath: folder,
            itemKeys
          }
        });
      }
    });
    document.getElementById("toggleAllRows").addEventListener("change", (ev) => {
      const el = ev.target;
      if (!(el instanceof HTMLInputElement)) return;
      filteredGroups().forEach(group => setGroupSelected(group, el.checked));
      render();
    });
    window.addEventListener("message", (ev) => {
      const message = ev.data || {};
      if (message.type === "promptCopied") {
        const count = message.payload && typeof message.payload.selectedCount === "number" ? message.payload.selectedCount : 0;
        setFeedback(t("AI review prompt copied to the clipboard. It includes ") + count + t(" selected rows."), "info");
      }
      if (message.type === "promptCopyFailed") {
        setFeedback(String(message.payload?.message || t("Prompt copy failed")), "warn");
      }
    });
    render();
  </script>
</body>
</html>`;
}
