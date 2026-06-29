import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createPatch, diffLines } from "diff";
import {
  GLOBAL_IGNORED_DIR_NAMES,
  INSTRUCTION_ROOT,
  INSTRUCTION_RULE_DIRS,
  NESTED_INSTRUCTION_FILES,
  ROOT_INSTRUCTION_FILES,
  SENSITIVE_RULES,
  SUPPORTED_INSTRUCTION_TARGETS,
  TOOL_PATHS,
} from "./constants";
import {
  assertManagedInstructionRelativePath,
  assertManagedSkillRelativePath,
  assertSkillFolderHasSkillMd,
  byteLength,
  collectFiles,
  collectValidSkillFiles,
  copyDirectory,
  countLines,
  existsPath,
  isEditableTextFile,
  isManagedInstructionRelativePath,
  normalizeForDiff,
  normalizeInstructionProfileId,
  normalizeInstructionRelativePath,
  normalizeRelativePath,
  readIfExists,
  resolveInstructionPath,
  resolveSkillPath,
  toSkillFolderRelativePath,
} from "./shared";
import type {
  DiffResult,
  DirectoryStatus,
  FileDiffStats,
  ImportRequest,
  InstructionFile,
  InstructionInventory,
  InstructionSource,
  InstructionTransferRequest,
  InstructionUpdateCandidate,
  PromoteRequest,
  SensitiveWarning,
  SkillAsset,
  SkillAssetInventory,
  SkillAssetWarning,
  SkillFile,
  SkillNodeType,
  SkillSource,
  ToolType,
  UpdateCandidate,
  ValidateTargetResult,
  WorkspaceCentralOverview,
  WorkspaceInspection,
} from "./types";

export { getConfigPath, loadConfig, saveConfig } from "./config";
export { checkCentralRepo, getGitDiagnostics, initializeCentralRepo, syncCentralRepo, testGitRemote } from "./git";
export { collectFiles, copyDirectory, isEditableTextFile } from "./shared";
export { runSkillsCli } from "./skillsCli";
export * from "./storagePaths";
export { loadWorkspaceGroupFile, saveWorkspaceGroupFile } from "./workspaceGroups";
export type * from "./types";

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
  return /(?:[A-Za-z]:[\\/][^ \n\r\t]+|\/(?:Users|home|Volumes)\/[^ \n\r\t]+)/.test(text);
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
