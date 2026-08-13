import { promises as fs } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import { resolveSkillPath } from "./skillPaths";
import { normalizeRel } from "./extensionSupport";
import { collectNpxSkillLibraryDiagnosis, renderNpxSkillLibraryGuideMarkdown, type NpxSkillLibraryDiagnosis } from "./npxSkillLibraryDiagnostics";
import type { GroupTreeNode, SelectionGroup, ToolType } from "./types";
import type { NpxInstallPreset } from "./extensionInstallTransfer";
import { npxSkillNamesFromGroup, updateNpxGroupFromMetadata } from "./npxGroupUpdate";
import { localize, type UiLanguage } from "./uiLanguage";
import { createWebviewNonce } from "./webviewCommon";
import { renderWebviewClientCommonScript } from "./webviewClientCommon";
import { renderWebviewCommonStyles } from "./webviewCommonStyles";

type TreeSide = "workspace" | "central";
type TranslationFn = typeof vscode.l10n.t;

type NpxRepoRow = {
  id: string;
  side: TreeSide;
  name: string;
  agent: ToolType | "mixed";
  source: "npx" | "mixed";
  repoKey: string;
  repoUrl: string;
  lastInstalledAt: string;
  installCwd: string;
  skills: string[];
  description: string;
};

export function createNpxSkillLibraryTools(args: {
  tr: TranslationFn;
  getUiLanguage: () => UiLanguage;
  refresh: () => Promise<void>;
  applyPanelBranding: (panel: vscode.WebviewPanel, render: () => void | Promise<void>) => void;
  state: { workspacePath: string; centralRepoPath: string; groups: SelectionGroup[] };
  getGroupTool: (group: SelectionGroup) => ToolType | "mixed" | null;
  installSkillsForSide: (side: TreeSide) => Promise<void>;
  installSkillsCommandForSide: (side: TreeSide) => Promise<void>;
  installNpxRepoForSide: (side: TreeSide, preset: NpxInstallPreset) => Promise<boolean>;
  openGroupOverview: (node?: GroupTreeNode) => Promise<void>;
  persistGroups: (next: SelectionGroup[], selectedGroupId: string | null, options?: { skipExistenceValidation?: boolean }) => Promise<void>;
  toUserError: (error: unknown) => string;
  handleError: (error: unknown) => Promise<void>;
}): { openNpxSkillLibrary: () => Promise<void> } {
  const openNpxSkillLibrary = async (): Promise<void> => {
    try {
      if (!args.state.workspacePath || !args.state.centralRepoPath) await args.refresh();
      let side: TreeSide = "workspace";
      let diagnosis: NpxSkillLibraryDiagnosis | null = null;
      const panel = vscode.window.createWebviewPanel("skillBridgeNpxSkillLibrary", args.tr("NPX Skill Library"), vscode.ViewColumn.Active, { enableScripts: true });
      const render = (): void => {
        panel.title = args.tr("NPX Skill Library");
        panel.webview.html = renderNpxSkillLibraryHtml(buildRows(args, side), side, args.getUiLanguage(), diagnosis);
      };
      panel.webview.onDidReceiveMessage(async (message: unknown) => {
        try {
          if (isSideMessage(message)) {
            side = message.side;
          } else if (isCheckEnvironmentMessage(message)) {
            diagnosis = await collectNpxSkillLibraryDiagnosis({ tr: args.tr, toUserError: args.toUserError });
          } else if (isWriteGuideMessage(message)) {
            diagnosis = diagnosis ?? await collectNpxSkillLibraryDiagnosis({ tr: args.tr, toUserError: args.toUserError });
            await writeNpxEnvironmentGuide(args, diagnosis);
          } else if (isDownloadMessage(message)) {
            assertNpxEnvironmentReady(args, diagnosis);
            await args.installSkillsForSide(message.side);
            await args.refresh();
          } else if (isCommandInstallMessage(message)) {
            assertNpxEnvironmentReady(args, diagnosis);
            await args.installSkillsCommandForSide(message.side);
            await args.refresh();
          } else if (isUpdateMessage(message)) {
            assertNpxEnvironmentReady(args, diagnosis);
            const row = findRow(args, message.id);
            await updateRow(args, row, false);
            await args.refresh();
          } else if (isUpdateAllMessage(message)) {
            assertNpxEnvironmentReady(args, diagnosis);
            await updateAllRows(args, message.side);
            await args.refresh();
          } else if (isDeleteMessage(message)) {
            await deleteRow(args, findRow(args, message.id));
            await args.refresh();
          } else if (isOpenLinkMessage(message)) {
            await vscode.env.openExternal(vscode.Uri.parse(message.url));
          } else if (isOpenGroupMessage(message)) {
            const group = args.state.groups.find((item) => item.id === message.id);
            if (group) await args.openGroupOverview({ id: group.id, kind: "group", side: group.side, label: group.name, count: group.targets.length });
          }
          render();
        } catch (error) {
          await args.handleError(error);
          render();
        }
      });
      render();
      args.applyPanelBranding(panel, render);
    } catch (error) {
      await args.handleError(error);
    }
  };
  return { openNpxSkillLibrary };
}

