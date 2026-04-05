import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GLOBAL_WORKSPACE_ID = "ws-global-default";
const GLOBAL_WORKSPACE_NAME = "Global (Home)";

export type ToolType = "claude" | "codex" | "gemini" | "cursor" | "antigravity";
export type SkillSource = "workspace" | "central";
export type SkillNodeType = "file" | "folder";

export interface WorkspaceEntry {
  id: string;
  name: string;
  path: string;
}

export interface AppConfig {
  centralRepo: string;
  autoPush: boolean;
  defaultTool: ToolType;
  fontSize: number;
  workspaces: WorkspaceEntry[];
  activeWorkspaceId: string | null;
}

export interface DirectoryStatus {
  tool: ToolType;
  workspaceDir: string;
  exists: boolean;
}

export interface SkillFile {
  tool: ToolType;
  relativePath: string;
  absolutePath: string;
}

export interface WorkspaceInspection {
  workspacePath: string;
  statuses: DirectoryStatus[];
  workspaceSkills: SkillFile[];
}

export interface DiffResult {
  hasChanges: boolean;
  oldText: string;
  newText: string;
  unifiedDiff: string;
}

export interface SensitiveWarning {
  rule: string;
  description: string;
}

export interface PromoteRequest {
  workspacePath: string;
  centralRepoPath: string;
  selections: Array<{ tool: ToolType; relativePath: string }>;
}

export interface ImportRequest {
  workspacePath: string;
  centralRepoPath: string;
  selections: Array<{ tool: ToolType; relativePath: string }>;
}

export interface UpdateCandidate {
  tool: ToolType;
  relativePath: string;
  diff: DiffResult;
}

export type DiffStatus = "changed" | "onlyWorkspace" | "onlyCentral";

export interface FileDiffStats {
  tool: ToolType;
  relativePath: string;
  status: DiffStatus;
  workspaceBytes: number;
  centralBytes: number;
  sizeDelta: number;
  addedLines: number;
  removedLines: number;
  lineDelta: number;
}

export interface WorkspaceCentralOverview {
  totalCompared: number;
  changedCount: number;
  onlyWorkspaceCount: number;
  onlyCentralCount: number;
  sameCount: number;
  items: FileDiffStats[];
}

export interface CentralRepoStatus {
  exists: boolean;
  isGitRepo: boolean;
}

export interface SyncCentralRepoRequest {
  centralRepoPath: string;
  commitMessage: string;
  push?: boolean;
}

export interface SyncCentralRepoResult {
  changedFiles: string[];
  commitHash?: string;
  pushed: boolean;
  message: string;
}

export interface GitRemoteInfo {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface GitDiagnostics {
  isGitRepo: boolean;
  branch: string;
  upstream: string | null;
  changedFiles: string[];
  remotes: GitRemoteInfo[];
  originUrl: string | null;
}

export interface GitRemoteTestResult {
  ok: boolean;
  remote: string;
  url: string | null;
  message: string;
}

export interface SkillsCliRequest {
  cwd: string;
  action: "add" | "check" | "update" | "list" | "find";
  repo?: string;
  skills?: string[];
  query?: string;
  yes?: boolean;
}

export interface SkillsCliResult {
  ok: boolean;
  command: string;
  stdout: string;
  stderr: string;
}

export interface ValidateTargetResult {
  exists: boolean;
  parentExists: boolean;
  absolutePath: string;
}

export interface WorkspaceGroupFile {
  version: number;
  groups: Array<{
    id: string;
    name: string;
    side: "workspace" | "central";
    targets: Array<{ kind: "file" | "folder"; tool: ToolType; relativePath: string }>;
  }>;
}

const TOOL_PATHS: Record<ToolType, { workspace: string; central: string }> = {
  claude: { workspace: ".claude", central: "claude" },
  codex: { workspace: ".codex", central: "codex" },
  gemini: { workspace: ".gemini", central: "gemini" },
  cursor: { workspace: ".cursor", central: "cursor" },
  antigravity: { workspace: ".antigravity", central: "antigravity" }
};

const EDITABLE_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".yaml", ".yml", ".js", ".ts", ".tsx", ".jsx", ".sh", ".ps1", ".toml", ".ini", ".cfg", ".env"
]);

const GLOBAL_IGNORED_DIR_NAMES = new Set([
  "backups",
  "backup",
  "cache",
  ".cache",
  "debug",
  "logs",
  "log",
  "tmp",
  "temp",
  ".tmp",
  ".temp",
  "sessions",
  "session",
  "history",
  "node_modules",
  ".git",
  "dist",
  "build"
]);

