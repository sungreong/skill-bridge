import path from "node:path";
import { promises as fs } from "node:fs";
import * as vscode from "vscode";
import type { GroupTarget, SelectionGroup, SkillFile, SkillTreeNode, ToolType } from "./types";
import type { UiLanguage } from "./uiLanguage";
import { tabLabel, type SourceTab } from "./extensionSupport";
import { applySkillBridgePanelBranding } from "./webviewPanelBranding";

type TreeSide = "workspace" | "central";

export function createExtensionShellTools(args: {
  extensionUri: vscode.Uri;
  settingsSection: string;
  tr: (message: string, ...args: Array<string | number | boolean>) => string;
  state: {
    workspacePath: string;
    centralRepoPath: string;
    activeTab: SourceTab;
    workspaceSkills: SkillFile[];
    centralSkills: SkillFile[];
    workspaceMissingSkillFolders: Array<{ tool: ToolType; relativePath: string }>;
    groups: SelectionGroup[];
    agents: ToolType[];
  };
  workspaceView: vscode.TreeView<{ node: SkillTreeNode }>;
  centralView: vscode.TreeView<{ node: SkillTreeNode }>;
  workspaceProvider: {
    setLanguage: (language: UiLanguage) => void;
    getSelected: () => SkillTreeNode | null | undefined;
  };
  centralProvider: {
    setLanguage: (language: UiLanguage) => void;
    getSelected: () => SkillTreeNode | null | undefined;
  };
  compactPathForDisplay: (value: string) => string;
  getUiLanguage: () => UiLanguage;
  updateStatusChromeCore: () => void;
  refresh: () => Promise<unknown>;
  getSkillRoot: (basePath: string, tool: ToolType, mode: TreeSide) => string;
  isWithinPath: (basePath: string, targetPath: string) => boolean;
  normalizeRel: (input: string) => string;
  getSkillFolderRelativePath: (relativePath: string) => string | null;
  collapseLibraryTargets: (targets: Array<{ tool: ToolType; relativePath: string; kind: "file" | "folder" }>) => Array<{ tool: ToolType; relativePath: string; kind: "file" | "folder" }>;
  uniqueSelections: (selections: Array<{ tool: ToolType; relativePath: string }>) => Array<{ tool: ToolType; relativePath: string }>;
  targetsToSelections: (files: SkillFile[], targets: GroupTarget[]) => Array<{ tool: ToolType; relativePath: string }>;
  transferSelections: (
    side: TreeSide,
    selections: Array<{ tool: ToolType; relativePath: string }>,
    options?: {
      groupContext?: { id: string; name: string; side: TreeSide };
      scopeHints?: Array<{ tool: ToolType; relativePath: string; kind: "file" | "folder" }>;
    }
  ) => Promise<{ copied: number; deleted: number; unchanged: number; affectedGroupIds: string[] }>;
  mirrorGroupToOtherSide: (group: SelectionGroup, options?: { requireExistingTargets?: boolean }) => Promise<boolean>;
}): {
  getAutoSyncWorkspaceAgents: () => ToolType[];
  formatAgentFolderLabel: (tool: ToolType) => string;
  resolveWorkspaceAgentToolFromNode: (node?: SkillTreeNode) => ToolType | undefined;
  resolveWorkspaceAutoSyncToolFromNode: (node?: SkillTreeNode) => ToolType | undefined;
  resolveSelectedAgentToolForSide: (side: TreeSide, node?: SkillTreeNode) => ToolType | undefined;
  toggleWorkspaceAgentAutoSync: (tool: ToolType) => Promise<boolean>;
  syncWorkspaceAgentToCentralNow: (tool: ToolType) => Promise<{ summary: { syncedFolders: number; mirroredGroups: number; copied: number; deleted: number; unchanged: number; centralFolders: number; centralFiles: number; skippedMissingSkillMd: number } }>;
  updateStatusChrome: () => void;
  applyLanguageChrome: () => void;
  applyPanelBranding: (panel: vscode.WebviewPanel, refresh: () => Promise<void> | void) => void;
  getWorkspaceChangedSkillFolder: (absolutePath: string) => { tool: ToolType; skillFolderRel: string } | null;
  syncWorkspaceAgentFoldersToCentral: (
    folders: Array<{ tool: ToolType; skillFolderRel: string }>,
    reason: "auto" | "manual"
  ) => Promise<{ syncedFolders: number; mirroredGroups: number; copied: number; deleted: number; unchanged: number; centralFolders: number; centralFiles: number; skippedMissingSkillMd: number }>;
} {
  const getAutoSyncWorkspaceAgents = (): ToolType[] => {
    const configured = vscode.workspace.getConfiguration(args.settingsSection).get<string[]>("autoSyncWorkspaceAgents", []);
    const allowed = new Set(args.state.agents);
    return configured.filter((tool): tool is ToolType => allowed.has(tool as ToolType));
  };

  const formatAgentFolderLabel = (tool: ToolType): string => tool === "agents" ? ".agents" : `.${tool}`;

  const resolveWorkspaceAgentToolFromNode = (node?: SkillTreeNode): ToolType | undefined => {
    const relativePath = node?.relativePath ?? "";
    const firstSegment = relativePath.split("/").find(Boolean);
    const folderName = firstSegment === "skills" ? "agents" : firstSegment;
    return folderName && args.state.agents.includes(folderName as ToolType)
      ? folderName as ToolType
      : undefined;
  };

  const resolveWorkspaceAutoSyncToolFromNode = (node?: SkillTreeNode): ToolType | undefined => {
    const target = resolveWorkspaceAgentToolFromNode(node);
    return target && getAutoSyncWorkspaceAgents().includes(target) ? target : target;
  };

  const resolveSelectedAgentToolForSide = (side: TreeSide, node?: SkillTreeNode): ToolType | undefined => {
    const fromNode = side === "workspace" ? resolveWorkspaceAgentToolFromNode(node) : undefined;
    if (fromNode) return fromNode;
    const providerSelected = (side === "workspace" ? args.workspaceProvider.getSelected() : args.centralProvider.getSelected()) ?? undefined;
    if (side === "workspace") {
      const fromSelected = resolveWorkspaceAgentToolFromNode(providerSelected);
      if (fromSelected) return fromSelected;
    }
    return undefined;
  };

  const toggleWorkspaceAgentAutoSync = async (tool: ToolType): Promise<boolean> => {
    const current = new Set(getAutoSyncWorkspaceAgents());
    if (current.has(tool)) {
      current.delete(tool);
    } else {
      current.add(tool);
    }
    const next = [...current];
    await vscode.workspace.getConfiguration(args.settingsSection).update("autoSyncWorkspaceAgents", next, vscode.ConfigurationTarget.Global);
    return current.has(tool);
  };

  const syncWorkspaceAgentFoldersToCentral = async (
    folders: Array<{ tool: ToolType; skillFolderRel: string }>,
    reason: "auto" | "manual"
  ): Promise<{ syncedFolders: number; mirroredGroups: number; copied: number; deleted: number; unchanged: number; centralFolders: number; centralFiles: number; skippedMissingSkillMd: number }> => {
    if (!args.state.workspacePath || !args.state.centralRepoPath) await args.refresh();
    if (folders.length === 0) return { syncedFolders: 0, mirroredGroups: 0, copied: 0, deleted: 0, unchanged: 0, centralFolders: 0, centralFiles: 0, skippedMissingSkillMd: 0 };

    const scopeHints = args.collapseLibraryTargets(
      folders.map((item) => ({ tool: item.tool, relativePath: item.skillFolderRel, kind: "folder" as const }))
    );
    if (scopeHints.length === 0) return { syncedFolders: 0, mirroredGroups: 0, copied: 0, deleted: 0, unchanged: 0, centralFolders: 0, centralFiles: 0, skippedMissingSkillMd: 0 };

    const skippedMissingSkillMd = args.state.workspaceMissingSkillFolders.filter((folder) =>
      scopeHints.some((hint) => hint.tool === folder.tool && hint.relativePath === folder.relativePath)
    ).length;

    await Promise.all([...new Set(scopeHints.map((hint) => hint.tool))].map(async (tool) => {
      await fs.mkdir(path.join(args.getSkillRoot(args.state.centralRepoPath, tool, "central"), "skills"), { recursive: true });
    }));

    const workspaceSelections = args.uniqueSelections(
      scopeHints.flatMap((hint) =>
        args.state.workspaceSkills
          .filter((file) => file.tool === hint.tool && file.relativePath.startsWith(`${hint.relativePath}/`))
          .map((file) => ({ tool: file.tool, relativePath: file.relativePath }))
      )
    );
    if (workspaceSelections.length === 0) {
      return {
        syncedFolders: scopeHints.length,
        mirroredGroups: 0,
        copied: 0,
        deleted: 0,
        unchanged: 0,
        centralFolders: 0,
        centralFiles: 0,
        skippedMissingSkillMd
      };
    }

    const result = await args.transferSelections("workspace", workspaceSelections, { scopeHints });
    let mirroredGroups = 0;
    for (const group of args.state.groups.filter((item) => item.side === "workspace")) {
      const selections = args.targetsToSelections(args.state.workspaceSkills, group.targets);
      if (selections.length === 0) continue;
      const groupHasTouchedFolder = group.targets.some((target) =>
        scopeHints.some((hint) => hint.tool === target.tool && target.relativePath.startsWith(hint.relativePath))
      );
      if (!groupHasTouchedFolder) continue;
      if (await args.mirrorGroupToOtherSide(group, { requireExistingTargets: true })) {
        mirroredGroups += 1;
      }
    }
    await args.refresh();
    const centralFiles = args.state.centralSkills.filter((file) =>
      scopeHints.some((hint) => file.tool === hint.tool && file.relativePath.startsWith(`${hint.relativePath}/`))
    );
    const centralFolders = new Set(
      centralFiles
        .map((file) => args.getSkillFolderRelativePath(file.relativePath))
        .filter((value): value is string => !!value)
    ).size;
    return {
      syncedFolders: scopeHints.length,
      mirroredGroups,
      copied: result.copied,
      deleted: result.deleted,
      unchanged: result.unchanged,
      centralFolders,
      centralFiles: centralFiles.length,
      skippedMissingSkillMd
    };
  };

  const syncWorkspaceAgentToCentralNow = async (
    tool: ToolType
  ): Promise<{ summary: { syncedFolders: number; mirroredGroups: number; copied: number; deleted: number; unchanged: number; centralFolders: number; centralFiles: number; skippedMissingSkillMd: number } }> => {
    const folderSet = new Set(
      args.state.workspaceSkills
        .filter((file) => file.tool === tool)
        .map((file) => args.getSkillFolderRelativePath(file.relativePath))
        .filter((value): value is string => !!value)
    );
    const folders = [...folderSet].sort((a, b) => a.localeCompare(b)).map((skillFolderRel) => ({ tool, skillFolderRel }));
    return { summary: await syncWorkspaceAgentFoldersToCentral(folders, "manual") };
  };

  const updateStatusChrome = (): void => {
    const groupCounts = args.state.groups.reduce((acc, group) => {
      if (group.side === "workspace") acc.workspace += 1;
      if (group.side === "central") acc.central += 1;
      return acc;
    }, { workspace: 0, central: 0 });
    const tab = args.state.activeTab === "all" ? args.tr("All") : tabLabel(args.state.activeTab);
    const selectedAgents = getAutoSyncWorkspaceAgents().map(formatAgentFolderLabel).join(", ");
    const autoSyncLabel = selectedAgents.length > 0 ? selectedAgents : args.tr("off");
    const groupLabel = args.tr("groups W {0} / C {1}", String(groupCounts.workspace), String(groupCounts.central));
    args.updateStatusChromeCore();
    vscode.window.setStatusBarMessage(
      `Skill Bridge · ${tab} · W ${args.state.workspaceSkills.length} / C ${args.state.centralSkills.length} · ${groupLabel} · auto save ${autoSyncLabel}`,
      2500
    );
  };

  const applyLanguageChrome = (): void => {
    const uiLanguage = args.getUiLanguage();
    args.workspaceProvider.setLanguage(uiLanguage);
    args.centralProvider.setLanguage(uiLanguage);
    updateStatusChrome();
    args.workspaceView.title = args.tr("Workspace Skills");
    args.centralView.title = args.tr("Central Skills");
    args.workspaceView.description = args.state.workspacePath ? args.compactPathForDisplay(args.state.workspacePath) : undefined;
    args.centralView.description = args.state.centralRepoPath ? args.compactPathForDisplay(args.state.centralRepoPath) : undefined;
  };

  const applyPanelBranding = (
    panel: vscode.WebviewPanel,
    _render?: () => Promise<void> | void
  ): void => {
    applySkillBridgePanelBranding(panel, args.extensionUri);
  };

  const getWorkspaceChangedSkillFolder = (absolutePath: string): { tool: ToolType; skillFolderRel: string } | null => {
    const normalizedAbsolute = path.resolve(absolutePath);
    for (const tool of args.state.agents) {
      const toolRoot = args.getSkillRoot(args.state.workspacePath, tool, "workspace");
      if (!args.isWithinPath(toolRoot, normalizedAbsolute)) continue;
      const relativePath = args.normalizeRel(path.relative(toolRoot, normalizedAbsolute));
      const skillFolderRel = args.getSkillFolderRelativePath(relativePath);
      if (!skillFolderRel) return null;
      return { tool, skillFolderRel };
    }
    return null;
  };

  return {
    getAutoSyncWorkspaceAgents,
    formatAgentFolderLabel,
    resolveWorkspaceAgentToolFromNode,
    resolveWorkspaceAutoSyncToolFromNode,
    resolveSelectedAgentToolForSide,
    toggleWorkspaceAgentAutoSync,
    syncWorkspaceAgentToCentralNow,
    updateStatusChrome,
    applyLanguageChrome,
    applyPanelBranding,
    getWorkspaceChangedSkillFolder,
    syncWorkspaceAgentFoldersToCentral
  };
}
