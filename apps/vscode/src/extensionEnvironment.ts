import { constants as fsConstants, promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import {
  formatCentralPathIssue,
  resolveHostPath,
  type CentralPathIssueCode,
  type ResolvedCentralRepoPath
} from "./centralPath";
import type { ToolType } from "./types";
import { skillBridgeStateDir } from "./storagePaths";
import { localize } from "./uiLanguage";

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
  configuredCentralRepoPath: string | null;
  configuredCentralIssue: CentralPathIssueCode | null;
  checks: EnvironmentCheck[];
};

type TranslatePair = (message: string, ...args: Array<string | number | boolean>) => string;

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
        args.tr("Skill Bridge setup check: {0} failed, {1} warning. You can repair it with a user-home Central library.", String(failed.length), String(warned.length)),
        args.tr("Repair User-Home Central"),
        args.tr("Show Results")
      );
      if (picked === args.tr("Repair User-Home Central")) {
        await repairUserCentralHome({
          ...args.repairUserCentralHomeArgs,
          diagnosis,
          tr: args.tr
        });
      }
      return;
    }

    const message = warned.length > 0
      ? args.tr("Skill Bridge setup check completed: {0} warning. Results were written to the Output panel.", String(warned.length))
      : args.tr("Skill Bridge setup check completed: the current Central environment is usable.");
    const picked = shouldOfferUserHomeRepair(diagnosis)
      ? await vscode.window.showInformationMessage(
        message,
        args.tr("Repair User-Home Central"),
        args.tr("Show Results")
      )
      : await vscode.window.showInformationMessage(message, args.tr("Show Results"));
    if (picked === args.tr("Repair User-Home Central")) {
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
  configuredCentralRepoPath: string | null;
  configuredCentralResolution: ResolvedCentralRepoPath | null;
  defaultCentralPath: string;
  getWritableSkillRoot: (basePath: string, tool: ToolType, mode: "central") => string;
  settingsSection: string;
}): Promise<EnvironmentDiagnosis> {
  const checks: EnvironmentCheck[] = [];
  const osLabel = `${platformLabel()} ${process.arch}`;
  const effectiveCentralPath = args.configuredCentralResolution?.ok ? args.configuredCentralResolution.absolutePath : args.centralRepoPath;
  const configuredCentralIssue = args.configuredCentralResolution && !args.configuredCentralResolution.ok
    ? args.configuredCentralResolution.issue
    : null;

  checks.push({
    label: args.tr("OS / user home"),
    status: os.homedir() ? "ok" : "fail",
    detail: os.homedir() ? `${osLabel} · home=${os.homedir()}` : `${osLabel} · ${args.tr("user home is unavailable.")}`
  });
  checks.push(await checkPathAccess(args.tr, args.exists, "Workspace", args.workspacePath, { mustExist: true, writable: false }));
  if (args.configuredCentralResolution && !args.configuredCentralResolution.ok) {
    checks.push({
      label: args.tr("Central setting"),
      status: "fail",
      detail: `${formatCentralPathIssue(args.configuredCentralResolution)} ${args.tr("Central must be reachable from the same host as the current VS Code session.")} · scope=${getCentralConfigScope(args.settingsSection)}`
    });
    checks.push(await checkPathAccess(args.tr, args.exists, args.tr("Fallback Central"), effectiveCentralPath, { mustExist: false, writable: true }));
  } else {
    checks.push({
      label: args.tr("Central setting"),
      status: isPathUnderHome(effectiveCentralPath) ? "ok" : "warn",
      detail: `${effectiveCentralPath} · scope=${getCentralConfigScope(args.settingsSection)}${isPathUnderHome(effectiveCentralPath) ? "" : ` · ${args.tr("outside user home; OS permissions or removable drive state may affect access.")}`}`
    });
    checks.push(await checkPathAccess(args.tr, args.exists, "Central", effectiveCentralPath, { mustExist: false, writable: true }));
  }
  checks.push(await checkCentralLayout(args.tr, args.exists, effectiveCentralPath, args.allAgents, args.getWritableSkillRoot));
  checks.push(await checkGitCommand(args.tr, args.toUserError));
  checks.push(await checkNpxCommand(args.tr, args.toUserError));

  return {
    osLabel,
    workspacePath: args.workspacePath,
    centralRepoPath: effectiveCentralPath,
    defaultCentralPath: args.defaultCentralPath,
    configScope: getCentralConfigScope(args.settingsSection),
    configuredCentralRepoPath: args.configuredCentralRepoPath,
    configuredCentralIssue,
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
    const beforeResolved = resolveHostPath(beforePath);
    const afterResolved = resolveHostPath(result.centralRepoPath);
    const moved = !beforeResolved.ok || !afterResolved.ok || !isSamePath(beforeResolved.absolutePath, afterResolved.absolutePath);
    const normalization = result.groupNormalization.changed
      ? args.tr(" · groups normalized: removed {0}, removed targets {1}", String(result.groupNormalization.removedGroupCount), String(result.groupNormalization.removedTargetCount))
      : args.tr(" · no group changes");
    const message = moved
      ? args.tr("Central library folder reset: {0} → {1}", String(args.compactPathForDisplay(beforePath)), String(args.compactPathForDisplay(result.centralRepoPath)))
      : args.tr("Central library folder is already using the default location: {0}", String(args.compactPathForDisplay(result.centralRepoPath)));
    args.output.appendLine(`[PersonalHomeReset] before=${beforePath}`);
    args.output.appendLine(`[PersonalHomeReset] after=${result.centralRepoPath}`);
    args.output.appendLine(`[PersonalHomeReset] centralFiles=${result.centralFileCount}, centralGroups=${result.centralGroupCount}, workspaceGroups=${result.workspaceGroupCount}, normalized=${JSON.stringify(result.groupNormalization)}`);
    vscode.window.showInformationMessage(args.tr("{0} · Central files {1} · Central groups {2}{3}", String(message), String(result.centralFileCount), String(result.centralGroupCount), String(normalization)));
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
    ? args.tr("Ensure the current user-home Central library folders and set this path globally?\n\n{0}", String(args.diagnosis.defaultCentralPath))
    : defaultCentralExists
      ? args.tr("Use the existing user-home Central library and set it globally?\n\n{0}", String(args.diagnosis.defaultCentralPath))
      : args.tr("Create a user-home Central library and set it globally?\n\n{0}", String(args.diagnosis.defaultCentralPath));
  const ok = await vscode.window.showWarningMessage(
    confirmMessage,
    { modal: true },
    args.tr("Repair")
  );
  if (ok !== args.tr("Repair")) return;
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
  vscode.window.showInformationMessage(args.tr("User-home Central repaired: {0}", String(args.compactPathForDisplay(result.centralRepoPath))));
}

function shouldOfferUserHomeRepair(diagnosis: EnvironmentDiagnosis): boolean {
  if (diagnosis.configuredCentralIssue) return true;
  if (!isSamePath(diagnosis.centralRepoPath, diagnosis.defaultCentralPath)) return true;
  return diagnosis.checks.some((check) =>
    check.status === "fail"
    || (check.status === "warn" && (check.label === "Central" || check.label.includes("Central layout") || check.label.includes(localize("Central layout"))))
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
  if (diagnosis.configuredCentralRepoPath) {
    output.appendLine(`Configured Central raw: ${diagnosis.configuredCentralRepoPath}`);
  }
  if (diagnosis.configuredCentralIssue) {
    output.appendLine(`Configured Central issue: ${diagnosis.configuredCentralIssue}`);
  }
  output.appendLine(`Default user Central: ${diagnosis.defaultCentralPath}`);
  output.appendLine(`Config scope: ${diagnosis.configScope}`);
  for (const check of diagnosis.checks) {
    output.appendLine(`- [${check.status.toUpperCase()}] ${check.label}: ${check.detail}`);
  }
  output.appendLine(tr("OS action guide:"));
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
        ? `${targetPath} ${tr("missing")} · parent=${parent} · parentWritable=${parentWritable ? "yes" : "no"}`
        : `${targetPath} ${tr("missing; no accessible parent folder was found.")}`
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
    return { label: tr("Central layout"), status: "warn", detail: tr("After creating Central, Skill Bridge can create per-agent skills folders.") };
  }
  const missing: string[] = [];
  for (const tool of allAgents) {
    const root = path.join(getWritableSkillRoot(centralRepoPath, tool, "central"), "skills");
    if (!(await exists(root))) missing.push(`${tool}/skills`);
  }
  return {
    label: tr("Central layout"),
    status: missing.length === 0 ? "ok" : "warn",
    detail: missing.length === 0 ? tr("Per-agent skills folders are ready.") : `${tr("Missing")}: ${missing.join(", ")}`
  };
}

async function checkGitCommand(tr: TranslatePair, toUserError: (error: unknown) => string): Promise<EnvironmentCheck> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync("git", ["--version"], { windowsHide: process.platform === "win32" });
    return { label: "Git", status: "ok", detail: String(stdout).trim() || tr("git is available") };
  } catch (error) {
    return { label: "Git", status: "warn", detail: `${tr("git command is unavailable. Check Git installation/PATH before saving skills to Central.")} ${toUserError(error)}` };
  }
}

