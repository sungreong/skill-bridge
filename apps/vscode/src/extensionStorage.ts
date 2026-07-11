import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type {
  GroupTarget,
  InstructionFile,
  PersonalSkillPack,
  ProjectPreset,
  ProjectPresetsFile,
  SelectionGroup,
  SkillFile,
  ToolType,
  WorkspaceGroupFile
} from "./types";
import { renderSkillGroupMarkdown, sanitizeGroupMeta } from "./groupMetadata";
import { coerceUiLanguage, DEFAULT_UI_LANGUAGE, type UiLanguage } from "./uiLanguage";
import { writeTextFileIfChanged } from "./writeTextFileIfChanged";
import {
  compactPathForDisplay as compactCentralPathForDisplay,
  DEFAULT_CENTRAL_REPO_PATH_SETTING,
  formatCentralPathIssue,
  getDefaultCentralRepoPath as resolveDefaultCentralRepoPath,
  resolveCentralRepoPath
} from "./centralPath";
import { mapWithConcurrency } from "./extensionSupport";
import { scanSkillFiles } from "./skillScanner";
import {
  collectFiles,
  INSTRUCTION_ROOT,
  INSTRUCTION_RULE_DIRS,
  isManagedInstructionPath,
  NESTED_INSTRUCTION_FILES,
  normalizeInstructionRelativePath,
  resolveWorkspaceInstructionPath,
  ROOT_INSTRUCTION_FILES,
  sanitizeInstructionProfileName
} from "./skillPaths";
import {
  groupMarkdownPath,
  groupStorePath,
  legacyGroupStorePath,
  legacyPackStorePath,
  legacyProjectPresetStorePath,
  legacySkillsLockPath,
  projectPresetStorePath,
  skillBridgeStateDir,
  skillsLockPath
} from "./storagePaths";

const SETTINGS_SECTION = "skillBridge";
const DEFAULT_CENTRAL_REPO_PATH = DEFAULT_CENTRAL_REPO_PATH_SETTING;
const CONFIGURABLE_TOOLS: ToolType[] = ["claude", "codex", "gemini", "cursor", "antigravity"];
const execFileAsync = promisify(execFile);

export type SelectionGroupLoadResult = {
  groups: SelectionGroup[];
  needsSave: boolean;
  migratedCentralGroupCount: number;
};

export type SkillBridgeStateRepairResult = {
  workspace: SkillBridgeStateSideRepairResult;
  central: SkillBridgeStateSideRepairResult;
};

type SkillBridgeStateSideRepairResult = {
  createdStateDir: boolean;
  createdGroupFile: boolean;
  migratedGroupFile: boolean;
  regeneratedGroupMarkdown: boolean;
  migratedSkillsLock: boolean;
};

export function resolveContext(): { workspacePath: string; centralRepoPath: string; agents: ToolType[] } {
  const workspacePath = getActiveWorkspacePath();
  if (!workspacePath) {
    throw new Error("Open a workspace folder first.");
  }
  const agents = vscode.workspace
    .getConfiguration(SETTINGS_SECTION)
    .get<string[]>("defaultAgents", [...CONFIGURABLE_TOOLS, "agents"])
    .filter(isToolType);
  const centralRepoPath = resolveSharedCentralRepoPath(workspacePath);
  return { workspacePath, centralRepoPath, agents };
}

export function compactPathForDisplay(value: string): string {
  return compactCentralPathForDisplay(value);
}

export function getActiveWorkspacePath(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.fsPath ?? "";
}

export function getDefaultCentralRepoPath(workspacePath: string): string {
  return resolveDefaultCentralRepoPath(workspacePath);
}

function resolveSharedCentralRepoPath(workspacePath: string): string {
  const raw = vscode.workspace.getConfiguration(SETTINGS_SECTION).get<string>("centralRepoPath", DEFAULT_CENTRAL_REPO_PATH);
  const resolved = resolveCentralRepoPath(raw, workspacePath, raw === DEFAULT_CENTRAL_REPO_PATH ? "default" : "configured");
  if (!resolved.ok) {
    throw new Error(formatCentralPathIssue(resolved));
  }
  return resolved.absolutePath;
}

