import type * as vscode from "vscode";
import { isToolType, normalizeRel } from "./extensionSupport";
import { healthLabel, renderBadge, sideLabel, sourceLabel, syncLabel } from "./groupOverviewLabels";
import { renderGroupOverviewStyles } from "./groupOverviewStyles";
import type { GroupOverviewData, GroupOverviewGroup, GroupOverviewSkillFolder, GroupOverviewTarget } from "./groupOverviewTypes";
import type { ToolType } from "./types";
import type { UiLanguage } from "./uiLanguage";
import { renderWebviewClientCommonScript } from "./webviewClientCommon";
import { createWebviewNonce } from "./webviewCommon";
import { renderWebviewCommonStyles } from "./webviewCommonStyles";

export function renderGroupOverviewHtml(webview: vscode.Webview, data: GroupOverviewData, language: UiLanguage): string {
  void webview;
  const isKo = language === "ko";
  const t = (english: string, korean: string): string => isKo ? korean : english;
  const nonce = createWebviewNonce();
  const activeAgent = data.agentFilter ?? "all";
  const agentButtons = [`<button class="chip sb-chip ${activeAgent === "all" ? "active" : ""}" data-agent-filter="all" type="button">All</button>`, ...data.agents.map((agent) => `<button class="chip sb-chip ${activeAgent === agent.agent ? "active" : ""}" data-agent-filter="${escAttr(agent.agent)}" type="button">${esc(formatAgent(agent.agent))}</button>`)].join("");
  const groupsForView = data.agents.flatMap((agent) => agent.groups);
  const selectedGroupId = groupsForView[0]?.id ?? "";
  const groupRows = groupsForView.map((group, index) => renderGroupRow(group, t, index === 0)).join("");
  const groupDetails = groupsForView.map((group, index) => renderGroupCard(group, t, index === 0)).join("");

  return `<!doctype html>
<html lang="${language}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(t("Group Overview", "그룹 개요"))}</title>
  <style>${renderWebviewCommonStyles()}${renderGroupOverviewStyles()}</style>
</head>
<body>
  <div class="wrap sb-root">
    <div class="top sb-topbar">
      <h1>${esc(t("Group Overview", "그룹 개요"))}: ${esc(data.side)}${data.agentFilter ? ` / ${esc(data.agentFilter)}` : ""}</h1>
      <div class="top-actions">
        <div id="summary" class="summary sb-muted">${data.groups.length} ${esc(t("groups", "그룹"))}</div>
        <button id="languageToggle" class="sb-button sb-button-ghost" type="button">${esc(isKo ? "English" : "한국어")}</button>
      </div>
    </div>
    <div class="controls">
      <div class="toolbar sb-toolbar">
        <input id="search" placeholder="${esc(t("Search agent, group, skill, or description...", "에이전트, 그룹, 스킬, 설명 검색..."))}" />
        <button id="expandAll" class="sb-button" type="button">${esc(t("Expand all", "모두 펼치기"))}</button>
        <button id="collapseAll" class="sb-button" type="button">${esc(t("Collapse all", "모두 접기"))}</button>
      </div>
      <div class="batch-actions sb-toolbar">
        <span id="selectedGroupCount" class="summary sb-muted">${esc(t("No groups selected", "선택 그룹 없음"))}</span>
        <button id="batchAddSkills" class="sb-button" type="button">${esc(t("Add existing skills to selected groups", "선택 그룹에 기존 스킬 추가"))}</button>
        <button id="batchTransferWithSkills" class="primary sb-button sb-button-primary" type="button">${esc(t("Apply selected groups + skills", "선택 그룹+스킬 반영"))}</button>
        <button id="batchTransferGroupOnly" class="sb-button" type="button">${esc(t("Apply selected group info only", "선택 그룹 정보만 반영"))}</button>
      </div>
    </div>
    <div id="agentFilter" class="agent-filter">
      ${agentButtons}
    </div>
    <main class="content">
      <section class="group-list sb-table-wrap">
        <table>
          <thead>
            <tr>
              <th style="width: 96px;">${esc(t("Agent", "에이전트"))}</th>
              <th class="group-check"><input id="toggleGroups" type="checkbox" title="${escAttr(t("Select visible groups", "보이는 그룹 선택"))}" /></th>
              <th>${esc(t("Group", "그룹"))}</th>
              <th style="width: 96px;">${esc(t("Side", "위치"))}</th>
              <th style="width: 96px;">${esc(t("Source", "출처"))}</th>
              <th style="width: 94px;">${esc(t("Status", "상태"))}</th>
              <th style="width: 82px;">${esc(t("Skills", "스킬"))}</th>
              <th style="width: 180px;">${esc(t("Latest file", "최신 파일"))}</th>
            </tr>
          </thead>
          <tbody>${groupRows || `<tr><td colspan="8">${esc(t("No groups to show.", "표시할 그룹이 없습니다."))}</td></tr>`}</tbody>
        </table>
      </section>
      <section class="detail-shell sb-panel">
        ${groupDetails || `<div class="empty sb-empty">${esc(t("Select a group to inspect.", "살펴볼 그룹을 선택하세요."))}</div>`}
      </section>
    </main>
    <div id="statusLine" class="sb-status-bar info">${esc(t("Ready", "준비 완료"))}</div>
  </div>
  <script nonce="${nonce}">
    ${renderWebviewClientCommonScript()}
    const vscode = acquireVsCodeApi();
    const search = document.getElementById("search");
    const summary = document.getElementById("summary");
    const agentFilter = document.getElementById("agentFilter");
    const rows = Array.from(document.querySelectorAll(".group-row"));
    const details = Array.from(document.querySelectorAll(".group-detail"));
    const statusController = window.SkillBridgeWebview?.createStatusController("statusLine");
    let activeGroup = "${esc(selectedGroupId)}";
    const activeAgents = new Set("${esc(activeAgent)}" === "all" ? [] : ["${esc(activeAgent)}"]);
    let busy = false;
    const selectedGroupCount = document.getElementById("selectedGroupCount");
    const toggleGroups = document.getElementById("toggleGroups");
    function setStatus(message, tone) { statusController?.set(message, tone || "info"); }
    function selectedGroupIds() { return Array.from(document.querySelectorAll(".group-row:not(.hidden) input[data-group-select]:checked")).map((item) => item.getAttribute("data-group-select") || "").filter(Boolean); }
    function syncBatchState() {
      const ids = selectedGroupIds();
      if (selectedGroupCount) selectedGroupCount.textContent = ids.length === 0 ? "${esc(t("No groups selected", "선택 그룹 없음"))}" : ids.length + " ${esc(t("groups selected", "개 그룹 선택"))}";
      document.querySelectorAll("#batchAddSkills,#batchTransferWithSkills,#batchTransferGroupOnly").forEach((item) => { if (item instanceof HTMLButtonElement) item.disabled = ids.length === 0; });
      const visibleChecks = Array.from(document.querySelectorAll(".group-row:not(.hidden) input[data-group-select]"));
      if (toggleGroups instanceof HTMLInputElement) {
        toggleGroups.checked = visibleChecks.length > 0 && visibleChecks.every((item) => item instanceof HTMLInputElement && item.checked);
        toggleGroups.indeterminate = visibleChecks.some((item) => item instanceof HTMLInputElement && item.checked) && !toggleGroups.checked;
      }
    }
    function postAction(message, button) {
      if (busy) return;
      busy = true;
      setStatus("${esc(t("Working...", "작업 중..."))}", "info");
      window.SkillBridgeWebview?.setBusy(document.querySelector(".sb-root"), true);
      document.querySelectorAll("button,input,textarea,select").forEach((item) => { if ("disabled" in item) item.disabled = true; });
      vscode.postMessage(message);
    }
    function applySearch() {
      const q = search instanceof HTMLInputElement ? search.value.trim().toLowerCase() : "";
      let visible = 0;
      let firstVisible = "";
      for (const row of rows) {
        const agentKey = String(row.getAttribute("data-agent") || "");
        const matchesActiveAgent = activeAgents.size === 0 || activeAgents.has(agentKey);
        const matches = matchesActiveAgent && (!q || String(row.getAttribute("data-search") || "").includes(q));
        row.classList.toggle("hidden", !matches);
        if (matches) {
          visible += 1;
          if (!firstVisible) firstVisible = String(row.getAttribute("data-group-id") || "");
        }
      }
      if (!activeGroup || !rows.some((row) => !row.classList.contains("hidden") && row.getAttribute("data-group-id") === activeGroup)) activeGroup = firstVisible;
      showGroup(activeGroup);
      if (summary) summary.textContent = visible + " ${esc(t("groups", "그룹"))}";
      syncBatchState();
    }
    function showGroup(groupId) { activeGroup = groupId || ""; for (const row of rows) row.classList.toggle("active", row.getAttribute("data-group-id") === activeGroup); for (const detail of details) detail.classList.toggle("hidden", detail.getAttribute("data-group-id") !== activeGroup); }
    function chooseAgent(value) {
      if (!value || value === "all") activeAgents.clear();
      else if (activeAgents.has(value)) activeAgents.delete(value);
      else activeAgents.add(value);
      agentFilter?.querySelectorAll("[data-agent-filter]").forEach((button) => {
        const value = button.getAttribute("data-agent-filter") || "all";
        button.classList.toggle("active", value === "all" ? activeAgents.size === 0 : activeAgents.has(value));
      });
      applySearch();
    }
    document.body.addEventListener("click", (event) => {
      const target = event.target;
      const save = target instanceof Element ? target.closest("button[data-save]") : null;
      if (save instanceof HTMLButtonElement) {
        const group = save.closest(".group-detail");
        const name = group?.querySelector("input[data-name]");
        const description = group?.querySelector("textarea[data-description]");
        postAction({
          type: "editGroup",
          groupId: save.getAttribute("data-save") || "",
          name: name instanceof HTMLInputElement ? name.value : "",
          description: description instanceof HTMLTextAreaElement ? description.value : ""
        }, save);
      }
      const transfer = target instanceof Element ? target.closest("button[data-transfer-group]") : null;
      if (transfer instanceof HTMLButtonElement) {
        postAction({
          type: "transferGroup",
          groupId: transfer.getAttribute("data-transfer-group") || "",
          mode: transfer.getAttribute("data-transfer-mode") || "withSkills"
        }, transfer);
      }
      const installNpx = target instanceof Element ? target.closest("button[data-install-npx]") : null;
      if (installNpx instanceof HTMLButtonElement) {
        postAction({ type: "installNpx", side: installNpx.getAttribute("data-install-npx") || "workspace" }, installNpx);
      }
      const addSkills = target instanceof Element ? target.closest("button[data-add-skills]") : null;
      if (addSkills instanceof HTMLButtonElement) {
        postAction({ type: "addSkills", groupId: addSkills.getAttribute("data-add-skills") || "" }, addSkills);
      }
      const removeSkills = target instanceof Element ? target.closest("button[data-remove-skills]") : null;
      if (removeSkills instanceof HTMLButtonElement) {
        const group = removeSkills.closest(".group-detail");
        const targets = Array.from(group?.querySelectorAll("input[data-skill-target]:checked") || []).map((input) => ({
          tool: input.getAttribute("data-tool") || "",
          relativePath: input.getAttribute("data-relative-path") || "",
          kind: "folder"
        }));
        postAction({ type: "removeSkills", groupId: removeSkills.getAttribute("data-remove-skills") || "", targets }, removeSkills);
      }
      if (target instanceof HTMLElement && target.id === "batchAddSkills") postAction({ type: "addSkillsToGroups", groupIds: selectedGroupIds() }, target);
      if (target instanceof HTMLElement && target.id === "batchTransferWithSkills") postAction({ type: "transferGroups", groupIds: selectedGroupIds(), mode: "withSkills" }, target);
      if (target instanceof HTMLElement && target.id === "batchTransferGroupOnly") postAction({ type: "transferGroups", groupIds: selectedGroupIds(), mode: "groupOnly" }, target);
      if (target instanceof HTMLElement && target.id === "expandAll") document.querySelectorAll("details").forEach((item) => { item.open = true; });
      if (target instanceof HTMLElement && target.id === "collapseAll") document.querySelectorAll("details").forEach((item) => { item.open = false; });
      if (target instanceof HTMLElement && target.id === "languageToggle") postAction({ type: "toggleLanguage" }, target);
      if (target instanceof HTMLInputElement && target.hasAttribute("data-group-select")) { syncBatchState(); return; }
      if (target instanceof HTMLInputElement && target.id === "toggleGroups") {
        document.querySelectorAll(".group-row:not(.hidden) input[data-group-select]").forEach((item) => { if (item instanceof HTMLInputElement) item.checked = target.checked; });
        syncBatchState();
        return;
      }
      const row = target instanceof Element ? target.closest(".group-row") : null;
      if (row instanceof HTMLElement) {
        showGroup(row.getAttribute("data-group-id") || "");
      }
    });
    document.querySelectorAll("input[data-skill-target]").forEach((item) => item.addEventListener("click", (event) => event.stopPropagation()));
    document.querySelectorAll("input[data-group-select]").forEach((item) => { item.addEventListener("click", (event) => event.stopPropagation()); item.addEventListener("change", syncBatchState); });
    agentFilter?.addEventListener("click", (event) => { const target = event.target; const button = target instanceof Element ? target.closest("[data-agent-filter]") : null; if (button instanceof HTMLElement) chooseAgent(button.getAttribute("data-agent-filter") || "all"); });
    search?.addEventListener("input", applySearch);
    applySearch();
  </script>
</body>
</html>`;
}

