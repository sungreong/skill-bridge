import { existsSync, promises as fs } from "node:fs";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import {
  ALL_AGENTS,
  type GroupTarget,
  type GroupTreeNode,
  type SelectionGroup,
  type SkillFile,
  type SkillSelection,
  type SkillTreeNode,
  type TransferPlan,
  type TransferPlanItem,
  type TransferPlanSummary,
  type TransferStatus,
  type ToolType,
  type WorkspaceGroupFile
} from "./types";
import { SkillTreeProvider } from "./views/skillTreeProvider";

const SETTINGS_SECTION = "skillBridge";
const CONFIGURABLE_TOOLS: ToolType[] = ["claude", "codex", "gemini", "cursor", "antigravity"];
type SourceTab = "all" | ToolType;
const execFileAsync = promisify(execFile);

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  type TreeSide = "workspace" | "central";
  type NodeCrudAction = "rename" | "delete" | "duplicate";
  type GroupMutationMode = "append" | "replace" | "remove";
  type ClipboardEntry = { kind: "file" | "folder"; tool: ToolType; relativePath: string };
  type TransferScopeHint = { tool: ToolType; relativePath: string; kind: "file" | "folder" };
  type SkillHistoryLog = {
    at: string;
    action: "copyToCentral";
    sourceProjectPath: string;
    sourceAbsolutePath: string;
  };
  type SkillHistoryRecord = {
    tool: ToolType;
    relativePath: string;
    lastUpdatedAt: string;
    lastSourceProjectPath: string;
    lastSourceAbsolutePath: string;
    history: SkillHistoryLog[];
  };
  type CentralSkillHistoryFile = {
    version: 1;
    updatedAt: string;
    records: Record<string, SkillHistoryRecord>;
  };

  const workspaceProvider = new SkillTreeProvider("skillBridge.selectWorkspaceNode", "workspace");
  const centralProvider = new SkillTreeProvider("skillBridge.selectCentralNode", "central");

  const workspaceView = vscode.window.createTreeView("skillBridge.workspaceSkills", {
    treeDataProvider: workspaceProvider,
    showCollapseAll: true,
    canSelectMany: true
  });
  const centralView = vscode.window.createTreeView("skillBridge.centralSkills", {
    treeDataProvider: centralProvider,
    showCollapseAll: true,
    canSelectMany: true
  });

  const state = {
    workspacePath: "",
    centralRepoPath: "",
    activeTab: "all" as SourceTab,
    workspaceSkills: [] as SkillFile[],
    centralSkills: [] as SkillFile[],
    workspaceMissingSkillFolders: [] as Array<{ tool: ToolType; relativePath: string }>,
    centralMissingSkillFolders: [] as Array<{ tool: ToolType; relativePath: string }>,
    agents: [...CONFIGURABLE_TOOLS, "agents"] as ToolType[],
    groups: [] as SelectionGroup[],
    workspaceSelection: [] as SkillTreeNode[],
    centralSelection: [] as SkillTreeNode[],
    selectedGroupId: null as string | null,
    clipboard: {
      side: null as TreeSide | null,
      entries: [] as ClipboardEntry[]
    }
  };

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.name = "Skill Bridge";
  statusBar.command = "skillBridge.refresh";
  statusBar.text = "$(repo) Skill Bridge";
  statusBar.show();
  const output = vscode.window.createOutputChannel("Skill Bridge");

  let refreshTimer: NodeJS.Timeout | null = null;
  let watchers: vscode.FileSystemWatcher[] = [];

  const scheduleRefresh = (): void => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      void refresh();
    }, 400);
  };

  const refresh = async (): Promise<void> => {
    const ctx = resolveContext();
    state.workspacePath = ctx.workspacePath;
    state.centralRepoPath = ctx.centralRepoPath;
    state.agents = ctx.agents;

    const [workspaceSkills, centralSkills] = await Promise.all([
      scanSkills(ctx.workspacePath, "workspace", ctx.agents),
      scanSkills(ctx.centralRepoPath, "central", ctx.agents)
    ]);

    const workspaceInventory = enforceSkillMdInventory(workspaceSkills);
    const centralInventory = enforceSkillMdInventory(centralSkills);
    state.workspaceSkills = workspaceInventory.validFiles;
    state.centralSkills = centralInventory.validFiles;
    state.workspaceMissingSkillFolders = workspaceInventory.missingFolders;
    state.centralMissingSkillFolders = centralInventory.missingFolders;
    if (workspaceInventory.missingFolders.length > 0 || centralInventory.missingFolders.length > 0) {
      const summarize = (rows: Array<{ tool: ToolType; relativePath: string }>): string => {
        if (rows.length === 0) return "0건";
        const preview = rows.slice(0, 5).map((item) => `${item.tool}/${item.relativePath}`).join(", ");
        return rows.length > 5 ? `${rows.length}건 (${preview} 외 ${rows.length - 5}건)` : `${rows.length}건 (${preview})`;
      };
      output.appendLine(`[SkillValidation] SKILL.md 누락 - workspace ${summarize(workspaceInventory.missingFolders)} / central ${summarize(centralInventory.missingFolders)}`);
    }

    const loadedGroups = await loadWorkspaceGroups(ctx.workspacePath);
    const normalizedGroupResult = normalizeGroupsForCurrentSkills(loadedGroups);
    state.groups = normalizedGroupResult.groups;
    if (normalizedGroupResult.changed) {
      await saveWorkspaceGroups(ctx.workspacePath, state.groups);
      output.appendLine(`[GroupNormalize] 그룹 정규화 적용 - split=${normalizedGroupResult.splitCount}, removedTargets=${normalizedGroupResult.removedTargetCount}, removedGroups=${normalizedGroupResult.removedGroupCount}`);
    }
    if (state.selectedGroupId && !state.groups.some((item) => item.id === state.selectedGroupId)) {
      state.selectedGroupId = null;
    }
    workspaceProvider.setGroups(state.groups);
    centralProvider.setGroups(state.groups);
    workspaceProvider.setSelectedGroup(state.selectedGroupId);
    centralProvider.setSelectedGroup(state.selectedGroupId);
    if (state.selectedGroupId) {
      const selected = state.groups.find((item) => item.id === state.selectedGroupId);
      if (selected) {
        applyGroupHighlight(state, selected, workspaceProvider, centralProvider);
      }
    } else {
      workspaceProvider.setHighlight(new Set());
      centralProvider.setHighlight(new Set());
    }
    applyTabFilter(state, workspaceProvider, centralProvider);
    const groupCounts = countGroups(filterGroupsByTab(state.groups, state.activeTab));
    statusBar.text = `$(repo) Skill Bridge: ${path.basename(ctx.centralRepoPath)} [${tabLabel(state.activeTab)}] (G W:${groupCounts.workspace} C:${groupCounts.central})`;

    for (const watcher of watchers) watcher.dispose();
    watchers = createWatchers(ctx.workspacePath, ctx.centralRepoPath);
    for (const watcher of watchers) {
      watcher.onDidCreate(scheduleRefresh);
      watcher.onDidChange(scheduleRefresh);
      watcher.onDidDelete(scheduleRefresh);
    }
  };

  const register = <TArgs extends unknown[]>(id: string, callback: (...args: TArgs) => unknown): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, (...args: unknown[]) => callback(...(args as TArgs)))
    );
  };

  context.subscriptions.push(workspaceView, centralView, statusBar, output);

  workspaceView.onDidChangeSelection((event) => {
    state.workspaceSelection = (event.selection ?? []).map((item) => item.node);
    workspaceProvider.setSelected(state.workspaceSelection[0] ?? null);
    if (state.workspaceSelection.length > 0) {
      centralProvider.setSelected(null);
    }
  });

  centralView.onDidChangeSelection((event) => {
    state.centralSelection = (event.selection ?? []).map((item) => item.node);
    centralProvider.setSelected(state.centralSelection[0] ?? null);
    if (state.centralSelection.length > 0) {
      workspaceProvider.setSelected(null);
    }
  });

  register("skillBridge.selectWorkspaceNode", (node: SkillTreeNode) => {
    workspaceProvider.setSelected(node);
    centralProvider.setSelected(null);
    void openNodeIfFile(state.workspacePath, node, "workspace");
  });

  register("skillBridge.selectCentralNode", (node: SkillTreeNode) => {
    centralProvider.setSelected(node);
    workspaceProvider.setSelected(null);
    void openNodeIfFile(state.centralRepoPath, node, "central");
  });

  register("skillBridge.selectGroup", async (node: GroupTreeNode) => {
    if (node.kind !== "group") return;
    const group = state.groups.find((item) => item.id === node.id);
    if (!group) return;
    if (state.selectedGroupId === group.id) {
      state.selectedGroupId = null;
      workspaceProvider.setSelectedGroup(null);
      centralProvider.setSelectedGroup(null);
      workspaceProvider.setHighlight(new Set());
      centralProvider.setHighlight(new Set());
    } else {
      state.selectedGroupId = group.id;
      workspaceProvider.setSelectedGroup(group.id);
      centralProvider.setSelectedGroup(group.id);
      applyGroupHighlight(state, group, workspaceProvider, centralProvider);
    }
    vscode.window.setStatusBarMessage(
      `Skill Bridge: 그룹 선택 ${group.name} (${group.targets.length}개)`,
      2000
    );
  });

  register("skillBridge.groupActions", async (node?: GroupTreeNode) => {
    await showGroupActions(node);
  });

  register("skillBridge.renameGroup", async (node?: GroupTreeNode) => {
    await renameGroup(node);
  });

  register("skillBridge.deleteGroup", async (node?: GroupTreeNode) => {
    try {
      if (!state.workspacePath) await refresh();
      const targetId = node?.kind === "group" ? node.id : state.selectedGroupId;
      if (!targetId) {
        vscode.window.showWarningMessage("삭제할 그룹을 선택하세요.");
        return;
      }
      const group = state.groups.find((item) => item.id === targetId);
      if (!group) return;
      const ok = await vscode.window.showWarningMessage(
        `그룹 "${group.name}"을 삭제할까요?`,
        { modal: true },
        "삭제"
      );
      if (ok !== "삭제") return;
      state.groups = state.groups.filter((item) => item.id !== targetId);
      await saveWorkspaceGroups(state.workspacePath, state.groups);
      if (state.selectedGroupId === targetId) state.selectedGroupId = null;
      workspaceProvider.setGroups(state.groups);
      centralProvider.setGroups(state.groups);
      workspaceProvider.setSelectedGroup(state.selectedGroupId);
      centralProvider.setSelectedGroup(state.selectedGroupId);
      workspaceProvider.setHighlight(new Set());
      centralProvider.setHighlight(new Set());
      vscode.window.showInformationMessage(`그룹 삭제 완료: ${group.name}`);
    } catch (error) {
      vscode.window.showErrorMessage(toUserError(error));
    }
  });

  register("skillBridge.createWorkspaceGroupFromNode", async (node: SkillTreeNode) => {
    const target = unwrapSkillNode(node);
    if (!target) return;
    await createGroupFromSelection("workspace", resolveGroupingNodes("workspace", target));
  });

  register("skillBridge.createCentralGroupFromNode", async (node: SkillTreeNode) => {
    const target = unwrapSkillNode(node);
    if (!target) return;
    await createGroupFromSelection("central", resolveGroupingNodes("central", target));
  });

  register("skillBridge.addWorkspaceSelectionToGroup", async (node?: SkillTreeNode) => {
    await addSelectionToExistingGroup("workspace", unwrapSkillNode(node));
  });

  register("skillBridge.addCentralSelectionToGroup", async (node?: SkillTreeNode) => {
    await addSelectionToExistingGroup("central", unwrapSkillNode(node));
  });

  register("skillBridge.createWorkspaceFolder", async (node?: SkillTreeNode) => {
    await createSkillItem("workspace", "folder", unwrapSkillNode(node));
  });

  register("skillBridge.createWorkspaceFile", async (node?: SkillTreeNode) => {
    await createSkillItem("workspace", "file", unwrapSkillNode(node));
  });

  register("skillBridge.createWorkspaceSkill", async (node?: SkillTreeNode) => {
    await createSkillFolder("workspace", unwrapSkillNode(node));
  });

  register("skillBridge.createCentralFolder", async (node?: SkillTreeNode) => {
    await createSkillItem("central", "folder", unwrapSkillNode(node));
  });

  register("skillBridge.createCentralFile", async (node?: SkillTreeNode) => {
    await createSkillItem("central", "file", unwrapSkillNode(node));
  });

  register("skillBridge.createCentralSkill", async (node?: SkillTreeNode) => {
    await createSkillFolder("central", unwrapSkillNode(node));
  });

  register("skillBridge.quickWorkspaceCrud", async (node?: SkillTreeNode) => {
    await showQuickSkillCrud("workspace", unwrapSkillNode(node));
  });

  register("skillBridge.quickCentralCrud", async (node?: SkillTreeNode) => {
    await showQuickSkillCrud("central", unwrapSkillNode(node));
  });

  register("skillBridge.smartWorkspaceActions", async (node?: SkillTreeNode) => {
    await showSmartActions("workspace", unwrapSkillNode(node));
  });

  register("skillBridge.smartCentralActions", async (node?: SkillTreeNode) => {
    await showSmartActions("central", unwrapSkillNode(node));
  });

  register("skillBridge.renameWorkspaceNode", async (node?: SkillTreeNode) => {
    await runNodeCrud("workspace", "rename", unwrapSkillNode(node));
  });

  register("skillBridge.renameCentralNode", async (node?: SkillTreeNode) => {
    await runNodeCrud("central", "rename", unwrapSkillNode(node));
  });

  register("skillBridge.deleteWorkspaceNode", async (node?: SkillTreeNode) => {
    await runNodeCrud("workspace", "delete", unwrapSkillNode(node));
  });

  register("skillBridge.deleteCentralNode", async (node?: SkillTreeNode) => {
    await runNodeCrud("central", "delete", unwrapSkillNode(node));
  });

  register("skillBridge.duplicateWorkspaceNode", async (node?: SkillTreeNode) => {
    await runNodeCrud("workspace", "duplicate", unwrapSkillNode(node));
  });

  register("skillBridge.duplicateCentralNode", async (node?: SkillTreeNode) => {
    await runNodeCrud("central", "duplicate", unwrapSkillNode(node));
  });

  register("skillBridge.copyWorkspaceNode", async (node?: SkillTreeNode) => {
    copyNodesToClipboard("workspace", unwrapSkillNode(node));
  });

  register("skillBridge.copyCentralNode", async (node?: SkillTreeNode) => {
    copyNodesToClipboard("central", unwrapSkillNode(node));
  });

  register("skillBridge.pasteWorkspaceNode", async (node?: SkillTreeNode) => {
    await pasteNodesFromClipboard("workspace", unwrapSkillNode(node));
  });

  register("skillBridge.pasteCentralNode", async (node?: SkillTreeNode) => {
    await pasteNodesFromClipboard("central", unwrapSkillNode(node));
  });

  register("skillBridge.installSkills", async (node?: SkillTreeNode) => {
    await installSkills(unwrapSkillNode(node));
  });

  register("skillBridge.viewSkillHistory", async (node?: SkillTreeNode) => {
    await showSkillHistory(unwrapSkillNode(node));
  });

  register("skillBridge.openTransferExplorer", async () => {
    await openTransferExplorerPanel();
  });
  register("skillBridge.openLibraryManager", async () => {
    await openLibraryManagerPanel();
  });

  register("skillBridge.refresh", async () => {
    try {
      await refresh();
    } catch (error) {
      vscode.window.showErrorMessage(toUserError(error));
    }
  });

  register("skillBridge.switchTab", async () => {
    const pick = await vscode.window.showQuickPick(
      [
        { label: "All", description: "모든 소스 폴더", value: "all" as SourceTab },
        { label: ".claude", description: "Claude skills", value: "claude" as SourceTab },
        { label: ".codex", description: "Codex skills", value: "codex" as SourceTab },
        { label: ".gemini", description: "Gemini skills", value: "gemini" as SourceTab },
        { label: ".cursor", description: "Cursor skills", value: "cursor" as SourceTab },
        { label: ".antigravity", description: "Antigravity skills", value: "antigravity" as SourceTab },
        { label: ".agents", description: "Shared agents skills", value: "agents" as SourceTab }
      ],
      { title: "Skill Source Tab 선택", matchOnDescription: true }
    );
    if (!pick) return;
    state.activeTab = pick.value;
    applyTabFilter(state, workspaceProvider, centralProvider);
    const groupCounts = countGroups(filterGroupsByTab(state.groups, state.activeTab));
    statusBar.text = `$(repo) Skill Bridge: ${path.basename(state.centralRepoPath)} [${tabLabel(state.activeTab)}] (G W:${groupCounts.workspace} C:${groupCounts.central})`;
  });

  register("skillBridge.promoteSelected", async () => {
    try {
      if (!state.workspacePath || !state.centralRepoPath) await refresh();

      const selected = workspaceProvider.getSelectionsFromNodes(state.workspaceSelection);
      const selections = uniqueSelections(selected.length > 0 ? selected : workspaceProvider.getAllSelections());

      if (selections.length === 0) {
        vscode.window.showWarningMessage("Workspace에서 인식된 skills 파일이 없습니다.");
        return;
      }

      const selectedGroup = state.selectedGroupId
        ? state.groups.find((group) => group.id === state.selectedGroupId && group.side === "workspace")
        : undefined;
      const result = await transferSelections("workspace", selections, {
        groupContext: selectedGroup ? { id: selectedGroup.id, name: selectedGroup.name, side: selectedGroup.side } : undefined,
        scopeHints: selectedGroup
          ? selectedGroup.targets.map((target) => ({ ...target }))
          : buildTransferScopeHintsFromNodes(state.workspaceSelection)
      });
      const mirrored = await mirrorSelectedGroupAfterTransfer("workspace");

      await refresh();
      if (result.copied + result.deleted === 0) {
        vscode.window.showInformationMessage(`중앙 저장소 복사 결과 변경 없음${mirrored ? " · 그룹 동기화됨" : ""}`);
      } else {
        vscode.window.showInformationMessage(`중앙 저장소 반영: 복사 ${result.copied}개 / 삭제 ${result.deleted}개 / 변경없음 ${result.unchanged}개${mirrored ? " · 그룹 동기화됨" : ""}`);
      }
    } catch (error) {
      vscode.window.showErrorMessage(toUserError(error));
    }
  });

  register("skillBridge.importSelected", async () => {
    try {
      if (!state.workspacePath || !state.centralRepoPath) await refresh();

      const selected = centralProvider.getSelectionsFromNodes(state.centralSelection);
      const selections = uniqueSelections(selected.length > 0 ? selected : centralProvider.getAllSelections());

      if (selections.length === 0) {
        vscode.window.showWarningMessage("Central 저장소에서 인식된 skills 파일이 없습니다.");
        return;
      }

      const selectedGroup = state.selectedGroupId
        ? state.groups.find((group) => group.id === state.selectedGroupId && group.side === "central")
        : undefined;
      const result = await transferSelections("central", selections, {
        groupContext: selectedGroup ? { id: selectedGroup.id, name: selectedGroup.name, side: selectedGroup.side } : undefined,
        scopeHints: selectedGroup
          ? selectedGroup.targets.map((target) => ({ ...target }))
          : buildTransferScopeHintsFromNodes(state.centralSelection)
      });
      const mirrored = await mirrorSelectedGroupAfterTransfer("central");

      await refresh();
      if (result.copied + result.deleted === 0) {
        vscode.window.showInformationMessage(`작업 폴더 복사 결과 변경 없음${mirrored ? " · 그룹 동기화됨" : ""}`);
      } else {
        vscode.window.showInformationMessage(`작업 폴더 반영: 복사 ${result.copied}개 / 삭제 ${result.deleted}개 / 변경없음 ${result.unchanged}개${mirrored ? " · 그룹 동기화됨" : ""}`);
      }
    } catch (error) {
      vscode.window.showErrorMessage(toUserError(error));
    }
  });

  register("skillBridge.createWorkspaceGroup", async () => {
    await createGroupFromSelection("workspace");
  });

  register("skillBridge.createCentralGroup", async () => {
    await createGroupFromSelection("central");
  });

  register("skillBridge.promoteGroup", async () => {
    await exportGroup("workspace");
  });

  register("skillBridge.importGroup", async () => {
    await exportGroup("central");
  });

  try {
    await refresh();
  } catch (error) {
    vscode.window.showWarningMessage(toUserError(error));
  }

  async function createGroupFromSelection(
    side: "workspace" | "central",
    overrideNodes?: SkillTreeNode[]
  ): Promise<void> {
    try {
      if (!state.workspacePath || !state.centralRepoPath) await refresh();
      const nodes = (overrideNodes && overrideNodes.length > 0)
        ? overrideNodes
        : resolveGroupingNodes(side);
      if (nodes.length === 0) {
        vscode.window.showWarningMessage("먼저 트리에서 항목을 선택하세요.");
        return;
      }

      const targets = buildGroupTargetsFromNodes(nodes);
      if (targets.length === 0) {
        vscode.window.showWarningMessage("skills 폴더 하위 항목만 그룹으로 저장할 수 있습니다.");
        return;
      }

      const name = await vscode.window.showInputBox({
        title: "그룹 이름",
        prompt: "그룹 이름을 입력하세요",
        value: `group-${new Date().toLocaleDateString("ko")}`
      });
      if (!name?.trim()) return;
      const trimmedName = name.trim();

      const selectedTools = [...new Set<ToolType>(targets.map((target) => target.tool))];
      const baseTool = selectedTools[0];
      if (!baseTool) {
        vscode.window.showWarningMessage("유효한 스킬을 먼저 선택하세요.");
        return;
      }
      ensureUniqueGroupNameForTool(side, baseTool, trimmedName);

      const sameToolTargets = targets.filter((target) => target.tool === baseTool);
      if (sameToolTargets.length !== targets.length) {
        vscode.window.showInformationMessage(`다른 에이전트 선택 ${targets.length - sameToolTargets.length}개는 제외하고 ${baseTool} 스킬만 그룹에 저장합니다.`);
      }

      const group: SelectionGroup = {
        id: `${side}-${Date.now()}`,
        name: trimmedName,
        side,
        targets: sameToolTargets,
        meta: { source: "manual" }
      };
      await persistGroups([...state.groups, group], group.id);
      const saved = state.groups.find((item) => item.id === state.selectedGroupId) ?? state.groups.find((item) => item.name === group.name && item.side === group.side);
      if (saved) {
        applyGroupHighlight(state, saved, workspaceProvider, centralProvider);
      }
      vscode.window.showInformationMessage(`그룹 저장 완료: ${group.name} (스킬 ${sameToolTargets.length}개)`);
    } catch (error) {
      vscode.window.showErrorMessage(toUserError(error));
    }
  }

  function resolveGroupingNodes(
    side: "workspace" | "central",
    targetNode?: SkillTreeNode
  ): SkillTreeNode[] {
    const current = side === "workspace" ? state.workspaceSelection : state.centralSelection;
    const groupable = current.filter((node) => node.kind === "file" || node.kind === "folder");
    if (!targetNode) return groupable;
    if (!(targetNode.kind === "file" || targetNode.kind === "folder")) return groupable;
    if (groupable.some((node) => node.key === targetNode.key)) return groupable;
    return [targetNode];
  }

  async function addSelectionToExistingGroup(
    side: "workspace" | "central",
    targetNode?: SkillTreeNode
  ): Promise<void> {
    try {
      if (!state.workspacePath || !state.centralRepoPath) await refresh();
      const nodes = resolveGroupingNodes(side, targetNode);
      if (nodes.length === 0) {
        vscode.window.showWarningMessage("먼저 스킬 폴더/파일을 선택하세요.");
        return;
      }
      const targets = buildGroupTargetsFromNodes(nodes);
      if (targets.length === 0) {
        vscode.window.showWarningMessage("SKILL.md가 있는 유효 스킬만 그룹에 추가할 수 있습니다.");
        return;
      }

      const selectedTools = [...new Set<ToolType>(targets.map((target) => target.tool))];
      const candidateGroups = state.groups
        .filter((group) => group.side === side)
        .filter((group) => {
          const groupTool = group.targets[0]?.tool;
          if (!groupTool) return false;
          return selectedTools.length === 1 ? groupTool === selectedTools[0] : selectedTools.includes(groupTool);
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      if (candidateGroups.length === 0) {
        vscode.window.showWarningMessage("추가할 기존 그룹이 없습니다. 먼저 그룹을 생성하세요.");
        return;
      }

      const picks = await vscode.window.showQuickPick(
        candidateGroups.map((group) => ({
          label: group.name,
          description: `${group.targets[0]?.tool ?? "-"} · 스킬 ${group.targets.length}`,
          value: group.id
        })),
        {
          canPickMany: true,
          title: side === "workspace" ? "Workspace 기존 그룹에 추가" : "Central 기존 그룹에 추가",
          placeHolder: "추가할 그룹을 하나 이상 선택하세요."
        }
      );
      if (!picks || picks.length === 0) return;

      let affectedTotal = 0;
      let skippedTotal = 0;
      for (const pick of picks) {
        const result = await assignTargetsToGroupMany(
          side,
          pick.value,
          targets.map((target) => ({ tool: target.tool, relativePath: target.relativePath, kind: "folder" as const }))
        );
        affectedTotal += result.affectedCount;
        skippedTotal += result.skippedCount;
      }
      const skipSuffix = skippedTotal > 0 ? ` · 제외 ${skippedTotal}개` : "";
      vscode.window.showInformationMessage(`기존 그룹 추가 완료: 반영 ${affectedTotal}개${skipSuffix}`);
    } catch (error) {
      vscode.window.showErrorMessage(toUserError(error));
    }
  }

  async function exportGroup(
    side: "workspace" | "central",
    selectedGroup?: SelectionGroup,
    options?: { skipConfirm?: boolean; skipNotify?: boolean; skipRefresh?: boolean }
  ): Promise<{ copied: number; deleted: number; unchanged: number } | null> {
    try {
      if (!state.workspacePath || !state.centralRepoPath) await refresh();
      const groups = state.groups.filter((item) => item.side === side);
      if (groups.length === 0) {
        vscode.window.showWarningMessage("등록된 그룹이 없습니다.");
        return null;
      }

      const group = selectedGroup ?? await pickGroup(groups, side);
      if (!group) return null;

      const selections = targetsToSelections(
        side === "workspace" ? state.workspaceSkills : state.centralSkills,
        group.targets
      );
      if (selections.length === 0) {
        vscode.window.showWarningMessage("그룹에서 전송할 파일을 찾지 못했습니다.");
        return null;
      }

      if (!options?.skipConfirm) {
        const directionLabel = side === "workspace" ? "Workspace → Central" : "Central → Workspace";
        const ok = await vscode.window.showWarningMessage(
          `그룹 "${group.name}" (${selections.length}개) ${directionLabel} 내보내기를 진행할까요?`,
          { modal: true },
          "진행"
        );
        if (ok !== "진행") return null;
      }

      const result = await transferSelections(side, selections, {
        groupContext: { id: group.id, name: group.name, side: group.side },
        scopeHints: group.targets.map((target) => ({ ...target }))
      });
      await mirrorGroupToOtherSide(group);

      if (!options?.skipRefresh) {
        await refresh();
      }
      if (!options?.skipNotify) {
        if (result.copied + result.deleted === 0) {
          vscode.window.showInformationMessage("그룹 복사 결과 변경 없음 · 반대 패널 그룹 동기화됨");
        } else {
          vscode.window.showInformationMessage(`그룹 반영: 복사 ${result.copied}개 / 삭제 ${result.deleted}개 / 변경없음 ${result.unchanged}개 · 반대 패널 그룹 동기화됨`);
        }
      }
      return { copied: result.copied, deleted: result.deleted, unchanged: result.unchanged };
    } catch (error) {
      vscode.window.showErrorMessage(toUserError(error));
      return null;
    }
  }

  function getTopSkillFolder(relativePath: string): string | null {
    const skillFolderRel = getSkillFolderRelativePath(relativePath);
    if (!skillFolderRel) return null;
    return skillFolderRel.split("/")[1] ?? null;
  }

  function getSkillInnerPath(relativePath: string, folder: string): string {
    const normalized = normalizeRel(relativePath);
    const prefix = `skills/${folder}/`;
    if (normalized.startsWith(prefix)) return normalized.slice(prefix.length);
    if (normalized === `skills/${folder}`) return "";
    return normalized;
  }

  function summarizeGroupTargets(targets: GroupTarget[]): string {
    return `스킬 ${targets.length}`;
  }

  function getSideSkillFiles(side: "workspace" | "central"): SkillFile[] {
    return side === "workspace" ? state.workspaceSkills : state.centralSkills;
  }

  function normalizeGroupNameKey(name: string): string {
    return name.trim().toLocaleLowerCase("ko-KR");
  }

  function getGroupTool(group: SelectionGroup): ToolType | null {
    return group.targets[0]?.tool ?? null;
  }

  function ensureUniqueGroupNameForTool(
    side: "workspace" | "central",
    tool: ToolType,
    name: string,
    excludeId?: string
  ): void {
    const key = normalizeGroupNameKey(name);
    const duplicate = state.groups.find((group) => {
      if (group.side !== side) return false;
      if (excludeId && group.id === excludeId) return false;
      const groupTool = getGroupTool(group);
      if (!groupTool || groupTool !== tool) return false;
      return normalizeGroupNameKey(group.name) === key;
    });
    if (duplicate) {
      throw new Error(`같은 에이전트(${tool})에는 동일한 그룹명 "${name.trim()}"을 만들 수 없습니다.`);
    }
  }

  function toSkillFolderTarget(
    tool: ToolType,
    relativePath: string
  ): GroupTarget | null {
    const skillFolderRel = getSkillFolderRelativePath(relativePath);
    if (!skillFolderRel) return null;
    return {
      kind: "folder",
      tool,
      relativePath: skillFolderRel
    };
  }

  function ensureUniqueGroupId(baseId: string, used: Set<string>): string {
    if (!used.has(baseId)) {
      used.add(baseId);
      return baseId;
    }
    let index = 2;
    while (used.has(`${baseId}-${index}`)) index += 1;
    const next = `${baseId}-${index}`;
    used.add(next);
    return next;
  }

  function normalizeGroupsForCurrentSkills(
    input: SelectionGroup[],
    options?: { skipExistenceValidation?: boolean }
  ): {
    groups: SelectionGroup[];
    changed: boolean;
    splitCount: number;
    removedTargetCount: number;
    removedGroupCount: number;
  } {
    const usedIds = new Set<string>();
    const next: SelectionGroup[] = [];
    let changed = false;
    let splitCount = 0;
    let removedTargetCount = 0;
    let removedGroupCount = 0;

    for (const group of input) {
      const normalizedTargets = dedupeGroupTargets(group.targets);
      if (normalizedTargets.length !== group.targets.length || group.targets.some((target) => target.kind !== "folder")) {
        changed = true;
      }
      if (normalizedTargets.length === 0) {
        removedGroupCount += 1;
        changed = true;
        continue;
      }

      const groupedByTool = new Map<ToolType, GroupTarget[]>();
      for (const target of normalizedTargets) {
        const bucket = groupedByTool.get(target.tool) ?? [];
        bucket.push(target);
        groupedByTool.set(target.tool, bucket);
      }
      if (groupedByTool.size > 1) {
        changed = true;
        splitCount += groupedByTool.size - 1;
      }

      const toolEntries = [...groupedByTool.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const sideFiles = getSideSkillFiles(group.side);
      let created = 0;
      for (let index = 0; index < toolEntries.length; index += 1) {
        const [tool, targets] = toolEntries[index];
        const validTargets = options?.skipExistenceValidation
          ? [...targets]
          : targets.filter((target) => targetExistsInFiles(target, sideFiles));
        removedTargetCount += targets.length - validTargets.length;
        if (validTargets.length !== targets.length) changed = true;
        if (validTargets.length === 0) continue;
        const nextId = ensureUniqueGroupId(index === 0 ? group.id : `${group.id}-${tool}`, usedIds);
        const nextName = toolEntries.length > 1 ? `${group.name} · ${tool}` : group.name;
        next.push({
          ...group,
          id: nextId,
          name: nextName,
          side: group.side,
          targets: validTargets
        });
        created += 1;
      }
      if (created === 0) {
        removedGroupCount += 1;
        changed = true;
      }
    }

    const mergedByName = new Map<string, SelectionGroup>();
    for (const group of next) {
      const tool = getGroupTool(group);
      if (!tool) {
        removedGroupCount += 1;
        changed = true;
        continue;
      }
      const key = `${group.side}:${tool}:${normalizeGroupNameKey(group.name)}`;
      const prev = mergedByName.get(key);
      if (!prev) {
        mergedByName.set(key, { ...group, targets: dedupeGroupTargets(group.targets) });
        continue;
      }
      const mergedTargets = dedupeGroupTargets([...prev.targets, ...group.targets]);
      mergedByName.set(key, { ...prev, targets: mergedTargets });
      removedGroupCount += 1;
      changed = true;
    }

    const mergedGroups = [...mergedByName.values()];
    return { groups: mergedGroups, changed, splitCount, removedTargetCount, removedGroupCount };
  }

  function buildTransferExplorerPayload(): {
    tools: ToolType[];
    workspace: {
      folders: Array<{
        tool: ToolType;
        folder: string;
        fileCount: number;
        groupNames: string[];
        files: string[];
        subfolders: Array<{ path: string; fileCount: number }>;
      }>;
      groups: Array<{ id: string; name: string; targetSummary: string; targetCount: number; tools: ToolType[] }>;
    };
    central: {
      folders: Array<{
        tool: ToolType;
        folder: string;
        fileCount: number;
        groupNames: string[];
        files: string[];
        subfolders: Array<{ path: string; fileCount: number }>;
      }>;
      groups: Array<{ id: string; name: string; targetSummary: string; targetCount: number; tools: ToolType[] }>;
    };
  } {
    const buildSide = (side: "workspace" | "central"): {
      folders: Array<{
        tool: ToolType;
        folder: string;
        fileCount: number;
        groupNames: string[];
        files: string[];
        subfolders: Array<{ path: string; fileCount: number }>;
      }>;
      groups: Array<{ id: string; name: string; targetSummary: string; targetCount: number; tools: ToolType[] }>;
    } => {
      const files = side === "workspace" ? state.workspaceSkills : state.centralSkills;
      const sideGroups = state.groups.filter((group) => group.side === side);
      const folderMap = new Map<string, {
        tool: ToolType;
        folder: string;
        fileCount: number;
        groupNames: Set<string>;
        files: Set<string>;
        subfolderCounts: Map<string, number>;
      }>();

      for (const file of files) {
        const folder = getTopSkillFolder(file.relativePath);
        if (!folder) continue;
        const key = `${file.tool}:${folder}`;
        const prev = folderMap.get(key) ?? {
          tool: file.tool,
          folder,
          fileCount: 0,
          groupNames: new Set<string>(),
          files: new Set<string>(),
          subfolderCounts: new Map<string, number>()
        };
        prev.fileCount += 1;
        const inner = getSkillInnerPath(file.relativePath, folder);
        if (inner) {
          prev.files.add(inner);
          const parts = inner.split("/").filter(Boolean);
          let prefix = "";
          for (let i = 0; i < parts.length - 1; i += 1) {
            prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
            const count = prev.subfolderCounts.get(prefix) ?? 0;
            prev.subfolderCounts.set(prefix, count + 1);
          }
        }
        folderMap.set(key, prev);
      }

      for (const group of sideGroups) {
        for (const target of group.targets) {
          const folder = getTopSkillFolder(target.relativePath);
          if (!folder) continue;
          const key = `${target.tool}:${folder}`;
          const prev = folderMap.get(key) ?? {
            tool: target.tool,
            folder,
            fileCount: 0,
            groupNames: new Set<string>(),
            files: new Set<string>(),
            subfolderCounts: new Map<string, number>()
          };
          prev.groupNames.add(group.name);
          folderMap.set(key, prev);
        }
      }

      const folders = [...folderMap.values()]
        .map((entry) => ({
          tool: entry.tool,
          folder: entry.folder,
          fileCount: entry.fileCount,
          groupNames: [...entry.groupNames].sort((a, b) => a.localeCompare(b)),
          files: [...entry.files].sort((a, b) => a.localeCompare(b)),
          subfolders: [...entry.subfolderCounts.entries()]
            .map(([path, fileCount]) => ({ path, fileCount }))
            .sort((a, b) => a.path.localeCompare(b.path))
        }))
        .sort((a, b) => a.tool.localeCompare(b.tool) || a.folder.localeCompare(b.folder));
      const groups = sideGroups
        .map((group) => ({
          id: group.id,
          name: group.name,
          targetSummary: summarizeGroupTargets(group.targets),
          targetCount: group.targets.length,
          tools: [...new Set(group.targets.map((target) => target.tool))].sort((a, b) => a.localeCompare(b))
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      return { folders, groups };
    };

    const workspace = buildSide("workspace");
    const central = buildSide("central");
    const tools = [...new Set<ToolType>([
      ...workspace.folders.map((item) => item.tool),
      ...central.folders.map((item) => item.tool),
      ...workspace.groups.flatMap((item) => item.tools),
      ...central.groups.flatMap((item) => item.tools)
    ])].sort((a, b) => a.localeCompare(b));
    return { tools, workspace, central };
  }

  async function transferPathFromExplorer(
    sourceSide: "workspace" | "central",
    tool: ToolType,
    relativePath: string,
    kind: "file" | "folder"
  ): Promise<void> {
    const skillFolderRel = getSkillFolderRelativePath(relativePath);
    if (!skillFolderRel) {
      vscode.window.showWarningMessage(`스킬 폴더 경로가 아닙니다: ${tool}/${relativePath}`);
      return;
    }
    const basePath = sourceSide === "workspace" ? state.workspacePath : state.centralRepoPath;
    const skillMdRel = `${skillFolderRel}/SKILL.md`;
    const skillMdAbs = resolveSkillPath(basePath, tool, skillMdRel, sourceSide);
    if (!(await exists(skillMdAbs))) {
      vscode.window.showWarningMessage(`SKILL.md가 없는 스킬은 전송할 수 없습니다: ${tool}/${skillFolderRel}`);
      return;
    }

    const sourceFiles = sourceSide === "workspace" ? state.workspaceSkills : state.centralSkills;
    const selections = uniqueSelections(
      sourceFiles
        .filter((file) => {
          if (file.tool !== tool) return false;
          if (kind === "file") return file.relativePath === relativePath;
          return file.relativePath === relativePath || file.relativePath.startsWith(`${relativePath}/`);
        })
        .map((file) => ({ tool: file.tool, relativePath: file.relativePath }))
    );
    if (selections.length === 0) {
      vscode.window.showWarningMessage(`전송할 유효 스킬을 찾지 못했습니다: ${tool}/${skillFolderRel}`);
      return;
    }
    const result = await transferSelections(sourceSide, selections, {
      scopeHints: [{ kind, tool, relativePath }]
    });
    await refresh();
    const mirroredGroups = await mirrorGroupsForTransferredTargets(sourceSide, [{ kind, tool, relativePath }]);
    const label = sourceSide === "workspace" ? "Workspace → Central" : "Central → Workspace";
    if (result.copied + result.deleted === 0) {
      vscode.window.showInformationMessage(`${label}: ${tool}/${relativePath} 변경 없음`);
    } else {
      const groupSuffix = mirroredGroups > 0 ? ` · 그룹 동기화 ${mirroredGroups}개` : "";
      vscode.window.showInformationMessage(`${label}: ${tool}/${relativePath} 반영 완료 (복사 ${result.copied}, 삭제 ${result.deleted})${groupSuffix}`);
    }
  }

  async function transferSelectedPathsFromLibrary(
    sourceSide: "workspace" | "central",
    targets: Array<{ tool: ToolType; relativePath: string; kind: "file" | "folder" }>
  ): Promise<{ requested: number; processed: number; copied: number; deleted: number; unchanged: number; skipped: number; mirroredGroups: number }> {
    const dedupTargets = [
      ...new Map(
        targets
          .filter((target) => target.tool && target.relativePath)
          .map((target) => {
            const normalizedRel = normalizeRel(target.relativePath);
            const kind = target.kind === "file" ? "file" : "folder";
            return [`${target.tool}:${normalizedRel}:${kind}`, { tool: target.tool, relativePath: normalizedRel, kind }] as const;
          })
      ).values()
    ];
    if (dedupTargets.length === 0) {
      throw new Error("일괄 이동할 대상을 먼저 선택하세요.");
    }

    const basePath = sourceSide === "workspace" ? state.workspacePath : state.centralRepoPath;
    const sourceFiles = sourceSide === "workspace" ? state.workspaceSkills : state.centralSkills;
    const scopeHints: TransferScopeHint[] = [];
    const selectedFiles: Array<{ tool: ToolType; relativePath: string }> = [];

    for (const target of dedupTargets) {
      const skillFolderRel = getSkillFolderRelativePath(target.relativePath);
      if (!skillFolderRel) continue;
      const skillMdRel = `${skillFolderRel}/SKILL.md`;
      const skillMdAbs = resolveSkillPath(basePath, target.tool, skillMdRel, sourceSide);
      if (!(await exists(skillMdAbs))) continue;

      const matched = sourceFiles.filter((file) => {
        if (file.tool !== target.tool) return false;
        if (target.kind === "file") return file.relativePath === target.relativePath;
        return file.relativePath === target.relativePath || file.relativePath.startsWith(`${target.relativePath}/`);
      });
      if (matched.length === 0) continue;

      selectedFiles.push(...matched.map((file) => ({ tool: file.tool, relativePath: file.relativePath })));
      scopeHints.push({ tool: target.tool, relativePath: target.relativePath, kind: target.kind });
    }

    const selections = uniqueSelections(selectedFiles);
    if (selections.length === 0 || scopeHints.length === 0) {
      throw new Error("선택 항목 중 전송 가능한 유효 스킬을 찾지 못했습니다.");
    }

    const result = await transferSelections(sourceSide, selections, { scopeHints });
    await refresh();
    const mirroredGroups = await mirrorGroupsForTransferredTargets(sourceSide, scopeHints);
    return {
      requested: dedupTargets.length,
      processed: scopeHints.length,
      copied: result.copied,
      deleted: result.deleted,
      unchanged: result.unchanged,
      skipped: Math.max(0, dedupTargets.length - scopeHints.length),
      mirroredGroups
    };
  }

  async function openTransferExplorerPanel(): Promise<void> {
    if (!state.workspacePath || !state.centralRepoPath) await refresh();
    const panel = vscode.window.createWebviewPanel(
      "skillBridgeTransferExplorer",
      "Transfer Explorer (Workspace ↔ Central)",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    const postState = (): void => {
      panel.webview.postMessage({ type: "state", payload: buildTransferExplorerPayload() });
    };
    const postUi = (payload: { busy?: boolean; message?: string; tone?: "info" | "warn" | "error" }): void => {
      panel.webview.postMessage({ type: "ui", payload });
    };

    panel.webview.html = renderTransferExplorerHtml(panel.webview, buildTransferExplorerPayload());
    panel.webview.onDidReceiveMessage(async (msg: unknown) => {
      if (!msg || typeof msg !== "object") return;
      const message = msg as { type?: string; payload?: unknown };
      try {
        if (message.type === "refresh") {
          postUi({ busy: true, message: "목록을 새로고침하는 중...", tone: "info" });
          await refresh();
          postState();
          postUi({ busy: false, message: "목록이 최신 상태로 갱신되었습니다.", tone: "info" });
          return;
        }
        if (message.type === "movePath") {
          const payload = (message.payload as { sourceSide?: string; tool?: string; relativePath?: string; kind?: string } | undefined) ?? {};
          const sourceSide = payload.sourceSide === "central" ? "central" : "workspace";
          const tool = isToolType(String(payload.tool ?? "")) ? String(payload.tool ?? "") as ToolType : null;
          const relativePath = normalizeRel(String(payload.relativePath ?? ""));
          const kind = payload.kind === "file" ? "file" : "folder";
          if (!tool || !relativePath) return;
          postUi({ busy: true, message: `${kind === "file" ? "파일" : "폴더"} 전송 중: ${tool}/${relativePath}`, tone: "info" });
          await transferPathFromExplorer(sourceSide, tool, relativePath, kind);
          postState();
          postUi({ busy: false, message: `${kind === "file" ? "파일" : "폴더"} 전송 완료: ${tool}/${relativePath}`, tone: "info" });
          return;
        }
        if (message.type === "moveGroup") {
          const payload = (message.payload as { sourceSide?: string; groupId?: string } | undefined) ?? {};
          const sourceSide = payload.sourceSide === "central" ? "central" : "workspace";
          const groupId = String(payload.groupId ?? "");
          if (!groupId) return;
          const group = state.groups.find((entry) => entry.id === groupId && entry.side === sourceSide);
          if (!group) {
            vscode.window.showWarningMessage("전송할 그룹을 찾지 못했습니다.");
            return;
          }
          postUi({ busy: true, message: `그룹 전송 중: ${group.name}`, tone: "info" });
          await exportGroup(sourceSide, group);
          postState();
          postUi({ busy: false, message: `그룹 전송 완료: ${group.name}`, tone: "info" });
        }
      } catch (error) {
        postUi({ busy: false, message: toUserError(error), tone: "error" });
        vscode.window.showErrorMessage(toUserError(error));
      }
    });
  }

  type LibraryStatus = "added" | "removed" | "modified" | "typeChanged" | "same";
  type LibraryEntry = {
    key: string;
    tool: ToolType;
    relativePath: string;
    folder: string;
    innerPath: string;
    exists: boolean;
    status: LibraryStatus;
    groupIds: string[];
    groupNames: string[];
  };
  type LibraryGroupView = {
    id: string;
    name: string;
    targetSummary: string;
    targetCount: number;
    tools: ToolType[];
  };
  type LibrarySideView = {
    entries: LibraryEntry[];
    groups: LibraryGroupView[];
  };
  type LibraryPayload = {
    tools: ToolType[];
    workspace: LibrarySideView;
    central: LibrarySideView;
    diagnostics: {
      workspaceMissingSkillFolders: Array<{ tool: ToolType; relativePath: string }>;
      centralMissingSkillFolders: Array<{ tool: ToolType; relativePath: string }>;
    };
  };

  function splitLibraryKey(key: string): { tool: ToolType; relativePath: string } | null {
    const idx = key.indexOf(":");
    if (idx <= 0) return null;
    const toolRaw = key.slice(0, idx);
    const relativePath = key.slice(idx + 1);
    if (!isToolType(toolRaw)) return null;
    return { tool: toolRaw, relativePath };
  }

  function entryMatchesTarget(tool: ToolType, relativePath: string, target: GroupTarget): boolean {
    if (target.tool !== tool) return false;
    if (target.kind === "file") return target.relativePath === relativePath;
    return relativePath === target.relativePath || relativePath.startsWith(`${target.relativePath}/`);
  }

  function summarizeStatuses(statuses: LibraryStatus[]): LibraryStatus {
    if (statuses.some((status) => status === "typeChanged")) return "typeChanged";
    if (statuses.some((status) => status === "modified")) return "modified";
    const hasAdded = statuses.some((status) => status === "added");
    const hasRemoved = statuses.some((status) => status === "removed");
    if (hasAdded && hasRemoved) return "modified";
    if (hasAdded) return "added";
    if (hasRemoved) return "removed";
    return "same";
  }

  async function buildLibraryManagerPayload(): Promise<LibraryPayload> {
    const dedupeSkills = (skills: SkillFile[]): SkillFile[] => {
      const dedup = new Map<string, SkillFile>();
      for (const item of skills) {
        if (!item || !isManagedSkillPath(item.relativePath)) continue;
        dedup.set(`${item.tool}:${normalizeRel(item.relativePath)}`, {
          ...item,
          relativePath: normalizeRel(item.relativePath)
        });
      }
      return [...dedup.values()].sort((a, b) => a.tool.localeCompare(b.tool) || a.relativePath.localeCompare(b.relativePath));
    };
    const dedupeValidSkills = (skills: SkillFile[]): SkillFile[] =>
      enforceSkillMdInventory(dedupeSkills(skills)).validFiles;
    const snapshotFromTree = (
      side: "workspace" | "central",
      basePath: string
    ): SkillFile[] => {
      const provider = side === "workspace" ? workspaceProvider : centralProvider;
      const skills = provider.getAllSelections()
        .filter((item) => isManagedSkillPath(item.relativePath))
        .map((item) => {
          const normalizedRel = normalizeRel(item.relativePath);
          const roots = getSkillRootCandidates(basePath, item.tool, side);
          const foundRoot = roots.find((root) => existsSync(path.join(root, normalizedRel))) ?? roots[0];
          return {
            tool: item.tool,
            relativePath: normalizedRel,
            absolutePath: path.join(foundRoot, normalizedRel)
          } satisfies SkillFile;
        });
      return dedupeSkills(skills);
    };

    let workspaceSkills = dedupeValidSkills([
      ...state.workspaceSkills,
      ...snapshotFromTree("workspace", state.workspacePath)
    ]);
    let centralSkills = dedupeValidSkills([
      ...state.centralSkills,
      ...snapshotFromTree("central", state.centralRepoPath)
    ]);

    if (workspaceSkills.length === 0 || centralSkills.length === 0) {
      const [workspaceScan, centralScan] = await Promise.all([
        workspaceSkills.length === 0 ? scanSkills(state.workspacePath, "workspace", state.agents) : Promise.resolve<SkillFile[]>([]),
        centralSkills.length === 0 ? scanSkills(state.centralRepoPath, "central", state.agents) : Promise.resolve<SkillFile[]>([])
      ]);
      if (workspaceScan.length > 0) {
        workspaceSkills = dedupeValidSkills([...workspaceSkills, ...workspaceScan]);
        state.workspaceSkills = dedupeValidSkills([...state.workspaceSkills, ...workspaceScan]);
      }
      if (centralScan.length > 0) {
        centralSkills = dedupeValidSkills([...centralSkills, ...centralScan]);
        state.centralSkills = dedupeValidSkills([...state.centralSkills, ...centralScan]);
      }
    }

    if (workspaceSkills.length === 0 || centralSkills.length === 0) {
      output.appendLine(`[LibraryManager] payload snapshot warning: workspace=${workspaceSkills.length}, central=${centralSkills.length}, stateWorkspace=${state.workspaceSkills.length}, stateCentral=${state.centralSkills.length}`);
    }

    const workspaceMap = new Map<string, SkillFile>(
      workspaceSkills.map((item) => [`${item.tool}:${item.relativePath}`, item] as const)
    );
    const centralMap = new Map<string, SkillFile>(
      centralSkills.map((item) => [`${item.tool}:${item.relativePath}`, item] as const)
    );
    const allKeys = new Set<string>([...workspaceMap.keys(), ...centralMap.keys()]);
    const statCache = new Map<string, Awaited<ReturnType<typeof fs.stat>> | null>();
    const equalCache = new Map<string, boolean>();

    const statOf = async (targetPath: string): Promise<Awaited<ReturnType<typeof fs.stat>> | null> => {
      if (statCache.has(targetPath)) return statCache.get(targetPath) ?? null;
      const stat = await fs.stat(targetPath).catch(() => null);
      statCache.set(targetPath, stat);
      return stat;
    };
    const filesEqual = async (leftPath: string, rightPath: string): Promise<boolean> => {
      const cacheKey = `${leftPath}::${rightPath}`;
      const reverseKey = `${rightPath}::${leftPath}`;
      if (equalCache.has(cacheKey)) return equalCache.get(cacheKey) ?? false;
      if (equalCache.has(reverseKey)) return equalCache.get(reverseKey) ?? false;
      const [leftStat, rightStat] = await Promise.all([statOf(leftPath), statOf(rightPath)]);
      if (!leftStat || !rightStat || !leftStat.isFile() || !rightStat.isFile()) {
        equalCache.set(cacheKey, false);
        return false;
      }
      const same = await isSameFileContent(leftPath, rightPath, Number(leftStat.size), Number(rightStat.size));
      equalCache.set(cacheKey, same);
      return same;
    };

    const buildSide = async (side: "workspace" | "central"): Promise<LibrarySideView> => {
      const sideMap = side === "workspace" ? workspaceMap : centralMap;
      const otherMap = side === "workspace" ? centralMap : workspaceMap;
      const sideGroups = state.groups.filter((group) => group.side === side);
      const mode = side === "workspace" ? "workspace" : "central";
      const basePath = side === "workspace" ? state.workspacePath : state.centralRepoPath;
      const entries: LibraryEntry[] = [];

      for (const key of allKeys) {
        const parsed = splitLibraryKey(key);
        if (!parsed) continue;
        const { tool, relativePath } = parsed;
        if (!isManagedSkillPath(relativePath)) continue;
        const folder = getTopSkillFolder(relativePath);
        if (!folder) continue;
        const sideFile = sideMap.get(key);
        const otherFile = otherMap.get(key);
        const expectedSidePath = resolveSkillPath(basePath, tool, relativePath, mode);

        let status: LibraryStatus = "same";
        if (sideFile && !otherFile) {
          const otherMode = side === "workspace" ? "central" : "workspace";
          const otherBase = side === "workspace" ? state.centralRepoPath : state.workspacePath;
          const otherExpectedPath = resolveSkillPath(otherBase, tool, relativePath, otherMode);
          const otherExpectedStat = await statOf(otherExpectedPath);
          status = otherExpectedStat?.isDirectory() ? "typeChanged" : "added";
        } else if (!sideFile && otherFile) {
          const sideExpectedStat = await statOf(expectedSidePath);
          status = sideExpectedStat?.isDirectory() ? "typeChanged" : "removed";
        } else if (sideFile && otherFile) {
          status = await filesEqual(sideFile.absolutePath, otherFile.absolutePath) ? "same" : "modified";
        }

        const matchingGroups = sideGroups
          .filter((group) => group.targets.some((target) => entryMatchesTarget(tool, relativePath, target)));
        entries.push({
          key,
          tool,
          relativePath,
          folder,
          innerPath: getSkillInnerPath(relativePath, folder),
          exists: !!sideFile,
          status,
          groupIds: matchingGroups.map((group) => group.id),
          groupNames: matchingGroups.map((group) => group.name)
        });
      }

      entries.sort((a, b) => a.tool.localeCompare(b.tool) || a.relativePath.localeCompare(b.relativePath));
      const groups: LibraryGroupView[] = sideGroups
        .map((group) => ({
          id: group.id,
          name: group.name,
          targetSummary: summarizeGroupTargets(group.targets),
          targetCount: group.targets.length,
          tools: [...new Set(group.targets.map((target) => target.tool))].sort((a, b) => a.localeCompare(b))
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { entries, groups };
    };

    const [workspace, central] = await Promise.all([buildSide("workspace"), buildSide("central")]);
    const discoveredTools = [...new Set<ToolType>([
      ...workspaceSkills.map((entry) => entry.tool),
      ...centralSkills.map((entry) => entry.tool),
      ...workspace.entries.map((entry) => entry.tool),
      ...central.entries.map((entry) => entry.tool),
      ...state.groups.flatMap((group) => group.targets.map((target) => target.tool))
    ])].sort((a, b) => a.localeCompare(b));
    const tools = state.agents.filter((tool) => discoveredTools.includes(tool));
    return {
      tools,
      workspace,
      central,
      diagnostics: {
        workspaceMissingSkillFolders: state.workspaceMissingSkillFolders,
        centralMissingSkillFolders: state.centralMissingSkillFolders
      }
    };
  }

  async function openLibraryDiff(
    sourceSide: "workspace" | "central",
    tool: ToolType,
    relativePath: string,
    kind: "file" | "folder"
  ): Promise<void> {
    const scopeHints: TransferScopeHint[] = [{ tool, relativePath, kind }];
    const plan = await buildTransferPlan(sourceSide, [], { scopeHints });
    if (kind === "file") {
      const item = plan.items.find((entry) => entry.tool === tool && entry.relativePath === relativePath);
      if (!item) {
        vscode.window.showWarningMessage("Diff 대상을 찾지 못했습니다.");
        return;
      }
      await openTransferDiff(item);
      return;
    }

    const targets = plan.items.filter((entry) =>
      entry.tool === tool && (entry.relativePath === relativePath || entry.relativePath.startsWith(`${relativePath}/`))
    );
    if (targets.length === 0) {
      vscode.window.showWarningMessage("폴더 요약 Diff 대상을 찾지 못했습니다.");
      return;
    }
    const summaryPanel = vscode.window.createWebviewPanel(
      "skillBridgeFolderDiffSummaryFromLibrary",
      `Diff Summary: ${tool}/${relativePath}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: false }
    );
    summaryPanel.webview.html = renderFolderDiffSummaryHtml(summaryPanel.webview, {
      mode: sourceSide === "workspace" ? "workspaceToCentral" : "centralToWorkspace",
      tool,
      relativePath,
      rows: buildFolderDiffSummaryRows(targets, sourceSide === "workspace" ? "workspaceToCentral" : "centralToWorkspace")
    });
    summaryPanel.webview.onDidReceiveMessage(async (subMsg: unknown) => {
      if (!subMsg || typeof subMsg !== "object") return;
      const inner = subMsg as { type?: string; payload?: unknown };
      if (inner.type !== "openDiff") return;
      const key = String((inner.payload as { key?: string } | undefined)?.key ?? "");
      const target = targets.find((entry) => entry.key === key);
      if (!target) return;
      await openTransferDiff(target);
    });
  }

  async function createGroupFromLibrary(
    side: "workspace" | "central",
    name: string,
    target: { tool: ToolType; relativePath: string; kind: "file" | "folder" }
  ): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("그룹 이름을 입력하세요.");
    const normalized = toSkillFolderTarget(target.tool, target.relativePath);
    if (!normalized) throw new Error("유효한 스킬 폴더를 선택하세요.");
    if (!targetExistsInFiles(normalized, getSideSkillFiles(side))) {
      throw new Error("SKILL.md가 있는 유효 스킬만 그룹에 추가할 수 있습니다.");
    }
    const group: SelectionGroup = {
      id: `${side}-${Date.now()}`,
      name: trimmed,
      side,
      targets: [normalized],
      meta: { source: "manual" }
    };
    await persistGroups([...state.groups, group], group.id);
  }

  function normalizeLibraryGroupTargets(
    side: "workspace" | "central",
    targets: Array<{ tool: ToolType; relativePath: string; kind: "file" | "folder" }>
  ): { valid: GroupTarget[]; invalidCount: number } {
    const files = getSideSkillFiles(side);
    const normalized = targets
      .map((target) => toSkillFolderTarget(target.tool, target.relativePath))
      .filter((target): target is GroupTarget => !!target);
    const valid = dedupeGroupTargets(normalized.filter((target) => targetExistsInFiles(target, files)));
    const invalidCount = Math.max(0, targets.length - valid.length);
    return { valid, invalidCount };
  }

  async function createGroupFromLibraryMany(
    side: "workspace" | "central",
    name: string,
    targets: Array<{ tool: ToolType; relativePath: string; kind: "file" | "folder" }>
  ): Promise<{ addedCount: number; skippedCount: number; tool: ToolType }> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("그룹 이름을 입력하세요.");
    const { valid, invalidCount } = normalizeLibraryGroupTargets(side, targets);
    if (valid.length === 0) {
      throw new Error("SKILL.md가 있는 유효 스킬만 그룹에 추가할 수 있습니다.");
    }
    const baseTool = valid[0].tool;
    const sameToolTargets = valid.filter((target) => target.tool === baseTool);
    if (sameToolTargets.length === 0) {
      throw new Error("같은 에이전트 스킬만 그룹으로 만들 수 있습니다.");
    }
    ensureUniqueGroupNameForTool(side, baseTool, trimmed);
    const group: SelectionGroup = {
      id: `${side}-${Date.now()}`,
      name: trimmed,
      side,
      targets: sameToolTargets,
      meta: { source: "manual" }
    };
    await persistGroups([...state.groups, group], group.id);
    return {
      addedCount: sameToolTargets.length,
      skippedCount: invalidCount + (valid.length - sameToolTargets.length),
      tool: baseTool
    };
  }

  async function assignTargetToGroup(
    side: "workspace" | "central",
    groupId: string,
    target: { tool: ToolType; relativePath: string; kind: "file" | "folder" }
  ): Promise<void> {
    const group = state.groups.find((item) => item.id === groupId && item.side === side);
    if (!group) throw new Error("할당할 그룹을 찾지 못했습니다.");
    const normalized = toSkillFolderTarget(target.tool, target.relativePath);
    if (!normalized) throw new Error("유효한 스킬 폴더를 선택하세요.");
    if (!targetExistsInFiles(normalized, getSideSkillFiles(side))) {
      throw new Error("SKILL.md가 있는 유효 스킬만 그룹에 할당할 수 있습니다.");
    }
    if (group.targets.length > 0 && group.targets[0].tool !== normalized.tool) {
      throw new Error(`그룹은 같은 에이전트(${group.targets[0].tool}) 스킬만 담을 수 있습니다.`);
    }
    const nextTargets = dedupeGroupTargets([...group.targets, normalized]);
    const nextGroups = state.groups.map((item) => item.id === group.id ? { ...item, targets: nextTargets } : item);
    await persistGroups(nextGroups, group.id);
  }

  async function unassignTargetFromGroup(
    side: "workspace" | "central",
    groupId: string,
    target: { tool: ToolType; relativePath: string; kind: "file" | "folder" }
  ): Promise<void> {
    const group = state.groups.find((item) => item.id === groupId && item.side === side);
    if (!group) throw new Error("해제할 그룹을 찾지 못했습니다.");
    const normalized = toSkillFolderTarget(target.tool, target.relativePath);
    if (!normalized) throw new Error("유효한 스킬 폴더를 선택하세요.");
    const nextTargets = group.targets.filter((item) =>
      !(item.tool === normalized.tool && normalizeRel(item.relativePath) === normalizeRel(normalized.relativePath))
    );
    if (nextTargets.length === 0) {
      throw new Error("그룹이 비게 됩니다. 필요하면 그룹 삭제를 사용하세요.");
    }
    const nextGroups = state.groups.map((item) => item.id === group.id ? { ...item, targets: nextTargets } : item);
    await persistGroups(nextGroups, group.id);
  }

  async function assignTargetsToGroupMany(
    side: "workspace" | "central",
    groupId: string,
    targets: Array<{ tool: ToolType; relativePath: string; kind: "file" | "folder" }>
  ): Promise<{ affectedCount: number; skippedCount: number }> {
    const group = state.groups.find((item) => item.id === groupId && item.side === side);
    if (!group) throw new Error("할당할 그룹을 찾지 못했습니다.");
    const { valid, invalidCount } = normalizeLibraryGroupTargets(side, targets);
    if (valid.length === 0) throw new Error("SKILL.md가 있는 유효 스킬만 그룹에 할당할 수 있습니다.");
    const groupTool = group.targets[0]?.tool ?? valid[0].tool;
    const sameToolTargets = valid.filter((target) => target.tool === groupTool);
    if (sameToolTargets.length === 0) {
      throw new Error(`그룹은 같은 에이전트(${groupTool}) 스킬만 담을 수 있습니다.`);
    }
    const beforeCount = group.targets.length;
    const nextTargets = dedupeGroupTargets([...group.targets, ...sameToolTargets]);
    const nextGroups = state.groups.map((item) => item.id === group.id ? { ...item, targets: nextTargets } : item);
    await persistGroups(nextGroups, group.id);
    return {
      affectedCount: Math.max(0, nextTargets.length - beforeCount),
      skippedCount: invalidCount + (valid.length - sameToolTargets.length)
    };
  }

  async function unassignTargetsFromGroupMany(
    side: "workspace" | "central",
    groupId: string,
    targets: Array<{ tool: ToolType; relativePath: string; kind: "file" | "folder" }>
  ): Promise<{ affectedCount: number; skippedCount: number }> {
    const group = state.groups.find((item) => item.id === groupId && item.side === side);
    if (!group) throw new Error("해제할 그룹을 찾지 못했습니다.");
    const normalized = dedupeGroupTargets(
      targets
        .map((target) => toSkillFolderTarget(target.tool, target.relativePath))
        .filter((target): target is GroupTarget => !!target)
    );
    if (normalized.length === 0) throw new Error("유효한 스킬 폴더를 선택하세요.");
    const toRemove = new Set(normalized.map((target) => `${target.tool}:${normalizeRel(target.relativePath)}`));
    const beforeCount = group.targets.length;
    const nextTargets = group.targets.filter((target) => !toRemove.has(`${target.tool}:${normalizeRel(target.relativePath)}`));
    if (nextTargets.length === 0) {
      throw new Error("그룹이 비게 됩니다. 필요하면 그룹 삭제를 사용하세요.");
    }
    const removedCount = Math.max(0, beforeCount - nextTargets.length);
    const nextGroups = state.groups.map((item) => item.id === group.id ? { ...item, targets: nextTargets } : item);
    await persistGroups(nextGroups, group.id);
    return {
      affectedCount: removedCount,
      skippedCount: Math.max(0, normalized.length - removedCount)
    };
  }

  async function openLibraryManagerPanel(): Promise<void> {
    await refresh();
    const panel = vscode.window.createWebviewPanel(
      "skillBridgeLibraryManager",
      "Skill Library Manager",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    const postUi = (payload: { busy?: boolean; message?: string; tone?: "info" | "warn" | "error" }): void => {
      panel.webview.postMessage({ type: "ui", payload });
    };
    const postState = async (): Promise<void> => {
      const payload = await buildLibraryManagerPayload();
      output.appendLine(`[LibraryManager] postState workspace=${payload.workspace.entries.length}, central=${payload.central.entries.length}, tools=${payload.tools.join(",")}`);
      panel.webview.postMessage({ type: "state", payload });
    };

    const initialPayload = await buildLibraryManagerPayload();
    panel.webview.html = renderLibraryManagerHtml(panel.webview, initialPayload);
    let clientReady = false;
    const bootTimeout = setTimeout(() => {
      if (clientReady) return;
      output.appendLine("[LibraryManager] webview clientReady timeout (2s) - script init may have failed.");
      vscode.window.setStatusBarMessage("Skill Bridge: Library Manager 화면 초기화 지연", 2500);
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
          output.appendLine(`[LibraryManager] client ready (workspace=${payload.workspace.entries.length}, central=${payload.central.entries.length}, tools=${payload.tools.join(",")})`);
          panel.webview.postMessage({ type: "state", payload });
          return;
        }
        if (message.type === "clientError") {
          const payload = (message.payload as { message?: string; stack?: string } | undefined) ?? {};
          const errorMessage = String(payload.message ?? "알 수 없는 오류");
          const stack = String(payload.stack ?? "").trim();
          output.appendLine(`[LibraryManager] client error: ${errorMessage}`);
          if (stack) output.appendLine(stack);
          vscode.window.showErrorMessage(`Library Manager 화면 오류: ${errorMessage}`);
          return;
        }
        if (message.type === "refresh") {
          postUi({ busy: true, message: "목록을 새로고침하는 중...", tone: "info" });
          await refresh();
          await postState();
          postUi({ busy: false, message: "목록이 최신 상태로 갱신되었습니다.", tone: "info" });
          return;
        }
        if (message.type === "setGroupingMode") {
          return;
        }
        if (message.type === "movePath") {
          const payload = (message.payload as { sourceSide?: string; tool?: string; relativePath?: string; kind?: string } | undefined) ?? {};
          const sourceSide = payload.sourceSide === "central" ? "central" : "workspace";
          const tool = isToolType(String(payload.tool ?? "")) ? String(payload.tool ?? "") as ToolType : null;
          const relativePath = normalizeRel(String(payload.relativePath ?? ""));
          const kind = payload.kind === "file" ? "file" : "folder";
          if (!tool || !relativePath) return;
          postUi({ busy: true, message: `${kind === "file" ? "파일" : "폴더"} 전송 중: ${tool}/${relativePath}`, tone: "info" });
          await transferPathFromExplorer(sourceSide, tool, relativePath, kind);
          await postState();
          postUi({ busy: false, message: `${kind === "file" ? "파일" : "폴더"} 전송 완료: ${tool}/${relativePath}`, tone: "info" });
          return;
        }
        if (message.type === "moveSelected") {
          const payload = (message.payload as {
            sourceSide?: string;
            targets?: Array<{ tool?: string; relativePath?: string; kind?: string }>;
          } | undefined) ?? {};
          const sourceSide = payload.sourceSide === "central" ? "central" : "workspace";
          const targets = (Array.isArray(payload.targets) ? payload.targets : [])
            .map((target) => {
              const tool = isToolType(String(target?.tool ?? "")) ? String(target?.tool ?? "") as ToolType : null;
              const relativePath = normalizeRel(String(target?.relativePath ?? ""));
              const kind = target?.kind === "file" ? "file" : "folder";
              if (!tool || !relativePath) return null;
              return { tool, relativePath, kind } as const;
            })
            .filter((target): target is { tool: ToolType; relativePath: string; kind: "file" | "folder" } => !!target);
          if (targets.length === 0) throw new Error("일괄 이동할 항목이 없습니다.");
          postUi({ busy: true, message: `선택 항목 일괄 전송 중... (${targets.length}개)`, tone: "info" });
          const summary = await transferSelectedPathsFromLibrary(sourceSide, targets);
          await postState();
          const groupSuffix = summary.mirroredGroups > 0 ? ` · 그룹 동기화 ${summary.mirroredGroups}` : "";
          postUi({
            busy: false,
            message: `선택 이동 완료: 요청 ${summary.requested}개 · 반영 ${summary.processed}개 · 복사 ${summary.copied} · 삭제 ${summary.deleted} · 제외 ${summary.skipped}${groupSuffix}`,
            tone: "info"
          });
          return;
        }
        if (message.type === "moveGroup") {
          const payload = (message.payload as {
            sourceSide?: string;
            groupId?: string;
            groupIds?: string[];
          } | undefined) ?? {};
          const sourceSide = payload.sourceSide === "central" ? "central" : "workspace";
          const sideGroups = state.groups
            .filter((group) => group.side === sourceSide)
            .sort((a, b) => a.name.localeCompare(b.name));
          if (sideGroups.length === 0) {
            throw new Error("이동할 그룹이 없습니다.");
          }

          const requestedIds = [
            ...(Array.isArray(payload.groupIds) ? payload.groupIds : []),
            ...(payload.groupId ? [payload.groupId] : [])
          ].map((id) => String(id)).filter(Boolean);

          let pickedGroups: SelectionGroup[] = sideGroups.filter((group) => requestedIds.includes(group.id));
          if (pickedGroups.length === 0) {
            const picked = await vscode.window.showQuickPick(
              sideGroups.map((group) => ({
                label: group.name,
                description: `${group.targets[0]?.tool ?? "-"} · 스킬 ${group.targets.length}`,
                value: group.id
              })),
              {
                canPickMany: true,
                title: sourceSide === "workspace" ? "Workspace → Central 그룹 이동" : "Central → Workspace 그룹 이동",
                placeHolder: "이동할 그룹을 하나 이상 선택하세요."
              }
            );
            if (!picked || picked.length === 0) return;
            const pickedIds = new Set(picked.map((item) => item.value));
            pickedGroups = sideGroups.filter((group) => pickedIds.has(group.id));
          }
          if (pickedGroups.length === 0) return;

          const directionLabel = sourceSide === "workspace" ? "Workspace → Central" : "Central → Workspace";
          const ok = await vscode.window.showWarningMessage(
            `선택한 그룹 ${pickedGroups.length}개를 ${directionLabel}로 이동할까요?`,
            { modal: true },
            "진행"
          );
          if (ok !== "진행") return;

          postUi({ busy: true, message: `그룹 일괄 이동 중... (${pickedGroups.length}개)`, tone: "info" });
          let copied = 0;
          let deleted = 0;
          let unchanged = 0;
          let movedGroups = 0;
          for (const group of pickedGroups) {
            const result = await exportGroup(sourceSide, group, {
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

          await refresh();
          await postState();
          postUi({
            busy: false,
            message: `그룹 이동 완료: 요청 ${pickedGroups.length}개 · 반영 ${movedGroups}개 · 복사 ${copied} · 삭제 ${deleted} · 변경없음 ${unchanged}`,
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
          const payload = (message.payload as {
            side?: string;
            name?: string;
            suggest?: string;
            tool?: string;
            relativePath?: string;
            kind?: string;
            targets?: Array<{ tool?: string; relativePath?: string; kind?: string }>;
          } | undefined) ?? {};
          const side = payload.side === "central" ? "central" : "workspace";
          const rawTargets = Array.isArray(payload.targets) ? payload.targets : [];
          const targets = rawTargets
            .map((target) => {
              const tool = isToolType(String(target?.tool ?? "")) ? String(target?.tool ?? "") as ToolType : null;
              const relativePath = normalizeRel(String(target?.relativePath ?? ""));
              const kind = target?.kind === "file" ? "file" : "folder";
              if (!tool || !relativePath) return null;
              return { tool, relativePath, kind } as const;
            })
            .filter((target): target is { tool: ToolType; relativePath: string; kind: "file" | "folder" } => !!target);
          if (targets.length === 0) {
            const tool = isToolType(String(payload.tool ?? "")) ? String(payload.tool ?? "") as ToolType : null;
            const relativePath = normalizeRel(String(payload.relativePath ?? ""));
            const kind = payload.kind === "file" ? "file" : "folder";
            if (!tool || !relativePath) throw new Error("그룹 생성 대상(파일/폴더)을 먼저 선택하세요.");
            targets.push({ tool, relativePath, kind });
          }
          const suggestName = payload.name ? String(payload.name) : (payload.suggest ? String(payload.suggest) : "새 그룹");
          const inputName = await vscode.window.showInputBox({ prompt: "새 그룹 이름을 입력하세요", value: suggestName, ignoreFocusOut: true });
          if (!inputName || !inputName.trim()) return;
          const name = inputName.trim();
          const created = await createGroupFromLibraryMany(side, name, targets);
          await postState();
          const suffix = created.skippedCount > 0 ? ` (제외 ${created.skippedCount}개)` : "";
          postUi({ busy: false, message: `그룹 생성 완료: ${created.addedCount}개 스킬${suffix}`, tone: "info" });
          return;
        }
        if (message.type === "groupAssign" || message.type === "groupUnassign") {
          const payload = (message.payload as {
            side?: string;
            groupId?: string;
            groupIds?: string[];
            tool?: string;
            relativePath?: string;
            kind?: string;
            targets?: Array<{ tool?: string; relativePath?: string; kind?: string }>;
          } | undefined) ?? {};
          const side = payload.side === "central" ? "central" : "workspace";
          let groupIds = Array.isArray(payload.groupIds) ? payload.groupIds.map((id) => String(id)).filter(Boolean) : [];
          if (groupIds.length === 0 && payload.groupId) groupIds.push(String(payload.groupId));
          const rawTargets = Array.isArray(payload.targets) ? payload.targets : [];
          const targets = rawTargets
            .map((target) => {
              const tool = isToolType(String(target?.tool ?? "")) ? String(target?.tool ?? "") as ToolType : null;
              const relativePath = normalizeRel(String(target?.relativePath ?? ""));
              const kind = target?.kind === "file" ? "file" : "folder";
              if (!tool || !relativePath) return null;
              return { tool, relativePath, kind } as const;
            })
            .filter((target): target is { tool: ToolType; relativePath: string; kind: "file" | "folder" } => !!target);
          if (targets.length === 0) {
            const tool = isToolType(String(payload.tool ?? "")) ? String(payload.tool ?? "") as ToolType : null;
            const relativePath = normalizeRel(String(payload.relativePath ?? ""));
            const kind = payload.kind === "file" ? "file" : "folder";
            if (!tool || !relativePath) throw new Error("대상(파일/폴더)을 먼저 선택하세요.");
            targets.push({ tool, relativePath, kind });
          }
          if (groupIds.length === 0) {
            const selectedTools = [...new Set<ToolType>(targets.map((target) => target.tool))];
            if (selectedTools.length > 1) {
              throw new Error("여러 에이전트가 함께 선택되었습니다. 같은 에이전트 스킬만 선택 후 다시 시도하세요.");
            }
            const selectedTool = selectedTools[0];
            const candidateGroups = state.groups
              .filter((group) => group.side === side)
              .filter((group) => {
                const groupTool = group.targets[0]?.tool;
                return !!groupTool && groupTool === selectedTool;
              })
              .sort((a, b) => a.name.localeCompare(b.name));
            if (candidateGroups.length === 0) throw new Error("선택 가능한 그룹이 없습니다. 먼저 그룹을 생성하세요.");
            const picked = await vscode.window.showQuickPick(
              candidateGroups.map((group) => ({
                label: group.name,
                description: `${group.targets[0]?.tool ?? "-"} · 스킬 ${group.targets.length}`,
                value: group.id
              })),
              {
                canPickMany: true,
                title: message.type === "groupAssign" ? "할당할 그룹 선택" : "해제할 그룹 선택",
                placeHolder: `${selectedTool} 그룹만 표시됩니다.`
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
          const baseLabel = message.type === "groupAssign" ? "그룹 할당 완료" : "그룹 해제 완료";
          const suffix = skippedTotal > 0 ? ` · 제외 ${skippedTotal}개` : "";
          postUi({ busy: false, message: `${baseLabel}: 반영 ${affectedTotal}개${suffix}`, tone: "info" });
          await postState();
          return;
        }
      } catch (error) {
        postUi({ busy: false, message: toUserError(error), tone: "error" });
        vscode.window.showErrorMessage(toUserError(error));
      }
    });
  }

  function resolveGroup(node?: unknown): SelectionGroup | undefined {
    const extractGroupId = (value: unknown): string | null => {
      if (!value || typeof value !== "object") return null;
      const record = value as Record<string, unknown>;
      if (record.kind === "group") {
        if (typeof record.id === "string" && record.id.trim()) return record.id;
        if (typeof record.groupId === "string" && record.groupId.trim()) return record.groupId;
      }
      if (record.node && typeof record.node === "object") {
        return extractGroupId(record.node);
      }
      return null;
    };
    const targetId = extractGroupId(node) ?? state.selectedGroupId;
    if (!targetId) return undefined;
    return state.groups.find((item) => item.id === targetId);
  }

  function getSelectedNodes(side: TreeSide): SkillTreeNode[] {
    return side === "workspace" ? state.workspaceSelection : state.centralSelection;
  }

  async function persistGroups(
    next: SelectionGroup[],
    selectedGroupId: string | null,
    options?: { skipExistenceValidation?: boolean }
  ): Promise<void> {
    const normalized = normalizeGroupsForCurrentSkills(next, options);
    state.groups = normalized.groups;
    state.selectedGroupId = selectedGroupId && state.groups.some((item) => item.id === selectedGroupId)
      ? selectedGroupId
      : null;
    if (normalized.changed) {
      output.appendLine(`[GroupNormalize] persist 시 정규화 적용 - split=${normalized.splitCount}, removedTargets=${normalized.removedTargetCount}, removedGroups=${normalized.removedGroupCount}`);
    }
    await saveWorkspaceGroups(state.workspacePath, state.groups);
    workspaceProvider.setGroups(state.groups);
    centralProvider.setGroups(state.groups);
    workspaceProvider.setSelectedGroup(state.selectedGroupId);
    centralProvider.setSelectedGroup(state.selectedGroupId);
    const selected = state.selectedGroupId
      ? state.groups.find((item) => item.id === state.selectedGroupId)
      : undefined;
    if (selected) {
      applyGroupHighlight(state, selected, workspaceProvider, centralProvider);
    } else {
      workspaceProvider.setHighlight(new Set());
      centralProvider.setHighlight(new Set());
    }
  }

  async function mirrorSelectedGroupAfterTransfer(sourceSide: TreeSide): Promise<boolean> {
    if (!state.selectedGroupId) return false;
    const group = state.groups.find((item) => item.id === state.selectedGroupId && item.side === sourceSide);
    if (!group) return false;
    await mirrorGroupToOtherSide(group);
    return true;
  }

  async function mirrorGroupToOtherSide(sourceGroup: SelectionGroup): Promise<void> {
    const targetSide: TreeSide = sourceGroup.side === "workspace" ? "central" : "workspace";
    const mirrorKey = `${sourceGroup.side}:${sourceGroup.id}`;
    const now = new Date().toISOString();
    const sourceTool = getGroupTool(sourceGroup);
    const existing = state.groups.find((group) =>
      group.side === targetSide
      && (
        group.meta?.mirroredFrom === mirrorKey
        || (
          group.name === sourceGroup.name
          && (!!sourceTool && getGroupTool(group) === sourceTool)
        )
      )
    );

    const normalizedTargets = dedupeGroupTargets(sourceGroup.targets.filter((target) => isManagedSkillPath(target.relativePath)));
    const nextMeta = {
      ...sourceGroup.meta,
      source: sourceGroup.meta?.source ?? "manual",
      mirroredFrom: mirrorKey,
      lastInstalledAt: sourceGroup.meta?.source === "npx" ? now : sourceGroup.meta?.lastInstalledAt
    } as SelectionGroup["meta"];

    const mirrored: SelectionGroup = {
      ...sourceGroup,
      id: existing?.id ?? `${targetSide}-${Date.now()}`,
      side: targetSide,
      targets: normalizedTargets,
      meta: nextMeta
    };

    const nextGroups = existing
      ? state.groups.map((group) => (group.id === existing.id ? mirrored : group))
      : [...state.groups, mirrored];
    await persistGroups(nextGroups, state.selectedGroupId, { skipExistenceValidation: true });
  }

  async function mirrorGroupsForTransferredTargets(
    sourceSide: "workspace" | "central",
    scopeHints: TransferScopeHint[]
  ): Promise<number> {
    const normalizedTargets = dedupeGroupTargets(
      scopeHints
        .map((hint) => toSkillFolderTarget(hint.tool, hint.relativePath))
        .filter((target): target is GroupTarget => !!target)
    );
    if (normalizedTargets.length === 0) return 0;

    const targetSide: TreeSide = sourceSide === "workspace" ? "central" : "workspace";
    const movedKeys = new Set(normalizedTargets.map((target) => `${target.tool}:${normalizeRel(target.relativePath)}`));
    const sourceGroups = state.groups
      .filter((group) => group.side === sourceSide)
      .filter((group) => group.targets.some((target) => movedKeys.has(`${target.tool}:${normalizeRel(target.relativePath)}`)));
    if (sourceGroups.length === 0) return 0;

    const nextGroups = [...state.groups];
    let changed = 0;
    for (const sourceGroup of sourceGroups) {
      const sourceTool = getGroupTool(sourceGroup);
      const mirrorKey = `${sourceGroup.side}:${sourceGroup.id}`;
      const matchedTargets = dedupeGroupTargets(
        sourceGroup.targets.filter((target) => movedKeys.has(`${target.tool}:${normalizeRel(target.relativePath)}`))
      );
      if (matchedTargets.length === 0) continue;

      const existing = nextGroups.find((group) =>
        group.side === targetSide
        && (
          group.meta?.mirroredFrom === mirrorKey
          || (
            group.name === sourceGroup.name
            && (!!sourceTool && getGroupTool(group) === sourceTool)
          )
        )
      );

      if (existing) {
        const mergedTargets = dedupeGroupTargets([...existing.targets, ...matchedTargets]);
        if (mergedTargets.length === existing.targets.length) continue;
        const index = nextGroups.findIndex((group) => group.id === existing.id);
        if (index >= 0) {
          nextGroups[index] = { ...existing, targets: mergedTargets };
          changed += 1;
        }
        continue;
      }

      const now = new Date().toISOString();
      nextGroups.push({
        ...sourceGroup,
        id: `${targetSide}-${Date.now()}-${changed}`,
        side: targetSide,
        targets: matchedTargets,
        meta: {
          ...sourceGroup.meta,
          source: sourceGroup.meta?.source ?? "manual",
          mirroredFrom: mirrorKey,
          lastInstalledAt: sourceGroup.meta?.source === "npx" ? now : sourceGroup.meta?.lastInstalledAt
        }
      });
      changed += 1;
    }

    if (changed === 0) return 0;
    await persistGroups(nextGroups, state.selectedGroupId, { skipExistenceValidation: true });
    return changed;
  }

  async function renameGroup(node?: GroupTreeNode): Promise<void> {
    try {
      if (!state.workspacePath) await refresh();
      const group = resolveGroup(node);
      if (!group) {
        vscode.window.showWarningMessage("이름을 바꿀 그룹을 선택하세요.");
        return;
      }
      const nextName = await vscode.window.showInputBox({
        title: "그룹 이름 변경",
        prompt: "새 그룹 이름을 입력하세요",
        value: group.name
      });
      if (!nextName?.trim()) return;
      if (nextName.trim() === group.name) return;
      const groupTool = getGroupTool(group);
      if (!groupTool) {
        throw new Error("그룹 에이전트 정보를 찾을 수 없습니다.");
      }
      ensureUniqueGroupNameForTool(group.side, groupTool, nextName.trim(), group.id);
      const nextGroups = state.groups.map((item) => item.id === group.id ? { ...item, name: nextName.trim() } : item);
      await persistGroups(nextGroups, group.id);
      vscode.window.showInformationMessage(`그룹 이름 변경 완료: ${nextName.trim()}`);
    } catch (error) {
      vscode.window.showErrorMessage(toUserError(error));
    }
  }

  async function mutateGroupTargets(group: SelectionGroup, mode: GroupMutationMode): Promise<void> {
    const nodes = getSelectedNodes(group.side);
    if (nodes.length === 0) {
      vscode.window.showWarningMessage("먼저 같은 사이드 트리에서 항목을 선택하세요.");
      return;
    }
    const selectedTargets = buildGroupTargetsFromNodes(nodes);
    if (selectedTargets.length === 0) {
      vscode.window.showWarningMessage("SKILL.md가 있는 유효 스킬만 그룹에 반영할 수 있습니다.");
      return;
    }

    const groupTool = group.targets[0]?.tool;
    const sameToolTargets = groupTool
      ? selectedTargets.filter((target) => target.tool === groupTool)
      : selectedTargets;
    if (sameToolTargets.length === 0) {
      vscode.window.showWarningMessage(`그룹은 같은 에이전트(${groupTool}) 스킬만 반영할 수 있습니다.`);
      return;
    }
    if (sameToolTargets.length !== selectedTargets.length) {
      vscode.window.showInformationMessage(`다른 에이전트 선택 ${selectedTargets.length - sameToolTargets.length}개는 제외하고 ${groupTool} 스킬만 반영합니다.`);
    }

    let nextTargets: GroupTarget[] = group.targets;
    if (mode === "append") {
      nextTargets = dedupeGroupTargets([...group.targets, ...sameToolTargets]);
    } else if (mode === "replace") {
      nextTargets = dedupeGroupTargets(sameToolTargets);
    } else {
      const removeKeys = new Set(sameToolTargets.map((target) => `${target.tool}:${normalizeRel(target.relativePath)}`));
      nextTargets = group.targets.filter((target) => {
        const key = `${target.tool}:${normalizeRel(target.relativePath)}`;
        return !removeKeys.has(key);
      });
    }

    if (nextTargets.length === 0) {
      vscode.window.showWarningMessage("그룹이 비게 됩니다. 필요하면 그룹 삭제를 사용하세요.");
      return;
    }

    const nextGroups = state.groups.map((item) => item.id === group.id ? { ...item, targets: nextTargets } : item);
    await persistGroups(nextGroups, group.id);
    vscode.window.showInformationMessage(`그룹 업데이트 완료: ${group.name} (${nextTargets.length}개)`);
  }

  async function showGroupActions(node?: GroupTreeNode): Promise<void> {
    try {
      if (!state.workspacePath || !state.centralRepoPath) await refresh();
      const group = resolveGroup(node);
      if (!group) {
        vscode.window.showWarningMessage("그룹을 먼저 선택하세요.");
        return;
      }
      state.selectedGroupId = group.id;
      workspaceProvider.setSelectedGroup(group.id);
      centralProvider.setSelectedGroup(group.id);
      applyGroupHighlight(state, group, workspaceProvider, centralProvider);

      const action = await vscode.window.showQuickPick(
        [
          { label: group.side === "workspace" ? "Promote 실행" : "Import 실행", value: "run" as const },
          { label: "그룹 이름 변경", value: "rename" as const },
          { label: "현재 선택 항목 추가", value: "append" as const },
          { label: "현재 선택 항목으로 교체", value: "replace" as const },
          { label: "현재 선택 항목 제거", value: "remove" as const },
          { label: "그룹 정보 보기", value: "info" as const },
          { label: "그룹 삭제", value: "delete" as const }
        ],
        { title: `그룹 작업: ${group.name}`, matchOnDescription: true }
      );
      if (!action) return;

      if (action.value === "run") {
        await exportGroup(group.side, group);
        return;
      }
      if (action.value === "rename") {
        await renameGroup({
          id: group.id,
          kind: "group",
          side: group.side,
          label: group.name,
          count: group.targets.length
        });
        return;
      }
      if (action.value === "append") {
        await mutateGroupTargets(group, "append");
        return;
      }
      if (action.value === "replace") {
        await mutateGroupTargets(group, "replace");
        return;
      }
      if (action.value === "remove") {
        await mutateGroupTargets(group, "remove");
        return;
      }
      if (action.value === "info") {
        await showGroupInfo(group);
        return;
      }
      await vscode.commands.executeCommand("skillBridge.deleteGroup", node);
    } catch (error) {
      vscode.window.showErrorMessage(toUserError(error));
    }
  }

  async function pickGroup(groups: SelectionGroup[], side: "workspace" | "central"): Promise<SelectionGroup | undefined> {
    const pick = await vscode.window.showQuickPick(
      groups.map((group) => ({
        label: group.name,
        description: `${group.targets.length}개 항목`,
        value: group.id
      })),
      { title: side === "workspace" ? "내보낼 그룹 선택" : "가져올 그룹 선택" }
    );
    if (!pick) return;
    return groups.find((item) => item.id === pick.value);
  }

  async function createSkillItem(
    side: "workspace" | "central",
    kind: "file" | "folder",
    node?: SkillTreeNode
  ): Promise<void> {
    try {
      if (!state.workspacePath || !state.centralRepoPath) await refresh();
      const basePath = side === "workspace" ? state.workspacePath : state.centralRepoPath;
      const baseNode = node ?? (side === "workspace" ? workspaceProvider.getSelected() : centralProvider.getSelected());
      const tool = baseNode?.tool ?? await pickTool();
      if (!tool) return;

      const baseRelRaw = baseNode
        ? (baseNode.kind === "file" ? path.posix.dirname(baseNode.relativePath) : baseNode.relativePath)
        : "skills";
      const baseRel = normalizeRel(baseRelRaw) || "skills";
      const toolRoot = getSkillRoot(basePath, tool, side);

      const name = await vscode.window.showInputBox({
        title: kind === "folder" ? "새 폴더 이름" : "새 파일 이름",
        prompt: kind === "folder" ? "폴더 이름을 입력하세요" : "파일 이름을 입력하세요",
        value: kind === "file" ? "SKILL.md" : ""
      });
      if (!name?.trim()) return;

      const nextRel = normalizeRel(path.join(baseRel, name.trim()));
      if (!isManagedSkillPath(nextRel) || nextRel.includes("..")) {
        vscode.window.showWarningMessage("skills 폴더 하위만 생성할 수 있습니다.");
        return;
      }

      const target = path.join(toolRoot, nextRel);
      if (await exists(target)) {
        vscode.window.showWarningMessage("이미 같은 이름이 있습니다.");
        return;
      }

      if (kind === "folder") {
        await fs.mkdir(toolRoot, { recursive: true });
        await fs.mkdir(target, { recursive: true });
      } else {
        await fs.mkdir(toolRoot, { recursive: true });
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, "", "utf8");
      }

      await refresh();
      vscode.window.showInformationMessage(`${kind === "folder" ? "폴더" : "파일"} 생성 완료`);
    } catch (error) {
      vscode.window.showErrorMessage(toUserError(error));
    }
  }

  async function runNodeCrud(side: TreeSide, action: NodeCrudAction, node?: SkillTreeNode): Promise<void> {
    try {
      if (!state.workspacePath || !state.centralRepoPath) await refresh();
      const provider = side === "workspace" ? workspaceProvider : centralProvider;
      const targetNode = node ?? provider.getSelected();
      if (!targetNode) {
        vscode.window.showWarningMessage("먼저 대상 파일 또는 폴더를 선택하세요.");
        return;
      }
      if (!targetNode.relativePath) {
        vscode.window.showWarningMessage(`에이전트 루트(${targetNode.tool})는 수정할 수 없습니다. skills 하위 항목에서 작업해주세요.`);
        return;
      }
      if (!isManagedSkillPath(targetNode.relativePath)) {
        vscode.window.showWarningMessage(`skills 폴더 하위 항목만 수정할 수 있습니다. (현재: ${targetNode.tool}/${targetNode.relativePath})`);
        return;
      }
      if (normalizeRel(targetNode.relativePath).toLowerCase() === "skills") {
        vscode.window.showWarningMessage("skills 루트는 변경할 수 없습니다.");
        return;
      }

      const basePath = side === "workspace" ? state.workspacePath : state.centralRepoPath;
      const sourceRoot = getSkillRoot(basePath, targetNode.tool, side);
      const sourceAbs = path.join(sourceRoot, targetNode.relativePath);
      if (!(await exists(sourceAbs))) {
        vscode.window.showWarningMessage("대상 경로를 찾을 수 없습니다.");
        return;
      }

      if (action === "delete") {
        const ok = await vscode.window.showWarningMessage(
          `${targetNode.kind === "folder" ? "폴더" : "파일"} "${targetNode.relativePath}"을(를) 삭제할까요?`,
          { modal: true },
          "삭제"
        );
        if (ok !== "삭제") return;
        await fs.rm(sourceAbs, { recursive: true, force: true });
        await refresh();
        vscode.window.showInformationMessage("삭제 완료");
        return;
      }

      const currentName = path.posix.basename(targetNode.relativePath);
      const parentRel = normalizeRel(path.posix.dirname(targetNode.relativePath));
      const defaultName = action === "duplicate" ? suggestDuplicateName(currentName) : currentName;
      const nextName = await vscode.window.showInputBox({
        title: action === "rename" ? "이름 변경" : "복제 이름",
        prompt: action === "rename" ? "새 이름을 입력하세요" : "복제 대상 이름을 입력하세요",
        value: defaultName
      });
      if (!nextName?.trim()) return;
      const nextRel = normalizeRel(parentRel === "." ? nextName.trim() : path.posix.join(parentRel, nextName.trim()));
      if (!isManagedSkillPath(nextRel) || nextRel.includes("..")) {
        vscode.window.showWarningMessage("skills 폴더 하위만 허용됩니다.");
        return;
      }
      if (nextRel === targetNode.relativePath) return;
      const nextAbs = path.join(sourceRoot, nextRel);
      if (await exists(nextAbs)) {
        vscode.window.showWarningMessage("이미 같은 이름이 있습니다.");
        return;
      }

      if (action === "rename") {
        await fs.mkdir(path.dirname(nextAbs), { recursive: true });
        await fs.rename(sourceAbs, nextAbs);
        await refresh();
        vscode.window.showInformationMessage("이름 변경 완료");
        return;
      }

      await copyNode(sourceAbs, nextAbs);
      await refresh();
      vscode.window.showInformationMessage("복제 완료");
    } catch (error) {
      vscode.window.showErrorMessage(toUserError(error));
    }
  }

  function copyNodesToClipboard(side: TreeSide, node?: SkillTreeNode): void {
    const isPathNode = (item: SkillTreeNode): item is SkillTreeNode & { kind: "file" | "folder" } =>
      item.kind === "file" || item.kind === "folder";
    const provider = side === "workspace" ? workspaceProvider : centralProvider;
    const selectedNodes = side === "workspace" ? state.workspaceSelection : state.centralSelection;
    const sourceNodes = node ? [node] : (selectedNodes.length > 0 ? selectedNodes : [provider.getSelected()].filter(Boolean) as SkillTreeNode[]);
    if (sourceNodes.length === 0) {
      vscode.window.showWarningMessage("복사할 항목을 선택하세요.");
      return;
    }

    const normalized = collapseCopyNodes(sourceNodes)
      .filter(isPathNode)
      .filter((item) => item.relativePath && isManagedSkillPath(item.relativePath))
      .filter((item) => normalizeRel(item.relativePath).toLowerCase() !== "skills")
      .map((item) => ({ kind: item.kind, tool: item.tool, relativePath: item.relativePath }));

    if (normalized.length === 0) {
      vscode.window.showWarningMessage("skills 폴더 하위 항목만 복사할 수 있습니다.");
      return;
    }

    state.clipboard = { side, entries: normalized };
    vscode.window.setStatusBarMessage(`Skill Bridge: ${normalized.length}개 항목을 복사했습니다.`, 1800);
  }

  async function pasteNodesFromClipboard(side: TreeSide, node?: SkillTreeNode): Promise<void> {
    try {
      if (!state.workspacePath || !state.centralRepoPath) await refresh();
      if (!state.clipboard.side || state.clipboard.entries.length === 0) {
        vscode.window.showWarningMessage("먼저 복사(Ctrl+C)할 항목을 선택하세요.");
        return;
      }
      if (state.clipboard.side !== side) {
        vscode.window.showWarningMessage("다른 패널로 붙여넣기는 지원하지 않습니다. Promote/Import를 사용하세요.");
        return;
      }

      const provider = side === "workspace" ? workspaceProvider : centralProvider;
      const selected = node ?? provider.getSelected();
      const targetFolderRel = resolvePasteFolder(selected);

      let copied = 0;
      for (const entry of state.clipboard.entries) {
        const sourceRoot = getSkillRoot(side === "workspace" ? state.workspacePath : state.centralRepoPath, entry.tool, side);
        const sourceAbs = path.join(sourceRoot, entry.relativePath);
        if (!(await exists(sourceAbs))) continue;

        const baseName = path.posix.basename(entry.relativePath);
        const destinationParent = targetFolderRel ?? normalizeRel(path.posix.dirname(entry.relativePath));
        const destinationBaseRel = normalizeRel(destinationParent ? path.posix.join(destinationParent, baseName) : baseName);
        if (!isManagedSkillPath(destinationBaseRel) || destinationBaseRel.includes("..")) continue;

        if (entry.kind === "folder") {
          const srcRel = normalizeRel(entry.relativePath);
          if (destinationBaseRel === srcRel || destinationBaseRel.startsWith(`${srcRel}/`)) {
            continue;
          }
        }

        const destinationRel = await getUniqueCopyRelativePath(sourceRoot, destinationBaseRel, entry.kind);
        const destinationAbs = path.join(sourceRoot, destinationRel);
        await copyNode(sourceAbs, destinationAbs);
        copied += 1;
      }

      await refresh();
      if (copied === 0) {
        vscode.window.showWarningMessage("붙여넣을 수 있는 항목이 없습니다.");
        return;
      }
      vscode.window.showInformationMessage(`붙여넣기 완료: ${copied}개`);
    } catch (error) {
      vscode.window.showErrorMessage(toUserError(error));
    }
  }

  function resolvePasteFolder(node: SkillTreeNode | null | undefined): string | null {
    if (!node) return null;
    if (!node.relativePath) return "skills";
    if (!isManagedSkillPath(node.relativePath)) return null;
    if (node.kind === "folder") return normalizeRel(node.relativePath);
    const parent = normalizeRel(path.posix.dirname(node.relativePath));
    return parent || "skills";
  }

  function collapseCopyNodes(nodes: SkillTreeNode[]): SkillTreeNode[] {
    const sorted = [...nodes].sort((a, b) => a.relativePath.length - b.relativePath.length);
    const kept: SkillTreeNode[] = [];
    for (const node of sorted) {
      const rel = normalizeRel(node.relativePath);
      const covered = kept.some((parent) => {
        if (parent.tool !== node.tool) return false;
        if (parent.kind !== "folder") return false;
        const p = normalizeRel(parent.relativePath);
        return rel === p || rel.startsWith(`${p}/`);
      });
      if (!covered) kept.push(node);
    }
    return kept;
  }

  async function getUniqueCopyRelativePath(
    sourceRoot: string,
    desiredRelativePath: string,
    kind: "file" | "folder"
  ): Promise<string> {
    const normalized = normalizeRel(desiredRelativePath);
    if (!(await exists(path.join(sourceRoot, normalized)))) return normalized;

    const parsed = path.posix.parse(normalized);
    const stem = kind === "file" && parsed.ext ? parsed.name : path.posix.basename(normalized);
    const ext = kind === "file" ? parsed.ext : "";
    const dir = parsed.dir;
    let index = 1;
    while (index < 1000) {
      const suffix = index === 1 ? "-copy" : `-copy-${index}`;
      const candidateName = `${stem}${suffix}${ext}`;
      const candidate = normalizeRel(dir ? path.posix.join(dir, candidateName) : candidateName);
      if (!(await exists(path.join(sourceRoot, candidate)))) return candidate;
      index += 1;
    }
    throw new Error("복사 대상 이름을 생성하지 못했습니다.");
  }

  function getSkillFolderRelativePathFromNode(node: SkillTreeNode | null | undefined): string | null {
    if (!node?.relativePath) return null;
    const normalized = normalizeRel(node.relativePath);
    const parts = normalized.split("/").filter(Boolean);
    if (parts[0] !== "skills" || !parts[1]) return null;
    return `skills/${parts[1]}`;
  }

  function makeFolderNode(tool: ToolType, relativePath: string): SkillTreeNode {
    return {
      key: `${tool}:${relativePath}`,
      kind: "folder",
      tool,
      relativePath,
      label: path.posix.basename(relativePath),
      children: []
    };
  }

  async function openSkillMarkdown(side: TreeSide, node?: SkillTreeNode): Promise<void> {
    if (!state.workspacePath || !state.centralRepoPath) await refresh();
    const provider = side === "workspace" ? workspaceProvider : centralProvider;
    const basePath = side === "workspace" ? state.workspacePath : state.centralRepoPath;
    const target = node ?? provider.getSelected();
    if (!target) {
      vscode.window.showWarningMessage("먼저 스킬 폴더를 선택하세요.");
      return;
    }
    const skillRel = getSkillFolderRelativePathFromNode(target);
    if (!skillRel) {
      vscode.window.showWarningMessage("스킬 폴더(skills/<name>)에서만 사용할 수 있습니다.");
      return;
    }
    const fileRel = `${skillRel}/SKILL.md`;
    const fileAbs = resolveSkillPath(basePath, target.tool, fileRel, side);
    if (!(await exists(fileAbs))) {
      const create = await vscode.window.showInformationMessage(
        "SKILL.md가 없습니다. 새로 만들까요?",
        "만들기"
      );
      if (create !== "만들기") return;
      await fs.mkdir(path.dirname(fileAbs), { recursive: true });
      await fs.writeFile(fileAbs, "", "utf8");
      await refresh();
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fileAbs));
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  async function showQuickSkillCrud(side: TreeSide, node?: SkillTreeNode): Promise<void> {
    try {
      if (!state.workspacePath || !state.centralRepoPath) await refresh();
      const provider = side === "workspace" ? workspaceProvider : centralProvider;
      const target = node ?? provider.getSelected();
      const skillRel = getSkillFolderRelativePathFromNode(target);
      const skillNode = target && skillRel ? makeFolderNode(target.tool, skillRel) : undefined;
      const title = side === "workspace" ? "Workspace Quick Skill CRUD" : "Central Quick Skill CRUD";

      const actions: Array<{ label: string; value: string; description?: string }> = [
        { label: "새 스킬 생성", value: "createSkill", description: "skills/<name> + SKILL.md 생성" },
        { label: "새 파일 생성", value: "createFile", description: "현재 위치에 파일 생성" },
        { label: "새 폴더 생성", value: "createFolder", description: "현재 위치에 폴더 생성" }
      ];

      if (skillNode) {
        actions.push(
          { label: "SKILL.md 열기", value: "openSkillMd", description: "스킬 설명 파일 편집" },
          { label: "스킬 이름 변경", value: "renameSkill", description: "skills/<name> 폴더 이름 변경" },
          { label: "스킬 복제", value: "duplicateSkill", description: "스킬 폴더 전체 복제" },
          { label: "스킬 삭제", value: "deleteSkill", description: "스킬 폴더 전체 삭제" }
        );
      }

      if (target) {
        actions.push(
          { label: "선택 항목 이름 변경", value: "renameNode" },
          { label: "선택 항목 복제", value: "duplicateNode" },
          { label: "선택 항목 삭제", value: "deleteNode" }
        );
      }

      const pick = await vscode.window.showQuickPick(actions, {
        title,
        matchOnDescription: true
      });
      if (!pick) return;

      if (pick.value === "createSkill") {
        await createSkillFolder(side, target ?? undefined);
        return;
      }
      if (pick.value === "createFile") {
        await createSkillItem(side, "file", target ?? undefined);
        return;
      }
      if (pick.value === "createFolder") {
        await createSkillItem(side, "folder", target ?? undefined);
        return;
      }
      if (pick.value === "openSkillMd") {
        await openSkillMarkdown(side, skillNode);
        return;
      }
      if (pick.value === "renameSkill") {
        await runNodeCrud(side, "rename", skillNode);
        return;
      }
      if (pick.value === "duplicateSkill") {
        await runNodeCrud(side, "duplicate", skillNode);
        return;
      }
      if (pick.value === "deleteSkill") {
        await runNodeCrud(side, "delete", skillNode);
        return;
      }
      if (pick.value === "renameNode") {
        await runNodeCrud(side, "rename", target ?? undefined);
        return;
      }
      if (pick.value === "duplicateNode") {
        await runNodeCrud(side, "duplicate", target ?? undefined);
        return;
      }
      if (pick.value === "deleteNode") {
        await runNodeCrud(side, "delete", target ?? undefined);
      }
    } catch (error) {
      vscode.window.showErrorMessage(toUserError(error));
    }
  }

  async function showSmartActions(side: TreeSide, node?: SkillTreeNode): Promise<void> {
    try {
      if (!state.workspacePath || !state.centralRepoPath) await refresh();
      const provider = side === "workspace" ? workspaceProvider : centralProvider;
      const selectedNodes = side === "workspace" ? state.workspaceSelection : state.centralSelection;
      const baseNode = node ?? provider.getSelected() ?? selectedNodes[0];
      const scopedNodes = node ? [node] : selectedNodes;
      const scopedSelections = provider.getSelectionsFromNodes(scopedNodes);
      const selections = uniqueSelections(scopedSelections.length > 0 ? scopedSelections : provider.getAllSelections());
      const skillRel = getSkillFolderRelativePathFromNode(baseNode);
      const skillNode = baseNode && skillRel ? makeFolderNode(baseNode.tool, skillRel) : undefined;
      const selectedGroup = state.selectedGroupId
        ? state.groups.find((group) => group.id === state.selectedGroupId && group.side === side)
        : undefined;

      const actions: Array<{ label: string; value: string; description?: string }> = [
        {
          label: side === "workspace" ? "선택 항목 Promote" : "선택 항목 Import",
          value: "transfer",
          description: `${selections.length}개 파일 대상`
        },
        {
          label: side === "workspace" ? "선택 항목 그룹 저장 (Workspace)" : "선택 항목 그룹 저장 (Central)",
          value: "createGroup",
          description: "현재 선택 노드를 새 그룹으로 저장"
        },
        {
          label: "Quick Skill CRUD 열기",
          value: "crud",
          description: "생성/이름변경/복제/삭제"
        }
      ];

      if (skillNode) {
        actions.push({
          label: "SKILL.md 열기",
          value: "openSkillMd",
          description: `${skillNode.tool}/${skillNode.relativePath}`
        });
      }

      if (selectedGroup) {
        actions.push({
          label: `선택 그룹 작업 열기 (${selectedGroup.name})`,
          value: "groupActions",
          description: "실행/이름변경/항목 추가·교체·제거"
        });
      }

      actions.push(
        { label: "소스 탭 전환", value: "switchTab" },
        { label: "새로고침", value: "refresh" }
      );

      const pick = await vscode.window.showQuickPick(actions, {
        title: side === "workspace" ? "Workspace 스마트 액션" : "Central 스마트 액션",
        matchOnDescription: true
      });
      if (!pick) return;

      if (pick.value === "transfer") {
        if (selections.length === 0) {
          vscode.window.showWarningMessage("전송할 파일을 찾지 못했습니다.");
          return;
        }
        const result = await transferSelections(side, selections, {
          scopeHints: buildTransferScopeHintsFromNodes(scopedNodes)
        });
        await refresh();
        vscode.window.showInformationMessage(`${side === "workspace" ? "Copy To Central" : "Copy To Workspace"} 반영: 복사 ${result.copied}개 / 삭제 ${result.deleted}개 / 변경없음 ${result.unchanged}개`);
        return;
      }
      if (pick.value === "createGroup") {
        await createGroupFromSelection(side);
        return;
      }
      if (pick.value === "crud") {
        await showQuickSkillCrud(side, baseNode);
        return;
      }
      if (pick.value === "openSkillMd") {
        await openSkillMarkdown(side, skillNode);
        return;
      }
      if (pick.value === "groupActions") {
        await showGroupActions();
        return;
      }
      if (pick.value === "switchTab") {
        await vscode.commands.executeCommand("skillBridge.switchTab");
        return;
      }
      await refresh();
    } catch (error) {
      vscode.window.showErrorMessage(toUserError(error));
    }
  }

  async function installSkills(node?: SkillTreeNode): Promise<void> {
    try {
      if (!state.workspacePath || !state.centralRepoPath) await refresh();
      const side = await resolveInstallSide(node);
      if (!side) return;

      const repoInput = await vscode.window.showInputBox({
        title: side === "workspace" ? "Workspace: npx skills add" : "Central: npx skills add",
        prompt: "설치할 스킬 저장소 URL을 입력하세요",
        value: "https://github.com/vercel-labs/skills",
        ignoreFocusOut: true
      });
      const repo = repoInput?.trim();
      if (!repo) return;

      const skillsInput = await vscode.window.showInputBox({
        title: "설치할 스킬 이름",
        prompt: "콤마(,)로 구분해 입력하세요. 비우면 전체(*)",
        value: "*",
        ignoreFocusOut: true
      });
      if (skillsInput === undefined) return;
      const skills = parseSkillInputs(skillsInput);

      const defaultCwd = side === "workspace" ? state.workspacePath : state.centralRepoPath;
      const cwdInput = await vscode.window.showInputBox({
        title: "실행 디렉터리",
        prompt: "npx skills add를 실행할 디렉터리를 입력하세요",
        value: defaultCwd,
        ignoreFocusOut: true
      });
      if (cwdInput === undefined) return;
      const cwd = cwdInput.trim() || defaultCwd;
      if (!(await exists(cwd))) {
        vscode.window.showErrorMessage(`실행 디렉터리를 찾을 수 없습니다: ${cwd}`);
        return;
      }
      const stat = await fs.stat(cwd).catch(() => null);
      if (!stat || !stat.isDirectory()) {
        vscode.window.showErrorMessage(`디렉터리 경로를 입력해주세요: ${cwd}`);
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `다음 명령을 실행할까요?\n\n(cd ${cwd}) && npx -y skills add ${repo} ${skills.map((s) => `--skill ${s}`).join(" ")} --yes`,
        { modal: true },
        "실행"
      );
      if (confirm !== "실행") return;

      const beforeFiles = await loadSkillFilesBySide(side, state.workspacePath, state.centralRepoPath, state.agents);
      const result = await runSkillsAdd(cwd, repo, skills);
      const text = [result.command, result.stdout, result.stderr].filter(Boolean).join("\n");
      output.appendLine(`[skills:add] side=${side} cwd=${cwd}`);
      output.appendLine(text || "(no output)");
      output.show(true);

      if (!result.ok) {
        vscode.window.showErrorMessage("npx skills add 실행에 실패했습니다. Output 패널을 확인하세요.");
        return;
      }

      await refresh();
      const afterFiles = await loadSkillFilesBySide(side, state.workspacePath, state.centralRepoPath, state.agents);
      const installedNames = extractInstalledSkillFolderNames(`${result.stdout}\n${result.stderr}`);
      const fallbackNames = inferNewSkillFolderNames(beforeFiles, afterFiles);
      const targetNames = installedNames.length > 0 ? installedNames : fallbackNames;
      const targets = buildGroupTargetsFromNames(afterFiles, targetNames);

      if (targets.length === 0) {
        vscode.window.showWarningMessage("설치는 완료되었지만 그룹으로 등록할 새 스킬 폴더를 찾지 못했습니다.");
        return;
      }

      const repoKey = normalizeRepoName(repo);
      const now = new Date().toISOString();
      const existing = state.groups.find((group) => group.side === side && group.meta?.repoKey === repoKey);

      let sourceGroup: SelectionGroup;
      if (existing) {
        const nextGroups: SelectionGroup[] = state.groups.map((group) => {
          if (group.id !== existing.id) return group;
          return {
            ...group,
            name: repoKey || group.name,
            targets,
            meta: {
              ...group.meta,
              source: "npx" as const,
              repoKey,
              repoUrl: repo,
              lastInstalledAt: now
            }
          };
        });
        await persistGroups(nextGroups, existing.id);
        sourceGroup = nextGroups.find((group) => group.id === existing.id) ?? existing;
        vscode.window.showInformationMessage(`설치 및 그룹 갱신 완료: ${repoKey} (${targets.length}개)`);
      } else {
        const groupId = `${side}-${Date.now()}`;
        const group: SelectionGroup = {
          id: groupId,
          name: repoKey || "skills-installed",
          side,
          targets,
          meta: {
            source: "npx",
            repoKey,
            repoUrl: repo,
            lastInstalledAt: now
          }
        };
        await persistGroups([...state.groups, group], groupId);
        sourceGroup = group;
        vscode.window.showInformationMessage(`설치 및 그룹 생성 완료: ${group.name} (${targets.length}개)`);
      }

      const shouldSync = await vscode.window.showInformationMessage(
        side === "workspace"
          ? "설치된 스킬을 중앙 저장소로 복사할까요?"
          : "설치된 스킬을 작업 폴더로 복사할까요?",
        "복사"
      );
      if (shouldSync === "복사") {
        const selections = targetsToSelections(afterFiles, sourceGroup.targets);
        const result = await transferSelections(side, selections, {
          groupContext: { id: sourceGroup.id, name: sourceGroup.name, side: sourceGroup.side },
          repoContext: { repo },
          scopeHints: sourceGroup.targets.map((target) => ({ ...target }))
        });
        if (result.copied + result.deleted > 0) {
          await mirrorGroupToOtherSide(sourceGroup);
          await refresh();
          vscode.window.showInformationMessage(`설치 스킬 반영: 복사 ${result.copied}개 / 삭제 ${result.deleted}개 / 변경없음 ${result.unchanged}개`);
        }
      }
    } catch (error) {
      vscode.window.showErrorMessage(toUserError(error));
    }
  }

  async function resolveInstallSide(node?: SkillTreeNode): Promise<TreeSide | undefined> {
    if (node) {
      const workspaceSelected = state.workspaceSelection.some((item) => item.key === node.key)
        || workspaceProvider.getSelected()?.key === node.key;
      if (workspaceSelected) return "workspace";
      const centralSelected = state.centralSelection.some((item) => item.key === node.key)
        || centralProvider.getSelected()?.key === node.key;
      if (centralSelected) return "central";
    }

    if (state.workspaceSelection.length > 0 && state.centralSelection.length === 0) return "workspace";
    if (state.centralSelection.length > 0 && state.workspaceSelection.length === 0) return "central";

    const pick = await vscode.window.showQuickPick(
      [
        { label: "Workspace", value: "workspace" as TreeSide },
        { label: "Central", value: "central" as TreeSide }
      ],
      { title: "npx skills add 실행 위치 선택" }
    );
    return pick?.value;
  }

  async function transferSelections(
    side: "workspace" | "central",
    selections: SkillSelection[],
    options?: Pick<TransferPlan, "groupContext" | "repoContext"> & { scopeHints?: TransferScopeHint[] }
  ): Promise<{ copied: number; deleted: number; unchanged: number; failed: number }> {
    const plan = await buildTransferPlan(side, selections, options);
    if (plan.items.length === 0) return { copied: 0, deleted: 0, unchanged: 0, failed: 0 };
    const resolved = await openTransferManagerTab(
      plan,
      async () => await buildTransferPlan(side, selections, options)
    );
    if (!resolved) return { copied: 0, deleted: 0, unchanged: 0, failed: 0 };
    const result = await applyTransferPlan(resolved.items, side === "workspace" ? state.workspacePath : null);
    if (result.failed > 0) {
      vscode.window.showWarningMessage(`반영 결과: 복사 ${result.copied}개 / 삭제 ${result.deleted}개 / 변경없음 ${result.unchanged}개 / 실패 ${result.failed}개`);
    }
    return result;
  }

  async function buildTransferPlan(
    side: "workspace" | "central",
    selections: SkillSelection[],
    options?: Pick<TransferPlan, "groupContext" | "repoContext"> & { scopeHints?: TransferScopeHint[] }
  ): Promise<TransferPlan> {
    const sourceGroup = options?.groupContext
      ? state.groups.find((group) => group.id === options.groupContext?.id && group.side === options.groupContext?.side)
      : undefined;
    const groupType: TransferPlanItem["groupType"] = sourceGroup
      ? sourceGroup.meta?.mirroredFrom
        ? "mirror"
        : sourceGroup.meta?.source === "manual"
          ? "manual"
          : "selected"
      : "none";
    const groupName = sourceGroup?.name ?? options?.groupContext?.name ?? null;
    type Entry = {
      relativePath: string;
      absolutePath: string;
      kind: "file" | "folder";
      mtime: string | null;
      size: number | null;
    };
    const summarizeStatuses = (statuses: TransferStatus[]): TransferStatus => {
      if (statuses.some((status) => status === "typeChanged")) return "typeChanged";
      if (statuses.some((status) => status === "modified")) return "modified";
      const hasAdded = statuses.some((status) => status === "added");
      const hasRemoved = statuses.some((status) => status === "removed");
      if (hasAdded && hasRemoved) return "modified";
      if (hasAdded) return "added";
      if (hasRemoved) return "removed";
      return "same";
    };
    const reasonByStatus = (status: TransferStatus): string => {
      if (status === "added") return "하위 파일 신규";
      if (status === "removed") return "하위 파일 삭제";
      if (status === "modified") return "하위 파일 변경";
      if (status === "typeChanged") return "하위 타입 불일치";
      return "하위 항목 동일";
    };

    const sourceBasePath = side === "workspace" ? state.workspacePath : state.centralRepoPath;
    const targetBasePath = side === "workspace" ? state.centralRepoPath : state.workspacePath;
    const sourceMode = side === "workspace" ? "workspace" as const : "central" as const;
    const targetMode = side === "workspace" ? "central" as const : "workspace" as const;
    const inferredScopeHints: TransferScopeHint[] = options?.scopeHints && options.scopeHints.length > 0
      ? options.scopeHints
      : sourceGroup
        ? sourceGroup.targets.map((target) => ({ ...target }))
        : uniqueSelections(selections).map((selected) => ({
            tool: selected.tool,
            relativePath: selected.relativePath,
            kind: "file" as const
          }));

    const scopeByTool = new Map<ToolType, Map<string, "file" | "folder">>();
    for (const selected of inferredScopeHints) {
      const scope = normalizeRel(selected.relativePath);
      if (!scope || !isManagedSkillPath(scope)) continue;
      const existing = scopeByTool.get(selected.tool) ?? new Map<string, "file" | "folder">();
      const prevKind = existing.get(scope);
      existing.set(scope, prevKind === "folder" || selected.kind === "folder" ? "folder" : "file");
      scopeByTool.set(selected.tool, existing);
    }

    const itemsMap = new Map<string, TransferPlanItem>();
    for (const [tool, scopes] of scopeByTool.entries()) {
      const sourceToolRoot = getSkillRoot(sourceBasePath, tool, sourceMode);
      const targetToolRoot = getSkillRoot(targetBasePath, tool, targetMode);
      for (const [scope, scopeKind] of scopes.entries()) {
        const [sourceEntries, targetEntries] = await Promise.all([
          collectScopeEntries(sourceToolRoot, scope, scopeKind),
          collectScopeEntries(targetToolRoot, scope, scopeKind)
        ]);
        const allPaths = new Set<string>([
          ...sourceEntries.keys(),
          ...targetEntries.keys()
        ]);
        for (const relativePath of allPaths) {
          if (!isManagedSkillPath(relativePath)) continue;
          const sourceEntry = sourceEntries.get(relativePath);
          const targetEntry = targetEntries.get(relativePath);
          let status: TransferStatus = "same";
          let reason = "동일";
          let entryKind: "file" | "folder" = sourceEntry?.kind ?? targetEntry?.kind ?? "file";

          if (sourceEntry && !targetEntry) {
            status = "added";
            reason = "대상에 없음";
            entryKind = sourceEntry.kind;
          } else if (!sourceEntry && targetEntry) {
            status = "removed";
            reason = "소스에 없음";
            entryKind = targetEntry.kind;
          } else if (sourceEntry && targetEntry && sourceEntry.kind !== targetEntry.kind) {
            status = "typeChanged";
            reason = "타입 불일치";
            entryKind = sourceEntry.kind;
          } else if (sourceEntry && targetEntry && sourceEntry.kind === "folder") {
            status = "same";
            reason = "폴더 동일";
            entryKind = "folder";
          } else if (sourceEntry && targetEntry) {
            const same = await isSameFileContent(
              sourceEntry.absolutePath,
              targetEntry.absolutePath,
              sourceEntry.size ?? 0,
              targetEntry.size ?? 0
            );
            status = same ? "same" : "modified";
            reason = same ? "내용 동일" : "내용 변경";
            entryKind = "file";
          }

          const srcPath = sourceEntry?.absolutePath
            ?? resolveSkillPath(sourceBasePath, tool, relativePath, sourceMode);
          const dstPath = targetEntry?.absolutePath
            ?? resolveSkillPath(targetBasePath, tool, relativePath, targetMode);
          const key = `${tool}:${relativePath}`;
          itemsMap.set(key, {
            key,
            tool,
            relativePath,
            entryKind,
            changeKind: status,
            src: srcPath,
            dst: dstPath,
            status,
            reason,
            srcMtime: sourceEntry?.mtime ?? null,
            dstMtime: targetEntry?.mtime ?? null,
            srcSize: sourceEntry?.size ?? null,
            dstSize: targetEntry?.size ?? null,
            selected: status === "added" || status === "modified" || status === "typeChanged",
            groupType,
            groupName
          });
        }
      }
    }

    const allItems = [...itemsMap.values()];
    const folderItems = allItems.filter((item) => item.entryKind === "folder");
    for (const folderItem of folderItems) {
      const prefix = `${folderItem.relativePath}/`;
      const childStatuses = allItems
        .filter((item) => item.tool === folderItem.tool && item.relativePath.startsWith(prefix))
        .map((item) => item.status);
      if (childStatuses.length === 0) continue;
      const nextStatus = summarizeStatuses(childStatuses);
      folderItem.status = nextStatus;
      folderItem.changeKind = nextStatus;
      folderItem.reason = reasonByStatus(nextStatus);
      folderItem.selected = nextStatus === "added" || nextStatus === "modified" || nextStatus === "typeChanged";
      itemsMap.set(folderItem.key, folderItem);
    }

    const items = [...itemsMap.values()].sort((a, b) => (
      a.tool.localeCompare(b.tool) || a.relativePath.localeCompare(b.relativePath)
    ));
    const summary: TransferPlanSummary = {
      total: items.length,
      addedCount: items.filter((item) => item.status === "added").length,
      removedCount: items.filter((item) => item.status === "removed").length,
      modifiedCount: items.filter((item) => item.status === "modified").length,
      typeChangedCount: items.filter((item) => item.status === "typeChanged").length,
      sameCount: items.filter((item) => item.status === "same").length,
      unchangedCount: items.filter((item) => item.status === "same").length
    };
    return {
      mode: side === "workspace" ? "workspaceToCentral" : "centralToWorkspace",
      items,
      summary,
      groupContext: options?.groupContext,
      repoContext: options?.repoContext
    };
  }

  async function openTransferManagerTab(
    plan: TransferPlan,
    rebuildPlan: () => Promise<TransferPlan>
  ): Promise<TransferPlan | null> {
    let currentPlan = plan;
    const panel = vscode.window.createWebviewPanel(
      "skillBridgeTransferManager",
      plan.mode === "workspaceToCentral" ? "Copy To Central - Transfer Manager" : "Copy To Workspace - Transfer Manager",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.webview.html = renderTransferManagerHtml(panel.webview, currentPlan);

    return await new Promise<TransferPlan | null>((resolve) => {
      let settled = false;
      const done = (value: TransferPlan | null): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      panel.onDidDispose(() => done(null));
      panel.webview.onDidReceiveMessage(async (msg: unknown) => {
        if (!msg || typeof msg !== "object") return;
        const message = msg as { type?: string; payload?: unknown };
        if (message.type === "cancel") {
          done(null);
          panel.dispose();
          return;
        }
        if (message.type === "openDiff") {
          const key = String((message.payload as { key?: string } | undefined)?.key ?? "");
          const item = currentPlan.items.find((entry) => entry.key === key);
          if (item) await openTransferDiff(item);
          return;
        }
        if (message.type === "openFolderDiffSummary") {
          const payload = (message.payload as { tool?: string; relativePath?: string; itemKeys?: string[] } | undefined) ?? {};
          const tool = String(payload.tool ?? "");
          const relativePath = String(payload.relativePath ?? "");
          const keySet = new Set(Array.isArray(payload.itemKeys) ? payload.itemKeys : []);
          const targets = currentPlan.items.filter((entry) => keySet.has(entry.key));
          if (targets.length === 0) return;
          const panelTitle = `Diff Summary: ${tool}/${relativePath}`;
          const summaryPanel = vscode.window.createWebviewPanel(
            "skillBridgeFolderDiffSummary",
            panelTitle,
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: false }
          );
          summaryPanel.webview.html = renderFolderDiffSummaryHtml(summaryPanel.webview, {
            mode: currentPlan.mode,
            tool,
            relativePath,
            rows: buildFolderDiffSummaryRows(targets, currentPlan.mode)
          });
          summaryPanel.webview.onDidReceiveMessage(async (subMsg: unknown) => {
            if (!subMsg || typeof subMsg !== "object") return;
            const inner = subMsg as { type?: string; payload?: unknown };
            if (inner.type !== "openDiff") return;
            const key = String((inner.payload as { key?: string } | undefined)?.key ?? "");
            const target = currentPlan.items.find((entry) => entry.key === key);
            if (!target) return;
            await openTransferDiff(target);
          });
          return;
        }
        if (message.type === "refreshPlan") {
          const selectedKeys = new Set(
            Array.isArray((message.payload as { selectedKeys?: string[] } | undefined)?.selectedKeys)
              ? (message.payload as { selectedKeys?: string[] }).selectedKeys
              : []
          );
          try {
            const refreshed = await rebuildPlan();
            currentPlan = {
              ...refreshed,
              items: refreshed.items.map((item) => ({
                ...item,
                selected: selectedKeys.has(item.key) || (item.selected && !selectedKeys.size)
              }))
            };
            panel.webview.html = renderTransferManagerHtml(panel.webview, currentPlan);
          } catch (error) {
            vscode.window.showErrorMessage(toUserError(error));
          }
          return;
        }
        if (message.type === "apply") {
          const selectedKeys = new Set(
            Array.isArray((message.payload as { selectedKeys?: string[] } | undefined)?.selectedKeys)
              ? (message.payload as { selectedKeys?: string[] }).selectedKeys
              : []
          );
          const resolvedPlan: TransferPlan = {
            ...currentPlan,
            items: currentPlan.items.map((item) => ({ ...item, selected: selectedKeys.has(item.key) }))
          };
          done(resolvedPlan);
          panel.dispose();
          return;
        }
      });
    });
  }

  async function applyTransferPlan(
    items: TransferPlanItem[],
    sourceProjectPath: string | null
  ): Promise<{ copied: number; deleted: number; unchanged: number; failed: number }> {
    const selected = collapseTransferItems(items.filter((item) => item.selected));
    let copied = 0;
    let deleted = 0;
    let unchanged = 0;
    let failed = 0;
    const copiedItems: TransferPlanItem[] = [];

    const firstPass = selected.filter((item) => item.status === "removed" || item.status === "typeChanged");
    const secondPass = selected.filter((item) => item.status !== "removed" && item.status !== "typeChanged");

    for (const item of [...firstPass, ...secondPass]) {
      try {
        if (item.status === "same") {
          unchanged += 1;
          continue;
        }
        if (item.status === "removed") {
          if (await exists(item.dst)) {
            await fs.rm(item.dst, { recursive: true, force: true });
            deleted += 1;
          } else {
            unchanged += 1;
          }
          continue;
        }
        if (item.status === "typeChanged") {
          if (await exists(item.dst)) {
            await fs.rm(item.dst, { recursive: true, force: true });
          }
        }
        if (item.entryKind === "folder") {
          await copyNode(item.src, item.dst);
        } else {
          await fs.mkdir(path.dirname(item.dst), { recursive: true });
          await fs.copyFile(item.src, item.dst);
        }
        copied += 1;
        copiedItems.push(item);
      } catch {
        failed += 1;
      }
    }
    if (copiedItems.length > 0 && sourceProjectPath) {
      await updateCentralSkillHistory(copiedItems, sourceProjectPath);
    }
    return { copied, deleted, unchanged, failed };
  }

  function collapseTransferItems(items: TransferPlanItem[]): TransferPlanItem[] {
    const sorted = [...items].sort((a, b) => {
      const aFolder = a.entryKind === "folder" ? 0 : 1;
      const bFolder = b.entryKind === "folder" ? 0 : 1;
      if (aFolder !== bFolder) return aFolder - bFolder;
      if (a.relativePath.length !== b.relativePath.length) return a.relativePath.length - b.relativePath.length;
      return a.relativePath.localeCompare(b.relativePath);
    });
    const kept: TransferPlanItem[] = [];
    for (const item of sorted) {
      const covered = kept.some((parent) => (
        parent.tool === item.tool
        && parent.entryKind === "folder"
        && item.relativePath.startsWith(`${parent.relativePath}/`)
      ));
      if (!covered) kept.push(item);
    }
    return kept;
  }

  async function showSkillHistory(node?: SkillTreeNode): Promise<void> {
    try {
      if (!state.centralRepoPath || !state.workspacePath) await refresh();
      const target = node
        ?? centralProvider.getSelected()
        ?? workspaceProvider.getSelected()
        ?? state.centralSelection[0]
        ?? state.workspaceSelection[0];
      if (!target) {
        vscode.window.showWarningMessage("히스토리를 볼 스킬 항목을 선택하세요.");
        return;
      }
      if (!target.relativePath || !isManagedSkillPath(target.relativePath)) {
        vscode.window.showWarningMessage("skills 폴더 하위 항목만 히스토리를 볼 수 있습니다.");
        return;
      }

      const db = await loadCentralSkillHistory();
      const prefix = `${target.tool}:${normalizeRel(target.relativePath)}`;
      const matched = Object.entries(db.records)
        .filter(([key]) => key === prefix || key.startsWith(`${prefix}/`))
        .map(([, record]) => record)
        .sort((a, b) => b.lastUpdatedAt.localeCompare(a.lastUpdatedAt));

      if (matched.length === 0) {
        vscode.window.showInformationMessage("기록된 히스토리가 없습니다.");
        return;
      }

      const picks = matched.map((record) => ({
        label: `${record.tool}/${record.relativePath}`,
        description: `마지막 소스: ${record.lastSourceProjectPath}`,
        detail: `${record.lastUpdatedAt} · 로그 ${record.history.length}개`,
        value: record
      }));
      const picked = await vscode.window.showQuickPick(picks, {
        title: `Skill History (${matched.length}개)`,
        matchOnDescription: true,
        matchOnDetail: true
      });
      if (!picked) return;

      const lines = [
        `경로: ${picked.value.tool}/${picked.value.relativePath}`,
        `마지막 업데이트: ${picked.value.lastUpdatedAt}`,
        `마지막 소스 프로젝트: ${picked.value.lastSourceProjectPath}`,
        `마지막 소스 절대경로: ${picked.value.lastSourceAbsolutePath}`,
        "",
        "최근 로그:"
      ];
      for (const log of picked.value.history.slice(0, 15)) {
        lines.push(`- ${log.at} · ${log.sourceProjectPath}`);
      }
      const doc = await vscode.workspace.openTextDocument({
        language: "markdown",
        content: `# Skill History\n\n${lines.join("\n")}`
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (error) {
      vscode.window.showErrorMessage(toUserError(error));
    }
  }

  async function loadCentralSkillHistory(): Promise<CentralSkillHistoryFile> {
    const target = path.join(state.centralRepoPath, ".skill-bridge-history.json");
    if (!(await exists(target))) {
      return { version: 1, updatedAt: new Date().toISOString(), records: {} };
    }
    try {
      const raw = await fs.readFile(target, "utf8");
      const parsed = JSON.parse(raw) as Partial<CentralSkillHistoryFile>;
      if (!parsed || typeof parsed !== "object") {
        return { version: 1, updatedAt: new Date().toISOString(), records: {} };
      }
      return {
        version: 1,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
        records: parsed.records && typeof parsed.records === "object" ? parsed.records : {}
      };
    } catch {
      return { version: 1, updatedAt: new Date().toISOString(), records: {} };
    }
  }

  async function saveCentralSkillHistory(db: CentralSkillHistoryFile): Promise<void> {
    const target = path.join(state.centralRepoPath, ".skill-bridge-history.json");
    db.updatedAt = new Date().toISOString();
    await fs.writeFile(target, JSON.stringify(db, null, 2), "utf8");
  }

  async function updateCentralSkillHistory(copiedItems: TransferPlanItem[], sourceProjectPath: string): Promise<void> {
    const db = await loadCentralSkillHistory();
    for (const item of copiedItems) {
      if (item.entryKind !== "file") continue;
      const key = `${item.tool}:${item.relativePath}`;
      const previous = db.records[key];
      const nextLog: SkillHistoryLog = {
        at: new Date().toISOString(),
        action: "copyToCentral",
        sourceProjectPath,
        sourceAbsolutePath: item.src
      };
      db.records[key] = {
        tool: item.tool,
        relativePath: item.relativePath,
        lastUpdatedAt: nextLog.at,
        lastSourceProjectPath: sourceProjectPath,
        lastSourceAbsolutePath: item.src,
        history: [nextLog, ...(previous?.history ?? [])].slice(0, 50)
      };
    }
    await saveCentralSkillHistory(db);
  }

  async function isSameFileContent(src: string, dst: string, srcSize: number, dstSize: number): Promise<boolean> {
    if (srcSize !== dstSize) return false;
    const [srcBuffer, dstBuffer] = await Promise.all([fs.readFile(src), fs.readFile(dst)]);
    return srcBuffer.equals(dstBuffer);
  }

  async function openTransferDiff(item: TransferPlanItem): Promise<void> {
    try {
      if (item.status === "same") {
        vscode.window.showInformationMessage("두 파일 내용이 동일해서 diff 하이라이트가 없습니다.");
        return;
      }
      if (item.status === "typeChanged") {
        await openTypeChangedTransferDiff(item);
        return;
      }
      if (item.entryKind === "folder") {
        if (item.status === "added" || item.status === "removed") {
          await openFolderTransferDiff(item);
          return;
        }
        vscode.window.showInformationMessage("폴더 타입 변경은 텍스트 diff 대신 경로 정보를 확인해주세요.");
        return;
      }

      const emptyDoc = await vscode.workspace.openTextDocument({ language: "plaintext", content: "" });
      const srcDocPromise = vscode.workspace.openTextDocument(vscode.Uri.file(item.src));
      const dstDocPromise = vscode.workspace.openTextDocument(vscode.Uri.file(item.dst));
      let leftDoc: vscode.TextDocument;
      let rightDoc: vscode.TextDocument;
      if (item.status === "added") {
        leftDoc = emptyDoc;
        rightDoc = await srcDocPromise;
      } else if (item.status === "removed") {
        leftDoc = await dstDocPromise;
        rightDoc = emptyDoc;
      } else {
        leftDoc = await dstDocPromise;
        rightDoc = await srcDocPromise;
      }
      const title = `Diff: ${item.tool}/${item.relativePath}`;
      await vscode.commands.executeCommand("vscode.diff", leftDoc.uri, rightDoc.uri, title, {
        preview: true,
        preserveFocus: false
      });
    } catch {
      vscode.window.showInformationMessage("텍스트 diff를 열 수 없는 파일입니다.");
    }
  }

  async function openTypeChangedTransferDiff(item: TransferPlanItem): Promise<void> {
    const srcExists = await exists(item.src);
    const dstExists = await exists(item.dst);
    const srcStat = srcExists ? await fs.stat(item.src).catch(() => null) : null;
    const dstStat = dstExists ? await fs.stat(item.dst).catch(() => null) : null;
    const srcKind = srcStat ? (srcStat.isDirectory() ? "folder" : "file") : "none";
    const dstKind = dstStat ? (dstStat.isDirectory() ? "folder" : "file") : "none";

    const srcRows = srcKind === "folder" ? await collectFolderEntryRows(item.src) : [];
    const dstRows = dstKind === "folder" ? await collectFolderEntryRows(item.dst) : [];
    const panel = vscode.window.createWebviewPanel(
      "skillBridgeTypeChangedDiff",
      `Type Changed: ${item.tool}/${item.relativePath}`,
      vscode.ViewColumn.Active,
      { enableScripts: false }
    );
    panel.webview.html = renderTypeChangedTransferDiffHtml(panel.webview, {
      tool: item.tool,
      relativePath: item.relativePath,
      sourceKind: srcKind,
      targetKind: dstKind,
      sourceRows: srcRows,
      targetRows: dstRows
    });
  }

  async function openFolderTransferDiff(item: TransferPlanItem): Promise<void> {
    const [sourceRows, targetRows] = await Promise.all([
      collectFolderEntryRows(item.src),
      collectFolderEntryRows(item.dst)
    ]);
    const diffRows = buildFolderDiffRows(sourceRows, targetRows);
    const panel = vscode.window.createWebviewPanel(
      "skillBridgeFolderDiff",
      `Folder Diff: ${item.tool}/${item.relativePath}`,
      vscode.ViewColumn.Active,
      { enableScripts: false }
    );
    panel.webview.html = renderFolderTransferDiffHtml(panel.webview, {
      tool: item.tool,
      relativePath: item.relativePath,
      status: item.status,
      totalFiles: diffRows.length,
      totalSourceBytes: sourceRows.reduce((sum, entry) => sum + entry.size, 0),
      totalTargetBytes: targetRows.reduce((sum, entry) => sum + entry.size, 0),
      addedCount: diffRows.filter((entry) => entry.status === "A").length,
      removedCount: diffRows.filter((entry) => entry.status === "D").length,
      modifiedCount: diffRows.filter((entry) => entry.status === "M").length,
      sameCount: diffRows.filter((entry) => entry.status === "=").length,
      skillMdCount: diffRows.filter((entry) => /(^|\/)SKILL\.md$/i.test(entry.relativePath)).length,
      rows: diffRows
    });
  }

  async function createSkillFolder(side: "workspace" | "central", node?: SkillTreeNode): Promise<void> {
    try {
      if (!state.workspacePath || !state.centralRepoPath) await refresh();
      const basePath = side === "workspace" ? state.workspacePath : state.centralRepoPath;
      const baseNode = node ?? (side === "workspace" ? workspaceProvider.getSelected() : centralProvider.getSelected());
      const tool = baseNode?.tool ?? await pickTool();
      if (!tool) return;

      const toolRoot = getSkillRoot(basePath, tool, side);
      const baseRel = "skills";

      const name = await vscode.window.showInputBox({
        title: "새 스킬 폴더",
        prompt: "폴더 이름을 입력하세요",
        value: ""
      });
      if (!name?.trim()) return;

      const folderRel = normalizeRel(path.join(baseRel, name.trim()));
      if (!isManagedSkillPath(folderRel) || folderRel.includes("..")) {
        vscode.window.showWarningMessage("skills 폴더 하위만 생성할 수 있습니다.");
        return;
      }

      const folderPath = path.join(toolRoot, folderRel);
      if (await exists(folderPath)) {
        vscode.window.showWarningMessage("이미 같은 이름이 있습니다.");
        return;
      }

      await fs.mkdir(toolRoot, { recursive: true });
      await fs.mkdir(folderPath, { recursive: true });
      const skillPath = path.join(folderPath, "SKILL.md");
      await fs.writeFile(skillPath, "", "utf8");

      await refresh();
      vscode.window.showInformationMessage("스킬 생성 완료 (SKILL.md 포함)");
    } catch (error) {
      vscode.window.showErrorMessage(toUserError(error));
    }
  }

  async function pickTool(): Promise<ToolType | undefined> {
    const pick = await vscode.window.showQuickPick(
      [
        { label: ".claude", value: "claude" as ToolType },
        { label: ".codex", value: "codex" as ToolType },
        { label: ".gemini", value: "gemini" as ToolType },
        { label: ".cursor", value: "cursor" as ToolType },
        { label: ".antigravity", value: "antigravity" as ToolType },
        { label: ".agents", value: "agents" as ToolType }
      ],
      { title: "생성할 대상 선택" }
    );
    return pick?.value;
  }

  async function showGroupInfo(group: SelectionGroup): Promise<void> {
    if (group.targets.length === 0) {
      vscode.window.showWarningMessage("그룹에 항목이 없습니다.");
      return;
    }
    const db = await loadCentralSkillHistory();
    const sourceFiles = group.side === "workspace" ? state.workspaceSkills : state.centralSkills;
    const fileSelections = targetsToSelections(sourceFiles, group.targets);
    if (fileSelections.length === 0) {
      vscode.window.showWarningMessage("그룹 내부에서 표시할 파일을 찾지 못했습니다.");
      return;
    }

    const basePath = group.side === "workspace" ? state.workspacePath : state.centralRepoPath;
    const mode = group.side === "workspace" ? "workspace" : "central";
    const panel = vscode.window.createWebviewPanel(
      "skillBridgeGroupInfo",
      `Group Info: ${group.name}`,
      vscode.ViewColumn.Active,
      { enableScripts: false }
    );

    const rows: Array<{
      targetPath: string;
      kind: string;
      fileMtime: string;
      fileSize: string;
      latestAt: string;
      latestProject: string;
      latestSource: string;
    }> = [];

    const files = [...fileSelections].sort((a, b) => {
      const aIsSkill = /\/SKILL\.md$/i.test(a.relativePath) ? 0 : 1;
      const bIsSkill = /\/SKILL\.md$/i.test(b.relativePath) ? 0 : 1;
      if (aIsSkill !== bIsSkill) return aIsSkill - bIsSkill;
      const aKey = `${a.tool}/${a.relativePath}`;
      const bKey = `${b.tool}/${b.relativePath}`;
      return aKey.localeCompare(bKey);
    });

    for (const file of files) {
      const key = `${file.tool}:${normalizeRel(file.relativePath)}`;
      const history = db.records[key];
      const absolutePath = resolveSkillPath(basePath, file.tool, file.relativePath, mode);
      const stat = await fs.stat(absolutePath).catch(() => null);
      const isSkillMd = /\/SKILL\.md$/i.test(file.relativePath);

      rows.push({
        targetPath: `${file.tool}/${file.relativePath}`,
        kind: isSkillMd ? "SKILL.md" : "파일",
        fileMtime: stat ? stat.mtime.toISOString() : "-",
        fileSize: stat ? `${stat.size} B` : "-",
        latestAt: history?.lastUpdatedAt ?? "-",
        latestProject: history?.lastSourceProjectPath ?? "기록 없음",
        latestSource: history?.lastSourceAbsolutePath ?? "-"
      });
    }

    panel.webview.html = renderGroupInfoHtml(panel.webview, {
      name: group.name,
      side: group.side,
      count: rows.length,
      source: group.meta?.source ?? "manual",
      repoKey: group.meta?.repoKey ?? "-",
      repoUrl: group.meta?.repoUrl ?? "-",
      lastInstalledAt: group.meta?.lastInstalledAt ?? "-",
      mirroredFrom: group.meta?.mirroredFrom ?? "-",
      rows
    });
  }

  function suggestDuplicateName(name: string): string {
    const dot = name.lastIndexOf(".");
    if (dot <= 0) return `${name}-copy`;
    return `${name.slice(0, dot)}-copy${name.slice(dot)}`;
  }
}

export function deactivate(): void {
  // noop
}

function renderTransferManagerHtml(webview: vscode.Webview, plan: TransferPlan): string {
  const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const initial = JSON.stringify(plan).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Transfer Manager</title>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; height: 100vh; overflow: hidden; }
    .wrap { padding: 12px; display: grid; gap: 10px; height: 100vh; box-sizing: border-box; grid-template-rows: auto auto auto auto 1fr auto; }
    .head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    .meta { font-size: 12px; opacity: 0.9; display: flex; gap: 12px; flex-wrap: wrap; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; }
    .card { border: 1px solid var(--vscode-panel-border); padding: 8px; border-radius: 6px; }
    .card b { font-size: 18px; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .toolbar input, .toolbar select, .toolbar button { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 6px 8px; }
    .toolbar input { flex: 1 1 280px; min-width: 200px; }
    button { cursor: pointer; }
    .table-wrap { border: 1px solid var(--vscode-panel-border); border-radius: 6px; overflow: auto; min-height: 0; }
    table { width: max-content; min-width: 100%; border-collapse: collapse; font-size: 12px; }
    thead { background: var(--vscode-sideBar-background); }
    th, td { padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); text-align: left; }
    tbody tr:hover { background: var(--vscode-list-hoverBackground); }
    .status-added { color: #22c55e; }
    .status-removed { color: #ef4444; }
    .status-modified { color: #f59e0b; }
    .status-typeChanged { color: #fb7185; }
    .status-same { color: #94a3b8; }
    .change-code { font-weight: 800; font-size: 13px; }
    .relation-main { display: block; font-weight: 700; }
    .predict-box { border: 1px solid #f59e0b; color: #fbbf24; border-radius: 6px; padding: 8px; font-size: 12px; background: color-mix(in oklab, var(--vscode-editor-background) 88%, #f59e0b 12%); }
    .feedback { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px; font-size: 12px; }
    .feedback.warn { border-color: #f59e0b; color: #fbbf24; }
    .feedback.info { border-color: var(--vscode-panel-border); color: var(--vscode-foreground); }
    .path-main { max-width: 420px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: inline-block; vertical-align: bottom; }
    .path-sub { opacity: 0.85; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; max-width: 580px; }
    .foot { display: flex; justify-content: flex-end; gap: 8px; position: sticky; bottom: 0; padding-top: 8px; background: var(--vscode-editor-background); }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="head">
      <h2 style="margin:0;">Transfer Manager</h2>
      <div class="meta">
        <span id="modeLabel"></span>
        <span id="groupLabel"></span>
        <span id="repoLabel"></span>
      </div>
    </div>
    <div class="summary">
      <div class="card">신규 <b id="sumAdded">0</b></div>
      <div class="card">변경(수정+타입충돌) <b id="sumChanged">0</b></div>
      <div class="card">선택 반영 예정 <b id="sumSelectedApply">0</b></div>
    </div>
    <div id="feedback" class="feedback info">버튼을 누르면 여기에서 적용 결과를 안내합니다.</div>
    <div class="toolbar">
      <input id="search" placeholder="경로 검색..." />
      <select id="statusFilter">
        <option value="">전체 상태</option>
        <option value="added">신규</option>
        <option value="removed">삭제</option>
        <option value="modified">수정</option>
        <option value="typeChanged">타입충돌</option>
      </select>
      <button id="bulkSelectAll">전체 선택</button>
      <button id="bulkConflict">변경만 선택</button>
      <button id="refreshPlan">새로고침</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th><input id="toggleAllRows" type="checkbox" title="현재 목록 전체 선택/해제"></th>
            <th>관계 (현재 → 적용 후)</th>
            <th>상태</th>
            <th>소스 업데이트</th>
            <th>대상 업데이트</th>
            <th>액션</th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
    <div class="predict-box" id="predictText">예상 결과: 생성 0 / 덮어쓰기 0 / 삭제 0</div>
    <div class="foot">
      <button id="cancelBtn">취소</button>
      <button id="applyBtn">적용</button>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = ${initial};
    vscode.postMessage({ type: "initPlan" });
    const ui = {
      rows: document.getElementById("rows"),
      search: document.getElementById("search"),
      status: document.getElementById("statusFilter"),
      sumAdded: document.getElementById("sumAdded"),
      sumChanged: document.getElementById("sumChanged"),
      sumSelectedApply: document.getElementById("sumSelectedApply"),
      modeLabel: document.getElementById("modeLabel"),
      groupLabel: document.getElementById("groupLabel"),
      repoLabel: document.getElementById("repoLabel"),
      feedback: document.getElementById("feedback"),
      predictText: document.getElementById("predictText")
    };

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
    function getStatusLabel(status){
      if (status === "added") return "신규";
      if (status === "removed") return "삭제";
      if (status === "modified") return "수정";
      if (status === "typeChanged") return "타입충돌";
      return "동일";
    }
    function getStatusClass(status){
      if (status === "added") return "status-added";
      if (status === "removed") return "status-removed";
      if (status === "modified") return "status-modified";
      if (status === "typeChanged") return "status-typeChanged";
      return "status-same";
    }
    function getSourceTargetLabels(){
      if (state.mode === "workspaceToCentral") {
        return { source: "작업공간(현재)", target: "중앙(적용 후)" };
      }
      return { source: "중앙(현재)", target: "작업공간(적용 후)" };
    }
    function getDecisionText(it){
      const labels = getSourceTargetLabels();
      if (it.status === "added") return labels.source + "에는 있고 " + labels.target + "에는 없음";
      if (it.status === "removed") return labels.source + "에는 없고 " + labels.target + "에는 있음";
      if (it.status === "modified") return "양쪽 모두 존재, 내용 다름";
      if (it.status === "typeChanged") return "타입 불일치(파일/폴더)";
      return "양쪽 동일";
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
      ui.modeLabel.textContent = state.mode === "workspaceToCentral" ? "Workspace → Central" : "Central → Workspace";
      ui.groupLabel.textContent = state.groupContext ? ("그룹: " + state.groupContext.name) : "";
      ui.repoLabel.textContent = state.repoContext ? ("repo: " + state.repoContext.repo) : "";
      const baseSummaryItems = getStatsBaseItems(state.items);
      const added = baseSummaryItems.filter(it => it.status === "added").length;
      const modified = baseSummaryItems.filter(it => it.status === "modified").length;
      const typeChanged = baseSummaryItems.filter(it => it.status === "typeChanged").length;
      const selectedCount = state.items.filter(it => it.selected).length;
      const selectedBaseItems = getStatsBaseItems(state.items.filter(it => it.selected));
      const predictedCreate = selectedBaseItems.filter(it => it.status === "added").length;
      const predictedOverwrite = selectedBaseItems.filter(it => it.status === "modified" || it.status === "typeChanged").length;
      const predictedDelete = selectedBaseItems.filter(it => it.status === "removed").length;
      ui.sumAdded.textContent = String(added);
      ui.sumChanged.textContent = String(modified + typeChanged);
      ui.sumSelectedApply.textContent = String(selectedCount);
      ui.predictText.textContent = "예상 결과: 생성 " + predictedCreate + " / 덮어쓰기 " + predictedOverwrite + " / 삭제 " + predictedDelete + " (적용 후 되돌리기 어려움)";
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
        const diffLabel = isSame ? "동일 항목" : (isFolder ? "요약 Diff" : "Diff 보기");
        const diffDisabled = isSame ? "disabled" : "";
        return \`<tr>
          <td><input type="checkbox" data-kind="toggle" data-key="\${esc(it.key)}" \${checked}></td>
          <td title="\${esc(it.relativePath)} | \${esc(it.src)} -> \${esc(it.dst)}"><span class="path-main">\${esc(displayPath)}</span> <small>[\${esc(it.entryKind)}]</small><span class="relation-main">\${esc(labels.source)} → \${esc(labels.target)}</span><span class="path-sub">\${esc(getDecisionText(it))}</span></td>
          <td class="change-code \${esc(statusClass)}" title="\${esc(it.status)}">\${esc(statusLabel)}</td>
          <td title="\${esc(it.srcMtime ?? "-")}">\${esc(fmtDate(it.srcMtime))}</td>
          <td title="\${esc(it.dstMtime ?? "-")}">\${esc(fmtDate(it.dstMtime))}</td>
          <td><button data-kind="\${esc(actionKind)}" data-key="\${esc(it.key)}" data-tool="\${esc(it.tool)}" data-folder="\${esc(folderName)}" data-summary-keys="\${esc(summaryKeys.join(","))}" \${diffDisabled}>\${diffLabel}</button></td>
        </tr>\`;
      }).join("");
      if (selectedCount === 0) {
        setFeedback("선택된 항목이 없습니다. 현재 상태로 적용하면 복사되지 않습니다.", "warn");
      } else {
        setFeedback("선택된 항목 " + selectedCount + "개가 적용 대상입니다. 적용 전 예상 결과를 확인하세요.", "info");
      }
      syncMasterToggle();
      vscode.postMessage({ type: "filterChanged", payload: { status: ui.status.value, search: ui.search.value } });
    }

    function setBulk(kind){
      if (kind === "selectAll") state.items.forEach(it => { it.selected = true; });
      if (kind === "conflict") state.items.forEach(it => { it.selected = it.status === "added" || it.status === "modified" || it.status === "typeChanged"; });
      const afterSelected = state.items.filter(it => it.selected).length;
      if (kind === "selectAll") {
        setFeedback("전체 선택 적용: 모든 항목을 선택했습니다.", "info");
      } else if (kind === "conflict" && afterSelected === 0) {
        setFeedback("변경 선택 결과 변경 없음: 신규/수정/타입충돌 항목이 없습니다.", "warn");
      } else {
        setFeedback("일괄 작업 적용: 선택 " + afterSelected + "개", "info");
      }
      vscode.postMessage({ type: "bulkAction", payload: { kind } });
      render();
    }

    ui.search.addEventListener("input", render);
    ui.status.addEventListener("change", render);
    document.getElementById("bulkSelectAll").addEventListener("click", () => setBulk("selectAll"));
    document.getElementById("bulkConflict").addEventListener("click", () => setBulk("conflict"));
    document.getElementById("refreshPlan").addEventListener("click", () => {
      const keys = state.items.filter(it => it.selected).map(it => it.key);
      setFeedback("파일 상태를 다시 확인하고 있습니다...", "info");
      vscode.postMessage({ type: "refreshPlan", payload: { selectedKeys: keys } });
    });
    document.getElementById("cancelBtn").addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
    document.getElementById("applyBtn").addEventListener("click", () => {
      const keys = state.items.filter(it => it.selected).map(it => it.key);
      if (keys.length === 0) {
        setFeedback("적용할 항목이 없습니다. 선택 후 다시 시도하세요.", "warn");
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
          setFeedback("이 그룹은 표시할 diff가 없습니다.", "warn");
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
    render();
  </script>
</body>
</html>`;
}

function renderTransferExplorerHtml(
  webview: vscode.Webview,
  data: {
    tools: ToolType[];
    workspace: {
      folders: Array<{
        tool: ToolType;
        folder: string;
        fileCount: number;
        groupNames: string[];
        files: string[];
        subfolders: Array<{ path: string; fileCount: number }>;
      }>;
      groups: Array<{ id: string; name: string; targetSummary: string; targetCount: number; tools: ToolType[] }>;
    };
    central: {
      folders: Array<{
        tool: ToolType;
        folder: string;
        fileCount: number;
        groupNames: string[];
        files: string[];
        subfolders: Array<{ path: string; fileCount: number }>;
      }>;
      groups: Array<{ id: string; name: string; targetSummary: string; targetCount: number; tools: ToolType[] }>;
    };
  }
): string {
  const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const initial = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Transfer Explorer</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; font-family: var(--vscode-font-family); background: var(--vscode-editor-background); color: var(--vscode-foreground); }
    .wrap { padding: 12px; display: grid; gap: 10px; height: 100vh; box-sizing: border-box; grid-template-rows: auto auto 1fr; }
    .head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .title { font-weight: 700; }
    .hint { font-size: 12px; color: var(--vscode-descriptionForeground); }
    .tabs { display: flex; gap: 6px; flex-wrap: wrap; }
    .tab { border: 1px solid var(--vscode-panel-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border-radius: 999px; padding: 4px 10px; font-size: 12px; cursor: pointer; }
    .tab.active { border-color: #3b82f6; color: #93c5fd; }
    .actions { display: flex; gap: 8px; align-items: center; }
    .actions input, .actions button { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 6px 10px; }
    .actions input { min-width: 220px; }
    .actions button { cursor: pointer; }
    .grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; min-height: 0; }
    .pane { border: 1px solid var(--vscode-panel-border); border-radius: 8px; display: grid; grid-template-rows: auto 1fr; min-height: 0; }
    .pane-head { padding: 10px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); font-weight: 700; display: flex; justify-content: space-between; gap: 8px; }
    .dropzone { padding: 10px; overflow: auto; display: grid; gap: 10px; min-height: 0; }
    .dropzone.drag-over { outline: 2px dashed #3b82f6; outline-offset: -2px; }
    .section { display: grid; gap: 6px; }
    .section h4 { margin: 0; font-size: 12px; color: var(--vscode-descriptionForeground); }
    .row { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px; display: grid; gap: 6px; background: var(--vscode-editor-background); }
    .row[draggable="true"] { cursor: grab; }
    .row-top { display: flex; justify-content: space-between; align-items: center; gap: 8px; min-width: 0; }
    .row-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .toggle-btn { border: 1px solid var(--vscode-panel-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border-radius: 4px; width: 22px; height: 22px; cursor: pointer; padding: 0; line-height: 20px; }
    .name { font-weight: 700; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .meta { font-size: 12px; color: var(--vscode-descriptionForeground); }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip { font-size: 11px; border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 1px 8px; color: var(--vscode-descriptionForeground); }
    .move-btn { border: 1px solid var(--vscode-panel-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border-radius: 4px; padding: 4px 8px; cursor: pointer; }
    .children { border-top: 1px dashed var(--vscode-panel-border); padding-top: 6px; display: grid; gap: 6px; }
    .child-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 6px 8px; }
    .child-path { font-size: 12px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .child-meta { font-size: 11px; color: var(--vscode-descriptionForeground); }
    .status { font-size: 12px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px; }
    .status.warn { border-color: #f59e0b; color: #f59e0b; }
    .status.error { border-color: #ef4444; color: #ef4444; }
    .disabled { opacity: 0.6; pointer-events: none; }
    .actions { width: 100%; }
    .actions input { flex: 1 1 auto; min-width: 0; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="head">
      <div class="title">Transfer Explorer</div>
      <div class="actions">
        <input id="searchInput" placeholder="폴더/그룹 검색..." />
        <button id="refreshBtn">새로고침</button>
      </div>
    </div>
    <div class="tabs" id="toolTabs"></div>
    <div class="hint">All/에이전트 탭으로 범위를 좁히고, 폴더를 펼쳐 파일(SKILL.md 포함) 또는 하위 폴더 단위로 전송할 수 있습니다.</div>
    <div id="statusLine" class="status">준비 완료</div>
    <div class="grid">
      <section class="pane">
        <div class="pane-head"><span>Workspace</span><span id="workspaceCount" class="meta"></span></div>
        <div class="dropzone" data-side="workspace" id="workspaceDrop"></div>
      </section>
      <section class="pane">
        <div class="pane-head"><span>Central</span><span id="centralCount" class="meta"></span></div>
        <div class="dropzone" data-side="central" id="centralDrop"></div>
      </section>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let state = ${initial};
    const uiState = { query: "", busy: false, selectedTool: "all", expanded: {} };

    function esc(v){ return String(v ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;"); }
    function matchesQuery(value){
      const q = uiState.query.trim().toLowerCase();
      if (!q) return true;
      return String(value || "").toLowerCase().includes(q);
    }
    function setStatus(message, tone){
      const el = document.getElementById("statusLine");
      el.textContent = message || "준비 완료";
      el.className = "status " + (tone || "");
    }
    function passesTool(tool){
      return uiState.selectedTool === "all" || uiState.selectedTool === tool;
    }
    function renderTabs(){
      const root = document.getElementById("toolTabs");
      const tools = Array.isArray(state.tools) ? state.tools : [];
      const all = ["all", ...tools];
      root.innerHTML = all.map((tool) => {
        const label = tool === "all" ? "All" : tool;
        const cls = uiState.selectedTool === tool ? "tab active" : "tab";
        return '<button class="' + cls + '" data-action="tab" data-tool="' + esc(tool) + '">' + esc(label) + '</button>';
      }).join("");
      root.querySelectorAll("[data-action='tab']").forEach((button) => {
        button.addEventListener("click", () => {
          uiState.selectedTool = button.getAttribute("data-tool") || "all";
          render();
        });
      });
    }
    function makePathPayload(sourceSide, tool, relativePath, kind){
      return {
        kind: "path",
        sourceSide,
        tool,
        relativePath,
        pathKind: kind
      };
    }

    function renderSection(side){
      const pane = state[side];
      const moveLabel = side === "workspace" ? "→" : "←";
      const filteredFolders = pane.folders.filter((item) => passesTool(item.tool) && matchesQuery(item.tool + " " + item.folder + " " + (item.groupNames || []).join(" ")));
      const filteredGroups = pane.groups.filter((group) => {
        const hasTool = uiState.selectedTool === "all" || (group.tools || []).includes(uiState.selectedTool);
        return hasTool && matchesQuery(group.name + " " + group.targetSummary);
      });
      const folderRows = filteredFolders.map((item) => {
        const chips = (item.groupNames || []).map((name) => '<span class="chip">' + esc(name) + '</span>').join("");
        const folderKey = side + ":" + item.tool + ":" + item.folder;
        const expanded = !!uiState.expanded[folderKey];
        const rootPath = "skills/" + item.folder;
        const childFiles = (item.files || []).map((relativeFile) => {
          const fullPath = rootPath + "/" + relativeFile;
          return '<div class="child-row' + (uiState.busy ? ' disabled' : '') + '" draggable="' + (uiState.busy ? "false" : "true") + '" data-kind="path" data-side="' + esc(side) + '" data-tool="' + esc(item.tool) + '" data-path-kind="file" data-relative-path="' + esc(fullPath) + '">' +
            '<div><div class="child-path">' + esc(relativeFile) + '</div><div class="child-meta">파일</div></div>' +
            '<button class="move-btn" ' + (uiState.busy ? "disabled " : "") + 'data-action="move-path" data-side="' + esc(side) + '" data-tool="' + esc(item.tool) + '" data-path-kind="file" data-relative-path="' + esc(fullPath) + '">' + moveLabel + '</button>' +
          '</div>';
        }).join("");
        const childFolders = (item.subfolders || []).map((sub) => {
          const fullPath = rootPath + "/" + sub.path;
          return '<div class="child-row' + (uiState.busy ? ' disabled' : '') + '" draggable="' + (uiState.busy ? "false" : "true") + '" data-kind="path" data-side="' + esc(side) + '" data-tool="' + esc(item.tool) + '" data-path-kind="folder" data-relative-path="' + esc(fullPath) + '">' +
            '<div><div class="child-path">' + esc(sub.path + "/") + '</div><div class="child-meta">하위 폴더 · 파일 ' + esc(sub.fileCount) + '개</div></div>' +
            '<button class="move-btn" ' + (uiState.busy ? "disabled " : "") + 'data-action="move-path" data-side="' + esc(side) + '" data-tool="' + esc(item.tool) + '" data-path-kind="folder" data-relative-path="' + esc(fullPath) + '">' + moveLabel + '</button>' +
          '</div>';
        }).join("");
        const children = expanded
          ? '<div class="children">' + (childFolders || "") + (childFiles || "") + (childFolders || childFiles ? "" : '<div class="meta">하위 항목 없음</div>') + '</div>'
          : "";
        return '<div class="row' + (uiState.busy ? ' disabled' : '') + '" draggable="' + (uiState.busy ? "false" : "true") + '" data-kind="path" data-side="' + esc(side) + '" data-tool="' + esc(item.tool) + '" data-path-kind="folder" data-relative-path="' + esc(rootPath) + '">' +
          '<div class="row-top"><div class="row-title"><button class="toggle-btn" data-action="toggle-folder" data-folder-key="' + esc(folderKey) + '">' + (expanded ? "▾" : "▸") + '</button><span class="name">' + esc(item.tool + "/" + rootPath) + '</span></div><button class="move-btn" ' + (uiState.busy ? "disabled " : "") + 'aria-label="폴더 이동" data-action="move-path" data-side="' + esc(side) + '" data-tool="' + esc(item.tool) + '" data-path-kind="folder" data-relative-path="' + esc(rootPath) + '">' + moveLabel + '</button></div>' +
          '<div class="meta">파일 ' + esc(item.fileCount) + '개</div>' +
          '<div class="chips">' + chips + '</div>' +
          children +
        '</div>';
      }).join("");
      const groupRows = filteredGroups.map((group) => (
        '<div class="row' + (uiState.busy ? ' disabled' : '') + '" draggable="' + (uiState.busy ? "false" : "true") + '" data-kind="group" data-side="' + esc(side) + '" data-group-id="' + esc(group.id) + '">' +
          '<div class="row-top"><span class="name">' + esc(group.name) + '</span><button class="move-btn" ' + (uiState.busy ? "disabled " : "") + 'aria-label="그룹 이동" data-action="move-group" data-side="' + esc(side) + '" data-group-id="' + esc(group.id) + '">' + moveLabel + '</button></div>' +
          '<div class="meta">' + esc(group.targetSummary) + ' · 타깃 ' + esc(group.targetCount) + '개 · 에이전트 ' + esc((group.tools || []).join(", ")) + '</div>' +
        '</div>'
      )).join("");
      const countEl = document.getElementById(side === "workspace" ? "workspaceCount" : "centralCount");
      if (countEl) {
        countEl.textContent = "폴더 " + filteredFolders.length + " · 그룹 " + filteredGroups.length;
      }
      return '<div class="section"><h4>Skill Folder</h4>' + (folderRows || '<div class="meta">항목 없음</div>') + '</div>'
        + '<div class="section"><h4>Group</h4>' + (groupRows || '<div class="meta">그룹 없음</div>') + '</div>';
    }

    function render(){
      renderTabs();
      document.getElementById("workspaceDrop").innerHTML = renderSection("workspace");
      document.getElementById("centralDrop").innerHTML = renderSection("central");
      bindRows();
    }

    function bindRows(){
      document.querySelectorAll('.row[draggable="true"]').forEach((row) => {
        row.addEventListener("dragstart", (ev) => {
          const kind = row.getAttribute("data-kind") || "";
          const payload = kind === "group"
            ? {
              kind: "group",
              sourceSide: row.getAttribute("data-side") || "",
              groupId: row.getAttribute("data-group-id") || ""
            }
            : makePathPayload(
              row.getAttribute("data-side") || "",
              row.getAttribute("data-tool") || "",
              row.getAttribute("data-relative-path") || "",
              row.getAttribute("data-path-kind") || "folder"
            );
          ev.dataTransfer?.setData("application/skill-bridge-transfer", JSON.stringify(payload));
          ev.dataTransfer?.setData("text/plain", JSON.stringify(payload));
        });
      });

      document.querySelectorAll("[data-action='toggle-folder']").forEach((button) => {
        button.addEventListener("click", () => {
          const key = button.getAttribute("data-folder-key") || "";
          if (!key) return;
          uiState.expanded[key] = !uiState.expanded[key];
          render();
        });
      });
      document.querySelectorAll("[data-action='move-path']").forEach((button) => {
        button.addEventListener("click", () => {
          if (uiState.busy) return;
          vscode.postMessage({
            type: "movePath",
            payload: {
              sourceSide: button.getAttribute("data-side"),
              tool: button.getAttribute("data-tool"),
              relativePath: button.getAttribute("data-relative-path"),
              kind: button.getAttribute("data-path-kind")
            }
          });
        });
      });
      document.querySelectorAll("[data-action='move-group']").forEach((button) => {
        button.addEventListener("click", () => {
          if (uiState.busy) return;
          vscode.postMessage({
            type: "moveGroup",
            payload: {
              sourceSide: button.getAttribute("data-side"),
              groupId: button.getAttribute("data-group-id")
            }
          });
        });
      });
    }

    function bindDropzone(el){
      el.addEventListener("dragover", (ev) => {
        if (uiState.busy) return;
        ev.preventDefault();
        el.classList.add("drag-over");
      });
      el.addEventListener("dragleave", () => {
        el.classList.remove("drag-over");
      });
      el.addEventListener("drop", (ev) => {
        if (uiState.busy) return;
        ev.preventDefault();
        el.classList.remove("drag-over");
        const raw = ev.dataTransfer?.getData("application/skill-bridge-transfer")
          || ev.dataTransfer?.getData("text/plain")
          || "";
        if (!raw) return;
        let payload;
        try { payload = JSON.parse(raw); } catch { return; }
        if (!payload || typeof payload !== "object") return;
        const targetSide = el.getAttribute("data-side");
        if (payload.sourceSide === targetSide) {
          setStatus("같은 패널로는 이동되지 않습니다. 반대 패널로 드롭하세요.", "warn");
          return;
        }
        if (payload.kind === "path") {
          vscode.postMessage({
            type: "movePath",
            payload: {
              sourceSide: payload.sourceSide,
              tool: payload.tool,
              relativePath: payload.relativePath,
              kind: payload.pathKind
            }
          });
        } else if (payload.kind === "group") {
          vscode.postMessage({ type: "moveGroup", payload: { sourceSide: payload.sourceSide, groupId: payload.groupId } });
        }
      });
    }

    bindDropzone(document.getElementById("workspaceDrop"));
    bindDropzone(document.getElementById("centralDrop"));

    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "state") {
        state = msg.payload || state;
        render();
      }
      if (msg.type === "ui") {
        const payload = msg.payload || {};
        if (typeof payload.busy === "boolean") uiState.busy = payload.busy;
        setStatus(payload.message || (uiState.busy ? "작업 중..." : "준비 완료"), payload.tone || "info");
        render();
      }
    });

    document.getElementById("searchInput").addEventListener("input", (ev) => {
      const target = ev.target;
      if (!(target instanceof HTMLInputElement)) return;
      uiState.query = target.value || "";
      render();
    });

    document.getElementById("refreshBtn").addEventListener("click", () => {
      if (uiState.busy) return;
      vscode.postMessage({ type: "refresh" });
    });

    render();
  </script>
</body>
</html>`;
}

function renderLibraryManagerHtml(
  webview: vscode.Webview,
  data: {
    tools: ToolType[];
    workspace: {
      entries: Array<{
        key: string;
        tool: ToolType;
        relativePath: string;
        folder: string;
        innerPath: string;
        exists: boolean;
        status: "added" | "removed" | "modified" | "typeChanged" | "same";
        groupIds: string[];
        groupNames: string[];
      }>;
      groups: Array<{ id: string; name: string; targetSummary: string; targetCount: number; tools: ToolType[] }>;
    };
    central: {
      entries: Array<{
        key: string;
        tool: ToolType;
        relativePath: string;
        folder: string;
        innerPath: string;
        exists: boolean;
        status: "added" | "removed" | "modified" | "typeChanged" | "same";
        groupIds: string[];
        groupNames: string[];
      }>;
      groups: Array<{ id: string; name: string; targetSummary: string; targetCount: number; tools: ToolType[] }>;
    };
    diagnostics: {
      workspaceMissingSkillFolders: Array<{ tool: ToolType; relativePath: string }>;
      centralMissingSkillFolders: Array<{ tool: ToolType; relativePath: string }>;
    };
  }
): string {
  const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const escHtml = (value: string): string =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const statusLabel = (status: "added" | "removed" | "modified" | "typeChanged" | "same"): string => {
    if (status === "added") return "신규";
    if (status === "removed") return "삭제";
    if (status === "modified") return "수정";
    if (status === "typeChanged") return "타입충돌";
    return "동일";
  };
  const statusClass = (status: "added" | "removed" | "modified" | "typeChanged" | "same"): string => {
    if (status === "added") return "s-added";
    if (status === "removed") return "s-removed";
    if (status === "modified") return "s-modified";
    if (status === "typeChanged") return "s-typeChanged";
    return "s-same";
  };
  const summarizeSkillStatus = (statuses: Array<"added" | "removed" | "modified" | "typeChanged" | "same">): "added" | "removed" | "modified" | "typeChanged" | "same" => {
    if (statuses.some((s) => s === "typeChanged")) return "typeChanged";
    if (statuses.some((s) => s === "modified")) return "modified";
    const hasAdded = statuses.some((s) => s === "added");
    const hasRemoved = statuses.some((s) => s === "removed");
    if (hasAdded && hasRemoved) return "modified";
    if (hasAdded) return "added";
    if (hasRemoved) return "removed";
    return "same";
  };
  const toSkillSnapshots = (entries: Array<{ tool: ToolType; folder: string; status: "added" | "removed" | "modified" | "typeChanged" | "same" }>): Array<{ tool: ToolType; relativePath: string; status: "added" | "removed" | "modified" | "typeChanged" | "same" }> => {
    const map = new Map<string, { tool: ToolType; relativePath: string; statuses: Array<"added" | "removed" | "modified" | "typeChanged" | "same"> }>();
    for (const entry of entries) {
      const relativePath = `skills/${entry.folder}`;
      const key = `${entry.tool}:${relativePath}`;
      const prev = map.get(key) ?? { tool: entry.tool, relativePath, statuses: [] };
      prev.statuses.push(entry.status);
      map.set(key, prev);
    }
    return [...map.values()]
      .map((e) => ({ tool: e.tool, relativePath: e.relativePath, status: summarizeSkillStatus(e.statuses) }))
      .sort((a, b) => a.tool.localeCompare(b.tool) || a.relativePath.localeCompare(b.relativePath));
  };
  const buildStaticRows = (entries: Array<{ tool: ToolType; relativePath: string; status: "added" | "removed" | "modified" | "typeChanged" | "same" }>): string => {
    if (entries.length === 0) return '<div class="empty"><div class="empty-title">로딩 중...</div><div class="empty-reason">새로고침을 눌러 조회하세요.</div></div>';
    const rows = entries.slice(0, 80).map((e) => `<div class="static-row"><span class="static-path">${escHtml(e.tool)}/${escHtml(e.relativePath)}</span><span class="badge ${statusClass(e.status)}">${statusLabel(e.status)}</span></div>`).join("");
    const more = entries.length > 80 ? `<div class="static-more">외 ${entries.length - 80}개 항목</div>` : "";
    return `${rows}${more}`;
  };
  const initialTabs = ["all", ...data.tools]
    .map((tool) => `<button class="tab ${tool === "all" ? "active" : ""}" data-action="tab" data-tool="${escHtml(tool)}">${escHtml(tool === "all" ? "All" : tool)}</button>`)
    .join("");
  const workspaceSkills = toSkillSnapshots(data.workspace.entries);
  const centralSkills = toSkillSnapshots(data.central.entries);
  const workspaceCountLabel = `스킬 ${workspaceSkills.length} · 변경 ${workspaceSkills.filter((e) => e.status !== "same").length} · 그룹 ${data.workspace.groups.length}`;
  const centralCountLabel = `스킬 ${centralSkills.length} · 변경 ${centralSkills.filter((e) => e.status !== "same").length} · 그룹 ${data.central.groups.length}`;
  const initialStatus = "로딩 중... 새로고침을 눌러 조회하세요.";
  const workspaceStaticRows = buildStaticRows(workspaceSkills);
  const centralStaticRows = buildStaticRows(centralSkills);
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Skill Library Manager</title>
  <style>
    body { margin: 0; font-family: var(--vscode-font-family); background: var(--vscode-editor-background); color: var(--vscode-foreground); }
    .wrap { box-sizing: border-box; height: 100vh; padding: 8px; display: grid; gap: 6px; grid-template-rows: auto auto 1fr; }
    .head { display: flex; flex-direction: column; gap: 6px; }
    .head-main { display: flex; justify-content: space-between; gap: 8px; align-items: center; flex-wrap: wrap; }
    .title { font-size: 15px; font-weight: 700; }
    .controls, .pane-controls { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; min-width: 0; }
    .pane-controls > * { min-width: 0; }
    input, button, select { max-width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 5px 9px; font: inherit; }
    .input-like { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 5px 9px; font: inherit; }
    input { min-width: 240px; }
    button { cursor: pointer; }
    .tabs { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
    .tabs-title { font-size: 11px; color: var(--vscode-descriptionForeground); margin-right: 2px; }
    .tab { border-radius: 6px; padding: 3px 9px; font-size: 12px; }
    .tab.active { border-color: #60a5fa; color: #bfdbfe; }
    .status { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 6px 8px; font-size: 11px; color: var(--vscode-descriptionForeground); }
    .status.warn { border-color: #f59e0b; color: #f59e0b; }
    .status.error { border-color: #ef4444; color: #ef4444; }
    .grid { min-height: 0; display: grid; grid-template-columns: minmax(420px,1fr) minmax(420px,1fr); gap: 8px; overflow-x: auto; }
    .pane { min-height: 0; border: 1px solid var(--vscode-panel-border); border-radius: 10px; display: grid; grid-template-rows: auto auto auto auto 1fr; overflow: hidden; }
    .pane-head { display: flex; justify-content: space-between; gap: 8px; align-items: center; padding: 8px; font-weight: 700; background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-panel-border); }
    .meta { font-size: 12px; color: var(--vscode-descriptionForeground); }
    .pane-controls { padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
    .pane-meta { display: none; }
    .grow { flex: 1 1 auto; min-width: 180px; }
    .group-filter-wrap { position: relative; flex: 1 1 0; min-width: 0; max-width: 100%; }
    .group-filter-trigger { width: 100%; text-align: left; display: inline-flex; justify-content: space-between; align-items: center; gap: 8px; min-height: 34px; }
    .group-filter-trigger::after { content: "▾"; font-size: 11px; color: var(--vscode-descriptionForeground); }
    .group-filter-wrap.open .group-filter-trigger { border-color: #60a5fa; box-shadow: inset 0 0 0 1px rgba(96,165,250,.35); }
    .group-filter-menu { position: absolute; z-index: 30; top: calc(100% + 4px); left: 0; width: 100%; max-width: 100%; border: 1px solid var(--vscode-panel-border); border-radius: 8px; background: var(--vscode-sideBar-background); padding: 8px; display: grid; gap: 6px; overflow: hidden; box-shadow: 0 8px 22px rgba(0,0,0,.35); }
    .group-filter-menu[hidden] { display: none; }
    .group-filter-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .group-filter-row .btn { font-size: 11px; padding: 3px 8px; }
    .group-search { width: 100%; max-width: 100%; min-width: 0; }
    .group-options { min-width: 0; max-width: 100%; max-height: 180px; overflow: auto; overflow-x: hidden; border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 6px; display: grid; gap: 4px; background: var(--vscode-editor-background); }
    .group-option { min-width: 0; display: flex; align-items: center; gap: 6px; border-radius: 6px; padding: 4px 6px; }
    .group-option:hover { background: rgba(148,163,184,.08); }
    .group-option input { margin: 0; min-width: 0; }
    .group-empty { font-size: 12px; color: var(--vscode-descriptionForeground); }
    .tags { display: flex; flex-wrap: wrap; gap: 4px; }
    .tag { font-size: 11px; border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 1px 8px; color: var(--vscode-descriptionForeground); }
    .pane-meta .tags { margin-top: 6px; }
    .tree { min-height: 0; overflow: auto; padding: 6px; display: grid; align-content: start; gap: 4px; }
    .tree.drag-over { outline: 2px dashed #60a5fa; outline-offset: -2px; border-radius: 8px; }
    .node { display: grid; gap: 4px; }
    .row { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 5px 7px; display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 8px; align-items: center; background: var(--vscode-editor-background); }
    .row[draggable="true"] { cursor: grab; }
    .row.selected { border-color: #60a5fa; box-shadow: inset 0 0 0 1px rgba(96,165,250,.4); }
    .row.muted { opacity: .7; }
    .left { min-width: 0; display: grid; gap: 2px; }
    .line1 { min-width: 0; display: flex; align-items: center; gap: 6px; overflow: hidden; }
    .toggle { width: 20px; height: 20px; padding: 0; line-height: 18px; }
    .toggle.placeholder { visibility: hidden; pointer-events: none; }
    .label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
    .sub { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--vscode-descriptionForeground); }
    .right { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
    .badge { font-size: 11px; border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 1px 8px; font-weight: 600; }
    .s-added { color: #34d399; border-color: #34d399; }
    .s-modified { color: #fbbf24; border-color: #fbbf24; }
    .s-removed { color: #fb7185; border-color: #fb7185; }
    .s-typeChanged { color: #f472b6; border-color: #f472b6; }
    .s-same { color: #94a3b8; border-color: #94a3b8; }
    .btn { padding: 2px 8px; font-size: 11px; }
    .btn:disabled { opacity: .5; cursor: default; }
    .empty { border: 1px dashed var(--vscode-panel-border); border-radius: 8px; padding: 12px; color: var(--vscode-descriptionForeground); font-size: 12px; display: grid; gap: 8px; justify-items: start; }
    .empty-title { font-size: 13px; color: var(--vscode-foreground); }
    .empty-reason { color: var(--vscode-descriptionForeground); }
    .empty-actions { display: flex; gap: 6px; flex-wrap: wrap; }
    .empty .btn { padding: 4px 10px; font-size: 12px; }
    .disabled { opacity: .55; pointer-events: none; }
    .static-row { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 6px 8px; display: flex; justify-content: space-between; gap: 8px; align-items: center; }
    .static-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
    .static-more { font-size: 12px; color: var(--vscode-descriptionForeground); padding: 4px 2px; }
    .group-filter-wrap { min-width: 0; }
    .controls { width: 100%; }
    .controls input { min-width: 0; width: min(460px, 100%); }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="head">
      <div class="head-main">
        <div class="title">Skill Library Manager</div>
        <div class="controls">
          <select id="groupingMode"><option value="agent">에이전트 우선</option><option value="group">그룹 우선</option></select>
          <label class="meta"><input id="changedOnly" type="checkbox" /> 변경만</label>
          <input id="searchInput" type="text" placeholder="파일/폴더/그룹 검색..." />
          <button id="refreshBtn">새로고침</button>
        </div>
      </div>
      <div class="tabs">
        <span class="tabs-title">에이전트 탭</span>
        <div id="toolTabs" class="tabs">${initialTabs}</div>
      </div>
    </div>
    <div id="statusLine" class="status">${escHtml(initialStatus)}</div>
    <div class="grid">
      <section class="pane">
        <div class="pane-head"><span>Workspace</span><span id="workspaceCount" class="meta">${escHtml(workspaceCountLabel)}</span></div>
        <div class="pane-controls">
          <div class="group-filter-wrap" data-side="workspace">
            <button id="workspaceGroupFilterTrigger" class="group-filter-trigger input-like" data-action="group-filter-toggle" data-side="workspace" type="button" aria-haspopup="listbox" aria-expanded="false">그룹 필터: 전체</button>
            <div id="workspaceGroupFilterMenu" class="group-filter-menu" hidden>
              <div class="group-filter-row">
                <button class="btn" data-action="group-filter-select-all" data-side="workspace" type="button">전체 선택</button>
                <button class="btn" data-action="group-filter-clear" data-side="workspace" type="button">전체 해제</button>
              </div>
              <input id="workspaceGroupFilterSearch" class="group-search" type="text" placeholder="그룹 검색..." />
              <label class="group-option"><input id="workspaceGroupUngrouped" data-action="group-option-ungrouped" data-side="workspace" type="checkbox" />미분류</label>
              <div id="workspaceGroupFilterOptions" class="group-options" role="listbox" aria-label="Workspace 그룹 필터 목록"></div>
            </div>
          </div>
          <button data-side="workspace" data-action="group-create" type="button">새 그룹</button>
        </div>
        <div id="workspaceGroupPicked" class="pane-meta">그룹 필터: 전체</div>
        <div class="pane-controls"><span id="workspaceSelectedHint" class="meta">선택 없음</span><button data-side="workspace" data-action="group-assign">선택 할당</button><button data-side="workspace" data-action="group-unassign">선택 해제</button><button data-side="workspace" data-action="move-group">그룹 이동 →</button><button data-side="workspace" data-action="move-selected">선택 이동 →</button></div>
        <div id="workspaceTree" class="tree" data-side="workspace">${workspaceStaticRows}</div>
      </section>
      <section class="pane">
        <div class="pane-head"><span>Central</span><span id="centralCount" class="meta">${escHtml(centralCountLabel)}</span></div>
        <div class="pane-controls">
          <div class="group-filter-wrap" data-side="central">
            <button id="centralGroupFilterTrigger" class="group-filter-trigger input-like" data-action="group-filter-toggle" data-side="central" type="button" aria-haspopup="listbox" aria-expanded="false">그룹 필터: 전체</button>
            <div id="centralGroupFilterMenu" class="group-filter-menu" hidden>
              <div class="group-filter-row">
                <button class="btn" data-action="group-filter-select-all" data-side="central" type="button">전체 선택</button>
                <button class="btn" data-action="group-filter-clear" data-side="central" type="button">전체 해제</button>
              </div>
              <input id="centralGroupFilterSearch" class="group-search" type="text" placeholder="그룹 검색..." />
              <label class="group-option"><input id="centralGroupUngrouped" data-action="group-option-ungrouped" data-side="central" type="checkbox" />미분류</label>
              <div id="centralGroupFilterOptions" class="group-options" role="listbox" aria-label="Central 그룹 필터 목록"></div>
            </div>
          </div>
          <button data-side="central" data-action="group-create" type="button">새 그룹</button>
        </div>
        <div id="centralGroupPicked" class="pane-meta">그룹 필터: 전체</div>
        <div class="pane-controls"><span id="centralSelectedHint" class="meta">선택 없음</span><button data-side="central" data-action="group-assign">선택 할당</button><button data-side="central" data-action="group-unassign">선택 해제</button><button data-side="central" data-action="move-group">그룹 이동 ←</button><button data-side="central" data-action="move-selected">선택 이동 ←</button></div>
        <div id="centralTree" class="tree" data-side="central">${centralStaticRows}</div>
      </section>
    </div>
  </div>
  <script nonce="${nonce}">
    (() => {
      let bootApi = null;
      try {
    const vscode = acquireVsCodeApi();
    bootApi = vscode;
    const EMPTY_STATE = {
      tools: [],
      workspace: { entries: [], groups: [] },
      central: { entries: [], groups: [] },
      diagnostics: { workspaceMissingSkillFolders: [], centralMissingSkillFolders: [] }
    };
    let state = EMPTY_STATE;
    const GROUP_UNASSIGNED = "__ungrouped__";
    const uiState = { busy:false, query:"", tool:"all", grouping:"agent", changedOnly:false, expanded:{}, selectedNodes:{ workspace:[], central:[] }, selectionAnchor:{ workspace:"", central:"" }, selectedGroups:{ workspace:[], central:[] }, groupSearch:{ workspace:"", central:"" }, groupMenuOpen:{ workspace:false, central:false } };
    const statusInfo = { added:{label:"신규",cls:"s-added"}, modified:{label:"수정",cls:"s-modified"}, removed:{label:"삭제",cls:"s-removed"}, typeChanged:{label:"타입충돌",cls:"s-typeChanged"}, same:{label:"동일",cls:"s-same"} };
    function esc(v){ return String(v ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;"); }
    function norm(v){ return String(v || "").replaceAll("\\\\","/"); }
    function isPathNode(t){ return t === "file" || t === "folder"; }
    function statusRank(status){ if (status === "typeChanged") return 4; if (status === "modified") return 3; if (status === "added" || status === "removed") return 2; return 1; }
    function summarizeStatus(list){ const a = (Array.isArray(list) ? list : []).filter(Boolean); if (a.some((s)=>s==="typeChanged")) return "typeChanged"; if (a.some((s)=>s==="modified")) return "modified"; const ad = a.some((s)=>s==="added"); const rm = a.some((s)=>s==="removed"); if (ad && rm) return "modified"; if (ad) return "added"; if (rm) return "removed"; return "same"; }
    function setStatus(msg,tone){ const el = document.getElementById("statusLine"); el.textContent = msg || "준비 완료"; el.className = "status " + (tone || ""); }
    window.addEventListener("error",(ev)=>{ setStatus("화면 오류: " + (ev.message || "알 수 없는 오류"), "error"); });
    window.addEventListener("unhandledrejection",(ev)=>{ const reason = ev.reason && ev.reason.message ? ev.reason.message : String(ev.reason || "알 수 없는 오류"); setStatus("화면 오류: " + reason, "error"); });
    function toolPass(tool){ return uiState.tool === "all" || uiState.tool === tool; }
    function textPass(text){ const q = uiState.query.trim().toLowerCase(); if (!q) return true; return String(text || "").toLowerCase().includes(q); }
    function getSide(side){ return side === "workspace" ? state.workspace : state.central; }
    function getSideGroupsAll(side){ const groups = Array.isArray(getSide(side)?.groups) ? getSide(side).groups : []; return groups.filter((g)=>(uiState.tool==="all" || (Array.isArray(g.tools) && g.tools.includes(uiState.tool)))); }
    function getSideGroups(side){ const groups = getSideGroupsAll(side); return groups.filter((g)=>textPass(g.name + " " + g.targetSummary)); }
    function selectedGroupIds(side){
      const allGroups = getSideGroupsAll(side);
      const selected = Array.isArray(uiState.selectedGroups[side]) ? uiState.selectedGroups[side] : [];
      const valid = selected.filter((id)=>id === GROUP_UNASSIGNED || allGroups.some((g)=>g.id===id));
      uiState.selectedGroups[side] = valid;
      return valid;
    }
    function selectedConcreteGroupIds(side){
      return selectedGroupIds(side).filter((id)=>id !== GROUP_UNASSIGNED);
    }
    function selectedHasUngrouped(side){
      return selectedGroupIds(side).includes(GROUP_UNASSIGNED);
    }
    function sideGroupSearch(side){
      return String(uiState.groupSearch[side] || "").trim().toLowerCase();
    }
    function getVisibleGroupsForDropdown(side){
      const groups = getSideGroupsAll(side);
      const q = sideGroupSearch(side);
      if (!q) return groups;
      return groups.filter((g)=>String(g.name || "").toLowerCase().includes(q));
    }
    function selectedGroupTagNames(side){
      const all = getSideGroupsAll(side);
      const names = [];
      for (const id of selectedGroupIds(side)){
        if (id === GROUP_UNASSIGNED) {
          names.push("미분류");
          continue;
        }
        const found = all.find((g)=>g.id===id);
        if (found?.name) names.push(found.name);
      }
      return names;
    }
    function groupFilterSummary(side){
      const names = selectedGroupTagNames(side);
      if (names.length === 0) return "전체";
      if (names.length <= 2) return names.join(", ");
      return names.slice(0, 2).join(", ") + " (+" + (names.length - 2) + ")";
    }
    function entryPassGroupFilter(entry, side){
      const selected = selectedGroupIds(side);
      if (selected.length === 0) return true;
      const ids = Array.isArray(entry.groupIds) ? entry.groupIds : [];
      const hasUngrouped = selected.includes(GROUP_UNASSIGNED);
      if (hasUngrouped && ids.length === 0) return true;
      const groupOnly = selected.filter((id)=>id !== GROUP_UNASSIGNED);
      if (groupOnly.length === 0) return false;
      return ids.some((id)=>groupOnly.includes(id));
    }
    function getSideEntriesRaw(side){ const entries = Array.isArray(getSide(side)?.entries) ? getSide(side).entries : []; return entries.filter((e)=>toolPass(e.tool) && entryPassGroupFilter(e, side) && textPass(e.tool + " " + e.relativePath + " " + (e.groupNames || []).join(" "))); }
    function getSideEntries(side){ const entries = getSideEntriesRaw(side); return uiState.changedOnly ? entries.filter((e)=>e.status!=="same") : entries; }
    function createFolderTree(side,idPrefix,tool,folder,items){
      const root = { id:idPrefix+"/folder/"+tool+"/skills/"+folder, nodeType:"folder", label:"skills/"+folder, tool, relativePath:"skills/"+folder, pathKind:"folder", exists:false, children:[], _folders:{}, _statuses:[], _groups:{} };
      for (const entry of items){
        root._statuses.push(entry.status || "same"); if (entry.exists) root.exists = true; for (const g of (entry.groupNames || [])) root._groups[g] = true;
        const parts = norm(entry.innerPath).split("/").filter(Boolean); if (parts.length === 0) continue;
        let cur = root; let prefix = "";
        for (let i=0;i<parts.length;i+=1){
          const seg = parts[i]; const leaf = i === parts.length - 1;
          if (!leaf){
            prefix = prefix ? prefix + "/" + seg : seg;
            if (!cur._folders[prefix]){
              cur._folders[prefix] = { id:idPrefix+"/folder/"+tool+"/skills/"+folder+"/"+prefix, nodeType:"folder", label:seg, tool, relativePath:"skills/"+folder+"/"+prefix, pathKind:"folder", exists:false, children:[], _folders:{}, _statuses:[], _groups:{} };
              cur.children.push(cur._folders[prefix]);
            }
            const next = cur._folders[prefix];
            next._statuses.push(entry.status || "same"); if (entry.exists) next.exists = true; for (const g of (entry.groupNames || [])) next._groups[g] = true;
            cur = next;
          } else {
            cur.children.push({ id:idPrefix+"/file/"+entry.key, nodeType:"file", label:seg, tool:entry.tool, relativePath:entry.relativePath, pathKind:"file", exists:!!entry.exists, status:entry.status || "same", groupNames:entry.groupNames || [], sub:entry.relativePath });
          }
        }
      }
      const finalize = (node) => {
        node.children.sort((a,b)=>{
          const rankGap = statusRank(b.status || "same") - statusRank(a.status || "same");
          if (rankGap !== 0) return rankGap;
          if (a.nodeType !== b.nodeType) return a.nodeType === "folder" ? -1 : 1;
          return String(a.label).localeCompare(String(b.label));
        });
        for (const child of node.children){ if (child.nodeType === "folder") finalize(child); }
        const bag = [...(node._statuses || [])]; for (const child of node.children){ if (child.status) bag.push(child.status); }
        node.status = summarizeStatus(bag); node.groupNames = Object.keys(node._groups || {}).sort((a,b)=>a.localeCompare(b)); delete node._folders; delete node._statuses; delete node._groups;
      };
      finalize(root);
      return root;
    }
    function buildAgentNodes(side, entries, idPrefix){
      const byTool = {}; for (const e of entries){ const t = String(e.tool); if (!byTool[t]) byTool[t] = []; byTool[t].push(e); }
      const tools = Object.keys(byTool).sort((a,b)=>a.localeCompare(b)); const nodes = [];
      for (const tool of tools){
        const byFolder = {}; for (const e of byTool[tool]){ const f = String(e.folder || ""); if (!f) continue; if (!byFolder[f]) byFolder[f] = []; byFolder[f].push(e); }
        const names = Object.keys(byFolder).sort((a,b)=>a.localeCompare(b)); const children = names.map((folder)=>createFolderTree(side,idPrefix,tool,folder,byFolder[folder]));
        nodes.push({ id:idPrefix+"/agent/"+tool, nodeType:"agent", label:tool, status:summarizeStatus(children.map((c)=>c.status)), exists:children.some((c)=>c.exists), children, sub:"스킬 폴더 " + children.length + "개" });
      }
      nodes.sort((a,b)=>{
        const rankGap = statusRank(b.status || "same") - statusRank(a.status || "same");
        if (rankGap !== 0) return rankGap;
        return String(a.label).localeCompare(String(b.label));
      });
      return nodes;
    }
    function buildTree(side){
      const entries = getSideEntries(side);
      if (uiState.grouping === "group"){
        const selectedIds = selectedConcreteGroupIds(side);
        const includeUngrouped = selectedHasUngrouped(side);
        const groups = getSideGroups(side).filter((g)=>selectedIds.length===0 || selectedIds.includes(g.id)); const nodes = [];
        for (const group of groups){
          const items = entries.filter((e)=>Array.isArray(e.groupIds) && e.groupIds.includes(group.id));
          if (items.length === 0) continue;
          const children = buildAgentNodes(side, items, side+"/group/"+group.id);
          nodes.push({ id:side+"/group/"+group.id, nodeType:"group", label:group.name, groupId:group.id, status:summarizeStatus(items.map((e)=>e.status)), exists:items.some((e)=>!!e.exists), children, targetCount:group.targetCount, sub:group.targetSummary + " · 에이전트 " + (group.tools || []).join(", ") });
        }
        if (includeUngrouped || selectedIds.length === 0){
          const ungroupedItems = entries.filter((e)=>!Array.isArray(e.groupIds) || e.groupIds.length === 0);
          if (ungroupedItems.length > 0) {
            const children = buildAgentNodes(side, ungroupedItems, side+"/group/"+GROUP_UNASSIGNED);
            nodes.push({ id:side+"/group/"+GROUP_UNASSIGNED, nodeType:"group", label:"미분류", groupId:GROUP_UNASSIGNED, status:summarizeStatus(ungroupedItems.map((e)=>e.status)), exists:ungroupedItems.some((e)=>!!e.exists), children, targetCount:ungroupedItems.length, sub:"그룹 미할당 항목" });
          }
        }
        nodes.sort((a,b)=>{
          const rankGap = statusRank(b.status || "same") - statusRank(a.status || "same");
          if (rankGap !== 0) return rankGap;
          return String(a.label).localeCompare(String(b.label));
        });
        return nodes;
      }
      return buildAgentNodes(side, entries, side+"/agent");
    }
    function nodeMeta(node){
      const parts = []; if (node.sub) parts.push(node.sub);
      if (node.nodeType === "folder") parts.push("하위 " + (Array.isArray(node.children) ? node.children.length : 0) + "개");
      if (node.nodeType === "group") parts.push("타깃 " + String(node.targetCount || 0) + "개");
      const groups = Array.isArray(node.groupNames) ? node.groupNames : []; if (groups.length > 0) parts.push("그룹 " + groups.join(", "));
      return parts.join(" · ");
    }
    function isExpanded(id, depth){
      if (typeof uiState.expanded[id] === "boolean") return !!uiState.expanded[id];
      if (String(id).includes("/folder/")) return false;
      if (String(id).includes("/agent/")) return true;
      return depth === 0;
    }
    function targetKey(target){ return String(target.tool || "") + ":" + String(target.relativePath || "") + ":" + String(target.kind || "folder"); }
    function getSelectedTargets(side){
      const list = Array.isArray(uiState.selectedNodes[side]) ? uiState.selectedNodes[side] : [];
      const dedup = new Map();
      for (const target of list){
        if (!target || !target.tool || !target.relativePath || !target.kind) continue;
        dedup.set(targetKey(target), target);
      }
      const next = Array.from(dedup.values());
      uiState.selectedNodes[side] = next;
      return next;
    }
    function setSelectedTargets(side, targets, anchorKey){
      const dedup = new Map();
      for (const target of (Array.isArray(targets) ? targets : [])){
        if (!target || !target.tool || !target.relativePath || !target.kind) continue;
        dedup.set(targetKey(target), target);
      }
      uiState.selectedNodes[side] = Array.from(dedup.values());
      if (typeof anchorKey === "string") uiState.selectionAnchor[side] = anchorKey;
    }
    function rowToTarget(row){
      const tool = row.getAttribute("data-tool") || "";
      const relativePath = row.getAttribute("data-relative-path") || "";
      const kind = row.getAttribute("data-path-kind") || "folder";
      if (!tool || !relativePath) return null;
      return { tool, relativePath, kind, exists: row.getAttribute("data-exists")==="1" };
    }
    function isSelected(side,node){
      if (!isPathNode(node.nodeType)) return false;
      const key = targetKey({ tool:node.tool, relativePath:node.relativePath, kind:node.pathKind });
      return getSelectedTargets(side).some((target)=>targetKey(target) === key);
    }
    function renderNode(side,node,depth){
      const kids = Array.isArray(node.children) ? node.children : []; const hasKids = kids.length > 0; const open = hasKids ? isExpanded(node.id, depth) : false;
      const canMovePath = isPathNode(node.nodeType) && node.exists && !!node.tool && !!node.relativePath;
      const canDiff = isPathNode(node.nodeType) && node.status !== "same" && !!node.tool && !!node.relativePath;
      const info = statusInfo[node.status] || statusInfo.same; const meta = nodeMeta(node); const mv = side === "workspace" ? "→" : "←";
      const attrs = canMovePath ? ('data-transfer-kind="path" data-tool="' + esc(node.tool) + '" data-relative-path="' + esc(node.relativePath) + '" data-path-kind="' + esc(node.pathKind) + '"')
        : "";
      const sel = isPathNode(node.nodeType)
        ? ('data-action="select-node" data-side="' + esc(side) + '" data-tool="' + esc(node.tool) + '" data-relative-path="' + esc(node.relativePath) + '" data-path-kind="' + esc(node.pathKind) + '" data-exists="' + (node.exists ? "1" : "0") + '" data-node-key="' + esc(targetKey({ tool:node.tool, relativePath:node.relativePath, kind:node.pathKind })) + '"')
        : "";
      const toggle = hasKids ? ('<button class="toggle" data-action="toggle" data-node-id="' + esc(node.id) + '">' + (open ? "▾" : "▸") + "</button>") : '<button class="toggle placeholder">·</button>';
      const diffBtn = canDiff ? ('<button class="btn" ' + (uiState.busy?"disabled ":"") + 'data-action="open-diff" data-side="' + esc(side) + '" data-tool="' + esc(node.tool) + '" data-relative-path="' + esc(node.relativePath) + '" data-path-kind="' + esc(node.pathKind) + '">Diff</button>') : "";
      const moveBtn = canMovePath ? ('<button class="btn" ' + (uiState.busy?"disabled ":"") + 'data-action="move-path" data-side="' + esc(side) + '" data-tool="' + esc(node.tool) + '" data-relative-path="' + esc(node.relativePath) + '" data-path-kind="' + esc(node.pathKind) + '">' + mv + "</button>") : "";
      const row = '<div class="row' + (isSelected(side,node) ? " selected" : "") + (uiState.busy ? " disabled" : "") + '" style="padding-left:' + (8 + depth * 14) + 'px" draggable="' + (!uiState.busy && canMovePath ? "true" : "false") + '" data-side="' + esc(side) + '" ' + attrs + " " + sel + ">" +
        '<div class="left"><div class="line1">' + toggle + '<span class="label">' + esc(node.label) + '</span></div>' + (meta ? '<div class="sub">' + esc(meta) + "</div>" : "") + "</div>" +
        '<div class="right"><span class="badge ' + esc(info.cls) + '">' + esc(info.label) + "</span>" + diffBtn + moveBtn + "</div></div>";
      if (!hasKids || !open) return '<div class="node">' + row + "</div>";
      return '<div class="node">' + row + kids.map((c)=>renderNode(side,c,depth+1)).join("") + "</div>";
    }
    function normalizeSide(raw){ return raw === "central" ? "central" : "workspace"; }
    function closeGroupMenus(exceptSide){
      for (const side of ["workspace", "central"]) {
        if (exceptSide && exceptSide === side) continue;
        uiState.groupMenuOpen[side] = false;
      }
    }
    function setGroupSelection(side, ids){
      const uniq = [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean))];
      uiState.selectedGroups[side] = uniq;
      vscode.postMessage({ type:"setGroupFilter", payload:{ side, selectedGroupIds:[...uniq] } });
      render();
    }
    function setGroupFilterSummary(side){
      const trigger = document.getElementById(side + "GroupFilterTrigger");
      if (trigger) {
        trigger.textContent = "그룹 필터: " + groupFilterSummary(side);
      }
      const picked = document.getElementById(side + "GroupPicked");
      if (picked) {
        const names = selectedGroupTagNames(side);
        const tags = names.length > 0
          ? ('<div class="tags">' + names.map((name)=>'<span class="tag">' + esc(name) + "</span>").join("") + "</div>")
          : '<div class="tags"><span class="tag">전체</span></div>';
        picked.innerHTML = "그룹 필터: " + esc(groupFilterSummary(side)) + tags;
      }
    }
    function renderGroupDropdown(side){
      const wrap = document.querySelector('.group-filter-wrap[data-side="' + side + '"]');
      if (wrap) {
        if (uiState.groupMenuOpen[side]) wrap.classList.add("open");
        else wrap.classList.remove("open");
      }
      const menu = document.getElementById(side + "GroupFilterMenu");
      const trigger = document.getElementById(side + "GroupFilterTrigger");
      if (menu) menu.hidden = !uiState.groupMenuOpen[side];
      if (trigger) trigger.setAttribute("aria-expanded", uiState.groupMenuOpen[side] ? "true" : "false");

      const search = document.getElementById(side + "GroupFilterSearch");
      if (search instanceof HTMLInputElement && search.value !== uiState.groupSearch[side]) {
        search.value = uiState.groupSearch[side];
      }
      const ungrouped = document.getElementById(side + "GroupUngrouped");
      if (ungrouped instanceof HTMLInputElement) {
        ungrouped.checked = selectedHasUngrouped(side);
      }
      const opts = document.getElementById(side + "GroupFilterOptions");
      if (!opts) return;
      const groups = getVisibleGroupsForDropdown(side);
      const selected = selectedConcreteGroupIds(side);
      if (groups.length === 0) {
        opts.innerHTML = '<div class="group-empty">조건에 맞는 그룹이 없습니다.</div>';
        return;
      }
      opts.innerHTML = groups.map((g)=>{
        const checked = selected.includes(g.id) ? " checked" : "";
        return '<label class="group-option"><input type="checkbox" data-action="group-option" data-side="' + esc(side) + '" value="' + esc(g.id) + '"' + checked + ' />' + esc(g.name) + "</label>";
      }).join("");
    }
    function selectedTargets(side){ return getSelectedTargets(side); }
    function updateHint(side){
      const el = document.getElementById(side + "SelectedHint"); if (!el) return;
      const groupNames = selectedGroupTagNames(side);
      const groupLabel = groupNames.length > 0 ? ("그룹 필터 " + groupNames.length + "개") : "그룹 필터 전체";
      const targets = selectedTargets(side);
      if (targets.length === 0) { el.textContent = "선택 없음 (Ctrl/Cmd/Shift로 다중 선택) · " + groupLabel; return; }
      const existingCount = targets.filter((target)=>!!target.exists).length;
      const preview = targets.slice(0, 2).map((target)=>target.tool + "/" + target.relativePath).join(", ");
      const more = targets.length > 2 ? (" 외 " + (targets.length - 2) + "개") : "";
      el.textContent = "선택 " + targets.length + "개 (현재 패널 " + existingCount + "개): " + preview + more + " · " + groupLabel;
    }
    function renderTabs(){
      const tabs = document.getElementById("toolTabs"); const tools = Array.isArray(state.tools) ? state.tools : []; const all = ["all", ...tools];
      tabs.innerHTML = all.map((t)=>'<button class="tab ' + (uiState.tool===t ? "active" : "") + '" data-action="tab" data-tool="' + esc(t) + '">' + esc(t==="all" ? "All" : t) + "</button>").join("");
      tabs.querySelectorAll("[data-action='tab']").forEach((el)=>el.addEventListener("click", ()=>{ uiState.tool = el.getAttribute("data-tool") || "all"; closeGroupMenus(); vscode.postMessage({ type:"setAgentTab", payload:{ tool:uiState.tool } }); render(); }));
    }
    function renderEmpty(side, reasonText){
      const canOffChanged = uiState.changedOnly;
      const hasGroupFilter = selectedGroupIds(side).length > 0;
      const quickActions = [];
      if (canOffChanged) quickActions.push('<button class="btn" data-action="quick-changed-off" data-side="' + esc(side) + '" type="button">변경만 끄기</button>');
      if (hasGroupFilter) quickActions.push('<button class="btn" data-action="quick-clear-groups" data-side="' + esc(side) + '" type="button">그룹 필터 초기화</button>');
      const filterLine = "현재 필터: 에이전트 " + (uiState.tool === "all" ? "All" : uiState.tool) + " · 그룹 " + groupFilterSummary(side) + " · 변경만 " + (uiState.changedOnly ? "켜짐" : "꺼짐") + (uiState.query.trim() ? (" · 검색 [" + uiState.query.trim() + "]") : "");
      return '<div class="empty"><div class="empty-title">표시할 항목이 없습니다.</div><div class="empty-reason">' + esc(filterLine) + '</div><div class="empty-reason">' + esc(reasonText) + "</div>" + (quickActions.length > 0 ? ('<div class="empty-actions">' + quickActions.join("") + "</div>") : "") + "</div>";
    }
    function renderPane(side){
      const tree = document.getElementById(side + "Tree"); if (!tree) return;
      const nodes = buildTree(side);
      const baseEntries = (Array.isArray(getSide(side)?.entries) ? getSide(side).entries : []).filter((e)=>toolPass(e.tool));
      const groupEntries = baseEntries.filter((e)=>entryPassGroupFilter(e, side));
      const queryEntries = groupEntries.filter((e)=>textPass(e.tool + " " + e.relativePath + " " + (e.groupNames || []).join(" ")));
      const changedEntries = queryEntries.filter((e)=>e.status!=="same");
      const summarizeSkillStatus = (statuses)=>{
        if (statuses.some((s)=>s==="typeChanged")) return "typeChanged";
        if (statuses.some((s)=>s==="modified")) return "modified";
        const hasAdded = statuses.some((s)=>s==="added");
        const hasRemoved = statuses.some((s)=>s==="removed");
        if (hasAdded && hasRemoved) return "modified";
        if (hasAdded) return "added";
        if (hasRemoved) return "removed";
        return "same";
      };
      const toSkillSummary = (entries)=>{
        const map = new Map();
        for (const entry of entries){
          const key = entry.tool + ":skills/" + entry.folder;
          const prev = map.get(key) || { statuses: [] };
          prev.statuses.push(entry.status || "same");
          map.set(key, prev);
        }
        let changed = 0;
        for (const value of map.values()){
          if (summarizeSkillStatus(value.statuses) !== "same") changed += 1;
        }
        return { total: map.size, changed };
      };
      let reasonText = "조건에 맞는 항목이 없습니다.";
      if (baseEntries.length === 0) {
        reasonText = "현재 에이전트 탭에 표시 가능한 유효 스킬이 없습니다.";
      } else {
        const reasons = [];
        if (selectedGroupIds(side).length > 0 && groupEntries.length === 0) reasons.push("선택한 그룹 필터와 일치하는 항목이 없습니다.");
        if (uiState.query.trim() && queryEntries.length === 0) reasons.push("검색어와 일치하는 항목이 없습니다.");
        if (uiState.changedOnly && queryEntries.length > 0 && changedEntries.length === 0) reasons.push("변경만이 켜져 있어 동일 항목이 숨겨졌습니다.");
        reasonText = reasons.length > 0 ? reasons.join(" ") : reasonText;
      }
      tree.innerHTML = nodes.length ? nodes.map((n)=>renderNode(side,n,0)).join("") : renderEmpty(side, reasonText);
      const groups = getSideGroupsAll(side);
      const skillSummary = toSkillSummary(baseEntries);
      const count = document.getElementById(side + "Count"); if (count) count.textContent = "스킬 " + skillSummary.total + " · 변경 " + skillSummary.changed + " · 그룹 " + groups.length + " · 그룹 필터 " + groupFilterSummary(side);
      setGroupFilterSummary(side);
      renderGroupDropdown(side);
      updateHint(side);
    }
    function bindTrees(){
      document.querySelectorAll("[data-action='toggle']").forEach((btn)=>btn.addEventListener("click", ()=>{ const id = btn.getAttribute("data-node-id") || ""; if (!id) return; uiState.expanded[id] = !uiState.expanded[id]; render(); }));
      document.querySelectorAll("[data-action='select-node']").forEach((row)=>row.addEventListener("click", (ev)=>{
        const side = row.getAttribute("data-side") || "workspace";
        const target = rowToTarget(row);
        if (!target) return;
        const key = row.getAttribute("data-node-key") || targetKey(target);
        const current = getSelectedTargets(side);
        if (ev.shiftKey) {
          const rows = Array.from(document.querySelectorAll('[data-action="select-node"][data-side="' + side + '"]'));
          const keys = rows.map((item)=>item.getAttribute("data-node-key") || "").filter(Boolean);
          const anchor = uiState.selectionAnchor[side] || key;
          const from = keys.indexOf(anchor);
          const to = keys.indexOf(key);
          if (from >= 0 && to >= 0) {
            const [start, end] = from <= to ? [from, to] : [to, from];
            const ranged = rows.slice(start, end + 1).map((item)=>rowToTarget(item)).filter((item)=>!!item);
            const next = (ev.ctrlKey || ev.metaKey) ? [...current, ...ranged] : ranged;
            setSelectedTargets(side, next, key);
            render();
            return;
          }
        }
        if (ev.ctrlKey || ev.metaKey) {
          const exists = current.some((item)=>targetKey(item) === key);
          const next = exists ? current.filter((item)=>targetKey(item) !== key) : [...current, target];
          setSelectedTargets(side, next, key);
          render();
          return;
        }
        setSelectedTargets(side, [target], key);
        render();
      }));
      document.querySelectorAll("[data-action='open-diff']").forEach((btn)=>btn.addEventListener("click",(ev)=>{ ev.stopPropagation(); if (uiState.busy) return; vscode.postMessage({ type:"openDiff", payload:{ sourceSide:btn.getAttribute("data-side"), tool:btn.getAttribute("data-tool"), relativePath:btn.getAttribute("data-relative-path"), kind:btn.getAttribute("data-path-kind") } }); }));
      document.querySelectorAll("[data-action='move-path']").forEach((btn)=>btn.addEventListener("click",(ev)=>{ ev.stopPropagation(); if (uiState.busy) return; vscode.postMessage({ type:"movePath", payload:{ sourceSide:btn.getAttribute("data-side"), tool:btn.getAttribute("data-tool"), relativePath:btn.getAttribute("data-relative-path"), kind:btn.getAttribute("data-path-kind") } }); }));
      document.querySelectorAll("[data-action='quick-changed-off']").forEach((btn)=>btn.addEventListener("click",(ev)=>{ ev.stopPropagation(); if (uiState.busy) return; uiState.changedOnly = false; const changed = document.getElementById("changedOnly"); if (changed instanceof HTMLInputElement) changed.checked = false; render(); }));
      document.querySelectorAll("[data-action='quick-clear-groups']").forEach((btn)=>btn.addEventListener("click",(ev)=>{ ev.stopPropagation(); if (uiState.busy) return; const side = normalizeSide(btn.getAttribute("data-side")); setGroupSelection(side, []); }));
      document.querySelectorAll(".row[draggable='true']").forEach((row)=>row.addEventListener("dragstart",(ev)=>{ const k = row.getAttribute("data-transfer-kind") || ""; if (k!=="path") return; const payload = { kind:"path", sourceSide:row.getAttribute("data-side") || "", tool:row.getAttribute("data-tool") || "", relativePath:row.getAttribute("data-relative-path") || "", pathKind:row.getAttribute("data-path-kind") || "folder" }; ev.dataTransfer?.setData("application/skill-bridge-library", JSON.stringify(payload)); ev.dataTransfer?.setData("text/plain", JSON.stringify(payload)); }));
    }
    function bindDrops(){
      document.querySelectorAll(".tree[data-side]").forEach((el)=>{
        el.addEventListener("dragover",(ev)=>{ if (uiState.busy) return; ev.preventDefault(); el.classList.add("drag-over"); });
        el.addEventListener("dragleave",()=>{ el.classList.remove("drag-over"); });
        el.addEventListener("drop",(ev)=>{ if (uiState.busy) return; ev.preventDefault(); el.classList.remove("drag-over");
          const raw = ev.dataTransfer?.getData("application/skill-bridge-library") || ev.dataTransfer?.getData("text/plain") || ""; if (!raw) return;
          let payload = null; try { payload = JSON.parse(raw); } catch { return; } if (!payload || typeof payload !== "object") return;
          const targetSide = el.getAttribute("data-side"); if (payload.sourceSide === targetSide) { setStatus("같은 패널로는 이동되지 않습니다. 반대 패널로 드롭하세요.", "warn"); return; }
          if (payload.kind === "path") { vscode.postMessage({ type:"movePath", payload:{ sourceSide:payload.sourceSide, tool:payload.tool, relativePath:payload.relativePath, kind:payload.pathKind } }); }
        });
      });
    }
    function applyGroupAction(action, side){
      if (uiState.busy) return;
      const groupIds = selectedConcreteGroupIds(side);
      const targets = selectedTargets(side).filter((target)=>!!target.exists);
      if (action === "move-group"){
        vscode.postMessage({
          type:"moveGroup",
          payload:{
            sourceSide: side,
            groupIds
          }
        });
        const groupLabel = groupIds.length > 0 ? String(groupIds.length) : "선택창";
        setStatus("그룹 이동 요청: 그룹 " + groupLabel, "info");
        return;
      }
      if (action === "move-selected"){
        if (targets.length === 0) { setStatus("현재 패널에서 이동할 파일/폴더를 하나 이상 선택하세요.", "warn"); return; }
        vscode.postMessage({
          type:"moveSelected",
          payload:{
            sourceSide: side,
            targets: targets.map((target)=>({ tool:target.tool, relativePath:target.relativePath, kind:target.kind }))
          }
        });
        setStatus("선택 이동 요청: 대상 " + targets.length + "개", "info");
        return;
      }
      if (action === "group-filter-clear"){
        setGroupSelection(side, []);
        return;
      }
      if (action === "group-filter-select-all"){
        const allGroupIds = getSideGroupsAll(side).map((g)=>g.id);
        setGroupSelection(side, [...allGroupIds, GROUP_UNASSIGNED]);
        return;
      }
      if (action === "group-create"){
        if (targets.length === 0) { setStatus("그룹 생성 전에 파일/폴더를 하나 이상 선택하세요.", "warn"); return; }
        const suggest = targets[0].kind === "folder" ? targets[0].relativePath.split("/").slice(-1)[0] : targets[0].tool + "-group";
        vscode.postMessage({ type:"groupCreate", payload:{ side, suggest: suggest || "새 그룹", targets:targets.map((target)=>({ tool:target.tool, relativePath:target.relativePath, kind:target.kind })) } });
        return;
      }
      if (action === "group-assign" || action === "group-unassign"){
        if (targets.length === 0) { setStatus("현재 패널에 있는 파일/폴더를 하나 이상 선택하세요.", "warn"); return; }
        vscode.postMessage({
          type: action === "group-assign" ? "groupAssign" : "groupUnassign",
          payload:{
            side,
            groupIds,
            targets: targets.map((target)=>({ tool:target.tool, relativePath:target.relativePath, kind:target.kind }))
          }
        });
        const groupCountLabel = groupIds.length > 0 ? String(groupIds.length) : "선택창";
        setStatus((action === "group-assign" ? "선택 할당" : "선택 해제") + " 요청: 그룹 " + groupCountLabel + " · 대상 " + targets.length + "개", "info");
      }
    }
    function bindGroupMenuStatics(side){
      const trigger = document.getElementById(side + "GroupFilterTrigger");
      const menu = document.getElementById(side + "GroupFilterMenu");
      const search = document.getElementById(side + "GroupFilterSearch");
      const ungrouped = document.getElementById(side + "GroupUngrouped");
      if (trigger) {
        trigger.addEventListener("click",(ev)=>{
          ev.stopPropagation();
          const next = !uiState.groupMenuOpen[side];
          closeGroupMenus(next ? side : undefined);
          uiState.groupMenuOpen[side] = next;
          render();
        });
      }
      if (menu) {
        menu.addEventListener("click",(ev)=>ev.stopPropagation());
      }
      if (search instanceof HTMLInputElement) {
        search.addEventListener("input",()=>{
          uiState.groupSearch[side] = search.value || "";
          renderGroupDropdown(side);
        });
      }
      if (ungrouped instanceof HTMLInputElement) {
        ungrouped.addEventListener("change",()=>{
          const current = selectedConcreteGroupIds(side);
          const next = ungrouped.checked ? [...current, GROUP_UNASSIGNED] : [...current];
          setGroupSelection(side, next);
        });
      }
    }
    function bindGlobalMenuClose(){
      document.addEventListener("click",()=>{
        if (uiState.groupMenuOpen.workspace || uiState.groupMenuOpen.central) {
          closeGroupMenus();
          render();
        }
      });
      document.addEventListener("keydown",(ev)=>{
        if (ev.key !== "Escape") return;
        if (uiState.groupMenuOpen.workspace || uiState.groupMenuOpen.central) {
          closeGroupMenus();
          render();
        }
      });
    }
    function bindControls(){
      document.querySelectorAll("[data-action='group-create'],[data-action='group-assign'],[data-action='group-unassign'],[data-action='group-filter-clear'],[data-action='group-filter-select-all'],[data-action='move-group'],[data-action='move-selected']").forEach((btn)=>btn.addEventListener("click", (ev)=>{ ev.stopPropagation(); const side = normalizeSide(btn.getAttribute("data-side")); const action = btn.getAttribute("data-action") || ""; applyGroupAction(action, side); }));
      document.body.addEventListener("change", (ev)=>{
        const target = ev.target;
        if (!(target instanceof HTMLInputElement)) return;
        if (target.getAttribute("data-action") !== "group-option") return;
        const side = normalizeSide(target.getAttribute("data-side"));
        const checkedIds = Array.from(document.querySelectorAll('input[data-action="group-option"][data-side="' + side + '"]:checked'))
          .map((el)=>el instanceof HTMLInputElement ? el.value : "")
          .filter(Boolean);
        const next = selectedHasUngrouped(side) ? [...checkedIds, GROUP_UNASSIGNED] : checkedIds;
        setGroupSelection(side, next);
      });
    }
    function bindStatic(){
      bindDrops();
      bindControls();
      bindGroupMenuStatics("workspace");
      bindGroupMenuStatics("central");
      bindGlobalMenuClose();
    }
    function render(){
      renderTabs();
      renderPane("workspace");
      renderPane("central");
      bindTrees();
      const wsCount = Array.isArray(state.workspace?.entries) ? state.workspace.entries.length : 0;
      const ctCount = Array.isArray(state.central?.entries) ? state.central.entries.length : 0;
      const wsExists = Array.isArray(state.workspace?.entries) ? state.workspace.entries.filter((e)=>!!e.exists).length : 0;
      const ctExists = Array.isArray(state.central?.entries) ? state.central.entries.filter((e)=>!!e.exists).length : 0;
      const wsMissing = Array.isArray(state.diagnostics?.workspaceMissingSkillFolders) ? state.diagnostics.workspaceMissingSkillFolders.length : 0;
      const ctMissing = Array.isArray(state.diagnostics?.centralMissingSkillFolders) ? state.diagnostics.centralMissingSkillFolders.length : 0;
      if (wsCount + ctCount === 0) {
        if (wsMissing + ctMissing > 0) {
          setStatus("유효 스킬 0건 (SKILL.md 없음) · Workspace " + wsMissing + "건 · Central " + ctMissing + "건", "warn");
        } else {
          setStatus("추출된 스킬이 없습니다. 새로고침 후에도 동일하면 경로 설정과 스킬 루트(.agents/.claude 등)를 확인하세요.", "warn");
        }
      } else if (wsExists + ctExists === 0) {
        setStatus("비교 항목은 있지만 현재 패널 경로와 실제 파일 위치가 맞지 않습니다. 설정 경로를 확인하세요.", "warn");
      }
    }
    document.getElementById("groupingMode").addEventListener("change",(ev)=>{ const el = ev.target; if (!(el instanceof HTMLSelectElement)) return; uiState.grouping = el.value === "group" ? "group" : "agent"; closeGroupMenus(); vscode.postMessage({ type:"setGroupingMode", payload:{ mode:uiState.grouping } }); render(); });
    document.getElementById("changedOnly").addEventListener("change",(ev)=>{ const el = ev.target; if (!(el instanceof HTMLInputElement)) return; uiState.changedOnly = !!el.checked; vscode.postMessage({ type:"toggleChangedOnly", payload:{ enabled:uiState.changedOnly } }); render(); });
    document.getElementById("searchInput").addEventListener("input",(ev)=>{ const el = ev.target; if (!(el instanceof HTMLInputElement)) return; uiState.query = el.value || ""; closeGroupMenus(); vscode.postMessage({ type:"setSearch", payload:{ query:uiState.query } }); render(); });
    document.getElementById("refreshBtn").addEventListener("click",()=>{ if (uiState.busy) return; vscode.postMessage({ type:"refresh" }); });
    window.addEventListener("message",(event)=>{ const message = event.data; if (!message || typeof message !== "object") return; if (message.type === "state"){ state = message.payload || state; render(); return; } if (message.type === "ui"){ const payload = message.payload || {}; if (typeof payload.busy === "boolean") uiState.busy = payload.busy; setStatus(payload.message || (uiState.busy ? "작업 중..." : "준비 완료"), payload.tone || ""); render(); } });
    document.getElementById("changedOnly").checked = uiState.changedOnly;
    bindStatic();
    render();
    vscode.postMessage({ type: "clientReady" });
    vscode.postMessage({ type: "refresh" });
      } catch (error) {
        const errObj = error && typeof error === "object" ? error : null;
        const message = errObj && "message" in errObj
          ? String(errObj.message ?? "알 수 없는 오류")
          : String(error ?? "알 수 없는 오류");
        const stack = errObj && "stack" in errObj ? String(errObj.stack ?? "") : "";
        const status = document.getElementById("statusLine");
        if (status) {
          status.textContent = "웹뷰 스크립트 초기화 실패: " + message;
          status.className = "status error";
        }
        try {
          const api = bootApi ?? (typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null);
          if (api && typeof api.postMessage === "function") {
            api.postMessage({ type: "clientError", payload: { message, stack: stack.slice(0, 2000) } });
          }
        } catch {
          // ignore
        }
      }
    })();
  </script>
</body>
</html>`;
}

function resolveContext(): { workspacePath: string; centralRepoPath: string; agents: ToolType[] } {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error("열려 있는 workspace가 없습니다.");
  }

  const workspacePath = folders[0].uri.fsPath;
  const config = vscode.workspace.getConfiguration(SETTINGS_SECTION, folders[0].uri);

  const centralRaw = String(config.get<string>("centralRepoPath") ?? "").trim();
  if (!centralRaw) {
    throw new Error("설정 `skillBridge.centralRepoPath`를 입력해주세요.");
  }

  const centralRepoPath = path.isAbsolute(centralRaw)
    ? path.normalize(centralRaw)
    : path.join(workspacePath, centralRaw);

  const configured = config.get<string[]>("defaultAgents", [...CONFIGURABLE_TOOLS]);
  const normalized = configured.filter(isToolType).filter((item) => item !== "agents");
  const agents = [...new Set<ToolType>([...normalized, "agents"])];

  return { workspacePath, centralRepoPath, agents };
}

async function loadWorkspaceGroups(workspacePath: string): Promise<SelectionGroup[]> {
  const target = path.join(workspacePath, "skill_workspace.json");
  if (!(await exists(target))) return [];
  try {
    const raw = await fs.readFile(target, "utf8");
    const parsed = JSON.parse(raw) as Partial<WorkspaceGroupFile>;
    const groups = Array.isArray(parsed.groups) ? parsed.groups : [];
    return groups
      .filter((group) => group && typeof group.id === "string" && typeof group.name === "string")
      .map((group) => ({
        id: group.id!,
        name: group.name!,
        side: group.side === "central" ? "central" as const : "workspace" as const,
        targets: Array.isArray(group.targets)
          ? group.targets
              .filter((target) => target && (target.kind === "file" || target.kind === "folder"))
              .map((target) => ({
                kind: target.kind!,
                tool: target.tool!,
                relativePath: String(target.relativePath ?? "")
              }))
          : [],
        meta: sanitizeGroupMeta(group.meta)
      }))
      .map((group) => ({
        ...group,
        targets: group.targets.filter((target) => isManagedSkillPath(target.relativePath))
      }))
      .filter((group) => group.targets.length > 0);
  } catch {
    return [];
  }
}

async function saveWorkspaceGroups(workspacePath: string, groups: SelectionGroup[]): Promise<void> {
  const target = path.join(workspacePath, "skill_workspace.json");
  const payload: WorkspaceGroupFile = {
    version: 2,
    groups: groups.map((group) => ({
      ...group,
      meta: sanitizeGroupMeta(group.meta)
    }))
  };
  await fs.writeFile(target, JSON.stringify(payload, null, 2), "utf8");
}

function sanitizeGroupMeta(meta: unknown): SelectionGroup["meta"] {
  if (!meta || typeof meta !== "object") return undefined;
  const source = (meta as { source?: unknown }).source;
  const repoKey = (meta as { repoKey?: unknown }).repoKey;
  const repoUrl = (meta as { repoUrl?: unknown }).repoUrl;
  const lastInstalledAt = (meta as { lastInstalledAt?: unknown }).lastInstalledAt;
  const mirroredFrom = (meta as { mirroredFrom?: unknown }).mirroredFrom;
  const normalized: NonNullable<SelectionGroup["meta"]> = {};
  if (source === "manual" || source === "npx") normalized.source = source;
  if (typeof repoKey === "string" && repoKey.trim()) normalized.repoKey = repoKey.trim();
  if (typeof repoUrl === "string" && repoUrl.trim()) normalized.repoUrl = repoUrl.trim();
  if (typeof lastInstalledAt === "string" && lastInstalledAt.trim()) normalized.lastInstalledAt = lastInstalledAt.trim();
  if (typeof mirroredFrom === "string" && mirroredFrom.trim()) normalized.mirroredFrom = mirroredFrom.trim();
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

async function scanSkills(basePath: string, mode: "workspace" | "central", agents: ToolType[]): Promise<SkillFile[]> {
  const out: SkillFile[] = [];
  const seen = new Set<string>();

  for (const tool of agents) {
    const roots = getSkillRootCandidates(basePath, tool, mode);
    for (const root of roots) {
      if (!(await exists(root))) continue;
      const files = await collectFiles(root, basePath);
      for (const relativePath of files) {
        if (!isManagedSkillPath(relativePath)) continue;
        const key = `${tool}:${relativePath}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ tool, relativePath, absolutePath: path.join(root, relativePath) });
      }
    }
  }

  return out.sort((a, b) => a.tool.localeCompare(b.tool) || a.relativePath.localeCompare(b.relativePath));
}

function parseSkillInputs(raw: string): string[] {
  const cleaned = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.replace(/^['"]+|['"]+$/g, "").trim())
    .filter(Boolean);
  return cleaned.length > 0 ? cleaned : ["*"];
}

async function loadSkillFilesBySide(
  side: "workspace" | "central",
  workspacePath: string,
  centralRepoPath: string,
  agents: ToolType[]
): Promise<SkillFile[]> {
  const skills = await scanSkills(
    side === "workspace" ? workspacePath : centralRepoPath,
    side,
    agents
  );
  return skills;
}

async function runSkillsAdd(
  cwd: string,
  repo: string,
  skills: string[]
): Promise<{ ok: boolean; command: string; stdout: string; stderr: string }> {
  const skillArgs = skills.flatMap((skill) => ["--skill", skill]);
  const args = ["-y", "skills", "add", repo, ...skillArgs, "--yes"];
  const command = `npx ${args.join(" ")}`;
  const maxBuffer = 12 * 1024 * 1024;

  const commands = process.platform === "win32" ? ["npx.cmd", "npx"] : ["npx"];
  for (const cmd of commands) {
    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, { cwd, windowsHide: true, maxBuffer });
      return { ok: true, command, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") };
    } catch (error) {
      const execError = error as { code?: number | string; stdout?: string; stderr?: string };
      if (execError.code === "ENOENT") {
        continue;
      }
      if (typeof execError.code === "number") {
        return {
          ok: false,
          command,
          stdout: String(execError.stdout ?? ""),
          stderr: String(execError.stderr ?? "")
        };
      }
    }
  }

  const spawned = await runSkillsAddWithSpawn(args, cwd);
  return {
    ok: spawned.code === 0,
    command,
    stdout: spawned.stdout,
    stderr: spawned.stderr
  };
}

async function runSkillsAddWithSpawn(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", args, { cwd, windowsHide: true, shell: true });
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function extractInstalledSkillFolderNames(output: string): string[] {
  const regex = /[\\/]skills[\\/]([a-z0-9._-]+)/gi;
  const found = new Set<string>();
  let match = regex.exec(output);
  while (match) {
    if (match[1]) found.add(match[1]);
    match = regex.exec(output);
  }
  return [...found];
}

function inferNewSkillFolderNames(before: SkillFile[], after: SkillFile[]): string[] {
  const beforeFolders = collectSkillFolderNames(before);
  const afterFolders = collectSkillFolderNames(after);
  return [...afterFolders].filter((name) => !beforeFolders.has(name));
}

function collectSkillFolderNames(items: SkillFile[]): Set<string> {
  const names = new Set<string>();
  for (const item of items) {
    const rel = item.relativePath.replace(/\\/g, "/");
    if (!rel.startsWith("skills/")) continue;
    const parts = rel.split("/");
    if (parts.length >= 2 && parts[1]) names.add(parts[1]);
  }
  return names;
}

function buildGroupTargetsFromNames(items: SkillFile[], folderNames: string[]): GroupTarget[] {
  const names = new Set(folderNames.map((name) => name.trim()).filter(Boolean));
  const targets: GroupTarget[] = [];
  for (const tool of ALL_AGENTS) {
    for (const name of names) {
      const prefix = `skills/${name}/`;
      const exists = items.some((item) => item.tool === tool && item.relativePath.replace(/\\/g, "/").startsWith(prefix));
      if (!exists) continue;
      targets.push({ kind: "folder", tool, relativePath: `skills/${name}` });
    }
  }
  return targets;
}

function renderGroupInfoHtml(
  webview: vscode.Webview,
  data: {
    name: string;
    side: "workspace" | "central";
    count: number;
    source: string;
    repoKey: string;
    repoUrl: string;
    lastInstalledAt: string;
    mirroredFrom: string;
    rows: Array<{
      targetPath: string;
      kind: string;
      fileMtime: string;
      fileSize: string;
      latestAt: string;
      latestProject: string;
      latestSource: string;
    }>;
  }
): string {
  const esc = (value: string): string =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const rowHtml = data.rows.map((row) => `
      <tr>
        <td>${esc(row.targetPath)}</td>
        <td>${esc(row.kind)}</td>
        <td>${esc(row.fileMtime)}</td>
        <td>${esc(row.fileSize)}</td>
        <td>${esc(row.latestAt)}</td>
        <td>${esc(row.latestProject)}</td>
        <td>${esc(row.latestSource)}</td>
      </tr>
  `).join("");

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Group Info</title>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; }
    .wrap { padding: 14px; display: grid; gap: 10px; }
    .cards { display: grid; grid-template-columns: repeat(4, minmax(140px, 1fr)); gap: 8px; }
    .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px; background: var(--vscode-sideBar-background); }
    .card .k { font-size: 11px; opacity: 0.8; margin-bottom: 4px; }
    .card .v { font-size: 13px; font-weight: 600; word-break: break-all; }
    .meta { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px; display: grid; gap: 6px; }
    .meta-row { font-size: 12px; }
    .table-wrap { border: 1px solid var(--vscode-panel-border); border-radius: 6px; overflow: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
    thead { background: var(--vscode-sideBar-background); }
    tbody tr:hover { background: var(--vscode-list-hoverBackground); }
  </style>
</head>
<body>
  <div class="wrap">
    <h2 style="margin:0;">Group Info: ${esc(data.name)}</h2>
    <div class="cards">
      <div class="card"><div class="k">Side</div><div class="v">${esc(data.side)}</div></div>
      <div class="card"><div class="k">Target Count</div><div class="v">${data.count}</div></div>
      <div class="card"><div class="k">Source</div><div class="v">${esc(data.source)}</div></div>
      <div class="card"><div class="k">Repo Key</div><div class="v">${esc(data.repoKey)}</div></div>
    </div>
    <div class="meta">
      <div class="meta-row"><b>Repo URL:</b> ${esc(data.repoUrl)}</div>
      <div class="meta-row"><b>Last Installed:</b> ${esc(data.lastInstalledAt)}</div>
      <div class="meta-row"><b>Mirrored From:</b> ${esc(data.mirroredFrom)}</div>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>File</th>
            <th>Kind</th>
            <th>File MTime</th>
            <th>File Size</th>
            <th>Latest At</th>
            <th>Latest Project</th>
            <th>Latest Source Path</th>
          </tr>
        </thead>
        <tbody>${rowHtml || `<tr><td colspan="7">표시할 항목이 없습니다.</td></tr>`}</tbody>
      </table>
    </div>
  </div>
  <script nonce="${nonce}">/* static view */</script>
</body>
</html>`;
}

function normalizeRepoName(raw: string): string {
  const cleaned = raw.replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").trim();
  return cleaned || "skills-installed";
}

function getSkillRoot(basePath: string, tool: ToolType, mode: "workspace" | "central"): string {
  const roots = getSkillRootCandidates(basePath, tool, mode);
  for (const candidate of roots) {
    if (existsSync(candidate)) return candidate;
  }
  return roots[0];
}

function getSkillRootCandidates(basePath: string, tool: ToolType, mode: "workspace" | "central"): string[] {
  const dotted = tool === "agents" ? ".agents" : `.${tool}`;
  const plain = tool;
  const primary = mode === "workspace"
    ? path.join(basePath, dotted)
    : path.join(basePath, plain);
  const secondary = mode === "workspace"
    ? path.join(basePath, plain)
    : path.join(basePath, dotted);
  return [...new Set([primary, secondary])];
}

function resolveSkillPath(basePath: string, tool: ToolType, relativePath: string, mode: "workspace" | "central"): string {
  const normalized = normalizeRel(relativePath);
  if (!isManagedSkillPath(normalized) || normalized.includes("..")) {
    throw new Error("skills 하위 경로만 허용됩니다.");
  }
  return path.join(getSkillRoot(basePath, tool, mode), normalized);
}

async function collectFiles(root: string, basePath: string): Promise<string[]> {
  const out: string[] = [];
  const visited = new Set<string>();

  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (entry.isFile()) {
        out.push(path.relative(root, abs).replace(/\\/g, "/"));
        continue;
      }
      if (!entry.isSymbolicLink()) continue;

      try {
        const real = await fs.realpath(abs);
        if (!isWithinPath(basePath, real)) continue;
        if (visited.has(real)) continue;
        visited.add(real);

        const stat = await fs.stat(abs);
        if (stat.isDirectory()) {
          await walk(abs);
        } else if (stat.isFile()) {
          out.push(path.relative(root, abs).replace(/\\/g, "/"));
        }
      } catch {
        // ignore broken links
      }
    }
  };

  await walk(root);
  return out;
}

async function collectScopeEntries(
  toolRoot: string,
  scopeRelativePath: string,
  scopeKind: "file" | "folder"
): Promise<Map<string, { relativePath: string; absolutePath: string; kind: "file" | "folder"; mtime: string | null; size: number | null }>> {
  const result = new Map<string, { relativePath: string; absolutePath: string; kind: "file" | "folder"; mtime: string | null; size: number | null }>();
  const scopePath = path.join(toolRoot, scopeRelativePath);
  if (!(await exists(scopePath))) return result;

  const add = async (relativePath: string, absolutePath: string, kind: "file" | "folder"): Promise<void> => {
    const stat = await fs.stat(absolutePath).catch(() => null);
    result.set(relativePath, {
      relativePath,
      absolutePath,
      kind,
      mtime: stat ? stat.mtime.toISOString() : null,
      size: kind === "file" && stat ? stat.size : null
    });
  };

  const walk = async (dirPath: string, relPath: string): Promise<void> => {
    await add(relPath, dirPath, "folder");
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(dirPath, entry.name);
      const childRel = normalizeRel(path.posix.join(relPath, entry.name));
      if (!isManagedSkillPath(childRel)) continue;
      if (entry.isDirectory()) {
        await walk(absolute, childRel);
      } else if (entry.isFile()) {
        await add(childRel, absolute, "file");
      }
    }
  };
  const scopeStat = await fs.stat(scopePath).catch(() => null);
  if (!scopeStat) return result;
  if (scopeKind === "file" || scopeStat.isFile()) {
    await add(normalizeRel(scopeRelativePath), scopePath, "file");
    return result;
  }
  await walk(scopePath, normalizeRel(scopeRelativePath));
  return result;
}

type FolderEntryRow = { relativePath: string; size: number; mtime: string };
type FolderDiffStatus = "A" | "D" | "M" | "=";
type FolderDiffRow = {
  relativePath: string;
  status: FolderDiffStatus;
  sourceSize: number | null;
  targetSize: number | null;
  sourceMtime: string | null;
  targetMtime: string | null;
};

async function collectFolderEntryRows(folderPath: string): Promise<FolderEntryRow[]> {
  if (!(await exists(folderPath))) return [];
  const rows: FolderEntryRow[] = [];
  const walk = async (dirPath: string): Promise<void> => {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        const stat = await fs.stat(absolute);
        rows.push({
          relativePath: path.relative(folderPath, absolute).replace(/\\/g, "/"),
          size: stat.size,
          mtime: stat.mtime.toISOString()
        });
      }
    }
  };
  await walk(folderPath);
  rows.sort((a, b) => {
    const aSkill = /(^|\/)SKILL\.md$/i.test(a.relativePath) ? 0 : 1;
    const bSkill = /(^|\/)SKILL\.md$/i.test(b.relativePath) ? 0 : 1;
    if (aSkill !== bSkill) return aSkill - bSkill;
    return a.relativePath.localeCompare(b.relativePath);
  });
  return rows;
}

function buildFolderDiffRows(sourceRows: FolderEntryRow[], targetRows: FolderEntryRow[]): FolderDiffRow[] {
  const sourceMap = new Map<string, FolderEntryRow>();
  const targetMap = new Map<string, FolderEntryRow>();
  for (const row of sourceRows) {
    sourceMap.set(row.relativePath, row);
  }
  for (const row of targetRows) {
    targetMap.set(row.relativePath, row);
  }

  const allPaths = new Set<string>([...sourceMap.keys(), ...targetMap.keys()]);
  const rows: FolderDiffRow[] = [];
  for (const relativePath of allPaths) {
    const sourceRow = sourceMap.get(relativePath);
    const targetRow = targetMap.get(relativePath);
    let status: FolderDiffStatus = "=";

    if (sourceRow && !targetRow) {
      status = "A";
    } else if (!sourceRow && targetRow) {
      status = "D";
    } else if (sourceRow && targetRow) {
      if (sourceRow.size !== targetRow.size || sourceRow.mtime !== targetRow.mtime) {
        status = "M";
      }
    }

    rows.push({
      relativePath,
      status,
      sourceSize: sourceRow?.size ?? null,
      targetSize: targetRow?.size ?? null,
      sourceMtime: sourceRow?.mtime ?? null,
      targetMtime: targetRow?.mtime ?? null
    });
  }

  rows.sort((a, b) => {
    const aSkill = /(^|\/)SKILL\.md$/i.test(a.relativePath) ? 0 : 1;
    const bSkill = /(^|\/)SKILL\.md$/i.test(b.relativePath) ? 0 : 1;
    if (aSkill !== bSkill) return aSkill - bSkill;
    if (a.status !== b.status) {
      const order: Record<FolderDiffStatus, number> = { A: 0, M: 1, D: 2, "=": 3 };
      return order[a.status] - order[b.status];
    }
    return a.relativePath.localeCompare(b.relativePath);
  });
  return rows;
}

type FolderDiffSummaryRow = {
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

function buildFolderDiffSummaryRows(items: TransferPlanItem[], mode: TransferPlan["mode"]): FolderDiffSummaryRow[] {
  const rows = items.map((item) => {
    const sourceState = item.status === "removed" ? "없음" : item.entryKind === "folder" ? "폴더" : "파일";
    const targetState = item.status === "added" ? "없음" : item.entryKind === "folder" ? "폴더" : "파일";
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

function renderFolderDiffSummaryHtml(
  webview: vscode.Webview,
  data: {
    mode: TransferPlan["mode"];
    tool: string;
    relativePath: string;
    rows: FolderDiffSummaryRow[];
  }
): string {
  const esc = (value: string): string =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sourceLabel = data.mode === "workspaceToCentral" ? "작업공간(현재)" : "중앙(현재)";
  const targetLabel = data.mode === "workspaceToCentral" ? "중앙(적용 후)" : "작업공간(적용 후)";
  const addedFiles = data.rows.filter((row) => row.changeCode === "A").length;
  const modifiedFiles = data.rows.filter((row) => row.changeCode === "M").length;
  const removedFiles = data.rows.filter((row) => row.changeCode === "D").length;
  const typeChangedFiles = data.rows.filter((row) => row.changeCode === "T").length;
  const sameFiles = data.rows.filter((row) => row.changeCode === "=").length;
  const codeToLabel = (code: FolderDiffSummaryRow["changeCode"]): string => {
    if (code === "A") return "신규";
    if (code === "D") return "삭제";
    if (code === "M") return "수정";
    if (code === "T") return "타입충돌";
    return "동일";
  };
  const rows = data.rows.map((row) => {
    const isSame = row.changeCode === "=";
    return `<tr>
      <td class="code code-${esc(row.changeCode)}" title="${esc(row.status)}">${esc(codeToLabel(row.changeCode))}</td>
      <td>${esc(row.relativePath)} <small>[${esc(row.entryKind)}]</small></td>
      <td>${esc(row.sourceState)}</td>
      <td>${esc(row.targetState)}</td>
      <td>${esc(row.decisionText)}</td>
      <td><span class="risk risk-${esc(row.riskLevel)}">${esc(row.riskLevel)}</span></td>
      <td><button data-kind="open-diff" data-key="${esc(row.key)}" ${isSame ? "disabled" : ""}>상세 Diff</button></td>
    </tr>`;
  }).join("");

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Folder Diff Summary</title>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; }
    .wrap { padding: 12px; display: grid; gap: 10px; }
    .cards { display: grid; grid-template-columns: repeat(5, minmax(120px, 1fr)); gap: 8px; }
    .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px; background: var(--vscode-sideBar-background); }
    .table-wrap { border: 1px solid var(--vscode-panel-border); border-radius: 6px; overflow: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
    thead { background: var(--vscode-sideBar-background); }
    .code { font-weight: 800; }
    .code-A { color: #22c55e; }
    .code-D { color: #ef4444; }
    .code-M { color: #f59e0b; }
    .code-T { color: #fb7185; }
    .code-\= { color: var(--vscode-descriptionForeground); }
    .risk { display: inline-block; border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 1px 7px; font-size: 11px; }
    .risk-high { border-color: #ef4444; color: #ef4444; }
    .risk-medium { border-color: #f59e0b; color: #f59e0b; }
    .risk-low { border-color: #22c55e; color: #22c55e; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; padding: 4px 8px; cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
  </style>
</head>
<body>
  <div class="wrap">
    <h2 style="margin:0;">Diff Summary: ${esc(data.tool)}/${esc(data.relativePath)}</h2>
    <div><b>${sourceLabel}</b> → <b>${targetLabel}</b></div>
    <div class="cards">
      <div class="card"><b>신규</b><br>${addedFiles}</div>
      <div class="card"><b>수정</b><br>${modifiedFiles}</div>
      <div class="card"><b>삭제</b><br>${removedFiles}</div>
      <div class="card"><b>타입충돌</b><br>${typeChangedFiles}</div>
      <div class="card"><b>동일</b><br>${sameFiles}</div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>상태</th><th>경로</th><th>${sourceLabel}</th><th>${targetLabel}</th><th>변경 설명</th><th>위험</th><th>액션</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="7">표시할 항목이 없습니다.</td></tr>`}</tbody>
      </table>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.body.addEventListener("click", (event) => {
      const el = event.target;
      if (!(el instanceof HTMLButtonElement)) return;
      if (el.dataset.kind !== "open-diff") return;
      const key = el.dataset.key || "";
      vscode.postMessage({ type: "openDiff", payload: { key } });
    });
  </script>
</body>
</html>`;
}

function renderFolderTransferDiffHtml(
  webview: vscode.Webview,
  data: {
    tool: ToolType;
    relativePath: string;
    status: TransferStatus;
    totalFiles: number;
    totalSourceBytes: number;
    totalTargetBytes: number;
    addedCount: number;
    removedCount: number;
    modifiedCount: number;
    sameCount: number;
    skillMdCount: number;
    rows: FolderDiffRow[];
  }
): string {
  const esc = (value: string): string =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const treeRows = data.rows.map((row) => {
    const isSkill = /(^|\/)SKILL\.md$/i.test(row.relativePath);
    const sizeDelta = row.sourceSize !== null && row.targetSize !== null ? row.sourceSize - row.targetSize : null;
    const sizeDeltaLabel = sizeDelta === null ? "-" : sizeDelta > 0 ? `+${sizeDelta} B` : `${sizeDelta} B`;
    return `<tr>
      <td class="status-${esc(row.status)}"><b>${esc(row.status)}</b></td>
      <td>${esc(row.relativePath)} ${isSkill ? "<b>[SKILL.md]</b>" : ""}</td>
      <td>${row.sourceSize ?? "-"}${row.sourceSize === null ? "" : " B"}</td>
      <td>${row.targetSize ?? "-"}${row.targetSize === null ? "" : " B"}</td>
      <td>${esc(sizeDeltaLabel)}</td>
      <td>${row.sourceMtime ? esc(row.sourceMtime) : "-"}</td>
      <td>${row.targetMtime ? esc(row.targetMtime) : "-"}</td>
    </tr>`;
  }).join("");

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Folder Diff</title>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; }
    .wrap { padding: 12px; display: grid; gap: 10px; }
    .cards { display: grid; grid-template-columns: repeat(5, minmax(120px, 1fr)); gap: 8px; }
    .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px; background: var(--vscode-sideBar-background); }
    .table-wrap { border: 1px solid var(--vscode-panel-border); border-radius: 6px; overflow: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
    thead { background: var(--vscode-sideBar-background); }
    tbody tr:hover { background: var(--vscode-list-hoverBackground); }
    .status-A { color: #22c55e; }
    .status-D { color: #ef4444; }
    .status-M { color: #f59e0b; }
    .status-\= { color: var(--vscode-descriptionForeground); }
  </style>
</head>
<body>
  <div class="wrap">
    <h2 style="margin:0;">Folder Diff: ${esc(data.tool)}/${esc(data.relativePath)}</h2>
    <div class="cards">
      <div class="card"><b>Status</b><br>${esc(data.status)}</div>
      <div class="card"><b>Total Files</b><br>${data.totalFiles}</div>
      <div class="card"><b>Changes</b><br>A ${data.addedCount} / M ${data.modifiedCount} / D ${data.removedCount}</div>
      <div class="card"><b>Source Size</b><br>${data.totalSourceBytes} B</div>
      <div class="card"><b>Target Size</b><br>${data.totalTargetBytes} B</div>
      <div class="card"><b>SKILL.md</b><br>${data.skillMdCount}</div>
      <div class="card"><b>Same</b><br>${data.sameCount}</div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Change</th><th>Path</th><th>Source Size</th><th>Target Size</th><th>Delta</th><th>Source MTime</th><th>Target MTime</th></tr></thead>
        <tbody>${treeRows || `<tr><td colspan="7">표시할 파일이 없습니다.</td></tr>`}</tbody>
      </table>
    </div>
  </div>
  <script nonce="${nonce}">/* static */</script>
</body>
</html>`;
}

function renderTypeChangedTransferDiffHtml(
  webview: vscode.Webview,
  data: {
    tool: ToolType;
    relativePath: string;
    sourceKind: "file" | "folder" | "none";
    targetKind: "file" | "folder" | "none";
    sourceRows: Array<{ relativePath: string; size: number; mtime: string }>;
    targetRows: Array<{ relativePath: string; size: number; mtime: string }>;
  }
): string {
  const esc = (value: string): string =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const renderRows = (rows: Array<{ relativePath: string; size: number; mtime: string }>): string =>
    rows.map((row) => {
      const isSkill = /(^|\/)SKILL\.md$/i.test(row.relativePath);
      return `<tr>
        <td>${esc(row.relativePath)} ${isSkill ? "<b>[SKILL.md]</b>" : ""}</td>
        <td>${row.size} B</td>
        <td>${esc(row.mtime)}</td>
      </tr>`;
    }).join("") || `<tr><td colspan="3">표시할 파일이 없습니다.</td></tr>`;

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Type Changed Diff</title>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; }
    .wrap { padding: 12px; display: grid; gap: 10px; }
    .cards { display: grid; grid-template-columns: repeat(3, minmax(140px, 1fr)); gap: 8px; }
    .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px; background: var(--vscode-sideBar-background); }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .table-wrap { border: 1px solid var(--vscode-panel-border); border-radius: 6px; overflow: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
    thead { background: var(--vscode-sideBar-background); }
  </style>
</head>
<body>
  <div class="wrap">
    <h2 style="margin:0;">Type Changed: ${esc(data.tool)}/${esc(data.relativePath)}</h2>
    <div class="cards">
      <div class="card"><b>Source Type</b><br>${esc(data.sourceKind)}</div>
      <div class="card"><b>Target Type</b><br>${esc(data.targetKind)}</div>
      <div class="card"><b>Change</b><br>${esc(data.targetKind)} -> ${esc(data.sourceKind)}</div>
    </div>
    <div class="grid">
      <div class="table-wrap">
        <table>
          <thead><tr><th colspan="3">Source Tree</th></tr><tr><th>Path</th><th>Size</th><th>MTime</th></tr></thead>
          <tbody>${renderRows(data.sourceRows)}</tbody>
        </table>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th colspan="3">Target Tree</th></tr><tr><th>Path</th><th>Size</th><th>MTime</th></tr></thead>
          <tbody>${renderRows(data.targetRows)}</tbody>
        </table>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">/* static */</script>
</body>
</html>`;
}

function uniqueSelections(items: SkillSelection[]): SkillSelection[] {
  const map = new Map<string, SkillSelection>();
  for (const item of items) {
    map.set(`${item.tool}:${item.relativePath}`, item);
  }
  return [...map.values()];
}

function buildGroupTargetsFromNodes(nodes: SkillTreeNode[]): GroupTarget[] {
  const out: GroupTarget[] = [];
  for (const node of nodes) {
    if (!node.relativePath) continue;
    const skillFolderRel = getSkillFolderRelativePath(node.relativePath);
    if (!skillFolderRel) continue;
    out.push({
      kind: "folder",
      tool: node.tool,
      relativePath: skillFolderRel
    });
  }
  return dedupeGroupTargets(out);
}

function buildTransferScopeHintsFromNodes(nodes: SkillTreeNode[]): Array<{ tool: ToolType; relativePath: string; kind: "file" | "folder" }> {
  const hints = new Map<string, { tool: ToolType; relativePath: string; kind: "file" | "folder" }>();
  for (const node of nodes) {
    if (!node.relativePath || !isManagedSkillPath(node.relativePath)) continue;
    const key = `${node.tool}:${node.relativePath}`;
    const next = {
      tool: node.tool,
      relativePath: node.relativePath,
      kind: node.kind === "folder" ? "folder" as const : "file" as const
    };
    const prev = hints.get(key);
    if (!prev || next.kind === "folder") {
      hints.set(key, next);
    }
  }
  return [...hints.values()];
}

function dedupeGroupTargets(targets: GroupTarget[]): GroupTarget[] {
  const unique = new Map<string, GroupTarget>();
  for (const target of targets) {
    const skillFolderRel = getSkillFolderRelativePath(target.relativePath);
    if (!skillFolderRel) continue;
    unique.set(`${target.tool}:${skillFolderRel}`, {
      kind: "folder",
      tool: target.tool,
      relativePath: skillFolderRel
    });
  }
  return [...unique.values()].sort((a, b) => a.tool.localeCompare(b.tool) || a.relativePath.localeCompare(b.relativePath));
}

function targetsToSelections(files: SkillFile[], targets: GroupTarget[]): SkillSelection[] {
  const selections = new Map<string, SkillSelection>();
  for (const target of targets) {
    if (!isManagedSkillPath(target.relativePath)) continue;
    if (target.kind === "file") {
      selections.set(`${target.tool}:${target.relativePath}`, { tool: target.tool, relativePath: target.relativePath });
      continue;
    }
    const prefix = target.relativePath;
    for (const file of files) {
      if (file.tool !== target.tool) continue;
      if (file.relativePath === prefix || file.relativePath.startsWith(`${prefix}/`)) {
        selections.set(`${file.tool}:${file.relativePath}`, { tool: file.tool, relativePath: file.relativePath });
      }
    }
  }
  return [...selections.values()];
}

function pruneGroupsByCurrentSkills(
  groups: SelectionGroup[],
  workspaceSkills: SkillFile[],
  centralSkills: SkillFile[]
): { groups: SelectionGroup[]; removedGroups: number } {
  const next: SelectionGroup[] = [];
  let removedGroups = 0;

  for (const group of groups) {
    const files = group.side === "workspace" ? workspaceSkills : centralSkills;
    const valid = group.targets.every((target) => targetExistsInFiles(target, files));
    if (!valid) {
      removedGroups += 1;
      continue;
    }
    next.push(group);
  }

  return { groups: next, removedGroups };
}

function targetExistsInFiles(target: GroupTarget, files: SkillFile[]): boolean {
  if (!isManagedSkillPath(target.relativePath)) return false;
  if (target.kind === "file") {
    return files.some((file) => file.tool === target.tool && file.relativePath === target.relativePath);
  }

  const prefix = target.relativePath;
  return files.some((file) => {
    if (file.tool !== target.tool) return false;
    return file.relativePath === prefix || file.relativePath.startsWith(`${prefix}/`);
  });
}

function normalizeRel(p: string | undefined | null): string {
  if (!p) return "";
  return p.replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

function getSkillFolderRelativePath(p: string): string | null {
  const normalized = normalizeRel(p);
  const parts = normalized.split("/").filter(Boolean);
  const skillsIndex = parts.indexOf("skills");
  if (skillsIndex < 0) return null;
  const skillName = parts[skillsIndex + 1];
  if (!skillName) return null;
  return `skills/${skillName}`;
}

function isSkillMdRelativePath(p: string): boolean {
  const normalized = normalizeRel(p);
  return /(^|\/)SKILL\.md$/i.test(normalized);
}

function enforceSkillMdInventory(files: SkillFile[]): {
  validFiles: SkillFile[];
  missingFolders: Array<{ tool: ToolType; relativePath: string }>;
} {
  const folderSet = new Set<string>();
  const skillMdSet = new Set<string>();
  for (const file of files) {
    const skillFolderRel = getSkillFolderRelativePath(file.relativePath);
    if (!skillFolderRel) continue;
    const key = `${file.tool}:${skillFolderRel}`;
    folderSet.add(key);
    if (isSkillMdRelativePath(file.relativePath)) {
      skillMdSet.add(key);
    }
  }
  const validFiles = files.filter((file) => {
    const skillFolderRel = getSkillFolderRelativePath(file.relativePath);
    if (!skillFolderRel) return false;
    return skillMdSet.has(`${file.tool}:${skillFolderRel}`);
  });
  const missingFolders = [...folderSet]
    .filter((key) => !skillMdSet.has(key))
    .map((key) => {
      const sep = key.indexOf(":");
      const tool = key.slice(0, sep);
      const relativePath = key.slice(sep + 1);
      return { tool: tool as ToolType, relativePath };
    })
    .sort((a, b) => a.tool.localeCompare(b.tool) || a.relativePath.localeCompare(b.relativePath));
  return { validFiles, missingFolders };
}

function isWithinPath(basePath: string, target: string): boolean {
  const base = path.resolve(basePath);
  const resolved = path.resolve(target);
  const baseLower = base.toLowerCase();
  const targetLower = resolved.toLowerCase();
  if (baseLower === targetLower) return true;
  return targetLower.startsWith(`${baseLower}${path.sep}`);
}

function isManagedSkillPath(p: string): boolean {
  const n = normalizeRel(p).toLowerCase();
  return n === "skills" || n.startsWith("skills/");
}

function isToolType(value: string): value is ToolType {
  return (ALL_AGENTS as string[]).includes(value);
}

function unwrapSkillNode(input: unknown): SkillTreeNode | undefined {
  if (!input || typeof input !== "object") return undefined;
  const direct = input as Partial<SkillTreeNode>;
  if (isSkillTreeNodeShape(direct)) return direct as SkillTreeNode;

  const wrapped = input as { node?: unknown };
  if (wrapped.node && typeof wrapped.node === "object" && isSkillTreeNodeShape(wrapped.node as Partial<SkillTreeNode>)) {
    return wrapped.node as SkillTreeNode;
  }
  return undefined;
}

function isSkillTreeNodeShape(node: Partial<SkillTreeNode>): boolean {
  return typeof node.kind === "string"
    && typeof node.tool === "string"
    && typeof node.relativePath === "string"
    && typeof node.label === "string";
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function copyNode(from: string, to: string): Promise<void> {
  const stat = await fs.stat(from);
  if (stat.isDirectory()) {
    await fs.mkdir(to, { recursive: true });
    const entries = await fs.readdir(from, { withFileTypes: true });
    for (const entry of entries) {
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      if (entry.isDirectory()) {
        await copyNode(src, dst);
      } else if (entry.isFile()) {
        await fs.mkdir(path.dirname(dst), { recursive: true });
        await fs.copyFile(src, dst);
      }
    }
    return;
  }
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.copyFile(from, to);
}

function toUserError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function openNodeIfFile(basePath: string, node: SkillTreeNode, mode: "workspace" | "central"): Promise<void> {
  if (node.kind !== "file") return;
  if (!basePath) return;
  try {
    const absolutePath = resolveSkillPath(basePath, node.tool, node.relativePath, mode);
    const uri = vscode.Uri.file(absolutePath);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true });
  } catch {
    // ignore open errors; selection must still work
  }
}

function applyTabFilter(
  state: { activeTab: SourceTab; workspaceSkills: SkillFile[]; centralSkills: SkillFile[]; groups: SelectionGroup[] },
  workspaceProvider: SkillTreeProvider,
  centralProvider: SkillTreeProvider
): void {
  workspaceProvider.setActiveTab(state.activeTab);
  centralProvider.setActiveTab(state.activeTab);
  workspaceProvider.setSkills(state.workspaceSkills);
  centralProvider.setSkills(state.centralSkills);
  workspaceProvider.setGroups(state.groups);
  centralProvider.setGroups(state.groups);
}

function tabLabel(tab: SourceTab): string {
  return tab === "all" ? "all" : tab;
}

function createWatchers(workspacePath: string, centralPath: string): vscode.FileSystemWatcher[] {
  const patterns = [
    new vscode.RelativePattern(workspacePath, ".*/skills/**"),
    new vscode.RelativePattern(workspacePath, "*/skills/**"),
    new vscode.RelativePattern(centralPath, ".*/skills/**"),
    new vscode.RelativePattern(centralPath, "*/skills/**")
  ];
  return patterns.map((pattern) => vscode.workspace.createFileSystemWatcher(pattern));
}

function applyGroupHighlight(
  state: { workspaceSkills: SkillFile[]; centralSkills: SkillFile[] },
  group: SelectionGroup,
  workspaceProvider: SkillTreeProvider,
  centralProvider: SkillTreeProvider
): void {
  const highlight = buildHighlightSet(
    group.side === "workspace" ? state.workspaceSkills : state.centralSkills,
    group
  );
  if (group.side === "workspace") {
    workspaceProvider.setHighlight(highlight);
    centralProvider.setHighlight(new Set());
  } else {
    centralProvider.setHighlight(highlight);
    workspaceProvider.setHighlight(new Set());
  }
}

function buildHighlightSet(files: SkillFile[], group: SelectionGroup): Set<string> {
  const highlight = new Set<string>();
  const selections = targetsToSelections(files, group.targets);
  const addPath = (tool: ToolType, rel: string): void => {
    if (!rel) return;
    highlight.add(`${tool}:${rel}`);
    const parts = rel.split("/");
    let cursor = "";
    for (let i = 0; i < parts.length - 1; i += 1) {
      cursor = cursor ? `${cursor}/${parts[i]}` : parts[i];
      highlight.add(`${tool}:${cursor}`);
    }
  };
  for (const target of group.targets) {
    if (!isManagedSkillPath(target.relativePath)) continue;
    highlight.add(`${target.tool}:${target.relativePath}`);
  }
  for (const item of selections) {
    addPath(item.tool, item.relativePath);
  }
  return highlight;
}

function countGroups(groups: SelectionGroup[]): { workspace: number; central: number } {
  let workspace = 0;
  let central = 0;
  for (const group of groups) {
    if (group.side === "workspace") workspace += 1;
    else central += 1;
  }
  return { workspace, central };
}

function filterGroupsByTab(groups: SelectionGroup[], tab: SourceTab): SelectionGroup[] {
  if (tab === "all") return groups;
  return groups.filter((group) => group.targets.some((target) => target.tool === tab));
}
