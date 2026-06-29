import { promises as fs } from "node:fs";
import path from "node:path";
import {
  EDITABLE_EXTENSIONS,
  INSTRUCTION_ROOT,
  INSTRUCTION_RULE_DIRS,
  NESTED_INSTRUCTION_FILES,
  ROOT_INSTRUCTION_FILES,
  SKILLS_ONLY_ERROR,
  TOOL_PATHS
} from "./constants";
import type { GitRemoteInfo, InstructionSource, SkillSource, ToolType } from "./types";

export type CollectFilesOptions = {
  skipDirNames?: Set<string>;
  containmentRoot?: string;
};

export function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

export function isManagedSkillRelativePath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath).toLowerCase();
  return normalized === "skills" || normalized.startsWith("skills/");
}

export function toSkillFolderRelativePath(relativePath: string): string | null {
  const normalized = normalizeRelativePath(relativePath);
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  if (parts[0]?.toLowerCase() !== "skills") return null;
  if (!parts[1]) return null;
  return `skills/${parts[1]}`;
}

export function collectValidSkillFiles(relativePaths: string[]): {
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

export function assertManagedSkillRelativePath(relativePath: string): void {
  if (!isManagedSkillRelativePath(relativePath)) {
    throw new Error(SKILLS_ONLY_ERROR);
  }
}

export function normalizeInstructionProfileId(profileId: string): string {
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

export function normalizeInstructionRelativePath(relativePath: string): string {
  return normalizeRelativePath(relativePath);
}

export function isManagedInstructionRelativePath(relativePath: string): boolean {
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

export function assertManagedInstructionRelativePath(relativePath: string): void {
  if (!isManagedInstructionRelativePath(relativePath)) {
    throw new Error("지원하는 instruction 파일 경로만 관리할 수 있습니다.");
  }
}

export function isEditableTextFile(relativePath: string): boolean {
  const ext = path.extname(relativePath).toLowerCase();
  if (!ext) return true;
  return EDITABLE_EXTENSIONS.has(ext);
}

export function normalizeForDiff(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export function countLines(text: string): number {
  if (!text) return 0;
  return text.replace(/\r\n/g, "\n").split("\n").length;
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function resolveInstructionPath(basePath: string, source: InstructionSource, profileId: string, relativePath: string): string {
  const normalizedProfile = normalizeInstructionProfileId(profileId);
  const normalizedRelativePath = normalizeInstructionRelativePath(relativePath);
  assertManagedInstructionRelativePath(normalizedRelativePath);

  if (source === "workspace") {
    return path.join(basePath, ...normalizedRelativePath.split("/"));
  }

  return path.join(basePath, INSTRUCTION_ROOT, normalizedProfile, ...normalizedRelativePath.split("/"));
}

export function resolveSkillPath(basePath: string, tool: ToolType, relativePath: string, source: SkillSource): string {
  const root = source === "workspace" ? TOOL_PATHS[tool].workspace : TOOL_PATHS[tool].central;
  if (hasAbsolutePathSyntax(relativePath)) throw new Error("상대 경로만 허용됩니다.");
  const normalized = normalizeRelativePath(relativePath);
  assertManagedSkillRelativePath(normalized);
  if (hasParentPathSegment(normalized)) throw new Error("상대 경로에 '..'은 허용되지 않습니다.");
  return path.join(basePath, root, normalized);
}

export function hasParentPathSegment(relativePath: string): boolean {
  return normalizeRelativePath(relativePath).split("/").includes("..");
}

export async function assertSkillFolderHasSkillMd(
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

export async function existsPath(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function readIfExists(target: string): Promise<string | undefined> {
  try {
    return await fs.readFile(target, "utf8");
  } catch {
    return undefined;
  }
}

export async function listGitRemotes(repoPath: string, runGit: (cwd: string, args: string[]) => Promise<string>): Promise<GitRemoteInfo[]> {
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

export async function collectFiles(root: string, options?: CollectFilesOptions): Promise<string[]> {
  const out: string[] = [];
  const skipDirNames = options?.skipDirNames;
  const containmentRoot = options?.containmentRoot ?? root;
  const visitedDirs = new Set<string>();

  async function walk(current: string, fromSymlink = false): Promise<void> {
    const visitKey = fromSymlink
      ? await fs.realpath(current).catch(() => path.resolve(current))
      : path.resolve(current);
    if (visitedDirs.has(visitKey)) return;
    visitedDirs.add(visitKey);

    const entries = await fs.readdir(current, { withFileTypes: true });
    const childDirs: Array<{ absolute: string; fromSymlink: boolean }> = [];
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (skipDirNames?.has(entry.name.toLowerCase())) continue;
        childDirs.push({ absolute: abs, fromSymlink: false });
      } else if (entry.isSymbolicLink()) {
        const realTarget = await fs.realpath(abs).catch(() => null);
        if (!realTarget || !isWithinPath(containmentRoot, realTarget)) continue;
        const targetStat = await fs.stat(abs).catch(() => null);
        if (!targetStat) continue;
        if (targetStat.isDirectory()) {
          if (skipDirNames?.has(entry.name.toLowerCase())) continue;
          childDirs.push({ absolute: abs, fromSymlink: true });
        } else if (targetStat.isFile()) {
          out.push(path.relative(root, abs).replace(/\\/g, "/"));
        }
      } else if (entry.isFile()) {
        out.push(path.relative(root, abs).replace(/\\/g, "/"));
      }
    }
    await mapLocalWithConcurrency(childDirs, 12, async (childDir) => {
      await walk(childDir.absolute, childDir.fromSymlink);
    });
  }

  await walk(root);
  return out;
}

export async function copyDirectory(from: string, to: string): Promise<void> {
  await fs.mkdir(to, { recursive: true });
  const entries = await fs.readdir(from, { withFileTypes: true });
  await mapLocalWithConcurrency(entries, 12, async (entry) => {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(src, dst);
    } else if (entry.isFile()) {
      await fs.copyFile(src, dst);
    }
  });
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
