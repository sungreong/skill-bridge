import * as vscode from "vscode";
import type { GroupTarget, ProjectPreset, ProjectPresetsFile, SelectionGroup, SkillFile, SkillTreeNode, ToolType } from "./types";
import type { UiLanguage } from "./uiLanguage";
import { createWebviewNonce } from "./webviewCommon";
import { renderWebviewClientCommonScript } from "./webviewClientCommon";
import { renderWebviewCommonStyles } from "./webviewCommonStyles";

type TranslationFn = (english: string, korean: string) => string;

type PresetOverviewRow = ProjectPreset & {
  missingCount: number;
  agentCount: number;
};

type SkillGroupSection = {
  id: string;
  name: string;
  tool: ToolType;
  targets: GroupTarget[];
};

export function createProjectPresetOverviewTools(args: {
  tr: TranslationFn;
  getUiLanguage: () => UiLanguage;
  refresh: () => Promise<void>;
  registerLanguageRefresh: (panel: vscode.WebviewPanel, render: () => void | Promise<void>) => void;
  state: {
    centralRepoPath: string;
    centralSkills: SkillFile[];
    centralProjectPresets: ProjectPreset[];
    groups: SelectionGroup[];
  };
  loadProjectPresets: (centralRepoPath: string) => Promise<{ file: ProjectPresetsFile; migratedFromLegacy: boolean }>;
  saveProjectPresets: (centralRepoPath: string, file: ProjectPresetsFile) => Promise<void>;
  applyProjectPreset: (node?: unknown) => Promise<void>;
  createProjectPresetFromCentral: () => Promise<void>;
  deleteProjectPreset: (node?: unknown) => Promise<void>;
  repairCentralMetadata: () => Promise<void>;
  slugifyProjectPresetId: (value: string) => string;
  targetExistsInFiles: (target: GroupTarget, files: SkillFile[]) => boolean;
  toUserError: (error: unknown) => string;
  handleError: (error: unknown) => Promise<void>;
}): {
  openProjectPresetOverview: (node?: unknown) => Promise<void>;
} {
  const openProjectPresetOverview = async (node?: unknown): Promise<void> => {
    try {
      if (!args.state.centralRepoPath) await args.refresh();
      let activePresetId = extractPresetId(node) ?? args.state.centralProjectPresets[0]?.id ?? "";
      const panel = vscode.window.createWebviewPanel(
        "skillBridgeProjectPresetOverview",
        args.tr("Project Presets", "프로젝트 프리셋"),
        vscode.ViewColumn.Active,
        { enableScripts: true }
      );
      const render = async (): Promise<void> => {
        panel.title = args.tr("Project Presets", "프로젝트 프리셋");
        panel.webview.html = renderProjectPresetOverviewHtml(
          buildRows(args),
          args.state.centralSkills,
          args.state.groups.filter((group) => group.side === "central"),
          activePresetId,
          args.getUiLanguage()
        );
      };
      panel.webview.onDidReceiveMessage(async (message: unknown) => {
        try {
          if (isSelectMessage(message)) {
            activePresetId = message.id;
          } else if (isApplyMessage(message)) {
            await args.applyProjectPreset({ kind: "preset", presetId: message.id });
          } else if (isCreateMessage(message)) {
            await args.createProjectPresetFromCentral();
            activePresetId = args.state.centralProjectPresets[0]?.id ?? activePresetId;
          } else if (isDeleteMessage(message)) {
            await args.deleteProjectPreset({ kind: "preset", presetId: message.id });
            activePresetId = args.state.centralProjectPresets[0]?.id ?? "";
          } else if (isSaveMessage(message)) {
            activePresetId = await savePresetFromOverview(args, message);
          } else if (isRepairMetadataMessage(message)) {
            await args.repairCentralMetadata();
            activePresetId = args.state.centralProjectPresets.find((preset) => preset.id === activePresetId)?.id
              ?? args.state.centralProjectPresets[0]?.id
              ?? "";
          } else if (isToggleLanguageMessage(message)) {
            await vscode.commands.executeCommand("skillBridge.toggleLanguage");
          }
          await args.refresh();
          await render();
        } catch (error) {
          await args.handleError(error);
          await render();
        }
      });
      await render();
      args.registerLanguageRefresh(panel, render);
    } catch (error) {
      await args.handleError(error);
    }
  };
  return { openProjectPresetOverview };
}