export async function clearCentralRepoPathOverrides(): Promise<void> {
  const config = vscode.workspace.getConfiguration(SETTINGS_SECTION);
  const inspect = config.inspect<string>("centralRepoPath");
  if (inspect?.workspaceValue !== undefined) {
    await config.update("centralRepoPath", undefined, vscode.ConfigurationTarget.Workspace);
  }
  if (inspect?.workspaceFolderValue !== undefined) {
    await config.update("centralRepoPath", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
  }
}

export async function ensureSkillBridgeState(workspacePath: string, centralRepoPath: string): Promise<SkillBridgeStateRepairResult> {
  const [workspace, central] = await Promise.all([
    ensureSkillBridgeStateForBase(workspacePath),
    ensureSkillBridgeStateForBase(centralRepoPath)
  ]);
  return { workspace, central };
}

async function ensureSkillBridgeStateForBase(basePath: string): Promise<SkillBridgeStateSideRepairResult> {
  const stateDir = skillBridgeStateDir(basePath);
  const createdStateDir = !(await exists(stateDir));
  await fs.mkdir(stateDir, { recursive: true });

  const groupPath = groupStorePath(basePath);
  const legacyGroupPath = legacyGroupStorePath(basePath);
  let createdGroupFile = false;
  let migratedGroupFile = false;
  if (!(await exists(groupPath))) {
    if (await exists(legacyGroupPath)) {
      await fs.copyFile(legacyGroupPath, groupPath);
      migratedGroupFile = true;
    } else {
      await fs.writeFile(groupPath, JSON.stringify({ version: 2, groups: [] }, null, 2), "utf8");
      createdGroupFile = true;
    }
  }

  const groups = await loadGroupFile(groupPath);
  const markdownPath = groupMarkdownPath(basePath);
  const regeneratedGroupMarkdown = await writeTextFileIfChanged(
    markdownPath,
    renderSkillGroupMarkdown(groups, getUiLanguage())
  );

  let migratedSkillsLock = false;
  const lockPath = skillsLockPath(basePath);
  const legacyLockPath = legacySkillsLockPath(basePath);
  if (!(await exists(lockPath)) && (await exists(legacyLockPath))) {
    await fs.copyFile(legacyLockPath, lockPath);
    migratedSkillsLock = true;
  }

  return {
    createdStateDir,
    createdGroupFile,
    migratedGroupFile,
    regeneratedGroupMarkdown,
    migratedSkillsLock
  };
}

export async function loadSelectionGroups(workspacePath: string, centralRepoPath: string): Promise<SelectionGroupLoadResult> {
  const workspaceGroups = await loadWorkspaceGroups(workspacePath);
  const centralGroups = await loadWorkspaceGroups(centralRepoPath);
  return {
    groups: [...workspaceGroups, ...centralGroups],
    needsSave: false,
    migratedCentralGroupCount: 0
  };
}

async function loadWorkspaceGroups(workspacePath: string): Promise<SelectionGroup[]> {
  return await loadGroupFile(await resolveExistingGroupStorePath(workspacePath));
}

async function loadGroupFile(target: string): Promise<SelectionGroup[]> {
  if (!(await exists(target))) return [];
  const raw = await fs.readFile(target, "utf8");
  const parsed = JSON.parse(raw) as WorkspaceGroupFile;
  return Array.isArray(parsed.groups)
    ? parsed.groups
        .filter((group) => typeof group?.id === "string" && typeof group?.name === "string")
        .map((group) => ({
          id: group.id,
          name: group.name,
          side: (group.side === "central" ? "central" : "workspace") as "workspace" | "central",
          description: typeof group.description === "string" ? group.description : "",
          targets: Array.isArray(group.targets)
            ? group.targets
                .map((target) => parsePackTarget(target))
                .filter((target): target is GroupTarget => !!target)
                .filter((target) => isToolType(target.tool))
                .filter((target) => isManagedSkillPath(target.relativePath))
            : [],
          meta: sanitizeGroupMeta(group.meta)
        }))
        .filter((group) => group.targets.length > 0)
    : [];
}

async function saveWorkspaceGroups(workspacePath: string, groups: SelectionGroup[]): Promise<void> {
  await saveGroupFile(groupStorePath(workspacePath), groupMarkdownPath(workspacePath), groups);
}

export async function saveSelectionGroups(workspacePath: string, centralRepoPath: string, groups: SelectionGroup[]): Promise<void> {
  await saveWorkspaceGroups(workspacePath, groups.filter((group) => group.side === "workspace"));
  await saveWorkspaceGroups(centralRepoPath, groups.filter((group) => group.side === "central"));
}

async function saveGroupFile(target: string, markdownTarget: string, groups: SelectionGroup[]): Promise<void> {
  const payload: WorkspaceGroupFile = {
    version: 2,
    groups: groups.map((group) => ({
      ...group,
      description: group.description ?? "",
      meta: sanitizeGroupMeta(group.meta)
    }))
  };
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(payload, null, 2), "utf8");
  await fs.writeFile(markdownTarget, renderSkillGroupMarkdown(payload.groups, getUiLanguage()), "utf8");
}

