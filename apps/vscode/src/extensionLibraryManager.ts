import * as vscode from "vscode";
import type {
  SelectionGroup,
  SkillFile,
  ToolType,
  TransferPlan,
  TransferPlanItem
} from "./types";
import { isToolType, normalizeRel } from "./extensionSupport";
import { createLibraryDiffOpener } from "./libraryManagerDiff";
import {
  comparePayloadAndClientSummary,
  formatLibraryClientSummary,
  formatLibraryPayloadDiagnostics,
  formatLibrarySummaryMismatch,
  parseLibraryClientSummary,
  summarizeLibraryPayload
} from "./libraryManagerDiagnostics";
import type { LibraryPayloadDiagnostics } from "./libraryManagerDiagnostics";
import { createLibraryGroupTools } from "./libraryManagerGroups";
import { createLibraryPayloadBuilder } from "./libraryManagerPayload";
import {
  LIBRARY_WEBVIEW_COMMANDS,
  parseGroupIds,
  parseLibraryTargets
} from "./libraryManagerTargets";
import { renderLibraryManagerHtml } from "./libraryManagerView";
import type {
  CreateGroupSummary,
  GroupMutationSummary,
  LibraryManagerStateShape,
  LibraryPayload,
  LibraryTarget,
  TreeSide
} from "./libraryManagerTypes";
import type { UiLanguage } from "./uiLanguage";
import type { SkillTreeProvider } from "./views/skillTreeProvider";

type TransferSummary = { requested: number; processed: number; copied: number; deleted: number; unchanged: number; skipped: number; mirroredGroups: number };
type DeleteSummary = { requested: number; deleted: number; skipped: number };
type ExportSummary = { copied: number; deleted: number; unchanged: number } | null;
type TranslationFn = (english: string, korean: string) => string;

type LibraryManagerDeps = {
  state: LibraryManagerStateShape;
  tr: TranslationFn;
  output: vscode.OutputChannel;
  settingsSection: string;
  handleError: (error: unknown) => Promise<void>;
  workspaceProvider: SkillTreeProvider;
  centralProvider: SkillTreeProvider;
  getUiLanguage: () => UiLanguage;
  setUiLanguage: (language: UiLanguage) => Promise<void>;
  refresh: () => Promise<void>;
  registerLanguageRefresh: (panel: vscode.WebviewPanel, render: () => void | Promise<void>) => void;
  scanSkills: (basePath: string, side: TreeSide, agents: ToolType[]) => Promise<SkillFile[]>;
  getSideSkillFiles: (side: TreeSide) => SkillFile[];
  getSkillFolderRelativePath: (relativePath: string) => string | null;
  transferPathFromExplorer: (
    sourceSide: TreeSide,
    tool: ToolType,
    relativePath: string,
    kind: "file" | "folder",
    preferredGroupIds?: string[]
  ) => Promise<void>;
  transferSelectedPathsFromLibrary: (
    sourceSide: TreeSide,
    targets: LibraryTarget[],
    preferredGroupIds?: string[]
  ) => Promise<TransferSummary>;
  deleteLibraryTargets: (side: TreeSide, targets: LibraryTarget[]) => Promise<DeleteSummary>;
  exportGroup: (
    side: TreeSide,
    selectedGroup?: SelectionGroup,
    options?: { skipConfirm?: boolean; skipNotify?: boolean; skipRefresh?: boolean }
  ) => Promise<ExportSummary>;
  buildTransferPlan: (
    sourceSide: TreeSide,
    selections: Array<{ tool: ToolType; relativePath: string }>,
    options?: { scopeHints?: Array<{ tool: ToolType; relativePath: string; kind: "file" | "folder" }> }
  ) => Promise<TransferPlan>;
  openTransferDiff: (item: TransferPlanItem) => Promise<void>;
  openAddMoveWizardPanel: () => Promise<void>;
  openTransferExplorerPanel: () => Promise<void>;
  installSkillsForSide: (side: TreeSide) => Promise<void>;
  persistGroups: (
    next: SelectionGroup[],
    selectedGroupId: string | null,
    options?: { skipExistenceValidation?: boolean }
  ) => Promise<void>;
  isSameFileContent: (src: string, dst: string, srcSize: number, dstSize: number) => Promise<boolean>;
  toUserError: (error: unknown) => string;
};

