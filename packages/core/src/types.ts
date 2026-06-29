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
    description?: string;
    side: "workspace" | "central";
    targets: Array<{ kind: "file" | "folder"; tool: ToolType; relativePath: string }>;
  }>;
}