const SENSITIVE_RULES: Array<{ rule: string; description: string; regex: RegExp }> = [
  { rule: "email", description: "이메일 패턴", regex: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi },
  { rule: "url", description: "URL 패턴", regex: /https?:\/\/[^\s]+/gi },
  { rule: "long-number", description: "긴 숫자열(8자리 이상)", regex: /\b\d{8,}\b/g },
  { rule: "card-like", description: "카드번호 유사 패턴", regex: /\b(?:\d[ -]*?){13,19}\b/g },
  { rule: "rrn-like", description: "주민번호 유사 패턴", regex: /\b\d{6}-?[1-4]\d{6}\b/g },
  { rule: "internal-domain", description: "내부 도메인 문자열", regex: /\b[a-z0-9-]+\.(?:internal|corp|local)\b/gi }
];

const SKILLS_ONLY_ERROR = "skills 폴더 하위만 관리할 수 있습니다.";

type LocalDiffPart = {
  added?: boolean;
  removed?: boolean;
  value: string;
};

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

function isManagedSkillRelativePath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath).toLowerCase();
  return normalized === "skills" || normalized.startsWith("skills/");
}

function assertManagedSkillRelativePath(relativePath: string): void {
  if (!isManagedSkillRelativePath(relativePath)) {
    throw new Error(SKILLS_ONLY_ERROR);
  }
}

export function getConfigPath(): string {
  return path.join(os.homedir(), ".skill_bridge_config.json");
}

export async function loadConfig(): Promise<AppConfig> {
  try {
    const raw = await fs.readFile(getConfigPath(), "utf8");
    return normalizeConfig(JSON.parse(raw) as Partial<AppConfig>);
  } catch {
    return normalizeConfig({});
  }
}

export async function saveConfig(input: Partial<AppConfig>): Promise<AppConfig> {
  const current = await loadConfig();
  const next = normalizeConfig({ ...current, ...input });
  await fs.writeFile(getConfigPath(), JSON.stringify(next, null, 2), "utf8");
  return next;
}

function normalizeConfig(input: Partial<AppConfig>): AppConfig {
  const defaultCentral = path.join(os.homedir(), "skill-bridge-repo");
  const userWorkspaces = (input.workspaces ?? [])
    .filter((item) => item?.id && item?.path && item.id !== GLOBAL_WORKSPACE_ID)
    .map((item) => ({
      id: item.id,
      name: item.name || path.basename(item.path),
      path: item.path
    }));

  const hasGlobal = hasGlobalSkillWorkspace();
  const homePath = os.homedir();
  const dedupedUser = hasGlobal
    ? userWorkspaces.filter((item) => path.resolve(item.path) !== path.resolve(homePath))
    : userWorkspaces;

  const workspaces = hasGlobal
    ? [{ id: GLOBAL_WORKSPACE_ID, name: GLOBAL_WORKSPACE_NAME, path: homePath }, ...dedupedUser]
    : dedupedUser;

  const activeWorkspaceId = workspaces.some((item) => item.id === input.activeWorkspaceId)
    ? input.activeWorkspaceId!
    : workspaces[0]?.id ?? null;

  return {
    centralRepo: input.centralRepo?.trim() || defaultCentral,
    autoPush: input.autoPush ?? true,
    defaultTool: input.defaultTool ?? "claude",
    fontSize: Math.max(11, Math.min(22, input.fontSize ?? 15)),
    workspaces,
    activeWorkspaceId
  };
}

function hasGlobalSkillWorkspace(): boolean {
  const home = os.homedir();
  for (const tool of Object.keys(TOOL_PATHS) as ToolType[]) {
    if (existsSync(path.join(home, TOOL_PATHS[tool].workspace))) {
      return true;
    }
  }
  return false;
}

export async function inspectWorkspace(workspacePath: string): Promise<WorkspaceInspection> {
  const statuses: DirectoryStatus[] = [];
  const workspaceSkills: SkillFile[] = [];
  const isGlobalWorkspace = path.resolve(workspacePath) === path.resolve(os.homedir());

  for (const tool of Object.keys(TOOL_PATHS) as ToolType[]) {
    const dir = path.join(workspacePath, TOOL_PATHS[tool].workspace);
    const exists = await existsPath(dir);
    statuses.push({ tool, workspaceDir: dir, exists });

    if (exists) {
      const files = await collectFiles(dir, {
        skipDirNames: isGlobalWorkspace ? GLOBAL_IGNORED_DIR_NAMES : undefined
      });
      for (const relativePath of files) {
        if (!isManagedSkillRelativePath(relativePath)) continue;
        workspaceSkills.push({ tool, relativePath, absolutePath: path.join(dir, relativePath) });
      }
    }
  }

  workspaceSkills.sort((a, b) => a.tool.localeCompare(b.tool) || a.relativePath.localeCompare(b.relativePath));
  return { workspacePath, statuses, workspaceSkills };
}

