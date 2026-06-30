import type * as vscode from "vscode";
import type { TransferPlan, TransferPlanItem, TransferStatus, ToolType } from "./types";
import type { FolderDiffRow, FolderEntryRow } from "./skillPaths";
import type { UiLanguage } from "./uiLanguage";

export type FolderDiffSummaryRow = {
  key: string;
  relativePath: string;
  entryKind: "file" | "folder";
  changeCode: "A" | "D" | "M" | "T" | "=";
  status: TransferStatus;
  sourceState: string;
  targetState: string;
  decisionText: string;
  riskLevel: "low" | "medium" | "high";
};

export function buildFolderDiffSummaryRows(items: TransferPlanItem[], mode: TransferPlan["mode"]): FolderDiffSummaryRow[] {
  const rows = items.map((item) => {
    const sourceState = item.status === "removed" ? "Missing" : item.entryKind === "folder" ? "Folder" : "File";
    const targetState = item.status === "added" ? "Missing" : item.entryKind === "folder" ? "Folder" : "File";
    const riskLevel: "low" | "medium" | "high" = item.status === "typeChanged"
      ? "high"
      : item.status === "modified" || item.status === "removed"
        ? "medium"
        : "low";
    return {
      key: item.key,
      relativePath: item.relativePath,
      entryKind: item.entryKind,
      changeCode: toChangeCode(item.status),
      status: item.status,
      sourceState,
      targetState,
      decisionText: getDecisionText(item, mode),
      riskLevel
    };
  });
  rows.sort((a, b) => {
    const aSame = a.changeCode === "=" ? 1 : 0;
    const bSame = b.changeCode === "=" ? 1 : 0;
    if (aSame !== bSame) return aSame - bSame;
    const aSkill = /(^|\/)SKILL\.md$/i.test(a.relativePath) ? 0 : 1;
    const bSkill = /(^|\/)SKILL\.md$/i.test(b.relativePath) ? 0 : 1;
    if (aSkill !== bSkill) return aSkill - bSkill;
    return a.relativePath.localeCompare(b.relativePath);
  });
  return rows;
}

