import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { collectFiles as collectCoreFiles } from "./vendor/core";
import type { SkillTreeNode, ToolType } from "./types";

export const INSTRUCTION_ROOT = "instructions";
export const ROOT_INSTRUCTION_FILES = [
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
export const NESTED_INSTRUCTION_FILES = [
  ".github/copilot-instructions.md"
];
export const INSTRUCTION_RULE_DIRS = [
  { dir: ".cursor/rules", extensions: new Set([".mdc", ".md"]) },
  { dir: ".windsurf/rules", extensions: new Set([".md"]) }
];

export type FolderEntryRow = { relativePath: string; size: number; mtime: string };
export type FolderDiffStatus = "A" | "D" | "M" | "=";
export type FolderDiffRow = {
  relativePath: string;
  status: FolderDiffStatus;
  sourceSize: number | null;
  targetSize: number | null;
  sourceMtime: string | null;
  targetMtime: string | null;
};

export function normalizeRepoName(raw: string): string {
  const cleaned = raw.replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").trim();
  return cleaned || "skills-installed";
}

export function getSkillRoot(basePath: string, tool: ToolType, mode: "workspace" | "central"): string {
  const roots = getSkillRootCandidates(basePath, tool, mode);
  for (const candidate of roots) {
    if (existsSync(candidate)) return candidate;
  }
  return roots[0];
}

export function getWritableSkillRoot(basePath: string, tool: ToolType, mode: "workspace" | "central"): string {
  return getPrimarySkillRoot(basePath, tool, mode);
}

export function getSkillRootCandidates(basePath: string, tool: ToolType, mode: "workspace" | "central"): string[] {
  const primary = getPrimarySkillRoot(basePath, tool, mode);
  const dotted = tool === "agents" ? ".agents" : `.${tool}`;
  const plain = tool;
  const secondary = mode === "workspace"
    ? path.join(basePath, plain)
    : path.join(basePath, dotted);
  return [...new Set([primary, secondary])];
}

export function resolveSkillPath(basePath: string, tool: ToolType, relativePath: string, mode: "workspace" | "central"): string {
  if (hasAbsolutePathSyntax(relativePath)) throw new Error("skills 하위 상대 경로만 허용됩니다.");
  const normalized = normalizeRel(relativePath);
  if (!isManagedSkillPath(normalized) || normalized.includes("..")) {
    throw new Error("skills 하위 경로만 허용됩니다.");
  }
  return path.join(getSkillRoot(basePath, tool, mode), normalized);
}

export function suggestInstructionProfile(workspacePath: string): string {
  const name = path.basename(path.resolve(workspacePath || "."));
  return sanitizeInstructionProfileName(name);
}

export function sanitizeInstructionProfileName(value: string): string {
  const safe = value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "")
    .slice(0, 80);
  return safe || "default";
}

export function normalizeInstructionRelativePath(relativePath: string): string {
  return normalizeRel(relativePath);
}

export function isManagedInstructionPath(relativePath: string): boolean {
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

export function resolveWorkspaceInstructionPath(workspacePath: string, relativePath: string): string {
  const normalized = normalizeInstructionRelativePath(relativePath);
  if (!isManagedInstructionPath(normalized)) throw new Error("지원하는 instruction 파일 경로만 허용됩니다.");
  return path.join(workspacePath, ...normalized.split("/"));
}

export function resolveCentralInstructionPath(centralRepoPath: string, profileId: string, relativePath: string): string {
  const normalized = normalizeInstructionRelativePath(relativePath);
  if (!isManagedInstructionPath(normalized)) throw new Error("지원하는 instruction 파일 경로만 허용됩니다.");
  return path.join(centralRepoPath, INSTRUCTION_ROOT, sanitizeInstructionProfileName(profileId), ...normalized.split("/"));
}

export function resolveOpenFolderTarget(
  basePath: string,
  mode: "workspace" | "central",
  node?: SkillTreeNode
): string {
  if (!node || (node.kind !== "file" && node.kind !== "folder")) {
    return basePath;
  }

  const normalized = normalizeRel(node.relativePath);
  if (!normalized) {
    return getSkillRoot(basePath, node.tool, mode);
  }
  return resolveSkillPath(basePath, node.tool, normalized, mode);
}

export async function collectFiles(root: string, basePath: string): Promise<string[]> {
  return collectCoreFiles(root, { containmentRoot: basePath });
}

export async function collectScopeEntries(
  toolRoot: string,
  scopeRelativePath: string,
  scopeKind: "file" | "folder"
): Promise<Map<string, { relativePath: string; absolutePath: string; kind: "file" | "folder"; mtime: string | null; size: number | null }>> {
  const result = new Map<string, { relativePath: string; absolutePath: string; kind: "file" | "folder"; mtime: string | null; size: number | null }>();
  const scopePath = path.join(toolRoot, scopeRelativePath);
  if (!(await exists(scopePath))) return result;

  const add = async (relativePath: string, absolutePath: string, kind: "file" | "folder"): Promise<void> => {
    const stat = await fs.stat(absolutePath).catch(() => null);
    result.set(relativePath, {
      relativePath,
      absolutePath,
      kind,
      mtime: stat ? stat.mtime.toISOString() : null,
      size: kind === "file" && stat ? stat.size : null
    });
  };

  const walk = async (dirPath: string, relPath: string): Promise<void> => {
    await add(relPath, dirPath, "folder");
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const childDirs: Array<{ absolute: string; relativePath: string }> = [];
    for (const entry of entries) {
      const absolute = path.join(dirPath, entry.name);
      const childRel = normalizeRel(path.posix.join(relPath, entry.name));
      if (!isManagedSkillPath(childRel)) continue;
      if (entry.isDirectory()) {
        childDirs.push({ absolute, relativePath: childRel });
      } else if (entry.isFile()) {
        await add(childRel, absolute, "file");
      }
    }
    await mapLocalWithConcurrency(childDirs, 12, async (child) => {
      await walk(child.absolute, child.relativePath);
    });
  };

  const scopeStat = await fs.stat(scopePath).catch(() => null);
  if (!scopeStat) return result;
  if (scopeKind === "file" || scopeStat.isFile()) {
    await add(normalizeRel(scopeRelativePath), scopePath, "file");
    return result;
  }
  await walk(scopePath, normalizeRel(scopeRelativePath));
  return result;
}

export async function collectFolderEntryRows(folderPath: string): Promise<FolderEntryRow[]> {
  if (!(await exists(folderPath))) return [];
  const rows: FolderEntryRow[] = [];
  const walk = async (dirPath: string): Promise<void> => {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        const stat = await fs.stat(absolute);
        rows.push({
          relativePath: path.relative(folderPath, absolute).replace(/\\/g, "/"),
          size: stat.size,
          mtime: stat.mtime.toISOString()
        });
      }
    }
  };
  await walk(folderPath);
  rows.sort((a, b) => {
    const aSkill = /(^|\/)SKILL\.md$/i.test(a.relativePath) ? 0 : 1;
    const bSkill = /(^|\/)SKILL\.md$/i.test(b.relativePath) ? 0 : 1;
    if (aSkill !== bSkill) return aSkill - bSkill;
    return a.relativePath.localeCompare(b.relativePath);
  });
  return rows;
}