function buildRows(args: Parameters<typeof createNpxSkillLibraryTools>[0], side: TreeSide): NpxRepoRow[] {
  return args.state.groups
    .filter((group) => group.side === side && (group.meta?.source === "npx" || group.meta?.source === "mixed"))
    .map((group) => {
      const skills = npxSkillNamesFromGroup(group);
      return {
        id: group.id,
        side: group.side,
        name: group.name,
        agent: args.getGroupTool(group) ?? "mixed",
        source: group.meta?.source === "mixed" ? "mixed" as const : "npx" as const,
        repoKey: group.meta?.repoKey ?? group.name,
        repoUrl: group.meta?.repoUrl ?? "",
        lastInstalledAt: group.meta?.lastInstalledAt ?? "-",
        installCwd: group.meta?.installCwd ?? "",
        skills,
        description: group.description ?? ""
      };
    })
    .sort((left, right) => right.lastInstalledAt.localeCompare(left.lastInstalledAt) || left.repoKey.localeCompare(right.repoKey));
}

async function updateRow(args: Parameters<typeof createNpxSkillLibraryTools>[0], row: NpxRepoRow, skipCommandConfirm: boolean): Promise<boolean> {
  const group = args.state.groups.find((item) => item.id === row.id);
  if (!group) throw new Error(args.tr("Could not find the npx group."));
  return await updateNpxGroupFromMetadata(args, group, skipCommandConfirm);
}

async function updateAllRows(args: Parameters<typeof createNpxSkillLibraryTools>[0], side: TreeSide): Promise<void> {
  const rows = buildRows(args, side).filter((row) => row.repoUrl && row.skills.length > 0);
  if (rows.length === 0) {
    vscode.window.showInformationMessage(args.tr("No npx repos can be updated in this side."));
    return;
  }
  const ok = await vscode.window.showWarningMessage(
    args.tr("Update {0} npx repo group(s) for {1}?", String(rows.length), String(side)),
    { modal: true },
    args.tr("Update all")
  );
  if (ok !== args.tr("Update all")) return;
  let updated = 0;
  for (const row of rows) {
    if (await updateRow(args, row, true)) updated += 1;
  }
  vscode.window.showInformationMessage(args.tr("NPX update complete: {0}/{1}", String(updated), String(rows.length)));
}

async function deleteRow(args: Parameters<typeof createNpxSkillLibraryTools>[0], row: NpxRepoRow): Promise<void> {
  const group = args.state.groups.find((item) => item.id === row.id);
  if (!group) throw new Error(args.tr("Could not find the npx group to delete."));
  const preview = row.skills.slice(0, 8).join(", ");
  const more = row.skills.length > 8 ? args.tr(" and {0} more", String(row.skills.length - 8)) : "";
  const ok = await vscode.window.showWarningMessage(
    args.tr("Delete installed skills and tracking group \"{0}\"?\n\n{1}{2}", String(row.repoKey), String(preview), String(more)),
    { modal: true },
    args.tr("Delete")
  );
  if (ok !== args.tr("Delete")) return;
  const basePath = row.side === "workspace" ? args.state.workspacePath : args.state.centralRepoPath;
  for (const target of group.targets) {
    const relativePath = skillFolderRelativePath(target.relativePath);
    if (!relativePath) continue;
    const absolutePath = (() => {
      try {
        return resolveSkillPath(basePath, target.tool, relativePath, row.side);
      } catch {
        return null;
      }
    })();
    if (!absolutePath) continue;
    await fs.rm(absolutePath, { recursive: true, force: true }).catch(() => undefined);
  }
  await args.persistGroups(args.state.groups.filter((item) => item.id !== group.id), null, { skipExistenceValidation: true });
  vscode.window.showInformationMessage(args.tr("Deleted npx group: {0}", String(row.repoKey)));
}

