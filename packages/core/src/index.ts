import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createPatch, diffLines } from "diff";

const execFileAsync = promisify(execFile);
const GLOBAL_WORKSPACE_ID = "ws-global-default";
const GLOBAL_WORKSPACE_NAME = "Global (Home)";

export type ToolType = "claude" | "codex" | "gemini" | "cursor" | "antigravity" | "agents";
export type SkillSource = "workspace" | "central";
export type InstructionSource = "workspace" | "central";
export type SkillNodeType = "file" | "folder";
export type SkillAssetWarningCode =
  | "missing-skill-md"
  | "duplicate-name"
  | "broken-reference"
  | "sensitive-content"
  | "workspace-specific-path"
  | "script-file"
  | "target-newer";
export type SkillAssetWarningSeverity = "info" | "warning" | "danger";

export interface WorkspaceEntry {
  id: string;
  name: string;
  path: string;
  autoRefreshSeconds: number;
}

export interface AppConfig {
  centralRepo: string;
  autoPush: boolean;
  defaultTool: ToolType;
  fontSize: number;
  treeFontScale: number;
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

export interface InstructionFile {
  source: InstructionSource;
  profileId: string;
  relativePath: string;
  absolutePath: string;
  totalBytes: number;
  updatedAt: string | null;
  warnings: SkillAssetWarning[];
}

export interface InstructionInventory {
  profileId: string;
  workspace: InstructionFile[];
  central: InstructionFile[];
  supportedTargets: string[];
}

export interface InstructionTransferRequest {
  workspacePath: string;
  centralRepoPath: string;
  profileId: string;
  selections: string[];
}

export interface InstructionUpdateCandidate {
  relativePath: string;
  diff: DiffResult;
}

export interface SkillAssetWarning {
  code: SkillAssetWarningCode;
  severity: SkillAssetWarningSeverity;
  message: string;
  relativePath?: string;
}

export interface SkillAsset {
  source: SkillSource;
  tool: ToolType;
  skillName: string;
  rootRelativePath: string;
  hasManifest: boolean;
  fileCount: number;
  totalBytes: number;
  updatedAt: string | null;
  files: SkillFile[];
  warnings: SkillAssetWarning[];
}

export interface SkillAssetInventory {
  workspace: SkillAsset[];
  central: SkillAsset[];
}

export interface WorkspaceInspection {
  workspacePath: string;
  statuses: DirectoryStatus[];
  workspaceSkills: SkillFile[];
  invalidSkillFolders: Array<{ tool: ToolType; relativePath: string }>;
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
  antigravity: { workspace: ".antigravity", central: "antigravity" },
  agents: { workspace: ".agents", central: "agents" }
};

const INSTRUCTION_ROOT = "instructions";

const ROOT_INSTRUCTION_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "CODEX.md",
  "GEMINI.md",
  "CURSOR.md",
  "WINDSURF.md",
  "QWEN.md",
  "AIDER.md",
  "ROO.md",
  "JUNIE.md",
  ".cursorrules",
  ".windsurfrules",
  ".clinerules"
];

const NESTED_INSTRUCTION_FILES = [
  ".github/copilot-instructions.md"
];

const INSTRUCTION_RULE_DIRS = [
  { dir: ".cursor/rules", extensions: new Set([".mdc", ".md"]) },
  { dir: ".windsurf/rules", extensions: new Set([".md"]) }
];

const SUPPORTED_INSTRUCTION_TARGETS = [
  ...ROOT_INSTRUCTION_FILES,
  ...NESTED_INSTRUCTION_FILES,
  ".cursor/rules/*.mdc",
  ".cursor/rules/*.md",
  ".windsurf/rules/*.md"
];

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

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

function isManagedSkillRelativePath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath).toLowerCase();
  return normalized === "skills" || normalized.startsWith("skills/");
}

function toSkillFolderRelativePath(relativePath: string): string | null {
  const normalized = normalizeRelativePath(relativePath);
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  if (parts[0]?.toLowerCase() !== "skills") return null;
  if (!parts[1]) return null;
  return `skills/${parts[1]}`;
}

