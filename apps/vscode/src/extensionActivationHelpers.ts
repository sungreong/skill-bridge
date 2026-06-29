import * as vscode from "vscode";
import type { GroupTarget, SelectionGroup, SkillTreeNode, ToolType, TransferPlanItem } from "./types";
import type { TransferScopeHint } from "./extensionTransferManager";

type TreeSide = "workspace" | "central";

export function createExtensionActivationHelpers(args: {
  state: {
    groups: SelectionGroup[];
  };
  tr: (english: string, korean: string) => string;
  normalizeRel: (input: string) => string;
  getSkillFolderRelativePath: (relativePath: string) => string | null;
  dedupeGroupTargets: (targets: GroupTarget[]) => GroupTarget[];
  mirrorGroupToOtherSide: (group: SelectionGroup, options?: { requireExistingTargets?: boolean }) => Promise<boolean>;
  refresh: () => Promise<unknown>;
}): {
  collectAffectedGroupIdsForScopeHints: (sourceSide: TreeSide, scopeHints: TransferScopeHint[]) => string[];
  collectScopeHintsFromPlanItems: (items: TransferPlanItem[]) => TransferScopeHint[];
  collectAffectedGroupIdsForPlanItems: (sourceSide: TreeSide, items: TransferPlanItem[]) => string[];
  mirrorGroupsByIds: (sourceSide: TreeSide, groupIds: string[]) => Promise<number>;
  selectPreferredGroupIds: (sourceSide: TreeSide, affectedGroupIds: string[], preferredGroupIds?: string[]) => string[];
  mirrorGroupsForTransferResult: (sourceSide: TreeSide, result: { affectedGroupIds: string[] }, preferredGroupIds?: string[]) => Promise<number>;
} {
  const collectAffectedGroupIdsForScopeHints = (
    sourceSide: TreeSide,
    scopeHints: TransferScopeHint[]
  ): string[] => {
    const folderKeys = new Set<string>();
    for (const item of scopeHints) {
      const skillFolderRel = args.getSkillFolderRelativePath(item.relativePath);
      if (!skillFolderRel) continue;
      folderKeys.add(`${item.tool}:${skillFolderRel}`);
    }
    if (folderKeys.size === 0) return [];
    return args.state.groups
      .filter((group) =>
        group.side === sourceSide
        && group.targets.some((target) => {
          const skillFolderRel = args.getSkillFolderRelativePath(target.relativePath);
          return !!skillFolderRel && folderKeys.has(`${target.tool}:${skillFolderRel}`);
        })
      )
      .map((group) => group.id);
  };

  const collectScopeHintsFromPlanItems = (items: TransferPlanItem[]): TransferScopeHint[] => {
    const scopeHints: TransferScopeHint[] = [];
    for (const item of items) {
      if (!item.selected) continue;
      const skillFolderRel = args.getSkillFolderRelativePath(item.relativePath);
      if (!skillFolderRel) continue;
      scopeHints.push({
        tool: item.tool,
        relativePath: skillFolderRel,
        kind: "folder"
      });
    }
    return scopeHints;
  };

  const collectAffectedGroupIdsForPlanItems = (sourceSide: TreeSide, items: TransferPlanItem[]): string[] =>
    collectAffectedGroupIdsForScopeHints(sourceSide, collectScopeHintsFromPlanItems(items));

  const mirrorGroupsByIds = async (sourceSide: TreeSide, groupIds: string[]): Promise<number> => {
    if (groupIds.length === 0) return 0;
    let mirrored = 0;
    for (const groupId of groupIds) {
      const group = args.state.groups.find((item) => item.id === groupId && item.side === sourceSide);
      if (!group) continue;
      if (await args.mirrorGroupToOtherSide(group, { requireExistingTargets: true })) {
        mirrored += 1;
      }
    }
    if (mirrored > 0) {
      await args.refresh();
    }
    return mirrored;
  };

  const selectPreferredGroupIds = (
    sourceSide: TreeSide,
    affectedGroupIds: string[],
    preferredGroupIds?: string[]
  ): string[] => {
    if (!preferredGroupIds || preferredGroupIds.length === 0) return affectedGroupIds;
    const allowed = new Set(
      preferredGroupIds.filter((groupId) =>
        args.state.groups.some((group) => group.id === groupId && group.side === sourceSide)
      )
    );
    if (allowed.size === 0) return affectedGroupIds;
    const narrowed = affectedGroupIds.filter((groupId) => allowed.has(groupId));
    return narrowed.length > 0 ? narrowed : affectedGroupIds;
  };

  const mirrorGroupsForTransferResult = async (
    sourceSide: TreeSide,
    result: { affectedGroupIds: string[] },
    preferredGroupIds?: string[]
  ): Promise<number> =>
    mirrorGroupsByIds(
      sourceSide,
      selectPreferredGroupIds(sourceSide, result.affectedGroupIds, preferredGroupIds)
    );

  return {
    collectAffectedGroupIdsForScopeHints,
    collectScopeHintsFromPlanItems,
    collectAffectedGroupIdsForPlanItems,
    mirrorGroupsByIds,
    selectPreferredGroupIds,
    mirrorGroupsForTransferResult
  };
}

export function summarizeStatuses(
  statuses: Array<"added" | "removed" | "modified" | "typeChanged" | "same">
): "added" | "removed" | "modified" | "typeChanged" | "same" {
  if (statuses.some((status) => status === "typeChanged")) return "typeChanged";
  if (statuses.some((status) => status === "modified")) return "modified";
  const hasAdded = statuses.some((status) => status === "added");
  const hasRemoved = statuses.some((status) => status === "removed");
  if (hasAdded && hasRemoved) return "modified";
  if (hasAdded) return "added";
  if (hasRemoved) return "removed";
  return "same";
}

export async function promptGroupDescription(input: {
  title: string;
  prompt: string;
  value: string;
}): Promise<string | undefined> {
  const description = await vscode.window.showInputBox({
    title: input.title,
    prompt: input.prompt,
    value: input.value,
    ignoreFocusOut: true
  });
  if (description === undefined) return undefined;
  return description.trim();
}

export function getSkillFolderRelativePathFromTreeNode(
  normalizeRel: (input: string) => string,
  node: SkillTreeNode | null | undefined
): string | null {
  if (!node?.relativePath) return null;
  const normalized = normalizeRel(node.relativePath);
  const parts = normalized.split("/").filter(Boolean);
  if (parts[0] !== "skills" || !parts[1]) return null;
  return `skills/${parts[1]}`;
}
