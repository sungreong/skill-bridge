import { constants as fsConstants, promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import type { ToolType } from "./types";
import { skillBridgeStateDir } from "./storagePaths";

export type EnvironmentCheckStatus = "ok" | "warn" | "fail";

export type EnvironmentCheck = {
  label: string;
  status: EnvironmentCheckStatus;
  detail: string;
};

export type EnvironmentDiagnosis = {
  osLabel: string;
  workspacePath: string;
  centralRepoPath: string;
  defaultCentralPath: string;
  configScope: string;
  checks: EnvironmentCheck[];
};

type TranslatePair = (english: string, korean: string) => string;

type RefreshResult = {
  centralRepoPath: string;
  centralFileCount: number;
  centralGroupCount: number;
  workspaceGroupCount: number;
  groupNormalization: {
    changed: boolean;
    removedGroupCount: number;
    removedTargetCount: number;
  };
};

export async function ensurePersonalSkillHome(args: {
  basePath: string;
  allAgents: readonly ToolType[];
  getWritableSkillRoot: (basePath: string, tool: ToolType, mode: "central") => string;
}): Promise<void> {
  await fs.mkdir(skillBridgeStateDir(args.basePath), { recursive: true });
  await Promise.all(args.allAgents.map(async (tool) => {
    await fs.mkdir(path.join(args.getWritableSkillRoot(args.basePath, tool, "central"), "skills"), { recursive: true });
  }));
}

export async function diagnoseEnvironment(args: {
  tr: TranslatePair;
  output: vscode.OutputChannel;
  toUserError: (error: unknown) => string;
  collectEnvironmentDiagnosisArgs: Omit<Parameters<typeof collectEnvironmentDiagnosis>[0], "tr" | "toUserError">;
  repairUserCentralHomeArgs: Omit<Parameters<typeof repairUserCentralHome>[0], "diagnosis" | "tr">;
}): Promise<void> {
  try {
    const diagnosis = await collectEnvironmentDiagnosis({
      ...args.collectEnvironmentDiagnosisArgs,
      tr: args.tr,
      toUserError: args.toUserError
    });
    writeEnvironmentDiagnosis(args.output, diagnosis, args.tr);
    args.output.show(true);

    const failed = diagnosis.checks.filter((check) => check.status === "fail");
    const warned = diagnosis.checks.filter((check) => check.status === "warn");
    if (failed.length > 0) {
      const picked = await vscode.window.showWarningMessage(
        args.tr(
          `Skill Bridge setup check: ${failed.length} failed, ${warned.length} warning. You can repair it with a user-home Central library.`,
          `Skill Bridge 환경 진단: 실패 ${failed.length}개, 주의 ${warned.length}개. 사용자 홈 Central로 복구할 수 있습니다.`
        ),
        args.tr("Repair User-Home Central", "사용자 홈 Central로 복구"),
        args.tr("Show Results", "결과 보기")
      );
      if (picked === args.tr("Repair User-Home Central", "사용자 홈 Central로 복구")) {
        await repairUserCentralHome({
          ...args.repairUserCentralHomeArgs,
          diagnosis,
          tr: args.tr
        });
      }
      return;
    }

    const message = warned.length > 0
      ? args.tr(
        `Skill Bridge setup check completed: ${warned.length} warning. Results were written to the Output panel.`,
        `Skill Bridge 환경 진단 완료: 주의 ${warned.length}개. 결과를 Output 패널에 기록했습니다.`
      )
      : args.tr(
        "Skill Bridge setup check completed: the current Central environment is usable.",
        "Skill Bridge 환경 진단 완료: 현재 Central 환경을 사용할 수 있습니다."
      );
    const picked = shouldOfferUserHomeRepair(diagnosis)
      ? await vscode.window.showInformationMessage(
        message,
        args.tr("Repair User-Home Central", "사용자 홈 Central 재정비"),
        args.tr("Show Results", "결과 보기")
      )
      : await vscode.window.showInformationMessage(message, args.tr("Show Results", "결과 보기"));
    if (picked === args.tr("Repair User-Home Central", "사용자 홈 Central 재정비")) {
      await repairUserCentralHome({
        ...args.repairUserCentralHomeArgs,
        diagnosis,
        tr: args.tr
      });
    }
  } catch (error) {
    vscode.window.showErrorMessage(args.toUserError(error));
  }
}

export async function collectEnvironmentDiagnosis(args: {
  tr: TranslatePair;
  toUserError: (error: unknown) => string;
  exists: (target: string) => Promise<boolean>;
  allAgents: readonly ToolType[];
  workspacePath: string;
  centralRepoPath: string;
  defaultCentralPath: string;
  getWritableSkillRoot: (basePath: string, tool: ToolType, mode: "central") => string;
  settingsSection: string;
}): Promise<EnvironmentDiagnosis> {
  const checks: EnvironmentCheck[] = [];
  const osLabel = `${platformLabel()} ${process.arch}`;

  checks.push({
    label: args.tr("OS / user home", "OS / 사용자 홈"),
    status: os.homedir() ? "ok" : "fail",
    detail: os.homedir() ? `${osLabel} · home=${os.homedir()}` : `${osLabel} · ${args.tr("user home is unavailable.", "사용자 홈을 확인할 수 없습니다.")}`
  });
  checks.push(await checkPathAccess(args.tr, args.exists, "Workspace", args.workspacePath, { mustExist: true, writable: false }));
  checks.push({
    label: args.tr("Central setting", "Central 설정"),
    status: isPathUnderHome(args.centralRepoPath) ? "ok" : "warn",
    detail: `${args.centralRepoPath} · scope=${getCentralConfigScope(args.settingsSection)}${isPathUnderHome(args.centralRepoPath) ? "" : ` · ${args.tr("outside user home; OS permissions or removable drive state may affect access.", "사용자 홈 밖 경로라 OS 권한/이동식 드라이브 영향이 있을 수 있습니다.")}`}`
  });
  checks.push(await checkPathAccess(args.tr, args.exists, "Central", args.centralRepoPath, { mustExist: false, writable: true }));
  checks.push(await checkCentralLayout(args.tr, args.exists, args.centralRepoPath, args.allAgents, args.getWritableSkillRoot));
  checks.push(await checkGitCommand(args.tr, args.toUserError));
  checks.push(await checkNpxCommand(args.tr, args.toUserError));

  return {
    osLabel,
    workspacePath: args.workspacePath,
    centralRepoPath: args.centralRepoPath,
    defaultCentralPath: args.defaultCentralPath,
    configScope: getCentralConfigScope(args.settingsSection),
    checks
  };
}

export async function resetPersonalSkillHome(args: {
  tr: TranslatePair;
  output: vscode.OutputChannel;
  toUserError: (error: unknown) => string;
  stateWorkspacePath: string;
  stateCentralRepoPath: string;
  getActiveWorkspacePath: () => string;
  resolveContext: () => { centralRepoPath: string } | undefined;
  getDefaultCentralRepoPath: (workspacePath: string) => string;
  defaultCentralRepoPathSetting: string;
  settingsSection: string;
  clearCentralRepoPathOverrides: () => Promise<void>;
  allAgents: readonly ToolType[];
  getWritableSkillRoot: (basePath: string, tool: ToolType, mode: "central") => string;
  refresh: () => Promise<RefreshResult>;
  compactPathForDisplay: (value: string) => string;
}): Promise<void> {
  try {
    const workspacePath = args.stateWorkspacePath || args.getActiveWorkspacePath();
    const defaultPath = args.getDefaultCentralRepoPath(workspacePath);
    const beforePath = args.stateCentralRepoPath || args.resolveContext()?.centralRepoPath || defaultPath;
    await vscode.workspace
      .getConfiguration(args.settingsSection)
      .update("centralRepoPath", args.defaultCentralRepoPathSetting, vscode.ConfigurationTarget.Global);
    await args.clearCentralRepoPathOverrides();
    await ensurePersonalSkillHome({
      basePath: defaultPath,
      allAgents: args.allAgents,
      getWritableSkillRoot: args.getWritableSkillRoot
    });
    const result = await args.refresh();
    const moved = path.normalize(beforePath) !== path.normalize(result.centralRepoPath);
    const normalization = result.groupNormalization.changed
      ? args.tr(` · groups normalized: removed ${result.groupNormalization.removedGroupCount}, removed targets ${result.groupNormalization.removedTargetCount}`, ` · 그룹 정리: 제거 ${result.groupNormalization.removedGroupCount}개, 대상 제거 ${result.groupNormalization.removedTargetCount}개`)
      : args.tr(" · no group changes", " · 그룹 변경 없음");
    const message = moved
      ? args.tr(
        `Central library folder reset: ${args.compactPathForDisplay(beforePath)} → ${args.compactPathForDisplay(result.centralRepoPath)}`,
        `중앙 라이브러리 폴더를 기본 위치로 재설정했습니다: ${args.compactPathForDisplay(beforePath)} → ${args.compactPathForDisplay(result.centralRepoPath)}`
      )
      : args.tr(
        `Central library folder is already using the default location: ${args.compactPathForDisplay(result.centralRepoPath)}`,
        `중앙 라이브러리 폴더가 이미 기본 위치를 사용 중입니다: ${args.compactPathForDisplay(result.centralRepoPath)}`
      );
    args.output.appendLine(`[PersonalHomeReset] before=${beforePath}`);
    args.output.appendLine(`[PersonalHomeReset] after=${result.centralRepoPath}`);
    args.output.appendLine(`[PersonalHomeReset] centralFiles=${result.centralFileCount}, centralGroups=${result.centralGroupCount}, workspaceGroups=${result.workspaceGroupCount}, normalized=${JSON.stringify(result.groupNormalization)}`);
    vscode.window.showInformationMessage(args.tr(
      `${message} · Central files ${result.centralFileCount} · Central groups ${result.centralGroupCount}${normalization}`,
      `${message} · 중앙 파일 ${result.centralFileCount}개 · 중앙 그룹 ${result.centralGroupCount}개${normalization}`
    ));
  } catch (error) {
    vscode.window.showErrorMessage(args.toUserError(error));
  }
}

async function repairUserCentralHome(args: {
  diagnosis: EnvironmentDiagnosis;
  tr: TranslatePair;
  settingsSection: string;
  defaultCentralRepoPathSetting: string;
  clearCentralRepoPathOverrides: () => Promise<void>;
  allAgents: readonly ToolType[];
  getWritableSkillRoot: (basePath: string, tool: ToolType, mode: "central") => string;
  refresh: () => Promise<RefreshResult>;
  output: vscode.OutputChannel;
  compactPathForDisplay: (value: string) => string;
}): Promise<void> {
  const defaultCentralExists = await pathExists(args.diagnosis.defaultCentralPath);
  const alreadyUsingDefault = isSamePath(args.diagnosis.centralRepoPath, args.diagnosis.defaultCentralPath);
  const confirmMessage = alreadyUsingDefault
    ? args.tr(
      `Ensure the current user-home Central library folders and set this path globally?\n\n${args.diagnosis.defaultCentralPath}`,
      `현재 사용자 홈 Central 폴더 구조를 확인하고 이 경로를 전역 설정으로 지정할까요?\n\n${args.diagnosis.defaultCentralPath}`
    )
    : defaultCentralExists
      ? args.tr(
        `Use the existing user-home Central library and set it globally?\n\n${args.diagnosis.defaultCentralPath}`,
        `이미 있는 사용자 홈 Central을 사용하고 전역 설정으로 지정할까요?\n\n${args.diagnosis.defaultCentralPath}`
      )
      : args.tr(
        `Create a user-home Central library and set it globally?\n\n${args.diagnosis.defaultCentralPath}`,
        `사용자 홈 Central을 만들고 전역 설정으로 지정할까요?\n\n${args.diagnosis.defaultCentralPath}`
      );
  const ok = await vscode.window.showWarningMessage(
    confirmMessage,
    { modal: true },
    args.tr("Repair", "복구")
  );
  if (ok !== args.tr("Repair", "복구")) return;
  await ensurePersonalSkillHome({
    basePath: args.diagnosis.defaultCentralPath,
    allAgents: args.allAgents,
    getWritableSkillRoot: args.getWritableSkillRoot
  });
  await vscode.workspace
    .getConfiguration(args.settingsSection)
    .update("centralRepoPath", args.defaultCentralRepoPathSetting, vscode.ConfigurationTarget.Global);
  await args.clearCentralRepoPathOverrides();
  const result = await args.refresh();
  args.output.appendLine(`[EnvironmentRepair] central=${result.centralRepoPath}`);
  vscode.window.showInformationMessage(args.tr(
    `User-home Central repaired: ${args.compactPathForDisplay(result.centralRepoPath)}`,
    `사용자 홈 Central 복구 완료: ${args.compactPathForDisplay(result.centralRepoPath)}`
  ));
}

function shouldOfferUserHomeRepair(diagnosis: EnvironmentDiagnosis): boolean {
  if (!isSamePath(diagnosis.centralRepoPath, diagnosis.defaultCentralPath)) return true;
  return diagnosis.checks.some((check) =>
    check.status === "fail"
    || (check.status === "warn" && (check.label === "Central" || check.label.includes("Central layout") || check.label.includes("Central 레이아웃")))
  );
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function writeEnvironmentDiagnosis(output: vscode.OutputChannel, diagnosis: EnvironmentDiagnosis, tr: TranslatePair): void {
  output.appendLine("");
  output.appendLine(`[EnvironmentDiagnosis] ${new Date().toISOString()}`);
  output.appendLine(`OS: ${diagnosis.osLabel}`);
  output.appendLine(`Workspace: ${diagnosis.workspacePath}`);
  output.appendLine(`Central: ${diagnosis.centralRepoPath}`);
  output.appendLine(`Default user Central: ${diagnosis.defaultCentralPath}`);
  output.appendLine(`Config scope: ${diagnosis.configScope}`);
  for (const check of diagnosis.checks) {
    output.appendLine(`- [${check.status.toUpperCase()}] ${check.label}: ${check.detail}`);
  }
  output.appendLine(tr("OS action guide:", "OS별 조치 가이드:"));
  for (const line of platformAdvice(tr)) {
    output.appendLine(`- ${line}`);
  }
}

async function checkPathAccess(
  tr: TranslatePair,
  exists: (target: string) => Promise<boolean>,
  label: string,
  targetPath: string,
  options: { mustExist: boolean; writable: boolean }
): Promise<EnvironmentCheck> {
  const existsTarget = await exists(targetPath);
  if (!existsTarget) {
    const parent = await findExistingParent(exists, targetPath);
    const parentWritable = parent ? await canWriteToDirectory(parent) : false;
    return {
      label,
      status: options.mustExist || !parentWritable ? "fail" : "warn",
      detail: parent
        ? `${targetPath} ${tr("missing", "없음")} · parent=${parent} · parentWritable=${parentWritable ? "yes" : "no"}`
        : `${targetPath} ${tr("missing; no accessible parent folder was found.", "없음 · 접근 가능한 상위 폴더를 찾지 못했습니다.")}`
    };
  }

  const readable = await canAccess(targetPath, fsConstants.R_OK);
  const writable = options.writable ? await canWriteToDirectory(targetPath) : true;
  return {
    label,
    status: readable && writable ? "ok" : "fail",
    detail: `${targetPath} · readable=${readable ? "yes" : "no"}${options.writable ? ` · writable=${writable ? "yes" : "no"}` : ""}`
  };
}

async function checkCentralLayout(
  tr: TranslatePair,
  exists: (target: string) => Promise<boolean>,
  centralRepoPath: string,
  allAgents: readonly ToolType[],
  getWritableSkillRoot: (basePath: string, tool: ToolType, mode: "central") => string
): Promise<EnvironmentCheck> {
  if (!(await exists(centralRepoPath))) {
    return { label: tr("Central layout", "Central 레이아웃"), status: "warn", detail: tr("After creating Central, Skill Bridge can create per-agent skills folders.", "Central 폴더 생성 후 에이전트별 skills 폴더를 만들 수 있습니다.") };
  }
  const missing: string[] = [];
  for (const tool of allAgents) {
    const root = path.join(getWritableSkillRoot(centralRepoPath, tool, "central"), "skills");
    if (!(await exists(root))) missing.push(`${tool}/skills`);
  }
  return {
    label: tr("Central layout", "Central 레이아웃"),
    status: missing.length === 0 ? "ok" : "warn",
    detail: missing.length === 0 ? tr("Per-agent skills folders are ready.", "에이전트별 skills 폴더가 준비되어 있습니다.") : `${tr("Missing", "누락")}: ${missing.join(", ")}`
  };
}

async function checkGitCommand(tr: TranslatePair, toUserError: (error: unknown) => string): Promise<EnvironmentCheck> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync("git", ["--version"], { windowsHide: process.platform === "win32" });
    return { label: "Git", status: "ok", detail: String(stdout).trim() || tr("git is available", "git 사용 가능") };
  } catch (error) {
    return { label: "Git", status: "warn", detail: `${tr("git command is unavailable. Check Git installation/PATH before using sync features.", "git 명령을 실행할 수 없습니다. 동기화 기능 전에 설치/PATH 확인이 필요합니다.")} ${toUserError(error)}` };
  }
}