function collectValidSkillFiles(relativePaths: string[]): {
  validFiles: string[];
  invalidSkillFolders: string[];
} {
  const bySkillFolder = new Map<string, string[]>();
  const hasSkillMd = new Set<string>();

  for (const rel of relativePaths) {
    if (!isManagedSkillRelativePath(rel)) continue;
    const skillFolder = toSkillFolderRelativePath(rel);
    if (!skillFolder) continue;
    const normalized = normalizeRelativePath(rel);
    const bucket = bySkillFolder.get(skillFolder) ?? [];
    bucket.push(normalized);
    bySkillFolder.set(skillFolder, bucket);
    if (normalized.toLowerCase() === `${skillFolder.toLowerCase()}/skill.md`) {
      hasSkillMd.add(skillFolder);
    }
  }

  const validFiles: string[] = [];
  const invalidSkillFolders: string[] = [];
  for (const [folder, files] of bySkillFolder.entries()) {
    if (!hasSkillMd.has(folder)) {
      invalidSkillFolders.push(folder);
      continue;
    }
    validFiles.push(...files);
  }

  validFiles.sort((a, b) => a.localeCompare(b));
  invalidSkillFolders.sort((a, b) => a.localeCompare(b));
  return { validFiles, invalidSkillFolders };
}

function assertManagedSkillRelativePath(relativePath: string): void {
  if (!isManagedSkillRelativePath(relativePath)) {
    throw new Error(SKILLS_ONLY_ERROR);
  }
}

function normalizeInstructionProfileId(profileId: string): string {
  const trimmed = profileId.trim();
  const fallback = "default";
  const safe = trimmed
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "")
    .slice(0, 80);
  return safe || fallback;
}

function normalizeInstructionRelativePath(relativePath: string): string {
  return normalizeRelativePath(relativePath);
}

function isManagedInstructionRelativePath(relativePath: string): boolean {
  const normalized = normalizeInstructionRelativePath(relativePath);
  if (!normalized || normalized.includes("..") || path.isAbsolute(normalized)) return false;
  const lower = normalized.toLowerCase();
  if (ROOT_INSTRUCTION_FILES.some((item) => item.toLowerCase() === lower)) return true;
  if (NESTED_INSTRUCTION_FILES.some((item) => item.toLowerCase() === lower)) return true;

  for (const ruleDir of INSTRUCTION_RULE_DIRS) {
    const prefix = `${ruleDir.dir.toLowerCase()}/`;
    if (!lower.startsWith(prefix)) continue;
    const rest = lower.slice(prefix.length);
    if (!rest || rest.includes("/")) return false;
    return ruleDir.extensions.has(path.extname(rest).toLowerCase());
  }

  return false;
}

function assertManagedInstructionRelativePath(relativePath: string): void {
  if (!isManagedInstructionRelativePath(relativePath)) {
    throw new Error("지원하는 instruction 파일 경로만 관리할 수 있습니다.");
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
      path: item.path,
      autoRefreshSeconds: normalizeAutoRefreshSeconds(item.autoRefreshSeconds)
    }));

  const hasGlobal = hasGlobalSkillWorkspace();
  const homePath = os.homedir();
  const dedupedUser = hasGlobal
    ? userWorkspaces.filter((item) => path.resolve(item.path) !== path.resolve(homePath))
    : userWorkspaces;

  const workspaces = hasGlobal
    ? [{ id: GLOBAL_WORKSPACE_ID, name: GLOBAL_WORKSPACE_NAME, path: homePath, autoRefreshSeconds: 0 }, ...dedupedUser]
    : dedupedUser;

  const activeWorkspaceId = workspaces.some((item) => item.id === input.activeWorkspaceId)
    ? input.activeWorkspaceId!
    : workspaces[0]?.id ?? null;

  return {
    centralRepo: input.centralRepo?.trim() || defaultCentral,
    autoPush: input.autoPush ?? true,
    defaultTool: input.defaultTool ?? "claude",
    fontSize: Math.max(11, Math.min(22, input.fontSize ?? 15)),
    treeFontScale: normalizeTreeFontScale(input.treeFontScale),
    workspaces,
    activeWorkspaceId
  };
}