async function writeNpxEnvironmentGuide(args: Parameters<typeof createNpxSkillLibraryTools>[0], diagnosis: NpxSkillLibraryDiagnosis): Promise<void> {
  if (!args.state.workspacePath) {
    throw new Error(args.tr("Workspace path is unavailable. Open a workspace before creating the guide."));
  }
  const guidePath = path.join(args.state.workspacePath, "NPX_SKILL_LIBRARY_ENVIRONMENT_GUIDE.md");
  const exists = await fs.access(guidePath).then(() => true, () => false);
  if (exists) {
    const overwrite = args.tr("Overwrite");
    const picked = await vscode.window.showWarningMessage(
      args.tr("Overwrite the existing NPX environment guide?\n\n{0}", String(guidePath)),
      { modal: true },
      overwrite
    );
    if (picked !== overwrite) return;
  }
  await fs.writeFile(guidePath, renderNpxSkillLibraryGuideMarkdown(diagnosis, args.tr), "utf8");
  const open = args.tr("Open Guide");
  const picked = await vscode.window.showInformationMessage(
    args.tr("NPX environment guide created: {0}", String(guidePath)),
    open
  );
  if (picked === open) {
    const document = await vscode.workspace.openTextDocument(guidePath);
    await vscode.window.showTextDocument(document);
  }
}

function assertNpxEnvironmentReady(args: Parameters<typeof createNpxSkillLibraryTools>[0], diagnosis: NpxSkillLibraryDiagnosis | null): void {
  if (diagnosis?.status === "ready") return;
  const message = diagnosis?.status === "blocked"
    ? args.tr("The NPX environment check found missing requirements. Create the guide document and resolve them before downloading or updating.")
    : args.tr("Run the NPX environment check before downloading or updating.");
  throw new Error(message);
}