function buildRows(args: Parameters<typeof createProjectPresetOverviewTools>[0]): PresetOverviewRow[] {
  return args.state.centralProjectPresets
    .map((preset) => ({
      ...preset,
      missingCount: preset.targets.filter((target) => !args.targetExistsInFiles(target, args.state.centralSkills)).length,
      agentCount: new Set(preset.targets.map((target) => target.tool)).size
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function savePresetFromOverview(
  args: Parameters<typeof createProjectPresetOverviewTools>[0],
  message: SaveMessage
): Promise<string> {
  const name = message.name.trim();
  if (!name) throw new Error(args.tr("Enter a preset name.", "프리셋 이름을 입력하세요."));
  const parsedTargets = message.targets
    .map(parseTargetKey)
    .filter((target): target is GroupTarget => target !== null)
    .filter((target) => args.targetExistsInFiles(target, args.state.centralSkills));
  const targets = [...new Map(parsedTargets.map((target) => [targetKey(target), target])).values()];
  if (targets.length === 0) throw new Error(args.tr("Choose at least one Central skill.", "Central 스킬을 하나 이상 선택하세요."));
  const loaded = await args.loadProjectPresets(args.state.centralRepoPath);
  const previous = loaded.file.presets.find((preset) => preset.id === message.id);
  const id = previous && previous.name === name ? previous.id : args.slugifyProjectPresetId(name);
  const duplicate = loaded.file.presets.find((preset) => preset.id === id && preset.id !== message.id);
  if (duplicate) throw new Error(args.tr("A project preset with this name already exists.", "이미 같은 이름의 프로젝트 프리셋이 있습니다."));
  const now = new Date().toISOString();
  const preset: ProjectPreset = {
    id,
    name,
    description: message.description.trim(),
    targets,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    lastAppliedAt: previous?.lastAppliedAt
  };
  await args.saveProjectPresets(args.state.centralRepoPath, {
    version: 1,
    updatedAt: now,
    presets: [...loaded.file.presets.filter((item) => item.id !== message.id && item.id !== id), preset]
      .sort((a, b) => a.name.localeCompare(b.name))
  });
  return id;
}

function renderProjectPresetOverviewHtml(
  rows: PresetOverviewRow[],
  centralSkills: SkillFile[],
  centralGroups: SelectionGroup[],
  activePresetId: string,
  language: UiLanguage
): string {
  const isKo = language === "ko";
  const t = (en: string, ko: string): string => isKo ? ko : en;
  const nonce = createWebviewNonce();
  const active = rows.find((row) => row.id === activePresetId) ?? rows[0];
  const activeTargets = new Set((active?.targets ?? []).map(targetKey));
  const skillOptions = centralSkillFolderTargets(centralSkills);
  const rowHtml = rows.map((row) => renderPresetRow(row, t, row.id === active?.id)).join("");
  const activeSkillTool = getInitialSkillTool(skillOptions, activeTargets);
  const skillSections = buildSkillGroupSections(skillOptions, centralGroups);
  const activeGroupIds = getInitialGroupIdsByTool(skillSections, activeTargets);
  const optionHtml = renderSkillGroupSections(skillSections, activeTargets, activeSkillTool, activeGroupIds);
  const skillTabHtml = renderSkillToolTabs(skillOptions, activeTargets, activeSkillTool);
  const groupTabHtml = renderSkillGroupTabs(skillSections, activeTargets, activeSkillTool, activeGroupIds, t);
  const filterHtml = renderFilterOptions(rows, t);
  const missingText = active && active.missingCount > 0
    ? `<span class="badge danger">${active.missingCount} ${esc(t("missing", "누락"))}</span>`
    : `<span class="badge">${esc(t("ready", "준비됨"))}</span>`;
  return `<!doctype html>
<html lang="${language}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <style>
    ${renderWebviewCommonStyles()}
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    .wrap { height: 100vh; display: grid; grid-template-rows: auto auto minmax(0, 1fr) auto; gap: 8px; padding: 10px; overflow: hidden; }
    .top, .toolbar, .actions, .meta { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .top { justify-content: space-between; min-width: 0; }
    .toolbar { align-items: flex-end; }
    h1, h2 { min-width: 0; margin: 0; font-size: 15px; line-height: 1.35; }
    .summary, .muted { color: var(--vscode-descriptionForeground); font-size: 12px; }
    input, textarea, select { width: 100%; font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 5px; padding: 6px 8px; }
    textarea { min-height: 58px; resize: vertical; }
    label { display: grid; gap: 4px; color: var(--vscode-descriptionForeground); font-size: 12px; }
    button { font: inherit; border: 1px solid var(--vscode-panel-border); border-radius: 5px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); padding: 5px 9px; cursor: pointer; }
    button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: var(--vscode-button-background); }
    button.danger { color: var(--vscode-errorForeground); }
    button:disabled { opacity: .55; cursor: not-allowed; }
    button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .toolbar-field { min-width: 180px; max-width: 220px; }
    .toolbar-search { flex: 1 1 260px; align-self: flex-end; min-height: 30px; }
    .content { min-height: 0; display: grid; grid-template-columns: minmax(280px, 36%) minmax(0, 1fr); gap: 10px; }
    .panel { min-height: 0; border: 1px solid var(--vscode-panel-border); border-radius: 7px; overflow: hidden; }
    .table-panel { overflow: auto; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 12px; }
    th, td { text-align: left; padding: 7px; border-top: 1px solid var(--vscode-panel-border); vertical-align: top; }
    th { position: sticky; top: 0; z-index: 1; color: var(--vscode-descriptionForeground); background: var(--vscode-sideBar-background); font-weight: 500; }
    .preset-row { cursor: pointer; }
    .preset-row.active { background: color-mix(in oklab, var(--vscode-editor-background) 84%, var(--vscode-focusBorder) 16%); }
    .name { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .detail { height: 100%; min-height: 0; display: grid; grid-template-rows: auto auto auto auto auto auto auto minmax(0, 1fr); gap: 9px; padding: 10px; overflow: hidden; }
    .form-grid { display: grid; grid-template-columns: minmax(160px, 240px) minmax(220px, 1fr); gap: 8px; align-items: start; }
    .badge { display: inline-flex; min-height: 20px; align-items: center; border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 2px 7px; font-size: 11px; white-space: nowrap; }
    .badge.danger { color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); }
    .skill-tabs { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .skill-tab { display: inline-flex; align-items: center; gap: 6px; min-height: 28px; }
    .skill-tab.active { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border-color: var(--vscode-button-background); }
    .skill-tab-count { color: inherit; opacity: .74; font-size: 11px; }
    .group-tabs { display: flex; gap: 6px; align-items: center; align-content: flex-start; flex-wrap: wrap; max-height: 74px; min-height: 0; overflow: auto; padding-right: 2px; }
    .group-tab { display: inline-flex; align-items: center; gap: 6px; max-width: 240px; min-height: 26px; }
    .group-tab.active { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border-color: var(--vscode-button-background); }
    .group-tab-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .group-tab-count { flex: 0 0 auto; color: inherit; opacity: .74; font-size: 11px; }
    .skills { min-height: 0; overflow: auto; padding-right: 2px; }
    .skill-group { min-height: 0; }
    .skill-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 6px; }
    .skill { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 7px; align-items: start; border: 1px solid var(--vscode-panel-border); border-radius: 5px; padding: 7px; }
    .skill span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .status-bar { min-height: 24px; display: flex; align-items: center; color: var(--vscode-descriptionForeground); border-top: 1px solid var(--vscode-panel-border); padding-top: 6px; }
    .hidden { display: none; }
    @media (max-width: 760px) {
      .top { align-items: flex-start; }
      .content { grid-template-columns: 1fr; grid-template-rows: minmax(160px, 38vh) minmax(0, 1fr); }
      .form-grid { grid-template-columns: 1fr; }
      .table-panel table { min-width: 640px; }
    }
  </style>
</head>
<body>
  <div class="wrap sb-root">
    <header class="top sb-topbar">
      <h1>${esc(t("Project Presets", "프로젝트 프리셋"))}</h1>
      <div class="summary">${rows.length} ${esc(t("presets", "프리셋"))} · ${centralSkillFolderTargets(centralSkills).length} ${esc(t("Central skills", "Central 스킬"))}</div>
    </header>
    <div class="toolbar">
      <input class="toolbar-search" id="search" aria-label="${escAttr(t("Search project presets", "프로젝트 프리셋 검색"))}" placeholder="${escAttr(t("Search presets, agents, or skills...", "프리셋, 에이전트, 스킬 검색..."))}" />
      <label class="toolbar-field">${esc(t("Filter", "필터"))}<select id="filter" aria-label="${escAttr(t("Filter project presets", "프로젝트 프리셋 필터"))}">${filterHtml}</select></label>
      <button data-create type="button">${esc(t("Create preset", "프리셋 만들기"))}</button>
      <button data-repair-metadata type="button">${esc(t("Repair metadata", "메타데이터 복구"))}</button>
      <button data-language type="button">${esc(isKo ? "English" : "한국어")}</button>
    </div>
    <main class="content">
      <section class="panel table-panel">
        <table>
          <thead><tr><th>${esc(t("Preset", "프리셋"))}</th><th style="width:74px">${esc(t("Skills", "스킬"))}</th><th style="width:74px">${esc(t("Agents", "에이전트"))}</th></tr></thead>
          <tbody>${rowHtml || `<tr><td colspan="3"><div class="muted">${esc(t("No project presets yet.", "프로젝트 프리셋이 아직 없습니다."))}</div></td></tr>`}</tbody>
        </table>
      </section>
      <section class="panel">
        ${active ? `
        <article class="detail" data-active-id="${escAttr(active.id)}">
          <div class="top">
            <h2>${esc(active.name)}</h2>
            <div class="meta">${missingText}<span class="badge">${active.targets.length} ${esc(t("skills", "스킬"))}</span><span class="badge">${active.agentCount} ${esc(t("agents", "에이전트"))}</span></div>
          </div>
          <div class="actions">
            <button class="primary" data-apply="${escAttr(active.id)}" type="button">${esc(t("Apply to Workspace", "작업공간에 적용"))}</button>
            <button data-save="${escAttr(active.id)}" type="button">${esc(t("Save preset", "프리셋 저장"))}</button>
            <button class="danger" data-delete="${escAttr(active.id)}" type="button">${esc(t("Delete preset", "프리셋 삭제"))}</button>
          </div>
          <div class="form-grid">
            <label>${esc(t("Name", "이름"))}<input id="presetName" value="${escAttr(active.name)}" /></label>
            <label>${esc(t("Description", "설명"))}<textarea id="presetDescription">${esc(active.description)}</textarea></label>
          </div>
          <div class="meta muted">
            <span>${esc(t("Created", "생성"))}: ${esc(formatTimestamp(active.createdAt, t))}</span>
            <span>${esc(t("Updated", "수정"))}: ${esc(formatTimestamp(active.updatedAt, t))}</span>
            <span>${esc(t("Applied", "적용"))}: ${esc(formatTimestamp(active.lastAppliedAt, t))}</span>
          </div>
          <div class="muted">${esc(t("Choose Central skills included in this preset.", "이 프리셋에 포함할 Central 스킬을 선택하세요."))}</div>
          ${skillTabHtml}
          ${groupTabHtml}
          <div class="skills">${optionHtml || `<div class="muted">${esc(t("No Central skills available.", "사용 가능한 Central 스킬이 없습니다."))}</div>`}</div>
        </article>` : `<div class="detail muted">${esc(t("Create a project preset to start.", "프로젝트 프리셋을 만들어 시작하세요."))}</div>`}
      </section>
    </main>
    <div id="statusLine" class="status-bar sb-status-bar info">${esc(t("Ready", "준비됨"))}</div>
  </div>
  <script nonce="${nonce}">
    ${renderWebviewClientCommonScript()}
    const vscode = acquireVsCodeApi();
    const status = document.getElementById("statusLine");
    let busy = false;
    function setBusy(message){
      busy = true;
      document.querySelectorAll("button,input,textarea,select").forEach((item)=>{ item.disabled = true; });
      if(status) status.textContent = message;
    }
    function post(message, label){
      if(busy) return;
      setBusy(label || "${esc(t("Working...", "작업 중..."))}");
      vscode.postMessage(message);
    }
    document.body.addEventListener("click", (event)=>{
      const target = event.target;
      if(!(target instanceof Element)) return;
      const skillTab = target.closest("[data-skill-tab]");
      if(skillTab instanceof HTMLElement){
        setSkillTab(skillTab.getAttribute("data-skill-tab") || "");
        return;
      }
      const groupTab = target.closest("[data-group-tab]");
      if(groupTab instanceof HTMLElement){
        setActiveGroup(groupTab.getAttribute("data-tool") || "", groupTab.getAttribute("data-group-tab") || "");
        return;
      }
      const row = target.closest("[data-preset-id]");
      if(row instanceof HTMLElement) post({type:"select", id: row.getAttribute("data-preset-id") || ""}, "${esc(t("Opening preset...", "프리셋 여는 중..."))}");
      const apply = target.closest("[data-apply]");
      if(apply instanceof HTMLElement) post({type:"apply", id: apply.getAttribute("data-apply") || ""}, "${esc(t("Applying preset...", "프리셋 적용 중..."))}");
      const create = target.closest("[data-create]");
      if(create instanceof HTMLElement) post({type:"create"}, "${esc(t("Creating preset...", "프리셋 만드는 중..."))}");
      const repair = target.closest("[data-repair-metadata]");
      if(repair instanceof HTMLElement) post({type:"repairMetadata"}, "${esc(t("Repairing metadata...", "메타데이터 복구 중..."))}");
      const del = target.closest("[data-delete]");
      if(del instanceof HTMLElement) post({type:"delete", id: del.getAttribute("data-delete") || ""}, "${esc(t("Deleting preset...", "프리셋 삭제 중..."))}");
      const save = target.closest("[data-save]");
      if(save instanceof HTMLElement){
        const targets = Array.from(document.querySelectorAll("input[data-target]:checked")).map((input)=>input.getAttribute("data-target") || "");
        post({
          type:"save",
          id: save.getAttribute("data-save") || "",
          name: document.getElementById("presetName")?.value || "",
          description: document.getElementById("presetDescription")?.value || "",
          targets
        }, "${esc(t("Saving preset...", "프리셋 저장 중..."))}");
      }
      const language = target.closest("[data-language]");
      if(language instanceof HTMLElement) post({type:"toggleLanguage"}, "${esc(t("Switching language...", "언어 전환 중..."))}");
    });
    const search = document.getElementById("search");
    const filter = document.getElementById("filter");
    function applyFilters(){
      const q = String(search.value || "").trim().toLowerCase();
      const mode = String(filter?.value || "all");
      document.querySelectorAll(".preset-row").forEach((row)=>{
        const matchesQuery = !q || String(row.getAttribute("data-search") || "").includes(q);
        const matchesFilter = mode === "all"
          || (mode === "missing" && row.getAttribute("data-missing") === "true")
          || String(row.getAttribute("data-agents") || "").split(" ").includes(mode);
        row.classList.toggle("hidden", !matchesQuery || !matchesFilter);
      });
    }
    search?.addEventListener("input", applyFilters);
    filter?.addEventListener("change", applyFilters);
    function setSkillTab(tool){
      if(!tool) return;
      document.querySelectorAll("[data-skill-tab]").forEach((tab)=>{
        const isActive = tab.getAttribute("data-skill-tab") === tool;
        tab.classList.toggle("active", isActive);
        tab.setAttribute("aria-selected", isActive ? "true" : "false");
      });
      document.querySelectorAll("[data-group-tab]").forEach((tab)=>{
        tab.classList.toggle("hidden", tab.getAttribute("data-tool") !== tool);
      });
      const activeGroup = findActiveGroup(tool);
      setActiveGroup(tool, activeGroup);
    }
    function findActiveGroup(tool){
      const tabs = Array.from(document.querySelectorAll("[data-group-tab]")).filter((tab)=>tab.getAttribute("data-tool") === tool);
      const active = tabs.find((tab)=>tab.classList.contains("active"));
      return (active || tabs[0])?.getAttribute("data-group-tab") || "";
    }
    function setActiveGroup(tool, groupId){
      if(!tool || !groupId) return;
      document.querySelectorAll("[data-group-tab]").forEach((tab)=>{
        if(tab.getAttribute("data-tool") !== tool) return;
        const isActive = tab.getAttribute("data-tool") === tool && tab.getAttribute("data-group-tab") === groupId;
        tab.classList.toggle("active", isActive);
        tab.setAttribute("aria-selected", isActive ? "true" : "false");
      });
      document.querySelectorAll(".skill-group[data-tool]").forEach((group)=>{
        const isVisible = group.getAttribute("data-tool") === tool && group.getAttribute("data-group-id") === groupId;
        group.classList.toggle("hidden", !isVisible);
      });
    }
  </script>
</body>
</html>`;
}

function renderPresetRow(row: PresetOverviewRow, t: (en: string, ko: string) => string, active: boolean): string {
  const search = `${row.name} ${row.description} ${row.targets.map((target) => `${target.tool} ${target.relativePath}`).join(" ")}`.toLowerCase();
  const agents = [...new Set(row.targets.map((target) => target.tool))].join(" ");
  return `<tr class="preset-row ${active ? "active" : ""}" data-preset-id="${escAttr(row.id)}" data-search="${escAttr(search)}" data-agents="${escAttr(agents)}" data-missing="${row.missingCount > 0 ? "true" : "false"}">
    <td><div class="name">${esc(row.name)}</div><div class="muted">${esc(row.description || t("No description", "설명 없음"))}</div>${row.missingCount ? `<span class="badge danger">${row.missingCount} ${esc(t("missing", "누락"))}</span>` : ""}</td>
    <td>${row.targets.length}</td>
    <td>${row.agentCount}</td>
  </tr>`;
}

function renderFilterOptions(rows: PresetOverviewRow[], t: (en: string, ko: string) => string): string {
  const agents = [...new Set(rows.flatMap((row) => row.targets.map((target) => target.tool)))].sort();
  return [
    `<option value="all">${esc(t("All presets", "전체 프리셋"))}</option>`,
    `<option value="missing">${esc(t("Missing targets", "누락 대상"))}</option>`,
    ...agents.map((agent) => `<option value="${escAttr(agent)}">${esc(agent)}</option>`)
  ].join("");
}

function formatTimestamp(value: string | undefined, t: (en: string, ko: string) => string): string {
  return value?.trim() ? value : t("Never", "없음");
}

function renderSkillGroupSections(
  sections: SkillGroupSection[],
  activeTargets: Set<string>,
  activeTool: ToolType | null,
  activeGroupIds: Map<ToolType, string>
): string {
  return sections.map((section) => {
    const visible = section.tool === activeTool && section.id === activeGroupIds.get(section.tool);
    return `<section class="skill-group ${visible ? "" : "hidden"}" data-tool="${escAttr(section.tool)}" data-group-id="${escAttr(section.id)}">
      <div class="skill-grid">${section.targets.map((target) => renderSkillOption(target, activeTargets.has(targetKey(target)))).join("")}</div>
    </section>`;
  }).join("");
}

function renderSkillGroupTabs(
  sections: SkillGroupSection[],
  activeTargets: Set<string>,
  activeTool: ToolType | null,
  activeGroupIds: Map<ToolType, string>,
  t: (en: string, ko: string) => string
): string {
  const tabs = sections.map((section) => {
    const selectedCount = section.targets.filter((target) => activeTargets.has(targetKey(target))).length;
    const countText = `${selectedCount}/${section.targets.length}`;
    const name = section.id.startsWith("ungrouped:") ? t("Ungrouped", "그룹 없음") : section.name;
    const active = section.tool === activeTool && section.id === activeGroupIds.get(section.tool);
    const visible = section.tool === activeTool;
    return `<button class="group-tab ${active ? "active" : ""} ${visible ? "" : "hidden"}" data-tool="${escAttr(section.tool)}" data-group-tab="${escAttr(section.id)}" type="button" role="tab" aria-selected="${active ? "true" : "false"}" title="${escAttr(name)}"><span class="group-tab-name">${esc(name)}</span><span class="group-tab-count">${esc(countText)}</span></button>`;
  }).join("");
  return tabs ? `<div class="group-tabs" role="tablist">${tabs}</div>` : "";
}

function renderSkillToolTabs(targets: GroupTarget[], activeTargets: Set<string>, activeTool: ToolType | null): string {
  const counts = new Map<ToolType, { total: number; selected: number }>();
  for (const target of targets) {
    const previous = counts.get(target.tool) ?? { total: 0, selected: 0 };
    counts.set(target.tool, {
      total: previous.total + 1,
      selected: previous.selected + (activeTargets.has(targetKey(target)) ? 1 : 0)
    });
  }
  const tabs = ALL_TOOLS
    .filter((tool) => counts.has(tool))
    .map((tool) => {
      const count = counts.get(tool);
      if (!count) return "";
      const active = tool === activeTool;
      const countText = count.selected > 0 ? `${count.selected}/${count.total}` : `${count.total}`;
      return `<button class="skill-tab ${active ? "active" : ""}" data-skill-tab="${escAttr(tool)}" type="button" role="tab" aria-selected="${active ? "true" : "false"}"><span>${esc(tool)}</span><span class="skill-tab-count">${esc(countText)}</span></button>`;
    })
    .join("");
  return tabs ? `<div class="skill-tabs" role="tablist">${tabs}</div>` : "";
}

function getInitialSkillTool(targets: GroupTarget[], activeTargets: Set<string>): ToolType | null {
  const selectedTool = ALL_TOOLS.find((tool) => targets.some((target) => target.tool === tool && activeTargets.has(targetKey(target))));
  if (selectedTool) return selectedTool;
  return ALL_TOOLS.find((tool) => targets.some((target) => target.tool === tool)) ?? null;
}

function getInitialGroupIdsByTool(sections: SkillGroupSection[], activeTargets: Set<string>): Map<ToolType, string> {
  const activeIds = new Map<ToolType, string>();
  for (const tool of ALL_TOOLS) {
    const toolSections = sections.filter((section) => section.tool === tool);
    const selectedSection = toolSections.find((section) => section.targets.some((target) => activeTargets.has(targetKey(target))));
    const firstSection = selectedSection ?? toolSections[0];
    if (firstSection) activeIds.set(tool, firstSection.id);
  }
  return activeIds;
}

function renderSkillOption(target: GroupTarget, checked: boolean): string {
  const key = targetKey(target);
  return `<label class="skill"><input type="checkbox" data-target="${escAttr(key)}" ${checked ? "checked" : ""} /><span title="${escAttr(key)}">${esc(target.relativePath)}</span></label>`;
}

function buildSkillGroupSections(targets: GroupTarget[], groups: SelectionGroup[]): SkillGroupSection[] {
  const sections: SkillGroupSection[] = [];
  for (const tool of ALL_TOOLS) {
    const toolTargets = targets.filter((target) => target.tool === tool);
    if (toolTargets.length === 0) continue;
    const assignedKeys = new Set<string>();
    const toolGroups = groups.filter((group) => group.targets.some((target) => target.tool === tool));
    for (const group of toolGroups) {
      const groupTargets = toolTargets.filter((target) =>
        !assignedKeys.has(targetKey(target)) && group.targets.some((groupTarget) => isTargetInGroup(groupTarget, target))
      );
      if (groupTargets.length === 0) continue;
      for (const target of groupTargets) assignedKeys.add(targetKey(target));
      sections.push({
        id: group.id,
        name: group.name,
        tool,
        targets: groupTargets.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
      });
    }
    const ungroupedTargets = toolTargets.filter((target) => !assignedKeys.has(targetKey(target)));
    if (ungroupedTargets.length > 0) {
      sections.push({
        id: `ungrouped:${tool}`,
        name: "Ungrouped",
        tool,
        targets: ungroupedTargets.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
      });
    }
  }
  return sections;
}

function isTargetInGroup(groupTarget: GroupTarget, skillTarget: GroupTarget): boolean {
  if (groupTarget.tool !== skillTarget.tool) return false;
  return skillFolderRelativePath(groupTarget.relativePath) === skillTarget.relativePath;
}

function skillFolderRelativePath(relativePath: string): string | null {
  const parts = relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts[0] !== "skills" || !parts[1]) return null;
  return `skills/${parts[1]}`;
}

function centralSkillFolderTargets(files: SkillFile[]): GroupTarget[] {
  const targets = new Map<string, GroupTarget>();
  for (const file of files) {
    const parts = file.relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
    if (parts[0] !== "skills" || !parts[1]) continue;
    const target: GroupTarget = { kind: "folder", tool: file.tool, relativePath: `skills/${parts[1]}` };
    targets.set(targetKey(target), target);
  }
  return [...targets.values()].sort((a, b) => targetKey(a).localeCompare(targetKey(b)));
}

function parseTargetKey(value: string): GroupTarget | null {
  const [tool, relativePath] = value.split(":", 2);
  if (!isToolType(tool) || typeof relativePath !== "string" || !relativePath.startsWith("skills/")) return null;
  return { kind: "folder", tool, relativePath };
}

function targetKey(target: GroupTarget): string {
  return `${target.tool}:${target.relativePath}`;
}

function extractPresetId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.presetId === "string" && record.presetId.trim()) return record.presetId;
  if (record.node && typeof record.node === "object") return extractPresetId(record.node);
  return null;
}

type SaveMessage = { type: "save"; id: string; name: string; description: string; targets: string[] };

function isSaveMessage(message: unknown): message is SaveMessage {
  return isRecord(message)
    && message.type === "save"
    && typeof message.id === "string"
    && typeof message.name === "string"
    && typeof message.description === "string"
    && Array.isArray(message.targets)
    && message.targets.every((target) => typeof target === "string");
}
function isSelectMessage(message: unknown): message is { type: "select"; id: string } {
  return isRecord(message) && message.type === "select" && typeof message.id === "string";
}
function isApplyMessage(message: unknown): message is { type: "apply"; id: string } {
  return isRecord(message) && message.type === "apply" && typeof message.id === "string";
}
function isDeleteMessage(message: unknown): message is { type: "delete"; id: string } {
  return isRecord(message) && message.type === "delete" && typeof message.id === "string";
}
function isCreateMessage(message: unknown): message is { type: "create" } {
  return isRecord(message) && message.type === "create";
}
function isRepairMetadataMessage(message: unknown): message is { type: "repairMetadata" } {
  return isRecord(message) && message.type === "repairMetadata";
}
function isToggleLanguageMessage(message: unknown): message is { type: "toggleLanguage" } {
  return isRecord(message) && message.type === "toggleLanguage";
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}
function isToolType(value: string): value is ToolType {
  return (["claude", "codex", "gemini", "cursor", "antigravity", "agents"] as string[]).includes(value);
}
const ALL_TOOLS: ToolType[] = ["agents", "claude", "codex", "gemini", "cursor", "antigravity"];
function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function escAttr(value: string): string {
  return esc(value).replace(/'/g, "&#39;");
}
