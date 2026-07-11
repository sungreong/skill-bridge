import type * as vscode from "vscode";
import type { ToolType } from "./types";
import type { UiLanguage } from "./uiLanguage";
import { createWebviewNonce } from "./webviewCommon";
import { renderWebviewClientCommonScript } from "./webviewClientCommon";
import { renderWebviewCommonStyles } from "./webviewCommonStyles";

export function renderComparedTransferExplorerHtml(
  webview: vscode.Webview,
  data: {
    tools: ToolType[];
    skills: Array<{
      key: string;
      tool: ToolType;
      folder: string;
      skillName: string;
      status: "same" | "modified" | "onlyWorkspace" | "onlyCentral";
      workspaceExists: boolean;
      centralExists: boolean;
      workspaceFileCount: number;
      centralFileCount: number;
      modifiedFileCount: number;
      workspaceOnlyFileCount: number;
      centralOnlyFileCount: number;
      workspaceGroupNames: string[];
      centralGroupNames: string[];
    }>;
    groupDiffs: Array<{
      key: string;
      tool: ToolType;
      name: string;
      status: "same" | "modified" | "onlyWorkspace" | "onlyCentral";
      workspaceGroupId: string | null;
      centralGroupId: string | null;
      workspaceTargetCount: number;
      centralTargetCount: number;
      workspaceTargets: string[];
      centralTargets: string[];
    }>;
    groups: {
      workspace: Array<{ id: string; name: string; targetSummary: string; targetCount: number; tools: ToolType[] }>;
      central: Array<{ id: string; name: string; targetSummary: string; targetCount: number; tools: ToolType[] }>;
    };
    summary: {
      total: number;
      modified: number;
      onlyWorkspace: number;
      onlyCentral: number;
      same: number;
    };
    groupSummary: {
      total: number;
      modified: number;
      onlyWorkspace: number;
      onlyCentral: number;
      same: number;
    };
  },
  language: UiLanguage = "en"
): string {
  void webview;
  const nonce = createWebviewNonce();
  const initial = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="${language}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${language === "ko" ? "변경 비교/반영" : "Compare and Apply Changes"}</title>
  <style>
    ${renderWebviewCommonStyles()}
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; height: 100vh; overflow: hidden; font-family: var(--vscode-font-family); background: var(--vscode-editor-background); color: var(--vscode-foreground); }
    .wrap { height: 100vh; min-height: 0; padding: 8px 10px; display: grid; grid-template-rows: auto auto auto auto auto minmax(0, 1fr); gap: 6px; }
    .head { display: grid; grid-template-columns: minmax(180px, 1fr) auto; align-items: center; gap: 8px; min-width: 0; }
    .title { font-size: 15px; font-weight: 700; }
    .controls, .tabs, .mode-switch, .section-actions, .chips, .row-actions { display: flex; gap: 5px; align-items: center; flex-wrap: wrap; min-width: 0; }
    input, button { max-width: 100%; min-height: 28px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 5px; padding: 4px 8px; font: inherit; }
    input { width: min(340px, 42vw); min-width: 180px; }
    button { cursor: pointer; }
    button:disabled { opacity: .5; cursor: default; }
    .mode-btn, .tab { font-size: 12px; }
    .tab { display: inline-flex; align-items: center; gap: 6px; }
    .tab-count { min-width: 20px; border-radius: 999px; padding: 0 6px; font-size: 11px; line-height: 16px; text-align: center; color: var(--vscode-descriptionForeground); background: color-mix(in oklab, var(--vscode-editor-background) 88%, var(--vscode-editor-foreground) 12%); }
    .tab.active .tab-count { color: var(--vscode-foreground); }
    .mode-btn.active, .tab.active { border-color: var(--sb-accent); color: var(--vscode-foreground); box-shadow: inset 0 0 0 1px var(--sb-accent); }
    .hint { display: none; }
    .result-meta { font-size: 12px; color: var(--vscode-descriptionForeground); display: flex; gap: 8px; flex-wrap: wrap; align-items: center; min-height: 18px; }
    .status-tabs { display: grid; grid-template-columns: repeat(4, minmax(104px, 1fr)); gap: 5px; min-width: 0; }
    .status-filter { min-width: 0; padding: 5px 7px; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 6px; text-align: left; background: color-mix(in oklab, var(--vscode-editor-background) 94%, var(--vscode-editor-foreground) 6%); }
    .status-filter.active { background: color-mix(in oklab, var(--vscode-button-background, var(--vscode-editor-background)) 16%, var(--vscode-editor-background) 84%); box-shadow: inset 0 0 0 1px rgba(96,165,250,.25); }
    .status-filter-name { min-width: 0; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .status-filter-counts { display: flex; align-items: center; gap: 5px; justify-content: flex-end; min-width: 0; }
    .status-count { min-width: 24px; border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 0 6px; font-size: 12px; font-weight: 800; text-align: center; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    .status-count-label { font-size: 11px; color: var(--vscode-descriptionForeground); }
    .tabs { border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 3px; }
    .status { font-size: 12px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 4px 7px; color: var(--vscode-descriptionForeground); }
    .status.warn { border-color: var(--sb-warning); color: var(--sb-warning); }
    .status.error { border-color: var(--sb-danger); color: var(--sb-danger); }
    .sections { min-height: 0; overflow: auto; display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; align-content: start; padding: 0 2px 4px 0; scrollbar-gutter: stable; }
    .section { min-width: 0; border: 1px solid var(--vscode-panel-border); border-radius: 9px; overflow: hidden; background: color-mix(in oklab, var(--vscode-editor-background) 97%, var(--vscode-editor-foreground) 3%); }
    .section-head { padding: 7px 9px; display: flex; justify-content: space-between; align-items: center; gap: 7px; background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-panel-border); }
    .section.collapsed .section-head { border-bottom: 0; }
    .section-title { min-width: 0; display: flex; align-items: center; gap: 8px; }
    .section-name { font-weight: 700; }
    .section-desc { font-size: 12px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .section-body { padding: 6px; display: grid; gap: 6px; content-visibility: auto; contain: layout paint style; contain-intrinsic-size: 420px; }
    .subsection { display: grid; gap: 6px; }
    .subsection-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; align-items: start; }
    .subsection-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .subsection-name { font-weight: 700; color: var(--vscode-foreground); }
    .agent-block { min-width: 0; border: 1px solid var(--vscode-panel-border); border-radius: 8px; overflow: hidden; }
    .agent-head { padding: 7px 8px; display: flex; justify-content: space-between; gap: 8px; align-items: center; background: color-mix(in oklab, var(--vscode-editor-background) 92%, var(--vscode-editor-foreground) 8%); }
    .agent-name { font-weight: 700; }
    .agent-count, .meta { font-size: 12px; color: var(--vscode-descriptionForeground); }
    .rows { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 6px; padding: 6px; align-items: start; }
    .row { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 6px 7px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; align-items: start; background: var(--vscode-editor-background); content-visibility: auto; contain: layout paint style; contain-intrinsic-size: 60px; }
    .row-main { display: grid; gap: 3px; min-width: 0; }
    .name { font-weight: 650; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .chip, .badge { font-size: 11px; border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 1px 8px; }
    .badge { font-weight: 700; }
    .s-added { color: var(--sb-success); border-color: var(--sb-success); }
    .s-modified { color: var(--sb-warning); border-color: var(--sb-warning); }
    .s-removed { color: var(--sb-danger); border-color: var(--sb-danger); }
    .s-same { color: var(--vscode-descriptionForeground); border-color: var(--vscode-panel-border); }
    .primary { border-color: var(--vscode-button-background); color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .danger { border-color: var(--sb-danger); color: var(--sb-danger); }
    .ghost { color: var(--vscode-descriptionForeground); }
    .row-actions { justify-content: flex-start; }
    .pager { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 6px 2px 0; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .pager-actions { display: flex; gap: 6px; align-items: center; }
    .pager button { font-size: 12px; padding: 3px 8px; }
    .empty { border: 1px dashed var(--vscode-panel-border); border-radius: 8px; padding: 12px; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .disabled { opacity: .6; pointer-events: none; }
    @media (max-width: 860px) {
      .head { grid-template-columns: minmax(0, 1fr); }
      .status-tabs { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .row { grid-template-columns: minmax(0, 1fr); }
      .rows { grid-template-columns: minmax(0, 1fr); }
      input { min-width: 100%; }
    }
  </style>
</head>
<body>
  <div class="wrap sb-root">
    <div class="head sb-topbar">
      <div class="title">${language === "ko" ? "변경 비교/반영" : "Compare and Apply Changes"}</div>
      <div class="controls">
        <div class="mode-switch" id="modeSwitch"></div>
        <input id="searchInput" placeholder="${language === "ko" ? "스킬, 에이전트, 그룹 검색..." : "Search skills, agents, or groups..."}" />
        <button id="refreshBtn">${language === "ko" ? "새로고침" : "Refresh"}</button>
      </div>
    </div>
    <div class="tabs" id="toolTabs"></div>
    <div id="summary" class="status-tabs"></div>
    <div id="resultMeta" class="result-meta"></div>
    <div class="hint">${language === "ko" ? "변경 없는 항목은 접어 두고, 변경된 스킬과 스킬 그룹은 수정/신규/삭제 섹션에서 에이전트별로 검토합니다." : "Unchanged items are kept collapsed, while changed skills and skill groups are reviewed by agent in the modified, new, and delete sections."}</div>
    <div id="statusLine" class="status sb-status-bar info">${language === "ko" ? "준비 완료" : "Ready"}</div>
    <div id="sections" class="sections"></div>
  </div>
  <script nonce="${nonce}">
    ${renderWebviewClientCommonScript()}
    const vscode = acquireVsCodeApi();
    let currentLanguage = "${language}";
    function isKo(){ return currentLanguage === "ko"; }
    function t(en, ko){ return isKo() ? ko : en; }
    let state = ${initial};
    const STATUS_ORDER = ["modified", "added", "removed", "same"];
    const PAGE_SIZE = 12;
    const uiState = {
      query: "",
      busy: false,
      selectedTool: "all",
      activeStatus: "modified",
      mode: "workspaceToCentral",
      collapsed: { modified: false, added: false, removed: false, same: true },
      page: { modified: 1, added: 1, removed: 1, same: 1 }
    };
    let renderFrame = 0;
    function statusInfoMap(){
      return {
        modified: { label: t("Modified", "수정"), cls: "s-modified", title: t("Modified", "수정"), desc: t("Items that exist on both sides but have different contents", "양쪽에 모두 있지만 내용이 다른 항목") },
        added: { label: t("New", "신규"), cls: "s-added", title: t("New", "신규"), desc: t("Items that only exist in the source and will be added to the target", "보내는 쪽에만 있어 대상에 추가될 항목") },
        removed: { label: t("Delete", "삭제"), cls: "s-removed", title: t("Delete", "삭제"), desc: t("Items that only exist in the target and will be deleted when applied", "받는 쪽에만 있어 반영 시 삭제될 항목") },
        same: { label: t("Same", "동일"), cls: "s-same", title: t("Same", "동일"), desc: t("Items with identical contents on both sides", "양쪽 내용이 동일한 항목") }
      };
    }
    function statusInfoFor(status){
      const map = statusInfoMap();
      return Object.prototype.hasOwnProperty.call(map, status) ? map[status] : map.modified;
    }
    function esc(v){ return String(v ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;"); }
    function sourceSide(){ return uiState.mode === "workspaceToCentral" ? "workspace" : "central"; }
    function targetSide(){ return uiState.mode === "workspaceToCentral" ? "central" : "workspace"; }
    function sourceLabel(){ return sourceSide() === "workspace" ? t("Workspace", "작업공간") : t("Central", "중앙"); }
    function targetLabel(){ return targetSide() === "workspace" ? t("Workspace", "작업공간") : t("Central", "중앙"); }
    function directionText(){ return sourceLabel() + " → " + targetLabel(); }
    function setStatus(message, tone){ const el = document.getElementById("statusLine"); el.textContent = message || t("Ready", "준비 완료"); el.className = "status sb-status-bar " + (tone || "info"); }
    function normalizeStatus(status){ return Object.prototype.hasOwnProperty.call(statusInfoMap(), status) ? status : "modified"; }
    function resetPages(){ for (const status of STATUS_ORDER) uiState.page[status] = 1; }
    function pageCount(total){ return Math.max(1, Math.ceil(total / PAGE_SIZE)); }
    function clampPage(status, total){
      const next = Math.min(Math.max(1, Number(uiState.page[status]) || 1), pageCount(total));
      uiState.page[status] = next;
      return next;
    }
    function pageSlice(status, rows, total){
      const page = clampPage(status, total);
      const start = (page - 1) * PAGE_SIZE;
      return rows.slice(start, start + PAGE_SIZE);
    }
    function renderPager(status, total){
      const pages = pageCount(total);
      if (pages <= 1) return "";
      const page = clampPage(status, total);
      const from = ((page - 1) * PAGE_SIZE) + 1;
      const to = Math.min(total, page * PAGE_SIZE);
      return '<div class="pager"><span>' + esc(from) + '-' + esc(to) + ' / ' + esc(total) + ' · ' + esc(PAGE_SIZE) + ' ' + esc(t("per page", "개씩")) + '</span><div class="pager-actions">' +
        '<button class="ghost" data-action="page-section" data-status="' + esc(status) + '" data-dir="-1" ' + (page <= 1 ? "disabled" : "") + '>' + esc(t("Previous", "이전")) + '</button>' +
        '<span>' + esc(page) + ' / ' + esc(pages) + '</span>' +
        '<button class="ghost" data-action="page-section" data-status="' + esc(status) + '" data-dir="1" ' + (page >= pages ? "disabled" : "") + '>' + esc(t("Next", "다음")) + '</button>' +
        '</div></div>';
    }
    function scheduleRender(){
      if (renderFrame) cancelAnimationFrame(renderFrame);
      renderFrame = requestAnimationFrame(()=>{
        renderFrame = 0;
        render();
      });
    }
    function passesTool(tool){ return uiState.selectedTool === "all" || uiState.selectedTool === tool; }
    function matchesQuery(value){ const q = uiState.query.trim().toLowerCase(); return !q || String(value || "").toLowerCase().includes(q); }
    function displayStatus(skill){
      if (!skill || skill.status === "same") return "same";
      if (skill.status === "modified") return "modified";
      if (uiState.mode === "workspaceToCentral") return skill.status === "onlyWorkspace" ? "added" : "removed";
      return skill.status === "onlyCentral" ? "added" : "removed";
    }
    function displayGroupStatus(group){
      if (!group || group.status === "same") return "same";
      if (group.status === "modified") return "modified";
      if (uiState.mode === "workspaceToCentral") return group.status === "onlyWorkspace" ? "added" : "removed";
      return group.status === "onlyCentral" ? "added" : "removed";
    }
    function visibleSkills(){
      const skills = Array.isArray(state.skills) ? state.skills : [];
      return skills.filter((skill)=>passesTool(skill.tool) && matchesQuery(skill.tool + " " + skill.folder + " " + skill.skillName + " " + (skill.workspaceGroupNames || []).join(" ") + " " + (skill.centralGroupNames || []).join(" ")));
    }
    function skillsByStatus(status){ return visibleSkills().filter((skill)=>displayStatus(skill) === status); }
    function visibleGroups(){
      const groups = Array.isArray(state.groupDiffs) ? state.groupDiffs : [];
      return groups.filter((group)=>passesTool(group.tool) && matchesQuery(group.tool + " " + group.name + " " + (group.workspaceTargets || []).join(" ") + " " + (group.centralTargets || []).join(" ")));
    }
    function groupsByStatus(status){ return visibleGroups().filter((group)=>displayGroupStatus(group) === status); }
    function createStatusBuckets(){
      const buckets = {};
      for (const status of STATUS_ORDER) buckets[status] = { skills: [], groups: [] };
      for (const skill of visibleSkills()) buckets[displayStatus(skill)].skills.push(skill);
      for (const group of visibleGroups()) buckets[displayGroupStatus(group)].groups.push(group);
      return buckets;
    }
    function createToolBuckets(tool){
      const selectedTool = tool || "all";
      const previousTool = uiState.selectedTool;
      uiState.selectedTool = selectedTool;
      const buckets = createStatusBuckets();
      uiState.selectedTool = previousTool;
      return buckets;
    }
    function groupByTool(skills){
      const map = new Map();
      for (const item of skills) {
        const bucket = map.get(item.tool) || [];
        bucket.push(item);
        map.set(item.tool, bucket);
      }
      return Array.from(map.entries()).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
    }
    function targetsFromSkills(skills){ return skills.map((skill)=>({ tool: skill.tool, relativePath: skill.folder, kind: "folder" })); }
    function groupIdForAction(status, group){
      if (status === "removed") {
        return targetSide() === "workspace" ? group.workspaceGroupId : group.centralGroupId;
      }
      return sourceSide() === "workspace" ? group.workspaceGroupId : group.centralGroupId;
    }
    function groupIdsForAction(status, groups){
      return Array.from(new Set(groups.map((group)=>groupIdForAction(status, group)).filter((id)=>!!id)));
    }
    function sourceFileCount(skill){ return sourceSide() === "workspace" ? skill.workspaceFileCount : skill.centralFileCount; }
    function targetFileCount(skill){ return targetSide() === "workspace" ? skill.workspaceFileCount : skill.centralFileCount; }
    function sourceOnlyFileCount(skill){ return sourceSide() === "workspace" ? skill.workspaceOnlyFileCount : skill.centralOnlyFileCount; }
    function targetOnlyFileCount(skill){ return targetSide() === "workspace" ? skill.workspaceOnlyFileCount : skill.centralOnlyFileCount; }
    function groupChips(skill){
      const chips = [];
      const w = Array.isArray(skill.workspaceGroupNames) ? skill.workspaceGroupNames : [];
      const c = Array.isArray(skill.centralGroupNames) ? skill.centralGroupNames : [];
      if (w.length) chips.push((isKo() ? "W 그룹 " : "W group ") + w.slice(0,2).join(", ") + (w.length > 2 ? " +" + (w.length - 2) : ""));
      if (c.length) chips.push((isKo() ? "C 그룹 " : "C group ") + c.slice(0,2).join(", ") + (c.length > 2 ? " +" + (c.length - 2) : ""));
      return chips.map((text)=>'<span class="chip">' + esc(text) + '</span>').join("");
    }
    function countForStatus(status, buckets){ return buckets && buckets[status] ? buckets[status].skills.length : skillsByStatus(status).length; }
    function groupCountForStatus(status, buckets){ return buckets && buckets[status] ? buckets[status].groups.length : groupsByStatus(status).length; }
    function renderSummary(buckets){
      document.getElementById("summary").innerHTML = STATUS_ORDER.map((status)=>{
        const info = statusInfoFor(status);
        const skillCount = countForStatus(status, buckets);
        const groupCount = groupCountForStatus(status, buckets);
        const active = uiState.activeStatus === status;
        const label = info.label + " · " + t("Skills ", "스킬 ") + skillCount + " · " + t("Groups ", "그룹 ") + groupCount;
        return '<button class="status-filter ' + info.cls + (active ? " active" : "") + '" data-action="status-filter" data-status="' + esc(status) + '" aria-pressed="' + (active ? "true" : "false") + '" title="' + esc(label) + '">' +
          '<span class="status-filter-name">' + esc(info.label) + '</span>' +
          '<span class="status-filter-counts"><span class="status-count" aria-label="' + esc(t("Skills", "스킬")) + '">' + esc(skillCount) + '</span><span class="status-count-label">/</span><span class="status-count" aria-label="' + esc(t("Groups", "그룹")) + '">' + esc(groupCount) + '</span></span>' +
          '</button>';
      }).join("");
    }
    function renderResultMeta(buckets){
      const activeStatus = normalizeStatus(uiState.activeStatus);
      const activeInfo = statusInfoFor(activeStatus);
      const skillTotal = buckets[activeStatus].skills.length;
      const groupTotal = buckets[activeStatus].groups.length;
      const q = uiState.query.trim();
      document.getElementById("resultMeta").textContent =
        (q ? t("Search results", "검색 결과") : t("Current view", "현재 보기"))
        + " · "
        + activeInfo.label
        + " · "
        + t("Skills ", "스킬 ")
        + skillTotal
        + " · "
        + t("Groups ", "그룹 ")
        + groupTotal
        + " · "
        + directionText();
    }
    function renderModeSwitch(){
      const root = document.getElementById("modeSwitch");
      root.innerHTML = [
        ["workspaceToCentral", t("Workspace → Central", "작업공간 → 중앙")],
        ["centralToWorkspace", t("Central → Workspace", "중앙 → 작업공간")]
      ].map((item)=>'<button class="mode-btn ' + (uiState.mode===item[0] ? "active" : "") + '" data-action="mode" data-mode="' + item[0] + '">' + item[1] + '</button>').join("");
    }
    function renderTabs(){
      const root = document.getElementById("toolTabs");
      const tools = Array.isArray(state.tools) ? state.tools : [];
      root.innerHTML = ["all", ...tools].map((tool)=>{
        const toolBuckets = createToolBuckets(tool);
        const total = STATUS_ORDER.reduce((sum, status)=>sum + toolBuckets[status].skills.length + toolBuckets[status].groups.length, 0);
        const label = tool === "all" ? t("All", "전체") : tool;
        return '<button class="tab ' + (uiState.selectedTool===tool ? "active" : "") + '" data-action="tab" data-tool="' + esc(tool) + '" title="' + esc(label + " · " + total) + '">' + esc(label) + '<span class="tab-count">' + esc(total) + '</span></button>';
      }).join("");
    }
    function postMove(status, skills){
      if (uiState.busy) return;
      const targets = targetsFromSkills(skills);
      if (targets.length === 0) { setStatus(t("There are no skills to apply.", "반영할 스킬이 없습니다."), "warn"); return; }
      vscode.postMessage({ type: "moveCompared", payload: { mode: uiState.mode, status, targets } });
      setStatus(t("Apply review requested: ", "반영 검토 요청: ") + statusInfoFor(status).label + " " + t("skills ", "스킬 ") + targets.length + " · " + directionText(), "info");
    }
    function postMoveGroups(status, groups){
      if (uiState.busy) return;
      const groupIds = groupIdsForAction(status, groups);
      if (groupIds.length === 0) { setStatus(t("There are no groups to apply.", "반영할 그룹이 없습니다."), "warn"); return; }
      vscode.postMessage({ type: "moveComparedGroups", payload: { mode: uiState.mode, status, groupIds } });
      setStatus(t("Matching groups apply requested: ", "현재 보이는 그룹 반영 요청: ") + statusInfoFor(status).label + " " + t("groups ", "그룹 ") + groupIds.length + " · " + directionText(), "info");
    }
    function findSkillByKey(key){ return (Array.isArray(state.skills) ? state.skills : []).find((skill)=>skill.key === key); }
    function findGroupByKey(key){ return (Array.isArray(state.groupDiffs) ? state.groupDiffs : []).find((group)=>group.key === key); }
    function openDiff(skill){
      if (uiState.busy) return;
      vscode.postMessage({ type: "openComparedDiff", payload: { mode: uiState.mode, tool: skill.tool, relativePath: skill.folder } });
    }
    function renderSkillRow(skill, status){
      const info = statusInfoFor(status);
      const isSame = status === "same";
      const sourceOnly = sourceOnlyFileCount(skill);
      const targetOnly = targetOnlyFileCount(skill);
      const delta = status === "modified"
        ? (isKo()
          ? "변경 " + skill.modifiedFileCount + " · 보내는 쪽만 " + sourceOnly + " · 받는 쪽만 " + targetOnly
          : "Changed " + skill.modifiedFileCount + " · Source only " + sourceOnly + " · Target only " + targetOnly)
        : status === "added"
          ? (isKo() ? "추가할 파일 " + sourceFileCount(skill) : "Files to add " + sourceFileCount(skill))
          : status === "removed"
            ? (isKo() ? "삭제할 파일 " + targetFileCount(skill) : "Files to delete " + targetFileCount(skill))
            : (isKo() ? "동일 파일 " + sourceFileCount(skill) : "Same files " + sourceFileCount(skill));
      const actionLabel = status === "removed" ? t("Review Delete", "삭제 검토") : status === "added" ? t("Add", "추가") : t("Apply Change", "변경 반영");
      const chips = groupChips(skill);
      const rowActions = '<span class="badge ' + info.cls + '">' + info.label + '</span>' +
        (isSame ? "" : '<button class="ghost" data-action="open-diff" data-key="' + esc(skill.key) + '" ' + (uiState.busy ? "disabled" : "") + '>' + esc(t("Diff", "비교")) + '</button>' +
          '<button class="' + (status === "removed" ? "danger" : "primary") + '" data-action="move-skill" data-status="' + esc(status) + '" data-key="' + esc(skill.key) + '" ' + (uiState.busy ? "disabled" : "") + '>' + esc(actionLabel) + '</button>');
      return '<div class="row ' + (uiState.busy ? "disabled" : "") + '">' +
        '<div class="row-main"><div class="name">' + esc(skill.tool + "/" + skill.folder) + '</div>' +
        '<div class="meta">' + esc(sourceLabel()) + " " + esc(t("files ", "파일 ")) + esc(sourceFileCount(skill)) + " · " + esc(targetLabel()) + " " + esc(t("files ", "파일 ")) + esc(targetFileCount(skill)) + " · " + esc(delta) + '</div>' +
        (chips ? '<div class="chips">' + chips + '</div>' : '') + '</div>' +
        '<div class="row-actions">' + rowActions + '</div></div>';
    }
    function renderGroupRow(group, status){
      const info = statusInfoFor(status);
      const isSame = status === "same";
      const sourceTargets = sourceSide() === "workspace" ? group.workspaceTargets : group.centralTargets;
      const targetTargets = targetSide() === "workspace" ? group.workspaceTargets : group.centralTargets;
      const sourceCount = sourceSide() === "workspace" ? group.workspaceTargetCount : group.centralTargetCount;
      const targetCount = targetSide() === "workspace" ? group.workspaceTargetCount : group.centralTargetCount;
      const actionLabel = status === "removed" ? t("Delete Group", "그룹 삭제") : status === "added" ? t("Add Group", "그룹 추가") : t("Apply Group", "그룹 반영");
      const preview = (status === "removed" ? targetTargets : sourceTargets).slice(0, 3).join(", ");
      const more = (status === "removed" ? targetTargets : sourceTargets).length > 3 ? " +" + ((status === "removed" ? targetTargets : sourceTargets).length - 3) : "";
      const rowActions = '<span class="badge ' + info.cls + '">' + info.label + '</span>' +
        (isSame ? "" : '<button class="' + (status === "removed" ? "danger" : "primary") + '" data-action="move-group-diff" data-status="' + esc(status) + '" data-key="' + esc(group.key) + '" ' + (uiState.busy ? "disabled" : "") + '>' + esc(actionLabel) + '</button>');
      return '<div class="row ' + (uiState.busy ? "disabled" : "") + '">' +
        '<div class="row-main"><div class="name">' + esc(group.tool + " / " + group.name) + '</div>' +
        '<div class="meta">' + esc(sourceLabel()) + " " + esc(t("targets ", "대상 ")) + esc(sourceCount) + " · " + esc(targetLabel()) + " " + esc(t("targets ", "대상 ")) + esc(targetCount) + (preview ? " · " + esc(preview + more) : "") + '</div></div>' +
        '<div class="row-actions">' + rowActions + '</div></div>';
    }
    function renderAgentBlock(status, tool, skills){
      const button = status === "same" || skills.length === 0 ? "" : '<button class="' + (status === "removed" ? "danger" : "primary") + '" data-action="move-agent" data-status="' + esc(status) + '" data-tool="' + esc(tool) + '" ' + (uiState.busy ? "disabled" : "") + '>' + esc(t("Apply This Agent", "이 에이전트 반영")) + '</button>';
      return '<div class="agent-block"><div class="agent-head"><div><span class="agent-name">' + esc(tool) + '</span> <span class="agent-count">' + esc(t("Skills ", "스킬 ")) + esc(skills.length) + '</span></div>' + button + '</div><div class="rows">' + skills.map((skill)=>renderSkillRow(skill, status)).join("") + '</div></div>';
    }
    function renderGroupAgentBlock(status, tool, groups){
      const button = status === "same" || groups.length === 0 ? "" : '<button class="' + (status === "removed" ? "danger" : "primary") + '" data-action="move-agent-groups" data-status="' + esc(status) + '" data-tool="' + esc(tool) + '" ' + (uiState.busy ? "disabled" : "") + '>' + esc(t("Apply This Agent Visible Groups", "이 에이전트 보이는 그룹 반영")) + '</button>';
      return '<div class="agent-block"><div class="agent-head"><div><span class="agent-name">' + esc(tool) + '</span> <span class="agent-count">' + esc(t("Groups ", "그룹 ")) + esc(groups.length) + '</span></div>' + button + '</div><div class="rows">' + groups.map((group)=>renderGroupRow(group, status)).join("") + '</div></div>';
    }
    function renderStatusSection(status, bucket){
      const info = statusInfoFor(status);
      const skills = bucket ? bucket.skills : skillsByStatus(status);
      const groupDiffs = bucket ? bucket.groups : groupsByStatus(status);
      const totalRows = Math.max(skills.length, groupDiffs.length);
      const currentPage = clampPage(status, totalRows);
      const currentPageSuffix = totalRows > PAGE_SIZE
        ? (isKo() ? " · " + currentPage + "/" + pageCount(totalRows) + " 페이지" : " · " + currentPage + "/" + pageCount(totalRows) + " pages")
        : "";
      const visibleSkillRows = pageSlice(status, skills, totalRows);
      const visibleGroupRows = pageSlice(status, groupDiffs, totalRows);
      const actions = [];
      if (status !== "same" && skills.length > 0) {
        actions.push('<button class="' + (status === "removed" ? "danger" : "primary") + '" data-action="move-status" data-status="' + esc(status) + '" ' + (uiState.busy ? "disabled" : "") + '>' + esc(t("Apply All Skills", "스킬 전체 반영")) + '</button>');
      }
      if (status !== "same" && groupDiffs.length > 0) {
        actions.push('<button class="' + (status === "removed" ? "danger" : "primary") + '" data-action="move-status-groups" data-status="' + esc(status) + '" ' + (uiState.busy ? "disabled" : "") + '>' + esc(t("Apply Visible Groups", "보이는 그룹 반영")) + '</button>');
      }
      const action = actions.join("");
      const skillBlocks = groupByTool(visibleSkillRows).map(([tool, rows])=>renderAgentBlock(status, tool, rows)).join("");
      const groupBlocks = groupByTool(visibleGroupRows).map(([tool, rows])=>renderGroupAgentBlock(status, tool, rows)).join("");
      const skillBody = visibleSkillRows.length
        ? '<div class="subsection"><div class="subsection-head"><span class="subsection-name">' + esc(t("Skills", "스킬")) + '</span><span>' + esc(t("Skills ", "스킬 ")) + esc(skills.length) + esc(currentPageSuffix) + '</span></div><div class="subsection-grid">' + skillBlocks + '</div></div>'
        : "";
      const groupBody = visibleGroupRows.length
        ? '<div class="subsection"><div class="subsection-head"><span class="subsection-name">' + esc(t("Skill Groups", "스킬 그룹")) + '</span><span>' + esc(t("Groups ", "그룹 ")) + esc(groupDiffs.length) + esc(currentPageSuffix) + '</span></div><div class="subsection-grid">' + groupBlocks + '</div></div>'
        : "";
      const empty = !skillBody && !groupBody ? '<div class="empty">' + esc(t("No skills or groups match the current filter.", "현재 필터와 맞는 스킬이나 그룹이 없습니다.")) + '</div>' : "";
      const pager = renderPager(status, totalRows);
      const body = skillBody + groupBody + empty + pager;
      return '<section class="section"><div class="section-head"><div class="section-title"><span class="badge ' + info.cls + '">' + info.label + '</span><div><div class="section-name">' + esc(info.title) + ' · ' + esc(t("Skills ", "스킬 ")) + esc(skills.length) + ' · ' + esc(t("Groups ", "그룹 ")) + esc(groupDiffs.length) + '</div><div class="section-desc">' + esc(info.desc) + '</div></div></div><div class="section-actions">' + action + '</div></div>' + (body ? '<div class="section-body">' + body + '</div>' : '') + '</section>';
    }
    function render(){
      if (renderFrame) {
        cancelAnimationFrame(renderFrame);
        renderFrame = 0;
      }
      const buckets = createStatusBuckets();
      renderModeSwitch();
      renderSummary(buckets);
      renderResultMeta(buckets);
      renderTabs();
      const activeStatus = normalizeStatus(uiState.activeStatus);
      uiState.activeStatus = activeStatus;
      document.getElementById("sections").innerHTML = renderStatusSection(activeStatus, buckets[activeStatus]);
    }
    function bindActions(){
      document.body.addEventListener("click",(ev)=>{
        const target = ev.target;
        const button = target instanceof Element ? target.closest("[data-action]") : null;
        if (!(button instanceof HTMLElement) || !document.body.contains(button)) return;
        const action = button.getAttribute("data-action") || "";
        if (action === "mode") {
          uiState.mode = button.getAttribute("data-mode") || "workspaceToCentral";
          resetPages();
          setStatus(t("Direction changed: ", "방향 변경: ") + directionText(), "info");
          render();
          return;
        }
        if (action === "tab") {
          uiState.selectedTool = button.getAttribute("data-tool") || "all";
          resetPages();
          render();
          return;
        }
        if (action === "status-filter") {
          uiState.activeStatus = normalizeStatus(button.getAttribute("data-status") || "modified");
          resetPages();
          render();
          return;
        }
        if (action === "move-status") {
          const status = button.getAttribute("data-status") || "modified";
          postMove(status, skillsByStatus(status));
          return;
        }
        if (action === "move-status-groups") {
          const status = button.getAttribute("data-status") || "modified";
          postMoveGroups(status, groupsByStatus(status));
          return;
        }
        if (action === "move-agent") {
          const status = button.getAttribute("data-status") || "modified";
          const tool = button.getAttribute("data-tool") || "";
          postMove(status, skillsByStatus(status).filter((skill)=>skill.tool === tool));
          return;
        }
        if (action === "move-agent-groups") {
          const status = button.getAttribute("data-status") || "modified";
          const tool = button.getAttribute("data-tool") || "";
          postMoveGroups(status, groupsByStatus(status).filter((group)=>group.tool === tool));
          return;
        }
        if (action === "move-skill") {
          const status = button.getAttribute("data-status") || "modified";
          const skill = findSkillByKey(button.getAttribute("data-key") || "");
          if (skill) postMove(status, [skill]);
          return;
        }
        if (action === "move-group-diff") {
          const status = button.getAttribute("data-status") || "modified";
          const group = findGroupByKey(button.getAttribute("data-key") || "");
          if (group) postMoveGroups(status, [group]);
          return;
        }
        if (action === "open-diff") {
          const skill = findSkillByKey(button.getAttribute("data-key") || "");
          if (skill) openDiff(skill);
          return;
        }
        if (action === "toggle-section") {
          const status = normalizeStatus(button.getAttribute("data-status") || "modified");
          uiState.collapsed[status] = !uiState.collapsed[status];
          render();
          return;
        }
        if (action === "page-section") {
          const status = normalizeStatus(button.getAttribute("data-status") || "modified");
          const dir = Number(button.getAttribute("data-dir")) || 0;
          uiState.page[status] = (Number(uiState.page[status]) || 1) + dir;
          render();
        }
      });
    }
    window.addEventListener("message", (event)=>{
      const msg = event.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "state") {
        state = msg.payload || state;
        resetPages();
        render();
      }
      if (msg.type === "ui") {
        const payload = msg.payload || {};
        if (typeof payload.busy === "boolean") uiState.busy = payload.busy;
        setStatus(payload.message || (uiState.busy ? t("Working...", "작업 중...") : t("Ready", "준비 완료")), payload.tone || "info");
        render();
      }
    });
    document.getElementById("searchInput").addEventListener("input", (ev)=>{
      const target = ev.target;
      if (!(target instanceof HTMLInputElement)) return;
      uiState.query = target.value || "";
      resetPages();
      scheduleRender();
    });
    document.getElementById("refreshBtn").addEventListener("click", ()=>{
      if (uiState.busy) return;
      vscode.postMessage({ type: "refresh" });
    });
    setStatus(t("Ready", "준비 완료") + " · " + directionText(), "info");
    bindActions();
    render();
  </script>
</body>
</html>`;
}