function renderNpxSkillLibraryHtml(rows: NpxRepoRow[], side: TreeSide, language: UiLanguage, diagnosis: NpxSkillLibraryDiagnosis | null): string {
  const t = localize;
  const nonce = createWebviewNonce();
  const selected = rows[0]?.id ?? "";
  const totalSkills = rows.reduce((sum, row) => sum + row.skills.length, 0);
  const envReady = diagnosis?.status === "ready";
  return `<!doctype html><html lang="${language}"><head><meta charset="UTF-8" /><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"><style>
  ${renderWebviewCommonStyles()}body{margin:0;background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family)}.wrap{height:100vh;display:grid;grid-template-rows:auto auto auto minmax(0,1fr) auto;gap:10px;padding:12px;overflow:hidden;container-type:inline-size}.top,.actions,.envbar,.control-group{display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-width:0}.top{justify-content:space-between}h1,h2{min-width:0;margin:0;font-size:16px}.summary{color:var(--vscode-descriptionForeground);font-size:12px}.commandbar{min-width:0;display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:8px 16px}.control-group+.control-group{position:relative}.control-group+.control-group::before{content:"";width:1px;height:22px;margin-right:8px;background:var(--vscode-panel-border)}.install-group{justify-content:flex-start}.manage-group{justify-content:flex-end}.group-label{color:var(--vscode-descriptionForeground);font-size:11px;font-weight:600;text-transform:uppercase}button{min-height:30px;font:inherit;border:1px solid var(--vscode-panel-border);border-radius:5px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);padding:5px 9px;cursor:pointer}button:hover:not(:disabled){background:var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground))}button:focus-visible{outline:2px solid var(--sb-accent);outline-offset:1px}button.primary,.tab.active{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:var(--vscode-button-background)}button.primary:hover:not(:disabled){background:var(--vscode-button-hoverBackground)}button:disabled{opacity:.55;cursor:not-allowed}.trending-button{display:inline-grid;grid-template-columns:auto auto;align-items:baseline;gap:6px;border-color:var(--vscode-textLink-foreground);color:var(--vscode-textLink-foreground);background:color-mix(in oklab,var(--vscode-editor-background) 92%,var(--vscode-textLink-foreground) 8%)}.trending-source{font-size:10px;font-weight:600;text-transform:uppercase}.trending-label{font-weight:700}.envbar{border:1px solid var(--vscode-panel-border);border-radius:6px;padding:7px 9px;background:var(--vscode-sideBar-background)}.env-title{font-weight:700}.env-status{border:1px solid var(--vscode-panel-border);border-radius:999px;padding:2px 7px;font-size:11px}.env-status.ready{border-color:var(--sb-success);color:var(--sb-success)}.env-status.blocked{border-color:var(--sb-danger);color:var(--sb-danger)}.env-status.unknown{color:var(--vscode-descriptionForeground)}.env-detail{color:var(--vscode-descriptionForeground);font-size:12px}.content{min-height:0;min-width:0;display:grid;grid-template-columns:minmax(360px,42%) minmax(0,1fr);gap:10px}.panel{min-height:0;border:1px solid var(--vscode-panel-border);border-radius:8px;overflow:auto}.repo-row{cursor:pointer}.repo-row.active{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}table{width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed}th,td{text-align:left;padding:7px;border-top:1px solid var(--vscode-panel-border);vertical-align:top}th{position:sticky;top:0;background:var(--vscode-sideBar-background);color:var(--vscode-descriptionForeground);font-weight:500}.repo{font-weight:700}.muted{color:var(--vscode-descriptionForeground);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.detail{display:none;padding:12px;gap:10px}.detail.active{display:grid}.meta{display:flex;gap:6px;flex-wrap:wrap}.pill{border:1px solid var(--vscode-panel-border);border-radius:999px;padding:2px 7px;font-size:11px}.skills{display:grid;gap:5px}.skill{border:1px solid var(--vscode-panel-border);border-radius:5px;padding:6px 8px}.empty{padding:16px;color:var(--vscode-descriptionForeground)}@container(max-width:980px){.commandbar{grid-template-columns:auto minmax(0,1fr)}.manage-group{grid-column:1/-1;justify-content:flex-start}.manage-group::before{display:none}}@media(max-width:800px){.top{align-items:flex-start}.content{grid-template-columns:1fr;grid-template-rows:minmax(180px,42vh) minmax(0,1fr)}.panel table{min-width:640px}}@container(max-width:640px){.commandbar{grid-template-columns:1fr}.control-group{justify-content:flex-start}.control-group+.control-group::before{display:none}.scope-group button{flex:1 1 0}.install-group button{flex:1 1 auto}.trending-button{flex:1 1 100%;justify-content:center}.group-label{flex:1 1 100%}}@media(max-width:640px){button{min-height:36px}.actions button.primary{flex:1 1 100%}}
  </style></head><body><div class="wrap sb-root"><div class="top sb-topbar"><h1>${esc(t("NPX Skill Library"))}</h1><div class="summary">${rows.length} ${esc(t("repo groups"))} · ${totalSkills} ${esc(t("skills"))}</div></div>${renderEnvironmentBar(diagnosis, t)}${renderNpxToolbar(side, envReady, t)}<main class="content"><section class="panel sb-panel"><table><thead><tr><th>${esc(t("Repo"))}</th><th style="width:82px">${esc(t("Agent"))}</th><th style="width:70px">${esc(t("Skills"))}</th><th style="width:150px">${esc(t("Updated"))}</th></tr></thead><tbody>${rows.map((row, index) => renderRow(row, index === 0)).join("") || `<tr><td colspan="4"><div class="empty">${esc(t("No npx groups on this side."))}</div></td></tr>`}</tbody></table></section><section class="panel sb-panel">${rows.map((row, index) => renderDetail(row, index === 0, t, envReady)).join("") || `<div class="empty">${esc(t("Use guided install or paste an npx skills add command."))}</div>`}</section></main><div id="statusLine" class="sb-status-bar info">${esc(t("Ready"))}</div></div><script nonce="${nonce}">
  ${renderWebviewClientCommonScript()}const vscode=acquireVsCodeApi();let active="${escAttr(selected)}";let busy=false;const statusLine=document.getElementById("statusLine");const rows=Array.from(document.querySelectorAll(".repo-row"));const details=Array.from(document.querySelectorAll(".detail"));function setStatus(message){if(statusLine)statusLine.textContent=message||"${esc(t("Ready"))}";}function show(id){active=id||"";rows.forEach(r=>r.classList.toggle("active",r.getAttribute("data-id")===active));details.forEach(d=>d.classList.toggle("active",d.getAttribute("data-id")===active));}function post(message){if(busy)return;busy=true;setStatus("${esc(t("Working..."))}");document.querySelectorAll("button").forEach(b=>b.disabled=true);vscode.postMessage(message)}document.body.addEventListener("click",(event)=>{const target=event.target;if(!(target instanceof Element))return;const row=target.closest(".repo-row");if(row instanceof HTMLElement)show(row.getAttribute("data-id")||"");const side=target.closest("[data-side]");if(side instanceof HTMLElement)post({type:"side",side:side.getAttribute("data-side")||"workspace"});const checkEnv=target.closest("[data-check-env]");if(checkEnv instanceof HTMLElement)post({type:"checkEnvironment"});const writeGuide=target.closest("[data-write-guide]");if(writeGuide instanceof HTMLElement)post({type:"writeGuide"});const download=target.closest("[data-download]");if(download instanceof HTMLElement)post({type:"download",side:download.getAttribute("data-download")||"workspace"});const commandInstall=target.closest("[data-command-install]");if(commandInstall instanceof HTMLElement)post({type:"commandInstall",side:commandInstall.getAttribute("data-command-install")||"workspace"});const update=target.closest("[data-update]");if(update instanceof HTMLElement)post({type:"update",id:update.getAttribute("data-update")||""});const updateAll=target.closest("[data-update-all]");if(updateAll instanceof HTMLElement)post({type:"updateAll",side:updateAll.getAttribute("data-update-all")||"workspace"});const del=target.closest("[data-delete]");if(del instanceof HTMLElement)post({type:"delete",id:del.getAttribute("data-delete")||""});const link=target.closest("[data-open-link]");if(link instanceof HTMLElement){event.preventDefault();post({type:"openLink",url:link.getAttribute("data-open-link")||""})}const group=target.closest("[data-open-group]");if(group instanceof HTMLElement)post({type:"openGroup",id:group.getAttribute("data-open-group")||""});});show(active);
  </script></body></html>`;
}

