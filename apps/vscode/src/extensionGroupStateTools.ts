import * as vscode from "vscode";
import type { GroupTarget, SelectionGroup, SkillFile, SkillTreeNode, ToolType } from "./types";
import type { TransferScopeHint } from "./extensionTransferManager";
import { findMirroredGroupIndexes } from "./groupMirrorMatching";

type TreeSide = "workspace" | "central";

type PersistGroupsOptions = { skipExistenceValidation?: boolean };

type PersistGroupsFn = (
  next: SelectionGroup[],
  selectedGroupId: string | null,
  options?: PersistGroupsOptions
) => Promise<void>;

export function createExtensionGroupStateTools(args: {
  tr: (message: string, ...args: Array<string | number | boolean>) => string;
  toUserError: (error: unknown) => string;
  handleError: (error: unknown) => Promise<void>;
  state: {
    workspacePath: string;
    centralRepoPath: string;
    groups: SelectionGroup[];
    selectedGroupId: string | null;
    workspaceSelection: SkillTreeNode[];
    centralSelection: SkillTreeNode[];
    workspaceSkills: SkillFile[];
    centralSkills: SkillFile[];
  };
  refresh: () => Promise<unknown>;
  workspaceProvider: {
    setGroups: (groups: SelectionGroup[]) => void;
    setSelectedGroup: (groupId: string | null) => void;
    setHighlight: (keys: Set<string>) => void;
  };
  centralProvider: {
    setGroups: (groups: SelectionGroup[]) => void;
    setSelectedGroup: (groupId: string | null) => void;
    setHighlight: (keys: Set<string>) => void;
  };
  applyGroupHighlight: (group: SelectionGroup) => void;
  saveSelectionGroups: (workspacePath: string, centralRepoPath: string, groups: SelectionGroup[]) => Promise<void>;
  normalizeGroupsForCurrentSkills: (args: {
    input: SelectionGroup[];
    workspaceSkills: SkillFile[];
    centralSkills: SkillFile[];
    dedupeGroupTargets: (targets: GroupTarget[]) => GroupTarget[];
    targetExistsInFiles: (target: GroupTarget, files: SkillFile[]) => boolean;
    options?: PersistGroupsOptions;
  }) => {
    groups: SelectionGroup[];
    changed: boolean;
    splitCount: number;
    removedTargetCount: number;
    removedGroupCount: number;
  };
  output: vscode.OutputChannel;
  buildGroupTargetsFromNodes: (nodes: SkillTreeNode[]) => GroupTarget[];
  dedupeGroupTargets: (targets: GroupTarget[]) => GroupTarget[];
  targetExistsInFiles: (target: GroupTarget, files: SkillFile[]) => boolean;
  targetsToSelections: (files: SkillFile[], targets: GroupTarget[]) => Array<{ tool: ToolType; relativePath: string }>;
  uniqueSelections: (selections: Array<{ tool: ToolType; relativePath: string }>) => Array<{ tool: ToolType; relativePath: string }>;
  ensureUniqueGroupNameForTool: (args: {
    groups: SelectionGroup[];
    tr: (message: string, ...args: Array<string | number | boolean>) => string;
    side: TreeSide;
    tool: ToolType;
    name: string;
  }) => void;
  promptGroupDescription: (input: { title: string; prompt: string; value: string }) => Promise<string | undefined>;
  promptCreateGroupForTargets: (
    side: TreeSide,
    targets: Array<{ tool: ToolType; relativePath: string; kind: "folder" }>,
    title: string,
    prompt: string
  ) => Promise<{ name: string; addedCount: number; skippedCount: number } | undefined>;
  assignTargetsToGroupMany: (
    side: TreeSide,
    groupId: string,
    targets: Array<{ tool: ToolType; relativePath: string; kind: "folder" }>
  ) => Promise<{ affectedCount: number; skippedCount: number }>;
  transferSelections: (
    side: TreeSide,
    selections: Array<{ tool: ToolType; relativePath: string }>,
    options?: { groupContext?: { id: string; name: string; side: TreeSide }; scopeHints?: TransferScopeHint[] }
  ) => Promise<{ copied: number; deleted: number; unchanged: number; failed: number }>;
  isManagedSkillPath: (relativePath: string) => boolean;
  normalizeRel: (input: string) => string;
  getGroupTool: (group: SelectionGroup) => ToolType | null | undefined;
}): {
  createGroupFromSelection: (side: TreeSide, overrideNodes?: SkillTreeNode[]) => Promise<void>;
  resolveGroupingNodes: (side: TreeSide, targetNode?: SkillTreeNode) => SkillTreeNode[];
  addSelectionToExistingGroup: (side: TreeSide, targetNode?: SkillTreeNode) => Promise<void>;
  exportGroup: (
    side: TreeSide,
    selectedGroup?: SelectionGroup,
    options?: { skipConfirm?: boolean; skipNotify?: boolean; skipRefresh?: boolean }
  ) => Promise<{ copied: number; deleted: number; unchanged: number } | null>;
  resolveGroup: (node?: unknown) => SelectionGroup | undefined;
  getSelectedNodes: (side: TreeSide) => SkillTreeNode[];
  persistGroups: PersistGroupsFn;
  mirrorGroupToOtherSide: (sourceGroup: SelectionGroup, options?: { requireExistingTargets?: boolean }) => Promise<boolean>;
  groupsEquivalent: (left: SelectionGroup, right: SelectionGroup) => boolean;
  getSideSkillFiles: (side: TreeSide) => SkillFile[];
} {
  const getSideSkillFiles = (side: TreeSide): SkillFile[] =>
    side === "workspace" ? args.state.workspaceSkills : args.state.centralSkills;

  const sideLabel = (side: TreeSide): string =>
    side === "workspace" ? args.tr("Workspace") : args.tr("Central");

  const uniqueTargetTools = (targets: GroupTarget[]): ToolType[] =>
    [...new Set(targets.map((target) => target.tool))].sort((left, right) => left.localeCompare(right));

  const formatTools = (tools: ToolType[]): string =>
    tools.length === 0 ? args.tr("unknown agent") : tools.join(", ");

  const groupNameKey = (name: string): string => name.trim().toLocaleLowerCase("ko-KR");

  const formatTargetSample = (targets: GroupTarget[]): string => {
    const sample = targets
      .slice(0, 3)
      .map((target) => `${target.tool}/${args.normalizeRel(target.relativePath)}`)
      .join(", ");
    const suffix = targets.length > 3 ? ` +${targets.length - 3}` : "";
    return `${sample}${suffix}`;
  };

  const findSameNameMissingTargetsByTool = (
    sourceGroup: SelectionGroup,
    targetSide: TreeSide,
    selectedTargetKeys: Set<string>
  ): Array<{ tool: ToolType; missingCount: number }> => {
    const targetFiles = getSideSkillFiles(targetSide);
    const missingByTool = new Map<ToolType, number>();
    const sourceNameKey = groupNameKey(sourceGroup.name);
    const sameNameGroups = args.state.groups.filter((group) =>
      group.side === sourceGroup.side
      && group.id !== sourceGroup.id
      && groupNameKey(group.name) === sourceNameKey
    );

    for (const group of sameNameGroups) {
      const targets = args.dedupeGroupTargets(
        group.targets.filter((target) => args.isManagedSkillPath(target.relativePath))
      );
      for (const target of targets) {
        const key = `${target.tool}:${args.normalizeRel(target.relativePath)}`;
        if (selectedTargetKeys.has(key)) continue;
        if (args.targetExistsInFiles(target, targetFiles)) continue;
        missingByTool.set(target.tool, (missingByTool.get(target.tool) ?? 0) + 1);
      }
    }

    return [...missingByTool.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([tool, missingCount]) => ({ tool, missingCount }));
  };

  const describeNoFileChangeGroupTransfer = (
    group: SelectionGroup,
    result: { unchanged: number; failed: number },
    mirroredGroup: boolean
  ): { message: string; warning: boolean } => {
    const targetSide: TreeSide = group.side === "workspace" ? "central" : "workspace";
    const normalizedTargets = args.dedupeGroupTargets(
      group.targets.filter((target) => args.isManagedSkillPath(target.relativePath))
    );
    const targetFiles = getSideSkillFiles(targetSide);
    const selectedTargetKeys = new Set(
      normalizedTargets.map((target) => `${target.tool}:${args.normalizeRel(target.relativePath)}`)
    );
    const missingSelectedTargets = normalizedTargets.filter((target) => !args.targetExistsInFiles(target, targetFiles));
    const tools = uniqueTargetTools(normalizedTargets);
    const groupSuffix = mirroredGroup ? args.tr(" · group applied") : "";

    if (missingSelectedTargets.length > 0) {
      return {
        warning: true,
        message: args.tr("Group copy made no file changes, but {0} still misses {1} selected target(s): {2}. Refresh and review the apply plan for this group.{3}", String(sideLabel(targetSide)), String(missingSelectedTargets.length), String(formatTargetSample(missingSelectedTargets)), String(groupSuffix))
      };
    }

    const sameNameMissingByTool = findSameNameMissingTargetsByTool(group, targetSide, selectedTargetKeys);
    if (sameNameMissingByTool.length > 0) {
      const missingSummary = sameNameMissingByTool
        .map((item) => `${item.tool} ${item.missingCount}`)
        .join(", ");
      return {
        warning: true,
        message: args.tr("No file changes for group \"{0}\" ({1}): those targets already exist in {2}. Same-named {3} groups are still missing in {4} for: {5}. Bring those agent groups separately.{6}", String(group.name), String(formatTools(tools)), String(sideLabel(targetSide)), String(sideLabel(group.side)), String(sideLabel(targetSide)), String(missingSummary), String(groupSuffix))
      };
    }

    return {
      warning: false,
      message: args.tr("Group copy made no file changes for \"{0}\" ({1}) · unchanged {2} · failed {3}{4}", String(group.name), String(formatTools(tools)), String(result.unchanged), String(result.failed), String(groupSuffix))
    };
  };

  const resolveGroupingNodes = (
    side: TreeSide,
    targetNode?: SkillTreeNode
  ): SkillTreeNode[] => {
    const current = side === "workspace" ? args.state.workspaceSelection : args.state.centralSelection;
    const groupable = current.filter((node) => node.kind === "file" || node.kind === "folder");
    if (!targetNode) return groupable;
    if (!(targetNode.kind === "file" || targetNode.kind === "folder")) return groupable;
    if (groupable.some((node) => node.key === targetNode.key)) return groupable;
    return [targetNode];
  };

  const persistGroups: PersistGroupsFn = async (next, selectedGroupId, options) => {
    const normalized = args.normalizeGroupsForCurrentSkills({
      input: next,
      workspaceSkills: args.state.workspaceSkills,
      centralSkills: args.state.centralSkills,
      dedupeGroupTargets: args.dedupeGroupTargets,
      targetExistsInFiles: args.targetExistsInFiles,
      options
    });
    args.state.groups = normalized.groups;
    args.state.selectedGroupId = selectedGroupId && args.state.groups.some((item) => item.id === selectedGroupId)
      ? selectedGroupId
      : null;
    if (normalized.changed) {
      args.output.appendLine(args.tr("[GroupNormalize] normalized during persist - split={0}, removedTargets={1}, removedGroups={2}", String(normalized.splitCount), String(normalized.removedTargetCount), String(normalized.removedGroupCount)));
    }
    await args.saveSelectionGroups(args.state.workspacePath, args.state.centralRepoPath, args.state.groups);
    args.workspaceProvider.setGroups(args.state.groups);
    args.centralProvider.setGroups(args.state.groups);
    args.workspaceProvider.setSelectedGroup(args.state.selectedGroupId);
    args.centralProvider.setSelectedGroup(args.state.selectedGroupId);
    const selected = args.state.selectedGroupId
      ? args.state.groups.find((item) => item.id === args.state.selectedGroupId)
      : undefined;
    if (selected) {
      args.applyGroupHighlight(selected);
    } else {
      args.workspaceProvider.setHighlight(new Set());
      args.centralProvider.setHighlight(new Set());
    }
  };

  const groupTargetsEqual = (left: GroupTarget[], right: GroupTarget[]): boolean => {
    const normalize = (targets: GroupTarget[]): string[] =>
      args.dedupeGroupTargets(targets)
        .map((target) => `${target.kind}:${target.tool}:${args.normalizeRel(target.relativePath)}`)
        .sort((a, b) => a.localeCompare(b));
    const a = normalize(left);
    const b = normalize(right);
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  };

  const groupMetaEqual = (left: SelectionGroup["meta"], right: SelectionGroup["meta"]): boolean =>
    (left?.source ?? "") === (right?.source ?? "")
      && (left?.tool ?? "") === (right?.tool ?? "")
      && (left?.repoKey ?? "") === (right?.repoKey ?? "")
      && (left?.repoUrl ?? "") === (right?.repoUrl ?? "")
      && (left?.lastInstalledAt ?? "") === (right?.lastInstalledAt ?? "")
      && (left?.mirroredFrom ?? "") === (right?.mirroredFrom ?? "");

  const groupsEquivalent = (left: SelectionGroup, right: SelectionGroup): boolean =>
    left.name === right.name
      && (left.description ?? "") === (right.description ?? "")
      && groupTargetsEqual(left.targets, right.targets)
      && groupMetaEqual(left.meta, right.meta);

  const resolveGroup = (node?: unknown): SelectionGroup | undefined => {
    const extractGroupId = (value: unknown): string | null => {
      if (!value || typeof value !== "object") return null;
      const record = value as Record<string, unknown>;
      if (record.kind === "group") {
        if (typeof record.id === "string" && record.id.trim()) return record.id;
        if (typeof record.groupId === "string" && record.groupId.trim()) return record.groupId;
      }
      if (record.node && typeof record.node === "object") {
        return extractGroupId(record.node);
      }
      return null;
    };
    const targetId = extractGroupId(node) ?? args.state.selectedGroupId;
    if (!targetId) return undefined;
    return args.state.groups.find((item) => item.id === targetId);
  };

  const getSelectedNodes = (side: TreeSide): SkillTreeNode[] =>
    side === "workspace" ? args.state.workspaceSelection : args.state.centralSelection;

  const mirrorGroupToOtherSide = async (
    sourceGroup: SelectionGroup,
    options?: { requireExistingTargets?: boolean }
  ): Promise<boolean> => {
    const targetSide: TreeSide = sourceGroup.side === "workspace" ? "central" : "workspace";
    const mirrorKey = `${sourceGroup.side}:${sourceGroup.id}`;
    const now = new Date().toISOString();
    const matchingIndexes = findMirroredGroupIndexes({ groups: args.state.groups, sourceGroup, targetSide, mirrorKey });
    const existingIndex = matchingIndexes[0] ?? -1;
    const duplicateIndexes = new Set(matchingIndexes.slice(1));
    const existing = existingIndex >= 0 ? args.state.groups[existingIndex] : undefined;

    const normalizedTargets = args.dedupeGroupTargets(sourceGroup.targets.filter((target) => args.isManagedSkillPath(target.relativePath)));
    const targetFiles = options?.requireExistingTargets ? getSideSkillFiles(targetSide) : undefined;
    const mirroredTargets = targetFiles
      ? normalizedTargets.filter((target) => args.targetExistsInFiles(target, targetFiles))
      : normalizedTargets;
    if (mirroredTargets.length === 0) {
      if (matchingIndexes.length > 0) {
        const indexesToRemove = new Set(matchingIndexes);
        const nextGroups = args.state.groups.filter((_, index) => !indexesToRemove.has(index));
        await persistGroups(nextGroups, args.state.selectedGroupId, { skipExistenceValidation: true });
      }
      args.output.appendLine(args.tr("[GroupMirror] skipped \"{0}\": no target-side skills were found after transfer.", String(sourceGroup.name)));
      return false;
    }

    const mirrored: SelectionGroup = {
      ...sourceGroup,
      id: existing?.id ?? `${targetSide}-${Date.now()}`,
      side: targetSide,
      targets: mirroredTargets,
      meta: {
        ...sourceGroup.meta,
        source: sourceGroup.meta?.source ?? "manual",
        mirroredFrom: mirrorKey,
        lastInstalledAt: sourceGroup.meta?.source === "npx" ? now : sourceGroup.meta?.lastInstalledAt
      }
    };

    const nextGroups = existing
      ? args.state.groups.flatMap((group, index) => {
        if (index === existingIndex) return [mirrored];
        if (duplicateIndexes.has(index)) return [];
        return [group];
      })
      : [...args.state.groups, mirrored];
    await persistGroups(nextGroups, args.state.selectedGroupId, { skipExistenceValidation: !options?.requireExistingTargets });
    return true;
  };

  const pickGroup = async (groups: SelectionGroup[], side: TreeSide): Promise<SelectionGroup | undefined> => {
    const pick = await vscode.window.showQuickPick(
      groups.map((group) => ({
        label: group.name,
        description: group.description?.trim()
          ? group.description.trim()
          : args.tr("{0} target(s)", String(group.targets.length)),
        value: group.id
      })),
      { title: side === "workspace" ? args.tr("Select Group to Save to Central") : args.tr("Select Group to Bring to Workspace") }
    );
    if (!pick) return undefined;
    return groups.find((item) => item.id === pick.value);
  };

  const createGroupFromSelection = async (
    side: TreeSide,
    overrideNodes?: SkillTreeNode[]
  ): Promise<void> => {
    try {
      if (!args.state.workspacePath || !args.state.centralRepoPath) await args.refresh();
      const nodes = (overrideNodes && overrideNodes.length > 0) ? overrideNodes : resolveGroupingNodes(side);
      if (nodes.length === 0) {
        vscode.window.showWarningMessage(args.tr("Select items in the tree first."));
        return;
      }

      const targets = args.buildGroupTargetsFromNodes(nodes);
      if (targets.length === 0) {
        vscode.window.showWarningMessage(args.tr("Only items under a skills folder can be saved as a group."));
        return;
      }

      const name = await vscode.window.showInputBox({
        title: args.tr("Group Name"),
        prompt: args.tr("Enter a group name."),
        value: `group-${new Date().toISOString().slice(0, 10)}`
      });
      if (!name?.trim()) return;
      const trimmedName = name.trim();
      const description = await args.promptGroupDescription({
        title: side === "workspace" ? args.tr("Workspace Group Description") : args.tr("Central Group Description"),
        prompt: args.tr("Describe what this group is for. This helps agents understand when to use it."),
        value: ""
      });
      if (description === undefined) return;

      const selectedTools = [...new Set<ToolType>(targets.map((target) => target.tool))];
      const baseTool = selectedTools[0];
      if (!baseTool) {
        vscode.window.showWarningMessage(args.tr("Select a valid skill first."));
        return;
      }
      args.ensureUniqueGroupNameForTool({ groups: args.state.groups, tr: args.tr, side, tool: baseTool, name: trimmedName });

      const sameToolTargets = targets.filter((target) => target.tool === baseTool);
      if (sameToolTargets.length !== targets.length) {
        vscode.window.showInformationMessage(args.tr("Skipped {0} targets from other agents and saved only {1} skills in the group.", String(targets.length - sameToolTargets.length), String(baseTool)));
      }

      const group: SelectionGroup = {
        id: `${side}-${Date.now()}`,
        name: trimmedName,
        description,
        side,
        targets: sameToolTargets,
        meta: { source: "manual" }
      };
      await persistGroups([...args.state.groups, group], group.id);
      const saved = args.state.groups.find((item) => item.id === args.state.selectedGroupId)
        ?? args.state.groups.find((item) => item.name === group.name && item.side === group.side);
      if (saved) args.applyGroupHighlight(saved);
      vscode.window.showInformationMessage(args.tr("Group saved: {0} ({1} skills)", String(group.name), String(sameToolTargets.length)));
    } catch (error) {
      await args.handleError(error);
    }
  };

  const addSelectionToExistingGroup = async (
    side: TreeSide,
    targetNode?: SkillTreeNode
  ): Promise<void> => {
    try {
      if (!args.state.workspacePath || !args.state.centralRepoPath) await args.refresh();
      const nodes = resolveGroupingNodes(side, targetNode);
      if (nodes.length === 0) {
        vscode.window.showWarningMessage(args.tr("Select skill folders or files first."));
        return;
      }
      const targets = args.buildGroupTargetsFromNodes(nodes);
      if (targets.length === 0) {
        vscode.window.showWarningMessage(args.tr("Only valid skills with SKILL.md can be added to a group."));
        return;
      }

      const selectedTools = [...new Set<ToolType>(targets.map((target) => target.tool))];
      const candidateGroups = args.state.groups
        .filter((group) => group.side === side)
        .filter((group) => {
          const groupTool = group.targets[0]?.tool;
          if (!groupTool) return false;
          return selectedTools.length === 1 ? groupTool === selectedTools[0] : selectedTools.includes(groupTool);
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      if (candidateGroups.length === 0) {
        const created = await args.promptCreateGroupForTargets(
          side,
          targets.map((target) => ({ tool: target.tool, relativePath: target.relativePath, kind: "folder" as const })),
          args.tr("No Existing Group"),
          args.tr("No matching group exists for this agent. Enter a group name to create it and add the selected skills.")
        );
        if (created) {
          const skipSuffix = created.skippedCount > 0 ? args.tr(" · skipped {0}", String(created.skippedCount)) : "";
          vscode.window.showInformationMessage(args.tr("Group created and selected skills added: {0} ({1} skills{2})", String(created.name), String(created.addedCount), String(skipSuffix)));
        }
        return;
      }

      const picks = await vscode.window.showQuickPick(
        candidateGroups.map((group) => ({
          label: group.name,
          description: group.description?.trim()
            ? group.description.trim()
            : `${group.targets[0]?.tool ?? "-"} · ${group.targets.length} ${args.tr("skills")}`,
          value: group.id
        })),
        {
          canPickMany: true,
          title: side === "workspace" ? args.tr("Add to Existing Workspace Groups") : args.tr("Add to Existing Central Groups"),
          placeHolder: args.tr("Choose one or more groups to add to.")
        }
      );
      if (!picks || picks.length === 0) return;

      let affectedTotal = 0;
      let skippedTotal = 0;
      for (const pick of picks) {
        const result = await args.assignTargetsToGroupMany(
          side,
          pick.value,
          targets.map((target) => ({ tool: target.tool, relativePath: target.relativePath, kind: "folder" as const }))
        );
        affectedTotal += result.affectedCount;
        skippedTotal += result.skippedCount;
      }
      const skipSuffix = skippedTotal > 0 ? args.tr(" · skipped {0}", String(skippedTotal)) : "";
      vscode.window.showInformationMessage(args.tr("Added to existing groups: {0} targets{1}", String(affectedTotal), String(skipSuffix)));
    } catch (error) {
      await args.handleError(error);
    }
  };

  const exportGroup = async (
    side: TreeSide,
    selectedGroup?: SelectionGroup,
    options?: { skipConfirm?: boolean; skipNotify?: boolean; skipRefresh?: boolean }
  ): Promise<{ copied: number; deleted: number; unchanged: number } | null> => {
    try {
      if (!args.state.workspacePath || !args.state.centralRepoPath) await args.refresh();
      const groups = args.state.groups.filter((item) => item.side === side);
      if (groups.length === 0) {
        vscode.window.showWarningMessage(args.tr("No groups are registered."));
        return null;
      }

      const group = selectedGroup ?? await pickGroup(groups, side);
      if (!group) return null;

      const selections = args.targetsToSelections(getSideSkillFiles(side), group.targets);
      const scopeHints = group.targets.map((target) => ({ ...target }));
      if (selections.length === 0) {
        const refreshLabel = args.tr("Refresh");
        const picked = await vscode.window.showWarningMessage(
          args.tr("Group \"{0}\" has no currently available skill files to apply. Its targets may be missing SKILL.md or no longer exist.", String(group.name)),
          refreshLabel
        );
        if (picked === refreshLabel) await args.refresh();
        return null;
      }

      if (!options?.skipConfirm) {
        const directionLabel = side === "workspace"
          ? args.tr("Workspace → Central")
          : args.tr("Central → Workspace");
        const ok = await vscode.window.showWarningMessage(
          args.tr("Apply group \"{0}\" ({1} skill folders) via {2}?", String(group.name), String(group.targets.length), String(directionLabel)),
          { modal: true },
          args.tr("Continue")
        );
        if (ok !== args.tr("Continue")) return null;
      }

      const result = await args.transferSelections(side, selections, {
        groupContext: { id: group.id, name: group.name, side: group.side },
        scopeHints
      });
      const changedFileRows = result.copied + result.deleted;

      if (changedFileRows > 0 && !options?.skipRefresh) {
        await args.refresh();
      }

      const canTrustUnrefreshedTransfer = Boolean(options?.skipRefresh && changedFileRows > 0 && result.failed === 0);
      const mirroredGroup = await mirrorGroupToOtherSide(group, { requireExistingTargets: !canTrustUnrefreshedTransfer });

      if (!options?.skipRefresh) {
        await args.refresh();
      }
      if (!options?.skipNotify) {
        if (changedFileRows === 0) {
          const diagnosis = describeNoFileChangeGroupTransfer(group, result, mirroredGroup);
          if (diagnosis.warning) {
            vscode.window.showWarningMessage(diagnosis.message);
          } else {
            vscode.window.showInformationMessage(diagnosis.message);
          }
        } else {
          const groupSuffix = mirroredGroup ? args.tr(" · opposite panel group updated") : "";
          vscode.window.showInformationMessage(args.tr("Group applied: copied {0} · deleted {1} · unchanged {2}{3}", String(result.copied), String(result.deleted), String(result.unchanged), String(groupSuffix)));
        }
      }
      return { copied: result.copied, deleted: result.deleted, unchanged: result.unchanged };
    } catch (error) {
      await args.handleError(error);
      return null;
    }
  };

  return {
    createGroupFromSelection,
    resolveGroupingNodes,
    addSelectionToExistingGroup,
    exportGroup,
    resolveGroup,
    getSelectedNodes,
    persistGroups,
    mirrorGroupToOtherSide,
    groupsEquivalent,
    getSideSkillFiles
  };
}