export async function loadProjectPresets(centralRepoPath: string): Promise<{ file: ProjectPresetsFile; migratedFromLegacy: boolean }> {
  const filePath = projectPresetStorePath(centralRepoPath);
  if (await exists(filePath)) {
    return {
      file: await loadProjectPresetFile(filePath),
      migratedFromLegacy: false
    };
  }

  const legacyFilePath = legacyProjectPresetStorePath(centralRepoPath);
  if (await exists(legacyFilePath)) {
    return {
      file: await loadProjectPresetFile(legacyFilePath),
      migratedFromLegacy: true
    };
  }

  const legacyPath = legacyPackStorePath(centralRepoPath);
  if (await exists(legacyPath)) {
    const legacy = await loadLegacyPackFile(legacyPath);
    return {
      file: {
        version: 1,
        updatedAt: legacy.updatedAt,
        presets: legacy.packs.map((pack) => ({
          id: pack.id,
          name: pack.name,
          description: pack.description,
          targets: pack.targets,
          createdAt: pack.createdAt,
          updatedAt: pack.updatedAt,
          lastAppliedAt: pack.lastAppliedAt ?? pack.lastHydratedAt
        }))
      },
      migratedFromLegacy: true
    };
  }

  return {
    file: { version: 1, updatedAt: new Date().toISOString(), presets: [] },
    migratedFromLegacy: false
  };
}

export async function saveProjectPresets(centralRepoPath: string, file: ProjectPresetsFile): Promise<void> {
  const filePath = projectPresetStorePath(centralRepoPath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify({
    version: 1,
    updatedAt: file.updatedAt,
    presets: file.presets.map((preset) => ({
      id: preset.id,
      name: preset.name,
      description: preset.description,
      targets: preset.targets,
      createdAt: preset.createdAt,
      updatedAt: preset.updatedAt,
      lastAppliedAt: preset.lastAppliedAt
    }))
  }, null, 2), "utf8");
}

async function loadProjectPresetFile(filePath: string): Promise<ProjectPresetsFile> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = asRecord(JSON.parse(raw));
    const rows = Array.isArray(parsed?.presets) ? parsed.presets : [];
    const presets = rows
      .map(parseProjectPreset)
      .filter((preset): preset is ProjectPreset => preset !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      version: 1,
      updatedAt: typeof parsed?.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      presets
    };
  } catch {
    return { version: 1, updatedAt: new Date().toISOString(), presets: [] };
  }
}

async function loadLegacyPackFile(filePath: string): Promise<{ updatedAt: string; packs: PersonalSkillPack[] }> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = asRecord(JSON.parse(raw));
    const rows = Array.isArray(parsed?.packs) ? parsed.packs : [];
    const packs = rows
      .map(parsePersonalSkillPack)
      .filter((pack): pack is PersonalSkillPack => pack !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      updatedAt: typeof parsed?.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      packs
    };
  } catch {
    return { updatedAt: new Date().toISOString(), packs: [] };
  }
}

function getUiLanguage(): UiLanguage {
  const raw = vscode.workspace.getConfiguration(SETTINGS_SECTION).get<string>("language", DEFAULT_UI_LANGUAGE);
  return coerceUiLanguage(raw);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

export function parseProjectPreset(value: unknown): ProjectPreset | null {
  const record = asRecord(value);
  if (!record || typeof record.id !== "string" || typeof record.name !== "string") return null;
  const targets = Array.isArray(record.targets)
    ? record.targets.map((target) => parsePackTarget(target)).filter((target): target is GroupTarget => !!target)
    : [];
  return {
    id: record.id,
    name: record.name,
    description: typeof record.description === "string" ? record.description : "",
    targets,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date(0).toISOString(),
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date(0).toISOString(),
    lastAppliedAt: typeof record.lastAppliedAt === "string"
      ? record.lastAppliedAt
      : typeof record.lastHydratedAt === "string"
        ? record.lastHydratedAt
        : undefined
  };
}

export function parsePersonalSkillPack(value: unknown): PersonalSkillPack | null {
  const preset = parseProjectPreset(value);
  const record = asRecord(value);
  if (!preset || !record) return null;
  return {
    ...preset,
    lastHydratedAt: typeof record.lastHydratedAt === "string" ? record.lastHydratedAt : undefined
  };
}

function parsePackTarget(value: unknown): GroupTarget | null {
  const record = asRecord(value);
  if (!record) return null;
  if (!isToolType(String(record.tool ?? ""))) return null;
  const relativePath = normalizeRel(String(record.relativePath ?? ""));
  if (!isManagedSkillPath(relativePath)) return null;
  return {
    kind: record.kind === "file" ? "file" : "folder",
    tool: record.tool as ToolType,
    relativePath
  };
}

export function slugifyPackId(raw: string): string {
  return slugifyProjectPresetId(raw);
}

export function slugifyProjectPresetId(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || `preset-${hashPresetId(raw)}`;
}

function hashPresetId(raw: string): string {
  let hash = 2166136261;
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).slice(0, 8);
}

