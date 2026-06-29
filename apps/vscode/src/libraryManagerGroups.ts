import * as vscode from "vscode";
import type { GroupTarget, SelectionGroup, SkillFile, ToolType } from "./types";
import {
  dedupeGroupTargets,
  normalizeRel,
  targetExistsInFiles
} from "./extensionSupport";
import {
  ensureUniqueGroupNameForTool,
  toSkillFolderTarget
} from "./extensionGroupTools";
import { suggestGroupNameForTargets } from "./libraryManagerTargets";
import type {
  CreateGroupSummary,
  GroupMutationSummary,
  LibraryManagerStateShape,
  LibraryTarget,
  TreeSide
} from "./libraryManagerTypes";

type TranslationFn = (english: string, korean: string) => string;

export type LibraryGroupDeps = {
  state: LibraryManagerStateShape;
  tr: TranslationFn;
  getSideSkillFiles: (side: TreeSide) => SkillFile[];
  getSkillFolderRelativePath: (relativePath: string) => string | null;
  persistGroups: (
    next: SelectionGroup[],
    selectedGroupId: string | null,
    options?: { skipExistenceValidation?: boolean }
  ) => Promise<void>;
};

export function createLibraryGroupTools(deps: LibraryGroupDeps) {
  const promptGroupDescription = async (input: {
    title: string;
    prompt: string;
    value: string;
  }): Promise<string | undefined> => {
    const description = await vscode.window.showInputBox({
      title: input.title,
      prompt: input.prompt,
      value: input.value,
      ignoreFocusOut: true
    });
    if (description === undefined) return undefined;
    return description.trim();
  };

  const normalizeLibraryGroupTargets = (
    side: TreeSide,
    targets: LibraryTarget[]
  ): { valid: GroupTarget[]; invalidCount: number } => {
    const files = deps.getSideSkillFiles(side);
    const normalized = targets
      .map((target) => toSkillFolderTarget(deps.getSkillFolderRelativePath, target.tool, target.relativePath))
      .filter((target): target is { tool: ToolType; relativePath: string; kind: "folder" } => !!target);
    const valid = dedupeGroupTargets(normalized.filter((target) => targetExistsInFiles(target, files)));
    const invalidCount = Math.max(0, targets.length - valid.length);
    return { valid, invalidCount };
  };

  const createGroupFromLibraryMany = async (
    side: TreeSide,
    name: string,
    targets: LibraryTarget[],
    description = ""
  ): Promise<CreateGroupSummary> => {
    const trimmed = name.trim();
    if (!trimmed) throw new Error(deps.tr("Enter a group name.", "그룹 이름을 입력하세요."));
    const { valid, invalidCount } = normalizeLibraryGroupTargets(side, targets);
    if (valid.length === 0) {
      throw new Error(deps.tr("Only valid skills with SKILL.md can be added to a group.", "SKILL.md가 있는 유효 스킬만 그룹에 추가할 수 있습니다."));
    }
    const baseTool = valid[0].tool;
    const sameToolTargets = valid.filter((target) => target.tool === baseTool);
    if (sameToolTargets.length === 0) {
      throw new Error(deps.tr("A group can only contain skills from the same agent.", "같은 에이전트 스킬만 그룹으로 만들 수 있습니다."));
    }
    ensureUniqueGroupNameForTool({ groups: deps.state.groups, tr: deps.tr, side, tool: baseTool, name: trimmed });
    const group: SelectionGroup = {
      id: `${side}-${Date.now()}`,
      name: trimmed,
      description,
      side,
      targets: sameToolTargets,
      meta: { source: "manual" }
    };
    await deps.persistGroups([...deps.state.groups, group], group.id);
    return {
      groupId: group.id,
      name: group.name,
      addedCount: sameToolTargets.length,
      skippedCount: invalidCount + (valid.length - sameToolTargets.length),
      tool: baseTool
    };
  };

  const promptCreateGroupForTargets = async (
    side: TreeSide,
    targets: LibraryTarget[],
    title: string,
    prompt: string
  ): Promise<CreateGroupSummary | undefined> => {
    const suggestedName = suggestGroupNameForTargets(deps.getSkillFolderRelativePath, targets);
    const inputName = await vscode.window.showInputBox({
      title,
      prompt,
      value: suggestedName,
      validateInput: (value) => value.trim() ? null : deps.tr("Enter a group name.", "그룹 이름을 입력하세요."),
      ignoreFocusOut: true
    });
    if (!inputName?.trim()) return undefined;
    const description = await promptGroupDescription({
      title: side === "workspace" ? deps.tr("Workspace Group Description", "작업공간 그룹 설명") : deps.tr("Central Group Description", "중앙 그룹 설명"),
      prompt: deps.tr("Describe what this group is for. This helps agents understand when to use it.", "이 그룹의 용도를 설명하세요. 에이전트가 그룹 목적을 이해하는 데 사용됩니다."),
      value: ""
    });
    if (description === undefined) return undefined;
    return await createGroupFromLibraryMany(side, inputName.trim(), targets, description);
  };

  const assignTargetsToGroupMany = async (
    side: TreeSide,
    groupId: string,
    targets: LibraryTarget[]
  ): Promise<GroupMutationSummary> => {
    const group = deps.state.groups.find((item) => item.id === groupId && item.side === side);
    if (!group) throw new Error(deps.tr("Could not find the group to assign.", "할당할 그룹을 찾지 못했습니다."));
    const { valid, invalidCount } = normalizeLibraryGroupTargets(side, targets);
    if (valid.length === 0) throw new Error(deps.tr("Only valid skills with SKILL.md can be assigned to a group.", "SKILL.md가 있는 유효 스킬만 그룹에 할당할 수 있습니다."));
    const groupTool = group.targets[0]?.tool ?? valid[0].tool;
    const sameToolTargets = valid.filter((target) => target.tool === groupTool);
    if (sameToolTargets.length === 0) {
      throw new Error(deps.tr(`A group can only contain skills from the same agent (${groupTool}).`, `그룹은 같은 에이전트(${groupTool}) 스킬만 담을 수 있습니다.`));
    }
    const beforeCount = group.targets.length;
    const nextTargets = dedupeGroupTargets([...group.targets, ...sameToolTargets]);
    const nextGroups = deps.state.groups.map((item) => item.id === group.id ? { ...item, targets: nextTargets } : item);
    await deps.persistGroups(nextGroups, group.id);
    return {
      affectedCount: Math.max(0, nextTargets.length - beforeCount),
      skippedCount: invalidCount + (valid.length - sameToolTargets.length)
    };
  };

  const unassignTargetsFromGroupMany = async (
    side: TreeSide,
    groupId: string,
    targets: LibraryTarget[]
  ): Promise<GroupMutationSummary> => {
    const group = deps.state.groups.find((item) => item.id === groupId && item.side === side);
    if (!group) throw new Error(deps.tr("Could not find the group to unassign.", "해제할 그룹을 찾지 못했습니다."));
    const normalized = dedupeGroupTargets(
      targets
        .map((target) => toSkillFolderTarget(deps.getSkillFolderRelativePath, target.tool, target.relativePath))
        .filter((target): target is GroupTarget => !!target)
    );
    if (normalized.length === 0) throw new Error(deps.tr("Select a valid skill folder.", "유효한 스킬 폴더를 선택하세요."));
    const toRemove = new Set(normalized.map((target) => `${target.tool}:${normalizeRel(target.relativePath)}`));
    const beforeCount = group.targets.length;
    const nextTargets = group.targets.filter((target) => !toRemove.has(`${target.tool}:${normalizeRel(target.relativePath)}`));
    if (nextTargets.length === 0) {
      throw new Error(deps.tr("This would leave the group empty. Delete the group instead if needed.", "그룹이 비게 됩니다. 필요하면 그룹 삭제를 사용하세요."));
    }
    const removedCount = Math.max(0, beforeCount - nextTargets.length);
    const nextGroups = deps.state.groups.map((item) => item.id === group.id ? { ...item, targets: nextTargets } : item);
    await deps.persistGroups(nextGroups, group.id);
    return {
      affectedCount: removedCount,
      skippedCount: Math.max(0, normalized.length - removedCount)
    };
  };

  return {
    promptGroupDescription,
    promptCreateGroupForTargets,
    createGroupFromLibraryMany,
    assignTargetsToGroupMany,
    unassignTargetsFromGroupMany
  };
}
