import type * as vscode from "vscode";
import { createCentralMetadataRepairTools } from "./extensionCentralMetadataRepair";
import { createProjectPresetTools } from "./extensionProjectPresets";
import { createProjectPresetOverviewTools } from "./projectPresetOverviewView";
import type { GroupTarget, ProjectPreset, ProjectPresetsFile, SelectionGroup, SkillFile, SkillSelection, SkillTreeNode, ToolType } from "./types";
import type { UiLanguage } from "./uiLanguage";
import type { WizardAssetPick } from "./extensionAddMoveWizard";

type TreeSide = "workspace" | "central";
type TranslationFn = (english: string, korean: string) => string;

export function createProjectPresetCommandTools(args: {
  tr: TranslationFn;
  toUserError: (error: unknown) => string;
  state: {
    workspacePath: string;
    centralRepoPath: string;
    workspaceSkills: SkillFile[];
    centralSkills: SkillFile[];
    centralProjectPresets: ProjectPreset[];
    groups: SelectionGroup[];
    workspaceSelection: SkillTreeNode[];
  };
  refresh: () => Promise<void>;
  getUiLanguage: () => UiLanguage;
  registerLanguageRefresh: (panel: vscode.WebviewPanel, render: () => void | Promise<void>) => void;
  loadProjectPresets: (centralRepoPath: string) => Promise<{ file: ProjectPresetsFile; migratedFromLegacy: boolean }>;
  saveProjectPresets: (centralRepoPath: string, file: ProjectPresetsFile) => Promise<void>;
  saveSelectionGroups: (workspacePath: string, centralRepoPath: string, groups: SelectionGroup[]) => Promise<void>;
  getWizardAssetPicks: (side: TreeSide) => WizardAssetPick[];
  statusLabelForWizard: (status: WizardAssetPick["status"]) => string;
  targetExistsInFiles: (target: GroupTarget, files: SkillFile[]) => boolean;
  targetsToSelections: (files: SkillFile[], targets: GroupTarget[]) => SkillSelection[];
  transferSelections: (side: TreeSide, selections: SkillSelection[], options?: { scopeHints?: GroupTarget[]; repoContext?: { repo: string } }) => Promise<{ copied: number; deleted: number; unchanged: number; failed?: number }>;
  dedupeGroupTargets: (targets: GroupTarget[]) => GroupTarget[];
  slugifyProjectPresetId: (value: string) => string;
  buildGroupTargetsFromNodes: (nodes: SkillTreeNode[]) => GroupTarget[];
  getSkillFolderRelativePath: (relativePath: string) => string | null;
  resolveGroup: (node?: unknown) => SelectionGroup | undefined;
  upsertPresetWorkspaceGroup: (presetName: string, presetId: string, targets: GroupTarget[]) => Promise<void>;
  normalizeGroupsForCurrentSkills: Parameters<typeof createCentralMetadataRepairTools>[0]["normalizeGroupsForCurrentSkills"];
}): ReturnType<typeof createProjectPresetTools> & {
  openProjectPresetOverview: (node?: unknown) => Promise<void>;
  repairCentralMetadata: () => Promise<void>;
} {
  const projectPresetTools = createProjectPresetTools({
    tr: args.tr,
    toUserError: args.toUserError,
    state: args.state,
    refresh: args.refresh,
    loadProjectPresets: args.loadProjectPresets,
    saveProjectPresets: args.saveProjectPresets,
    getWizardAssetPicks: args.getWizardAssetPicks,
    statusLabelForWizard: args.statusLabelForWizard,
    targetExistsInFiles: args.targetExistsInFiles,
    targetsToSelections: args.targetsToSelections,
    transferSelections: args.transferSelections,
    dedupeGroupTargets: args.dedupeGroupTargets,
    slugifyProjectPresetId: args.slugifyProjectPresetId,
    buildGroupTargetsFromNodes: args.buildGroupTargetsFromNodes,
    getSkillFolderRelativePath: args.getSkillFolderRelativePath,
    resolveGroup: args.resolveGroup,
    upsertPresetWorkspaceGroup: args.upsertPresetWorkspaceGroup
  });
  const { repairCentralMetadata } = createCentralMetadataRepairTools({
    tr: args.tr,
    toUserError: args.toUserError,
    state: args.state,
    refresh: args.refresh,
    loadProjectPresets: args.loadProjectPresets,
    saveProjectPresets: args.saveProjectPresets,
    saveSelectionGroups: args.saveSelectionGroups,
    dedupeGroupTargets: args.dedupeGroupTargets,
    targetExistsInFiles: args.targetExistsInFiles,
    normalizeGroupsForCurrentSkills: args.normalizeGroupsForCurrentSkills
  });
  const { openProjectPresetOverview } = createProjectPresetOverviewTools({
    tr: args.tr,
    getUiLanguage: args.getUiLanguage,
    refresh: args.refresh,
    registerLanguageRefresh: args.registerLanguageRefresh,
    state: args.state,
    loadProjectPresets: args.loadProjectPresets,
    saveProjectPresets: args.saveProjectPresets,
    applyProjectPreset: (node) => projectPresetTools.applyProjectPreset(node),
    createProjectPresetFromCentral: () => projectPresetTools.createProjectPresetFromCentral(),
    deleteProjectPreset: (node) => projectPresetTools.deleteProjectPreset(node),
    repairCentralMetadata,
    slugifyProjectPresetId: args.slugifyProjectPresetId,
    targetExistsInFiles: args.targetExistsInFiles,
    toUserError: args.toUserError
  });
  return { ...projectPresetTools, openProjectPresetOverview, repairCentralMetadata };
}