function renderGroupCard(group: GroupOverviewGroup, t: (english: string, korean: string) => string, active: boolean): string {
  const skillFolders = groupTargetsBySkillFolder(group.targets);
  const folderHtml = skillFolders.slice(0, 80).map((folder) => renderSkillFolder(folder, t)).join("");
  const searchText = `${group.agent} ${group.sourceDetail} ${group.name} ${group.description} ${group.targets.map((target) => `${target.path} ${target.description} ${target.historyProject}`).join(" ")}`;
  const primaryAction = group.side === "workspace"
    ? t("Save group + skills to Central", "그룹+스킬을 중앙에 반영")
    : t("Bring group + skills to Workspace", "그룹+스킬을 작업공간으로 가져오기");
  return `
    <article class="group-detail ${active ? "" : "hidden"}" data-group-id="${escAttr(group.id)}" data-search="${esc(searchText.toLowerCase())}">
      <div class="group-head">
        <div>
          <h3>${esc(group.name)}</h3>
          <div class="meta">
            ${renderBadge(sideLabel(group.side, t), group.side)}
            ${renderBadge(sourceLabel(group.source, t), group.source)}
            ${group.sourceDetail ? `<span class="pill sb-chip source-detail" title="${escAttr(group.sourceDetail)}">${esc(group.sourceDetail)}</span>` : ""}
            ${renderBadge(syncLabel(group.syncStatus, t), group.syncStatus)}
            ${renderBadge(healthLabel(group.health, group.brokenTargetCount, t), group.health)}
            <span class="pill sb-chip">${esc(t("Targets", "대상"))}: ${group.targetCount}</span>
            <span class="pill sb-chip">${esc(t("Latest file", "최신 파일"))}: ${esc(group.latestUpdatedAt)}</span>
            <span class="pill sb-chip">${esc(t("Latest applied", "최근 반영"))}: ${esc(group.latestHistoryAt)}</span>
          </div>
        </div>
        <div class="actions">
          <button class="primary sb-button sb-button-primary" data-transfer-group="${escAttr(group.id)}" data-transfer-mode="withSkills">${esc(primaryAction)}</button>
          <button class="sb-button" data-transfer-group="${escAttr(group.id)}" data-transfer-mode="groupOnly">${esc(t("Group info only", "그룹 정보만"))}</button>
          <button class="sb-button" data-add-skills="${escAttr(group.id)}">${esc(t("Add existing skills", "기존 스킬 추가"))}</button>
          <button class="sb-button" data-remove-skills="${escAttr(group.id)}">${esc(t("Remove from group", "그룹에서 제외"))}</button>
          <button class="sb-button" data-install-npx="${escAttr(group.side)}">${esc(t("Install from npx", "npx에서 설치"))}</button>
        </div>
      </div>
      <div class="edit">
        <input data-name value="${escAttr(group.name)}" aria-label="${escAttr(t("Group name", "그룹 이름"))}" />
        <textarea data-description aria-label="${escAttr(t("Group description", "그룹 설명"))}">${esc(group.description)}</textarea>
        <button class="primary sb-button sb-button-primary" data-save="${escAttr(group.id)}">${esc(t("Save", "저장"))}</button>
      </div>
      <details class="skill-section" open>
        <summary>${esc(t("Skills in this group", "이 그룹의 스킬"))} <span class="meta-inline">${skillFolders.length} ${esc(t("skills", "스킬"))}</span></summary>
        <div class="skill-folders">
          ${folderHtml || `<div class="empty sb-empty">${esc(t("No skills found.", "스킬을 찾지 못했습니다."))}</div>`}
        </div>
      </details>
    </article>
  `;
}

