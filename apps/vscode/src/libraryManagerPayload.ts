import { existsSync, promises as fs } from "node:fs";
import type { Stats } from "node:fs";
import path from "node:path";
import type { SkillFile, ToolType } from "./types";
import {
  enforceSkillMdInventory,
  isManagedSkillPath,
  isToolType,
  mapWithConcurrency,
  normalizeRel
} from "./extensionSupport";
import {
  getSkillInnerPath,
  getTopSkillFolder,
  summarizeGroupTargets
} from "./extensionGroupTools";
import {
  getSkillRootCandidates,
  resolveSkillPath
} from "./skillPaths";
import type { SkillTreeProvider } from "./views/skillTreeProvider";
import type {
  LibraryEntry,
  LibraryPayload,
  LibrarySideView,
  LibraryStatus,
  TreeSide,
  LibraryManagerStateShape
} from "./libraryManagerTypes";

type TranslationFn = (english: string, korean: string) => string;

export type LibraryPayloadBuilderDeps = {
  state: LibraryManagerStateShape;
  tr: TranslationFn;
  output: { appendLine: (value: string) => void };
  workspaceProvider: SkillTreeProvider;
  centralProvider: SkillTreeProvider;
  scanSkills: (basePath: string, side: TreeSide, agents: ToolType[]) => Promise<SkillFile[]>;
  getSkillFolderRelativePath: (relativePath: string) => string | null;
  isSameFileContent: (src: string, dst: string, srcSize: number, dstSize: number) => Promise<boolean>;
};

function splitLibraryKey(key: string): { tool: ToolType; relativePath: string } | null {
  const idx = key.indexOf(":");
  if (idx <= 0) return null;
  const toolRaw = key.slice(0, idx);
  const relativePath = key.slice(idx + 1);
  if (!isToolType(toolRaw)) return null;
  return { tool: toolRaw, relativePath };
}

function entryMatchesTarget(tool: ToolType, relativePath: string, target: { tool: ToolType; kind: "file" | "folder"; relativePath: string }): boolean {
  if (target.tool !== tool) return false;
  if (target.kind === "file") return target.relativePath === relativePath;
  return relativePath === target.relativePath || relativePath.startsWith(`${target.relativePath}/`);
}

function isoOrNull(value: number): string | null {
  return Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null;
}

function safeResolveSkillPath(basePath: string, tool: ToolType, relativePath: string, mode: "workspace" | "central"): string | null {
  try {
    return resolveSkillPath(basePath, tool, relativePath, mode);
  } catch {
    return null;
  }
}

