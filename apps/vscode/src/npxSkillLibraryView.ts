import { promises as fs } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import { resolveSkillPath } from "./skillPaths";
import { normalizeRel } from "./extensionSupport";
import { collectNpxSkillLibraryDiagnosis, renderNpxSkillLibraryGuideMarkdown, type NpxSkillLibraryDiagnosis } from "./npxSkillLibraryDiagnostics";
import type { GroupTreeNode, SelectionGroup, ToolType } from "./types";
import type { NpxInstallPreset } from "./extensionInstallTransfer";
import type { UiLanguage } from "./uiLanguage";
import { createWebviewNonce } from "./webviewCommon";
import { renderWebviewClientCommonScript } from "./webviewClientCommon";
import { renderWebviewCommonStyles } from "./webviewCommonStyles";

type TreeSide = "workspace" | "central";
type TranslationFn = (english: string, korean: string) => string;

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
  registerLanguageRefresh: (panel: vscode.WebviewPanel, render: () => void | Promise<void>) => void;
  state: { workspacePath: string; centralRepoPath: string; groups: SelectionGroup[] };
  getGroupTool: (group: SelectionGroup) => ToolType | "mixed" | null;
  installSkillsForSide: (side: TreeSide) => Promise<void>;
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
      const panel = vscode.window.createWebviewPanel("skillBridgeNpxSkillLibrary", args.tr("NPX Skill Library", "NPX 스킬 라이브러리"), vscode.ViewColumn.Active, { enableScripts: true });
      const render = (): void => {
        panel.title = args.tr("NPX Skill Library", "NPX 스킬 라이브러리");
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
      args.registerLanguageRefresh(panel, render);
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
      const skills = skillNamesFromTargets(group);
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
  if (!row.repoUrl) throw new Error(args.tr("This npx group has no repo URL to update from.", "이 npx 그룹에는 업데이트할 repo URL이 없습니다."));
  if (row.skills.length === 0) throw new Error(args.tr("This npx group has no tracked skill folders.", "이 npx 그룹에는 추적 중인 스킬 폴더가 없습니다."));
  return await args.installNpxRepoForSide(row.side, {
    repoUrl: row.repoUrl,
    skills: row.skills,
    cwd: row.installCwd || (row.side === "workspace" ? args.state.workspacePath : args.state.centralRepoPath),
    tool: row.agent === "mixed" ? undefined : row.agent,
    skipCommandConfirm,
    skipPostInstallSyncPrompt: true
  });
}

async function updateAllRows(args: Parameters<typeof createNpxSkillLibraryTools>[0], side: TreeSide): Promise<void> {
  const rows = buildRows(args, side).filter((row) => row.repoUrl && row.skills.length > 0);
  if (rows.length === 0) {
    vscode.window.showInformationMessage(args.tr("No npx repos can be updated in this side.", "이 위치에서 업데이트할 수 있는 npx repo가 없습니다."));
    return;
  }
  const ok = await vscode.window.showWarningMessage(
    args.tr(`Update ${rows.length} npx repo group(s) for ${side}?`, `${side}의 npx repo 그룹 ${rows.length}개를 업데이트할까요?`),
    { modal: true },
    args.tr("Update all", "전체 업데이트")
  );
  if (ok !== args.tr("Update all", "전체 업데이트")) return;
  let updated = 0;
  for (const row of rows) {
    if (await updateRow(args, row, true)) updated += 1;
  }
  vscode.window.showInformationMessage(args.tr(`NPX update complete: ${updated}/${rows.length}`, `NPX 업데이트 완료: ${updated}/${rows.length}`));
}

async function deleteRow(args: Parameters<typeof createNpxSkillLibraryTools>[0], row: NpxRepoRow): Promise<void> {
  const group = args.state.groups.find((item) => item.id === row.id);
  if (!group) throw new Error(args.tr("Could not find the npx group to delete.", "삭제할 npx 그룹을 찾지 못했습니다."));
  const preview = row.skills.slice(0, 8).join(", ");
  const more = row.skills.length > 8 ? args.tr(` and ${row.skills.length - 8} more`, ` 외 ${row.skills.length - 8}개`) : "";
  const ok = await vscode.window.showWarningMessage(
    args.tr(
      `Delete installed skills and tracking group "${row.repoKey}"?\n\n${preview}${more}`,
      `"${row.repoKey}"의 설치 스킬과 추적 그룹을 삭제할까요?\n\n${preview}${more}`
    ),
    { modal: true },
    args.tr("Delete", "삭제")
  );
  if (ok !== args.tr("Delete", "삭제")) return;
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
  vscode.window.showInformationMessage(args.tr(`Deleted npx group: ${row.repoKey}`, `npx 그룹 삭제 완료: ${row.repoKey}`));
}