function renderGroupRow(group: GroupOverviewGroup, t: (english: string, korean: string) => string, active: boolean): string {
  const skillCount = groupTargetsBySkillFolder(group.targets).length;
  const searchText = `${group.agent} ${group.side} ${group.source} ${group.sourceDetail} ${group.syncStatus} ${group.name} ${group.description} ${group.targets.map((target) => `${target.path} ${target.description} ${target.historyProject}`).join(" ")}`;
  return `
    <tr class="group-row ${active ? "active" : ""}" data-group-id="${escAttr(group.id)}" data-agent="${escAttr(group.agent)}" data-search="${esc(searchText.toLowerCase())}">
      <td><span class="agent-label">${esc(formatAgent(group.agent))}</span></td>
      <td class="group-check"><input type="checkbox" data-group-select="${escAttr(group.id)}" title="${escAttr(t("Select group", "그룹 선택"))}" /></td>
      <td>
        <div class="group-name">${esc(group.name)}</div>
        <div class="group-desc" title="${escAttr(group.description || "-")}">${esc(group.description || t("No description", "설명 없음"))}</div>
      </td>
      <td>${renderBadge(sideLabel(group.side, t), group.side)}</td>
      <td>${renderBadge(sourceLabel(group.source, t), group.source)}</td>
      <td>${renderBadge(syncLabel(group.syncStatus, t), group.syncStatus)}</td>
      <td>${skillCount}</td>
      <td>${esc(group.latestUpdatedAt)}</td>
    </tr>
  `;
}

