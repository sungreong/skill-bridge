import { getGroupTool, normalizeGroupNameKey } from "./extensionGroupTools";
import type { SelectionGroup, ToolType } from "./types";

type TreeSide = SelectionGroup["side"];

function getSourceTool(group: SelectionGroup): ToolType | null {
  return getGroupTool(group) ?? group.meta?.tool ?? null;
}

function sameTool(candidate: SelectionGroup, sourceTool: ToolType | null): boolean {
  return sourceTool !== null && getGroupTool(candidate) === sourceTool;
}

function mirrorMatchPriority(
  candidate: SelectionGroup,
  sourceGroup: SelectionGroup,
  targetSide: TreeSide,
  mirrorKey: string
): number {
  if (candidate.side !== targetSide) return 0;
  if (candidate.meta?.mirroredFrom === mirrorKey) return 5;
  if (sourceGroup.meta?.mirroredFrom === `${targetSide}:${candidate.id}`) return 4;

  const sourceTool = getSourceTool(sourceGroup);
  if (!sameTool(candidate, sourceTool)) return 0;

  const sourceRepoKey = sourceGroup.meta?.repoKey?.trim();
  if (sourceRepoKey && candidate.meta?.repoKey?.trim() === sourceRepoKey) return 3;
  if (normalizeGroupNameKey(candidate.name) === normalizeGroupNameKey(sourceGroup.name)) return 2;

  return 0;
}

export function findMirroredGroupIndexes(args: {
  groups: SelectionGroup[];
  sourceGroup: SelectionGroup;
  targetSide: TreeSide;
  mirrorKey: string;
}): number[] {
  return args.groups
    .map((group, index) => ({
      index,
      priority: mirrorMatchPriority(group, args.sourceGroup, args.targetSide, args.mirrorKey)
    }))
    .filter((item) => item.priority > 0)
    .sort((left, right) => right.priority - left.priority || left.index - right.index)
    .map((item) => item.index);
}