export async function listCentralSkills(centralRepoPath: string): Promise<SkillFile[]> {
  const output: SkillFile[] = [];

  for (const tool of Object.keys(TOOL_PATHS) as ToolType[]) {
    const dir = path.join(centralRepoPath, TOOL_PATHS[tool].central);
    if (!(await existsPath(dir))) continue;
    const files = await collectFiles(dir);
    for (const relativePath of files) {
      if (!isManagedSkillRelativePath(relativePath)) continue;
      output.push({ tool, relativePath, absolutePath: path.join(dir, relativePath) });
    }
  }

  output.sort((a, b) => a.tool.localeCompare(b.tool) || a.relativePath.localeCompare(b.relativePath));
  return output;
}

export async function checkCentralRepo(centralRepoPath: string): Promise<CentralRepoStatus> {
  const exists = await existsPath(centralRepoPath);
  if (!exists) return { exists: false, isGitRepo: false };
  return { exists: true, isGitRepo: await existsPath(path.join(centralRepoPath, ".git")) };
}

export async function initializeCentralRepo(centralRepoPath: string): Promise<void> {
  await fs.mkdir(centralRepoPath, { recursive: true });
  if (!(await existsPath(path.join(centralRepoPath, ".git")))) {
    await runGit(centralRepoPath, ["init"]);
  }

  for (const tool of Object.keys(TOOL_PATHS) as ToolType[]) {
    await fs.mkdir(path.join(centralRepoPath, TOOL_PATHS[tool].central), { recursive: true });
  }
}

export async function buildDiff(oldText: string, newText: string, label = "skill.md"): Promise<DiffResult> {
  const oldNormalized = normalizeForDiff(oldText);
  const newNormalized = normalizeForDiff(newText);
  const hasChanges = oldNormalized !== newNormalized;
  return {
    hasChanges,
    oldText,
    newText,
    unifiedDiff: hasChanges ? createUnifiedPatch(label, oldNormalized, newNormalized) : ""
  };
}

export function scanSensitiveContent(text: string): SensitiveWarning[] {
  const warnings: SensitiveWarning[] = [];
  for (const rule of SENSITIVE_RULES) {
    rule.regex.lastIndex = 0;
    if (rule.regex.test(text)) warnings.push({ rule: rule.rule, description: rule.description });
  }
  return warnings;
}

export async function compareSkill(
  workspacePath: string,
  centralRepoPath: string,
  tool: ToolType,
  relativePath: string,
  mode: "promote" | "import"
): Promise<DiffResult> {
  assertManagedSkillRelativePath(relativePath);
  const workspaceFile = resolveSkillPath(workspacePath, tool, relativePath, "workspace");
  const centralFile = resolveSkillPath(centralRepoPath, tool, relativePath, "central");

  const workspaceText = await readIfExists(workspaceFile);
  const centralText = await readIfExists(centralFile);

  if (mode === "promote") {
    return buildDiff(centralText ?? "", workspaceText ?? "", `${tool}/${relativePath}`);
  }
  return buildDiff(workspaceText ?? "", centralText ?? "", `${tool}/${relativePath}`);
}

export async function promoteSkills(req: PromoteRequest): Promise<{ changedFiles: string[]; commitHash?: string }> {
  const changedFiles = await copyWorkspaceToCentral(req.workspacePath, req.centralRepoPath, req.selections);
  return { changedFiles };
}

export async function importSkills(req: ImportRequest): Promise<{ changedFiles: string[] }> {
  const changedFiles = await copyCentralToWorkspace(req.centralRepoPath, req.workspacePath, req.selections);
  return { changedFiles };
}

export async function findUpdateCandidates(workspacePath: string, centralRepoPath: string): Promise<UpdateCandidate[]> {
  const workspace = await inspectWorkspace(workspacePath);
  const central = await listCentralSkills(centralRepoPath);
  const workspaceKeyed = new Set(workspace.workspaceSkills.map((f) => `${f.tool}:${f.relativePath}`));

  const candidates: UpdateCandidate[] = [];
  for (const item of central) {
    const key = `${item.tool}:${item.relativePath}`;
    if (!workspaceKeyed.has(key)) continue;
    const diff = await compareSkill(workspacePath, centralRepoPath, item.tool, item.relativePath, "import");
    if (diff.hasChanges) candidates.push({ tool: item.tool, relativePath: item.relativePath, diff });
  }

  candidates.sort((a, b) => a.tool.localeCompare(b.tool) || a.relativePath.localeCompare(b.relativePath));
  return candidates;
}