async function checkNpxCommand(tr: TranslatePair, toUserError: (error: unknown) => string): Promise<EnvironmentCheck> {
  try {
    const version = await runNpxVersionForDiagnostic();
    return { label: "npx", status: "ok", detail: version ? `npx ${version}` : tr("npx is available", "npx 사용 가능") };
  } catch (error) {
    return { label: "npx", status: "warn", detail: `${tr("npx command is unavailable. Check Node.js/npm PATH before using install features.", "npx 명령을 실행할 수 없습니다. 스킬 설치 기능 전에 Node.js/npm PATH 확인이 필요합니다.")} ${toUserError(error)}` };
  }
}

async function runNpxVersionForDiagnostic(): Promise<string> {
  return await new Promise((resolve, reject) => {
    const command = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "npx";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", "npx", "--version"] : ["--version"];
    const child = spawn(command, args, {
      windowsHide: process.platform === "win32",
      shell: false,
      timeout: 30000
    });
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
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(stderr.trim() || stdout.trim() || `npx exited with code ${code ?? 1}`));
    });
  });
}

async function findExistingParent(exists: (target: string) => Promise<boolean>, targetPath: string): Promise<string | null> {
  let cursor = path.resolve(targetPath);
  while (true) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    if (await exists(parent)) return parent;
    cursor = parent;
  }
}