function renderNpxToolbar(side: TreeSide, envReady: boolean, t: (message: string, ...args: Array<string | number | boolean>) => string): string {
  const guidedPrimary = envReady ? "primary" : "";
  const checkPrimary = envReady ? "" : "primary";
  return `<div class="commandbar sb-toolbar">
    <div class="control-group scope-group" role="group" aria-label="${escAttr(t("Install location"))}">
      <button class="tab ${side === "workspace" ? "active" : ""}" data-side="workspace" aria-pressed="${side === "workspace"}">Workspace</button>
      <button class="tab ${side === "central" ? "active" : ""}" data-side="central" aria-pressed="${side === "central"}">Central</button>
    </div>
    <div class="control-group install-group" role="group" aria-label="${escAttr(t("Install and discover"))}">
      <span class="group-label">${esc(t("Install"))}</span>
      <button class="${guidedPrimary}" data-download="${side}" ${envReady ? "" : "disabled"}>${esc(t("Guided"))}</button>
      <button data-command-install="${side}" ${envReady ? "" : "disabled"}>${esc(t("Paste command"))}</button>
      <button class="trending-button" data-open-link="https://www.skills.sh/trending" title="${escAttr(t("Browse popular skills on skills.sh"))}"><span class="trending-source">skills.sh</span><span class="trending-label">Trending</span></button>
    </div>
    <div class="control-group manage-group" role="group" aria-label="${escAttr(t("Library management"))}">
      <button data-update-all="${side}" ${envReady ? "" : "disabled"}>${esc(t("Update all"))}</button>
      <button class="${checkPrimary}" data-check-env>${esc(t("Check environment"))}</button>
      <button data-write-guide>${esc(t("Create guide"))}</button>
    </div>
  </div>`;
}

function renderEnvironmentBar(diagnosis: NpxSkillLibraryDiagnosis | null, t: (message: string, ...args: Array<string | number | boolean>) => string): string {
  if (!diagnosis) {
  return `<div class="envbar"><span class="env-title">${esc(t("Environment"))}</span><span class="env-status unknown">${esc(t("Not checked"))}</span><span class="env-detail">${esc(t("Check the setup, then create a guide document for an agent if anything needs attention."))}</span></div>`;
  }
  return `<div class="envbar"><span class="env-title">${esc(t("Environment"))}</span><span class="env-status ${diagnosis.status}">${esc(diagnosis.status === "ready" ? t("Ready") : t("Needs attention"))}</span><span class="env-detail">${esc(`${diagnosis.osLabel} · ${diagnosis.summary}`)}</span></div>`;
}

function renderRow(row: NpxRepoRow, active: boolean): string {
  return `<tr class="repo-row ${active ? "active" : ""}" data-id="${escAttr(row.id)}"><td><div class="repo">${esc(row.repoKey)}</div><div class="muted" title="${escAttr(row.repoUrl || "-")}">${esc(row.repoUrl || "-")}</div></td><td>${esc(row.agent)}</td><td>${row.skills.length}</td><td>${esc(row.lastInstalledAt)}</td></tr>`;
}

