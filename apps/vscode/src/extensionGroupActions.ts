import * as vscode from "vscode";
import { ensureUniqueGroupNameForTool, getGroupTool } from "./extensionGroupTools";
import type { GroupTarget, GroupTreeNode, SelectionGroup, SkillTreeNode, ToolType } from "./types";

type TranslationFn = (message: string, ...args: Array<string | number | boolean>) => string;
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
        vscode.window.showWarningMessage(args.tr("Select a group to rename."));
        return;
      }
      const nextName = await vscode.window.showInputBox({
        title: args.tr("Rename Group"),
        prompt: args.tr("Enter the new group name"),
        value: group.name
      });
      if (!nextName?.trim() || nextName.trim() === group.name) return;
      const groupTool = getGroupTool(group);
      if (!groupTool) throw new Error(args.tr("Could not find the group agent information."));
      ensureUniqueGroupNameForTool({ groups: args.state.groups, tr: args.tr, side: group.side, tool: groupTool, name: nextName.trim(), excludeId: group.id });
      await args.persistGroups(args.state.groups.map((item) => item.id === group.id ? { ...item, name: nextName.trim() } : item), group.id);
      vscode.window.showInformationMessage(args.tr("Group renamed: {0}", String(nextName.trim())));
    } catch (error) {
      await args.handleError(error);
    }
  };

  const editGroupDescription = async (node?: GroupTreeNode): Promise<void> => {
    try {
      if (!args.state.workspacePath) await args.refresh();
      const group = args.resolveGroup(node);
      if (!group) {
        vscode.window.showWarningMessage(args.tr("Select a group to edit."));
        return;
      }
      const nextDescription = await args.promptGroupDescription({
        title: args.tr("Edit Group Description"),
        prompt: args.tr("Update what this group is for. Agents use this text as grouping intent."),
        value: group.description ?? ""
      });
      if (nextDescription === undefined || nextDescription === (group.description ?? "")) return;
      await args.persistGroups(args.state.groups.map((item) => item.id === group.id ? { ...item, description: nextDescription } : item), group.id);
      vscode.window.showInformationMessage(args.tr("Group description updated: {0}", String(group.name)));
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
      vscode.window.showWarningMessage(args.tr("Select items in the same side tree first."));
      return;
    }
    const selectedTargets = args.buildGroupTargetsFromNodes(nodes);
    if (selectedTargets.length === 0) {
      vscode.window.showWarningMessage(args.tr("Only valid skills with SKILL.md can be applied to a group."));
      return;
    }
    const groupTool = group.targets[0]?.tool;
    const sameToolTargets = groupTool ? selectedTargets.filter((target) => target.tool === groupTool) : selectedTargets;
    if (sameToolTargets.length === 0) {
      vscode.window.showWarningMessage(args.tr("A group can only apply skills from the same agent ({0}).", String(groupTool)));
      return;
    }
    if (sameToolTargets.length !== selectedTargets.length) {
      vscode.window.showInformationMessage(args.tr("Skipped {0} target(s) from other agents and applied only {1} skills.", String(selectedTargets.length - sameToolTargets.length), String(groupTool)));
    }
    let nextTargets: GroupTarget[] = group.targets;
    if (mode === "append") {
      nextTargets = args.dedupeGroupTargets([...group.targets, ...sameToolTargets]);
      if (sameTargetSet(nextTargets, group.targets)) {
        vscode.window.showInformationMessage(args.tr("All selected targets are already in group \"{0}\".", String(group.name)));
        return;
      }
    } else if (mode === "replace") {
      nextTargets = args.dedupeGroupTargets(sameToolTargets);
      if (sameTargetSet(nextTargets, group.targets)) {
        vscode.window.showInformationMessage(args.tr("Group \"{0}\" already matches the current selection.", String(group.name)));
        return;
      }
    } else {
      const removeKeys = new Set(sameToolTargets.map((target) => `${target.tool}:${args.normalizeRel(target.relativePath)}`));
      nextTargets = group.targets.filter((target) => !removeKeys.has(`${target.tool}:${args.normalizeRel(target.relativePath)}`));
      if (nextTargets.length === group.targets.length) {
        vscode.window.showWarningMessage(args.tr("None of the selected targets are in group \"{0}\".", String(group.name)));
        return;
      }
    }
    if (nextTargets.length === 0) {
      vscode.window.showWarningMessage(args.tr("This would leave the group empty. Delete the group instead if needed."));
      return;
    }
    await args.persistGroups(args.state.groups.map((item) => item.id === group.id ? { ...item, targets: nextTargets } : item), group.id);
    vscode.window.showInformationMessage(args.tr("Group updated: {0} ({1} target(s))", String(group.name), String(nextTargets.length)));
  };

  const showGroupActions = async (node?: GroupTreeNode): Promise<void> => {
    try {
      if (!args.state.workspacePath || !args.state.centralRepoPath) await args.refresh();
      const group = args.resolveGroup(node);
      if (!group) {
        vscode.window.showWarningMessage(args.tr("Select a group first."));
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
        ? args.tr("current valid selection {0}", String(sameToolSelectedCount))
        : args.tr("no current valid selection");
      const action = await vscode.window.showQuickPick(
        [
          { label: group.side === "workspace" ? args.tr("Save Group and Skills to Central") : args.tr("Bring Group and Skills to Workspace"), value: "run" as const, description: args.tr("group targets {0}", String(group.targets.length)) },
          { label: args.tr("Copy Group and Skills to Another Agent"), value: "copyAgent" as const, description: args.tr("group targets {0}", String(group.targets.length)) },
          { label: args.tr("Rename Group"), value: "rename" as const },
          { label: args.tr("Edit Group Description"), value: "description" as const },
          { label: args.tr("Add Current Selection to Group"), value: "append" as const, description: selectionDetail },
          { label: args.tr("Replace Group with Current Selection"), value: "replace" as const, description: selectionDetail },
          { label: args.tr("Remove Current Selection from Group"), value: "remove" as const, description: selectionDetail },
          { label: args.tr("View Group Info"), value: "info" as const },
          { label: args.tr("Delete Group"), value: "delete" as const }
        ],
        {
          title: args.tr("Group Actions: {0}", String(group.name)),
          matchOnDescription: true,
          placeHolder: group.description?.trim()
            ? group.description.trim()
            : args.tr("Choose an action for this group.")
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