async function canAccess(targetPath: string, mode: number): Promise<boolean> {
  try {
    await fs.access(targetPath, mode);
    return true;
  } catch {
    return false;
  }
}

async function canWriteToDirectory(targetPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(targetPath);
    if (!stat.isDirectory()) return false;
    const probe = path.join(targetPath, `.skillbridge-write-test-${process.pid}-${Date.now()}.tmp`);
    await fs.writeFile(probe, "ok", "utf8");
    await fs.rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

function platformLabel(): string {
  if (process.platform === "win32") return "Windows";
  if (process.platform === "darwin") return "macOS";
  if (process.platform === "linux") return "Linux";
  return process.platform;
}

function getCentralConfigScope(settingsSection: string): string {
  const inspected = vscode.workspace.getConfiguration(settingsSection).inspect<string>("centralRepoPath");
  if (inspected?.workspaceFolderValue !== undefined) return "workspaceFolder";
  if (inspected?.workspaceValue !== undefined) return "workspace";
  if (inspected?.globalValue !== undefined) return "global";
  return "default";
}

function isPathUnderHome(targetPath: string): boolean {
  const home = path.resolve(os.homedir());
  const target = path.resolve(targetPath);
  const normalizedHome = process.platform === "win32" ? home.toLowerCase() : home;
  const normalizedTarget = process.platform === "win32" ? target.toLowerCase() : target;
  const relative = path.relative(normalizedHome, normalizedTarget);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isSamePath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function platformAdvice(tr: TranslatePair): string[] {
  if (process.platform === "win32") {
    return [
      tr("Windows: Prefer Central under %USERPROFILE% instead of Program Files, Windows, or another user's folder.", "Windows: Program Files, Windows, 다른 사용자 폴더보다 %USERPROFILE% 아래 Central을 권장합니다."),
      tr("Windows: Avoid mixing administrator and normal VS Code sessions because file ownership/permissions can become inconsistent.", "Windows: VS Code를 관리자 권한으로 섞어 실행하면 파일 소유/권한이 꼬일 수 있으니 일반 권한으로 통일하세요."),
      tr("Windows: If Git or npx fails, confirm PATH in a new terminal and restart VS Code.", "Windows: Git 또는 npx 실패 시 새 터미널에서 PATH가 잡히는지 확인하고 VS Code를 재시작하세요.")
    ];
  }
  if (process.platform === "darwin") {
    return [
      tr("macOS: Prefer a user-home path such as ~/skill-bridge-repo.", "macOS: ~/skill-bridge-repo 같은 사용자 홈 경로를 권장합니다."),
      tr("macOS: Desktop/Documents/Downloads may require Files and Folders permission for VS Code.", "macOS: Desktop/Documents/Downloads 아래를 쓰면 VS Code에 Files and Folders 권한이 필요할 수 있습니다."),
      tr("macOS: Avoid Central under /System, /Applications, or another user's home.", "macOS: /System, /Applications, 다른 사용자 홈 아래 Central은 피하세요.")
    ];
  }
  if (process.platform === "linux") {
    return [
      tr("Linux: Prefer a user-home path such as ~/skill-bridge-repo.", "Linux: ~/skill-bridge-repo 같은 사용자 홈 경로를 권장합니다."),
      tr("Linux: Folders created by root can fail writes in normal VS Code; make the current user the owner.", "Linux: root로 만든 폴더는 일반 VS Code에서 쓰기 실패할 수 있으니 소유자를 현재 사용자로 맞추세요."),
      tr("Linux: In containers or remote environments, confirm the Central path is visible to the current VS Code server process.", "Linux: 컨테이너/원격 환경에서는 Central 경로가 현재 VS Code 서버 프로세스에서 보이는지 확인하세요.")
    ];
  }
  return [
    tr("Prefer a Central path under the user home.", "사용자 홈 아래 Central 경로를 권장합니다."),
    tr("Git/npx must be available on PATH for the VS Code process.", "Git/npx는 VS Code 프로세스의 PATH에서 실행 가능해야 합니다.")
  ];
}