function renderDetail(row: NpxRepoRow, active: boolean, t: (message: string, ...args: Array<string | number | boolean>) => string, envReady: boolean): string {
  const canUpdate = row.repoUrl && row.skills.length > 0 && envReady;
  return `<article class="detail ${active ? "active" : ""}" data-id="${escAttr(row.id)}"><div class="actions"><button class="primary" data-update="${escAttr(row.id)}" ${canUpdate ? "" : "disabled"}>${esc(t("Update"))}</button><button data-delete="${escAttr(row.id)}">${esc(t("Delete"))}</button>${row.repoUrl ? `<button data-open-link="${escAttr(row.repoUrl)}">${esc(t("Open link"))}</button>` : ""}<button data-open-group="${escAttr(row.id)}">${esc(t("Open group"))}</button></div><h2>${esc(row.repoKey)}</h2><div class="meta"><span class="pill">${esc(row.side)}</span><span class="pill">${esc(row.agent)}</span><span class="pill">${esc(row.source)}</span><span class="pill">${esc(t("Last updated"))}: ${esc(row.lastInstalledAt)}</span></div><div class="muted" title="${escAttr(row.description || "-")}">${esc(row.description || "-")}</div><div class="muted">${esc(t("Install location"))}: ${esc(row.installCwd || "-")}</div><div class="skills">${row.skills.map((skill) => `<div class="skill">${esc(skill)}</div>`).join("") || `<div class="empty">${esc(t("No tracked skills."))}</div>`}</div></article>`;
}

function findRow(args: Parameters<typeof createNpxSkillLibraryTools>[0], id: string): NpxRepoRow {
  const group = args.state.groups.find((item) => item.id === id && (item.meta?.source === "npx" || item.meta?.source === "mixed"));
  if (!group) throw new Error(args.tr("Could not find the npx group."));
  return buildRows(args, group.side).find((row) => row.id === id) ?? (() => { throw new Error(args.tr("Could not read the npx group.")); })();
}

function skillFolderRelativePath(value: string): string | null {
  const parts = normalizeRel(value).split("/").filter(Boolean);
  const skillsIndex = parts.indexOf("skills");
  return skillsIndex >= 0 && parts[skillsIndex + 1] ? parts.slice(0, skillsIndex + 2).join("/") : null;
}

function skillNameFromRelativePath(value: string): string {
  const folder = skillFolderRelativePath(value);
  const parts = (folder ?? normalizeRel(value)).split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function isSideMessage(message: unknown): message is { type: "side"; side: TreeSide } {
  return isRecord(message) && message.type === "side" && (message.side === "workspace" || message.side === "central");
}
function isCheckEnvironmentMessage(message: unknown): message is { type: "checkEnvironment" } {
  return isRecord(message) && message.type === "checkEnvironment";
}
function isWriteGuideMessage(message: unknown): message is { type: "writeGuide" } {
  return isRecord(message) && message.type === "writeGuide";
}
function isDownloadMessage(message: unknown): message is { type: "download"; side: TreeSide } {
  return isRecord(message) && message.type === "download" && (message.side === "workspace" || message.side === "central");
}
function isCommandInstallMessage(message: unknown): message is { type: "commandInstall"; side: TreeSide } {
  return isRecord(message) && message.type === "commandInstall" && (message.side === "workspace" || message.side === "central");
}
function isUpdateMessage(message: unknown): message is { type: "update"; id: string } {
  return isRecord(message) && message.type === "update" && typeof message.id === "string";
}
function isUpdateAllMessage(message: unknown): message is { type: "updateAll"; side: TreeSide } {
  return isRecord(message) && message.type === "updateAll" && (message.side === "workspace" || message.side === "central");
}
function isDeleteMessage(message: unknown): message is { type: "delete"; id: string } {
  return isRecord(message) && message.type === "delete" && typeof message.id === "string";
}
function isOpenLinkMessage(message: unknown): message is { type: "openLink"; url: string } {
  return isRecord(message) && message.type === "openLink" && typeof message.url === "string" && /^https?:\/\//i.test(message.url);
}
function isOpenGroupMessage(message: unknown): message is { type: "openGroup"; id: string } {
  return isRecord(message) && message.type === "openGroup" && typeof message.id === "string";
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}
function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function escAttr(value: string): string {
  return esc(value).replace(/'/g, "&#39;");
}
