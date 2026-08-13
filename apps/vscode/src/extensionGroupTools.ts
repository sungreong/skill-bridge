import type { GroupTarget, SelectionGroup, SkillFile, ToolType } from "./types";

export function getTopSkillFolder(getSkillFolderRelativePath: (relativePath: string) => string | null, relativePath: string): string | null {
  const skillFolderRel = getSkillFolderRelativePath(relativePath);
  if (!skillFolderRel) return null;
  return skillFolderRel.split("/")[1] ?? null;
}

export function getSkillInnerPath(normalizeRel: (value: string | undefined | null) => string, relativePath: string, folder: string): string {
  const normalized = normalizeRel(relativePath);
  const prefix = `skills/${folder}/`;
  if (normalized.startsWith(prefix)) return normalized.slice(prefix.length);
  if (normalized === `skills/${folder}`) return "";
  return normalized;
}

export function summarizeGroupTargets(
  tr: (message: string, ...args: Array<string | number | boolean>) => string,
  targets: GroupTarget[]
): string {
  return tr("{0} skills", String(targets.length));
}

export function getGroupTool(group: SelectionGroup): ToolType | null {
  return group.targets[0]?.tool ?? null;
}

export function normalizeGroupNameKey(name: string): string {
  return name.trim().toLocaleLowerCase("ko-KR");
}

export function ensureUniqueGroupNameForTool(args: {
  groups: SelectionGroup[];
  tr: (message: string, ...args: Array<string | number | boolean>) => string;
  side: "workspace" | "central";
  tool: ToolType;
  name: string;
  excludeId?: string;
}): void {
  const key = normalizeGroupNameKey(args.name);
  const duplicate = args.groups.find((group) => {
    if (group.side !== args.side) return false;
    if (args.excludeId && group.id === args.excludeId) return false;
    const groupTool = getGroupTool(group);
    if (!groupTool || groupTool !== args.tool) return false;
    return normalizeGroupNameKey(group.name) === key;
  });
  if (duplicate) {
    throw new Error(args.tr("A group named \"{0}\" already exists for the same agent ({1}).", String(args.name.trim()), String(args.tool)));
  }
}

export function toSkillFolderTarget(
  getSkillFolderRelativePath: (relativePath: string) => string | null,
  tool: ToolType,
  relativePath: string
): GroupTarget | null {
  const skillFolderRel = getSkillFolderRelativePath(relativePath);
  if (!skillFolderRel) return null;
  return {
    kind: "folder",
    tool,
    relativePath: skillFolderRel
  };
}

export function normalizeGroupsForCurrentSkills(args: {
  input: SelectionGroup[];
  workspaceSkills: SkillFile[];
  centralSkills: SkillFile[];
  dedupeGroupTargets: (targets: GroupTarget[]) => GroupTarget[];
  targetExistsInFiles: (target: GroupTarget, files: SkillFile[]) => boolean;
  options?: { skipExistenceValidation?: boolean };
}): {
  groups: SelectionGroup[];
  changed: boolean;
  splitCount: number;
  removedTargetCount: number;
  removedGroupCount: number;
} {
  const usedIds = new Set<string>();
  const next: SelectionGroup[] = [];
  let changed = false;
  let splitCount = 0;
  let removedTargetCount = 0;
  let removedGroupCount = 0;

  const ensureUniqueGroupId = (baseId: string): string => {
    if (!usedIds.has(baseId)) {
      usedIds.add(baseId);
      return baseId;
    }
    let index = 2;
    while (usedIds.has(`${baseId}-${index}`)) index += 1;
    const nextId = `${baseId}-${index}`;
    usedIds.add(nextId);
    return nextId;
  };

  const getSideSkillFiles = (side: "workspace" | "central"): SkillFile[] =>
    side === "workspace" ? args.workspaceSkills : args.centralSkills;

  for (const group of args.input) {
    const normalizedTargets = args.dedupeGroupTargets(group.targets);
    if (normalizedTargets.length !== group.targets.length || group.targets.some((target) => target.kind !== "folder")) {
      changed = true;
    }
    if (normalizedTargets.length === 0) {
      removedGroupCount += 1;
      changed = true;
      continue;
    }

    const groupedByTool = new Map<ToolType, GroupTarget[]>();
    for (const target of normalizedTargets) {
      const bucket = groupedByTool.get(target.tool) ?? [];
      bucket.push(target);
      groupedByTool.set(target.tool, bucket);
    }
    if (groupedByTool.size > 1) {
      changed = true;
      splitCount += groupedByTool.size - 1;
    }

    const toolEntries = [...groupedByTool.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const sideFiles = getSideSkillFiles(group.side);
    let created = 0;

    for (let index = 0; index < toolEntries.length; index += 1) {
      const [tool, targets] = toolEntries[index];
      const validTargets = args.options?.skipExistenceValidation
        ? [...targets]
        : targets.filter((target) => args.targetExistsInFiles(target, sideFiles));
      removedTargetCount += targets.length - validTargets.length;
      if (validTargets.length !== targets.length) changed = true;
      if (validTargets.length === 0) continue;
      const nextId = ensureUniqueGroupId(index === 0 ? group.id : `${group.id}-${tool}`);
      const nextName = toolEntries.length > 1 ? `${group.name} · ${tool}` : group.name;
      next.push({
        ...group,
        id: nextId,
        name: nextName,
        side: group.side,
        targets: validTargets
      });
      created += 1;
    }

    if (created === 0) {
      removedGroupCount += 1;
      changed = true;
    }
  }

  return {
    groups: next.map((group) => ({ ...group, targets: args.dedupeGroupTargets(group.targets) })),
    changed,
    splitCount,
    removedTargetCount,
    removedGroupCount
  };
}