export async function applyUpdates(
  workspacePath: string,
  centralRepoPath: string,
  selections: Array<{ tool: ToolType; relativePath: string }>
): Promise<{ changedFiles: string[] }> {
  return importSkills({ workspacePath, centralRepoPath, selections });
}

export async function compareWorkspaceCentralOverview(workspacePath: string, centralRepoPath: string): Promise<WorkspaceCentralOverview> {
  const workspace = await inspectWorkspace(workspacePath);
  const central = await listCentralSkills(centralRepoPath);

  const workspaceKeys = new Set(workspace.workspaceSkills.map((f) => `${f.tool}:${f.relativePath}`));
  const centralKeys = new Set(central.map((f) => `${f.tool}:${f.relativePath}`));
  const union = new Set<string>([...workspaceKeys, ...centralKeys]);

  const items: FileDiffStats[] = [];
  let changedCount = 0;
  let onlyWorkspaceCount = 0;
  let onlyCentralCount = 0;
  let sameCount = 0;

  for (const key of union) {
    const [toolRaw, ...rest] = key.split(":");
    const tool = toolRaw as ToolType;
    const relativePath = rest.join(":");
    const workspaceFile = resolveSkillPath(workspacePath, tool, relativePath, "workspace");
    const centralFile = resolveSkillPath(centralRepoPath, tool, relativePath, "central");
    const workspaceText = await readIfExists(workspaceFile);
    const centralText = await readIfExists(centralFile);

    if (workspaceText === undefined && centralText === undefined) {
      continue;
    }

    if (workspaceText !== undefined && centralText === undefined) {
      const added = countLines(workspaceText);
      onlyWorkspaceCount += 1;
      items.push({
        tool,
        relativePath,
        status: "onlyWorkspace",
        workspaceBytes: byteLength(workspaceText),
        centralBytes: 0,
        sizeDelta: byteLength(workspaceText),
        addedLines: added,
        removedLines: 0,
        lineDelta: added
      });
      continue;
    }

    if (workspaceText === undefined && centralText !== undefined) {
      const removed = countLines(centralText);
      onlyCentralCount += 1;
      items.push({
        tool,
        relativePath,
        status: "onlyCentral",
        workspaceBytes: 0,
        centralBytes: byteLength(centralText),
        sizeDelta: -byteLength(centralText),
        addedLines: 0,
        removedLines: removed,
        lineDelta: -removed
      });
      continue;
    }

    const ws = workspaceText ?? "";
    const ce = centralText ?? "";
    const lines = diffLinesLocal(ce, ws);
    let addedLines = 0;
    let removedLines = 0;
    for (const part of lines) {
      const lineCount = countLines(part.value);
      if (part.added) addedLines += lineCount;
      if (part.removed) removedLines += lineCount;
    }

    if (ws === ce) {
      sameCount += 1;
      continue;
    }

    changedCount += 1;
    items.push({
      tool,
      relativePath,
      status: "changed",
      workspaceBytes: byteLength(ws),
      centralBytes: byteLength(ce),
      sizeDelta: byteLength(ws) - byteLength(ce),
      addedLines,
      removedLines,
      lineDelta: addedLines - removedLines
    });
  }

  items.sort((a, b) => a.tool.localeCompare(b.tool) || a.relativePath.localeCompare(b.relativePath));
  return {
    totalCompared: union.size,
    changedCount,
    onlyWorkspaceCount,
    onlyCentralCount,
    sameCount,
    items
  };
}

function createUnifiedPatch(label: string, oldText: string, newText: string): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const out: string[] = [];
  out.push(`--- before/${label}`);
  out.push(`+++ after/${label}`);
  out.push(`@@ -1,${oldLines.length} +1,${newLines.length} @@`);
  for (const line of oldLines) {
    out.push(`-${line}`);
  }
  for (const line of newLines) {
    out.push(`+${line}`);
  }
  return out.join("\n");
}

function diffLinesLocal(oldText: string, newText: string): LocalDiffPart[] {
  if (oldText === newText) {
    return [{ value: oldText }];
  }
  const out: LocalDiffPart[] = [];
  if (oldText.length > 0) out.push({ removed: true, value: oldText });
  if (newText.length > 0) out.push({ added: true, value: newText });
  return out;
}

export function isEditableTextFile(relativePath: string): boolean {
  const ext = path.extname(relativePath).toLowerCase();
  if (!ext) return true;
  return EDITABLE_EXTENSIONS.has(ext);
}

