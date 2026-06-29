import { promises as fs } from "node:fs";
import path from "node:path";
import { collectFiles, getSkillRootCandidates } from "./skillPaths";
import type { SkillFile, ToolType } from "./types";

const AGENT_SCAN_CONCURRENCY = 3;

export async function scanSkillFiles(basePath: string, mode: "workspace" | "central", agents: ToolType[]): Promise<SkillFile[]> {
  const files = (await mapWithConcurrency(agents, AGENT_SCAN_CONCURRENCY, async (tool) => scanToolSkillFiles(basePath, mode, tool))).flat();
  return files.sort((a, b) => a.tool.localeCompare(b.tool) || a.relativePath.localeCompare(b.relativePath));
}

async function scanToolSkillFiles(basePath: string, mode: "workspace" | "central", tool: ToolType): Promise<SkillFile[]> {
  const files: SkillFile[] = [];
  const candidates = getSkillRootCandidates(basePath, tool, mode);
  const roots = await existingManagedSkillRoots(candidates);
  const seen = new Set<string>();
  for (const root of roots) {
    const relativePaths = await collectManagedSkillFiles(root);
    for (const relativePath of relativePaths) {
      if (seen.has(relativePath)) continue;
      seen.add(relativePath);
      files.push({
        tool,
        relativePath,
        absolutePath: path.join(root, ...relativePath.split("/"))
      });
    }
  }
  return files;
}

async function existingManagedSkillRoots(candidates: string[]): Promise<string[]> {
  const checks = await Promise.all(candidates.map(async (candidate) => ({
    candidate,
    exists: await exists(path.join(candidate, "skills"))
  })));
  return checks.filter((item) => item.exists).map((item) => item.candidate);
}

async function collectManagedSkillFiles(root: string): Promise<string[]> {
  const skillsRoot = path.join(root, "skills");
  const relativePaths = await collectFiles(skillsRoot, root);
  return relativePaths
    .map((relativePath) => normalizeRel(path.posix.join("skills", relativePath)))
    .filter(isManagedSkillPath);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function normalizeRel(value: string | undefined | null): string {
  if (!value) return "";
  return value.replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

function isManagedSkillPath(value: string): boolean {
  const normalized = normalizeRel(value).toLowerCase();
  return normalized === "skills" || normalized.startsWith("skills/");
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  if (items.length === 1) return [await mapper(items[0] as T)];

  const cappedLimit = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: cappedLimit }, () => worker()));
  return results;
}