function normalizeAutoRefreshSeconds(value: unknown): number {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return 0;
  const integer = Math.floor(raw);
  if (integer < 0) return 0;
  if (integer > 3600) return 3600;
  return integer;
}

function normalizeTreeFontScale(value: unknown): number {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return 1;
  if (raw < 0.85) return 0.85;
  if (raw > 1.2) return 1.2;
  return Math.round(raw * 100) / 100;
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
  const invalidSkillFolders: Array<{ tool: ToolType; relativePath: string }> = [];
  const isGlobalWorkspace = path.resolve(workspacePath) === path.resolve(os.homedir());

  for (const tool of Object.keys(TOOL_PATHS) as ToolType[]) {
    const dir = path.join(workspacePath, TOOL_PATHS[tool].workspace);
    const exists = await existsPath(dir);
    statuses.push({ tool, workspaceDir: dir, exists });

    if (exists) {
      const files = await collectFiles(dir, {
        skipDirNames: isGlobalWorkspace ? GLOBAL_IGNORED_DIR_NAMES : undefined
      });
      const valid = collectValidSkillFiles(files);
      for (const relativePath of valid.validFiles) {
        workspaceSkills.push({ tool, relativePath, absolutePath: path.join(dir, relativePath) });
      }
      for (const relativePath of valid.invalidSkillFolders) {
        invalidSkillFolders.push({ tool, relativePath });
      }
    }
  }

  workspaceSkills.sort((a, b) => a.tool.localeCompare(b.tool) || a.relativePath.localeCompare(b.relativePath));
  invalidSkillFolders.sort((a, b) => a.tool.localeCompare(b.tool) || a.relativePath.localeCompare(b.relativePath));
  return { workspacePath, statuses, workspaceSkills, invalidSkillFolders };
}

export async function listCentralSkills(centralRepoPath: string): Promise<SkillFile[]> {
  const output: SkillFile[] = [];

  for (const tool of Object.keys(TOOL_PATHS) as ToolType[]) {
    const dir = path.join(centralRepoPath, TOOL_PATHS[tool].central);
    if (!(await existsPath(dir))) continue;
    const files = await collectFiles(dir);
    const valid = collectValidSkillFiles(files);
    for (const relativePath of valid.validFiles) {
      output.push({ tool, relativePath, absolutePath: path.join(dir, relativePath) });
    }
  }

  output.sort((a, b) => a.tool.localeCompare(b.tool) || a.relativePath.localeCompare(b.relativePath));
  return output;
}

export async function listWorkspaceSkillAssets(workspacePath: string): Promise<SkillAsset[]> {
  return collectSkillAssets(workspacePath, "workspace");
}

export async function listCentralSkillAssets(centralRepoPath: string): Promise<SkillAsset[]> {
  return collectSkillAssets(centralRepoPath, "central");
}

export async function buildSkillAssetInventory(workspacePath: string, centralRepoPath: string): Promise<SkillAssetInventory> {
  const [workspace, central] = await Promise.all([
    listWorkspaceSkillAssets(workspacePath),
    listCentralSkillAssets(centralRepoPath)
  ]);
  addCrossInventoryWarnings(workspace, central);
  return { workspace, central };
}

async function collectSkillAssets(basePath: string, source: SkillSource): Promise<SkillAsset[]> {
  const assets: SkillAsset[] = [];
  const isGlobalWorkspace = source === "workspace" && path.resolve(basePath) === path.resolve(os.homedir());

  for (const tool of Object.keys(TOOL_PATHS) as ToolType[]) {
    const rootName = source === "workspace" ? TOOL_PATHS[tool].workspace : TOOL_PATHS[tool].central;
    const root = path.join(basePath, rootName);
    if (!(await existsPath(root))) continue;

    const files = await collectFiles(root, {
      skipDirNames: isGlobalWorkspace ? GLOBAL_IGNORED_DIR_NAMES : undefined
    });
    const byFolder = new Map<string, string[]>();
    for (const relativePath of files) {
      const folder = toSkillFolderRelativePath(relativePath);
      if (!folder) continue;
      const bucket = byFolder.get(folder) ?? [];
      bucket.push(normalizeRelativePath(relativePath));
      byFolder.set(folder, bucket);
    }

    for (const [folder, folderFiles] of byFolder.entries()) {
      assets.push(await buildSkillAsset(basePath, source, tool, folder, folderFiles));
    }
  }

  addDuplicateNameWarnings(assets);
  return assets.sort((a, b) => (
    a.tool.localeCompare(b.tool) || a.rootRelativePath.localeCompare(b.rootRelativePath)
  ));
}