async function writeNpxEnvironmentGuide(args: Parameters<typeof createNpxSkillLibraryTools>[0], diagnosis: NpxSkillLibraryDiagnosis): Promise<void> {
  if (!args.state.workspacePath) {
    throw new Error(args.tr("Workspace path is unavailable. Open a workspace before creating the guide.", "작업공간 경로를 확인할 수 없습니다. 가이드를 만들기 전에 작업공간을 열어주세요."));
  }
  const guidePath = path.join(args.state.workspacePath, "NPX_SKILL_LIBRARY_ENVIRONMENT_GUIDE.md");
  const exists = await fs.access(guidePath).then(() => true, () => false);
  if (exists) {
    const overwrite = args.tr("Overwrite", "덮어쓰기");
    const picked = await vscode.window.showWarningMessage(
      args.tr(
        `Overwrite the existing NPX environment guide?\n\n${guidePath}`,
        `기존 NPX 환경 가이드 문서를 덮어쓸까요?\n\n${guidePath}`
      ),
      { modal: true },
      overwrite
    );
    if (picked !== overwrite) return;
  }
  await fs.writeFile(guidePath, renderNpxSkillLibraryGuideMarkdown(diagnosis, args.tr), "utf8");
  const open = args.tr("Open Guide", "가이드 열기");
  const picked = await vscode.window.showInformationMessage(
    args.tr(`NPX environment guide created: ${guidePath}`, `NPX 환경 가이드 문서를 생성했습니다: ${guidePath}`),
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
    ? args.tr(
      "The NPX environment check found missing requirements. Create the guide document and resolve them before downloading or updating.",
      "NPX 환경 점검에서 누락된 필수 항목이 발견되었습니다. 가이드 문서를 만든 뒤 해결하고 설치/업데이트를 진행하세요."
    )
    : args.tr(
      "Run the NPX environment check before downloading or updating.",
      "설치/업데이트 전에 NPX 환경 점검을 먼저 진행하세요."
    );
  throw new Error(message);
}

function renderNpxSkillLibraryHtml(rows: NpxRepoRow[], side: TreeSide, language: UiLanguage, diagnosis: NpxSkillLibraryDiagnosis | null): string {
  const isKo = language === "ko";
  const t = (en: string, ko: string): string => isKo ? ko : en;
  const nonce = createWebviewNonce();
  const selected = rows[0]?.id ?? "";
  const totalSkills = rows.reduce((sum, row) => sum + row.skills.length, 0);
  const envReady = diagnosis?.status === "ready";
  return `<!doctype html><html lang="${language}"><head><meta charset="UTF-8" /><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"><style>
  ${renderWebviewCommonStyles()}body{margin:0;background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family)}.wrap{height:100vh;display:grid;grid-template-rows:auto auto auto minmax(0,1fr) auto;gap:10px;padding:12px;overflow:hidden}.top,.tabs,.actions,.envbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-width:0}.top{justify-content:space-between}h1,h2{min-width:0;margin:0;font-size:16px}.summary{color:var(--vscode-descriptionForeground);font-size:12px}button{font:inherit;border:1px solid var(--vscode-panel-border);border-radius:5px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);padding:5px 9px;cursor:pointer}button.primary,.tab.active{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:var(--vscode-button-background)}button:disabled{opacity:.55;cursor:not-allowed}.envbar{border:1px solid var(--vscode-panel-border);border-radius:6px;padding:7px 9px;background:var(--vscode-sideBar-background)}.env-title{font-weight:700}.env-status{border:1px solid var(--vscode-panel-border);border-radius:999px;padding:2px 7px;font-size:11px}.env-status.ready{border-color:rgba(52,211,153,.65);color:#86efac}.env-status.blocked{border-color:rgba(248,113,113,.75);color:#fca5a5}.env-status.unknown{color:var(--vscode-descriptionForeground)}.env-detail{color:var(--vscode-descriptionForeground);font-size:12px}.content{min-height:0;min-width:0;display:grid;grid-template-columns:minmax(360px,42%) minmax(0,1fr);gap:10px}.panel{min-height:0;border:1px solid var(--vscode-panel-border);border-radius:8px;overflow:auto}.repo-row{cursor:pointer}.repo-row.active{background:color-mix(in oklab,var(--vscode-editor-background) 84%,#60a5fa 16%)}table{width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed}th,td{text-align:left;padding:7px;border-top:1px solid var(--vscode-panel-border);vertical-align:top}th{position:sticky;top:0;background:var(--vscode-sideBar-background);color:var(--vscode-descriptionForeground);font-weight:500}.repo{font-weight:700}.muted{color:var(--vscode-descriptionForeground);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.detail{display:none;padding:12px;gap:10px}.detail.active{display:grid}.meta{display:flex;gap:6px;flex-wrap:wrap}.pill{border:1px solid var(--vscode-panel-border);border-radius:999px;padding:2px 7px;font-size:11px}.skills{display:grid;gap:5px}.skill{border:1px solid var(--vscode-panel-border);border-radius:5px;padding:6px 8px}.empty{padding:16px;color:var(--vscode-descriptionForeground)}@media(max-width:800px){.top{align-items:flex-start}.content{grid-template-columns:1fr;grid-template-rows:minmax(180px,42vh) minmax(0,1fr)}.panel table{min-width:640px}}
  </style></head><body><div class="wrap sb-root"><div class="top sb-topbar"><h1>${esc(t("NPX Skill Library", "NPX 스킬 라이브러리"))}</h1><div class="summary">${rows.length} ${esc(t("repo groups", "repo 그룹"))} · ${totalSkills} ${esc(t("skills", "스킬"))}</div></div>${renderEnvironmentBar(diagnosis, t)}<div class="tabs sb-toolbar"><button class="tab ${side === "workspace" ? "active" : ""}" data-side="workspace">Workspace</button><button class="tab ${side === "central" ? "active" : ""}" data-side="central">Central</button><button class="primary" data-download="${side}" ${envReady ? "" : "disabled"}>${esc(t("Install", "설치"))}</button><button data-update-all="${side}" ${envReady ? "" : "disabled"}>${esc(t("Update all", "전체 업데이트"))}</button><button data-check-env>${esc(t("Check environment", "환경 점검"))}</button><button data-write-guide>${esc(t("Create guide", "가이드 생성"))}</button></div><main class="content"><section class="panel sb-panel"><table><thead><tr><th>${esc(t("Repo", "Repo"))}</th><th style="width:82px">${esc(t("Agent", "에이전트"))}</th><th style="width:70px">${esc(t("Skills", "스킬"))}</th><th style="width:150px">${esc(t("Updated", "업데이트"))}</th></tr></thead><tbody>${rows.map((row, index) => renderRow(row, index === 0)).join("") || `<tr><td colspan="4"><div class="empty">${esc(t("No npx groups on this side.", "이 위치에는 npx 그룹이 없습니다."))}</div></td></tr>`}</tbody></table></section><section class="panel sb-panel">${rows.map((row, index) => renderDetail(row, index === 0, t, envReady)).join("") || `<div class="empty">${esc(t("Use Install to add skills from npx.", "설치 버튼으로 npx 스킬을 설치하세요."))}</div>`}</section></main><div id="statusLine" class="sb-status-bar info">${esc(t("Ready", "준비 완료"))}</div></div><script nonce="${nonce}">
  ${renderWebviewClientCommonScript()}const vscode=acquireVsCodeApi();let active="${escAttr(selected)}";let busy=false;const statusLine=document.getElementById("statusLine");const rows=Array.from(document.querySelectorAll(".repo-row"));const details=Array.from(document.querySelectorAll(".detail"));function setStatus(message){if(statusLine)statusLine.textContent=message||"${esc(t("Ready", "준비 완료"))}";}function show(id){active=id||"";rows.forEach(r=>r.classList.toggle("active",r.getAttribute("data-id")===active));details.forEach(d=>d.classList.toggle("active",d.getAttribute("data-id")===active));}function post(message){if(busy)return;busy=true;setStatus("${esc(t("Working...", "작업 중..."))}");document.querySelectorAll("button").forEach(b=>b.disabled=true);vscode.postMessage(message)}document.body.addEventListener("click",(event)=>{const target=event.target;if(!(target instanceof Element))return;const row=target.closest(".repo-row");if(row instanceof HTMLElement)show(row.getAttribute("data-id")||"");const side=target.closest("[data-side]");if(side instanceof HTMLElement)post({type:"side",side:side.getAttribute("data-side")||"workspace"});const checkEnv=target.closest("[data-check-env]");if(checkEnv instanceof HTMLElement)post({type:"checkEnvironment"});const writeGuide=target.closest("[data-write-guide]");if(writeGuide instanceof HTMLElement)post({type:"writeGuide"});const download=target.closest("[data-download]");if(download instanceof HTMLElement)post({type:"download",side:download.getAttribute("data-download")||"workspace"});const update=target.closest("[data-update]");if(update instanceof HTMLElement)post({type:"update",id:update.getAttribute("data-update")||""});const updateAll=target.closest("[data-update-all]");if(updateAll instanceof HTMLElement)post({type:"updateAll",side:updateAll.getAttribute("data-update-all")||"workspace"});const del=target.closest("[data-delete]");if(del instanceof HTMLElement)post({type:"delete",id:del.getAttribute("data-delete")||""});const link=target.closest("[data-open-link]");if(link instanceof HTMLElement)post({type:"openLink",url:link.getAttribute("data-open-link")||""});const group=target.closest("[data-open-group]");if(group instanceof HTMLElement)post({type:"openGroup",id:group.getAttribute("data-open-group")||""});});show(active);
  </script></body></html>`;
}

function renderEnvironmentBar(diagnosis: NpxSkillLibraryDiagnosis | null, t: (en: string, ko: string) => string): string {
  if (!diagnosis) {
  return `<div class="envbar"><span class="env-title">${esc(t("Environment", "환경"))}</span><span class="env-status unknown">${esc(t("Not checked", "점검 전"))}</span><span class="env-detail">${esc(t("Check the setup, then create a guide document for an agent if anything needs attention.", "설정을 점검한 뒤 필요한 경우 에이전트에게 전달할 가이드 문서를 생성하세요."))}</span></div>`;
  }
  return `<div class="envbar"><span class="env-title">${esc(t("Environment", "환경"))}</span><span class="env-status ${diagnosis.status}">${esc(diagnosis.status === "ready" ? t("Ready", "사용 가능") : t("Needs attention", "조치 필요"))}</span><span class="env-detail">${esc(`${diagnosis.osLabel} · ${diagnosis.summary}`)}</span></div>`;
}

function renderRow(row: NpxRepoRow, active: boolean): string {
  return `<tr class="repo-row ${active ? "active" : ""}" data-id="${escAttr(row.id)}"><td><div class="repo">${esc(row.repoKey)}</div><div class="muted" title="${escAttr(row.repoUrl || "-")}">${esc(row.repoUrl || "-")}</div></td><td>${esc(row.agent)}</td><td>${row.skills.length}</td><td>${esc(row.lastInstalledAt)}</td></tr>`;
}

function renderDetail(row: NpxRepoRow, active: boolean, t: (en: string, ko: string) => string, envReady: boolean): string {
  const canUpdate = row.repoUrl && row.skills.length > 0 && envReady;
  return `<article class="detail ${active ? "active" : ""}" data-id="${escAttr(row.id)}"><div class="actions"><button class="primary" data-update="${escAttr(row.id)}" ${canUpdate ? "" : "disabled"}>${esc(t("Update", "업데이트"))}</button><button data-delete="${escAttr(row.id)}">${esc(t("Delete", "삭제"))}</button>${row.repoUrl ? `<button data-open-link="${escAttr(row.repoUrl)}">${esc(t("Open link", "링크 열기"))}</button>` : ""}<button data-open-group="${escAttr(row.id)}">${esc(t("Open group", "그룹 열기"))}</button></div><h2>${esc(row.repoKey)}</h2><div class="meta"><span class="pill">${esc(row.side)}</span><span class="pill">${esc(row.agent)}</span><span class="pill">${esc(row.source)}</span><span class="pill">${esc(t("Last updated", "마지막 업데이트"))}: ${esc(row.lastInstalledAt)}</span></div><div class="muted" title="${escAttr(row.description || "-")}">${esc(row.description || "-")}</div><div class="muted">${esc(t("Install location", "설치 위치"))}: ${esc(row.installCwd || "-")}</div><div class="skills">${row.skills.map((skill) => `<div class="skill">${esc(skill)}</div>`).join("") || `<div class="empty">${esc(t("No tracked skills.", "추적 스킬 없음"))}</div>`}</div></article>`;
}

function findRow(args: Parameters<typeof createNpxSkillLibraryTools>[0], id: string): NpxRepoRow {
  const group = args.state.groups.find((item) => item.id === id && (item.meta?.source === "npx" || item.meta?.source === "mixed"));
  if (!group) throw new Error(args.tr("Could not find the npx group.", "npx 그룹을 찾지 못했습니다."));
  return buildRows(args, group.side).find((row) => row.id === id) ?? (() => { throw new Error(args.tr("Could not read the npx group.", "npx 그룹을 읽지 못했습니다.")); })();
}

function skillNamesFromTargets(group: SelectionGroup): string[] {
  const metaSkills = group.meta?.installSkills?.filter((skill) => skill && skill !== "*") ?? [];
  const targetSkills = group.targets.map((target) => skillNameFromRelativePath(target.relativePath)).filter((skill) => !!skill);
  return [...new Set([...metaSkills, ...targetSkills])].sort((left, right) => left.localeCompare(right));
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
