import * as vscode from "vscode";
import { ensureUniqueGroupNameForTool, getGroupTool } from "./extensionGroupTools";
import type { GroupTarget, GroupTreeNode, SelectionGroup, SkillTreeNode, ToolType } from "./types";

type TranslationFn = (english: string, korean: string) => string;
type TreeSide = "workspace" | "central";
type GroupMutationMode = "append" | "replace" | "remove";

export function createGroupActionTools(args: {
  tr: TranslationFn;
  toUserError: (error: unknown) => string;
  handleError: (error: unknown) => Promise<void>;
  refresh: () => Promise<void>;
  workspaceProvider: {
    setSelectedGroup: (groupId: string | null) => void;
    setHighlight: (keys: Set<string>) => void;
  };
  centralProvider: {
    setSelectedGroup: (groupId: string | null) => void;
    setHighlight: (keys: Set<string>) => void;
  };
  applyGroupHighlight: (group: SelectionGroup) => void;
  state: {
    workspacePath: string;
    centralRepoPath: string;
    selectedGroupId: string | null;
    groups: SelectionGroup[];
  };
  resolveGroup: (node?: unknown) => SelectionGroup | undefined;
  persistGroups: (
    next: SelectionGroup[],
    selectedGroupId: string | null,
    options?: { skipExistenceValidation?: boolean }
  ) => Promise<void>;
  getSelectedNodes: (side: TreeSide) => SkillTreeNode[];
  buildGroupTargetsFromNodes: (nodes: SkillTreeNode[]) => GroupTarget[];
  dedupeGroupTargets: (targets: GroupTarget[]) => GroupTarget[];
  normalizeRel: (value: string | undefined | null) => string;
  runGroupAgentCopyWizard: (side: TreeSide, node?: GroupTreeNode) => Promise<void>;
  showGroupInfo: (group: SelectionGroup) => Promise<void>;
  exportGroup: (side: TreeSide, selectedGroup?: SelectionGroup) => Promise<unknown>;
  promptGroupDescription: (input: { title: string; prompt: string; value: string }) => Promise<string | undefined>;
}): {
  renameGroup: (node?: GroupTreeNode) => Promise<void>;
  editGroupDescription: (node?: GroupTreeNode) => Promise<void>;
  mutateGroupTargets: (group: SelectionGroup, mode: GroupMutationMode) => Promise<void>;
  showGroupActions: (node?: GroupTreeNode) => Promise<void>;
} {
  const renameGroup = async (node?: GroupTreeNode): Promise<void> => {
    try {
      if (!args.state.workspacePath) await args.refresh();
      const group = args.resolveGroup(node);
      if (!group) {
        vscode.window.showWarningMessage(args.tr("Select a group to rename.", "이름을 바꿀 그룹을 선택하세요."));
        return;
      }
      const nextName = await vscode.window.showInputBox({
        title: args.tr("Rename Group", "그룹 이름 변경"),
        prompt: args.tr("Enter the new group name", "새 그룹 이름을 입력하세요"),
        value: group.name
      });
      if (!nextName?.trim() || nextName.trim() === group.name) return;
      const groupTool = getGroupTool(group);
      if (!groupTool) throw new Error(args.tr("Could not find the group agent information.", "그룹 에이전트 정보를 찾을 수 없습니다."));
      ensureUniqueGroupNameForTool({ groups: args.state.groups, tr: args.tr, side: group.side, tool: groupTool, name: nextName.trim(), excludeId: group.id });
      await args.persistGroups(args.state.groups.map((item) => item.id === group.id ? { ...item, name: nextName.trim() } : item), group.id);
      vscode.window.showInformationMessage(args.tr(`Group renamed: ${nextName.trim()}`, `그룹 이름 변경 완료: ${nextName.trim()}`));
    } catch (error) {
      await args.handleError(error);
    }
  };

  const editGroupDescription = async (node?: GroupTreeNode): Promise<void> => {
    try {
      if (!args.state.workspacePath) await args.refresh();
      const group = args.resolveGroup(node);
      if (!group) {
        vscode.window.showWarningMessage(args.tr("Select a group to edit.", "수정할 그룹을 선택하세요."));
        return;
      }
      const nextDescription = await args.promptGroupDescription({
        title: args.tr("Edit Group Description", "그룹 설명 수정"),
        prompt: args.tr("Update what this group is for. Agents use this text as grouping intent.", "이 그룹의 용도를 수정하세요. 에이전트는 이 설명을 그룹 의도로 사용합니다."),
        value: group.description ?? ""
      });
      if (nextDescription === undefined || nextDescription === (group.description ?? "")) return;
      await args.persistGroups(args.state.groups.map((item) => item.id === group.id ? { ...item, description: nextDescription } : item), group.id);
      vscode.window.showInformationMessage(args.tr(`Group description updated: ${group.name}`, `그룹 설명 수정 완료: ${group.name}`));
    } catch (error) {
      await args.handleError(error);
    }
  };

  const groupTargetKey = (target: GroupTarget): string => `${target.tool}:${args.normalizeRel(target.relativePath)}`;

  const sameTargetSet = (left: GroupTarget[], right: GroupTarget[]): boolean => {
    if (left.length !== right.length) return false;
    const leftKeys = new Set(left.map(groupTargetKey));
    return right.every((target) => leftKeys.has(groupTargetKey(target)));
  };

  const mutateGroupTargets = async (group: SelectionGroup, mode: GroupMutationMode): Promise<void> => {
    const nodes = args.getSelectedNodes(group.side);
    if (nodes.length === 0) {
      vscode.window.showWarningMessage(args.tr("Select items in the same side tree first.", "먼저 같은 사이드 트리에서 항목을 선택하세요."));
      return;
    }
    const selectedTargets = args.buildGroupTargetsFromNodes(nodes);
    if (selectedTargets.length === 0) {
      vscode.window.showWarningMessage(args.tr("Only valid skills with SKILL.md can be applied to a group.", "SKILL.md가 있는 유효 스킬만 그룹에 반영할 수 있습니다."));
      return;
    }
    const groupTool = group.targets[0]?.tool;
    const sameToolTargets = groupTool ? selectedTargets.filter((target) => target.tool === groupTool) : selectedTargets;
    if (sameToolTargets.length === 0) {
      vscode.window.showWarningMessage(args.tr(`A group can only apply skills from the same agent (${groupTool}).`, `그룹은 같은 에이전트(${groupTool}) 스킬만 반영할 수 있습니다.`));
      return;
    }
    if (sameToolTargets.length !== selectedTargets.length) {
      vscode.window.showInformationMessage(args.tr(
        `Skipped ${selectedTargets.length - sameToolTargets.length} target(s) from other agents and applied only ${groupTool} skills.`,
        `다른 에이전트 대상 ${selectedTargets.length - sameToolTargets.length}개는 제외하고 ${groupTool} 스킬만 반영합니다.`
      ));
    }
    let nextTargets: GroupTarget[] = group.targets;
    if (mode === "append") {
      nextTargets = args.dedupeGroupTargets([...group.targets, ...sameToolTargets]);
      if (sameTargetSet(nextTargets, group.targets)) {
        vscode.window.showInformationMessage(args.tr(
          `All selected targets are already in group "${group.name}".`,
          `선택한 대상이 이미 모두 그룹 "${group.name}"에 있습니다.`
        ));
        return;
      }
    } else if (mode === "replace") {
      nextTargets = args.dedupeGroupTargets(sameToolTargets);
      if (sameTargetSet(nextTargets, group.targets)) {
        vscode.window.showInformationMessage(args.tr(
          `Group "${group.name}" already matches the current selection.`,
          `그룹 "${group.name}"은 이미 현재 선택 항목과 같습니다.`
        ));
        return;
      }
    } else {
      const removeKeys = new Set(sameToolTargets.map((target) => `${target.tool}:${args.normalizeRel(target.relativePath)}`));
      nextTargets = group.targets.filter((target) => !removeKeys.has(`${target.tool}:${args.normalizeRel(target.relativePath)}`));
      if (nextTargets.length === group.targets.length) {
        vscode.window.showWarningMessage(args.tr(
          `None of the selected targets are in group "${group.name}".`,
          `선택한 대상이 그룹 "${group.name}"에 없습니다.`
        ));
        return;
      }
    }
    if (nextTargets.length === 0) {
      vscode.window.showWarningMessage(args.tr("This would leave the group empty. Delete the group instead if needed.", "그룹이 비게 됩니다. 필요하면 그룹 삭제를 사용하세요."));
      return;
    }
    await args.persistGroups(args.state.groups.map((item) => item.id === group.id ? { ...item, targets: nextTargets } : item), group.id);
    vscode.window.showInformationMessage(args.tr(`Group updated: ${group.name} (${nextTargets.length} target(s))`, `그룹 변경 완료: ${group.name} (대상 ${nextTargets.length}개)`));
  };

  const showGroupActions = async (node?: GroupTreeNode): Promise<void> => {
    try {
      if (!args.state.workspacePath || !args.state.centralRepoPath) await args.refresh();
      const group = args.resolveGroup(node);
      if (!group) {
        vscode.window.showWarningMessage(args.tr("Select a group first.", "그룹을 먼저 선택하세요."));
        return;
      }
      args.state.selectedGroupId = group.id;
      args.workspaceProvider.setSelectedGroup(group.id);
      args.centralProvider.setSelectedGroup(group.id);
      args.applyGroupHighlight(group);
      const selectedTargets = args.buildGroupTargetsFromNodes(args.getSelectedNodes(group.side));
      const groupTool = getGroupTool(group);
      const sameToolSelectedCount = groupTool
        ? selectedTargets.filter((target) => target.tool === groupTool).length
        : selectedTargets.length;
      const selectionDetail = sameToolSelectedCount > 0
        ? args.tr(`current valid selection ${sameToolSelectedCount}`, `현재 유효 선택 ${sameToolSelectedCount}개`)
        : args.tr("no current valid selection", "현재 유효 선택 없음");
      const action = await vscode.window.showQuickPick(
        [
          { label: group.side === "workspace" ? args.tr("Save Group and Skills to Central", "그룹+스킬을 중앙에 반영") : args.tr("Bring Group and Skills to Workspace", "그룹+스킬을 작업공간으로 가져오기"), value: "run" as const, description: args.tr(`group targets ${group.targets.length}`, `그룹 대상 ${group.targets.length}개`) },
          { label: args.tr("Copy Group and Skills to Another Agent", "그룹+스킬을 다른 에이전트로 복사"), value: "copyAgent" as const, description: args.tr(`group targets ${group.targets.length}`, `그룹 대상 ${group.targets.length}개`) },
          { label: args.tr("Rename Group", "그룹 이름 변경"), value: "rename" as const },
          { label: args.tr("Edit Group Description", "그룹 설명 수정"), value: "description" as const },
          { label: args.tr("Add Current Selection to Group", "현재 선택 스킬을 그룹에 추가"), value: "append" as const, description: selectionDetail },
          { label: args.tr("Replace Group with Current Selection", "그룹 구성을 현재 선택 스킬로 교체"), value: "replace" as const, description: selectionDetail },
          { label: args.tr("Remove Current Selection from Group", "현재 선택 스킬을 그룹에서 제외"), value: "remove" as const, description: selectionDetail },
          { label: args.tr("View Group Info", "그룹 정보 보기"), value: "info" as const },
          { label: args.tr("Delete Group", "그룹 삭제"), value: "delete" as const }
        ],
        {
          title: args.tr(`Group Actions: ${group.name}`, `그룹 작업: ${group.name}`),
          matchOnDescription: true,
          placeHolder: group.description?.trim()
            ? group.description.trim()
            : args.tr("Choose an action for this group.", "이 그룹에 적용할 작업을 선택하세요.")
        }
      );
      if (!action) return;
      if (action.value === "run") return void await args.exportGroup(group.side, group);
      if (action.value === "copyAgent") {
        return void await args.runGroupAgentCopyWizard(group.side, {
          id: group.id,
          kind: "group",
          side: group.side,
          label: group.name,
          count: group.targets.length,
          tool: getGroupTool(group) ?? undefined
        });
      }
      if (action.value === "rename") return void await renameGroup({ id: group.id, kind: "group", side: group.side, label: group.name, count: group.targets.length });
      if (action.value === "description") return void await editGroupDescription({ id: group.id, kind: "group", side: group.side, label: group.name, count: group.targets.length });
      if (action.value === "append") return void await mutateGroupTargets(group, "append");
      if (action.value === "replace") return void await mutateGroupTargets(group, "replace");
      if (action.value === "remove") return void await mutateGroupTargets(group, "remove");
      if (action.value === "info") return void await args.showGroupInfo(group);
      await vscode.commands.executeCommand("skillBridge.deleteGroup", node);
    } catch (error) {
      await args.handleError(error);
    }
  };

  return {
    renameGroup,
    editGroupDescription,
    mutateGroupTargets,
    showGroupActions
  };
}
