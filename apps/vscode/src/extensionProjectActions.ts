import { promises as fs } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import {
  DEFAULT_CENTRAL_REPO_PATH_SETTING,
  formatCentralPathIssue,
  resolveCentralRepoPath,
  type ResolvedCentralRepoPath
} from "./centralPath";
import { createFileUriFromAbsolutePath } from "./extensionSupport";
import type { GroupTarget, SelectionGroup, SkillAssetTreeMeta, SkillFile, SkillTreeFilterMode, ToolType } from "./types";
import type { UiLanguage } from "./uiLanguage";
import type { WizardAssetPick } from "./extensionAddMoveWizard";
import type { diagnoseEnvironment, resetPersonalSkillHome } from "./extensionEnvironment";
import type { ExtensionRefreshResult } from "./extensionRefreshRuntime";

type TreeSide = "workspace" | "central";
type ProjectContext = {
  workspacePath: string;
  centralRepoPath: string;
  configuredCentralRepoPath: string | null;
  centralResolution: ResolvedCentralRepoPath;
};

export function createExtensionProjectActions(args: {
  tr: (message: string, ...args: Array<string | number | boolean>) => string;
  toUserError: (error: unknown) => string;
  handleError: (error: unknown) => Promise<void>;
  output: vscode.OutputChannel;
  state: {
    workspacePath: string;
    centralRepoPath: string;
    workspaceSkills: SkillFile[];
    centralSkills: SkillFile[];
    workspaceMissingSkillFolders: Array<{ tool: ToolType; relativePath: string }>;
    centralMissingSkillFolders: Array<{ tool: ToolType; relativePath: string }>;
    workspaceAssetMeta: Map<string, SkillAssetTreeMeta>;
    centralAssetMeta: Map<string, SkillAssetTreeMeta>;
    treeFilter: SkillTreeFilterMode;
    groups: SelectionGroup[];
  };
  uiLanguage: () => UiLanguage;
  refresh: () => Promise<ExtensionRefreshResult>;
  pickWizardSide: (title: string) => Promise<TreeSide | undefined>;
  pickTool: () => Promise<ToolType | undefined>;
  pickWizardAsset: (side: TreeSide, title: string) => Promise<{ tool: ToolType; rootRelativePath: string; status?: string } | undefined>;
  getWizardAssetPicks: (side: TreeSide) => WizardAssetPick[];
  summarizeWizardAssets: (assets: WizardAssetPick[]) => {
    total: number;
    changed: number;
    fresh: number;
    risk: number;
    missing: number;
    recent: number;
    preview: Array<{ tool: ToolType; skillName: string; status: string; warnings: number; fileCount: number }>;
  };
  buildSkillMdTemplate: (name: string) => string;
  exists: (path: string) => Promise<boolean>;
  getWritableSkillRoot: (basePath: string, tool: ToolType, mode: TreeSide) => string;
  normalizeRel: (input: string) => string;
  transferSelections: (side: TreeSide, selections: Array<{ tool: ToolType; relativePath: string }>, options?: { scopeHints?: Array<{ tool: ToolType; relativePath: string; kind: "folder" }> }) => Promise<{ copied: number; deleted: number; unchanged: number; affectedGroupIds: string[] }>;
  uniqueSelections: (selections: Array<{ tool: ToolType; relativePath: string }>) => Array<{ tool: ToolType; relativePath: string }>;
  mirrorGroupsByIds: (side: TreeSide, groupIds: string[]) => Promise<number>;
  resolveContext: () => { workspacePath: string; centralRepoPath: string } | undefined;
  ensurePersonalSkillHome: (args: {
    basePath: string;
    allAgents: ToolType[];
    getWritableSkillRoot: (basePath: string, tool: ToolType, mode: TreeSide) => string;
  }) => Promise<void>;
  settingsSection: string;
  clearCentralRepoPathOverrides: () => Promise<void>;
  diagnoseEnvironment: (args: Parameters<typeof diagnoseEnvironment>[0]) => Promise<void>;
  resetPersonalSkillHome: (args: Parameters<typeof resetPersonalSkillHome>[0]) => Promise<void>;
  getActiveWorkspacePath: () => string;
  getDefaultCentralRepoPath: (workspacePath: string) => string;
  defaultCentralRepoPathSetting: string;
  compactPathForDisplay: (input: string) => string;
  allAgents: ToolType[];
  getWritableSkillRootForEnv: (basePath: string, tool: ToolType, mode: TreeSide) => string;
  saveSelectionGroups: (workspacePath: string, centralRepoPath: string, groups: SelectionGroup[]) => Promise<void>;
  dedupeGroupTargets: (targets: GroupTarget[]) => GroupTarget[];
  slugifyPackId: (packId: string) => string;
}): {
  buildAddMoveWizardPayload: () => {
    workspace: unknown;
    central: unknown;
    activeFilter: SkillTreeFilterMode;
    language: UiLanguage;
  };
  runNewSkillWizard: () => Promise<void>;
  runAssetTransferWizard: (sourceSide: TreeSide) => Promise<void>;
  setPersonalSkillHome: () => Promise<void>;
  runEnvironmentDiagnosis: () => Promise<void>;
  runResetPersonalSkillHome: () => Promise<void>;
  upsertHydratedWorkspaceGroup: (packName: string, packId: string, targets: GroupTarget[]) => Promise<void>;
} {
  const buildAddMoveWizardPayload = () => ({
    workspace: args.summarizeWizardAssets(args.getWizardAssetPicks("workspace")),
    central: args.summarizeWizardAssets(args.getWizardAssetPicks("central")),
    activeFilter: args.state.treeFilter,
    language: args.uiLanguage()
  });

  const getConfiguredCentralRepoPath = (): string | undefined => {
    const inspected = vscode.workspace.getConfiguration(args.settingsSection).inspect<string>("centralRepoPath");
    const configured = inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
    return typeof configured === "string" && configured.trim() ? configured.trim() : undefined;
  };

  const resolveProjectContext = async (options?: { allowCentralFallback?: boolean }): Promise<ProjectContext> => {
    const stateWorkspacePath = args.state.workspacePath.trim();
    let workspacePath = stateWorkspacePath || args.getActiveWorkspacePath();
    if (!workspacePath) {
      const resolved = args.resolveContext();
      workspacePath = workspacePath || resolved?.workspacePath || "";
    }

    if (!workspacePath) {
      throw new Error(args.tr("Open a workspace folder first."));
    }

    const configuredCentralRepoPath = getConfiguredCentralRepoPath();
    let centralResolution = configuredCentralRepoPath
      ? resolveCentralRepoPath(configuredCentralRepoPath, workspacePath, "configured")
      : resolveCentralRepoPath(args.defaultCentralRepoPathSetting, workspacePath, "default");
    let centralRepoPath = centralResolution.ok ? centralResolution.absolutePath : centralResolution.fallbackPath;

    if (!configuredCentralRepoPath) {
      centralRepoPath = args.getDefaultCentralRepoPath(workspacePath);
      await args.ensurePersonalSkillHome({
        basePath: centralRepoPath,
        allAgents: args.allAgents,
        getWritableSkillRoot: args.getWritableSkillRootForEnv
      });
      await vscode.workspace
        .getConfiguration(args.settingsSection)
        .update("centralRepoPath", DEFAULT_CENTRAL_REPO_PATH_SETTING, vscode.ConfigurationTarget.Global);
      await args.clearCentralRepoPathOverrides();
      args.output.appendLine(`[EnvironmentContext] centralRepoPath missing; set default=${centralRepoPath}`);
      centralResolution = resolveCentralRepoPath(DEFAULT_CENTRAL_REPO_PATH_SETTING, workspacePath, "default");
    } else if (!centralResolution.ok && !options?.allowCentralFallback) {
      throw new Error(formatCentralPathIssue(centralResolution));
    }

    if (!centralRepoPath) {
      throw new Error(args.tr("Central library path is not configured."));
    }

    args.state.workspacePath = workspacePath;
    if (centralResolution.ok) {
      args.state.centralRepoPath = centralRepoPath;
    }
    return {
      workspacePath,
      centralRepoPath,
      configuredCentralRepoPath: configuredCentralRepoPath ?? null,
      centralResolution
    };
  };

  const runNewSkillWizard = async (): Promise<void> => {
    const side = await args.pickWizardSide(args.tr("Choose where to create the new skill"));
    if (!side) return;
    const tool = await args.pickTool();
    if (!tool) return;
    const name = await vscode.window.showInputBox({
      title: args.tr("New Skill Name"),
      prompt: args.tr("Creates skills/<name>/SKILL.md."),
      validateInput: (value) => {
        const normalized = value.trim();
        if (!normalized) return args.tr("Enter a skill name.");
        if (normalized.includes("/") || normalized.includes("\\") || normalized.includes("..")) {
          return args.tr("Skill names cannot include path separators or '..'.");
        }
        return null;
      },
      ignoreFocusOut: true
    });
    if (!name?.trim()) return;

    const basePath = side === "workspace" ? args.state.workspacePath : args.state.centralRepoPath;
    const toolRoot = args.getWritableSkillRoot(basePath, tool, side);
    const folderRel = args.normalizeRel(path.posix.join("skills", name.trim()));
    const folderAbs = path.join(toolRoot, folderRel);
    if (await args.exists(folderAbs)) {
      vscode.window.showWarningMessage(args.tr("A skill already exists: {0}/{1}", String(tool), String(folderRel)));
      return;
    }
    await fs.mkdir(folderAbs, { recursive: true });
    await fs.writeFile(path.join(folderAbs, "SKILL.md"), args.buildSkillMdTemplate(name.trim()), "utf8");
    vscode.window.showInformationMessage(args.tr("New skill created: {0} {1}/{2}", String(side), String(tool), String(folderRel)));
  };

  const runAssetTransferWizard = async (sourceSide: TreeSide): Promise<void> => {
    const asset = await args.pickWizardAsset(sourceSide, sourceSide === "workspace" ? args.tr("Choose a skill to save to Central") : args.tr("Choose a skill to bring to Workspace"));
    if (!asset) return;
    if (asset.status === "missingSkillMd") {
      vscode.window.showWarningMessage(args.tr("Skills without SKILL.md cannot be applied."));
      return;
    }
    const sourceFiles = sourceSide === "workspace" ? args.state.workspaceSkills : args.state.centralSkills;
    const selections = args.uniqueSelections(
      sourceFiles
        .filter((file) => file.tool === asset.tool && file.relativePath.startsWith(`${asset.rootRelativePath}/`))
        .map((file) => ({ tool: file.tool, relativePath: file.relativePath }))
    );
    if (selections.length === 0) {
      vscode.window.showWarningMessage(args.tr("No files were found to apply."));
      return;
    }
    const result = await args.transferSelections(sourceSide, selections, {
      scopeHints: [{ tool: asset.tool, relativePath: asset.rootRelativePath, kind: "folder" }]
    });
    const mirroredGroups = await args.mirrorGroupsByIds(sourceSide, result.affectedGroupIds);
    await args.refresh();
    vscode.window.showInformationMessage(
      args.tr("Skill apply result: copied {0} · deleted {1} · unchanged {2}{3}", String(result.copied), String(result.deleted), String(result.unchanged), String(mirroredGroups > 0 ? ` · applied groups ${mirroredGroups}` : ""))
    );
  };

  const setPersonalSkillHome = async (): Promise<void> => {
    try {
      const projectContext = await resolveProjectContext({ allowCentralFallback: true });
      const current = projectContext.centralResolution.ok
        ? projectContext.centralRepoPath
        : projectContext.centralResolution.fallbackPath;
      const picked = await vscode.window.showOpenDialog({
        title: args.tr("Choose Central Library Folder"),
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        defaultUri: createFileUriFromAbsolutePath(current)
      });
      const folder = picked?.[0]?.fsPath;
      if (!folder) return;
      await fs.mkdir(folder, { recursive: true });
      await args.ensurePersonalSkillHome({
        basePath: folder,
        allAgents: args.allAgents,
        getWritableSkillRoot: args.getWritableSkillRootForEnv
      });
      await vscode.workspace.getConfiguration(args.settingsSection).update("centralRepoPath", folder, vscode.ConfigurationTarget.Global);
      await args.clearCentralRepoPathOverrides();
      await args.refresh();
      vscode.window.showInformationMessage(args.tr("Central library folder set: {0}", String(folder)));
    } catch (error) {
      await args.handleError(error);
    }
  };

  const runEnvironmentDiagnosis = async (): Promise<void> => {
    const projectContext = await resolveProjectContext({ allowCentralFallback: true });
    await args.diagnoseEnvironment({
      tr: args.tr,
      output: args.output,
      toUserError: args.toUserError,
      collectEnvironmentDiagnosisArgs: {
        exists: args.exists,
        allAgents: args.allAgents,
        workspacePath: projectContext.workspacePath,
        centralRepoPath: projectContext.centralRepoPath,
        configuredCentralRepoPath: projectContext.configuredCentralRepoPath,
        configuredCentralResolution: projectContext.centralResolution,
        defaultCentralPath: args.getDefaultCentralRepoPath(projectContext.workspacePath),
        getWritableSkillRoot: args.getWritableSkillRootForEnv,
        settingsSection: args.settingsSection
      },
      repairUserCentralHomeArgs: {
        settingsSection: args.settingsSection,
        defaultCentralRepoPathSetting: args.defaultCentralRepoPathSetting,
        clearCentralRepoPathOverrides: args.clearCentralRepoPathOverrides,
        allAgents: args.allAgents,
        getWritableSkillRoot: args.getWritableSkillRootForEnv,
        refresh: args.refresh,
        output: args.output,
        compactPathForDisplay: args.compactPathForDisplay
      }
    });
  };

  const runResetPersonalSkillHome = async (): Promise<void> => {
    const projectContext = await resolveProjectContext({ allowCentralFallback: true });
    await args.resetPersonalSkillHome({
      tr: args.tr,
      output: args.output,
      toUserError: args.toUserError,
      stateWorkspacePath: projectContext.workspacePath,
      stateCentralRepoPath: projectContext.centralResolution.ok
        ? projectContext.centralRepoPath
        : projectContext.centralResolution.rawValue,
      getActiveWorkspacePath: args.getActiveWorkspacePath,
      resolveContext: args.resolveContext,
      getDefaultCentralRepoPath: args.getDefaultCentralRepoPath,
      defaultCentralRepoPathSetting: args.defaultCentralRepoPathSetting,
      settingsSection: args.settingsSection,
      clearCentralRepoPathOverrides: args.clearCentralRepoPathOverrides,
      allAgents: args.allAgents,
      getWritableSkillRoot: args.getWritableSkillRootForEnv,
      refresh: args.refresh,
      compactPathForDisplay: args.compactPathForDisplay
    });
  };

  const upsertHydratedWorkspaceGroup = async (
    packName: string,
    packId: string,
    targets: GroupTarget[]
  ): Promise<void> => {
    const now = new Date().toISOString();
    const key = `preset:${packId}`;
    const legacyKey = `pack:${packId}`;
    const nextGroup: SelectionGroup = {
      id: args.state.groups.find((group) => group.side === "workspace" && (group.meta?.repoKey === key || group.meta?.repoKey === legacyKey))?.id
        ?? `hydrated-${args.slugifyPackId(packId)}-${Date.now()}`,
      name: `Preset: ${packName}`,
      side: "workspace",
      targets: args.dedupeGroupTargets(targets),
      meta: {
        source: "manual",
        repoKey: key,
        lastInstalledAt: now,
        mirroredFrom: "central-preset"
      }
    };
    args.state.groups = [
      ...args.state.groups.filter((group) => !(group.side === "workspace" && (group.meta?.repoKey === key || group.meta?.repoKey === legacyKey))),
      nextGroup
    ];
    await args.saveSelectionGroups(args.state.workspacePath, args.state.centralRepoPath, args.state.groups);
  };

  return {
    buildAddMoveWizardPayload,
    runNewSkillWizard,
    runAssetTransferWizard,
    setPersonalSkillHome,
    runEnvironmentDiagnosis,
    runResetPersonalSkillHome,
    upsertHydratedWorkspaceGroup
  };
}