async function buildSkillAsset(
  basePath: string,
  source: SkillSource,
  tool: ToolType,
  rootRelativePath: string,
  relativePaths: string[]
): Promise<SkillAsset> {
  let totalBytes = 0;
  let latestMtime = 0;
  const files: SkillFile[] = [];
  const warnings: SkillAssetWarning[] = [];
  const sorted = [...relativePaths].sort((a, b) => a.localeCompare(b));
  const hasManifest = sorted.some((rel) => normalizeRelativePath(rel).toLowerCase() === `${rootRelativePath.toLowerCase()}/skill.md`);

  if (!hasManifest) {
    warnings.push({
      code: "missing-skill-md",
      severity: "danger",
      message: "SKILL.md가 없어 Skill Bridge 전송 대상에서 제외될 수 있습니다.",
      relativePath: rootRelativePath
    });
  }

  for (const relativePath of sorted) {
    const absolutePath = resolveSkillPath(basePath, tool, relativePath, source);
    const stat = await fs.stat(absolutePath).catch(() => null);
    if (!stat?.isFile()) continue;
    totalBytes += stat.size;
    latestMtime = Math.max(latestMtime, stat.mtimeMs);
    files.push({ tool, relativePath, absolutePath });
    warnings.push(...await analyzeSkillAssetFile(absolutePath, relativePath, rootRelativePath, sorted));
  }

  return {
    source,
    tool,
    skillName: rootRelativePath.split("/")[1] ?? rootRelativePath,
    rootRelativePath,
    hasManifest,
    fileCount: files.length,
    totalBytes,
    updatedAt: latestMtime > 0 ? new Date(latestMtime).toISOString() : null,
    files,
    warnings: dedupeAssetWarnings(warnings)
  };
}

async function analyzeSkillAssetFile(
  absolutePath: string,
  relativePath: string,
  rootRelativePath: string,
  allRelativePaths: string[]
): Promise<SkillAssetWarning[]> {
  const warnings: SkillAssetWarning[] = [];
  const normalized = normalizeRelativePath(relativePath);
  const ext = path.extname(normalized).toLowerCase();

  if (isScriptLikePath(normalized)) {
    warnings.push({
      code: "script-file",
      severity: "warning",
      message: "실행 스크립트가 포함되어 전송 전 의도 확인이 필요합니다.",
      relativePath: normalized
    });
  }

  if (!isEditableTextFile(normalized)) return warnings;

  const text = await readIfExists(absolutePath);
  if (text === undefined) return warnings;

  if (scanSensitiveContent(text).length > 0) {
    warnings.push({
      code: "sensitive-content",
      severity: "danger",
      message: "민감정보로 보일 수 있는 문자열이 포함되어 있습니다.",
      relativePath: normalized
    });
  }
  if (containsWorkspaceSpecificPath(text)) {
    warnings.push({
      code: "workspace-specific-path",
      severity: "warning",
      message: "로컬 절대경로로 보이는 문자열이 포함되어 다른 workspace에서 깨질 수 있습니다.",
      relativePath: normalized
    });
  }
  if (ext === ".md") {
    warnings.push(...findBrokenMarkdownReferenceWarnings(text, normalized, rootRelativePath, allRelativePaths));
  }

  return warnings;
}