export function createLibraryPayloadBuilder(deps: LibraryPayloadBuilderDeps): () => Promise<LibraryPayload> {
  return async (): Promise<LibraryPayload> => {
    const dedupeSkills = (skills: SkillFile[]): SkillFile[] => {
      const dedup = new Map<string, SkillFile>();
      for (const item of skills) {
        if (!item || !isManagedSkillPath(item.relativePath)) continue;
        dedup.set(`${item.tool}:${normalizeRel(item.relativePath)}`, {
          ...item,
          relativePath: normalizeRel(item.relativePath)
        });
      }
      return [...dedup.values()].sort((a, b) => a.tool.localeCompare(b.tool) || a.relativePath.localeCompare(b.relativePath));
    };
    const dedupeValidSkills = (skills: SkillFile[]): SkillFile[] =>
      enforceSkillMdInventory(dedupeSkills(skills)).validFiles;
    const snapshotFromTree = (side: TreeSide, basePath: string): SkillFile[] => {
      const provider = side === "workspace" ? deps.workspaceProvider : deps.centralProvider;
      const skills = provider.getAllSelections()
        .filter((item) => isManagedSkillPath(item.relativePath))
        .map((item) => {
          const normalizedRel = normalizeRel(item.relativePath);
          const roots = getSkillRootCandidates(basePath, item.tool, side);
          const foundRoot = roots.find((root) => existsSync(path.join(root, normalizedRel))) ?? roots[0];
          return {
            tool: item.tool,
            relativePath: normalizedRel,
            absolutePath: path.join(foundRoot, normalizedRel)
          } satisfies SkillFile;
        });
      return dedupeSkills(skills);
    };

    let workspaceSkills = dedupeValidSkills([
      ...deps.state.workspaceSkills,
      ...snapshotFromTree("workspace", deps.state.workspacePath)
    ]);
    let centralSkills = dedupeValidSkills([
      ...deps.state.centralSkills,
      ...snapshotFromTree("central", deps.state.centralRepoPath)
    ]);

    if (workspaceSkills.length === 0 || centralSkills.length === 0) {
      const [workspaceScan, centralScan] = await Promise.all([
        workspaceSkills.length === 0 ? deps.scanSkills(deps.state.workspacePath, "workspace", deps.state.agents) : Promise.resolve<SkillFile[]>([]),
        centralSkills.length === 0 ? deps.scanSkills(deps.state.centralRepoPath, "central", deps.state.agents) : Promise.resolve<SkillFile[]>([])
      ]);
      if (workspaceScan.length > 0) {
        workspaceSkills = dedupeValidSkills([...workspaceSkills, ...workspaceScan]);
        deps.state.workspaceSkills = dedupeValidSkills([...deps.state.workspaceSkills, ...workspaceScan]);
      }
      if (centralScan.length > 0) {
        centralSkills = dedupeValidSkills([...centralSkills, ...centralScan]);
        deps.state.centralSkills = dedupeValidSkills([...deps.state.centralSkills, ...centralScan]);
      }
    }

    if (workspaceSkills.length === 0 || centralSkills.length === 0) {
      deps.output.appendLine(`[LibraryManager] payload snapshot warning: workspace=${workspaceSkills.length}, central=${centralSkills.length}, stateWorkspace=${deps.state.workspaceSkills.length}, stateCentral=${deps.state.centralSkills.length}`);
    }

    const workspaceMap = new Map<string, SkillFile>(
      workspaceSkills.map((item) => [`${item.tool}:${item.relativePath}`, item] as const)
    );
    const centralMap = new Map<string, SkillFile>(
      centralSkills.map((item) => [`${item.tool}:${item.relativePath}`, item] as const)
    );
    const allKeys = new Set<string>([...workspaceMap.keys(), ...centralMap.keys()]);
    const statCache = new Map<string, Stats | null>();
    const equalCache = new Map<string, boolean>();

    const statOf = async (targetPath: string): Promise<Stats | null> => {
      if (statCache.has(targetPath)) return statCache.get(targetPath) ?? null;
      const stat = await fs.stat(targetPath).catch(() => null);
      statCache.set(targetPath, stat);
      return stat;
    };
    const filesEqual = async (leftPath: string, rightPath: string): Promise<boolean> => {
      const cacheKey = `${leftPath}::${rightPath}`;
      const reverseKey = `${rightPath}::${leftPath}`;
      if (equalCache.has(cacheKey)) return equalCache.get(cacheKey) ?? false;
      if (equalCache.has(reverseKey)) return equalCache.get(reverseKey) ?? false;
      const [leftStat, rightStat] = await Promise.all([statOf(leftPath), statOf(rightPath)]);
      if (!leftStat || !rightStat || !leftStat.isFile() || !rightStat.isFile()) {
        equalCache.set(cacheKey, false);
        return false;
      }
      const same = await deps.isSameFileContent(leftPath, rightPath, Number(leftStat.size), Number(rightStat.size));
      equalCache.set(cacheKey, same);
      return same;
    };

    const buildSide = async (side: TreeSide): Promise<LibrarySideView> => {
      const sideMap = side === "workspace" ? workspaceMap : centralMap;
      const otherMap = side === "workspace" ? centralMap : workspaceMap;
      const sideGroups = deps.state.groups.filter((group) => group.side === side);
      const mode = side === "workspace" ? "workspace" : "central";
      const basePath = side === "workspace" ? deps.state.workspacePath : deps.state.centralRepoPath;
      const sideAssetMeta = side === "workspace" ? deps.state.workspaceAssetMeta : deps.state.centralAssetMeta;

      const rows = await mapWithConcurrency([...allKeys], 32, async (key): Promise<LibraryEntry | null> => {
        const parsed = splitLibraryKey(key);
        if (!parsed) return null;
        const { tool, relativePath } = parsed;
        if (!isManagedSkillPath(relativePath)) return null;
        const folder = getTopSkillFolder(deps.getSkillFolderRelativePath, relativePath);
        if (!folder) return null;
        const sideFile = sideMap.get(key);
        const otherFile = otherMap.get(key);
        const expectedSidePath = safeResolveSkillPath(basePath, tool, relativePath, mode);
        const expectedFolderPath = safeResolveSkillPath(basePath, tool, folder, mode);
        const folderStat = sideFile && expectedFolderPath ? await statOf(expectedFolderPath) : null;
        const assetMeta = sideAssetMeta.get(`${tool}:${folder}`);

        let status: LibraryStatus = "same";
        if (sideFile && !otherFile) {
          const otherMode = side === "workspace" ? "central" : "workspace";
          const otherBase = side === "workspace" ? deps.state.centralRepoPath : deps.state.workspacePath;
          const otherExpectedPath = safeResolveSkillPath(otherBase, tool, relativePath, otherMode);
          const otherExpectedStat = otherExpectedPath ? await statOf(otherExpectedPath) : null;
          status = otherExpectedStat?.isDirectory() ? "typeChanged" : "added";
        } else if (!sideFile && otherFile) {
          const sideExpectedStat = expectedSidePath ? await statOf(expectedSidePath) : null;
          status = sideExpectedStat?.isDirectory() ? "typeChanged" : "removed";
        } else if (sideFile && otherFile) {
          status = await filesEqual(sideFile.absolutePath, otherFile.absolutePath) ? "same" : "modified";
        }

        const matchingGroups = sideGroups
          .filter((group) => group.targets.some((target) => entryMatchesTarget(tool, relativePath, target)));
        return {
          key,
          tool,
          relativePath,
          folder,
          innerPath: getSkillInnerPath(normalizeRel, relativePath, folder),
          exists: !!sideFile,
          status,
          createdAt: folderStat ? isoOrNull(folderStat.birthtimeMs || folderStat.ctimeMs) : null,
          updatedAt: assetMeta?.updatedAt ?? (folderStat ? isoOrNull(folderStat.mtimeMs) : null),
          groupIds: matchingGroups.map((group) => group.id),
          groupNames: matchingGroups.map((group) => group.name)
        };
      });

      const entries = rows.filter((entry): entry is LibraryEntry => entry !== null);
      entries.sort((a, b) => a.tool.localeCompare(b.tool) || a.relativePath.localeCompare(b.relativePath));
      const groups = sideGroups
        .map((group) => ({
          id: group.id,
          name: group.name,
          targetSummary: summarizeGroupTargets(deps.tr, group.targets),
          targetCount: group.targets.length,
          tools: [...new Set(group.targets.map((target) => target.tool))].sort((a, b) => a.localeCompare(b))
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { entries, groups };
    };

    const [workspace, central] = await Promise.all([buildSide("workspace"), buildSide("central")]);
    const discoveredTools = [...new Set<ToolType>([
      ...workspaceSkills.map((entry) => entry.tool),
      ...centralSkills.map((entry) => entry.tool),
      ...workspace.entries.map((entry) => entry.tool),
      ...central.entries.map((entry) => entry.tool),
      ...deps.state.groups.flatMap((group) => group.targets.map((target) => target.tool))
    ])].sort((a, b) => a.localeCompare(b));
    const tools = deps.state.agents.filter((tool) => discoveredTools.includes(tool));
    return {
      tools,
      workspace,
      central,
      diagnostics: {
        workspaceMissingSkillFolders: deps.state.workspaceMissingSkillFolders,
        centralMissingSkillFolders: deps.state.centralMissingSkillFolders
      }
    };
  };
}