export function renderFolderDiffSummaryHtml(
  webview: vscode.Webview,
  data: {
    mode: TransferPlan["mode"];
    tool: string;
    relativePath: string;
    rows: FolderDiffSummaryRow[];
  },
  language: UiLanguage = "en"
): string {
  void webview;
  const esc = (value: string): string =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const isKo = language === "ko";
  const t = (english: string, korean: string): string => isKo ? korean : english;
  const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sourceLabel = data.mode === "workspaceToCentral" ? t("Workspace (Current)", "작업공간 (현재)") : t("Central (Current)", "중앙 (현재)");
  const targetLabel = data.mode === "workspaceToCentral" ? t("Central (After Apply)", "중앙 (반영 후)") : t("Workspace (After Apply)", "작업공간 (반영 후)");
  const stateLabel = (value: string): string => {
    if (value === "Missing") return t("Missing", "없음");
    if (value === "Folder") return t("Folder", "폴더");
    if (value === "File") return t("File", "파일");
    return value;
  };
  const riskLabel = (value: FolderDiffSummaryRow["riskLevel"]): string => {
    if (value === "high") return t("high", "높음");
    if (value === "medium") return t("medium", "보통");
    return t("low", "낮음");
  };
  const decisionLabel = (row: FolderDiffSummaryRow): string => {
    const sourceSideLabel = data.mode === "workspaceToCentral" ? t("Workspace", "작업공간") : t("Central", "중앙");
    const targetSideLabel = data.mode === "workspaceToCentral" ? t("Central", "중앙") : t("Workspace", "작업공간");
    if (row.status === "added") return t(`Exists in ${sourceSideLabel}, missing in ${targetSideLabel}`, `${sourceSideLabel}에 있고 ${targetSideLabel}에는 없습니다`);
    if (row.status === "removed") return t(`Missing in ${sourceSideLabel}, exists in ${targetSideLabel}`, `${sourceSideLabel}에는 없고 ${targetSideLabel}에 있습니다`);
    if (row.status === "modified") return t("Exists on both sides with different contents", "양쪽에 있지만 내용이 다릅니다");
    if (row.status === "typeChanged") return t("Type mismatch (file/folder)", "타입이 다릅니다 (파일/폴더)");
    return t("Same on both sides", "양쪽이 같습니다");
  };
  const codeToLabel = (code: FolderDiffSummaryRow["changeCode"]): string => {
    if (code === "A") return t("New", "신규");
    if (code === "D") return t("Delete", "삭제");
    if (code === "M") return t("Modified", "수정");
    if (code === "T") return t("Type Conflict", "타입 충돌");
    return t("Same", "동일");
  };
  const tableRows = data.rows.map((row) => {
    const isSkill = /(^|\/)SKILL\.md$/i.test(row.relativePath);
    const searchText = `${row.relativePath} ${row.changeCode} ${row.status} ${row.sourceState} ${row.targetState} ${row.decisionText}`;
    return `<tr data-search="${esc(searchText.toLowerCase())}" data-change="${esc(row.changeCode)}">
      <td><span class="badge change-${esc(row.changeCode)}">${esc(codeToLabel(row.changeCode))}</span></td>
      <td><span class="path">${esc(row.relativePath)}</span> ${isSkill ? "<b>[SKILL.md]</b>" : ""}<button class="copy" data-copy="${esc(row.relativePath)}" title="${esc(t("Copy path", "경로 복사"))}">${esc(t("Copy", "복사"))}</button></td>
      <td>${esc(stateLabel(row.sourceState))}</td>
      <td>${esc(stateLabel(row.targetState))}</td>
      <td>${esc(decisionLabel(row))}</td>
      <td>${esc(riskLabel(row.riskLevel))}</td>
    </tr>`;
  }).join("");

  return `<!doctype html>
<html lang="${language}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(t("Folder Diff Summary", "폴더 Diff 요약"))}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; height: 100vh; overflow: hidden; }
    .wrap { height: 100vh; padding: 10px; display: grid; gap: 8px; grid-template-rows: auto auto auto minmax(0, 1fr); }
    .head { display: flex; justify-content: space-between; gap: 10px; align-items: center; min-width: 0; flex-wrap: wrap; }
    h2 { margin: 0; font-size: 16px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pills { display: flex; gap: 6px; align-items: center; overflow-x: auto; scrollbar-gutter: stable; }
    .pill { border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 3px 8px; font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
    .pill strong { color: var(--vscode-foreground); }
    .controls { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    input, button { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 5px; padding: 5px 8px; font: inherit; }
    input { min-width: min(360px, 58vw); max-width: 100%; }
    input[type="checkbox"] { min-width: 0; }
    button { cursor: pointer; }
    .table-wrap { border: 1px solid var(--vscode-panel-border); border-radius: 7px; overflow: auto; min-height: 0; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
    thead { background: var(--vscode-sideBar-background); position: sticky; top: 0; z-index: 1; }
    tbody tr:hover { background: var(--vscode-list-hoverBackground); }
    .badge { display: inline-block; border-radius: 999px; padding: 2px 8px; font-size: 11px; }
    .change-A { background: rgba(34, 197, 94, .18); color: #22c55e; }
    .change-D { background: rgba(239, 68, 68, .18); color: #ef4444; }
    .change-M { background: rgba(245, 158, 11, .18); color: #f59e0b; }
    .change-T { background: rgba(244, 114, 182, .18); color: #f472b6; }
    .change-= { background: rgba(148, 163, 184, .18); color: var(--vscode-descriptionForeground); }
    .path { display: inline-block; max-width: 460px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
    .copy { margin-left: 6px; padding: 2px 6px; font-size: 11px; }
    .hidden-row { display: none; }
    @media (max-width: 760px) {
      .controls { align-items: stretch; }
      input { min-width: 100%; }
      table { min-width: 820px; }
      .path { max-width: 56vw; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="head">
      <h2 title="${esc(`${data.tool}/${data.relativePath}`)}">${esc(t("Folder Diff Summary", "폴더 Diff 요약"))}: ${esc(data.tool)}/${esc(data.relativePath)}</h2>
      <span id="visibleCount" class="pill">${esc(t("Files", "파일"))} ${data.rows.length}</span>
    </div>
    <div class="pills">
      <span class="pill">${esc(t("Source", "원본"))} <strong>${esc(sourceLabel)}</strong></span>
      <span class="pill">${esc(t("Target", "대상"))} <strong>${esc(targetLabel)}</strong></span>
      <span class="pill">${esc(t("Rows", "행"))} <strong>${data.rows.length}</strong></span>
    </div>
    <div class="controls">
      <input id="search" placeholder="${esc(t("Search path, change, or decision...", "경로, 변경 종류, 판단 검색..."))}" />
      <label class="pill"><input id="changedOnly" type="checkbox" checked /> ${esc(t("Changed only", "변경 항목만"))}</label>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>${esc(t("Change", "변경"))}</th><th>${esc(t("Path", "경로"))}</th><th>${esc(sourceLabel)}</th><th>${esc(targetLabel)}</th><th>${esc(t("Decision", "판단"))}</th><th>${esc(t("Risk", "위험도"))}</th></tr></thead>
        <tbody>${tableRows || `<tr><td colspan="6">${esc(t("No rows to show.", "표시할 행이 없습니다."))}</td></tr>`}</tbody>
      </table>
    </div>
  </div>
  <script nonce="${nonce}">
    const rows = Array.from(document.querySelectorAll("tbody tr[data-search]"));
    const search = document.getElementById("search");
    const changedOnly = document.getElementById("changedOnly");
    const visibleCount = document.getElementById("visibleCount");
    function applyFilters(){
      const q = search instanceof HTMLInputElement ? search.value.trim().toLowerCase() : "";
      const changed = changedOnly instanceof HTMLInputElement ? changedOnly.checked : false;
      let visible = 0;
      for (const row of rows) {
        const text = row.getAttribute("data-search") || "";
        const change = row.getAttribute("data-change") || "";
        const show = (!q || text.includes(q)) && (!changed || change !== "=");
        row.classList.toggle("hidden-row", !show);
        if (show) visible += 1;
      }
      visibleCount.textContent = ${JSON.stringify(t("Files", "파일"))} + " " + visible + " / " + rows.length;
    }
    document.body.addEventListener("click", (event) => {
      const copy = event.target instanceof Element ? event.target.closest("[data-copy]") : null;
      if (!(copy instanceof HTMLElement)) return;
      const value = copy.getAttribute("data-copy") || "";
      navigator.clipboard.writeText(value).then(() => {
        copy.textContent = ${JSON.stringify(t("Copied", "복사됨"))};
        setTimeout(() => { copy.textContent = ${JSON.stringify(t("Copy", "복사"))}; }, 900);
      }).catch(() => {
        copy.textContent = ${JSON.stringify(t("Failed", "실패"))};
        setTimeout(() => { copy.textContent = ${JSON.stringify(t("Copy", "복사"))}; }, 900);
      });
    });
    search?.addEventListener("input", applyFilters);
    changedOnly?.addEventListener("change", applyFilters);
    applyFilters();
  </script>
</body>
</html>`;
}

