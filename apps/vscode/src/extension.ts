import { constants as fsConstants, existsSync, promises as fs, type Dirent, type Stats } from "node:fs";
import { execFile, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { ALL_AGENTS, type GroupTarget, type GroupTreeNode, type InstructionFile, type ProjectPreset, type SelectionGroup, type SkillAssetTreeMeta, type SkillAssetWarning, type SkillTreeFilterMode, type SkillFile, type SkillSelection, type SkillTreeNode, type TransferPlan, type TransferPlanItem, type TransferPlanSummary, type TransferStatus, type ToolType, type WorkspaceGroupFile } from "./types";
import { buildGroupTargetsFromNames, collectSkillFolderSyncTargets, extractInstalledSkillFolderNames, getUniqueTargetTools, inferNewSkillFolderNames } from "./installGrouping";
import { renderSkillGroupMarkdown, sanitizeGroupMeta } from "./groupMetadata";
import { createGroupOverviewTools } from "./groupOverviewView";
import { createNpxSkillLibraryTools } from "./npxSkillLibraryView";
import { createAddMoveWizardPanelOpener, summarizeWizardAssets, type WizardAssetPick } from "./extensionAddMoveWizard";
import { createWizardAssetTools } from "./extensionWizardAssets";
import { createHydrationTools } from "./extensionHydration";
import { createAgentCopyTools } from "./extensionAgentCopy";
import { createReviewTools } from "./extensionReviewTools";
import { createTransferManager, type TransferPlanOptions, type TransferScopeHint } from "./extensionTransferManager";
import { createDiagnosticsTools } from "./extensionDiagnostics";
import { createHistoryTools, type CentralSkillHistoryFile } from "./extensionHistoryTools";
import { createNodeActionTools } from "./extensionNodeActions";
import { createGroupActionTools } from "./extensionGroupActions";
import { createInstallTransferTools } from "./extensionInstallTransfer";
import { createExtensionGroupStateTools } from "./extensionGroupStateTools";
import { createExtensionLibraryTransferTools } from "./extensionLibraryTransferTools";
import { createExtensionInstructionTransferTools } from "./extensionInstructionTransferTools";
import { createExtensionShellTools } from "./extensionShellTools";
import {
  createExtensionActivationHelpers,
  getSkillFolderRelativePathFromTreeNode,
  promptGroupDescription,
  summarizeStatuses
} from "./extensionActivationHelpers";
import { createExtensionRefreshRuntime, type ExtensionRefreshResult } from "./extensionRefreshRuntime";
import { createExtensionProjectActions } from "./extensionProjectActions";
import { createProjectPresetCommandTools } from "./extensionProjectPresetBootstrap";
import { registerExtensionCommands } from "./extensionCommandRegistrar";
import {
  collectFiles,
  collectFolderEntryRows,
  getSkillRoot,
  getSkillRootCandidates,
  getWritableSkillRoot,
  INSTRUCTION_ROOT,
  INSTRUCTION_RULE_DIRS,
  NESTED_INSTRUCTION_FILES,
  normalizeInstructionRelativePath,
  normalizeRepoName,
  resolveCentralInstructionPath,
  resolveOpenFolderTarget,
  resolveSkillPath,
  resolveWorkspaceInstructionPath,
  ROOT_INSTRUCTION_FILES,
  sanitizeInstructionProfileName,
  suggestInstructionProfile,
  isManagedInstructionPath
} from "./skillPaths";
import {
  applyGroupHighlight,
  applyTabFilter,
  buildGroupTargetsFromNodes,
  buildTransferScopeHintsFromNodes,
  collectSkillFolderNamesForTool,
  containsWorkspaceSpecificPath,
  copyNode,
  countGroups,
  createWatchers,
  dedupeGroupTargets,
  dedupeTreeWarnings,
  enforceSkillMdInventory,
  exists,
  filterActionSelectionNodes,
  filterGroupsByTab,
  findBrokenMarkdownLinkWarnings,
  formatCommandForDisplay,
  getNpxExecFileCandidates,
  getSkillFolderRelativePath,
  getSkillInnerRelativePath,
  hasParentPathSegment,
  hasSensitiveLikeText,
  isEditableSkillTextPath,
  isManagedSkillPath,
  isSkillMdRelativePath,
  isToolType,
  isWithinPath,
  mapWithConcurrency,
  normalizeSourceTab,
  normalizePathForContainment,
  normalizeRel,
  openNodeIfFile,
  pruneGroupsByCurrentSkills,
  quoteCommandArg,
  readDirEntriesOrEmpty,
  tabLabel,
  targetExistsInFiles,
  targetsToSelections,
  toUserError,
  type SourceTab,
  uniqueSelections,
  unwrapSkillNode
} from "./extensionSupport";
import {
  ensureUniqueGroupNameForTool,
  getGroupTool,
  getSkillInnerPath,
  getTopSkillFolder,
  normalizeGroupsForCurrentSkills,
  normalizeGroupNameKey,
  summarizeGroupTargets,
  toSkillFolderTarget
} from "./extensionGroupTools";
import {
  diagnoseEnvironment,
  ensurePersonalSkillHome,
  resetPersonalSkillHome,
  type EnvironmentCheck,
  type EnvironmentCheckStatus,
  type EnvironmentDiagnosis
} from "./extensionEnvironment";
import { DEFAULT_CENTRAL_REPO_PATH_SETTING } from "./centralPath";
import { createTransferExplorerTools } from "./extensionTransferExplorer";
import { asRecord, clearCentralRepoPathOverrides, compactPathForDisplay, ensureSkillBridgeState, getActiveWorkspacePath, getDefaultCentralRepoPath, loadProjectPresets, loadSelectionGroups, loadSkillFilesBySide, parseSkillInputs, resolveContext, runSkillsAdd, saveProjectPresets, saveSelectionGroups, scanCentralInstructions, scanSkills, scanWorkspaceInstructions, slugifyPackId, slugifyProjectPresetId } from "./extensionStorage";
import { createLibraryManagerTools } from "./extensionLibraryManager";
import { coerceUiLanguage, DEFAULT_UI_LANGUAGE, type UiLanguage } from "./uiLanguage";
import { SkillTreeProvider } from "./views/skillTreeProvider";
import { createCentralPathRepairTools } from "./extensionCentralPathRepair";

const SETTINGS_SECTION = "skillBridge";
const DEFAULT_CENTRAL_REPO_PATH = DEFAULT_CENTRAL_REPO_PATH_SETTING;
const BUNDLED_SKILL_MANAGER_RELATIVE_PATH = "skills/skill-manager";
const CONFIGURABLE_TOOLS: ToolType[] = ["claude", "codex", "gemini", "cursor", "antigravity"];
const execFileAsync = promisify(execFile);
function getUiLanguage(): UiLanguage {
  const raw = vscode.workspace.getConfiguration(SETTINGS_SECTION).get<string>("language", DEFAULT_UI_LANGUAGE);
  return coerceUiLanguage(raw);
}
function labelForLanguage(language: UiLanguage, english: string, korean: string): string {
  return language === "ko" ? korean : english;
}
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const activationStartedAt = Date.now();
  type TreeSide = "workspace" | "central";
  type NodeCrudAction = "rename" | "delete" | "duplicate";
  type GroupMutationMode = "append" | "replace" | "remove";
  type ClipboardEntry = { kind: "file" | "folder"; tool: ToolType; relativePath: string };
  type InstructionTransferTarget = { relativePath: string; profileId?: string; sourcePath?: string };
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
    activeTab: normalizeSourceTab(vscode.workspace.getConfiguration(SETTINGS_SECTION).get<string[]>("visibleAgents", []), [...CONFIGURABLE_TOOLS, "agents"]),
    workspaceSkills: [] as SkillFile[],
    centralSkills: [] as SkillFile[],
    workspaceInstructions: [] as InstructionFile[],
    centralInstructions: [] as InstructionFile[],
    workspaceMissingSkillFolders: [] as Array<{ tool: ToolType; relativePath: string }>,
    centralMissingSkillFolders: [] as Array<{ tool: ToolType; relativePath: string }>,
    workspaceAssetMeta: new Map<string, SkillAssetTreeMeta>(),
    centralAssetMeta: new Map<string, SkillAssetTreeMeta>(),
    treeFilter: "all" as SkillTreeFilterMode,
    agents: [...CONFIGURABLE_TOOLS, "agents"] as ToolType[],
    groups: [] as SelectionGroup[],
    centralProjectPresets: [] as ProjectPreset[],
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
  const qualityStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  qualityStatusBar.name = "Skill Bridge Quality";
  qualityStatusBar.command = "workbench.action.problems.focus";
  qualityStatusBar.tooltip = "Skill Bridge workspace quality issues. Click to open Problems.";
  const output = vscode.window.createOutputChannel("Skill Bridge");
  const skillDiagnostics = vscode.languages.createDiagnosticCollection("skillBridge");
  let uiLanguage = getUiLanguage();
  const languageRefreshers = new Set<() => Promise<void> | void>();
  const tr = (english: string, korean: string): string => labelForLanguage(uiLanguage, english, korean);
  qualityStatusBar.tooltip = tr("Skill Bridge workspace quality issues. Click to open Problems.", "Skill Bridge 작업공간 품질 이슈입니다. 클릭하면 문제 목록을 엽니다.");
  workspaceProvider.setLanguage(uiLanguage);
  centralProvider.setLanguage(uiLanguage);
  const {
    getAutoSyncWorkspaceAgents,
    formatAgentFolderLabel,
    resolveWorkspaceAgentToolFromNode,
    resolveWorkspaceAutoSyncToolFromNode,
    resolveSelectedAgentToolForSide,
    toggleWorkspaceAgentAutoSync,
    syncWorkspaceAgentToCentralNow,
    updateStatusChrome,
    applyLanguageChrome,
    registerLanguageRefresh,
    getWorkspaceChangedSkillFolder,
    syncWorkspaceAgentFoldersToCentral
  } = createExtensionShellTools({
    settingsSection: SETTINGS_SECTION,
    tr,
    state,
    workspaceView,
    centralView,
    workspaceProvider,
    centralProvider,
    compactPathForDisplay,
    getUiLanguage,
    updateStatusChromeCore: () => {
      const groupCounts = countGroups(filterGroupsByTab(state.groups, state.activeTab));
      const centralName = path.basename(state.centralRepoPath) || state.centralRepoPath;
      statusBar.text = `$(repo) Skill Bridge: ${centralName} [${tabLabel(state.activeTab)}] (${tr("Groups", "그룹")} W:${groupCounts.workspace} C:${groupCounts.central})`;
      statusBar.tooltip = [
        `${tr("Central Skill Home", "중앙 스킬 홈")}: ${state.centralRepoPath || tr("Unset", "미설정")}`,
        `${tr("Workspace", "작업공간")}: ${state.workspacePath || tr("Unset", "미설정")}`,
        `${tr("Agent tab", "에이전트 탭")}: ${tabLabel(state.activeTab)}`,
        `${tr("Groups", "그룹")}: ${tr("Workspace", "작업공간")} ${groupCounts.workspace}, ${tr("Central", "중앙")} ${groupCounts.central}`
      ].join("\n");
    },
    languageRefreshers,
    refresh: async () => void (await refresh()),
    getSkillRoot,
    isWithinPath,
    normalizeRel,
    getSkillFolderRelativePath,
    collapseLibraryTargets: (targets) => requireToolset(libraryTransferTools, "libraryTransferTools").collapseLibraryTargets(targets),
    uniqueSelections,
    targetsToSelections,
    transferSelections: (side, selections, options) => transferSelections(side, selections, options),
    mirrorGroupToOtherSide: async (group, options) => await requireToolset(groupStateTools, "groupStateTools").mirrorGroupToOtherSide(group, options)
  });

  const scheduleRefresh = (): void => {
    requireToolset(refreshRuntimeTools, "refreshRuntimeTools").scheduleRefresh(requireToolset(refreshRuntimeState, "refreshRuntimeState"));
  };

  const enqueueWorkspaceAutoSync = (tool: ToolType, skillFolderRel: string): void => {
    const runtime = requireToolset(refreshRuntimeState, "refreshRuntimeState");
    runtime.autoSyncPending.set(`${tool}:${skillFolderRel}`, { tool, skillFolderRel });
    if (runtime.autoSyncTimer) clearTimeout(runtime.autoSyncTimer);
    runtime.autoSyncTimer = setTimeout(() => {
      runtime.autoSyncTimer = null;
      void requireToolset(refreshRuntimeTools, "refreshRuntimeTools").flushWorkspaceAutoSync(runtime);
    }, 900);
  };
  let groupStateTools: ReturnType<typeof createExtensionGroupStateTools> | null = null;
  let libraryTransferTools: ReturnType<typeof createExtensionLibraryTransferTools> | null = null;
  let instructionTransferTools: ReturnType<typeof createExtensionInstructionTransferTools> | null = null;
  let transferManagerTools: ReturnType<typeof createTransferManager> | null = null;
  let installTransferTools: ReturnType<typeof createInstallTransferTools> | null = null;
  let refreshRuntimeTools: ReturnType<typeof createExtensionRefreshRuntime> | null = null;
  type RefreshRuntimeState = ReturnType<ReturnType<typeof createExtensionRefreshRuntime>["createRefreshState"]>;
  let refreshRuntimeState: RefreshRuntimeState | null = null;
  let activationHelpers: ReturnType<typeof createExtensionActivationHelpers> | null = null;
  const requireToolset = <T,>(value: T | null, label: string): T => {
    if (!value) {
      throw new Error(`Skill Bridge internal dependency not ready: ${label}`);
    }
    return value;
  };

  const refresh = async (): Promise<ExtensionRefreshResult> =>
    await requireToolset(refreshRuntimeTools, "refreshRuntimeTools").refresh(requireToolset(refreshRuntimeState, "refreshRuntimeState"));

  let offerCentralPathRepair: (error: unknown) => Promise<boolean> = async () => false;
  const handleError = async (error: unknown): Promise<void> => {
    if (!(await offerCentralPathRepair(error))) vscode.window.showErrorMessage(toUserError(error));
  };

  const { openLibraryDiff, openLibraryManagerPanel, promptCreateGroupForTargets, assignTargetsToGroupMany, unassignTargetsFromGroupMany } = createLibraryManagerTools({
    state,
    tr,
    output,
    settingsSection: SETTINGS_SECTION,
    handleError,
    workspaceProvider,
    centralProvider,
    getUiLanguage: () => uiLanguage,
    setUiLanguage: async (language) => {
      await vscode.workspace
        .getConfiguration(SETTINGS_SECTION)
        .update("language", language, vscode.ConfigurationTarget.Global);
      uiLanguage = language;
      applyLanguageChrome();
    },
    refresh: async () => void (await refresh()),
    registerLanguageRefresh,
    scanSkills,
    getSideSkillFiles: (side) => requireToolset(groupStateTools, "groupStateTools").getSideSkillFiles(side),
    getSkillFolderRelativePath,
    transferPathFromExplorer: (sourceSide, tool, relativePath, kind, preferredGroupIds) =>
      requireToolset(libraryTransferTools, "libraryTransferTools").transferPathFromExplorer(sourceSide, tool, relativePath, kind, preferredGroupIds),
    transferSelectedPathsFromLibrary: (sourceSide, targets, preferredGroupIds) =>
      requireToolset(libraryTransferTools, "libraryTransferTools").transferSelectedPathsFromLibrary(sourceSide, targets, preferredGroupIds),
    deleteLibraryTargets: (side, targets) => requireToolset(libraryTransferTools, "libraryTransferTools").deleteLibraryTargets(side, targets),
    exportGroup: (side, selectedGroup, options) => requireToolset(groupStateTools, "groupStateTools").exportGroup(side, selectedGroup, options),
    buildTransferPlan: (sourceSide, selections, options) => requireToolset(transferManagerTools, "transferManagerTools").buildTransferPlan(sourceSide, selections, options),
    openTransferDiff: (item) => openTransferDiff(item),
    openAddMoveWizardPanel: () => openAddMoveWizardPanel(),
    openTransferExplorerPanel: () => openTransferExplorerPanel(),
    installSkillsForSide: (side) => requireToolset(installTransferTools, "installTransferTools").installSkillsForSide(side),
    persistGroups: (next, selectedGroupId, options) => requireToolset(groupStateTools, "groupStateTools").persistGroups(next, selectedGroupId, options),
    isSameFileContent: (src, dst, srcSize, dstSize) => requireToolset(instructionTransferTools, "instructionTransferTools").isSameFileContent(src, dst, srcSize, dstSize),
    toUserError
  });
  const { openTransferExplorerPanel } = createTransferExplorerTools({
    state,
    tr,
    handleError,
    getUiLanguage: () => uiLanguage,
    setUiLanguage: async (language) => {
      await vscode.workspace
        .getConfiguration(SETTINGS_SECTION)
        .update("language", language, vscode.ConfigurationTarget.Global);
      uiLanguage = language;
      applyLanguageChrome();
    },
    refresh: async () => void (await refresh()),
    registerLanguageRefresh,
    getSkillFolderRelativePath,
    transferPathFromExplorer: (sourceSide, tool, relativePath, kind, preferredGroupIds) =>
      requireToolset(libraryTransferTools, "libraryTransferTools").transferPathFromExplorer(sourceSide, tool, relativePath, kind, preferredGroupIds),
    transferComparedTargetsFromExplorer: (sourceSide, targets, selectedStatuses) =>
      requireToolset(libraryTransferTools, "libraryTransferTools").transferComparedTargetsFromExplorer(sourceSide, targets, selectedStatuses),
    mirrorComparedGroupsFromExplorer: (sourceSide, groupIds) => requireToolset(libraryTransferTools, "libraryTransferTools").mirrorComparedGroupsFromExplorer(sourceSide, groupIds),
    deleteComparedGroupsFromExplorer: (targetSide, groupIds) => requireToolset(libraryTransferTools, "libraryTransferTools").deleteComparedGroupsFromExplorer(targetSide, groupIds),
    openLibraryDiff: (sourceSide, tool, relativePath, kind) => openLibraryDiff(sourceSide, tool, relativePath, kind),
    exportGroup: (side, group) => requireToolset(groupStateTools, "groupStateTools").exportGroup(side, group),
    isSameFileContent: (src, dst, srcSize, dstSize) => requireToolset(instructionTransferTools, "instructionTransferTools").isSameFileContent(src, dst, srcSize, dstSize),
    toUserError
  });

  groupStateTools = createExtensionGroupStateTools({
    tr,
    toUserError,
    handleError,
    state,
    refresh: async () => void (await refresh()),
    workspaceProvider,
    centralProvider,
    applyGroupHighlight: (group) => applyGroupHighlight(state, group, workspaceProvider, centralProvider),
    saveSelectionGroups,
    normalizeGroupsForCurrentSkills,
    output,
    buildGroupTargetsFromNodes,
    dedupeGroupTargets,
    targetExistsInFiles,
    targetsToSelections,
    uniqueSelections,
    ensureUniqueGroupNameForTool,
    promptGroupDescription,
    promptCreateGroupForTargets: (...groupArgs) => promptCreateGroupForTargets(...groupArgs),
    assignTargetsToGroupMany: (...groupArgs) => assignTargetsToGroupMany(...groupArgs),
    transferSelections: (side, selections, options) =>
      requireToolset(installTransferTools, "installTransferTools").transferSelections(side, selections, options),
    isManagedSkillPath,
    normalizeRel,
    getGroupTool
  });
  const {
    createGroupFromSelection,
    resolveGroupingNodes,
    addSelectionToExistingGroup,
    exportGroup,
    getSideSkillFiles,
    resolveGroup,
    getSelectedNodes,
    persistGroups,
    mirrorGroupToOtherSide,
    groupsEquivalent
  } = groupStateTools;
  activationHelpers = createExtensionActivationHelpers({
    state,
    tr,
    normalizeRel,
    getSkillFolderRelativePath,
    dedupeGroupTargets,
    mirrorGroupToOtherSide,
    refresh: async () => {
      await refresh();
    }
  });
  const {
    collectAffectedGroupIdsForScopeHints,
    collectScopeHintsFromPlanItems,
    collectAffectedGroupIdsForPlanItems,
    mirrorGroupsByIds,
    selectPreferredGroupIds,
    mirrorGroupsForTransferResult
  } = activationHelpers;

  const register = <TArgs extends unknown[]>(id: string, callback: (...args: TArgs) => unknown): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          await Promise.resolve(callback(...(args as TArgs)));
        } catch (error) { await handleError(error); }
      })
    );
  };

  const setLanguageAndRefreshViews = async (language: UiLanguage): Promise<void> => {
    await vscode.workspace
      .getConfiguration(SETTINGS_SECTION)
      .update("language", language, vscode.ConfigurationTarget.Global);
    uiLanguage = language;
    applyLanguageChrome();
    workspaceProvider.setLanguage(language);
    centralProvider.setLanguage(language);
    for (const refreshLanguage of [...languageRefreshers]) {
      await Promise.resolve(refreshLanguage()).catch((error) => {
        output.appendLine(`[LanguageRefresh] ${toUserError(error)}`);
      });
    }
  };

  context.subscriptions.push(workspaceView, centralView, statusBar, qualityStatusBar, output, skillDiagnostics);
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(`${SETTINGS_SECTION}.language`)) {
      applyLanguageChrome();
      workspaceProvider.setLanguage(getUiLanguage());
      centralProvider.setLanguage(getUiLanguage());
      for (const refresh of [...languageRefreshers]) {
        void Promise.resolve(refresh()).catch((error) => {
          output.appendLine(`[LanguageRefresh] ${toUserError(error)}`);
        });
      }
    }
    if (event.affectsConfiguration(`${SETTINGS_SECTION}.autoSyncWorkspaceAgents`)) {
      const agents = getAutoSyncWorkspaceAgents();
      vscode.window.setStatusBarMessage(
        agents.length > 0
          ? tr(`Skill Bridge auto sync agents: ${agents.join(", ")}`, `Skill Bridge 자동 sync 에이전트: ${agents.join(", ")}`)
          : tr("Skill Bridge auto sync disabled.", "Skill Bridge 자동 sync가 꺼져 있습니다."),
        3000
      );
    }
    if (event.affectsConfiguration(`${SETTINGS_SECTION}.visibleAgents`)) {
      state.activeTab = normalizeSourceTab(vscode.workspace.getConfiguration(SETTINGS_SECTION).get<string[]>("visibleAgents", []), state.agents);
      applyTabFilter(state, workspaceProvider, centralProvider); updateStatusChrome();
    }
  }));
  applyLanguageChrome();

  workspaceView.onDidChangeSelection((event) => {
    const rawSelection = (event.selection ?? []).map((item) => item.node);
    state.workspaceSelection = filterActionSelectionNodes(rawSelection);
    workspaceProvider.setSelected(state.workspaceSelection[0] ?? null);
    if (rawSelection.length > 0) {
      state.centralSelection = [];
      centralProvider.setSelected(null);
    }
  });

  centralView.onDidChangeSelection((event) => {
    const rawSelection = (event.selection ?? []).map((item) => item.node);
    state.centralSelection = filterActionSelectionNodes(rawSelection);
    centralProvider.setSelected(state.centralSelection[0] ?? null);
    if (rawSelection.length > 0) {
      state.workspaceSelection = [];
      workspaceProvider.setSelected(null);
    }
  });

  const openAddMoveWizardPanel = createAddMoveWizardPanelOpener({
    tr,
    settingsSection: SETTINGS_SECTION,
    getPayload: () => buildAddMoveWizardPayload() as any,
    registerLanguageRefresh,
    setLanguage: async (next) => {
      await vscode.workspace
        .getConfiguration(SETTINGS_SECTION)
        .update("language", next, vscode.ConfigurationTarget.Global);
      applyLanguageChrome();
    },
    refresh: async () => void (await refresh()),
    runNewSkillWizard: () => runNewSkillWizard(),
    runAssetTransferWizard: (side) => runAssetTransferWizard(side),
    runAgentCopyWizard: () => runAgentCopyWizard(),
    installSkills: () => installSkills(),
    hydrateCurrentProject: () => hydrateCurrentProject(),
    downloadCentralSkillToWorkspace: () => downloadCentralSkillToWorkspace(),
    downloadSkillManagerSkillToWorkspace: () => downloadSkillManagerSkillToWorkspace(),
    createCentralPack: () => createCentralPack(),
    toUserError
  });
  const {
    pickWizardSide,
    pickWizardAsset,
    getWizardAssetPicks,
    statusLabelForWizard,
    buildSkillMdTemplate,
    dedupeWizardAssets,
    getWizardAssetFromNode
  } = createWizardAssetTools({
    tr,
    getWorkspaceSkills: () => state.workspaceSkills,
    getCentralSkills: () => state.centralSkills,
    getWorkspaceMissingSkillFolders: () => state.workspaceMissingSkillFolders,
    getCentralMissingSkillFolders: () => state.centralMissingSkillFolders,
    getWorkspaceAssetMeta: () => state.workspaceAssetMeta,
    getCentralAssetMeta: () => state.centralAssetMeta,
    getSkillFolderRelativePath,
    normalizeRel,
    getSkillFolderRelativePathFromNode: (node) => getSkillFolderRelativePathFromTreeNode(normalizeRel, node)
  });
  const { hydrateCurrentProject, downloadCentralSkillToWorkspace, downloadSkillManagerSkillToWorkspace, createCentralPack } = createHydrationTools({
    tr,
    toUserError,
    handleError,
    workspacePath: () => state.workspacePath,
    centralRepoPath: () => state.centralRepoPath,
    agents: () => state.agents,
    centralSkills: () => state.centralSkills,
    refresh: async () => void (await refresh()),
    getWizardAssetPicks,
    statusLabelForWizard,
    getWritableSkillRoot: (basePath, tool, mode) => getWritableSkillRoot(basePath, tool, mode),
    getSkillRoot: (basePath, tool, mode) => getSkillRoot(basePath, tool, mode),
    exists,
    copyNode,
    targetExistsInFiles,
    targetsToSelections,
    transferSelections: (side, selections, options) => transferSelections(side, selections, options),
    dedupeGroupTargets,
    slugifyPackId,
    bundledSkillManagerRelativePath: BUNDLED_SKILL_MANAGER_RELATIVE_PATH,
    extensionPath: context.extensionPath,
    upsertHydratedWorkspaceGroup: async (packName, packId, targets) => {
      await upsertHydratedWorkspaceGroup(packName, packId, targets);
    }
  });
  const { runAgentCopyWizard, runGroupAgentCopyWizard } = createAgentCopyTools({
    tr,
    toUserError,
    handleError,
    workspacePath: () => state.workspacePath,
    centralRepoPath: () => state.centralRepoPath,
    agents: () => state.agents,
    groups: () => state.groups,
    refresh: async () => void (await refresh()),
    pickWizardSide,
    pickWizardAsset,
    getWizardAssetPicks,
    dedupeWizardAssets,
    getSelectedNodes,
    buildGroupTargetsFromNodes,
    resolveGroup: (node) => resolveGroup(node),
    getGroupTool,
    dedupeGroupTargets,
    isManagedSkillPath,
    getSkillRoot: (basePath, tool, mode) => getSkillRoot(basePath, tool, mode),
    getWritableSkillRoot: (basePath, tool, mode) => getWritableSkillRoot(basePath, tool, mode),
    exists,
    copyNode,
    persistGroups: (next, selectedGroupId, options) => persistGroups(next, selectedGroupId, options),
    groupsEquivalent
  });
  const {
    showNodeWarningReasons,
    openTransferDiff
  } = createReviewTools({
    tr,
    toUserError,
    workspaceProvider,
    centralProvider,
    getWorkspaceSelection: () => state.workspaceSelection,
    getCentralSelection: () => state.centralSelection,
    registerLanguageRefresh,
    getUiLanguage: () => uiLanguage,
    exists,
    collectFolderEntryRows
  });
  const {
    showSkillHistory,
    loadCentralSkillHistory,
    saveCentralSkillHistory,
    updateCentralSkillHistory,
    createSkillFolder,
    pickTool,
    showGroupInfo,
    suggestDuplicateName
  } = createHistoryTools({
    tr,
    toUserError,
    handleError,
    getUiLanguage: () => uiLanguage,
    refresh: async () => void (await refresh()),
    state,
    workspaceProviderGetSelected: () => workspaceProvider.getSelected(),
    centralProviderGetSelected: () => centralProvider.getSelected(),
    buildSkillMdTemplate,
    registerLanguageRefresh,
    targetsToSelections,
    exists
  });
  const { openGroupOverview } = createGroupOverviewTools({
    tr, getUiLanguage: () => uiLanguage, refresh: async () => void (await refresh()), registerLanguageRefresh, state, loadCentralSkillHistory, targetsToSelections, getGroupTool,
    persistGroups: (next, selectedGroupId, options) => persistGroups(next, selectedGroupId, options),
    exportGroup: (side, selectedGroup, options) => exportGroup(side, selectedGroup, options),
    mirrorGroupToOtherSide: (group, options) => mirrorGroupToOtherSide(group, options),
    installSkillsForSide: (side) => requireToolset(installTransferTools, "installTransferTools").installSkillsForSide(side),
    assignTargetsToGroupMany: (side, groupId, targets) => assignTargetsToGroupMany(side, groupId, targets),
    unassignTargetsFromGroupMany: (side, groupId, targets) => unassignTargetsFromGroupMany(side, groupId, targets),
    ensureUniqueGroupNameForTool, toUserError
  });
  const { openNpxSkillLibrary } = createNpxSkillLibraryTools({ tr, getUiLanguage: () => uiLanguage, refresh: async () => void (await refresh()), registerLanguageRefresh, state, getGroupTool, installSkillsForSide: (side) => requireToolset(installTransferTools, "installTransferTools").installSkillsForSide(side), installNpxRepoForSide: (side, preset) => requireToolset(installTransferTools, "installTransferTools").installNpxRepoForSide(side, preset), openGroupOverview, persistGroups: (next, selectedGroupId, options) => persistGroups(next, selectedGroupId, options), toUserError, handleError });
  const {
    renameGroup,
    editGroupDescription,
    mutateGroupTargets,
    showGroupActions
  } = createGroupActionTools({
    tr,
    toUserError,
    handleError,
    refresh: async () => void (await refresh()),
    workspaceProvider,
    centralProvider,
    applyGroupHighlight: (group) => applyGroupHighlight(state, group, workspaceProvider, centralProvider),
    state,
    resolveGroup: (node) => resolveGroup(node),
    persistGroups: (next, selectedGroupId, options) => persistGroups(next, selectedGroupId, options),
    getSelectedNodes,
    buildGroupTargetsFromNodes,
    dedupeGroupTargets,
    normalizeRel,
    runGroupAgentCopyWizard: (side, node) => runGroupAgentCopyWizard(side, node),
    showGroupInfo: (group) => showGroupInfo(group),
    exportGroup: (side, selectedGroup) => exportGroup(side, selectedGroup),
    promptGroupDescription
  });
  const {
    createSkillItem,
    openFolderInOs,
    runNodeCrud,
    copyNodesToClipboard,
    copyNodePathToClipboard,
    pasteNodesFromClipboard,
    openSkillMarkdown,
    showQuickSkillCrud,
    showSmartActions,
    makeFolderNode
  } = createNodeActionTools({
    tr,
    toUserError,
    handleError,
    refresh: async () => void (await refresh()),
    exists,
    copyNode,
    compactPathForDisplay,
    buildSkillMdTemplate,
    createSkillFolder: (side, node) => createSkillFolder(side, node),
    pickTool: () => pickTool(),
    showGroupActions: async () => {
      await showGroupActions();
    },
    createGroupFromSelection: (side, nodes) => createGroupFromSelection(side, nodes),
    addSelectionToExistingGroup: (side, node) => addSelectionToExistingGroup(side, node),
    runAgentCopyWizard: (side, node) => runAgentCopyWizard(side, node),
    transferSelections: (side, selections, options) => transferSelections(side, selections, options),
    buildTransferScopeHintsFromNodes,
    mirrorGroupsByIds: (side, groupIds) => mirrorGroupsByIds(side, groupIds),
    selectPreferredGroupIds,
    resolveGroupingNodes: (side, node) => resolveGroupingNodes(side, node),
    buildGroupTargetsFromNodes,
    resolveWorkspaceAgentToolFromNode,
    getAutoSyncWorkspaceAgents,
    toggleWorkspaceAgentAutoSync,
    formatAgentFolderLabel,
    syncWorkspaceAgentToCentralNow,
    uniqueSelections,
    workspaceProvider,
    centralProvider,
    state
  });
  transferManagerTools = createTransferManager({
    tr,
    toUserError,
    handleError,
    getUiLanguage: () => uiLanguage,
    registerLanguageRefresh,
    getWorkspacePath: () => state.workspacePath,
    getCentralRepoPath: () => state.centralRepoPath,
    getGroups: () => state.groups,
    uniqueSelections,
    exists,
    copyNode,
    openTransferDiff,
    isSameFileContent: (src, dst, srcSize, dstSize) => requireToolset(instructionTransferTools, "instructionTransferTools").isSameFileContent(src, dst, srcSize, dstSize),
    updateCentralSkillHistory
  });
  const {
    buildTransferPlan,
    openTransferManagerTab,
    applyTransferPlan
  } = transferManagerTools;
  const {
    buildTreeAssetMeta,
    updateSkillDiagnostics
  } = createDiagnosticsTools({
    tr,
    state,
    skillDiagnostics,
    isSameFileContent: (src, dst, srcSize, dstSize) => requireToolset(instructionTransferTools, "instructionTransferTools").isSameFileContent(src, dst, srcSize, dstSize)
  });
  refreshRuntimeTools = createExtensionRefreshRuntime({
    tr,
    toUserError,
    output,
    state,
    workspaceProvider,
    centralProvider,
    applyGroupHighlight: (group) => applyGroupHighlight(state, group, workspaceProvider, centralProvider),
    applyTabFilter: () => applyTabFilter(state, workspaceProvider, centralProvider),
    updateStatusChrome,
    qualityStatusBar,
    skillDiagnostics,
    createWatchers,
    resolveContext,
    ensureSkillBridgeState,
    scanSkills,
    scanWorkspaceInstructions,
    scanCentralInstructions,
    enforceSkillMdInventory,
    buildTreeAssetMeta: (input) => buildTreeAssetMeta(input),
    updateSkillDiagnostics,
    loadSelectionGroups,
    loadProjectPresets,
    saveProjectPresets,
    normalizeGroupsForCurrentSkills,
    dedupeGroupTargets,
    targetExistsInFiles,
    saveSelectionGroups,
    filterGroupsByTab,
    countGroups,
    getWorkspaceChangedSkillFolder,
    getAutoSyncWorkspaceAgents,
    enqueueWorkspaceAutoSync,
    syncWorkspaceAgentFoldersToCentral
  });
  refreshRuntimeState = refreshRuntimeTools.createRefreshState();
  installTransferTools = createInstallTransferTools({
    tr,
    toUserError,
    handleError,
    refresh: async () => void (await refresh()),
    output,
    state,
    workspaceProvider,
    centralProvider,
    exists,
    parseSkillInputs,
    formatCommandForDisplay,
    loadSkillFilesBySide,
    runSkillsAdd,
    resolveSelectedAgentToolForSide,
    formatAgentFolderLabel,
    getAutoSyncWorkspaceAgents,
    syncWorkspaceAgentFoldersToCentral,
    normalizeRepoName,
    persistGroups: (next, selectedGroupId) => persistGroups(next, selectedGroupId),
    targetsToSelections,
    buildTransferPlan: (side, selections, options) => buildTransferPlan(side, selections, options),
    openTransferManagerTab: (plan, rebuildPlan, expandPlan) => openTransferManagerTab(plan, rebuildPlan, expandPlan),
    applyTransferPlan: (items, sourceProjectPath) => applyTransferPlan(items, sourceProjectPath),
    collectScopeHintsFromPlanItems,
    collapseLibraryTargets: (targets) => requireToolset(libraryTransferTools, "libraryTransferTools").collapseLibraryTargets(targets),
    collectAffectedGroupIdsForScopeHints,
    mirrorGroupToOtherSide,
    getSkillFolderRelativePath,
    normalizeRel
  });
  const {
    installSkills,
    resolveInstallSide,
    transferSelections,
    resolveCommandNodes,
    pickEmptyTransferScope,
    buildTransferScopeContext,
    formatTransferScopeLabel,
    getAllSelectionsForSide
  } = installTransferTools;

  libraryTransferTools = createExtensionLibraryTransferTools({
    tr,
    state,
    refresh: async () => void (await refresh()),
    exists,
    resolveSkillPath,
    getSkillFolderRelativePath,
    normalizeRel,
    isManagedSkillPath,
    isToolType,
    uniqueSelections,
    transferSelections: (side, selections, options) => transferSelections(side, selections, options),
    mirrorGroupsByIds: (side, groupIds) => mirrorGroupsByIds(side, groupIds),
    selectPreferredGroupIds,
    buildTransferPlan: (sourceSide, selections, options) => buildTransferPlan(sourceSide, selections, options),
    openTransferManagerTab: (plan, rebuildPlan) => openTransferManagerTab(plan, rebuildPlan),
    applyTransferPlan: (items, sourceProjectPath) => applyTransferPlan(items, sourceProjectPath),
    collectScopeHintsFromPlanItems,
    collectAffectedGroupIdsForScopeHints,
    dedupeGroupTargets,
    targetExistsInFiles,
    persistGroups: (next, selectedGroupId, options) => persistGroups(next, selectedGroupId, options),
    getGroupTool,
    groupsEquivalent
  });
  const {
    transferPathFromExplorer,
    transferSelectedPathsFromLibrary,
    transferComparedTargetsFromExplorer,
    mirrorComparedGroupsFromExplorer,
    deleteComparedGroupsFromExplorer,
    deleteLibraryTargets,
    collapseLibraryTargets
  } = libraryTransferTools;

  instructionTransferTools = createExtensionInstructionTransferTools({
    tr,
    toUserError,
    handleError,
    output,
    state,
    refresh: async () => {
      await refresh();
    },
    unwrapSkillNode,
    resolveCommandNodes,
    buildTransferScopeHintsFromNodes,
    uniqueSelections,
    targetsToSelections,
    buildTransferScopeContext: (input) => buildTransferScopeContext({
      side: input.side,
      nodes: input.nodes,
      hints: input.hints,
      selectedGroup: input.selectedGroup,
      isWholeTreeScope: input.isWholeTreeScope
    }),
    transferSelections: (side, selections, options) => transferSelections(side, selections, options),
    mirrorGroupsForTransferResult,
    workspaceProvider,
    centralProvider,
    pickEmptyTransferScope,
    suggestInstructionProfile,
    normalizeInstructionRelativePath,
    sanitizeInstructionProfileName,
    isManagedInstructionPath,
    resolveWorkspaceInstructionPath,
    resolveCentralInstructionPath,
    exists
  });
  const {
    promoteSelected,
    importSelected,
    getInstructionTransferTargets,
    transferInstructions,
    summarizeInstructionProfiles,
    openInstructionDiff,
    isSameFileContent
  } = instructionTransferTools;
  const {
    buildAddMoveWizardPayload,
    runNewSkillWizard,
    runAssetTransferWizard,
    setPersonalSkillHome,
    runEnvironmentDiagnosis,
    runResetPersonalSkillHome,
    upsertHydratedWorkspaceGroup
  } = createExtensionProjectActions({
    tr,
    toUserError,
    handleError,
    output,
    state,
    uiLanguage: () => uiLanguage,
    refresh: async () => await refresh(),
    pickWizardSide,
    pickTool: () => pickTool(),
    pickWizardAsset,
    getWizardAssetPicks,
    summarizeWizardAssets,
    buildSkillMdTemplate,
    exists,
    getWritableSkillRoot,
    normalizeRel,
    transferSelections: (side, selections, options) => transferSelections(side, selections, options),
    uniqueSelections,
    mirrorGroupsByIds,
    resolveContext,
    ensurePersonalSkillHome,
    settingsSection: SETTINGS_SECTION,
    clearCentralRepoPathOverrides,
    diagnoseEnvironment,
    resetPersonalSkillHome,
    getActiveWorkspacePath,
    getDefaultCentralRepoPath,
    defaultCentralRepoPathSetting: DEFAULT_CENTRAL_REPO_PATH,
    compactPathForDisplay,
    allAgents: ALL_AGENTS,
    getWritableSkillRootForEnv: (basePath, tool, mode) => getWritableSkillRoot(basePath, tool, mode),
    saveSelectionGroups,
    dedupeGroupTargets,
    slugifyPackId
  });
  const projectPresetTools = createProjectPresetCommandTools({
    tr, toUserError, handleError, state,
    refresh: async () => void (await refresh()),
    getUiLanguage: () => uiLanguage, registerLanguageRefresh,
    loadProjectPresets, saveProjectPresets, saveSelectionGroups, getWizardAssetPicks,
    statusLabelForWizard, targetExistsInFiles, targetsToSelections,
    transferSelections: (side, selections, options) => transferSelections(side, selections, options),
    dedupeGroupTargets, slugifyProjectPresetId, buildGroupTargetsFromNodes,
    getSkillFolderRelativePath,
    resolveGroup: (node) => resolveGroup(node), normalizeGroupsForCurrentSkills,
    upsertPresetWorkspaceGroup: async (presetName, presetId, targets) => { await upsertHydratedWorkspaceGroup(presetName, presetId, targets); }
  });

  registerExtensionCommands({
    register, tr, toUserError, handleError, settingsSection: SETTINGS_SECTION, state,
    workspaceProvider, centralProvider, unwrapSkillNode,
    openNodeIfFile, openFolderInOs, showGroupActions,
    openGroupOverview, openNpxSkillLibrary, renameGroup, editGroupDescription,
    refresh: async () => { await refresh(); }, saveSelectionGroups,
    applyGroupHighlight: (group) => applyGroupHighlight(state, group, workspaceProvider, centralProvider),
    createGroupFromSelection, resolveGroupingNodes, addSelectionToExistingGroup,
    createSkillItem, createSkillFolder, showQuickSkillCrud, showSmartActions,
    runNodeCrud, copyNodesToClipboard, copyNodePathToClipboard, pasteNodesFromClipboard, installSkills,
    runAgentCopyWizard, runGroupAgentCopyWizard, showSkillHistory,
    showNodeWarningReasons, openTransferExplorerPanel, openLibraryManagerPanel,
    openAddMoveWizardPanel, hydrateCurrentProject,
    downloadCentralSkillToWorkspace, downloadSkillManagerSkillToWorkspace, createCentralPack,
    openProjectPresetOverview: (node) => projectPresetTools.openProjectPresetOverview(node),
    applyProjectPreset: (node) => projectPresetTools.applyProjectPreset(node),
    createProjectPresetFromCentral: () => projectPresetTools.createProjectPresetFromCentral(),
    createProjectPresetFromWorkspace: (node) => projectPresetTools.createProjectPresetFromWorkspace(unwrapSkillNode(node)),
    createProjectPresetFromWorkspaceGroup: (node) => projectPresetTools.createProjectPresetFromWorkspaceGroup(node),
    renameProjectPreset: (node) => projectPresetTools.renameProjectPreset(node),
    editProjectPresetDescription: (node) => projectPresetTools.editProjectPresetDescription(node),
    deleteProjectPreset: (node) => projectPresetTools.deleteProjectPreset(node), repairCentralMetadata: () => projectPresetTools.repairCentralMetadata(),
    runEnvironmentDiagnosis, getAutoSyncWorkspaceAgents,
    resolveWorkspaceAutoSyncToolFromNode, formatAgentFolderLabel,
    toggleWorkspaceAgentAutoSync, syncWorkspaceAgentToCentralNow,
    setLanguage: setLanguageAndRefreshViews,
    applyLanguageChrome,
    updateStatusChrome,
    applyTabFilter: () => applyTabFilter(state, workspaceProvider, centralProvider),
    setPersonalSkillHome,
    runResetPersonalHome: runResetPersonalSkillHome,
    promoteSelected,
    importSelected,
    exportGroup: async (side) => await exportGroup(side)
  });

  const centralPathRepairTools = createCentralPathRepairTools({
    tr,
    output,
    toUserError,
    state,
    settingsSection: SETTINGS_SECTION,
    getActiveWorkspacePath,
    ensurePersonalSkillHome,
    allAgents: ALL_AGENTS,
    getWritableSkillRoot: (basePath, tool, mode) => getWritableSkillRoot(basePath, tool, mode),
    clearCentralRepoPathOverrides,
    refresh,
    compactPathForDisplay,
    runEnvironmentDiagnosis
  });
  ({ offerCentralPathRepair } = centralPathRepairTools);
  register("skillBridge.repairCentralPath", async () => {
    await centralPathRepairTools.openCentralPathRepairPicker();
  });

  output.appendLine(`[Activation] registered in ${Date.now() - activationStartedAt}ms; initial refresh queued`);
  void refresh().catch(async (error) => {
    await handleError(error);
  });
}

export function deactivate(): void {
  // noop
}