function renderSkillFolder(folder: GroupOverviewSkillFolder, t: (english: string, korean: string) => string): string {
  const rowHtml = folder.files.map((target) => `
    <tr>
      <td><div class="path" title="${esc(target.path)}">${esc(relativeFileLabel(target.path, folder.path))}</div></td>
      <td>${esc(target.kind)}</td>
      <td>${esc(target.updatedAt)}</td>
      <td>${esc(target.historyAt)}</td>
      <td>${esc(target.historyProject)}</td>
      <td><div class="skill-desc">${esc(target.description || "-")}</div></td>
    </tr>
  `).join("");
  return `
    <details class="skill-folder">
      <summary>
        <input type="checkbox" data-skill-target data-tool="${escAttr(folder.tool)}" data-relative-path="${escAttr(folder.relativePath)}" />
        <span class="folder-name">${esc(folder.name)}</span>
        <span class="folder-path">${esc(folder.path)}</span>
        <span class="meta-inline">${folder.files.length} ${esc(t("files", "파일"))}</span>
      </summary>
      <div class="folder-summary">
        <span class="pill sb-chip">${esc(t("Latest file", "최신 파일"))}: ${esc(folder.latestUpdatedAt)}</span>
        <span class="pill sb-chip">${esc(t("Latest applied", "최근 반영"))}: ${esc(folder.latestHistoryAt)}</span>
        ${folder.description ? `<span class="skill-desc">${esc(folder.description)}</span>` : ""}
      </div>
      <table>
        <thead>
          <tr>
            <th>${esc(t("File", "파일"))}</th>
            <th>${esc(t("Type", "종류"))}</th>
            <th>${esc(t("File updated", "파일 수정"))}</th>
            <th>${esc(t("Applied", "반영"))}</th>
            <th>${esc(t("Source", "출처"))}</th>
            <th>${esc(t("Description", "설명"))}</th>
          </tr>
        </thead>
        <tbody>${rowHtml}</tbody>
      </table>
    </details>
  `;
}