function normalizeForDiff(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.replace(/\r\n/g, "\n").split("\n").length;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export async function readSkillText(basePath: string, source: SkillSource, tool: ToolType, relativePath: string): Promise<string> {
  assertManagedSkillRelativePath(relativePath);
  if (!isEditableTextFile(relativePath)) throw new Error("텍스트 파일만 편집할 수 있습니다.");
  const target = resolveSkillPath(basePath, tool, relativePath, source);
  return fs.readFile(target, "utf8");
}

export async function writeSkillText(basePath: string, source: SkillSource, tool: ToolType, relativePath: string, content: string): Promise<void> {
  assertManagedSkillRelativePath(relativePath);
  if (!isEditableTextFile(relativePath)) throw new Error("텍스트 파일만 저장할 수 있습니다.");
  const target = resolveSkillPath(basePath, tool, relativePath, source);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

export async function createSkillNode(
  basePath: string,
  source: SkillSource,
  tool: ToolType,
  relativePath: string,
  nodeType: SkillNodeType,
  content = ""
): Promise<void> {
  assertManagedSkillRelativePath(relativePath);
  const target = resolveSkillPath(basePath, tool, relativePath, source);
  if (await existsPath(target)) throw new Error("이미 같은 경로가 존재합니다.");

  if (nodeType === "folder") {
    await fs.mkdir(target, { recursive: true });
  } else {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
}

export async function renameSkillNode(
  basePath: string,
  source: SkillSource,
  tool: ToolType,
  fromRelativePath: string,
  toRelativePath: string
): Promise<void> {
  assertManagedSkillRelativePath(fromRelativePath);
  assertManagedSkillRelativePath(toRelativePath);
  const fromPath = resolveSkillPath(basePath, tool, fromRelativePath, source);
  const toPath = resolveSkillPath(basePath, tool, toRelativePath, source);

  if (!(await existsPath(fromPath))) throw new Error("원본 경로가 존재하지 않습니다.");
  if (await existsPath(toPath)) throw new Error("대상 경로가 이미 존재합니다.");

  await fs.mkdir(path.dirname(toPath), { recursive: true });
  await fs.rename(fromPath, toPath);
}

export async function deleteSkillNode(
  basePath: string,
  source: SkillSource,
  tool: ToolType,
  relativePath: string
): Promise<void> {
  assertManagedSkillRelativePath(relativePath);
  const target = resolveSkillPath(basePath, tool, relativePath, source);
  if (!(await existsPath(target))) throw new Error("삭제 대상이 존재하지 않습니다.");
  await fs.rm(target, { recursive: true, force: true });
}

export async function duplicateSkillNode(
  basePath: string,
  source: SkillSource,
  tool: ToolType,
  fromRelativePath: string,
  toRelativePath: string
): Promise<void> {
  assertManagedSkillRelativePath(fromRelativePath);
  assertManagedSkillRelativePath(toRelativePath);
  const fromPath = resolveSkillPath(basePath, tool, fromRelativePath, source);
  const toPath = resolveSkillPath(basePath, tool, toRelativePath, source);

  if (!(await existsPath(fromPath))) throw new Error("복제 원본이 존재하지 않습니다.");
  if (await existsPath(toPath)) throw new Error("복제 대상 경로가 이미 존재합니다.");

  const stat = await fs.stat(fromPath);
  if (stat.isDirectory()) {
    await copyDirectory(fromPath, toPath);
  } else {
    await fs.mkdir(path.dirname(toPath), { recursive: true });
    await fs.copyFile(fromPath, toPath);
  }
}

export async function existsSkillNode(
  basePath: string,
  source: SkillSource,
  tool: ToolType,
  relativePath: string
): Promise<boolean> {
  assertManagedSkillRelativePath(relativePath);
  return existsPath(resolveSkillPath(basePath, tool, relativePath, source));
}

export async function validateSkillTarget(
  basePath: string,
  source: SkillSource,
  tool: ToolType,
  relativePath: string
): Promise<ValidateTargetResult> {
  assertManagedSkillRelativePath(relativePath);
  const absolutePath = resolveSkillPath(basePath, tool, relativePath, source);
  return {
    exists: await existsPath(absolutePath),
    parentExists: await existsPath(path.dirname(absolutePath)),
    absolutePath
  };
}

export async function syncCentralRepo(req: SyncCentralRepoRequest): Promise<SyncCentralRepoResult> {
  await ensureGitRepo(req.centralRepoPath);

  const changedFiles = await listGitChangedFiles(req.centralRepoPath);
  if (changedFiles.length === 0) {
    return { changedFiles: [], pushed: false, message: "동기화할 변경사항이 없습니다." };
  }

  if (!req.commitMessage.trim()) {
    throw new Error("동기화 commit message를 입력해주세요.");
  }

  await runGit(req.centralRepoPath, ["add", "-A"]);
  await runGit(req.centralRepoPath, ["commit", "-m", req.commitMessage]);
  const commitHash = (await runGit(req.centralRepoPath, ["rev-parse", "HEAD"])).trim();

  if (req.push === false) {
    return { changedFiles, commitHash, pushed: false, message: "로컬 commit만 완료했습니다." };
  }

  const branch = (await runGit(req.centralRepoPath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (!branch || branch === "HEAD") {
    throw new Error("현재 브랜치를 확인할 수 없습니다. 브랜치를 만든 뒤 다시 시도해주세요.");
  }

  try {
    await runGit(req.centralRepoPath, ["push"]);
  } catch (error) {
    const message = String(error).toLowerCase();
    if (message.includes("tracking information") || message.includes("no upstream")) {
      const remotes = (await runGit(req.centralRepoPath, ["remote"])).split(/\r?\n/).filter(Boolean);
      if (!remotes.includes("origin")) {
        throw new Error("origin 원격 저장소가 없습니다. origin 설정 후 다시 시도해주세요.");
      }
      await runGit(req.centralRepoPath, ["push", "-u", "origin", branch]);
    } else {
      throw error;
    }
  }

  return { changedFiles, commitHash, pushed: true, message: "동기화(commit + push) 완료" };
}

export async function loadWorkspaceGroupFile(workspacePath: string): Promise<WorkspaceGroupFile> {
  const target = path.join(workspacePath, "skill_workspace.json");
  if (!(await existsPath(target))) {
    return { version: 1, groups: [] };
  }

  try {
    const raw = await fs.readFile(target, "utf8");
    const parsed = JSON.parse(raw) as Partial<WorkspaceGroupFile>;
    const groups = Array.isArray(parsed.groups) ? parsed.groups : [];
    return {
      version: 1,
      groups: groups
        .filter((group) => group && typeof group.id === "string" && typeof group.name === "string")
        .map((group) => ({
          id: group.id,
          name: group.name,
          side: group.side === "central" ? "central" : "workspace",
          targets: Array.isArray(group.targets)
            ? group.targets
                .filter((target) => target && (target.kind === "file" || target.kind === "folder"))
                .map((target) => ({
                  kind: target.kind!,
                  tool: target.tool!,
                  relativePath: String(target.relativePath ?? "")
                }))
            : []
        }))
    };
  } catch {
    return { version: 1, groups: [] };
  }
}

export async function saveWorkspaceGroupFile(workspacePath: string, data: WorkspaceGroupFile): Promise<void> {
  const target = path.join(workspacePath, "skill_workspace.json");
  await fs.writeFile(target, JSON.stringify({ version: 1, groups: data.groups ?? [] }, null, 2), "utf8");
}

export async function getGitDiagnostics(centralRepoPath: string): Promise<GitDiagnostics> {
  const status = await checkCentralRepo(centralRepoPath);
  if (!status.isGitRepo) {
    return {
      isGitRepo: false,
      branch: "",
      upstream: null,
      changedFiles: [],
      remotes: [],
      originUrl: null
    };
  }

  const branch = (await runGit(centralRepoPath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  const upstream = (await runGitAllowFail(centralRepoPath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])).trim() || null;
  const changedFiles = await listGitChangedFiles(centralRepoPath);
  const remotes = await listGitRemotes(centralRepoPath);
  const origin = remotes.find((item) => item.name === "origin");

  return {
    isGitRepo: true,
    branch,
    upstream,
    changedFiles,
    remotes,
    originUrl: origin?.fetchUrl ?? null
  };
}

export async function testGitRemote(centralRepoPath: string, remote = "origin"): Promise<GitRemoteTestResult> {
  await ensureGitRepo(centralRepoPath);
  const remotes = await listGitRemotes(centralRepoPath);
  const target = remotes.find((item) => item.name === remote);
  if (!target) {
    return { ok: false, remote, url: null, message: `${remote} 원격 저장소가 없습니다.` };
  }

  try {
    await runGit(centralRepoPath, ["ls-remote", "--heads", remote]);
    return { ok: true, remote, url: target.fetchUrl, message: `${remote} 연결 확인 성공` };
  } catch (error) {
    return { ok: false, remote, url: target.fetchUrl, message: `연결 실패: ${String(error)}` };
  }
}

export async function runSkillsCli(req: SkillsCliRequest): Promise<SkillsCliResult> {
  if (!(await existsPath(req.cwd))) {
    throw new Error(`작업 경로가 없습니다: ${req.cwd}`);
  }

  const args: string[] = [];
  if (req.yes !== false) args.push("-y");
  args.push("skills", req.action);

  if (req.action === "add") {
    if (!req.repo?.trim()) throw new Error("add 동작에는 repo가 필요합니다.");
    // https://github.com/owner/repo → owner/repo
    const rawRepo = req.repo.trim();
    const repoArg = rawRepo.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
    args.push(repoArg);
    const normalizedSkills = (req.skills ?? [])
      .map((skill) => skill.trim().replace(/^['"]+|['"]+$/g, "").trim())
      .filter(Boolean);
    const targetSkills = normalizedSkills.length > 0 ? normalizedSkills : ["*"];
    for (const skill of targetSkills) {
      const trimmed = skill.trim();
      if (!trimmed) continue;
      args.push("--skill", trimmed);
    }
    if (req.yes !== false) args.push("--yes");
  }

  if (req.action === "find" && req.query?.trim()) {
    args.push(req.query.trim());
  }

  const command = `npx ${args.join(" ")}`;
  // eslint-disable-next-line no-control-regex
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?][0-9;]*[A-Za-z]|\x1b\[[0-9;]*m|\r/g, "").trim();
  const execOpts = {
    cwd: req.cwd,
    timeout: 180000,
    windowsHide: true,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" },
  };
  try {
    if (process.platform === "win32") {
      const winResult = await runSkillsCliOnWindows(args, execOpts);
      const mirrorNote = req.action === "add" ? await mirrorInstalledSkillsIfCentralLayout(req.cwd) : "";
      return {
        ok: winResult.code === 0,
        command,
        stdout: stripAnsi(winResult.stdout),
        stderr: stripAnsi(joinMessages(winResult.stderr, mirrorNote))
      };
    }
    const { stdout, stderr } = await execFileAsync("npx", args, execOpts);
    const mirrorNote = req.action === "add" ? await mirrorInstalledSkillsIfCentralLayout(req.cwd) : "";
    return { ok: true, command, stdout: stripAnsi(stdout), stderr: stripAnsi(joinMessages(stderr, mirrorNote)) };
  } catch (error: unknown) {
    const stdout = typeof error === "object" && error && "stdout" in error ? String((error as { stdout?: unknown }).stdout ?? "") : "";
    const stderrRaw = typeof error === "object" && error && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : "";
    const fallback = error instanceof Error ? error.message : String(error);
    const stderr = stderrRaw.trim() ? stderrRaw : fallback;
    return { ok: false, command, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr) };
  }
}

type SkillsCliExecOptions = {
  cwd: string;
  timeout: number;
  windowsHide: boolean;
  env: NodeJS.ProcessEnv;
};

async function runSkillsCliOnWindows(args: string[], opts: SkillsCliExecOptions): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("npx", args, {
      cwd: opts.cwd,
      timeout: opts.timeout,
      windowsHide: opts.windowsHide,
      env: opts.env,
      shell: true
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function mirrorInstalledSkillsIfCentralLayout(cwd: string): Promise<string> {
  const centralRoots = ["claude", "codex", "gemini", "cursor", "antigravity"];
  const centralReady = await Promise.all(centralRoots.map(async (name) => existsPath(path.join(cwd, name))));
  if (!centralReady.every(Boolean)) return "";

  const mappings: Array<{ from: string; to: string }> = [
    { from: path.join(cwd, ".claude", "skills"), to: path.join(cwd, "claude", "skills") },
    { from: path.join(cwd, ".codex", "skills"), to: path.join(cwd, "codex", "skills") },
    { from: path.join(cwd, ".gemini", "skills"), to: path.join(cwd, "gemini", "skills") },
    { from: path.join(cwd, ".cursor", "skills"), to: path.join(cwd, "cursor", "skills") },
    { from: path.join(cwd, ".antigravity", "skills"), to: path.join(cwd, "antigravity", "skills") }
  ];

  let copiedCount = 0;
  for (const item of mappings) {
    if (!(await existsPath(item.from))) continue;
    await fs.mkdir(item.to, { recursive: true });
    const entries = await fs.readdir(item.from, { withFileTypes: true });
    for (const entry of entries) {
      const src = path.join(item.from, entry.name);
      const dest = path.join(item.to, entry.name);
      await fs.cp(src, dest, { recursive: true, force: true, dereference: true });
      copiedCount += 1;
    }
  }

  if (copiedCount === 0) return "";
  return `중앙 레이아웃 동기화: ${copiedCount}개 항목`;
}

function joinMessages(a: string, b: string): string {
  const first = a.trim();
  const second = b.trim();
  if (first && second) return `${first}\n${second}`;
  return first || second;
}

async function copyWorkspaceToCentral(
  workspacePath: string,
  centralRepoPath: string,
  selections: Array<{ tool: ToolType; relativePath: string }>
): Promise<string[]> {
  const changedFiles: string[] = [];
  for (const selection of selections) {
    const src = resolveSkillPath(workspacePath, selection.tool, selection.relativePath, "workspace");
    const dest = resolveSkillPath(centralRepoPath, selection.tool, selection.relativePath, "central");

    if (!(await existsPath(src))) {
      throw new Error(`Workspace 파일을 찾을 수 없습니다: ${selection.tool}/${selection.relativePath}`);
    }

    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
    changedFiles.push(path.join(TOOL_PATHS[selection.tool].central, selection.relativePath));
  }
  return changedFiles;
}

async function copyCentralToWorkspace(
  centralRepoPath: string,
  workspacePath: string,
  selections: Array<{ tool: ToolType; relativePath: string }>
): Promise<string[]> {
  const changedFiles: string[] = [];
  for (const selection of selections) {
    const src = resolveSkillPath(centralRepoPath, selection.tool, selection.relativePath, "central");
    const dest = resolveSkillPath(workspacePath, selection.tool, selection.relativePath, "workspace");

    if (!(await existsPath(src))) {
      throw new Error(`Central 파일을 찾을 수 없습니다: ${selection.tool}/${selection.relativePath}`);
    }

    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
    changedFiles.push(path.join(TOOL_PATHS[selection.tool].workspace, selection.relativePath));
  }
  return changedFiles;
}

function resolveSkillPath(basePath: string, tool: ToolType, relativePath: string, source: SkillSource): string {
  const root = source === "workspace" ? TOOL_PATHS[tool].workspace : TOOL_PATHS[tool].central;
  const normalized = normalizeRelativePath(relativePath);
  assertManagedSkillRelativePath(normalized);
  if (normalized.includes("..")) throw new Error("상대 경로에 '..'은 허용되지 않습니다.");
  return path.join(basePath, root, normalized);
}

async function listGitChangedFiles(repoPath: string): Promise<string[]> {
  const out = await runGit(repoPath, ["status", "--porcelain"]);
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(3));
}

async function ensureGitRepo(repoPath: string): Promise<void> {
  if (!(await existsPath(path.join(repoPath, ".git")))) {
    throw new Error(`Git 저장소가 아닙니다: ${repoPath}`);
  }
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync("git", args, { cwd });
  if (stderr && stderr.toLowerCase().includes("fatal")) {
    throw new Error(stderr.trim());
  }
  return stdout;
}

async function runGitAllowFail(cwd: string, args: string[]): Promise<string> {
  try {
    return await runGit(cwd, args);
  } catch {
    return "";
  }
}

async function existsPath(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readIfExists(target: string): Promise<string | undefined> {
  try {
    return await fs.readFile(target, "utf8");
  } catch {
    return undefined;
  }
}

async function listGitRemotes(repoPath: string): Promise<GitRemoteInfo[]> {
  const raw = await runGit(repoPath, ["remote", "-v"]);
  const map = new Map<string, GitRemoteInfo>();

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^([^\s]+)\s+([^\s]+)\s+\((fetch|push)\)$/);
    if (!match) continue;
    const [, name, url, kind] = match;
    const current = map.get(name) ?? { name, fetchUrl: "", pushUrl: "" };
    if (kind === "fetch") current.fetchUrl = url;
    if (kind === "push") current.pushUrl = url;
    map.set(name, current);
  }

  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

type CollectFilesOptions = {
  skipDirNames?: Set<string>;
};

async function collectFiles(root: string, options?: CollectFilesOptions): Promise<string[]> {
  const out: string[] = [];
  const skipDirNames = options?.skipDirNames;
  const visitedDirs = new Set<string>();

  async function walk(current: string): Promise<void> {
    const resolvedCurrent = await fs.realpath(current).catch(() => current);
    if (visitedDirs.has(resolvedCurrent)) return;
    visitedDirs.add(resolvedCurrent);

    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (skipDirNames?.has(entry.name.toLowerCase())) {
          continue;
        }
        await walk(abs);
      } else if (entry.isSymbolicLink()) {
        const targetStat = await fs.stat(abs).catch(() => null);
        if (!targetStat) continue;
        if (targetStat.isDirectory()) {
          if (skipDirNames?.has(entry.name.toLowerCase())) {
            continue;
          }
          await walk(abs);
        } else if (targetStat.isFile()) {
          out.push(path.relative(root, abs).replace(/\\/g, "/"));
        }
      } else if (entry.isFile()) {
        out.push(path.relative(root, abs).replace(/\\/g, "/"));
      }
    }
  }

  await walk(root);
  return out;
}

async function copyDirectory(from: string, to: string): Promise<void> {
  await fs.mkdir(to, { recursive: true });
  const entries = await fs.readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(src, dst);
    } else if (entry.isFile()) {
      await fs.copyFile(src, dst);
    }
  }
}
