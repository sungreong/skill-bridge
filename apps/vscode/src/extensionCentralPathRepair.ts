import * as vscode from "vscode";
import {
  DEFAULT_CENTRAL_REPO_PATH_SETTING,
  formatCentralPathIssue,
  resolveCentralRepoPath
} from "./centralPath";
import type { ToolType } from "./types";

type TranslatePair = (english: string, korean: string) => string;

type RefreshResult = {
  centralRepoPath: string;
};

export function createCentralPathRepairTools(args: {
  tr: TranslatePair;
  output: vscode.OutputChannel;
  toUserError: (error: unknown) => string;
  state: {
    workspacePath: string;
  };
  settingsSection: string;
  getActiveWorkspacePath: () => string;
  ensurePersonalSkillHome: (input: {
    basePath: string;
    allAgents: readonly ToolType[];
    getWritableSkillRoot: (basePath: string, tool: ToolType, mode: "central") => string;
  }) => Promise<void>;
  allAgents: readonly ToolType[];
  getWritableSkillRoot: (basePath: string, tool: ToolType, mode: "central") => string;
  clearCentralRepoPathOverrides: () => Promise<void>;
  refresh: () => Promise<RefreshResult>;
  compactPathForDisplay: (value: string) => string;
  runEnvironmentDiagnosis: () => Promise<void>;
}): {
  offerCentralPathRepair: (error: unknown) => Promise<boolean>;
} {
  const getConfiguredCentralRepoPath = (): string | undefined => {
    const inspected = vscode.workspace.getConfiguration(args.settingsSection).inspect<string>("centralRepoPath");
    const configured = inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
    return typeof configured === "string" && configured.trim() ? configured.trim() : undefined;
  };

  const repairCentralPathForCurrentSession = async (fallbackPath: string): Promise<void> => {
    await args.ensurePersonalSkillHome({
      basePath: fallbackPath,
      allAgents: args.allAgents,
      getWritableSkillRoot: args.getWritableSkillRoot
    });
    await vscode.workspace
      .getConfiguration(args.settingsSection)
      .update("centralRepoPath", DEFAULT_CENTRAL_REPO_PATH_SETTING, vscode.ConfigurationTarget.Global);
    await args.clearCentralRepoPathOverrides();
    const result = await args.refresh();
    args.output.appendLine(`[Activation:centralPathRepair] central=${result.centralRepoPath}`);
    vscode.window.showInformationMessage(args.tr(
      `Central library path updated for this session: ${args.compactPathForDisplay(result.centralRepoPath)}`,
      `현재 세션에 맞게 Central 라이브러리 경로를 변경했습니다: ${args.compactPathForDisplay(result.centralRepoPath)}`
    ));
  };

  const offerCentralPathRepair = async (error: unknown): Promise<boolean> => {
    const workspacePath = args.state.workspacePath || args.getActiveWorkspacePath();
    if (!workspacePath) return false;
    const configuredCentralRepoPath = getConfiguredCentralRepoPath();
    const centralResolution = configuredCentralRepoPath
      ? resolveCentralRepoPath(configuredCentralRepoPath, workspacePath, "configured")
      : resolveCentralRepoPath(DEFAULT_CENTRAL_REPO_PATH_SETTING, workspacePath, "default");
    if (centralResolution.ok) return false;

    const useFallbackLabel = args.tr("Use Suggested Path", "권장 경로 사용");
    const checkSetupLabel = args.tr("Check Setup", "환경 진단");
    const picked = await vscode.window.showWarningMessage(
      `${formatCentralPathIssue(centralResolution)} ${args.tr(
        "You can switch Skill Bridge to the current session's user-home Central library now.",
        "지금 Skill Bridge를 현재 세션의 사용자 홈 Central 라이브러리로 바꿀 수 있습니다."
      )}`,
      useFallbackLabel,
      checkSetupLabel
    );
    if (picked === useFallbackLabel) {
      try {
        await repairCentralPathForCurrentSession(centralResolution.fallbackPath);
      } catch (repairError) {
        args.output.appendLine(`[Activation:centralPathRepair] ${args.toUserError(repairError)}`);
        vscode.window.showErrorMessage(args.toUserError(repairError));
      }
      return true;
    }
    if (picked === checkSetupLabel) {
      try {
        await args.runEnvironmentDiagnosis();
      } catch (diagnosisError) {
        args.output.appendLine(`[Activation:diagnose] ${args.toUserError(diagnosisError)}`);
        vscode.window.showErrorMessage(args.toUserError(diagnosisError));
      }
      return true;
    }
    args.output.appendLine(`[Activation:centralPathIssue] ${args.toUserError(error)}`);
    return true;
  };

  return { offerCentralPathRepair };
}
