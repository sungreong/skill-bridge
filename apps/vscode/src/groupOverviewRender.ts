import type * as vscode from "vscode";
import { isToolType, normalizeRel } from "./extensionSupport";
import { healthLabel, renderBadge, sideLabel, sourceLabel, syncLabel } from "./groupOverviewLabels";
import { renderGroupOverviewStyles } from "./groupOverviewStyles";
import type { GroupOverviewData, GroupOverviewGroup, GroupOverviewSkillFolder, GroupOverviewTarget } from "./groupOverviewTypes";
import type { ToolType } from "./types";
import { localize, type UiLanguage } from "./uiLanguage";
import { renderWebviewClientCommonScript } from "./webviewClientCommon";
import { createWebviewNonce } from "./webviewCommon";
import { renderWebviewCommonStyles } from "./webviewCommonStyles";

export function renderGroupOverviewHtml(webview: vscode.Webview, data: GroupOverviewData, language: UiLanguage): string {
  void webview;
  const t = localize;
  const nonce = createWebviewNonce();
  const activeAgent = data.agentFilter ?? "all";
  const agentButtons = [`<button class="chip sb-chip ${activeAgent === "all" ? "active" : ""}" data-agent-filter="all" type="button">All</button>`, ...data.agents.map((agent) => `<button class="chip sb-chip ${activeAgent === agent.agent ? "active" : ""}" data-agent-filter="${escAttr(agent.agent)}" type="button">${esc(formatAgent(agent.agent))}</button>`)].join("");
  const groupsForView = data.agents.flatMap((agent) => agent.groups);
  const isSingleGroupView = groupsForView.length === 1;
  const selectedGroupId = groupsForView[0]?.id ?? "";
  const groupRows = groupsForView.map((group, index) => renderGroupRow(group, t, index === 0)).join("");
  const groupDetails = groupsForView.map((group, index) => renderGroupCard(group, t, index === 0)).join("");

  return `<!doctype html>
<html lang="${language}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(t("Group Overview"))}</title>
  <style>${renderWebviewCommonStyles()}${renderGroupOverviewStyles()}</style>
</head>
<body>
  <div class="wrap sb-root ${isSingleGroupView ? "single-group-view" : "multi-group-view"} ${data.agentFilter ? "filtered-agent-view" : ""}" data-selection-mode="none">
    <div class="top sb-topbar">
      <h1>${esc(t("Group Overview"))}: ${esc(data.side)}${data.agentFilter ? ` / ${esc(data.agentFilter)}` : ""}</h1>
      <div class="top-actions">
        <div id="summary" class="summary sb-muted">${data.groups.length} ${esc(t("groups"))}</div>
      </div>
    </div>
    <div class="controls">
      <div class="toolbar sb-toolbar">
        <input id="search" aria-label="${escAttr(t("Search groups and skills"))}" placeholder="${esc(t("Search agent, group, skill, or description..."))}" />
        <button id="expandAll" class="sb-button" type="button">${esc(t("Expand skill details"))}</button>
        <button id="collapseAll" class="sb-button" type="button">${esc(t("Collapse skill details"))}</button>
      </div>
      <div class="batch-actions sb-toolbar">
        <span id="selectedGroupCount" class="summary sb-muted">${esc(t("No groups selected"))}</span>
        <button id="batchAddSkills" class="sb-button" type="button">${esc(t("Add existing skills to selected groups"))}</button>
        <button id="batchTransferWithSkills" class="primary sb-button sb-button-primary" type="button">${esc(t("Apply selected groups + skills"))}</button>
        <button id="batchTransferGroupOnly" class="sb-button" type="button">${esc(t("Apply selected group info only"))}</button>
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
              <th style="width: 96px;">${esc(t("Agent"))}</th>
              <th class="group-check"><input id="toggleGroups" type="checkbox" aria-label="${escAttr(t("Select visible groups"))}" title="${escAttr(t("Select visible groups"))}" /></th>
              <th>${esc(t("Group"))}</th>
              <th style="width: 96px;">${esc(t("Source"))}</th>
              <th style="width: 94px;">${esc(t("Status"))}</th>
              <th style="width: 82px;">${esc(t("Skills"))}</th>
              <th style="width: 180px;">${esc(t("Latest file"))}</th>
            </tr>
          </thead>
          <tbody>${groupRows || `<tr><td colspan="7">${esc(t("No groups to show."))}</td></tr>`}</tbody>
        </table>
      </section>
      <section class="detail-shell sb-panel">
        ${groupDetails || `<div class="empty sb-empty">${esc(t("Select a group to inspect."))}</div>`}
      </section>
    </main>
    <div id="statusLine" class="sb-status-bar info" role="status" aria-live="polite">${esc(t("Ready"))}</div>
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
      if (selectedGroupCount) selectedGroupCount.textContent = ids.length === 0 ? "${esc(t("No groups selected"))}" : ids.length + " ${esc(t("groups selected"))}";
      document.querySelectorAll("#batchAddSkills,#batchTransferWithSkills,#batchTransferGroupOnly").forEach((item) => { if (item instanceof HTMLButtonElement) item.disabled = ids.length === 0; });
      const root = document.querySelector(".sb-root");
      root?.setAttribute("data-selection-mode", ids.length > 1 ? "multiple" : ids.length === 1 ? "single" : "none");
      const visibleChecks = Array.from(document.querySelectorAll(".group-row:not(.hidden) input[data-group-select]"));
      if (toggleGroups instanceof HTMLInputElement) {
        toggleGroups.checked = visibleChecks.length > 0 && visibleChecks.every((item) => item instanceof HTMLInputElement && item.checked);
        toggleGroups.indeterminate = visibleChecks.some((item) => item instanceof HTMLInputElement && item.checked) && !toggleGroups.checked;
      }
    }
    function postAction(message, button) {
      if (busy) return;
      busy = true;
      setStatus("${esc(t("Working..."))}", "info");
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
      if (summary) summary.textContent = visible + " ${esc(t("groups"))}";
      syncBatchState();
    }
    function showGroup(groupId) {
      activeGroup = groupId || "";
      for (const row of rows) {
        const selected = row.getAttribute("data-group-id") === activeGroup;
        row.classList.toggle("active", selected);
        row.setAttribute("aria-selected", String(selected));
      }
      for (const detail of details) detail.classList.toggle("hidden", detail.getAttribute("data-group-id") !== activeGroup);
    }
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
      const updateNpx = target instanceof Element ? target.closest("button[data-update-npx]") : null;
      if (updateNpx instanceof HTMLButtonElement) {
        postAction({ type: "updateNpxGroup", groupId: updateNpx.getAttribute("data-update-npx") || "" }, updateNpx);
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
      if (target instanceof HTMLElement && target.id === "expandAll") document.querySelectorAll("details.skill-folder").forEach((item) => { item.open = true; });
      if (target instanceof HTMLElement && target.id === "collapseAll") document.querySelectorAll("details.skill-folder").forEach((item) => { item.open = false; });
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
    document.querySelector(".group-list")?.addEventListener("keydown", (event) => {
      if (!(event instanceof KeyboardEvent) || (event.key !== "Enter" && event.key !== " ")) return;
      const target = event.target;
      const row = target instanceof Element ? target.closest(".group-row") : null;
      if (!(row instanceof HTMLElement) || target instanceof HTMLInputElement) return;
      event.preventDefault();
      showGroup(row.getAttribute("data-group-id") || "");
    });
    agentFilter?.addEventListener("click", (event) => { const target = event.target; const button = target instanceof Element ? target.closest("[data-agent-filter]") : null; if (button instanceof HTMLElement) chooseAgent(button.getAttribute("data-agent-filter") || "all"); });
    search?.addEventListener("input", applySearch);
    applySearch();
  </script>
</body>
</html>`;
}