function groupTargetsBySkillFolder(targets: GroupOverviewTarget[]): GroupOverviewSkillFolder[] {
  const folders = new Map<string, GroupOverviewSkillFolder>();
  for (const target of targets) {
    const folderPath = skillFolderPathFromDisplayPath(target.path);
    const parsed = parseDisplaySkillFolder(folderPath);
    const folder = folders.get(folderPath) ?? {
      name: skillNameFromDisplayPath(folderPath),
      path: folderPath,
      relativePath: parsed?.relativePath ?? "skills",
      tool: parsed?.tool ?? "agents",
      files: [],
      latestUpdatedAt: "-",
      latestHistoryAt: "-",
      description: ""
    };
    folder.files.push(target);
    folder.latestUpdatedAt = maxIso([folder.latestUpdatedAt, target.updatedAt]);
    folder.latestHistoryAt = maxIso([folder.latestHistoryAt, target.historyAt]);
    if (!folder.description && /\/SKILL\.md$/i.test(target.path) && target.description && target.description !== "-") {
      folder.description = target.description;
    }
    folders.set(folderPath, folder);
  }
  return [...folders.values()].sort((left, right) =>
    right.latestUpdatedAt.localeCompare(left.latestUpdatedAt) || left.path.localeCompare(right.path)
  );
}