async function checkNpxCommand(tr: TranslatePair, toUserError: (error: unknown) => string): Promise<EnvironmentCheck> {
  try {
    const version = await runNpxVersionForDiagnostic();
    return { label: "npx", status: "ok", detail: version ? `npx ${version}` : tr("npx is available") };
  } catch (error) {
    return { label: "npx", status: "warn", detail: `${tr("npx command is unavailable. Check Node.js/npm PATH before using install features.")} ${toUserError(error)}` };
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
      tr("Windows: Prefer Central under %USERPROFILE% instead of Program Files, Windows, or another user's folder."),
      tr("Windows: Avoid mixing administrator and normal VS Code sessions because file ownership/permissions can become inconsistent."),
      tr("Windows: If Git or npx fails, confirm PATH in a new terminal and restart VS Code.")
    ];
  }
  if (process.platform === "darwin") {
    return [
      tr("macOS: Prefer a user-home path such as ~/skill-bridge-repo."),
      tr("macOS: Desktop/Documents/Downloads may require Files and Folders permission for VS Code."),
      tr("macOS: Avoid Central under /System, /Applications, or another user's home.")
    ];
  }
  if (process.platform === "linux") {
    return [
      tr("Linux: Prefer a user-home path such as ~/skill-bridge-repo."),
      tr("Linux: Folders created by root can fail writes in normal VS Code; make the current user the owner."),
      tr("Linux: In containers or remote environments, confirm the Central path is visible to the current VS Code server process.")
    ];
  }
  return [
    tr("Prefer a Central path under the user home."),
    tr("Git/npx must be available on PATH for the VS Code process.")
  ];
}