function renderGroupCard(group: GroupOverviewGroup, t: (message: string, ...args: Array<string | number | boolean>) => string, active: boolean): string {
  const skillFolders = groupTargetsBySkillFolder(group.targets);
  const folderHtml = skillFolders.slice(0, 80).map((folder) => renderSkillFolder(folder, t)).join("");
  const searchText = `${group.agent} ${group.sourceDetail} ${group.name} ${group.description} ${group.targets.map((target) => `${target.path} ${target.description} ${target.historyProject}`).join(" ")}`;
  const primaryAction = group.side === "workspace"
    ? t("Save to Central")
    : t("Bring to Workspace");
  const transferHelp = group.side === "workspace"
    ? t("Send this group's skills to your Central library.")
    : t("Bring this group's skills into the current Workspace.");
  const hasAvailableTargets = group.availableTargetCount > 0;
  const unavailableTransferHelp = group.source === "npx"
    ? t("No source skill files are currently available. Run Install from npx on this side first.")
    : t("No source skill files are currently available for this group.");
  const transferTitle = hasAvailableTargets ? transferHelp : unavailableTransferHelp;
  const latestAppliedLabel = hasHistoryValue(group.latestHistoryAt) ? compactTimestamp(group.latestHistoryAt) : t("Not applied");
  return `
    <article class="group-detail ${active ? "" : "hidden"}" data-group-id="${escAttr(group.id)}" data-search="${esc(searchText.toLowerCase())}">
      <div class="group-head">
        <div>
          <h3>${esc(group.name)}</h3>
          <div class="meta">
            ${renderBadge(sideLabel(group.side, t), group.side)}
            ${renderBadge(sourceLabel(group.source, t), group.source)}
            ${renderBadge(syncLabel(group.syncStatus, t), group.syncStatus)}
            ${renderBadge(healthLabel(group.health, group.brokenTargetCount, t), group.health)}
          </div>
          ${group.sourceDetail ? `<div class="group-source-detail" title="${escAttr(group.sourceDetail)}">${esc(group.sourceDetail)}</div>` : ""}
          <div class="group-facts sb-muted">
            <span>${skillFolders.length} ${esc(t("skills"))}</span>
            <span>${group.availableTargetCount} ${esc(t("files available"))}</span>
            <span title="${escAttr(group.latestUpdatedAt)}">${esc(t("Updated"))}: ${esc(compactTimestamp(group.latestUpdatedAt))}</span>
            <span title="${escAttr(group.latestHistoryAt)}">${esc(t("Latest applied"))}: ${esc(latestAppliedLabel)}</span>
          </div>
          </div>
        <div class="actions">
          <div class="action-buttons">
            <button class="primary sb-button sb-button-primary" data-transfer-group="${escAttr(group.id)}" data-transfer-mode="withSkills" ${hasAvailableTargets ? "" : "disabled"} title="${escAttr(transferTitle)}">${esc(primaryAction)}</button>
            <details class="more-actions">
              <summary>${esc(t("More actions"))}</summary>
              <div class="more-actions-panel">
                <button class="sb-button" data-transfer-group="${escAttr(group.id)}" data-transfer-mode="groupOnly">${esc(t("Group info only (no files)"))}</button>
                <button class="sb-button" data-add-skills="${escAttr(group.id)}">${esc(t("Add existing skills"))}</button>
                <button class="sb-button" data-remove-skills="${escAttr(group.id)}">${esc(t("Remove from group"))}</button>
                ${group.source === "npx" ? `<button class="sb-button" data-update-npx="${escAttr(group.id)}" ${group.npxUpdateAvailable ? "" : "disabled"} title="${escAttr(group.npxUpdateAvailable ? t("Update tracked skills from the original npx repository.") : t("This npx group needs a repository URL and tracked skills before it can be updated."))}">${esc(t("Update from npx"))}</button>` : ""}
                <button class="sb-button" data-install-npx="${escAttr(group.side)}">${esc(t("Install from npx"))}</button>
              </div>
            </details>
          </div>
          <span class="transfer-help sb-muted">${esc(transferTitle)}</span>
        </div>
      </div>
      <details class="group-edit">
        <summary>${esc(t("Edit group info"))}</summary>
        <div class="edit">
          <label class="edit-field edit-name">
            <span>${esc(t("Group name"))}</span>
            <input data-name value="${escAttr(group.name)}" />
          </label>
          <div class="edit-actions">
            <button class="sb-button" type="button" data-save="${escAttr(group.id)}">${esc(t("Save changes"))}</button>
          </div>
          <label class="edit-field edit-description">
            <span>${esc(t("Description"))}</span>
            <textarea data-description rows="4" placeholder="${escAttr(t("Describe the purpose of this group and when its skills should be used together."))}">${esc(group.description)}</textarea>
            <small class="edit-help sb-muted">${esc(t("This description is included in group search and generated Skill Bridge metadata."))}</small>
          </label>
        </div>
      </details>
      <details class="skill-section" open>
        <summary>${esc(t("Skills in this group"))} <span class="meta-inline">${skillFolders.length} ${esc(t("skills"))}</span></summary>
        <div class="skill-folders">
          ${folderHtml || `<div class="empty sb-empty">${esc(t("No skills found."))}</div>`}
        </div>
      </details>
    </article>
  `;
}