export function buildFolderDiffRows(sourceRows: FolderEntryRow[], targetRows: FolderEntryRow[]): FolderDiffRow[] {
  const sourceMap = new Map<string, FolderEntryRow>();
  const targetMap = new Map<string, FolderEntryRow>();
  for (const row of sourceRows) {
    sourceMap.set(row.relativePath, row);
  }
  for (const row of targetRows) {
    targetMap.set(row.relativePath, row);
  }

  const allPaths = new Set<string>([...sourceMap.keys(), ...targetMap.keys()]);
  const rows: FolderDiffRow[] = [];
  for (const relativePath of allPaths) {
    const sourceRow = sourceMap.get(relativePath);
    const targetRow = targetMap.get(relativePath);
    let status: FolderDiffStatus = "=";

    if (sourceRow && !targetRow) status = "A";
    else if (!sourceRow && targetRow) status = "D";
    else if (sourceRow && targetRow && (sourceRow.size !== targetRow.size || sourceRow.mtime !== targetRow.mtime)) status = "M";

    rows.push({
      relativePath,
      status,
      sourceSize: sourceRow?.size ?? null,
      targetSize: targetRow?.size ?? null,
      sourceMtime: sourceRow?.mtime ?? null,
      targetMtime: targetRow?.mtime ?? null
    });
  }

  rows.sort((a, b) => {
    const aSkill = /(^|\/)SKILL\.md$/i.test(a.relativePath) ? 0 : 1;
    const bSkill = /(^|\/)SKILL\.md$/i.test(b.relativePath) ? 0 : 1;
    if (aSkill !== bSkill) return aSkill - bSkill;
    if (a.status !== b.status) {
      const order: Record<FolderDiffStatus, number> = { A: 0, M: 1, D: 2, "=": 3 };
      return order[a.status] - order[b.status];
    }
    return a.relativePath.localeCompare(b.relativePath);
  });
  return rows;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function getPrimarySkillRoot(basePath: string, tool: ToolType, mode: "workspace" | "central"): string {
  const dotted = tool === "agents" ? ".agents" : `.${tool}`;
  const plain = tool;
  return mode === "workspace"
    ? path.join(basePath, dotted)
    : path.join(basePath, plain);
}

function normalizeRel(value: string | undefined | null): string {
  if (!value) return "";
  return value.replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

function isManagedSkillPath(value: string): boolean {
  const normalized = normalizeRel(value).toLowerCase();
  return normalized === "skills" || normalized.startsWith("skills/");
}

function isWithinPath(basePath: string, target: string): boolean {
  const base = normalizePathForContainment(basePath);
  const resolved = normalizePathForContainment(target);
  const relative = path.relative(base, resolved);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function hasAbsolutePathSyntax(value: string): boolean {
  return path.isAbsolute(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

function normalizePathForContainment(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function mapLocalWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  mapper: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  if (items.length === 1) {
    await mapper(items[0] as T);
    return;
  }

  const cappedLimit = Math.max(1, Math.min(limit, items.length));
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await mapper(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: cappedLimit }, () => worker()));
}
