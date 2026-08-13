import { promises as fs } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import type { GroupTarget, GroupTreeNode, SelectionGroup, SkillTreeNode, ToolType } from "./types";
import type { WizardAssetPick } from "./extensionAddMoveWizard";

type TreeSide = "workspace" | "central";
type TranslationFn = (message: string, ...args: Array<string | number | boolean>) => string;

type AgentCopyDeps = {
  tr: TranslationFn;
  toUserError: (error: unknown) => string;
  handleError: (error: unknown) => Promise<void>;
  workspacePath: () => string;
  centralRepoPath: () => string;
  agents: () => ToolType[];
  groups: () => SelectionGroup[];
  refresh: () => Promise<void>;
  pickWizardSide: (title: string) => Promise<TreeSide | undefined>;
  pickWizardAsset: (side: TreeSide, title: string) => Promise<WizardAssetPick | undefined>;
  getWizardAssetPicks: (side: TreeSide) => WizardAssetPick[];
  dedupeWizardAssets: (assets: WizardAssetPick[]) => WizardAssetPick[];
  getSelectedNodes: (side: TreeSide) => SkillTreeNode[];
  buildGroupTargetsFromNodes: (nodes: SkillTreeNode[]) => GroupTarget[];
  resolveGroup: (node?: unknown) => SelectionGroup | undefined;
  getGroupTool: (group: SelectionGroup) => ToolType | null;
  dedupeGroupTargets: (targets: GroupTarget[]) => GroupTarget[];
  isManagedSkillPath: (relativePath: string) => boolean;
  getSkillRoot: (basePath: string, tool: ToolType, mode: TreeSide) => string;
  getWritableSkillRoot: (basePath: string, tool: ToolType, mode: TreeSide) => string;
  exists: (targetPath: string) => Promise<boolean>;
  copyNode: (sourcePath: string, destinationPath: string) => Promise<void>;
  persistGroups: (
    next: SelectionGroup[],
    selectedGroupId: string | null,
    options?: { skipExistenceValidation?: boolean }
  ) => Promise<void>;
  groupsEquivalent: (left: SelectionGroup, right: SelectionGroup) => boolean;
};

