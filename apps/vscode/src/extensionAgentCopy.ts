import { promises as fs } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import type { GroupTarget, GroupTreeNode, SelectionGroup, SkillTreeNode, ToolType } from "./types";
import type { WizardAssetPick } from "./extensionAddMoveWizard";

type TreeSide = "workspace" | "central";
type TranslationFn = (english: string, korean: string) => string;

type AgentCopyDeps = {
  tr: TranslationFn;
  toUserError: (error: unknown) => string;
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
      vscode.window.showWarningMessage(deps.tr("Only valid skill folders can be copied between agents.", "에이전트 간 복사는 유효한 스킬 폴더만 가능합니다."));
      return undefined;
    }

    const asset = await deps.pickWizardAsset(side, deps.tr("Choose the source skill to copy", "복사할 원본 스킬"));
    return asset ? [asset] : undefined;
  };

  const runAgentCopyWizard = async (forcedSide?: TreeSide, sourceNode?: SkillTreeNode): Promise<void> => {
    if (!deps.workspacePath() || !deps.centralRepoPath()) await deps.refresh();
    const side = forcedSide ?? await deps.pickWizardSide(deps.tr("Choose where to copy between agents", "에이전트 간 복사 위치"));
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
      vscode.window.showWarningMessage(deps.tr("No selected skills with SKILL.md are available to copy.", "복사할 수 있는 SKILL.md 포함 선택 스킬이 없습니다."));
      return;
    }
    const skippedCount = pickedAssets.length - validAssets.length;

    const sourceTools = new Set(validAssets.map((asset) => asset.tool));
    const targetAgents = deps.agents().filter((tool) => !sourceTools.has(tool));
    if (targetAgents.length === 0) {
      vscode.window.showWarningMessage(deps.tr("There are no other configured agents to copy to.", "복사할 다른 설정된 에이전트가 없습니다."));
      return;
    }
    const targetTool = await vscode.window.showQuickPick(
      [
        {
          label: deps.tr("All Other Agents", "다른 모든 에이전트"),
          description: deps.tr("Copy into every other configured agent folder on this side", "이 side의 설정된 다른 모든 에이전트 폴더로 복사"),
          detail: targetAgents.map((tool) => tool === "agents" ? ".agents" : `.${tool}`).join(", "),
          value: "all" as const
        },
        ...targetAgents.map((tool) => ({
          label: tool === "agents" ? ".agents" : `.${tool}`,
          description: side === "workspace" ? deps.tr("Workspace agent folder", "작업공간 에이전트 폴더") : deps.tr("Central agent folder", "중앙 에이전트 폴더"),
          value: tool
        }))
      ],
      {
        title: side === "workspace" ? deps.tr("Choose Workspace Target Agent", "작업공간 대상 에이전트 선택") : deps.tr("Choose Central Target Agent", "중앙 대상 에이전트 선택"),
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
        deps.tr(
          `${existingTargets.length} target skill folder(s) already exist. Update them from the selected skills?`,
          `${existingTargets.length}개 대상 스킬 폴더가 이미 있습니다. 선택한 스킬 내용으로 업데이트할까요?`
        ),
        { modal: true },
        deps.tr("Update", "업데이트")
      );
      if (ok !== deps.tr("Update", "업데이트")) return;
    }
    const confirm = await vscode.window.showInformationMessage(
      deps.tr(
        `Copy ${validAssets.length} selected skill(s) to ${selectedTargetAgents.length} agent target(s)?`,
        `선택한 스킬 ${validAssets.length}개를 에이전트 대상 ${selectedTargetAgents.length}개로 복사할까요?`
      ),
      { modal: true },
      deps.tr("Copy", "복사")
    );
    if (confirm !== deps.tr("Copy", "복사")) return;

    for (const info of targetInfos) {
      if (info.exists) {
        await fs.rm(info.targetAbs, { recursive: true, force: true });
      }
      await fs.mkdir(info.targetRoot, { recursive: true });
      await deps.copyNode(info.asset.sourceAbs, info.targetAbs);
    }
    const targetLabel = targetTool.value === "all"
      ? deps.tr(`all other agents (${selectedTargetAgents.length})`, `다른 모든 에이전트 (${selectedTargetAgents.length}개)`)
      : `${targetTool.value}`;
    const skipSuffix = skippedCount > 0 ? deps.tr(` · skipped invalid skills ${skippedCount}`, ` · 유효하지 않은 스킬 제외 ${skippedCount}개`) : "";
    vscode.window.showInformationMessage(deps.tr(
      `Copied between agents on ${side}: ${validAssets.length} skill(s) → ${targetLabel}${skipSuffix}`,
      `${side} 에이전트 간 복사 완료: 스킬 ${validAssets.length}개 → ${targetLabel}${skipSuffix}`
    ));
  };

  const runGroupAgentCopyWizard = async (forcedSide?: TreeSide, groupNode?: GroupTreeNode): Promise<void> => {
    try {
      if (!deps.workspacePath() || !deps.centralRepoPath()) await deps.refresh();
      const group = deps.resolveGroup(groupNode);
      if (!group) {
        vscode.window.showWarningMessage(deps.tr("Select a group first.", "그룹을 먼저 선택하세요."));
        return;
      }
      const side = forcedSide ?? group.side;
      if (group.side !== side) {
        vscode.window.showWarningMessage(deps.tr("The selected group does not belong to this panel.", "선택한 그룹이 이 패널에 속하지 않습니다."));
        return;
      }
      const sourceTool = deps.getGroupTool(group);
      if (!sourceTool) {
        vscode.window.showWarningMessage(deps.tr("Could not find the source agent for this group.", "이 그룹의 원본 에이전트를 찾을 수 없습니다."));
        return;
      }

      const sourceTargets = deps.dedupeGroupTargets(
        group.targets.filter((target) => target.tool === sourceTool && deps.isManagedSkillPath(target.relativePath))
      );
      if (sourceTargets.length === 0) {
        vscode.window.showWarningMessage(deps.tr("This group does not contain valid skill folders.", "이 그룹에는 유효한 스킬 폴더가 없습니다."));
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
        vscode.window.showWarningMessage(deps.tr("No valid group skills with SKILL.md were found to copy.", "복사할 수 있는 SKILL.md 포함 그룹 스킬이 없습니다."));
        return;
      }
      const skippedCount = sourceTargets.length - validTargets.length;

      const targetAgents = deps.agents().filter((tool) => tool !== sourceTool);
      if (targetAgents.length === 0) {
        vscode.window.showWarningMessage(deps.tr("There are no other configured agents to copy this group to.", "이 그룹을 복사할 다른 설정된 에이전트가 없습니다."));
        return;
      }
      const targetPick = await vscode.window.showQuickPick(
        [
          {
            label: deps.tr("All Other Agents", "다른 모든 에이전트"),
            description: deps.tr("Copy this group and its skills into every other configured agent", "이 그룹과 스킬을 설정된 다른 모든 에이전트로 복사"),
            detail: targetAgents.map((tool) => tool === "agents" ? ".agents" : `.${tool}`).join(", "),
            value: "all" as const
          },
          ...targetAgents.map((tool) => ({
            label: tool === "agents" ? ".agents" : `.${tool}`,
            description: side === "workspace" ? deps.tr("Workspace target agent", "작업공간 대상 에이전트") : deps.tr("Central target agent", "중앙 대상 에이전트"),
            value: tool
          }))
        ],
        {
          title: side === "workspace" ? deps.tr("Choose Workspace Target Agent for Group", "그룹을 복사할 작업공간 대상 에이전트 선택") : deps.tr("Choose Central Target Agent for Group", "그룹을 복사할 중앙 대상 에이전트 선택"),
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
          deps.tr(
            `${existingTargets.length} target skill folder(s) already exist. Update them from group "${group.name}"?`,
            `${existingTargets.length}개 대상 스킬 폴더가 이미 있습니다. 그룹 "${group.name}" 내용으로 업데이트할까요?`
          ),
          { modal: true },
          deps.tr("Update", "업데이트")
        );
        if (ok !== deps.tr("Update", "업데이트")) return;
      }

      const confirm = await vscode.window.showInformationMessage(
        deps.tr(
          `Copy group "${group.name}" from ${side} ${sourceTool} to ${selectedTargetAgents.length} agent target(s)?`,
          `${side}의 ${sourceTool} 그룹 "${group.name}"을 에이전트 대상 ${selectedTargetAgents.length}개로 복사할까요?`
        ),
        { modal: true },
        deps.tr("Copy", "복사")
      );
      if (confirm !== deps.tr("Copy", "복사")) return;

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
        ? deps.tr(`all other agents (${selectedTargetAgents.length})`, `다른 모든 에이전트 (${selectedTargetAgents.length}개)`)
        : `${targetPick.value}`;
      const skipSuffix = skippedCount > 0 ? deps.tr(` · skipped invalid skills ${skippedCount}`, ` · 유효하지 않은 스킬 제외 ${skippedCount}개`) : "";
      vscode.window.showInformationMessage(deps.tr(
        `Copied group between agents on ${side}: ${group.name} → ${targetLabel} · skills ${validTargets.length} · groups ${changedGroups}${skipSuffix}`,
        `${side} 에이전트 간 그룹 복사 완료: ${group.name} → ${targetLabel} · 스킬 ${validTargets.length}개 · 그룹 ${changedGroups}개${skipSuffix}`
      ));
    } catch (error) {
      vscode.window.showErrorMessage(deps.toUserError(error));
    }
  };

  return {
    runAgentCopyWizard,
    runGroupAgentCopyWizard
  };
}
