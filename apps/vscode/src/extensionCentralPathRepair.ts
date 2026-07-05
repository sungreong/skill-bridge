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

type RepairTarget = {
  path: string;
  settingValue: string;
  logLabel: string;
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
  openCentralPathRepairPicker: () => Promise<void>;
} {
  const getConfiguredCentralRepoPath = (): string | undefined => {
    const inspected = vscode.workspace.getConfiguration(args.settingsSection).inspect<string>("centralRepoPath");
    const configured = inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
    return typeof configured === "string" && configured.trim() ? configured.trim() : undefined;
  };

  const repairCentralPathForCurrentSession = async (target: RepairTarget): Promise<void> => {
    await args.ensurePersonalSkillHome({
      basePath: target.path,
      allAgents: args.allAgents,
      getWritableSkillRoot: args.getWritableSkillRoot
    });
    await vscode.workspace
      .getConfiguration(args.settingsSection)
      .update("centralRepoPath", target.settingValue, vscode.ConfigurationTarget.Global);
    await args.clearCentralRepoPathOverrides();
    const result = await args.refresh();
    args.output.appendLine(`[CentralPathRepair:${target.logLabel}] central=${result.centralRepoPath}`);
    vscode.window.showInformationMessage(args.tr(
      `Central library path updated for this session: ${args.compactPathForDisplay(result.centralRepoPath)}`,
      `현재 세션에 맞게 Central 라이브러리 경로를 변경했습니다: ${args.compactPathForDisplay(result.centralRepoPath)}`
    ));
  };

  const chooseCentralPathForCurrentSession = async (fallbackPath: string): Promise<void> => {
    const picked = await vscode.window.showOpenDialog({
      title: args.tr("Choose Central Library Folder", "Central 라이브러리 폴더 선택"),
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: vscode.Uri.file(fallbackPath)
    });
    const folder = picked?.[0]?.fsPath;
    if (!folder) return;
    await repairCentralPathForCurrentSession({
      path: folder,
      settingValue: folder,
      logLabel: "choose"
    });
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
    const chooseFolderLabel = args.tr("Choose Folder", "폴더 선택");
    const checkSetupLabel = args.tr("Check Setup", "환경 진단");
    const picked = await vscode.window.showWarningMessage(
      `${formatCentralPathIssue(centralResolution)} ${args.tr(
        "Choose a Central folder that is reachable from the current VS Code session.",
        "현재 VS Code 세션에서 접근 가능한 Central 폴더를 선택하거나 권장 경로로 바꿀 수 있습니다."
      )}`,
      useFallbackLabel,
      chooseFolderLabel,
      checkSetupLabel
    );
    if (picked === useFallbackLabel) {
      try {
        await repairCentralPathForCurrentSession({
          path: centralResolution.fallbackPath,
          settingValue: DEFAULT_CENTRAL_REPO_PATH_SETTING,
          logLabel: "suggested"
        });
      } catch (repairError) {
        args.output.appendLine(`[Activation:centralPathRepair] ${args.toUserError(repairError)}`);
        vscode.window.showErrorMessage(args.toUserError(repairError));
      }
      return true;
    }
    if (picked === chooseFolderLabel) {
      try {
        await chooseCentralPathForCurrentSession(centralResolution.fallbackPath);
      } catch (repairError) {
        args.output.appendLine(`[CentralPathRepair:choose] ${args.toUserError(repairError)}`);
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

  const openCentralPathRepairPicker = async (): Promise<void> => {
    const workspacePath = args.state.workspacePath || args.getActiveWorkspacePath();
    if (!workspacePath) {
      vscode.window.showWarningMessage(args.tr(
        "Open a workspace folder before choosing the Central library path.",
        "Central 라이브러리 경로를 선택하기 전에 작업공간 폴더를 먼저 여세요."
      ));
      return;
    }
    const configuredCentralRepoPath = getConfiguredCentralRepoPath();
    const centralResolution = configuredCentralRepoPath
      ? resolveCentralRepoPath(configuredCentralRepoPath, workspacePath, "configured")
      : resolveCentralRepoPath(DEFAULT_CENTRAL_REPO_PATH_SETTING, workspacePath, "default");
    const defaultResolution = resolveCentralRepoPath(DEFAULT_CENTRAL_REPO_PATH_SETTING, workspacePath, "default");
    const suggestedPath = centralResolution.ok
      ? (defaultResolution.ok ? defaultResolution.absolutePath : centralResolution.absolutePath)
      : centralResolution.fallbackPath;
    const useFallbackLabel = args.tr("Use Suggested Path", "권장 경로 사용");
    const chooseFolderLabel = args.tr("Choose Folder", "폴더 선택");
    const checkSetupLabel = args.tr("Check Setup", "환경 진단");
    const currentPath = centralResolution.ok ? centralResolution.absolutePath : centralResolution.rawValue;
    const picked = await vscode.window.showInformationMessage(
      args.tr(
        `Central library path: ${currentPath}. Suggested for this session: ${suggestedPath}`,
        `Central 라이브러리 경로: ${currentPath}. 현재 세션 권장 경로: ${suggestedPath}`
      ),
      useFallbackLabel,
      chooseFolderLabel,
      checkSetupLabel
    );
    if (picked === useFallbackLabel) {
      await repairCentralPathForCurrentSession({
        path: suggestedPath,
        settingValue: DEFAULT_CENTRAL_REPO_PATH_SETTING,
        logLabel: "command-suggested"
      });
    } else if (picked === chooseFolderLabel) {
      await chooseCentralPathForCurrentSession(suggestedPath);
    } else if (picked === checkSetupLabel) {
      await args.runEnvironmentDiagnosis();
    }
  };

  return { offerCentralPathRepair, openCentralPathRepairPicker };
}
