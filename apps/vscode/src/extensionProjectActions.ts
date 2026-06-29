import { promises as fs } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import type { GroupTarget, SelectionGroup, SkillAssetTreeMeta, SkillFile, SkillTreeFilterMode, ToolType } from "./types";
import type { UiLanguage } from "./uiLanguage";
import type { WizardAssetPick } from "./extensionAddMoveWizard";
import type { diagnoseEnvironment, resetPersonalSkillHome } from "./extensionEnvironment";
import type { ExtensionRefreshResult } from "./extensionRefreshRuntime";

type TreeSide = "workspace" | "central";
type ProjectContext = {
  workspacePath: string;
  centralRepoPath: string;
};

export function createExtensionProjectActions(args: {
  tr: (english: string, korean: string) => string;
  toUserError: (error: unknown) => string;
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
  resolveContext: () => ProjectContext | undefined;
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

  const resolveProjectContext = async (): Promise<ProjectContext> => {
    const stateWorkspacePath = args.state.workspacePath.trim();
    let workspacePath = stateWorkspacePath || args.getActiveWorkspacePath();
    let centralRepoPath = args.state.centralRepoPath.trim();

    if (!workspacePath || !centralRepoPath) {
      const resolved = args.resolveContext();
      workspacePath = workspacePath || resolved?.workspacePath || "";
      centralRepoPath = centralRepoPath || resolved?.centralRepoPath || "";
    }

    if (!workspacePath) {
      throw new Error(args.tr("Open a workspace folder first.", "먼저 작업공간 폴더를 여세요."));
    }

    const configuredCentralRepoPath = getConfiguredCentralRepoPath();
    if (!configuredCentralRepoPath) {
      centralRepoPath = args.getDefaultCentralRepoPath(workspacePath);
      await args.ensurePersonalSkillHome({
        basePath: centralRepoPath,
        allAgents: args.allAgents,
        getWritableSkillRoot: args.getWritableSkillRootForEnv
      });
      await vscode.workspace
        .getConfiguration(args.settingsSection)
        .update("centralRepoPath", args.defaultCentralRepoPathSetting, vscode.ConfigurationTarget.Global);
      await args.clearCentralRepoPathOverrides();
      args.output.appendLine(`[EnvironmentContext] centralRepoPath missing; set default=${centralRepoPath}`);
    }

    if (!centralRepoPath) {
      throw new Error(args.tr("Central library path is not configured.", "Central 라이브러리 경로가 설정되지 않았습니다."));
    }

    args.state.workspacePath = workspacePath;
    args.state.centralRepoPath = centralRepoPath;
    return { workspacePath, centralRepoPath };
  };

  const runNewSkillWizard = async (): Promise<void> => {
    const side = await args.pickWizardSide(args.tr("Choose where to create the new skill", "새 스킬을 만들 위치"));
    if (!side) return;
    const tool = await args.pickTool();
    if (!tool) return;
    const name = await vscode.window.showInputBox({
      title: args.tr("New Skill Name", "새 스킬 이름"),
      prompt: args.tr("Creates skills/<name>/SKILL.md.", "skills/<name>/SKILL.md 형태로 생성됩니다."),
      validateInput: (value) => {
        const normalized = value.trim();
        if (!normalized) return args.tr("Enter a skill name.", "스킬 이름을 입력하세요.");
        if (normalized.includes("/") || normalized.includes("\\") || normalized.includes("..")) {
          return args.tr("Skill names cannot include path separators or '..'.", "스킬 이름에는 경로 구분자나 '..'을 사용할 수 없습니다.");
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
      vscode.window.showWarningMessage(args.tr(`A skill already exists: ${tool}/${folderRel}`, `이미 같은 스킬이 있습니다: ${tool}/${folderRel}`));
      return;
    }
    await fs.mkdir(folderAbs, { recursive: true });
    await fs.writeFile(path.join(folderAbs, "SKILL.md"), args.buildSkillMdTemplate(name.trim()), "utf8");
    vscode.window.showInformationMessage(args.tr(`New skill created: ${side} ${tool}/${folderRel}`, `새 스킬 생성 완료: ${side} ${tool}/${folderRel}`));
  };

  const runAssetTransferWizard = async (sourceSide: TreeSide): Promise<void> => {
    const asset = await args.pickWizardAsset(sourceSide, sourceSide === "workspace" ? args.tr("Choose a skill to send to Central", "중앙으로 올릴 스킬") : args.tr("Choose a skill to bring to Workspace", "작업공간으로 가져올 스킬"));
    if (!asset) return;
    if (asset.status === "missingSkillMd") {
      vscode.window.showWarningMessage(args.tr("Skills without SKILL.md cannot be transferred.", "SKILL.md가 없는 스킬은 전송할 수 없습니다."));
      return;
    }
    const sourceFiles = sourceSide === "workspace" ? args.state.workspaceSkills : args.state.centralSkills;
    const selections = args.uniqueSelections(
      sourceFiles
        .filter((file) => file.tool === asset.tool && file.relativePath.startsWith(`${asset.rootRelativePath}/`))
        .map((file) => ({ tool: file.tool, relativePath: file.relativePath }))
    );
    if (selections.length === 0) {
      vscode.window.showWarningMessage(args.tr("No files were found to transfer.", "전송할 파일을 찾지 못했습니다."));
      return;
    }
    const result = await args.transferSelections(sourceSide, selections, {
      scopeHints: [{ tool: asset.tool, relativePath: asset.rootRelativePath, kind: "folder" }]
    });
    const mirroredGroups = await args.mirrorGroupsByIds(sourceSide, result.affectedGroupIds);
    await args.refresh();
    vscode.window.showInformationMessage(
      args.tr(
        `Skill transfer result: copied ${result.copied} · deleted ${result.deleted} · unchanged ${result.unchanged}${mirroredGroups > 0 ? ` · synced groups ${mirroredGroups}` : ""}`,
        `스킬 전송 결과: 복사 행 ${result.copied}개 / 삭제 행 ${result.deleted}개 / 변경없음 행 ${result.unchanged}개${mirroredGroups > 0 ? ` · 그룹 동기화 ${mirroredGroups}개` : ""}`
      )
    );
  };

  const setPersonalSkillHome = async (): Promise<void> => {
    try {
      const current = (await resolveProjectContext()).centralRepoPath;
      const picked = await vscode.window.showOpenDialog({
        title: args.tr("Choose Central Library Folder", "Central 라이브러리 폴더 선택"),
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        defaultUri: vscode.Uri.file(current)
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
      vscode.window.showInformationMessage(args.tr(`Central library folder set: ${folder}`, `Central 라이브러리 폴더 설정 완료: ${folder}`));
    } catch (error) {
      vscode.window.showErrorMessage(args.toUserError(error));
    }
  };

  const runEnvironmentDiagnosis = async (): Promise<void> => {
    const projectContext = await resolveProjectContext();
    await args.diagnoseEnvironment({
      tr: args.tr,
      output: args.output,
      toUserError: args.toUserError,
      collectEnvironmentDiagnosisArgs: {
        exists: args.exists,
        allAgents: args.allAgents,
        workspacePath: projectContext.workspacePath,
        centralRepoPath: projectContext.centralRepoPath,
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
    const projectContext = await resolveProjectContext();
    await args.resetPersonalSkillHome({
      tr: args.tr,
      output: args.output,
      toUserError: args.toUserError,
      stateWorkspacePath: projectContext.workspacePath,
      stateCentralRepoPath: projectContext.centralRepoPath,
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
