import type * as vscode from "vscode";
import { buildTransferReviewMeta } from "./reviewPrompt";
import type { TransferPlan } from "./types";
import type { UiLanguage } from "./uiLanguage";

export function renderTransferManagerHtml(webview: vscode.Webview, plan: TransferPlan, language: UiLanguage = "en"): string {
  void webview;
  const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const initial = JSON.stringify(plan).replace(/</g, "\\u003c");
  const reviewInitial = JSON.stringify(buildTransferReviewMeta(plan)).replace(/</g, "\\u003c");
  const isKo = language === "ko";
  return `<!doctype html>
<html lang="${language}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${isKo ? "변경 검토" : "Review Changes"}</title>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; height: 100vh; overflow: hidden; }
    .wrap { padding: 8px 10px; display: grid; gap: 6px; height: 100vh; box-sizing: border-box; grid-template-areas: "head" "direction" "summary" "review" "feedback" "toolbar" "table" "predict" "foot"; grid-template-rows: auto auto auto auto auto auto minmax(0, 1fr) auto auto; }
    .head { grid-area: head; }
    .direction-panel { grid-area: direction; }
    .summary { grid-area: summary; }
    .review-panel { grid-area: review; }
    .feedback { grid-area: feedback; }
    .toolbar { grid-area: toolbar; }
    .table-wrap { grid-area: table; }
    .predict-box { grid-area: predict; }
    .foot { grid-area: foot; }
    .head { min-width: 0; display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
    .head h2 { font-size: 17px; line-height: 1.2; }
    .meta { font-size: 11px; opacity: 0.9; display: flex; gap: 8px; flex-wrap: wrap; }
    .direction-panel { min-width: 0; border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 6px 8px; display: grid; grid-template-columns: minmax(180px, auto) minmax(0, 1fr) auto; gap: 7px; align-items: center; background: color-mix(in oklab, var(--vscode-editor-background) 88%, #2563eb 12%); }
    .direction-panel.import { background: color-mix(in oklab, var(--vscode-editor-background) 88%, #16a34a 12%); }
    .direction-title { font-weight: 800; font-size: 13px; white-space: nowrap; }
    .direction-title .arrow { padding: 0 6px; color: #93c5fd; }
    .direction-panel.import .direction-title .arrow { color: #86efac; }
    .scope-line { min-width: 0; display: flex; flex-wrap: wrap; gap: 4px; align-items: center; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .scope-chip { border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 2px 7px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); max-width: min(620px, 60vw); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .scope-chip.locked { border-color: #60a5fa; color: #bfdbfe; }
    .direction-panel.import .scope-chip.locked { border-color: #22c55e; color: #bbf7d0; }
    .scope-action { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 3px 7px; font-size: 12px; }
    .summary { display: flex; flex-wrap: wrap; gap: 5px; align-items: stretch; min-height: 0; }
    .card { flex: 1 1 150px; min-width: 0; border: 1px solid var(--vscode-panel-border); padding: 4px 7px; border-radius: 5px; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .card b { font-size: 14px; }
    .review-panel { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 5px 7px; background: color-mix(in oklab, var(--vscode-editor-background) 94%, var(--vscode-editor-foreground) 6%); display: grid; gap: 4px; }
    .review-strip { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; min-width: 0; font-size: 12px; }
    .review-strip strong { margin-right: 2px; }
    .review-note { color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 180px; flex: 1 1 240px; }
    .risk-chip { display: inline-flex; align-items: center; gap: 4px; border-radius: 999px; border: 1px solid var(--vscode-panel-border); padding: 1px 7px; font-size: 11px; white-space: nowrap; }
    .risk-high { border-color: #fb7185; color: #fb7185; }
    .risk-medium { border-color: #f59e0b; color: #fbbf24; }
    .risk-low { border-color: #22c55e; color: #4ade80; }
    .risk-tags { display: flex; flex-wrap: wrap; gap: 4px; max-width: 360px; }
    .asset-details { border-top: 1px solid var(--vscode-panel-border); padding-top: 4px; }
    .asset-details summary { cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 12px; user-select: none; }
    .asset-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 5px; margin-top: 5px; max-height: 82px; overflow: auto; }
    .asset-card { border: 1px solid var(--vscode-panel-border); border-radius: 5px; padding: 5px; background: var(--vscode-sideBar-background); display: grid; gap: 3px; min-width: 0; }
    .asset-card .name { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .asset-card .line { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; font-size: 11px; }
    .asset-empty { color: var(--vscode-descriptionForeground); font-size: 12px; padding: 4px 0; }
    .recommend-apply { color: #4ade80; border-color: #22c55e; }
    .recommend-inspect { color: #fbbf24; border-color: #f59e0b; }
    .recommend-skip { color: #fb7185; border-color: #fb7185; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
    .toolbar input, .toolbar select, .toolbar button { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 4px 7px; min-height: 28px; }
    .toolbar input { flex: 1 1 280px; min-width: 200px; }
    button { cursor: pointer; }
    button:disabled { opacity: .5; cursor: default; }
    .table-wrap { border: 1px solid var(--vscode-panel-border); border-radius: 6px; overflow: auto; min-height: 160px; }
    table { width: max-content; min-width: 100%; border-collapse: collapse; font-size: 12px; }
    thead { background: var(--vscode-sideBar-background); }
    th, td { padding: 5px 7px; border-bottom: 1px solid var(--vscode-panel-border); text-align: left; }
    tbody tr:hover { background: var(--vscode-list-hoverBackground); }
    .status-added { color: #22c55e; }
    .status-removed { color: #ef4444; }
    .status-modified { color: #f59e0b; }
    .status-typeChanged { color: #fb7185; }
    .status-same { color: #94a3b8; }
    .change-code { font-weight: 800; font-size: 13px; }
    .relation-main { display: block; font-weight: 700; }
    .predict-box { border: 1px solid #f59e0b; color: #fbbf24; border-radius: 6px; padding: 5px 7px; font-size: 12px; background: color-mix(in oklab, var(--vscode-editor-background) 88%, #f59e0b 12%); }
    .feedback { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 4px 7px; font-size: 12px; }
    .feedback.warn { border-color: #f59e0b; color: #fbbf24; }
    .feedback.info { border-color: var(--vscode-panel-border); color: var(--vscode-foreground); }
    .path-main { max-width: 420px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: inline-block; vertical-align: bottom; }
    .path-sub { opacity: 0.85; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; max-width: 580px; }
    .foot { position: sticky; bottom: 0; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 7px 10px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; background: color-mix(in oklab, var(--vscode-editor-background) 92%, #111827 8%); box-shadow: 0 -10px 24px rgba(0,0,0,.14); }
    .foot-copy { min-width: 0; display: grid; gap: 2px; }
    .foot-kicker { font-size: 10px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; color: color-mix(in oklab, var(--vscode-descriptionForeground) 82%, #f8fafc 18%); }
    .foot-title { font-size: 13px; font-weight: 700; color: var(--vscode-foreground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .foot-note { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .foot-actions { display: inline-flex; justify-content: flex-end; gap: 8px; align-items: center; }
    .btn { min-height: 30px; padding: 0 12px; border-radius: 7px; border: 1px solid var(--vscode-panel-border); background: color-mix(in oklab, var(--vscode-button-secondaryBackground, var(--vscode-input-background)) 72%, transparent); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); font-weight: 700; letter-spacing: 0; transition: background .16s ease, border-color .16s ease, transform .16s ease, opacity .16s ease, color .16s ease; }
    .btn:hover:not(:disabled) { transform: translateY(-1px); }
    .btn:active:not(:disabled) { transform: translateY(0); }
    .btn-ghost { background: transparent; border-color: color-mix(in oklab, var(--vscode-panel-border) 76%, #94a3b8 24%); color: var(--vscode-foreground); }
    .btn-ghost:hover:not(:disabled) { background: color-mix(in oklab, var(--vscode-list-hoverBackground) 75%, transparent); }
    .btn-primary { border-color: color-mix(in oklab, #22c55e 70%, var(--vscode-panel-border) 30%); background: linear-gradient(180deg, color-mix(in oklab, #22c55e 84%, white 16%), color-mix(in oklab, #15803d 90%, black 10%)); color: #f7fee7; box-shadow: inset 0 1px 0 rgba(255,255,255,.12), 0 0 0 1px rgba(34,197,94,.08); }
    .btn-primary:hover:not(:disabled) { background: linear-gradient(180deg, color-mix(in oklab, #4ade80 86%, white 14%), color-mix(in oklab, #166534 92%, black 8%)); border-color: color-mix(in oklab, #4ade80 74%, var(--vscode-panel-border) 26%); }
    .btn:disabled { opacity: .42; cursor: default; transform: none; box-shadow: none; }
    .btn-primary:disabled { background: color-mix(in oklab, var(--vscode-button-background, var(--vscode-input-background)) 34%, #22c55e 14%); color: color-mix(in oklab, var(--vscode-disabledForeground, var(--vscode-descriptionForeground)) 90%, #f8fafc 10%); border-color: var(--vscode-panel-border); }
    @media (max-width: 960px) {
      .direction-panel { grid-template-columns: minmax(0, 1fr); align-items: start; }
      .direction-title { white-space: normal; }
      .scope-chip { max-width: 100%; }
      .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .foot { grid-template-columns: 1fr; }
      .foot-actions { justify-content: stretch; }
      .foot-actions .btn { flex: 1 1 0; }
    }
    @media (max-width: 640px) {
      .summary { grid-template-columns: minmax(0, 1fr); }
      .toolbar input { min-width: 100%; }
      .foot-title, .foot-note { white-space: normal; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="head">
      <h2 style="margin:0;">${isKo ? "변경 검토" : "Review Changes"}</h2>
      <div class="meta">
        <span id="groupLabel"></span>
        <span id="repoLabel"></span>
      </div>
    </div>
    <div id="directionPanel" class="direction-panel">
      <div id="directionTitle" class="direction-title"></div>
      <div class="scope-line">
        <span>${isKo ? "현재 범위" : "Current scope"}</span>
        <span id="scopeLabel" class="scope-chip"></span>
        <span id="scopeCount"></span>
      </div>
      <button id="expandScopeBtn" class="scope-action">${isKo ? "전체 보기" : "Show All"}</button>
    </div>
    <div class="summary">
      <div class="card">${isKo ? "새 파일/폴더" : "New files/folders"} <b id="sumAdded">0</b></div>
      <div class="card">${isKo ? "변경 파일/폴더" : "Changed files/folders"} <b id="sumChanged">0</b></div>
      <div class="card">${isKo ? "선택된 행" : "Selected rows"} <b id="sumSelectedApply">0</b></div>
    </div>
    <div class="review-panel">
      <div id="reviewStrip" class="review-strip">${isKo ? "검토 요약을 계산하는 중..." : "Calculating review summary..."}</div>
      <details id="assetDetails" class="asset-details">
        <summary id="assetSummary">${isKo ? "스킬별 검토 힌트 보기" : "Show per-skill review hints"}</summary>
        <div id="assetStrip" class="asset-strip"></div>
      </details>
    </div>
    <div id="feedback" class="feedback info">${isKo ? "작업 결과가 여기에 표시됩니다." : "Action results will appear here."}</div>
    <div class="toolbar">
      <input id="search" placeholder="${isKo ? "스킬 또는 파일 경로 검색..." : "Search skill or file path..."}" />
      <select id="statusFilter">
        <option value="">${isKo ? "모든 상태" : "All statuses"}</option>
        <option value="added">${isKo ? "신규" : "New"}</option>
        <option value="removed">${isKo ? "삭제" : "Delete"}</option>
        <option value="modified">${isKo ? "수정" : "Modified"}</option>
        <option value="typeChanged">${isKo ? "유형 충돌" : "Type conflict"}</option>
      </select>
      <button id="bulkSelectAll">${isKo ? "전체 선택" : "Select All"}</button>
      <button id="bulkConflict">${isKo ? "변경 선택" : "Select Changes"}</button>
      <button id="copyReviewPrompt">${isKo ? "AI 검토 복사" : "Copy AI Review"}</button>
      <button id="refreshPlan">${isKo ? "새로고침" : "Refresh"}</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th><input id="toggleAllRows" type="checkbox" title="${isKo ? "보이는 행 전체 선택 또는 해제" : "Select or clear all visible rows"}"></th>
            <th>${isKo ? "관계 (현재 → 반영 후)" : "Relation (current → after apply)"}</th>
            <th>${isKo ? "상태" : "Status"}</th>
            <th>${isKo ? "검토 힌트" : "Review hint"}</th>
            <th>${isKo ? "원본 수정 시각" : "Source modified"}</th>
            <th>${isKo ? "대상 수정 시각" : "Target modified"}</th>
            <th>${isKo ? "작업" : "Action"}</th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
    <div class="predict-box" id="predictText">${isKo ? "예상 결과: 생성 0 / 덮어쓰기 0 / 삭제 0" : "Expected result: create 0 / overwrite 0 / delete 0"}</div>
    <div class="foot">
      <div class="foot-copy">
        <div class="foot-kicker">${isKo ? "Final Step" : "Final Step"}</div>
        <div id="footTitle" class="foot-title">${isKo ? "검토를 마치면 선택한 변경만 반영됩니다." : "Only the selected changes will be applied."}</div>
        <div id="footNote" class="foot-note">${isKo ? "선택이 없으면 반영 버튼이 비활성화됩니다." : "The apply button stays disabled until you select at least one item."}</div>
      </div>
      <div class="foot-actions">
        <button id="cancelBtn" class="btn btn-ghost">${isKo ? "취소" : "Cancel"}</button>
        <button id="applyBtn" class="btn btn-primary">${isKo ? "선택 변경 반영" : "Apply Selected Changes"}</button>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
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
      predictText: document.getElementById("predictText"),
      footTitle: document.getElementById("footTitle"),
      footNote: document.getElementById("footNote")
    };
    function t(en, ko){ return language === "ko" ? ko : en; }
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
    function getEntryKindLabel(kind){
      if (kind === "folder") return t("folder", "폴더");
      if (kind === "file") return t("file", "파일");
      return String(kind || "");
    }
    function getStatusLabel(status){
      if (status === "added") return t("New", "신규");
      if (status === "removed") return t("Delete", "삭제");
      if (status === "modified") return t("Modified", "수정");
      if (status === "typeChanged") return t("Type conflict", "유형 충돌");
      return t("Same", "동일");
    }
    function getStatusClass(status){
      if (status === "added") return "status-added";
      if (status === "removed") return "status-removed";
      if (status === "modified") return "status-modified";
      if (status === "typeChanged") return "status-typeChanged";
      return "status-same";
    }
    function getReview(it){
      return reviewMeta.items[it.key] || { severity: "low", tags: [t("General change", "일반 변경")], notes: [], checklist: [] };
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
      const tags = Array.isArray(review.tags) && review.tags.length > 0 ? review.tags : [t("General change", "일반 변경")];
      const severityLabel = review.severity === "high"
        ? t("High", "높음")
        : review.severity === "medium"
          ? t("Medium", "중간")
          : t("Low", "낮음");
      return '<div class="risk-tags"><span class="risk-chip risk-' + esc(review.severity) + '">' + esc(severityLabel) + '</span>' + tags.slice(0, 3).map(tag => '<span class="risk-chip">' + esc(tag) + '</span>').join("") + '</div>';
    }
    function getSourceTargetLabels(){
      if (state.mode === "workspaceToCentral") {
        return { source: t("Workspace (current)", "작업공간 (현재)"), target: t("Central (after apply)", "중앙 (반영 후)") };
      }
      return { source: t("Central (current)", "중앙 (현재)"), target: t("Workspace (after apply)", "작업공간 (반영 후)") };
    }
    function getDecisionText(it){
      const labels = getSourceTargetLabels();
      if (it.status === "added") return labels.source + t(" exists; ", " 있음 · ") + labels.target + t(" is missing", " 없음");
      if (it.status === "removed") return labels.source + t(" is missing; ", " 없음 · ") + labels.target + t(" exists", " 있음");
      if (it.status === "modified") return t("Both sides exist; content differs", "양쪽 모두 존재 · 내용이 다름");
      if (it.status === "typeChanged") return t("Type mismatch (file/folder)", "유형 불일치 (파일/폴더)");
      return t("Both sides match", "양쪽이 동일함");
    }
    function getStatsBaseItems(items){
      const files = items.filter(it => it.entryKind === "file");
      return files.length > 0 ? files : items;
    }
    function buildFolderSummaryMap(items){
      const groups = new Map();
      for (const it of items) {
        const folder = getSkillFolderName(it.relativePath);
        const key = it.tool + "::" + folder;
        const prev = groups.get(key) || [];
        prev.push(it.key);
        groups.set(key, prev);
      }
      return groups;
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
        let status = t("Same", "동일");
        if (statuses.has("typeChanged")) status = t("Type conflict", "유형 충돌");
        else if (statuses.has("removed")) status = t("Delete candidate", "삭제 후보");
        else if (statuses.has("modified")) status = t("Modified", "수정");
        else if (statuses.has("added")) status = t("New skill", "새 스킬");
        let recommendation = t("Safe to apply", "바로 반영 가능");
        let recommendClass = "recommend-apply";
        if (statuses.has("removed")) {
          recommendation = t("Skip recommended", "건너뛰기 권장");
          recommendClass = "recommend-skip";
        } else if (statuses.has("typeChanged") || hasHigh || hasMedium) {
          recommendation = t("Inspect diff first", "먼저 diff 확인");
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
      const visible = filtered();
      const master = document.getElementById("toggleAllRows");
      if (!(master instanceof HTMLInputElement)) return;
      if (visible.length === 0) {
        master.checked = false;
        master.indeterminate = false;
        return;
      }
      const selected = visible.filter(it => it.selected).length;
      master.checked = selected === visible.length;
      master.indeterminate = selected > 0 && selected < visible.length;
    }
    function filtered(){
      const q = ui.search.value.trim().toLowerCase();
      const s = ui.status.value;
      return state.items.filter(it => {
        if (s && it.status !== s) return false;
        const displayPath = getDisplayPath(it).toLowerCase();
        if (q && !(displayPath.includes(q) || it.relativePath.toLowerCase().includes(q))) return false;
        return true;
      });
    }
    function setFeedback(message, tone){
      ui.feedback.textContent = message;
      ui.feedback.className = "feedback " + (tone || "info");
    }
    function render(){
      const labels = getSourceTargetLabels();
      const isExport = state.mode === "workspaceToCentral";
      ui.directionPanel.className = "direction-panel" + (isExport ? "" : " import");
      ui.directionTitle.innerHTML = isExport
        ? t('Workspace <span class="arrow">→</span> Save to Central', '작업공간 <span class="arrow">→</span> 중앙에 반영')
        : t('Central <span class="arrow">→</span> Bring to Workspace', '중앙 <span class="arrow">→</span> 작업공간으로 가져오기');
      const scope = state.scopeContext || { type: "all", label: isExport ? t("All Workspace", "작업공간 전체") : t("All Central", "중앙 전체"), count: 0, expandable: false };
      ui.scopeLabel.textContent = scope.label || (isExport ? t("All Workspace", "작업공간 전체") : t("All Central", "중앙 전체"));
      ui.scopeLabel.className = "scope-chip" + (scope.type === "all" ? "" : " locked");
      ui.scopeCount.textContent = scope.count ? t("Targets ", "대상 ") + scope.count : t("Full scope", "전체 범위");
      ui.expandScopeBtn.style.display = scope.expandable ? "" : "none";
      ui.groupLabel.textContent = state.groupContext ? (t("Group: ", "그룹: ") + state.groupContext.name) : "";
      ui.repoLabel.textContent = state.repoContext ? (t("Repo: ", "저장소: ") + state.repoContext.repo) : "";
      const baseSummaryItems = getStatsBaseItems(state.items);
      const added = baseSummaryItems.filter(it => it.status === "added").length;
      const modified = baseSummaryItems.filter(it => it.status === "modified").length;
      const typeChanged = baseSummaryItems.filter(it => it.status === "typeChanged").length;
      const selectedCount = state.items.filter(it => it.selected).length;
      const selectedBaseItems = getStatsBaseItems(state.items.filter(it => it.selected));
      const predictedCreate = selectedBaseItems.filter(it => it.status === "added").length;
      const predictedOverwrite = selectedBaseItems.filter(it => it.status === "modified" || it.status === "typeChanged").length;
      const predictedDelete = selectedBaseItems.filter(it => it.status === "removed").length;
      const selectedItems = state.items.filter(it => it.selected);
      const riskCounts = getRiskCounts(selectedItems);
      ui.sumAdded.textContent = String(added);
      ui.sumChanged.textContent = String(modified + typeChanged);
      ui.sumSelectedApply.textContent = String(selectedCount);
      ui.reviewStrip.innerHTML = '<strong>' + esc(t("AI review summary", "AI 검토 요약")) + '</strong>'
        + '<span class="risk-chip risk-high">' + esc(t("High ", "높음 ")) + riskCounts.high + '</span>'
        + '<span class="risk-chip risk-medium">' + esc(t("Medium ", "중간 ")) + riskCounts.medium + '</span>'
        + '<span class="risk-chip risk-low">' + esc(t("Low ", "낮음 ")) + riskCounts.low + '</span>'
        + '<span class="review-note">' + esc(t("Only selected rows are included in the prompt. File contents and absolute paths are excluded.", "프롬프트에는 선택한 행만 포함되며 파일 내용과 절대 경로는 제외됩니다.")) + '</span>';
      const allAssetSummaries = buildAssetSummaries(selectedItems);
      const assetSummaries = allAssetSummaries.slice(0, 8);
      ui.assetSummary.textContent = t("Per-skill review hints ", "스킬별 검토 힌트 ") + allAssetSummaries.length + (allAssetSummaries.length > 8 ? t(" (showing top 8)", " (상위 8개 표시)") : "");
      ui.assetStrip.innerHTML = assetSummaries.length
        ? assetSummaries.map(asset => '<div class="asset-card"><div class="name" title="' + esc(asset.key) + '">' + esc(asset.tool) + ' / ' + esc(asset.folder) + '</div><div class="line"><span class="risk-chip">' + esc(asset.status) + '</span><span class="risk-chip risk-high">' + esc(t("High ", "높음 ")) + asset.highCount + '</span><span class="risk-chip risk-medium">' + esc(t("Medium ", "중간 ")) + asset.mediumCount + '</span></div><div class="line"><span class="risk-chip ' + esc(asset.recommendClass) + '">' + esc(asset.recommendation) + '</span><span class="risk-chip">' + esc(t("Changed ", "변경 ")) + asset.changedCount + '</span></div></div>').join("")
        : '<div class="asset-empty">' + esc(t("No selected items.", "선택된 항목이 없습니다.")) + '</div>';
      ui.predictText.textContent = t("Expected result (file/folder rows): create ", "예상 결과 (파일/폴더 행): 생성 ") + predictedCreate + t(" / overwrite ", " / 덮어쓰기 ") + predictedOverwrite + t(" / delete ", " / 삭제 ") + predictedDelete + t(" (hard to undo after apply)", " (반영 후 되돌리기 어려움)");
      const promptButton = document.getElementById("copyReviewPrompt");
      if (promptButton instanceof HTMLButtonElement) promptButton.disabled = selectedCount === 0;
      const applyButton = document.getElementById("applyBtn");
      if (applyButton instanceof HTMLButtonElement) {
        applyButton.disabled = selectedCount === 0;
        applyButton.title = selectedCount === 0 ? t("Select items to apply first.", "먼저 반영할 항목을 선택하세요.") : t("Apply selected changes.", "선택한 변경을 반영합니다.");
      }
      if (ui.footTitle) {
        ui.footTitle.textContent = selectedCount === 0
          ? t("Select changes before applying.", "반영하려면 먼저 변경 항목을 선택하세요.")
          : t(selectedCount + " selected rows are ready to apply.", selectedCount + "개 선택 행이 반영 준비되었습니다.");
      }
      if (ui.footNote) {
        ui.footNote.textContent = selectedCount === 0
          ? t("Review summary and expected result first, then choose the rows you want.", "검토 요약과 예상 결과를 먼저 보고 원하는 행을 선택하세요.")
          : t("The current selection will be applied in one step.", "현재 선택 항목이 한 번에 반영됩니다.");
      }
      const list = filtered();
      const summaryMap = buildFolderSummaryMap(state.items);
      ui.rows.innerHTML = list.map(it => {
        const checked = it.selected ? "checked" : "";
        const isSame = it.status === "same";
        const isFolder = it.entryKind === "folder";
        const displayPath = getDisplayPath(it);
        const statusLabel = getStatusLabel(it.status);
        const statusClass = getStatusClass(it.status);
        const folderName = getSkillFolderName(it.relativePath);
        const summaryKey = it.tool + "::" + folderName;
        const summaryKeys = summaryMap.get(summaryKey) || [];
        const actionKind = isFolder ? "diff-folder-summary" : "diff";
        const diffLabel = isSame ? t("Same item", "동일 항목") : (isFolder ? t("Summary Diff", "요약 Diff") : t("View Diff", "Diff 보기"));
        const diffDisabled = isSame ? "disabled" : "";
        return \`<tr>
          <td><input type="checkbox" data-kind="toggle" data-key="\${esc(it.key)}" \${checked}></td>
          <td title="\${esc(it.relativePath)} | \${esc(it.src)} -> \${esc(it.dst)}"><span class="path-main">\${esc(displayPath)}</span> <small>[\${esc(getEntryKindLabel(it.entryKind))}]</small><span class="relation-main">\${esc(labels.source)} → \${esc(labels.target)}</span><span class="path-sub">\${esc(getDecisionText(it))}</span></td>
          <td class="change-code \${esc(statusClass)}" title="\${esc(it.status)}">\${esc(statusLabel)}</td>
          <td>\${renderRiskTags(it)}</td>
          <td title="\${esc(it.srcMtime ?? "-")}">\${esc(fmtDate(it.srcMtime))}</td>
          <td title="\${esc(it.dstMtime ?? "-")}">\${esc(fmtDate(it.dstMtime))}</td>
          <td><button data-kind="\${esc(actionKind)}" data-key="\${esc(it.key)}" data-tool="\${esc(it.tool)}" data-folder="\${esc(folderName)}" data-summary-keys="\${esc(summaryKeys.join(","))}" \${diffDisabled}>\${diffLabel}</button></td>
        </tr>\`;
      }).join("");
      if (selectedCount === 0) {
        setFeedback(t("No rows selected. Nothing will be copied in the current state.", "선택된 행이 없습니다. 현재 상태에서는 복사되지 않습니다."), "warn");
      } else {
        setFeedback(selectedCount + t(" selected rows will be applied. Check the expected result before applying.", "개 선택 행이 반영됩니다. 적용 전에 예상 결과를 확인하세요."), "info");
      }
      syncMasterToggle();
      vscode.postMessage({ type: "filterChanged", payload: { status: ui.status.value, search: ui.search.value } });
    }
    function setBulk(kind){
      if (kind === "selectAll") state.items.forEach(it => { it.selected = true; });
      if (kind === "conflict") state.items.forEach(it => { it.selected = it.status === "added" || it.status === "modified" || it.status === "typeChanged"; });
      const afterSelected = state.items.filter(it => it.selected).length;
      if (kind === "selectAll") {
        setFeedback(t("Select all applied: every item is selected.", "전체 선택 적용: 모든 항목이 선택되었습니다."), "info");
      } else if (kind === "conflict" && afterSelected === 0) {
        setFeedback(t("Select changes found nothing: there are no new, modified, or type-conflict items.", "변경 선택 결과가 없습니다. 신규/수정/유형 충돌 항목이 없습니다."), "warn");
      } else {
        setFeedback(t("Bulk action applied: ", "일괄 작업 적용: ") + afterSelected + t(" selected rows", "개 행 선택"), "info");
      }
      vscode.postMessage({ type: "bulkAction", payload: { kind } });
      render();
    }
    ui.search.addEventListener("input", render);
    ui.status.addEventListener("change", render);
    document.getElementById("bulkSelectAll").addEventListener("click", () => setBulk("selectAll"));
    document.getElementById("bulkConflict").addEventListener("click", () => setBulk("conflict"));
    document.getElementById("copyReviewPrompt").addEventListener("click", () => {
      const keys = state.items.filter(it => it.selected).map(it => it.key);
      if (keys.length === 0) {
        setFeedback(t("There are no items to include in the review prompt.", "검토 프롬프트에 포함할 항목이 없습니다."), "warn");
        return;
      }
      vscode.postMessage({ type: "copyReviewPrompt", payload: { selectedKeys: keys } });
    });
    document.getElementById("refreshPlan").addEventListener("click", () => {
      const keys = state.items.filter(it => it.selected).map(it => it.key);
      setFeedback(t("Checking file state again...", "파일 상태를 다시 확인하는 중..."), "info");
      vscode.postMessage({ type: "refreshPlan", payload: { selectedKeys: keys } });
    });
    document.getElementById("expandScopeBtn").addEventListener("click", () => {
      setFeedback(t("Removing the scope filter and loading the full apply plan...", "범위 필터를 해제하고 전체 반영 계획을 불러오는 중..."), "info");
      vscode.postMessage({ type: "expandScope" });
    });
    document.getElementById("cancelBtn").addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
    document.getElementById("applyBtn").addEventListener("click", () => {
      const keys = state.items.filter(it => it.selected).map(it => it.key);
      if (keys.length === 0) {
        setFeedback(t("There are no items to apply. Select items and try again.", "반영할 항목이 없습니다. 항목을 선택한 뒤 다시 시도하세요."), "warn");
        return;
      }
      vscode.postMessage({ type: "apply", payload: { selectedKeys: keys } });
    });
    ui.rows.addEventListener("change", (ev) => {
      const el = ev.target;
      if (!(el instanceof HTMLInputElement)) return;
      if (el.dataset.kind === "toggle") {
        const key = el.dataset.key || "";
        const target = state.items.find(it => it.key === key);
        if (!target) return;
        target.selected = el.checked;
        vscode.postMessage({ type: "toggleItem", payload: { key, selected: el.checked } });
      }
      render();
    });
    ui.rows.addEventListener("click", (ev) => {
      const el = ev.target;
      if (!(el instanceof HTMLButtonElement)) return;
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
          setFeedback(t("This group has no diff to show.", "이 그룹에는 표시할 diff가 없습니다."), "warn");
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
      const visible = filtered();
      const keys = new Set(visible.map(it => it.key));
      state.items.forEach((it) => {
        if (keys.has(it.key)) it.selected = el.checked;
      });
      render();
    });
    window.addEventListener("message", (ev) => {
      const message = ev.data || {};
      if (message.type === "promptCopied") {
        const count = message.payload && typeof message.payload.selectedCount === "number" ? message.payload.selectedCount : 0;
        setFeedback(t("AI review prompt copied to the clipboard. It includes ", "AI 검토 프롬프트를 클립보드에 복사했습니다. 선택 행 ") + count + t(" selected rows.", "개를 포함합니다."), "info");
      }
      if (message.type === "promptCopyFailed") {
        setFeedback(String(message.payload?.message || t("Prompt copy failed", "프롬프트 복사 실패")), "warn");
      }
    });
    render();
  </script>
</body>
</html>`;
}