export async function scanSkills(basePath: string, mode: "workspace" | "central", agents: ToolType[]): Promise<SkillFile[]> {
  return await scanSkillFiles(basePath, mode, agents);
}

export async function scanWorkspaceInstructions(workspacePath: string): Promise<InstructionFile[]> {
  const out: InstructionFile[] = [];
  const found = new Set<string>();
  for (const relativePath of [...ROOT_INSTRUCTION_FILES, ...NESTED_INSTRUCTION_FILES]) {
    const normalized = normalizeInstructionRelativePath(relativePath);
    const absolutePath = resolveWorkspaceInstructionPath(workspacePath, normalized);
    if (!(await exists(absolutePath))) continue;
    found.add(normalized);
    out.push({ relativePath: normalized, absolutePath });
  }
  for (const ruleDir of INSTRUCTION_RULE_DIRS) {
    const dir = path.join(workspacePath, ...ruleDir.dir.split("/"));
    if (!(await exists(dir))) continue;
    const entries = await readDirEntriesOrEmpty(dir);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!ruleDir.extensions.has(ext)) continue;
      const relativePath = normalizeInstructionRelativePath(path.posix.join(ruleDir.dir, entry.name));
      if (found.has(relativePath)) continue;
      found.add(relativePath);
      out.push({ relativePath, absolutePath: path.join(dir, entry.name) });
    }
  }
  return out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export async function scanCentralInstructions(centralRepoPath: string): Promise<InstructionFile[]> {
  const instructionsRoot = path.join(centralRepoPath, INSTRUCTION_ROOT);
  if (!(await exists(instructionsRoot))) return [];
  const entries = await readDirEntriesOrEmpty(instructionsRoot);
  const profileEntries = entries.filter((entry) => entry.isDirectory());
  const filesByProfile = await mapWithConcurrency(profileEntries, 4, async (entry) => {
    const out: InstructionFile[] = [];
    const profileId = sanitizeInstructionProfileName(entry.name);
    const profileRoot = path.join(instructionsRoot, entry.name);
    const relativePaths = (await collectFiles(profileRoot, profileRoot))
      .map(normalizeInstructionRelativePath)
      .filter(isManagedInstructionPath);
    for (const relativePath of relativePaths) {
      out.push({
        relativePath,
        profileId,
        displayPath: path.posix.join(profileId, relativePath),
        absolutePath: path.join(profileRoot, ...relativePath.split("/"))
      });
    }
    return out;
  });
  const out = filesByProfile.flat();
  return out.sort((a, b) => (a.profileId ?? "").localeCompare(b.profileId ?? "") || a.relativePath.localeCompare(b.relativePath));
}