function renderGroupRow(group: GroupOverviewGroup, t: (message: string, ...args: Array<string | number | boolean>) => string, active: boolean): string {
  const skillCount = groupTargetsBySkillFolder(group.targets).length;
  const searchText = `${group.agent} ${group.side} ${group.source} ${group.sourceDetail} ${group.syncStatus} ${group.name} ${group.description} ${group.targets.map((target) => `${target.path} ${target.description} ${target.historyProject}`).join(" ")}`;
  return `
    <tr class="group-row ${active ? "active" : ""}" data-group-id="${escAttr(group.id)}" data-agent="${escAttr(group.agent)}" data-search="${esc(searchText.toLowerCase())}" tabindex="0" aria-selected="${active}">
      <td><span class="agent-label">${esc(formatAgent(group.agent))}</span></td>
      <td class="group-check"><input type="checkbox" data-group-select="${escAttr(group.id)}" aria-label="${escAttr(t("Select group {0}", group.name))}" title="${escAttr(t("Select group"))}" /></td>
      <td>
        <div class="group-title-line">
          <div class="group-name">${esc(group.name)}</div>
          <span class="group-compact-meta">${esc(sourceLabel(group.source, t))} · ${skillCount} ${esc(t("skills"))}</span>
        </div>
        <div class="group-desc" title="${escAttr(group.description || "-")}">${esc(group.description || t("No description"))}</div>
      </td>
      <td>${renderBadge(sourceLabel(group.source, t), group.source)}</td>
      <td>${renderBadge(syncLabel(group.syncStatus, t), group.syncStatus)}</td>
      <td>${skillCount}</td>
      <td><span title="${escAttr(group.latestUpdatedAt)}">${esc(compactTimestamp(group.latestUpdatedAt))}</span></td>
    </tr>
  `;
}