function skillFolderPathFromDisplayPath(value: string): string {
  const parts = value.split("/").filter(Boolean);
  const skillsIndex = parts.indexOf("skills");
  if (skillsIndex < 0 || !parts[skillsIndex + 1]) return value;
  return parts.slice(0, skillsIndex + 2).join("/");
}

function parseDisplaySkillFolder(value: string): { tool: ToolType; relativePath: string } | null {
  const parts = value.split("/").filter(Boolean);
  const tool = parts[0];
  if (!tool || !isToolType(tool)) return null;
  const skillsIndex = parts.indexOf("skills");
  if (skillsIndex < 0 || !parts[skillsIndex + 1]) return null;
  return {
    tool,
    relativePath: parts.slice(1, skillsIndex + 2).join("/")
  };
}

export function skillFolderRelativePath(value: string): string {
  const relativePath = normalizeRel(value);
  const parts = relativePath.split("/").filter(Boolean);
  const skillsIndex = parts.indexOf("skills");
  if (skillsIndex < 0 || !parts[skillsIndex + 1]) return relativePath;
  return parts.slice(0, skillsIndex + 2).join("/");
}

export function skillNameFromRelativePath(value: string): string {
  const parts = normalizeRel(value).split("/").filter(Boolean);
  return parts[parts.length - 1] ?? value;
}

function skillNameFromDisplayPath(value: string): string {
  const parts = value.split("/").filter(Boolean);
  return parts[parts.length - 1] || value;
}

function relativeFileLabel(value: string, folderPath: string): string {
  if (value === folderPath) return ".";
  const prefix = `${folderPath}/`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function formatAgent(agent: ToolType | "mixed"): string {
  return agent;
}

function maxIso(values: string[]): string {
  const valid = values.filter((value) => value && value !== "-");
  return valid.length > 0 ? valid.sort((left, right) => right.localeCompare(left))[0] : "-";
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escAttr(value: string): string {
  return esc(value).replace(/'/g, "&#39;");
}