export function renderFolderTransferDiffHtml(
  webview: vscode.Webview,
  data: {
    tool: ToolType;
    relativePath: string;
    status: TransferStatus;
    totalFiles: number;
    totalSourceBytes: number;
    totalTargetBytes: number;
    addedCount: number;
    modifiedCount: number;
    removedCount: number;
    sameCount: number;
    skillMdCount: number;
    rows: FolderDiffRow[];
  },
  language: UiLanguage = "en"
): string {
  void webview;
  const esc = (value: string): string =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const isKo = language === "ko";
  const t = (english: string, korean: string): string => isKo ? korean : english;
  const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const treeRows = data.rows.map((row) => {
    const isSkill = /(^|\/)SKILL\.md$/i.test(row.relativePath);
    const sizeDelta = row.sourceSize !== null && row.targetSize !== null ? row.sourceSize - row.targetSize : null;
    const sizeDeltaLabel = sizeDelta === null ? "-" : sizeDelta > 0 ? `+${sizeDelta} B` : `${sizeDelta} B`;
    const searchText = `${row.relativePath} ${row.status} ${sizeDeltaLabel} ${row.sourceMtime ?? ""} ${row.targetMtime ?? ""}`;
    return `<tr data-search="${esc(searchText.toLowerCase())}" data-change="${esc(row.status)}">
      <td class="status-${esc(row.status)}"><b>${esc(row.status)}</b></td>
      <td><span class="path">${esc(row.relativePath)}</span> ${isSkill ? "<b>[SKILL.md]</b>" : ""}<button class="copy" data-copy="${esc(row.relativePath)}" title="${esc(t("Copy path", "경로 복사"))}">${esc(t("Copy", "복사"))}</button></td>
      <td>${row.sourceSize ?? "-"}${row.sourceSize === null ? "" : " B"}</td>
      <td>${row.targetSize ?? "-"}${row.targetSize === null ? "" : " B"}</td>
      <td>${esc(sizeDeltaLabel)}</td>
      <td>${row.sourceMtime ? esc(row.sourceMtime) : "-"}</td>
      <td>${row.targetMtime ? esc(row.targetMtime) : "-"}</td>
    </tr>`;
  }).join("");

  return `<!doctype html>
<html lang="${language}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(t("Folder Diff", "폴더 Diff"))}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; height: 100vh; overflow: hidden; }
    .wrap { height: 100vh; padding: 10px; display: grid; gap: 8px; grid-template-rows: auto auto auto minmax(0, 1fr); }
    .head { display: flex; justify-content: space-between; gap: 10px; align-items: center; min-width: 0; flex-wrap: wrap; }
    h2 { margin: 0; font-size: 16px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pills { display: flex; gap: 6px; align-items: center; overflow-x: auto; scrollbar-gutter: stable; }
    .pill { border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 3px 8px; font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
    .pill strong { color: var(--vscode-foreground); }
    .controls { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    input, button { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 5px; padding: 5px 8px; font: inherit; }
    input { min-width: min(360px, 58vw); max-width: 100%; }
    input[type="checkbox"] { min-width: 0; }
    button { cursor: pointer; }
    .table-wrap { border: 1px solid var(--vscode-panel-border); border-radius: 7px; overflow: auto; min-height: 0; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
    thead { background: var(--vscode-sideBar-background); position: sticky; top: 0; z-index: 1; }
    tbody tr:hover { background: var(--vscode-list-hoverBackground); }
    .status-A { color: #22c55e; }
    .status-D { color: #ef4444; }
    .status-M { color: #f59e0b; }
    .status-= { color: var(--vscode-descriptionForeground); }
    .path { display: inline-block; max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
    .copy { margin-left: 6px; padding: 2px 6px; font-size: 11px; }
    .hidden-row { display: none; }
    @media (max-width: 760px) {
      .controls { align-items: stretch; }
      input { min-width: 100%; }
      table { min-width: 820px; }
      .path { max-width: 56vw; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="head">
      <h2 title="${esc(`${data.tool}/${data.relativePath}`)}">${esc(t("Folder Diff", "폴더 Diff"))}: ${esc(data.tool)}/${esc(data.relativePath)}</h2>
      <span id="visibleCount" class="pill">${esc(t("Files", "파일"))} ${data.rows.length}</span>
    </div>
    <div class="pills">
      <span class="pill">${esc(t("Status", "상태"))} <strong>${esc(data.status)}</strong></span>
      <span class="pill">${esc(t("Files", "파일"))} <strong>${data.totalFiles}</strong></span>
      <span class="pill">${esc(t("Changes", "변경"))} <strong>A ${data.addedCount} / M ${data.modifiedCount} / D ${data.removedCount}</strong></span>
      <span class="pill">${esc(t("Source", "원본"))} <strong>${data.totalSourceBytes} B</strong></span>
      <span class="pill">${esc(t("Target", "대상"))} <strong>${data.totalTargetBytes} B</strong></span>
      <span class="pill">SKILL.md <strong>${data.skillMdCount}</strong></span>
      <span class="pill">${esc(t("Same", "동일"))} <strong>${data.sameCount}</strong></span>
    </div>
    <div class="controls">
      <input id="search" placeholder="${esc(t("Search files, status, or modified date...", "파일, 상태, 수정 시각 검색..."))}" />
      <label class="pill"><input id="changedOnly" type="checkbox" checked /> ${esc(t("Changed only", "변경 항목만"))}</label>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>${esc(t("Change", "변경"))}</th><th>${esc(t("Path", "경로"))}</th><th>${esc(t("Source Size", "원본 크기"))}</th><th>${esc(t("Target Size", "대상 크기"))}</th><th>${esc(t("Difference", "차이"))}</th><th>${esc(t("Source Modified", "원본 수정 시각"))}</th><th>${esc(t("Target Modified", "대상 수정 시각"))}</th></tr></thead>
        <tbody>${treeRows || `<tr><td colspan="7">${esc(t("No files to show.", "표시할 파일이 없습니다."))}</td></tr>`}</tbody>
      </table>
    </div>
  </div>
  <script nonce="${nonce}">
    const rows = Array.from(document.querySelectorAll("tbody tr[data-search]"));
    const search = document.getElementById("search");
    const changedOnly = document.getElementById("changedOnly");
    const visibleCount = document.getElementById("visibleCount");
    function applyFilters(){
      const q = search instanceof HTMLInputElement ? search.value.trim().toLowerCase() : "";
      const changed = changedOnly instanceof HTMLInputElement ? changedOnly.checked : false;
      let visible = 0;
      for (const row of rows) {
        const text = row.getAttribute("data-search") || "";
        const change = row.getAttribute("data-change") || "";
        const show = (!q || text.includes(q)) && (!changed || change !== "=");
        row.classList.toggle("hidden-row", !show);
        if (show) visible += 1;
      }
      visibleCount.textContent = ${JSON.stringify(t("Files", "파일"))} + " " + visible + " / " + rows.length;
    }
    document.body.addEventListener("click", (event) => {
      const copy = event.target instanceof Element ? event.target.closest("[data-copy]") : null;
      if (!(copy instanceof HTMLElement)) return;
      const value = copy.getAttribute("data-copy") || "";
      navigator.clipboard.writeText(value).then(() => {
        copy.textContent = ${JSON.stringify(t("Copied", "복사됨"))};
        setTimeout(() => { copy.textContent = ${JSON.stringify(t("Copy", "복사"))}; }, 900);
      }).catch(() => {
        copy.textContent = ${JSON.stringify(t("Failed", "실패"))};
        setTimeout(() => { copy.textContent = ${JSON.stringify(t("Copy", "복사"))}; }, 900);
      });
    });
    search?.addEventListener("input", applyFilters);
    changedOnly?.addEventListener("change", applyFilters);
    applyFilters();
  </script>
</body>
</html>`;
}