function renderSkillFolder(folder: GroupOverviewSkillFolder, t: (message: string, ...args: Array<string | number | boolean>) => string): string {
  const entries = folder.files.map((target) => ({
    target,
    label: normalizeRel(relativeFileLabel(target.path, folder.path))
  }));
  const mainEntry = entries.find((entry) => entry.label.toLowerCase() === "skill.md");
  const supportingEntries = entries.filter((entry) => entry !== mainEntry);
  const rootEntries = supportingEntries.filter((entry) => !entry.label.includes("/"));
  const directoryGroups = new Map<string, Array<(typeof entries)[number]>>();
  for (const entry of supportingEntries) {
    const separatorIndex = entry.label.indexOf("/");
    if (separatorIndex < 0) continue;
    const directory = entry.label.slice(0, separatorIndex);
    const groupedEntries = directoryGroups.get(directory) ?? [];
    groupedEntries.push(entry);
    directoryGroups.set(directory, groupedEntries);
  }
  const directoryPriority = ["references", "scripts", "assets", "templates"];
  const sortedDirectories = [...directoryGroups.entries()].sort(([left], [right]) => {
    const leftIndex = directoryPriority.indexOf(left);
    const rightIndex = directoryPriority.indexOf(right);
    if (leftIndex >= 0 || rightIndex >= 0) return (leftIndex < 0 ? directoryPriority.length : leftIndex) - (rightIndex < 0 ? directoryPriority.length : rightIndex);
    return left.localeCompare(right);
  });
  const renderFileRows = (files: Array<(typeof entries)[number]>, directory = ""): string => files
    .sort((left, right) => left.label.localeCompare(right.label))
    .map((entry) => {
      const displayLabel = directory ? entry.label.slice(directory.length + 1) : entry.label;
      const historyHtml = hasHistoryValue(entry.target.historyAt)
        ? `<div class="file-history">${esc(t("Applied"))}: ${esc(compactTimestamp(entry.target.historyAt))}${hasHistoryValue(entry.target.historyProject) ? ` · ${esc(entry.target.historyProject)}` : ""}</div>`
        : "";
      return `
        <tr>
          <td><div class="path" title="${escAttr(entry.target.path)}">${esc(displayLabel)}</div></td>
          <td><span title="${escAttr(entry.target.updatedAt)}">${esc(compactTimestamp(entry.target.updatedAt))}</span>${historyHtml}</td>
          <td><div class="skill-desc">${esc(entry.target.description || "-")}</div></td>
        </tr>
      `;
    }).join("");
  const renderFileGroup = (label: string, files: Array<(typeof entries)[number]>, directory = "", open = false): string => `
    <details class="file-directory" ${open ? "open" : ""}>
      <summary>
        <span class="file-directory-name">${esc(label)}</span>
        <span class="meta-inline">${files.length} ${esc(t("files"))}</span>
      </summary>
      <table class="file-table">
        <thead>
          <tr>
            <th>${esc(t("File"))}</th>
            <th>${esc(t("Updated / applied"))}</th>
            <th>${esc(t("Description"))}</th>
          </tr>
        </thead>
        <tbody>${renderFileRows(files, directory)}</tbody>
      </table>
    </details>
  `;
  const mainDescription = mainEntry?.target.description || folder.description;
  const mainHistoryHtml = mainEntry && hasHistoryValue(mainEntry.target.historyAt)
    ? `<span title="${escAttr(mainEntry.target.historyAt)}">${esc(t("Applied"))}: ${esc(compactTimestamp(mainEntry.target.historyAt))}</span>`
    : "";
  const mainFileHtml = mainEntry ? `
    <div class="main-skill-file">
      <div class="main-file-heading">
        <span class="main-file-name">SKILL.md</span>
        <span class="badge same">${esc(t("Main instructions"))}</span>
      </div>
      ${mainDescription ? `<div class="main-file-description">${esc(mainDescription)}</div>` : ""}
      <div class="main-file-meta sb-muted">
        <span title="${escAttr(mainEntry.target.updatedAt)}">${esc(t("Updated"))}: ${esc(compactTimestamp(mainEntry.target.updatedAt))}</span>
        ${mainHistoryHtml}
      </div>
    </div>
  ` : `<div class="main-skill-file missing-main"><strong>SKILL.md</strong> ${esc(t("was not found."))}</div>`;
  const fileGroupsHtml = [
    rootEntries.length > 0 ? renderFileGroup(t("Root files"), rootEntries, "", rootEntries.length <= 4) : "",
    ...sortedDirectories.map(([directory, files]) => renderFileGroup(`${directory}/`, files, directory))
  ].join("");
  return `
    <details class="skill-folder">
      <summary>
        <input type="checkbox" data-skill-target data-tool="${escAttr(folder.tool)}" data-relative-path="${escAttr(folder.relativePath)}" aria-label="${escAttr(t("Select skill {0}", folder.name))}" />
        <span class="folder-name">${esc(folder.name)}</span>
        <span class="folder-path">${esc(folder.path)}</span>
        <span class="meta-inline">${folder.files.length} ${esc(t("files"))}</span>
      </summary>
      <div class="folder-summary">
        <span class="pill sb-chip" title="${escAttr(folder.latestUpdatedAt)}">${esc(t("Latest file"))}: ${esc(compactTimestamp(folder.latestUpdatedAt))}</span>
        <span class="pill sb-chip" title="${escAttr(folder.latestHistoryAt)}">${esc(t("Latest applied"))}: ${esc(compactTimestamp(folder.latestHistoryAt))}</span>
      </div>
      <div class="skill-file-structure">
        ${mainFileHtml}
        ${fileGroupsHtml}
      </div>
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

function compactTimestamp(value: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) ? `${value.slice(0, 10)} ${value.slice(11, 16)}` : value;
}

function hasHistoryValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized !== "-" && normalized !== "no record" && normalized !== localize("No record").toLowerCase();
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