export function createAgentCopyTools(deps: AgentCopyDeps): {
  runAgentCopyWizard: (forcedSide?: TreeSide, sourceNode?: SkillTreeNode) => Promise<void>;
  runGroupAgentCopyWizard: (forcedSide?: TreeSide, groupNode?: GroupTreeNode) => Promise<void>;
} {
  const resolveAgentCopyAssets = async (side: TreeSide, sourceNode?: SkillTreeNode): Promise<WizardAssetPick[] | undefined> => {
    const assetPicks = deps.getWizardAssetPicks(side);
    const assetsByTarget = new Map(assetPicks.map((asset) => [`${asset.tool}:${asset.rootRelativePath}`, asset]));
    const selectedNodes = deps.getSelectedNodes(side).filter((node) => node.kind === "file" || node.kind === "folder");
    const selectedIncludesSource = !!sourceNode && selectedNodes.some((node) => node.key === sourceNode.key);
    const candidateNodes = selectedNodes.length > 1 && (!sourceNode || selectedIncludesSource)
      ? selectedNodes
      : sourceNode
        ? [sourceNode]
        : selectedNodes;

    if (candidateNodes.length > 0) {
      const targets = deps.buildGroupTargetsFromNodes(candidateNodes);
      const assets = deps.dedupeWizardAssets(
        targets
          .map((target) => assetsByTarget.get(`${target.tool}:${target.relativePath}`))
          .filter((asset): asset is WizardAssetPick => !!asset)
      );
      if (assets.length > 0) return assets;
      vscode.window.showWarningMessage(deps.tr("Only valid skill folders can be copied between agents."));
      return undefined;
    }

    const asset = await deps.pickWizardAsset(side, deps.tr("Choose the source skill to copy"));
    return asset ? [asset] : undefined;
  };

  const runAgentCopyWizard = async (forcedSide?: TreeSide, sourceNode?: SkillTreeNode): Promise<void> => {
    if (!deps.workspacePath() || !deps.centralRepoPath()) await deps.refresh();
    const side = forcedSide ?? await deps.pickWizardSide(deps.tr("Choose where to copy between agents"));
    if (!side) return;
    const basePath = side === "workspace" ? deps.workspacePath() : deps.centralRepoPath();

    const pickedAssets = await resolveAgentCopyAssets(side, sourceNode);
    if (!pickedAssets || pickedAssets.length === 0) return;
    const validAssets: Array<WizardAssetPick & { sourceAbs: string }> = [];
    for (const asset of pickedAssets) {
      if (asset.status === "missingSkillMd") continue;
      const sourceRoot = deps.getSkillRoot(basePath, asset.tool, side);
      const sourceAbs = path.join(sourceRoot, asset.rootRelativePath);
      if (await deps.exists(path.join(sourceAbs, "SKILL.md"))) {
        validAssets.push({ ...asset, sourceAbs });
      }
    }
    if (validAssets.length === 0) {
      vscode.window.showWarningMessage(deps.tr("No selected skills with SKILL.md are available to copy."));
      return;
    }
    const skippedCount = pickedAssets.length - validAssets.length;

    const sourceTools = new Set(validAssets.map((asset) => asset.tool));
    const targetAgents = deps.agents().filter((tool) => !sourceTools.has(tool));
    if (targetAgents.length === 0) {
      vscode.window.showWarningMessage(deps.tr("There are no other configured agents to copy to."));
      return;
    }
    const targetTool = await vscode.window.showQuickPick(
      [
        {
          label: deps.tr("All Other Agents"),
          description: deps.tr("Copy into every other configured agent folder on this side"),
          detail: targetAgents.map((tool) => tool === "agents" ? ".agents" : `.${tool}`).join(", "),
          value: "all" as const
        },
        ...targetAgents.map((tool) => ({
          label: tool === "agents" ? ".agents" : `.${tool}`,
          description: side === "workspace" ? deps.tr("Workspace agent folder") : deps.tr("Central agent folder"),
          value: tool
        }))
      ],
      {
        title: side === "workspace" ? deps.tr("Choose Workspace Target Agent") : deps.tr("Choose Central Target Agent"),
        matchOnDescription: true,
        matchOnDetail: true
      }
    );
    if (!targetTool) return;
    const selectedTargetAgents = targetTool.value === "all" ? targetAgents : [targetTool.value];
    const targetInfos = await Promise.all(selectedTargetAgents.flatMap((tool) =>
      validAssets.map(async (asset) => {
        const targetRoot = deps.getWritableSkillRoot(basePath, tool, side);
        const targetAbs = path.join(targetRoot, asset.rootRelativePath);
        return {
          tool,
          asset,
          targetRoot,
          targetAbs,
          exists: await deps.exists(targetAbs)
        };
      })
    ));
    const existingTargets = targetInfos.filter((info) => info.exists);
    if (existingTargets.length > 0) {
      const ok = await vscode.window.showWarningMessage(
        deps.tr("{0} target skill folder(s) already exist. Update them from the selected skills?", String(existingTargets.length)),
        { modal: true },
        deps.tr("Update")
      );
      if (ok !== deps.tr("Update")) return;
    }
    const confirm = await vscode.window.showInformationMessage(
      deps.tr("Copy {0} selected skill(s) to {1} agent target(s)?", String(validAssets.length), String(selectedTargetAgents.length)),
      { modal: true },
      deps.tr("Copy")
    );
    if (confirm !== deps.tr("Copy")) return;

    for (const info of targetInfos) {
      if (info.exists) {
        await fs.rm(info.targetAbs, { recursive: true, force: true });
      }
      await fs.mkdir(info.targetRoot, { recursive: true });
      await deps.copyNode(info.asset.sourceAbs, info.targetAbs);
    }
    const targetLabel = targetTool.value === "all"
      ? deps.tr("all other agents ({0})", String(selectedTargetAgents.length))
      : `${targetTool.value}`;
    const skipSuffix = skippedCount > 0 ? deps.tr(" · skipped invalid skills {0}", String(skippedCount)) : "";
    vscode.window.showInformationMessage(deps.tr("Copied between agents on {0}: {1} skill(s) → {2}{3}", String(side), String(validAssets.length), String(targetLabel), String(skipSuffix)));
  };

  const runGroupAgentCopyWizard = async (forcedSide?: TreeSide, groupNode?: GroupTreeNode): Promise<void> => {
    try {
      if (!deps.workspacePath() || !deps.centralRepoPath()) await deps.refresh();
      const group = deps.resolveGroup(groupNode);
      if (!group) {
        vscode.window.showWarningMessage(deps.tr("Select a group first."));
        return;
      }
      const side = forcedSide ?? group.side;
      if (group.side !== side) {
        vscode.window.showWarningMessage(deps.tr("The selected group does not belong to this panel."));
        return;
      }
      const sourceTool = deps.getGroupTool(group);
      if (!sourceTool) {
        vscode.window.showWarningMessage(deps.tr("Could not find the source agent for this group."));
        return;
      }

      const sourceTargets = deps.dedupeGroupTargets(
        group.targets.filter((target) => target.tool === sourceTool && deps.isManagedSkillPath(target.relativePath))
      );
      if (sourceTargets.length === 0) {
        vscode.window.showWarningMessage(deps.tr("This group does not contain valid skill folders."));
        return;
      }

      const basePath = side === "workspace" ? deps.workspacePath() : deps.centralRepoPath();
      const sourceRoot = deps.getSkillRoot(basePath, sourceTool, side);
      const validTargets: Array<{ target: GroupTarget; sourceAbs: string }> = [];
      for (const target of sourceTargets) {
        const sourceAbs = path.join(sourceRoot, target.relativePath);
        if (await deps.exists(path.join(sourceAbs, "SKILL.md"))) {
          validTargets.push({ target, sourceAbs });
        }
      }
      if (validTargets.length === 0) {
        vscode.window.showWarningMessage(deps.tr("No valid group skills with SKILL.md were found to copy."));
        return;
      }
      const skippedCount = sourceTargets.length - validTargets.length;

      const targetAgents = deps.agents().filter((tool) => tool !== sourceTool);
      if (targetAgents.length === 0) {
        vscode.window.showWarningMessage(deps.tr("There are no other configured agents to copy this group to."));
        return;
      }
      const targetPick = await vscode.window.showQuickPick(
        [
          {
            label: deps.tr("All Other Agents"),
            description: deps.tr("Copy this group and its skills into every other configured agent"),
            detail: targetAgents.map((tool) => tool === "agents" ? ".agents" : `.${tool}`).join(", "),
            value: "all" as const
          },
          ...targetAgents.map((tool) => ({
            label: tool === "agents" ? ".agents" : `.${tool}`,
            description: side === "workspace" ? deps.tr("Workspace target agent") : deps.tr("Central target agent"),
            value: tool
          }))
        ],
        {
          title: side === "workspace" ? deps.tr("Choose Workspace Target Agent for Group") : deps.tr("Choose Central Target Agent for Group"),
          matchOnDescription: true,
          matchOnDetail: true
        }
      );
      if (!targetPick) return;

      const selectedTargetAgents = targetPick.value === "all" ? targetAgents : [targetPick.value];
      const copyTargets = await Promise.all(selectedTargetAgents.flatMap((tool) =>
        validTargets.map(async (item) => {
          const targetRoot = deps.getWritableSkillRoot(basePath, tool, side);
          const targetAbs = path.join(targetRoot, item.target.relativePath);
          return {
            tool,
            relativePath: item.target.relativePath,
            sourceAbs: item.sourceAbs,
            targetAbs,
            exists: await deps.exists(targetAbs)
          };
        })
      ));

      const existingTargets = copyTargets.filter((item) => item.exists);
      if (existingTargets.length > 0) {
        const ok = await vscode.window.showWarningMessage(
          deps.tr("{0} target skill folder(s) already exist. Update them from group \"{1}\"?", String(existingTargets.length), String(group.name)),
          { modal: true },
          deps.tr("Update")
        );
        if (ok !== deps.tr("Update")) return;
      }

      const confirm = await vscode.window.showInformationMessage(
        deps.tr("Copy group \"{0}\" from {1} {2} to {3} agent target(s)?", String(group.name), String(side), String(sourceTool), String(selectedTargetAgents.length)),
        { modal: true },
        deps.tr("Copy")
      );
      if (confirm !== deps.tr("Copy")) return;

      for (const item of copyTargets) {
        if (item.exists) {
          await fs.rm(item.targetAbs, { recursive: true, force: true });
        }
        await fs.mkdir(path.dirname(item.targetAbs), { recursive: true });
        await deps.copyNode(item.sourceAbs, item.targetAbs);
      }

      await deps.refresh();
      const nextGroups = [...deps.groups()];
      let changedGroups = 0;
      for (const targetTool of selectedTargetAgents) {
        const nextTargets = deps.dedupeGroupTargets(validTargets.map((item) => ({
          kind: "folder" as const,
          tool: targetTool,
          relativePath: item.target.relativePath
        })));
        const mirrorKey = `${side}:${group.id}:${targetTool}`;
        const existingIndex = nextGroups.findIndex((item) =>
          item.side === side
          && item.meta?.mirroredFrom === mirrorKey
        );
        const existing = existingIndex >= 0 ? nextGroups[existingIndex] : undefined;
        const copiedGroup: SelectionGroup = {
          ...group,
          id: existing?.id ?? `${side}-${targetTool}-${Date.now()}-${changedGroups}`,
          side,
          targets: nextTargets,
          meta: {
            ...group.meta,
            source: group.meta?.source ?? "manual",
            mirroredFrom: mirrorKey
          }
        };
        if (existing) {
          if (deps.groupsEquivalent(existing, copiedGroup)) continue;
          nextGroups[existingIndex] = copiedGroup;
        } else {
          nextGroups.push(copiedGroup);
        }
        changedGroups += 1;
      }

      if (changedGroups > 0) {
        await deps.persistGroups(nextGroups, group.id);
      }
      await deps.refresh();
      const targetLabel = targetPick.value === "all"
        ? deps.tr("all other agents ({0})", String(selectedTargetAgents.length))
        : `${targetPick.value}`;
      const skipSuffix = skippedCount > 0 ? deps.tr(" · skipped invalid skills {0}", String(skippedCount)) : "";
      vscode.window.showInformationMessage(deps.tr("Copied group between agents on {0}: {1} → {2} · skills {3} · groups {4}{5}", String(side), String(group.name), String(targetLabel), String(validTargets.length), String(changedGroups), String(skipSuffix)));
    } catch (error) {
      await deps.handleError(error);
    }
  };

  return {
    runAgentCopyWizard,
    runGroupAgentCopyWizard
  };
}
