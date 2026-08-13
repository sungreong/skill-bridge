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
type TranslationFn = (message: string, ...args: Array<string | number | boolean>) => string;

type LibraryManagerDeps = {
  state: LibraryManagerStateShape;
  tr: TranslationFn;
  output: vscode.OutputChannel;
  settingsSection: string;
  handleError: (error: unknown) => Promise<void>;
  workspaceProvider: SkillTreeProvider;
  centralProvider: SkillTreeProvider;
  getUiLanguage: () => UiLanguage;
  refresh: () => Promise<void>;
  applyPanelBranding: (panel: vscode.WebviewPanel, render: () => void | Promise<void>) => void;
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
      deps.tr("Skill Library"),
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
      panel.title = deps.tr("Skill Library");
      const payload = await buildLibraryManagerPayload();
      rememberPayloadDiagnostics(payload);
      deps.output.appendLine(formatLibraryPayloadDiagnostics("render", payload));
      panel.webview.html = renderLibraryManagerHtml(panel.webview, payload, deps.getUiLanguage());
    };
    deps.applyPanelBranding(panel, render);

    await render();
    let clientReady = false;
    const bootTimeout = setTimeout(() => {
      if (clientReady) return;
      deps.output.appendLine("[LibraryManager] webview clientReady timeout (2s) - script init may have failed.");
      vscode.window.setStatusBarMessage(deps.tr("Skill Bridge: Skill Library screen initialization is delayed"), 2500);
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
          const errorMessage = String(payload.message ?? deps.tr("Unknown error"));
          const stack = String(payload.stack ?? "").trim();
          deps.output.appendLine(`[LibraryManager] client error: ${errorMessage}`);
          if (stack) deps.output.appendLine(stack);
          vscode.window.showErrorMessage(deps.tr("Skill Library screen error: {0}", String(errorMessage)));
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
          postUi({ busy: true, message: deps.tr("Refreshing list..."), tone: "info" });
          await deps.refresh();
          await postState();
          postUi({ busy: false, message: deps.tr("List refreshed."), tone: "info" });
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
          postUi({ busy: true, message: deps.tr("Opening npx skills add..."), tone: "info" });
          await deps.installSkillsForSide(side);
          await deps.refresh();
          await postState();
          postUi({ busy: false, message: deps.tr("npx skills add completed."), tone: "info" });
          return;
        }
        if (message.type === "runCommand") {
          const command = String(((message.payload as { command?: string } | undefined)?.command) ?? "");
          if (!LIBRARY_WEBVIEW_COMMANDS.has(command)) return;
          postUi({ busy: true, message: deps.tr("Running command..."), tone: "info" });
          await vscode.commands.executeCommand(command);
          await deps.refresh();
          await postState();
          postUi({ busy: false, message: deps.tr("Command completed."), tone: "info" });
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
          postUi({ busy: true, message: `${kind === "file" ? deps.tr("File") : deps.tr("Folder")} apply in progress: ${tool}/${relativePath}`, tone: "info" });
          await deps.transferPathFromExplorer(sourceSide, tool, relativePath, kind, parseGroupIds(payload.selectedGroupIds));
          await postState();
          postUi({ busy: false, message: `${kind === "file" ? deps.tr("File") : deps.tr("Folder")} apply completed: ${tool}/${relativePath}`, tone: "info" });
          return;
        }
        if (message.type === "moveSelected") {
          const payload = (message.payload as { sourceSide?: string; targets?: unknown; selectedGroupIds?: string[] } | undefined) ?? {};
          const sourceSide = payload.sourceSide === "central" ? "central" : "workspace";
          const targets = parseLibraryTargets(payload.targets);
          if (targets.length === 0) throw new Error(deps.tr("There are no items to apply."));
          postUi({ busy: true, message: deps.tr("Bulk apply in progress... ({0} targets)", String(targets.length)), tone: "info" });
          const summary = await deps.transferSelectedPathsFromLibrary(sourceSide, targets, parseGroupIds(payload.selectedGroupIds));
          await postState();
          const groupSuffix = summary.mirroredGroups > 0 ? ` · applied groups ${summary.mirroredGroups}` : "";
          postUi({
            busy: false,
            message: deps.tr("Selected apply completed: requested {0} · applied {1} · copied {2} · deleted {3} · skipped {4}{5}", String(summary.requested), String(summary.processed), String(summary.copied), String(summary.deleted), String(summary.skipped), String(groupSuffix)),
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
          postUi({ busy: true, message: deps.tr("Reviewing changes to bring into {0}: {1}/{2}", String(targetSide === "workspace" ? "Workspace" : "Central"), String(tool), String(relativePath)), tone: "info" });
          await deps.transferPathFromExplorer(sourceSide, tool, relativePath, kind, parseGroupIds(payload.selectedGroupIds));
          await postState();
          postUi({ busy: false, message: deps.tr("Bring changes review completed: {0}/{1}", String(tool), String(relativePath)), tone: "info" });
          return;
        }
        if (message.type === "updateSelected") {
          const payload = (message.payload as { targetSide?: string; targets?: unknown; selectedGroupIds?: string[] } | undefined) ?? {};
          const targetSide = payload.targetSide === "central" ? "central" : "workspace";
          const sourceSide = targetSide === "workspace" ? "central" : "workspace";
          const targets = parseLibraryTargets(payload.targets);
          if (targets.length === 0) throw new Error(deps.tr("There are no changes to bring in."));
          postUi({ busy: true, message: deps.tr("Reviewing selected changes to bring in... ({0} targets)", String(targets.length)), tone: "info" });
          const summary = await deps.transferSelectedPathsFromLibrary(sourceSide, targets, parseGroupIds(payload.selectedGroupIds));
          await postState();
          const groupSuffix = summary.mirroredGroups > 0 ? ` · applied groups ${summary.mirroredGroups}` : "";
          postUi({
            busy: false,
            message: deps.tr("Selected changes brought in: requested {0} · applied {1} · copied {2} · deleted {3} · skipped {4}{5}", String(summary.requested), String(summary.processed), String(summary.copied), String(summary.deleted), String(summary.skipped), String(groupSuffix)),
            tone: "info"
          });
          return;
        }
        if (message.type === "deletePath") {
          const payload = (message.payload as { side?: string } | undefined) ?? {};
          const side = payload.side === "central" ? "central" : "workspace";
          const targets = parseLibraryTargets([message.payload]);
          if (targets.length === 0) throw new Error(deps.tr("There are no items to delete."));
          postUi({ busy: true, message: deps.tr("Confirming delete: {0}/{1}", String(targets[0].tool), String(targets[0].relativePath)), tone: "warn" });
          const result = await deps.deleteLibraryTargets(side, targets);
          await deps.refresh();
          await postState();
          postUi({
            busy: false,
            message: deps.tr("Delete completed: requested {0} · deleted {1} · skipped {2}", String(result.requested), String(result.deleted), String(result.skipped)),
            tone: result.deleted > 0 ? "info" : "warn"
          });
          return;
        }
        if (message.type === "deleteSelected") {
          const payload = (message.payload as { side?: string; targets?: unknown } | undefined) ?? {};
          const side = payload.side === "central" ? "central" : "workspace";
          const targets = parseLibraryTargets(payload.targets);
          if (targets.length === 0) throw new Error(deps.tr("There are no selected items to delete."));
          postUi({ busy: true, message: deps.tr("Confirming selected delete... ({0} targets)", String(targets.length)), tone: "warn" });
          const result = await deps.deleteLibraryTargets(side, targets);
          await deps.refresh();
          await postState();
          postUi({
            busy: false,
            message: deps.tr("Selected delete completed: requested {0} · deleted {1} · skipped {2}", String(result.requested), String(result.deleted), String(result.skipped)),
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
            throw new Error(deps.tr("There are no groups to move."));
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
              { canPickMany: true, title: deps.tr("Choose Groups to Move") }
            )
            : groupsToMove.map((group) => ({ label: group.name, value: group.id }));
          if (!moveTargets || moveTargets.length === 0) return;

          const selectedGroups = sideGroups.filter((group) => moveTargets.some((item) => item.value === group.id));
          const directionLabel = sourceSide === "workspace"
            ? deps.tr("Workspace → Central")
            : deps.tr("Central → Workspace");
          const ok = await vscode.window.showWarningMessage(
            deps.tr("Move {0} selected groups via {1}?", String(selectedGroups.length), String(directionLabel)),
            { modal: true },
            deps.tr("Continue")
          );
          if (ok !== deps.tr("Continue")) return;

          postUi({ busy: true, message: deps.tr("Bulk group move in progress... ({0} groups)", String(selectedGroups.length)), tone: "info" });
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
            message: deps.tr("Group move completed: requested {0} · moved {1} · copied {2} · deleted {3} · unchanged {4}", String(selectedGroups.length), String(movedGroups), String(copied), String(deleted), String(unchanged)),
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
            if (!tool || !relativePath) throw new Error(deps.tr("Select group creation targets first."));
            targets.push({ tool, relativePath, kind });
          }
          const suggestName = payload.name ? String(payload.name) : (payload.suggest ? String(payload.suggest) : deps.tr("New Group"));
          const inputName = await vscode.window.showInputBox({ prompt: deps.tr("Enter a new group name."), value: suggestName, ignoreFocusOut: true });
          if (!inputName || !inputName.trim()) return;
          const description = await promptGroupDescription({
            title: side === "workspace" ? deps.tr("Workspace Group Description") : deps.tr("Central Group Description"),
            prompt: deps.tr("Describe what this group is for. This helps agents understand when to use it."),
            value: ""
          });
          if (description === undefined) return;
          const created = await createGroupFromLibraryMany(side, inputName.trim(), targets, description);
          await postState();
          const suffix = created.skippedCount > 0 ? ` (skipped ${created.skippedCount})` : "";
          postUi({ busy: false, message: deps.tr("Group created: {0} skills{1}", String(created.addedCount), String(suffix)), tone: "info" });
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
            if (!tool || !relativePath) throw new Error(deps.tr("Select targets (files/folders) first."));
            targets.push({ tool, relativePath, kind });
          }
          if (groupIds.length === 0) {
            const selectedTools = [...new Set<ToolType>(targets.map((target) => target.tool))];
            if (selectedTools.length > 1) {
              throw new Error(deps.tr("Multiple agents are selected. Select skills from the same agent and try again."));
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
                throw new Error(deps.tr("No selectable groups are available."));
              }
              const created = await promptCreateGroupForTargets(
                side,
                targets,
                deps.tr("No Existing Group"),
                deps.tr("No matching group exists for this agent. Enter a group name to create it and add the selected skills.")
              );
              if (!created) return;
              const suffix = created.skippedCount > 0 ? ` · skipped ${created.skippedCount}` : "";
              postUi({ busy: false, message: deps.tr("Group created and assigned: {0} · added {1}{2}", String(created.name), String(created.addedCount), String(suffix)), tone: "info" });
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
                  ? deps.tr("Choose Groups to Assign")
                  : deps.tr("Choose Groups to Unassign"),
                placeHolder: deps.tr("Only {0} groups are shown.", String(selectedTool))
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
          const baseLabel = message.type === "groupAssign" ? deps.tr("Group assignment completed") : deps.tr("Group unassignment completed");
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