export function parseSkillInputs(raw: string): string[] {
  const cleaned = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.replace(/^['"]+|['"]+$/g, "").trim())
    .filter(Boolean);
  return cleaned.length > 0 ? cleaned : ["*"];
}

export async function loadSkillFilesBySide(
  side: "workspace" | "central",
  workspacePath: string,
  centralRepoPath: string,
  agents: ToolType[]
): Promise<SkillFile[]> {
  return await scanSkills(side === "workspace" ? workspacePath : centralRepoPath, side, agents);
}

export async function runSkillsAdd(
  cwd: string,
  repo: string,
  skills: string[]
): Promise<{ ok: boolean; command: string; stdout: string; stderr: string }> {
  const skillArgs = skills.flatMap((skill) => ["--skill", skill]);
  const args = ["-y", "skills", "add", repo, ...skillArgs, "--yes"];
  const command = formatCommandForDisplay("npx", args);
  const maxBuffer = 12 * 1024 * 1024;
  const firstRun = await runSkillsAddOnce(args, cwd, maxBuffer);
  if (firstRun.ok || !isBrokenNpxSkillsCliCache(firstRun.stdout, firstRun.stderr)) {
    return { ...firstRun, command };
  }

  const retry = await runSkillsAddWithIsolatedCache(args, cwd, maxBuffer);
  const retryNote = retry.ok
    ? "Detected a broken npm npx cache for the skills CLI, then retried with an isolated temporary npm cache successfully."
    : "Detected a broken npm npx cache for the skills CLI and retried with an isolated temporary npm cache, but the retry also failed. Run `npm cache clean --force` in a local terminal, then try again.";
  return {
    ok: retry.ok,
    command,
    stdout: joinMessages(firstRun.stdout, retry.stdout),
    stderr: joinMessages(firstRun.stderr, retryNote, retry.stderr)
  };
}

async function runSkillsAddOnce(
  args: string[],
  cwd: string,
  maxBuffer: number,
  env?: NodeJS.ProcessEnv
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  for (const cmd of getNpxExecFileCandidates()) {
    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, {
        cwd,
        windowsHide: process.platform === "win32",
        maxBuffer,
        env
      });
      return { ok: true, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") };
    } catch (error) {
      const execError = error as { code?: number | string; stdout?: string; stderr?: string };
      if (execError.code === "ENOENT") continue;
      if (typeof execError.code === "number") {
        return {
          ok: false,
          stdout: String(execError.stdout ?? ""),
          stderr: String(execError.stderr ?? "")
        };
      }
    }
  }
  try {
    const spawned = await runSkillsAddWithSpawn(args, cwd, env);
    return {
      ok: spawned.code === 0,
      stdout: spawned.stdout,
      stderr: spawned.stderr
    };
  } catch (error) {
    const spawnError = error as { code?: string; message?: string };
    const message = spawnError.code === "ENOENT"
      ? "Could not find the npx executable. Check the Node.js/npm installation and PATH."
      : String(spawnError.message ?? error);
    return { ok: false, stdout: "", stderr: message };
  }
}

async function runSkillsAddWithIsolatedCache(
  args: string[],
  cwd: string,
  maxBuffer: number
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-bridge-npm-cache-"));
  try {
    return await runSkillsAddOnce(args, cwd, maxBuffer, {
      ...process.env,
      npm_config_cache: cacheDir,
      npm_config_prefer_online: "true",
      npm_config_audit: "false",
      npm_config_fund: "false"
    });
  } finally {
    await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function runSkillsAddWithSpawn(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const command = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "npx";
    const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", "npx", ...args] : args;
    const child = spawn(command, commandArgs, {
      cwd,
      windowsHide: process.platform === "win32",
      shell: false,
      timeout: 180000,
      env
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
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function isBrokenNpxSkillsCliCache(stdout: string, stderr: string): boolean {
  const output = `${stdout}\n${stderr}`;
  return output.includes("ERR_MODULE_NOT_FOUND")
    && /node_modules[\\/]+skills[\\/]+dist[\\/]+cli\.mjs/i.test(output);
}

function joinMessages(...messages: string[]): string {
  return messages.map((message) => message.trim()).filter(Boolean).join("\n");
}

function normalizeRel(p: string | undefined | null): string {
  if (!p) return "";
  return p.replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

function isManagedSkillPath(relativePath: string): boolean {
  const n = normalizeRel(relativePath).toLowerCase();
  return n === "skills" || n.startsWith("skills/");
}

function isToolType(value: string): value is ToolType {
  return (["claude", "codex", "gemini", "cursor", "antigravity", "agents"] as string[]).includes(value);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function resolveExistingGroupStorePath(basePath: string): Promise<string> {
  const current = groupStorePath(basePath);
  if (await exists(current)) return current;
  return legacyGroupStorePath(basePath);
}

async function readDirEntriesOrEmpty(dirPath: string): Promise<import("node:fs").Dirent[]> {
  try {
    return await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (isSkippableFileSystemError(error)) return [];
    throw error;
  }
}

function isSkippableFileSystemError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = String((error as { code?: unknown }).code ?? "");
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP" || code === "EPERM" || code === "EACCES";
}

function getNpxExecFileCandidates(): string[] {
  return process.platform === "win32" ? [] : ["npx"];
}

function formatCommandForDisplay(command: string, args: string[]): string {
  return [command, ...args].map(quoteCommandArg).join(" ");
}

function quoteCommandArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}