export function renderTypeChangedTransferDiffHtml(
  webview: vscode.Webview,
  data: {
    tool: ToolType;
    relativePath: string;
    sourceKind: "file" | "folder" | "none";
    targetKind: "file" | "folder" | "none";
    sourceRows: FolderEntryRow[];
    targetRows: FolderEntryRow[];
  },
  language: UiLanguage = "en"
): string {
  void webview;
  const esc = (value: string): string =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const isKo = language === "ko";
  const t = (english: string, korean: string): string => isKo ? korean : english;
  const kindLabel = (value: "file" | "folder" | "none"): string => {
    if (value === "file") return t("file", "파일");
    if (value === "folder") return t("folder", "폴더");
    return t("none", "없음");
  };
  const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const renderRows = (rows: FolderEntryRow[]): string =>
    rows.map((row) => {
      const isSkill = /(^|\/)SKILL\.md$/i.test(row.relativePath);
      const searchText = `${row.relativePath} ${row.size} ${row.mtime}`;
      return `<tr data-search="${esc(searchText.toLowerCase())}">
        <td><span class="path">${esc(row.relativePath)}</span> ${isSkill ? "<b>[SKILL.md]</b>" : ""}<button class="copy" data-copy="${esc(row.relativePath)}" title="${esc(t("Copy path", "경로 복사"))}">${esc(t("Copy", "복사"))}</button></td>
        <td>${row.size} B</td>
        <td>${esc(row.mtime)}</td>
      </tr>`;
    }).join("") || `<tr><td colspan="3">${esc(t("No files to show.", "표시할 파일이 없습니다."))}</td></tr>`;

  return `<!doctype html>
<html lang="${language}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(t("Type Conflict Diff", "타입 충돌 Diff"))}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; height: 100vh; overflow: hidden; }
    .wrap { height: 100vh; padding: 10px; display: grid; gap: 8px; grid-template-rows: auto auto auto minmax(0, 1fr); }
    .head { display: flex; justify-content: space-between; gap: 10px; align-items: center; min-width: 0; flex-wrap: wrap; }
    h2 { margin: 0; font-size: 16px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pills { display: flex; gap: 6px; align-items: center; overflow-x: auto; scrollbar-gutter: stable; }
    .pill { border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 3px 8px; font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
    .pill strong { color: var(--vscode-foreground); }
    .controls { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    input, button { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 5px; padding: 5px 8px; font: inherit; }
    input { min-width: min(360px, 58vw); max-width: 100%; }
    button { cursor: pointer; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; min-height: 0; }
    .table-wrap { border: 1px solid var(--vscode-panel-border); border-radius: 7px; overflow: auto; min-height: 0; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
    thead { background: var(--vscode-sideBar-background); position: sticky; top: 0; z-index: 1; }
    tbody tr:hover { background: var(--vscode-list-hoverBackground); }
    .path { display: inline-block; max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
    .copy { margin-left: 6px; padding: 2px 6px; font-size: 11px; }
    .hidden-row { display: none; }
    @media (max-width: 860px) {
      .grid { grid-template-columns: 1fr; }
      .controls { align-items: stretch; }
      input { min-width: 100%; }
      table { min-width: 680px; }
      .path { max-width: 56vw; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="head">
      <h2 title="${esc(`${data.tool}/${data.relativePath}`)}">${esc(t("Type Conflict Diff", "타입 충돌 Diff"))}: ${esc(data.tool)}/${esc(data.relativePath)}</h2>
      <span id="visibleCount" class="pill">${esc(t("Files", "파일"))} ${data.sourceRows.length + data.targetRows.length}</span>
    </div>
    <div class="pills">
      <span class="pill">${esc(t("Source", "원본"))} <strong>${esc(kindLabel(data.sourceKind))}</strong></span>
      <span class="pill">${esc(t("Target", "대상"))} <strong>${esc(kindLabel(data.targetKind))}</strong></span>
      <span class="pill">${esc(t("After Apply", "반영 후"))} <strong>${esc(kindLabel(data.targetKind))} → ${esc(kindLabel(data.sourceKind))}</strong></span>
    </div>
    <div class="controls">
      <input id="search" placeholder="${esc(t("Search paths in both trees...", "양쪽 트리 경로 검색..."))}" />
    </div>
    <div class="grid">
      <div class="table-wrap">
        <table>
          <thead><tr><th colspan="3">${esc(t("Source Tree", "원본 트리"))}</th></tr><tr><th>${esc(t("Path", "경로"))}</th><th>${esc(t("Size", "크기"))}</th><th>${esc(t("Modified", "수정 시각"))}</th></tr></thead>
          <tbody>${renderRows(data.sourceRows)}</tbody>
        </table>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th colspan="3">${esc(t("Target Tree", "대상 트리"))}</th></tr><tr><th>${esc(t("Path", "경로"))}</th><th>${esc(t("Size", "크기"))}</th><th>${esc(t("Modified", "수정 시각"))}</th></tr></thead>
          <tbody>${renderRows(data.targetRows)}</tbody>
        </table>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">
    const rows = Array.from(document.querySelectorAll("tbody tr[data-search]"));
    const search = document.getElementById("search");
    const visibleCount = document.getElementById("visibleCount");
    function applyFilters(){
      const q = search instanceof HTMLInputElement ? search.value.trim().toLowerCase() : "";
      let visible = 0;
      for (const row of rows) {
        const text = row.getAttribute("data-search") || "";
        const show = !q || text.includes(q);
        row.classList.toggle("hidden-row", !show);
        if (show) visible += 1;
      }
      visibleCount.textContent = ${JSON.stringify(t("Files", "파일"))} + " " + visible + " / " + rows.length;
    }
    document.body.addEventListener("click", (event) => {
      const copy = event.target instanceof Element ? event.target.closest("[data-copy]") : null;
      if (!(copy instanceof HTMLElement)) return;
      const value = copy.getAttribute("data-copy") || "";
      navigator.clipboard.writeText(value).then(() => {
        copy.textContent = ${JSON.stringify(t("Copied", "복사됨"))};
        setTimeout(() => { copy.textContent = ${JSON.stringify(t("Copy", "복사"))}; }, 900);
      }).catch(() => {
        copy.textContent = ${JSON.stringify(t("Failed", "실패"))};
        setTimeout(() => { copy.textContent = ${JSON.stringify(t("Copy", "복사"))}; }, 900);
      });
    });
    search?.addEventListener("input", applyFilters);
    applyFilters();
  </script>
</body>
</html>`;
}

function toChangeCode(status: TransferStatus): "A" | "D" | "M" | "T" | "=" {
  if (status === "added") return "A";
  if (status === "removed") return "D";
  if (status === "modified") return "M";
  if (status === "typeChanged") return "T";
  return "=";
}

function getDecisionText(item: TransferPlanItem, mode: TransferPlan["mode"]): string {
  const sourceLabel = mode === "workspaceToCentral" ? "작업공간" : "중앙";
  const targetLabel = mode === "workspaceToCentral" ? "중앙" : "작업공간";
  if (item.status === "added") return `${sourceLabel}에는 있고 ${targetLabel}에는 없음`;
  if (item.status === "removed") return `${sourceLabel}에는 없고 ${targetLabel}에는 있음`;
  if (item.status === "modified") return "양쪽 모두 존재, 내용 다름";
  if (item.status === "typeChanged") return "타입 불일치(파일/폴더)";
  return "양쪽 동일";
}
