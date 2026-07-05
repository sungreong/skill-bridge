import * as vscode from "vscode";
import { promises as fs } from "node:fs";
import type { GroupTarget, SelectionGroup, SkillFile, ToolType, TransferPlan, TransferStatus } from "./types";
import type { TransferScopeHint } from "./extensionTransferManager";
import { findMirroredGroupIndexes } from "./groupMirrorMatching";

type TreeSide = "workspace" | "central";

export function createExtensionLibraryTransferTools(args: {
  tr: (english: string, korean: string) => string;
  state: {
    workspacePath: string;
    centralRepoPath: string;
    workspaceSkills: SkillFile[];
    centralSkills: SkillFile[];
    groups: SelectionGroup[];
    selectedGroupId: string | null;
  };
  refresh: () => Promise<unknown>;
  exists: (path: string) => Promise<boolean>;
  resolveSkillPath: (basePath: string, tool: ToolType, relativePath: string, side: TreeSide) => string;
  getSkillFolderRelativePath: (relativePath: string) => string | null;
  normalizeRel: (input: string) => string;
  isManagedSkillPath: (relativePath: string) => boolean;
  isToolType: (value: string) => value is ToolType;
  uniqueSelections: (selections: Array<{ tool: ToolType; relativePath: string }>) => Array<{ tool: ToolType; relativePath: string }>;
  transferSelections: (
    side: TreeSide,
    selections: Array<{ tool: ToolType; relativePath: string }>,
    options?: { scopeHints?: TransferScopeHint[] }
  ) => Promise<{ copied: number; deleted: number; unchanged: number; appliedScopeHints: TransferScopeHint[]; affectedGroupIds: string[] }>;
  mirrorGroupsByIds: (side: TreeSide, groupIds: string[]) => Promise<number>;
  selectPreferredGroupIds: (side: TreeSide, groupIds: string[], preferredGroupIds?: string[]) => string[];
  buildTransferPlan: (sourceSide: TreeSide, selections: Array<{ tool: ToolType; relativePath: string }>, options?: { scopeHints?: TransferScopeHint[] }) => Promise<TransferPlan>;
  openTransferManagerTab: (plan: TransferPlan, rebuildPlan: () => Promise<TransferPlan>) => Promise<TransferPlan | null | undefined>;
  applyTransferPlan: (items: TransferPlan["items"], sourceProjectPath: string | null) => Promise<{ copied: number; deleted: number; unchanged: number }>;
  collectScopeHintsFromPlanItems: (items: TransferPlan["items"]) => TransferScopeHint[];
  collectAffectedGroupIdsForScopeHints: (side: TreeSide, scopeHints: TransferScopeHint[]) => string[];
  dedupeGroupTargets: (targets: GroupTarget[]) => GroupTarget[];
  targetExistsInFiles: (target: GroupTarget, files: SkillFile[]) => boolean;
  persistGroups: (
    next: SelectionGroup[],
    selectedGroupId: string | null,
    options?: { skipExistenceValidation?: boolean }
  ) => Promise<void>;
  getGroupTool: (group: SelectionGroup) => ToolType | null | undefined;
  groupsEquivalent: (left: SelectionGroup, right: SelectionGroup) => boolean;
}): {
  transferPathFromExplorer: (
    sourceSide: TreeSide,
    tool: ToolType,
    relativePath: string,
    kind: "file" | "folder",
    preferredGroupIds?: string[]
  ) => Promise<void>;
  transferSelectedPathsFromLibrary: (
    sourceSide: TreeSide,
    targets: Array<{ tool: ToolType; relativePath: string; kind: "file" | "folder" }>,
    preferredGroupIds?: string[]
  ) => Promise<{ requested: number; processed: number; copied: number; deleted: number; unchanged: number; skipped: number; mirroredGroups: number }>;
  transferComparedTargetsFromExplorer: (
    sourceSide: TreeSide,
    targets: Array<{ tool: ToolType; relativePath: string; kind: "file" | "folder" }>,
    selectedStatuses: TransferStatus[]
  ) => Promise<{ requested: number; processed: number; copied: number; deleted: number; unchanged: number; skipped: number; mirroredGroups: number }>;
  mirrorComparedGroupsFromExplorer: (sourceSide: TreeSide, groupIds: string[]) => Promise<{ changed: number; skipped: number }>;
  deleteComparedGroupsFromExplorer: (targetSide: TreeSide, groupIds: string[]) => Promise<{ changed: number; skipped: number }>;
  deleteLibraryTargets: (side: TreeSide, targets: Array<{ tool: ToolType; relativePath: string; kind: "file" | "folder" }>) => Promise<{ requested: number; deleted: number; skipped: number }>;
  collapseLibraryTargets: (targets: Array<{ tool: ToolType; relativePath: string; kind: "file" | "folder" }>) => Array<{ tool: ToolType; relativePath: string; kind: "file" | "folder" }>;
} {
  const getSideSkillFiles = (side: TreeSide): SkillFile[] =>
    side === "workspace" ? args.state.workspaceSkills : args.state.centralSkills;

  const collapseLibraryTargets = (
    targets: Array<{ tool: ToolType; relativePath: string; kind: "file" | "folder" }>
  ): Array<{ tool: ToolType; relativePath: string; kind: "file" | "folder" }> => {
    const deduped = [
      ...new Map(targets.map((target) => [
        `${target.tool}:${args.normalizeRel(target.relativePath)}:${target.kind}`,
        { ...target, relativePath: args.normalizeRel(target.relativePath) }
      ] as const)).values()
    ].sort((a, b) => {
      const folderOrder = (a.kind === "folder" ? 0 : 1) - (b.kind === "folder" ? 0 : 1);
      if (folderOrder !== 0) return folderOrder;
      if (a.relativePath.length !== b.relativePath.length) return a.relativePath.length - b.relativePath.length;
      return a.relativePath.localeCompare(b.relativePath);
    });

    const kept: Array<{ tool: ToolType; relativePath: string; kind: "file" | "folder" }> = [];
    for (const target of deduped) {
      const covered = kept.some((parent) => (
        parent.tool === target.tool
        && parent.kind === "folder"
        && (
          target.relativePath === parent.relativePath
          || target.relativePath.startsWith(`${parent.relativePath}/`)
        )
      ));
      if (!covered) kept.push(target);
    }
    return kept;
  };

  const transferPathFromExplorer = async (
    sourceSide: TreeSide,
    tool: ToolType,
    relativePath: string,
    kind: "file" | "folder",
    preferredGroupIds?: string[]
  ): Promise<void> => {
    const skillFolderRel = args.getSkillFolderRelativePath(relativePath);
    if (!skillFolderRel) {
      vscode.window.showWarningMessage(args.tr(`Not a skill folder path: ${tool}/${relativePath}`, `스킬 폴더 경로가 아닙니다: ${tool}/${relativePath}`));
      return;
    }
    const basePath = sourceSide === "workspace" ? args.state.workspacePath : args.state.centralRepoPath;
    const skillMdRel = `${skillFolderRel}/SKILL.md`;
    const skillMdAbs = args.resolveSkillPath(basePath, tool, skillMdRel, sourceSide);
    if (!(await args.exists(skillMdAbs))) {
      vscode.window.showWarningMessage(args.tr(`Skills without SKILL.md cannot be transferred: ${tool}/${skillFolderRel}`, `SKILL.md가 없는 스킬은 전송할 수 없습니다: ${tool}/${skillFolderRel}`));
      return;
    }

    const sourceFiles = getSideSkillFiles(sourceSide);
    const selections = args.uniqueSelections(
      sourceFiles
        .filter((file) => {
          if (file.tool !== tool) return false;
          if (kind === "file") return file.relativePath === relativePath;
          return file.relativePath === relativePath || file.relativePath.startsWith(`${relativePath}/`);
        })
        .map((file) => ({ tool: file.tool, relativePath: file.relativePath }))
    );
    if (selections.length === 0) {
      vscode.window.showWarningMessage(args.tr(`No valid skill was found to transfer: ${tool}/${skillFolderRel}`, `전송할 유효 스킬을 찾지 못했습니다: ${tool}/${skillFolderRel}`));
      return;
    }
    const scopeHints: TransferScopeHint[] = [{ kind, tool, relativePath }];
    const result = await args.transferSelections(sourceSide, selections, { scopeHints });
    await args.refresh();
    const mirroredGroups = await args.mirrorGroupsByIds(
      sourceSide,
      args.selectPreferredGroupIds(sourceSide, result.affectedGroupIds, preferredGroupIds)
    );
    const label = sourceSide === "workspace"
      ? args.tr("Workspace → Central", "작업공간 → 중앙")
      : args.tr("Central → Workspace", "중앙 → 작업공간");
    const groupSuffix = mirroredGroups > 0 ? args.tr(` · synced groups ${mirroredGroups}`, ` · 그룹 동기화 ${mirroredGroups}개`) : "";
    if (result.copied + result.deleted === 0) {
      vscode.window.showInformationMessage(args.tr(`${label}: ${tool}/${relativePath} no changes${groupSuffix}`, `${label}: ${tool}/${relativePath} 변경 없음${groupSuffix}`));
      return;
    }
    vscode.window.showInformationMessage(args.tr(
      `${label}: ${tool}/${relativePath} applied (copied ${result.copied}, deleted ${result.deleted})${groupSuffix}`,
      `${label}: ${tool}/${relativePath} 반영 완료 (복사 행 ${result.copied}개, 삭제 행 ${result.deleted}개)${groupSuffix}`
    ));
  };

  const transferSelectedPathsFromLibrary = async (
    sourceSide: TreeSide,
    targets: Array<{ tool: ToolType; relativePath: string; kind: "file" | "folder" }>,
    preferredGroupIds?: string[]
  ): Promise<{ requested: number; processed: number; copied: number; deleted: number; unchanged: number; skipped: number; mirroredGroups: number }> => {
    const dedupTargets = [
      ...new Map(
        targets
          .filter((target) => target.tool && target.relativePath)
          .map((target) => {
            const normalizedRel = args.normalizeRel(target.relativePath);
            const kind = target.kind === "file" ? "file" : "folder";
            return [`${target.tool}:${normalizedRel}:${kind}`, { tool: target.tool, relativePath: normalizedRel, kind }] as const;
          })
      ).values()
    ];
    if (dedupTargets.length === 0) {
      throw new Error(args.tr("Select targets before bulk moving.", "일괄 이동할 대상을 먼저 선택하세요."));
    }

    const basePath = sourceSide === "workspace" ? args.state.workspacePath : args.state.centralRepoPath;
    const sourceFiles = getSideSkillFiles(sourceSide);
    const scopeHints: TransferScopeHint[] = [];
    const selectedFiles: Array<{ tool: ToolType; relativePath: string }> = [];

    for (const target of dedupTargets) {
      const skillFolderRel = args.getSkillFolderRelativePath(target.relativePath);
      if (!skillFolderRel) continue;
      const skillMdRel = `${skillFolderRel}/SKILL.md`;
      const skillMdAbs = args.resolveSkillPath(basePath, target.tool, skillMdRel, sourceSide);
      if (!(await args.exists(skillMdAbs))) continue;

      const matched = sourceFiles.filter((file) => {
        if (file.tool !== target.tool) return false;
        if (target.kind === "file") return file.relativePath === target.relativePath;
        return file.relativePath === target.relativePath || file.relativePath.startsWith(`${target.relativePath}/`);
      });
      if (matched.length === 0) continue;

      selectedFiles.push(...matched.map((file) => ({ tool: file.tool, relativePath: file.relativePath })));
      scopeHints.push({ tool: target.tool, relativePath: target.relativePath, kind: target.kind });
    }

    const selections = args.uniqueSelections(selectedFiles);
    if (selections.length === 0 || scopeHints.length === 0) {
      throw new Error(args.tr("No transferable valid skills were found in the selected items.", "선택 항목 중 전송 가능한 유효 스킬을 찾지 못했습니다."));
    }

    const result = await args.transferSelections(sourceSide, selections, { scopeHints });
    await args.refresh();
    const mirroredGroups = await args.mirrorGroupsByIds(
      sourceSide,
      args.selectPreferredGroupIds(sourceSide, result.affectedGroupIds, preferredGroupIds)
    );
    return {
      requested: dedupTargets.length,
      processed: result.appliedScopeHints.length,
      copied: result.copied,
      deleted: result.deleted,
      unchanged: result.unchanged,
      skipped: Math.max(0, dedupTargets.length - result.appliedScopeHints.length),
      mirroredGroups
    };
  };

  const transferComparedTargetsFromExplorer = async (
    sourceSide: TreeSide,
    targets: Array<{ tool: ToolType; relativePath: string; kind: "file" | "folder" }>,
    selectedStatuses: TransferStatus[]
  ): Promise<{ requested: number; processed: number; copied: number; deleted: number; unchanged: number; skipped: number; mirroredGroups: number }> => {
    const requested = targets.length;
    const scopeHints = collapseLibraryTargets(
      targets
        .map((target) => ({ tool: target.tool, relativePath: args.normalizeRel(target.relativePath), kind: "folder" as const }))
        .filter((target) => !!args.getSkillFolderRelativePath(target.relativePath))
    );
    if (scopeHints.length === 0) {
      throw new Error(args.tr("No applicable skill folders were found.", "반영 가능한 스킬 폴더를 찾지 못했습니다."));
    }
    const selectedStatusSet = new Set(selectedStatuses);
    if (selectedStatusSet.size === 0) {
      throw new Error(args.tr("The same area has no changes to apply.", "동일 영역은 반영할 변경사항이 없습니다."));
    }

    const buildPreselectedPlan = async (): Promise<TransferPlan> => {
      const plan = await args.buildTransferPlan(sourceSide, [], { scopeHints });
      return { ...plan, items: plan.items.map((item) => ({ ...item, selected: selectedStatusSet.has(item.status) })) };
    };

    const plan = await buildPreselectedPlan();
    if (plan.items.filter((item) => item.selected).length === 0) {
      throw new Error(args.tr("The selected area has no changes to apply.", "선택한 영역에 반영할 변경사항이 없습니다."));
    }

    const resolved = await args.openTransferManagerTab(plan, buildPreselectedPlan);
    if (!resolved) {
      return { requested, processed: 0, copied: 0, deleted: 0, unchanged: 0, skipped: requested, mirroredGroups: 0 };
    }

    const result = await args.applyTransferPlan(resolved.items, sourceSide === "workspace" ? args.state.workspacePath : null);
    await args.refresh();
    const appliedScopeHints = args.collectScopeHintsFromPlanItems(resolved.items);
    const mirroredGroups = await args.mirrorGroupsByIds(sourceSide, args.collectAffectedGroupIdsForScopeHints(sourceSide, appliedScopeHints));
    return {
      requested,
      processed: appliedScopeHints.length,
      copied: result.copied,
      deleted: result.deleted,
      unchanged: result.unchanged,
      skipped: Math.max(0, requested - appliedScopeHints.length),
      mirroredGroups
    };
  };

  const mirrorComparedGroupsFromExplorer = async (
    sourceSide: TreeSide,
    groupIds: string[]
  ): Promise<{ changed: number; skipped: number }> => {
    const idSet = new Set(groupIds);
    const sourceGroups = args.state.groups.filter((group) => group.side === sourceSide && idSet.has(group.id));
    if (sourceGroups.length === 0) {
      return { changed: 0, skipped: groupIds.length };
    }

    const targetSide: TreeSide = sourceSide === "workspace" ? "central" : "workspace";
    const targetFiles = getSideSkillFiles(targetSide);
    const nextGroups = [...args.state.groups];
    let changed = 0;
    let skipped = Math.max(0, groupIds.length - sourceGroups.length);

    for (const sourceGroup of sourceGroups) {
      const mirrorKey = `${sourceGroup.side}:${sourceGroup.id}`;
      const matchingIndexes = findMirroredGroupIndexes({ groups: nextGroups, sourceGroup, targetSide, mirrorKey });
      const existingIndex = matchingIndexes[0] ?? -1;
      const duplicateIndexes = new Set(matchingIndexes.slice(1));
      const existing = existingIndex >= 0 ? nextGroups[existingIndex] : undefined;
      const now = new Date().toISOString();
      const normalizedTargets = args.dedupeGroupTargets(sourceGroup.targets.filter((target) => args.isManagedSkillPath(target.relativePath)));
      const mirroredTargets = normalizedTargets.filter((target) => args.targetExistsInFiles(target, targetFiles));
      if (mirroredTargets.length === 0) {
        if (matchingIndexes.length > 0) {
          const indexesToRemove = new Set(matchingIndexes);
          for (let index = nextGroups.length - 1; index >= 0; index -= 1) {
            if (indexesToRemove.has(index)) nextGroups.splice(index, 1);
          }
          changed += matchingIndexes.length;
        } else {
          skipped += 1;
        }
        continue;
      }

      const mirrored: SelectionGroup = {
        ...sourceGroup,
        id: existing?.id ?? `${targetSide}-${Date.now()}-${changed}`,
        side: targetSide,
        targets: mirroredTargets,
        meta: {
          ...sourceGroup.meta,
          source: sourceGroup.meta?.source ?? "manual",
          mirroredFrom: mirrorKey,
          lastInstalledAt: sourceGroup.meta?.source === "npx" ? now : sourceGroup.meta?.lastInstalledAt
        }
      };

      if (existing) {
        if (args.groupsEquivalent(existing, mirrored) && duplicateIndexes.size === 0) continue;
        nextGroups[existingIndex] = mirrored;
        for (const index of [...duplicateIndexes].sort((left, right) => right - left)) {
          nextGroups.splice(index, 1);
        }
        changed += 1;
      } else {
        nextGroups.push(mirrored);
        changed += 1;
      }
    }

    if (changed > 0) {
      await args.persistGroups(nextGroups, args.state.selectedGroupId);
    }
    return { changed, skipped };
  };

  const deleteComparedGroupsFromExplorer = async (
    targetSide: TreeSide,
    groupIds: string[]
  ): Promise<{ changed: number; skipped: number }> => {
    const idSet = new Set(groupIds);
    const targetGroups = args.state.groups.filter((group) => group.side === targetSide && idSet.has(group.id));
    if (targetGroups.length === 0) {
      return { changed: 0, skipped: groupIds.length };
    }

    const sideLabel = targetSide === "workspace" ? args.tr("Workspace", "작업공간") : args.tr("Central", "중앙");
    const preview = targetGroups.slice(0, 5).map((group) => `${args.getGroupTool(group) ?? "-"} / ${group.name}`).join("\n");
    const more = targetGroups.length > 5 ? args.tr(`\nand ${targetGroups.length - 5} more`, `\n외 ${targetGroups.length - 5}개`) : "";
    const ok = await vscode.window.showWarningMessage(
      args.tr(`Delete ${targetGroups.length} groups that exist only in ${sideLabel}?\n\n${preview}${more}`, `${sideLabel}에만 있는 그룹 ${targetGroups.length}개를 삭제할까요?\n\n${preview}${more}`),
      { modal: true },
      args.tr("Delete", "삭제")
    );
    if (ok !== args.tr("Delete", "삭제")) {
      return { changed: 0, skipped: groupIds.length };
    }

    const nextGroups = args.state.groups.filter((group) => !(group.side === targetSide && idSet.has(group.id)));
    await args.persistGroups(nextGroups, args.state.selectedGroupId, { skipExistenceValidation: true });
    return { changed: targetGroups.length, skipped: Math.max(0, groupIds.length - targetGroups.length) };
  };

  const deleteLibraryTargets = async (
    side: TreeSide,
    targets: Array<{ tool: ToolType; relativePath: string; kind: "file" | "folder" }>
  ): Promise<{ requested: number; deleted: number; skipped: number }> => {
    const collapsed = collapseLibraryTargets(targets);
    if (collapsed.length === 0) return { requested: 0, deleted: 0, skipped: 0 };

    const preview = collapsed.slice(0, 6).map((target) => `${target.tool}/${target.relativePath}`).join("\n");
    const more = collapsed.length > 6 ? args.tr(`\n...and ${collapsed.length - 6} more`, `\n...외 ${collapsed.length - 6}개`) : "";
    const sideLabel = side === "workspace" ? "Workspace" : "Central";
    const ok = await vscode.window.showWarningMessage(
      args.tr(`Delete ${collapsed.length} selected skill items from ${sideLabel}?\n\n${preview}${more}`, `${sideLabel}에서 선택한 스킬 항목 ${collapsed.length}개를 삭제할까요?\n\n${preview}${more}`),
      { modal: true },
      args.tr("Delete", "삭제")
    );
    if (ok !== args.tr("Delete", "삭제")) return { requested: collapsed.length, deleted: 0, skipped: collapsed.length };

    const basePath = side === "workspace" ? args.state.workspacePath : args.state.centralRepoPath;
    let deleted = 0;
    let skipped = 0;
    for (const target of collapsed) {
      const absolutePath = args.resolveSkillPath(basePath, target.tool, target.relativePath, side);
      if (!(await args.exists(absolutePath))) {
        skipped += 1;
        continue;
      }
      await fs.rm(absolutePath, { recursive: true, force: true });
      deleted += 1;
    }
    return { requested: collapsed.length, deleted, skipped };
  };

  return {
    transferPathFromExplorer,
    transferSelectedPathsFromLibrary,
    transferComparedTargetsFromExplorer,
    mirrorComparedGroupsFromExplorer,
    deleteComparedGroupsFromExplorer,
    deleteLibraryTargets,
    collapseLibraryTargets
  };
}