function findBrokenMarkdownReferenceWarnings(
  text: string,
  fileRelativePath: string,
  rootRelativePath: string,
  allRelativePaths: string[]
): SkillAssetWarning[] {
  const warnings: SkillAssetWarning[] = [];
  const known = new Set(allRelativePaths.map((item) => normalizeRelativePath(item).toLowerCase()));
  const parent = path.posix.dirname(fileRelativePath);
  const regex = /\[[^\]]+\]\(([^)]+)\)/g;
  let match = regex.exec(text);
  while (match) {
    const raw = (match[1] ?? "").trim().replace(/^['"]|['"]$/g, "");
    const target = raw.split("#")[0]?.trim() ?? "";
    if (target && !/^(https?:|mailto:|#|data:)/i.test(target) && !target.includes("://")) {
      const normalizedTarget = normalizeRelativePath(path.posix.normalize(path.posix.join(parent, target)));
      if (normalizedTarget.startsWith(`${rootRelativePath}/`) && !known.has(normalizedTarget.toLowerCase())) {
        warnings.push({
          code: "broken-reference",
          severity: "warning",
          message: `상대 링크 대상이 스킬 폴더 안에 없습니다: ${target}`,
          relativePath: fileRelativePath
        });
      }
    }
    match = regex.exec(text);
  }
  return warnings;
}

function addDuplicateNameWarnings(assets: SkillAsset[]): void {
  const byName = new Map<string, SkillAsset[]>();
  for (const asset of assets) {
    const key = asset.skillName.toLowerCase();
    const bucket = byName.get(key) ?? [];
    bucket.push(asset);
    byName.set(key, bucket);
  }
  for (const bucket of byName.values()) {
    const tools = [...new Set(bucket.map((asset) => asset.tool))];
    if (tools.length < 2) continue;
    for (const asset of bucket) {
      asset.warnings = dedupeAssetWarnings([
        ...asset.warnings,
        {
          code: "duplicate-name",
          severity: "info",
          message: `같은 이름의 스킬이 여러 에이전트에 있습니다: ${tools.join(", ")}`,
          relativePath: asset.rootRelativePath
        }
      ]);
    }
  }
}

function addCrossInventoryWarnings(workspace: SkillAsset[], central: SkillAsset[]): void {
  const centralByKey = new Map(central.map((asset) => [`${asset.tool}:${asset.rootRelativePath}`, asset] as const));
  const workspaceByKey = new Map(workspace.map((asset) => [`${asset.tool}:${asset.rootRelativePath}`, asset] as const));
  for (const asset of workspace) {
    addTargetNewerWarning(asset, centralByKey.get(`${asset.tool}:${asset.rootRelativePath}`), "central");
  }
  for (const asset of central) {
    addTargetNewerWarning(asset, workspaceByKey.get(`${asset.tool}:${asset.rootRelativePath}`), "workspace");
  }
}

function addTargetNewerWarning(asset: SkillAsset, counterpart: SkillAsset | undefined, counterpartLabel: SkillSource): void {
  if (!asset.updatedAt || !counterpart?.updatedAt) return;
  const assetTime = Date.parse(asset.updatedAt);
  const counterpartTime = Date.parse(counterpart.updatedAt);
  if (!Number.isFinite(assetTime) || !Number.isFinite(counterpartTime)) return;
  if (counterpartTime <= assetTime) return;
  asset.warnings = dedupeAssetWarnings([
    ...asset.warnings,
    {
      code: "target-newer",
      severity: "warning",
      message: `반대편 ${counterpartLabel} 스킬이 더 최신입니다.`,
      relativePath: asset.rootRelativePath
    }
  ]);
}

function dedupeAssetWarnings(warnings: SkillAssetWarning[]): SkillAssetWarning[] {
  const unique = new Map<string, SkillAssetWarning>();
  for (const warning of warnings) {
    unique.set(`${warning.code}:${warning.relativePath ?? ""}:${warning.message}`, warning);
  }
  return [...unique.values()];
}

function isScriptLikePath(relativePath: string): boolean {
  return /\.(ps1|bat|cmd|sh|bash|zsh|fish|js|mjs|cjs|ts|tsx|py|rb|pl)$/i.test(relativePath);
}

function containsWorkspaceSpecificPath(text: string): boolean {
  return /(?:[A-Za-z]:\\Users\\|[A-Za-z]:\\[^ \n\r\t]+|\/Users\/|\/home\/)/.test(text);
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
  await fs.mkdir(path.join(centralRepoPath, INSTRUCTION_ROOT), { recursive: true });
}

export async function buildInstructionInventory(
  workspacePath: string,
  centralRepoPath: string,
  profileId: string
): Promise<InstructionInventory> {
  const normalizedProfile = normalizeInstructionProfileId(profileId);
  const [workspace, central] = await Promise.all([
    listWorkspaceInstructionFiles(workspacePath, normalizedProfile),
    listCentralInstructionFiles(centralRepoPath, normalizedProfile)
  ]);
  return {
    profileId: normalizedProfile,
    workspace,
    central,
    supportedTargets: [...SUPPORTED_INSTRUCTION_TARGETS]
  };
}

export async function listWorkspaceInstructionFiles(workspacePath: string, profileId: string): Promise<InstructionFile[]> {
  const normalizedProfile = normalizeInstructionProfileId(profileId);
  const relativePaths = await discoverWorkspaceInstructionRelativePaths(workspacePath);
  const files = await Promise.all(
    relativePaths.map((relativePath) => buildInstructionFile(workspacePath, "workspace", normalizedProfile, relativePath))
  );
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export async function listCentralInstructionFiles(centralRepoPath: string, profileId: string): Promise<InstructionFile[]> {
  const normalizedProfile = normalizeInstructionProfileId(profileId);
  const profileRoot = path.join(centralRepoPath, INSTRUCTION_ROOT, normalizedProfile);
  if (!(await existsPath(profileRoot))) return [];

  const relativePaths = (await collectFiles(profileRoot))
    .map(normalizeInstructionRelativePath)
    .filter(isManagedInstructionRelativePath);
  const files = await Promise.all(
    relativePaths.map((relativePath) => buildInstructionFile(centralRepoPath, "central", normalizedProfile, relativePath))
  );
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export async function compareInstruction(
  workspacePath: string,
  centralRepoPath: string,
  profileId: string,
  relativePath: string,
  mode: "promote" | "import"
): Promise<DiffResult> {
  const normalizedProfile = normalizeInstructionProfileId(profileId);
  const normalizedRelativePath = normalizeInstructionRelativePath(relativePath);
  assertManagedInstructionRelativePath(normalizedRelativePath);

  const workspaceFile = resolveInstructionPath(workspacePath, "workspace", normalizedProfile, normalizedRelativePath);
  const centralFile = resolveInstructionPath(centralRepoPath, "central", normalizedProfile, normalizedRelativePath);
  const workspaceText = await readIfExists(workspaceFile);
  const centralText = await readIfExists(centralFile);

  if (mode === "promote") {
    if (workspaceText === undefined) throw new Error(`Workspace instruction 파일을 찾을 수 없습니다: ${normalizedRelativePath}`);
    return buildDiff(centralText ?? "", workspaceText, `instructions/${normalizedProfile}/${normalizedRelativePath}`);
  }

  if (centralText === undefined) throw new Error(`Central instruction 파일을 찾을 수 없습니다: ${normalizedProfile}/${normalizedRelativePath}`);
  return buildDiff(workspaceText ?? "", centralText, `instructions/${normalizedProfile}/${normalizedRelativePath}`);
}

export async function promoteInstructions(req: InstructionTransferRequest): Promise<{ changedFiles: string[] }> {
  const changedFiles = await copyInstructions(req.workspacePath, req.centralRepoPath, req.profileId, req.selections, "promote");
  return { changedFiles };
}

export async function importInstructions(req: InstructionTransferRequest): Promise<{ changedFiles: string[] }> {
  const changedFiles = await copyInstructions(req.workspacePath, req.centralRepoPath, req.profileId, req.selections, "import");
  return { changedFiles };
}

export async function findInstructionUpdateCandidates(
  workspacePath: string,
  centralRepoPath: string,
  profileId: string
): Promise<InstructionUpdateCandidate[]> {
  const normalizedProfile = normalizeInstructionProfileId(profileId);
  const [workspace, central] = await Promise.all([
    listWorkspaceInstructionFiles(workspacePath, normalizedProfile),
    listCentralInstructionFiles(centralRepoPath, normalizedProfile)
  ]);
  const workspaceKeys = new Set(workspace.map((item) => item.relativePath));
  const candidates: InstructionUpdateCandidate[] = [];

  for (const item of central) {
    if (!workspaceKeys.has(item.relativePath)) continue;
    const diff = await compareInstruction(workspacePath, centralRepoPath, normalizedProfile, item.relativePath, "import");
    if (diff.hasChanges) candidates.push({ relativePath: item.relativePath, diff });
  }

  return candidates.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export async function buildDiff(oldText: string, newText: string, label = "skill.md"): Promise<DiffResult> {
  const oldNormalized = normalizeForDiff(oldText);
  const newNormalized = normalizeForDiff(newText);
  const hasChanges = oldNormalized !== newNormalized;
  return {
    hasChanges,
    oldText,
    newText,
    unifiedDiff: hasChanges ? createPatch(label, oldNormalized, newNormalized, "before", "after", { context: 3 }) : ""
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
  if (mode === "promote") {
    await assertSkillFolderHasSkillMd(workspacePath, tool, relativePath, "workspace");
    await assertSkillFolderHasSkillMd(centralRepoPath, tool, relativePath, "central", true);
  } else {
    await assertSkillFolderHasSkillMd(centralRepoPath, tool, relativePath, "central");
    await assertSkillFolderHasSkillMd(workspacePath, tool, relativePath, "workspace", true);
  }
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
    const lines = diffLines(ce, ws);
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
  await fs.mkdir(path.join(cwd, "agents"), { recursive: true });

  const mappings: Array<{ from: string; to: string }> = [
    { from: path.join(cwd, ".claude", "skills"), to: path.join(cwd, "claude", "skills") },
    { from: path.join(cwd, ".codex", "skills"), to: path.join(cwd, "codex", "skills") },
    { from: path.join(cwd, ".gemini", "skills"), to: path.join(cwd, "gemini", "skills") },
    { from: path.join(cwd, ".cursor", "skills"), to: path.join(cwd, "cursor", "skills") },
    { from: path.join(cwd, ".antigravity", "skills"), to: path.join(cwd, "antigravity", "skills") },
    { from: path.join(cwd, ".agents", "skills"), to: path.join(cwd, "agents", "skills") }
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

async function discoverWorkspaceInstructionRelativePaths(workspacePath: string): Promise<string[]> {
  const found = new Set<string>();

  for (const relativePath of [...ROOT_INSTRUCTION_FILES, ...NESTED_INSTRUCTION_FILES]) {
    const normalized = normalizeInstructionRelativePath(relativePath);
    const target = path.join(workspacePath, ...normalized.split("/"));
    if (await existsPath(target)) found.add(normalized);
  }

  for (const ruleDir of INSTRUCTION_RULE_DIRS) {
    const dir = path.join(workspacePath, ...ruleDir.dir.split("/"));
    if (!(await existsPath(dir))) continue;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!ruleDir.extensions.has(ext)) continue;
      const relativePath = normalizeInstructionRelativePath(path.posix.join(ruleDir.dir, entry.name));
      found.add(relativePath);
    }
  }

  return [...found].sort((a, b) => a.localeCompare(b));
}

async function buildInstructionFile(
  basePath: string,
  source: InstructionSource,
  profileId: string,
  relativePath: string
): Promise<InstructionFile> {
  const target = resolveInstructionPath(basePath, source, profileId, relativePath);
  const stat = await fs.stat(target).catch(() => null);
  const text = isEditableTextFile(relativePath) ? await readIfExists(target) : undefined;
  const warnings: SkillAssetWarning[] = [];
  if (text !== undefined) {
    if (scanSensitiveContent(text).length > 0) {
      warnings.push({
        code: "sensitive-content",
        severity: "danger",
        message: "민감정보로 보일 수 있는 문자열이 포함되어 있습니다.",
        relativePath
      });
    }
    if (containsWorkspaceSpecificPath(text)) {
      warnings.push({
        code: "workspace-specific-path",
        severity: "warning",
        message: "로컬 절대경로로 보이는 문자열이 포함되어 다른 workspace에서 깨질 수 있습니다.",
        relativePath
      });
    }
  }

  return {
    source,
    profileId,
    relativePath,
    absolutePath: target,
    totalBytes: stat?.isFile() ? stat.size : 0,
    updatedAt: stat?.isFile() ? new Date(stat.mtimeMs).toISOString() : null,
    warnings: dedupeAssetWarnings(warnings)
  };
}

async function copyInstructions(
  workspacePath: string,
  centralRepoPath: string,
  profileId: string,
  selections: string[],
  mode: "promote" | "import"
): Promise<string[]> {
  const normalizedProfile = normalizeInstructionProfileId(profileId);
  const changedFiles: string[] = [];

  for (const selection of selections) {
    const relativePath = normalizeInstructionRelativePath(selection);
    assertManagedInstructionRelativePath(relativePath);

    const src = mode === "promote"
      ? resolveInstructionPath(workspacePath, "workspace", normalizedProfile, relativePath)
      : resolveInstructionPath(centralRepoPath, "central", normalizedProfile, relativePath);
    const dest = mode === "promote"
      ? resolveInstructionPath(centralRepoPath, "central", normalizedProfile, relativePath)
      : resolveInstructionPath(workspacePath, "workspace", normalizedProfile, relativePath);

    if (!(await existsPath(src))) {
      const sourceLabel = mode === "promote" ? "Workspace" : "Central";
      throw new Error(`${sourceLabel} instruction 파일을 찾을 수 없습니다: ${relativePath}`);
    }

    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
    changedFiles.push(mode === "promote"
      ? path.join(INSTRUCTION_ROOT, normalizedProfile, relativePath)
      : relativePath);
  }

  return changedFiles;
}

function resolveInstructionPath(basePath: string, source: InstructionSource, profileId: string, relativePath: string): string {
  const normalizedProfile = normalizeInstructionProfileId(profileId);
  const normalizedRelativePath = normalizeInstructionRelativePath(relativePath);
  assertManagedInstructionRelativePath(normalizedRelativePath);

  if (source === "workspace") {
    return path.join(basePath, ...normalizedRelativePath.split("/"));
  }

  return path.join(basePath, INSTRUCTION_ROOT, normalizedProfile, ...normalizedRelativePath.split("/"));
}

async function copyWorkspaceToCentral(
  workspacePath: string,
  centralRepoPath: string,
  selections: Array<{ tool: ToolType; relativePath: string }>
): Promise<string[]> {
  const changedFiles: string[] = [];
  for (const selection of selections) {
    await assertSkillFolderHasSkillMd(workspacePath, selection.tool, selection.relativePath, "workspace");
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
    await assertSkillFolderHasSkillMd(centralRepoPath, selection.tool, selection.relativePath, "central");
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

async function assertSkillFolderHasSkillMd(
  basePath: string,
  tool: ToolType,
  relativePath: string,
  source: SkillSource,
  allowMissingFolder = false
): Promise<void> {
  const skillFolder = toSkillFolderRelativePath(relativePath);
  if (!skillFolder) {
    throw new Error("유효 스킬 경로만 처리할 수 있습니다. (skills/<skill>/...)");
  }
  const skillMdPath = resolveSkillPath(basePath, tool, `${skillFolder}/SKILL.md`, source);
  const exists = await existsPath(skillMdPath);
  if (exists) return;
  if (allowMissingFolder) {
    const skillFolderPath = resolveSkillPath(basePath, tool, skillFolder, source);
    if (!(await existsPath(skillFolderPath))) return;
  }
  throw new Error(`SKILL.md가 없는 스킬은 처리할 수 없습니다: ${tool}/${skillFolder}`);
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