export function createLibraryManagerTools(deps: LibraryManagerDeps): {
  buildLibraryManagerPayload: () => Promise<LibraryPayload>;
  openLibraryDiff: (sourceSide: TreeSide, tool: ToolType, relativePath: string, kind: "file" | "folder") => Promise<void>;
  openLibraryManagerPanel: () => Promise<void>;
  promptCreateGroupForTargets: (
    side: TreeSide,
    targets: LibraryTarget[],
    title: string,
    prompt: string
  ) => Promise<CreateGroupSummary | undefined>;
  assignTargetsToGroupMany: (side: TreeSide, groupId: string, targets: LibraryTarget[]) => Promise<GroupMutationSummary>;
  unassignTargetsFromGroupMany: (side: TreeSide, groupId: string, targets: LibraryTarget[]) => Promise<GroupMutationSummary>;
} {
  const groupTools = createLibraryGroupTools(deps);
  const {
    promptGroupDescription,
    promptCreateGroupForTargets,
    createGroupFromLibraryMany,
    assignTargetsToGroupMany,
    unassignTargetsFromGroupMany
  } = groupTools;
  const buildLibraryManagerPayload = createLibraryPayloadBuilder(deps);
  const openLibraryDiff = createLibraryDiffOpener(deps);
  let latestPayloadDiagnostics: LibraryPayloadDiagnostics | null = null;

  const rememberPayloadDiagnostics = (payload: LibraryPayload): void => {
    latestPayloadDiagnostics = summarizeLibraryPayload(payload);
  };

  const openLibraryManagerPanel = async (): Promise<void> => {
    await deps.refresh();
    const panel = vscode.window.createWebviewPanel(
      "skillBridgeLibraryManager",
      deps.tr("Skill Library", "스킬 보관함"),
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    const postUi = (payload: { busy?: boolean; message?: string; tone?: "info" | "warn" | "error" }): void => {
      panel.webview.postMessage({ type: "ui", payload });
    };
    const postState = async (): Promise<void> => {
      const payload = await buildLibraryManagerPayload();
      rememberPayloadDiagnostics(payload);
      deps.output.appendLine(formatLibraryPayloadDiagnostics("postState", payload));
      panel.webview.postMessage({ type: "state", payload });
    };
    const render = async (): Promise<void> => {
      panel.title = deps.tr("Skill Library", "스킬 보관함");
      const payload = await buildLibraryManagerPayload();
      rememberPayloadDiagnostics(payload);
      deps.output.appendLine(formatLibraryPayloadDiagnostics("render", payload));
      panel.webview.html = renderLibraryManagerHtml(panel.webview, payload, deps.getUiLanguage());
    };
    deps.registerLanguageRefresh(panel, render);

    await render();
    let clientReady = false;
    const bootTimeout = setTimeout(() => {
      if (clientReady) return;
      deps.output.appendLine("[LibraryManager] webview clientReady timeout (2s) - script init may have failed.");
      vscode.window.setStatusBarMessage(deps.tr("Skill Bridge: Skill Library screen initialization is delayed", "Skill Bridge: 스킬 보관함 화면 초기화 지연"), 2500);
    }, 2000);
    panel.onDidDispose(() => {
      clearTimeout(bootTimeout);
    });
    panel.webview.onDidReceiveMessage(async (msg: unknown) => {
      if (!msg || typeof msg !== "object") return;
      const message = msg as { type?: string; payload?: unknown };
      try {
        if (message.type === "clientReady") {
          clientReady = true;
          clearTimeout(bootTimeout);
          const payload = await buildLibraryManagerPayload();
          rememberPayloadDiagnostics(payload);
          deps.output.appendLine(formatLibraryPayloadDiagnostics("clientReady", payload));
          panel.webview.postMessage({ type: "state", payload });
          return;
        }
        if (message.type === "clientError") {
          const payload = (message.payload as { message?: string; stack?: string } | undefined) ?? {};
          const errorMessage = String(payload.message ?? deps.tr("Unknown error", "알 수 없는 오류"));
          const stack = String(payload.stack ?? "").trim();
          deps.output.appendLine(`[LibraryManager] client error: ${errorMessage}`);
          if (stack) deps.output.appendLine(stack);
          vscode.window.showErrorMessage(deps.tr(`Skill Library screen error: ${errorMessage}`, `스킬 보관함 화면 오류: ${errorMessage}`));
          return;
        }
        if (message.type === "clientSummary") {
          const summary = parseLibraryClientSummary(message.payload);
          if (summary) {
            deps.output.appendLine(formatLibraryClientSummary(summary));
            if (latestPayloadDiagnostics) {
              const mismatch = comparePayloadAndClientSummary(latestPayloadDiagnostics, summary);
              const line = formatLibrarySummaryMismatch(mismatch);
              if (line) deps.output.appendLine(line);
            }
          }
          return;
        }
        if (message.type === "refresh") {
          postUi({ busy: true, message: deps.tr("Refreshing list...", "목록을 새로고침하는 중..."), tone: "info" });
          await deps.refresh();
          await postState();
          postUi({ busy: false, message: deps.tr("List refreshed.", "목록이 최신 상태로 갱신되었습니다."), tone: "info" });
          return;
        }
        if (message.type === "setLanguage") {
          const nextLanguage: UiLanguage = ((message.payload as { language?: string } | undefined)?.language === "ko") ? "ko" : "en";
          await deps.setUiLanguage(nextLanguage);
          await render();
          return;
        }
        if (message.type === "openAddMoveWizard") {
          await deps.openAddMoveWizardPanel();
          return;
        }
        if (message.type === "openTransferExplorer") {
          await deps.openTransferExplorerPanel();
          return;
        }
        if (message.type === "installNpx") {
          const payload = (message.payload as { side?: string } | undefined) ?? {};
          const side = payload.side === "central" ? "central" : "workspace";
          postUi({ busy: true, message: deps.tr("Opening npx skills add...", "npx skills add 흐름을 여는 중입니다..."), tone: "info" });
          await deps.installSkillsForSide(side);
          await deps.refresh();
          await postState();
          postUi({ busy: false, message: deps.tr("npx skills add completed.", "npx skills add 흐름을 완료했습니다."), tone: "info" });
          return;
        }
        if (message.type === "runCommand") {
          const command = String(((message.payload as { command?: string } | undefined)?.command) ?? "");
          if (!LIBRARY_WEBVIEW_COMMANDS.has(command)) return;
          postUi({ busy: true, message: deps.tr("Running command...", "명령 실행 중..."), tone: "info" });
          await vscode.commands.executeCommand(command);
          await deps.refresh();
          await postState();
          postUi({ busy: false, message: deps.tr("Command completed.", "명령 실행 완료."), tone: "info" });
          return;
        }
        if (message.type === "setGroupingMode") return;
        if (message.type === "movePath") {
          const payload = (message.payload as { sourceSide?: string; tool?: string; relativePath?: string; kind?: string; selectedGroupIds?: string[] } | undefined) ?? {};
          const sourceSide = payload.sourceSide === "central" ? "central" : "workspace";
          const tool = isToolType(String(payload.tool ?? "")) ? String(payload.tool ?? "") as ToolType : null;
          const relativePath = normalizeRel(String(payload.relativePath ?? ""));
          const kind = payload.kind === "file" ? "file" : "folder";
          if (!tool || !relativePath) return;
          postUi({ busy: true, message: `${kind === "file" ? deps.tr("File", "파일") : deps.tr("Folder", "폴더")} apply in progress: ${tool}/${relativePath}`, tone: "info" });
          await deps.transferPathFromExplorer(sourceSide, tool, relativePath, kind, parseGroupIds(payload.selectedGroupIds));
          await postState();
          postUi({ busy: false, message: `${kind === "file" ? deps.tr("File", "파일") : deps.tr("Folder", "폴더")} apply completed: ${tool}/${relativePath}`, tone: "info" });
          return;
        }
        if (message.type === "moveSelected") {
          const payload = (message.payload as { sourceSide?: string; targets?: unknown; selectedGroupIds?: string[] } | undefined) ?? {};
          const sourceSide = payload.sourceSide === "central" ? "central" : "workspace";
          const targets = parseLibraryTargets(payload.targets);
          if (targets.length === 0) throw new Error(deps.tr("There are no items to apply.", "반영할 항목이 없습니다."));
          postUi({ busy: true, message: deps.tr(`Bulk apply in progress... (${targets.length} targets)`, `일괄 반영 진행 중... (${targets.length}개 대상)`), tone: "info" });
          const summary = await deps.transferSelectedPathsFromLibrary(sourceSide, targets, parseGroupIds(payload.selectedGroupIds));
          await postState();
          const groupSuffix = summary.mirroredGroups > 0 ? ` · applied groups ${summary.mirroredGroups}` : "";
          postUi({
            busy: false,
            message: deps.tr(
              `Selected apply completed: requested ${summary.requested} · applied ${summary.processed} · copied ${summary.copied} · deleted ${summary.deleted} · skipped ${summary.skipped}${groupSuffix}`,
              `선택 항목 반영 완료: 요청 ${summary.requested} · 적용 ${summary.processed} · 복사 ${summary.copied} · 삭제 ${summary.deleted} · 건너뜀 ${summary.skipped}${groupSuffix}`
            ),
            tone: "info"
          });
          return;
        }
        if (message.type === "updatePath") {
          const payload = (message.payload as { targetSide?: string; tool?: string; relativePath?: string; kind?: string; selectedGroupIds?: string[] } | undefined) ?? {};
          const targetSide = payload.targetSide === "central" ? "central" : "workspace";
          const sourceSide = targetSide === "workspace" ? "central" : "workspace";
          const tool = isToolType(String(payload.tool ?? "")) ? String(payload.tool ?? "") as ToolType : null;
          const relativePath = normalizeRel(String(payload.relativePath ?? ""));
          const kind = payload.kind === "file" ? "file" : "folder";
          if (!tool || !relativePath) return;
          postUi({ busy: true, message: deps.tr(`Reviewing changes to bring into ${targetSide === "workspace" ? "Workspace" : "Central"}: ${tool}/${relativePath}`, `${targetSide === "workspace" ? "작업공간" : "중앙"}으로 가져올 변경 검토 중: ${tool}/${relativePath}`), tone: "info" });
          await deps.transferPathFromExplorer(sourceSide, tool, relativePath, kind, parseGroupIds(payload.selectedGroupIds));
          await postState();
          postUi({ busy: false, message: deps.tr(`Bring changes review completed: ${tool}/${relativePath}`, `변경 가져오기 검토 완료: ${tool}/${relativePath}`), tone: "info" });
          return;
        }
        if (message.type === "updateSelected") {
          const payload = (message.payload as { targetSide?: string; targets?: unknown; selectedGroupIds?: string[] } | undefined) ?? {};
          const targetSide = payload.targetSide === "central" ? "central" : "workspace";
          const sourceSide = targetSide === "workspace" ? "central" : "workspace";
          const targets = parseLibraryTargets(payload.targets);
          if (targets.length === 0) throw new Error(deps.tr("There are no changes to bring in.", "가져올 변경 항목이 없습니다."));
          postUi({ busy: true, message: deps.tr(`Reviewing selected changes to bring in... (${targets.length} targets)`, `선택 변경 가져오기 검토 중... (${targets.length}개 대상)`), tone: "info" });
          const summary = await deps.transferSelectedPathsFromLibrary(sourceSide, targets, parseGroupIds(payload.selectedGroupIds));
          await postState();
          const groupSuffix = summary.mirroredGroups > 0 ? ` · applied groups ${summary.mirroredGroups}` : "";
          postUi({
            busy: false,
            message: deps.tr(
              `Selected changes brought in: requested ${summary.requested} · applied ${summary.processed} · copied ${summary.copied} · deleted ${summary.deleted} · skipped ${summary.skipped}${groupSuffix}`,
              `선택 변경 가져오기 완료: 요청 ${summary.requested} · 적용 ${summary.processed} · 복사 ${summary.copied} · 삭제 ${summary.deleted} · 건너뜀 ${summary.skipped}${groupSuffix}`
            ),
            tone: "info"
          });
          return;
        }
        if (message.type === "deletePath") {
          const payload = (message.payload as { side?: string } | undefined) ?? {};
          const side = payload.side === "central" ? "central" : "workspace";
          const targets = parseLibraryTargets([message.payload]);
          if (targets.length === 0) throw new Error(deps.tr("There are no items to delete.", "삭제할 항목이 없습니다."));
          postUi({ busy: true, message: deps.tr(`Confirming delete: ${targets[0].tool}/${targets[0].relativePath}`, `삭제 확인 중: ${targets[0].tool}/${targets[0].relativePath}`), tone: "warn" });
          const result = await deps.deleteLibraryTargets(side, targets);
          await deps.refresh();
          await postState();
          postUi({
            busy: false,
            message: deps.tr(`Delete completed: requested ${result.requested} · deleted ${result.deleted} · skipped ${result.skipped}`, `삭제 완료: 요청 ${result.requested} · 삭제 ${result.deleted} · 건너뜀 ${result.skipped}`),
            tone: result.deleted > 0 ? "info" : "warn"
          });
          return;
        }
        if (message.type === "deleteSelected") {
          const payload = (message.payload as { side?: string; targets?: unknown } | undefined) ?? {};
          const side = payload.side === "central" ? "central" : "workspace";
          const targets = parseLibraryTargets(payload.targets);
          if (targets.length === 0) throw new Error(deps.tr("There are no selected items to delete.", "삭제할 선택 항목이 없습니다."));
          postUi({ busy: true, message: deps.tr(`Confirming selected delete... (${targets.length} targets)`, `선택 삭제 확인 중... (${targets.length}개 대상)`), tone: "warn" });
          const result = await deps.deleteLibraryTargets(side, targets);
          await deps.refresh();
          await postState();
          postUi({
            busy: false,
            message: deps.tr(`Selected delete completed: requested ${result.requested} · deleted ${result.deleted} · skipped ${result.skipped}`, `선택 삭제 완료: 요청 ${result.requested} · 삭제 ${result.deleted} · 건너뜀 ${result.skipped}`),
            tone: result.deleted > 0 ? "info" : "warn"
          });
          return;
        }
        if (message.type === "moveGroup") {
          const payload = (message.payload as { sourceSide?: string; groupId?: string; groupIds?: string[] } | undefined) ?? {};
          const sourceSide = payload.sourceSide === "central" ? "central" : "workspace";
          const sideGroups = deps.state.groups
            .filter((group) => group.side === sourceSide)
            .sort((a, b) => a.name.localeCompare(b.name));
          if (sideGroups.length === 0) {
            throw new Error(deps.tr("There are no groups to move.", "이동할 그룹이 없습니다."));
          }

          const requestedIds = [
            ...(Array.isArray(payload.groupIds) ? payload.groupIds : []),
            ...(payload.groupId ? [payload.groupId] : [])
          ].map((id) => String(id)).filter(Boolean);
          const pickedGroups = requestedIds.length === 0
            ? []
            : sideGroups.filter((group) => requestedIds.includes(group.id));
          if (requestedIds.length > 0 && pickedGroups.length === 0) return;

          const groupsToMove = requestedIds.length === 0
            ? sideGroups
            : pickedGroups;
          const moveTargets = requestedIds.length === 0
            ? await vscode.window.showQuickPick(
              groupsToMove.map((group) => ({ label: group.name, description: `${group.targets[0]?.tool ?? "-"} · ${group.targets.length} skills`, value: group.id })),
              { canPickMany: true, title: deps.tr("Choose Groups to Move", "이동할 그룹 선택") }
            )
            : groupsToMove.map((group) => ({ label: group.name, value: group.id }));
          if (!moveTargets || moveTargets.length === 0) return;

          const selectedGroups = sideGroups.filter((group) => moveTargets.some((item) => item.value === group.id));
          const directionLabel = sourceSide === "workspace"
            ? deps.tr("Workspace → Central", "작업공간 → 중앙")
            : deps.tr("Central → Workspace", "중앙 → 작업공간");
          const ok = await vscode.window.showWarningMessage(
            deps.tr(
              `Move ${selectedGroups.length} selected groups via ${directionLabel}?`,
              `선택한 그룹 ${selectedGroups.length}개를 ${directionLabel} 방향으로 이동할까요?`
            ),
            { modal: true },
            deps.tr("Continue", "진행")
          );
          if (ok !== deps.tr("Continue", "진행")) return;

          postUi({ busy: true, message: deps.tr(`Bulk group move in progress... (${selectedGroups.length} groups)`, `그룹 일괄 이동 진행 중... (${selectedGroups.length}개 그룹)`), tone: "info" });
          let copied = 0;
          let deleted = 0;
          let unchanged = 0;
          let movedGroups = 0;
          for (const group of selectedGroups) {
            const result = await deps.exportGroup(sourceSide, group, {
              skipConfirm: true,
              skipNotify: true,
              skipRefresh: true
            });
            if (!result) continue;
            movedGroups += 1;
            copied += result.copied;
            deleted += result.deleted;
            unchanged += result.unchanged;
          }

          await deps.refresh();
          await postState();
          postUi({
            busy: false,
            message: deps.tr(`Group move completed: requested ${selectedGroups.length} · moved ${movedGroups} · copied ${copied} · deleted ${deleted} · unchanged ${unchanged}`, `그룹 이동 완료: 요청 ${selectedGroups.length} · 이동 ${movedGroups} · 복사 ${copied} · 삭제 ${deleted} · 변경없음 ${unchanged}`),
            tone: movedGroups === 0 ? "warn" : "info"
          });
          return;
        }
        if (message.type === "openDiff") {
          const payload = (message.payload as { sourceSide?: string; tool?: string; relativePath?: string; kind?: string } | undefined) ?? {};
          const sourceSide = payload.sourceSide === "central" ? "central" : "workspace";
          const tool = isToolType(String(payload.tool ?? "")) ? String(payload.tool ?? "") as ToolType : null;
          const relativePath = normalizeRel(String(payload.relativePath ?? ""));
          const kind = payload.kind === "file" ? "file" : "folder";
          if (!tool || !relativePath) return;
          await openLibraryDiff(sourceSide, tool, relativePath, kind);
          return;
        }
        if (message.type === "groupCreate") {
          const payload = (message.payload as { side?: string; name?: string; suggest?: string; tool?: string; relativePath?: string; kind?: string; targets?: unknown } | undefined) ?? {};
          const side = payload.side === "central" ? "central" : "workspace";
          const targets = parseLibraryTargets(payload.targets);
          if (targets.length === 0) {
            const tool = isToolType(String(payload.tool ?? "")) ? String(payload.tool ?? "") as ToolType : null;
            const relativePath = normalizeRel(String(payload.relativePath ?? ""));
            const kind = payload.kind === "file" ? "file" : "folder";
            if (!tool || !relativePath) throw new Error(deps.tr("Select group creation targets first.", "그룹 생성 대상(파일/폴더)을 먼저 선택하세요."));
            targets.push({ tool, relativePath, kind });
          }
          const suggestName = payload.name ? String(payload.name) : (payload.suggest ? String(payload.suggest) : deps.tr("New Group", "새 그룹"));
          const inputName = await vscode.window.showInputBox({ prompt: deps.tr("Enter a new group name.", "새 그룹 이름을 입력하세요"), value: suggestName, ignoreFocusOut: true });
          if (!inputName || !inputName.trim()) return;
          const description = await promptGroupDescription({
            title: side === "workspace" ? deps.tr("Workspace Group Description", "작업공간 그룹 설명") : deps.tr("Central Group Description", "중앙 그룹 설명"),
            prompt: deps.tr("Describe what this group is for. This helps agents understand when to use it.", "이 그룹의 용도를 설명하세요. 에이전트가 그룹 목적을 이해하는 데 사용됩니다."),
            value: ""
          });
          if (description === undefined) return;
          const created = await createGroupFromLibraryMany(side, inputName.trim(), targets, description);
          await postState();
          const suffix = created.skippedCount > 0 ? ` (skipped ${created.skippedCount})` : "";
          postUi({ busy: false, message: deps.tr(`Group created: ${created.addedCount} skills${suffix}`, `그룹 생성 완료: 스킬 ${created.addedCount}개${suffix}`), tone: "info" });
          return;
        }
        if (message.type === "groupAssign" || message.type === "groupUnassign") {
          const payload = (message.payload as { side?: string; groupId?: string; groupIds?: string[]; tool?: string; relativePath?: string; kind?: string; targets?: unknown } | undefined) ?? {};
          const side = payload.side === "central" ? "central" : "workspace";
          let groupIds = Array.isArray(payload.groupIds) ? payload.groupIds.map((id) => String(id)).filter(Boolean) : [];
          if (groupIds.length === 0 && payload.groupId) groupIds.push(String(payload.groupId));
          const targets = parseLibraryTargets(payload.targets);
          if (targets.length === 0) {
            const tool = isToolType(String(payload.tool ?? "")) ? String(payload.tool ?? "") as ToolType : null;
            const relativePath = normalizeRel(String(payload.relativePath ?? ""));
            const kind = payload.kind === "file" ? "file" : "folder";
            if (!tool || !relativePath) throw new Error(deps.tr("Select targets (files/folders) first.", "대상(파일/폴더)을 먼저 선택하세요."));
            targets.push({ tool, relativePath, kind });
          }
          if (groupIds.length === 0) {
            const selectedTools = [...new Set<ToolType>(targets.map((target) => target.tool))];
            if (selectedTools.length > 1) {
              throw new Error(deps.tr("Multiple agents are selected. Select skills from the same agent and try again.", "여러 에이전트가 함께 선택되었습니다. 같은 에이전트 스킬만 선택 후 다시 시도하세요."));
            }
            const selectedTool = selectedTools[0];
            const candidateGroups = deps.state.groups
              .filter((group) => group.side === side)
              .filter((group) => {
                const groupTool = group.targets[0]?.tool;
                return !!groupTool && groupTool === selectedTool;
              })
              .sort((a, b) => a.name.localeCompare(b.name));
            if (candidateGroups.length === 0) {
              if (message.type === "groupUnassign") {
                throw new Error(deps.tr("No selectable groups are available.", "선택 가능한 그룹이 없습니다."));
              }
              const created = await promptCreateGroupForTargets(
                side,
                targets,
                deps.tr("No Existing Group", "기존 그룹 없음"),
                deps.tr("No matching group exists for this agent. Enter a group name to create it and add the selected skills.", "이 에이전트에 맞는 그룹이 없습니다. 그룹 이름을 입력하면 새 그룹을 만들고 선택한 스킬을 추가합니다.")
              );
              if (!created) return;
              const suffix = created.skippedCount > 0 ? ` · skipped ${created.skippedCount}` : "";
              postUi({ busy: false, message: deps.tr(`Group created and assigned: ${created.name} · added ${created.addedCount}${suffix}`, `그룹 생성 및 할당 완료: ${created.name} · 추가 ${created.addedCount}${suffix}`), tone: "info" });
              await postState();
              return;
            }
            const picked = await vscode.window.showQuickPick(
              candidateGroups.map((group) => ({
                label: group.name,
                description: `${group.targets[0]?.tool ?? "-"} · ${group.targets.length} skills`,
                value: group.id
              })),
              {
                canPickMany: true,
                title: message.type === "groupAssign"
                  ? deps.tr("Choose Groups to Assign", "할당할 그룹 선택")
                  : deps.tr("Choose Groups to Unassign", "해제할 그룹 선택"),
                placeHolder: deps.tr(`Only ${selectedTool} groups are shown.`, `${selectedTool} 그룹만 표시됩니다.`)
              }
            );
            if (!picked || picked.length === 0) return;
            groupIds = picked.map((item) => item.value);
          }
          let affectedTotal = 0;
          let skippedTotal = 0;
          for (const groupId of groupIds) {
            if (message.type === "groupAssign") {
              const result = await assignTargetsToGroupMany(side, groupId, targets);
              affectedTotal += result.affectedCount;
              skippedTotal += result.skippedCount;
            } else {
              const result = await unassignTargetsFromGroupMany(side, groupId, targets);
              affectedTotal += result.affectedCount;
              skippedTotal += result.skippedCount;
            }
          }
          const baseLabel = message.type === "groupAssign" ? deps.tr("Group assignment completed", "그룹 할당 완료") : deps.tr("Group unassignment completed", "그룹 해제 완료");
          const suffix = skippedTotal > 0 ? ` · skipped ${skippedTotal}` : "";
          postUi({ busy: false, message: `${baseLabel}: affected ${affectedTotal}${suffix}`, tone: "info" });
          await postState();
        }
      } catch (error) {
        postUi({ busy: false, message: deps.toUserError(error), tone: "error" });
        await deps.handleError(error);
      }
    });
  };

  return {
    buildLibraryManagerPayload,
    openLibraryDiff,
    openLibraryManagerPanel,
    promptCreateGroupForTargets,
    assignTargetsToGroupMany,
    unassignTargetsFromGroupMany
  };
}
