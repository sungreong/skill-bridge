import * as vscode from "vscode";
import type { GroupTarget, ProjectPreset, ProjectPresetsFile, SelectionGroup, SkillFile } from "./types";

type TranslationFn = (english: string, korean: string) => string;

type RepairSummary = {
  presetCount: number;
  presetTargetCount: number;
  centralGroupCount: number;
  centralGroupTargetCount: number;
  centralGroupSplitCount: number;
};

export function createCentralMetadataRepairTools(args: {
  tr: TranslationFn;
  toUserError: (error: unknown) => string;
  state: {
    workspacePath: string;
    centralRepoPath: string;
    centralSkills: SkillFile[];
    centralProjectPresets: ProjectPreset[];
    groups: SelectionGroup[];
  };
  refresh: () => Promise<void>;
  loadProjectPresets: (centralRepoPath: string) => Promise<{ file: ProjectPresetsFile; migratedFromLegacy: boolean }>;
  saveProjectPresets: (centralRepoPath: string, file: ProjectPresetsFile) => Promise<void>;
  saveSelectionGroups: (workspacePath: string, centralRepoPath: string, groups: SelectionGroup[]) => Promise<void>;
  dedupeGroupTargets: (targets: GroupTarget[]) => GroupTarget[];
  targetExistsInFiles: (target: GroupTarget, files: SkillFile[]) => boolean;
  normalizeGroupsForCurrentSkills: (input: {
    input: SelectionGroup[];
    workspaceSkills: SkillFile[];
    centralSkills: SkillFile[];
    dedupeGroupTargets: (targets: GroupTarget[]) => GroupTarget[];
    targetExistsInFiles: (target: GroupTarget, files: SkillFile[]) => boolean;
  }) => {
    groups: SelectionGroup[];
    changed: boolean;
    splitCount: number;
    removedTargetCount: number;
    removedGroupCount: number;
  };
}): {
  repairCentralMetadata: () => Promise<void>;
} {
  const repairCentralMetadata = async (): Promise<void> => {
    try {
      await args.refresh();
      const loadedPresets = await args.loadProjectPresets(args.state.centralRepoPath);
      const presetRepair = repairPresets(loadedPresets.file.presets, args);
      const centralGroups = args.state.groups.filter((group) => group.side === "central");
      const workspaceGroups = args.state.groups.filter((group) => group.side === "workspace");
      const groupRepair = args.normalizeGroupsForCurrentSkills({
        input: centralGroups,
        workspaceSkills: [],
        centralSkills: args.state.centralSkills,
        dedupeGroupTargets: args.dedupeGroupTargets,
        targetExistsInFiles: args.targetExistsInFiles
      });
      const summary = buildSummary(presetRepair, groupRepair);
      if (!hasChanges(summary)) {
        vscode.window.showInformationMessage(args.tr(
          "Central metadata is already up to date.",
          "Central 메타데이터가 이미 최신 상태입니다."
        ));
        return;
      }

      const ok = await vscode.window.showWarningMessage(
        formatConfirmMessage(args.tr, summary),
        { modal: true },
        args.tr("Repair Metadata", "메타데이터 복구")
      );
      if (ok !== args.tr("Repair Metadata", "메타데이터 복구")) return;

      const now = new Date().toISOString();
      if (presetRepair.changed) {
        await args.saveProjectPresets(args.state.centralRepoPath, {
          version: 1,
          updatedAt: now,
          presets: presetRepair.presets
        });
      }
      if (groupRepair.changed) {
        args.state.groups = [...workspaceGroups, ...groupRepair.groups];
        await args.saveSelectionGroups(args.state.workspacePath, args.state.centralRepoPath, args.state.groups);
      }
      await args.refresh();
      vscode.window.showInformationMessage(formatDoneMessage(args.tr, summary));
    } catch (error) {
      vscode.window.showErrorMessage(args.toUserError(error));
    }
  };

  return { repairCentralMetadata };
}

function repairPresets(
  presets: ProjectPreset[],
  args: {
    dedupeGroupTargets: (targets: GroupTarget[]) => GroupTarget[];
    targetExistsInFiles: (target: GroupTarget, files: SkillFile[]) => boolean;
    state: { centralSkills: SkillFile[] };
  }
): { presets: ProjectPreset[]; changed: boolean; changedCount: number; removedTargetCount: number } {
  const now = new Date().toISOString();
  let changed = false;
  let changedCount = 0;
  let removedTargetCount = 0;
  const next = presets.map((preset) => {
    const deduped = args.dedupeGroupTargets(preset.targets);
    const valid = deduped.filter((target) => args.targetExistsInFiles(target, args.state.centralSkills));
    const presetChanged = !targetsEqual(preset.targets, valid);
    if (!presetChanged) return preset;
    changed = true;
    changedCount += 1;
    removedTargetCount += preset.targets.length - valid.length;
    return {
      ...preset,
      targets: valid,
      updatedAt: now
    };
  });
  return {
    presets: next.sort((a, b) => a.name.localeCompare(b.name)),
    changed,
    changedCount,
    removedTargetCount
  };
}

function buildSummary(
  presetRepair: { changedCount: number; removedTargetCount: number },
  groupRepair: { splitCount: number; removedTargetCount: number; removedGroupCount: number }
): RepairSummary {
  return {
    presetCount: presetRepair.changedCount,
    presetTargetCount: presetRepair.removedTargetCount,
    centralGroupCount: groupRepair.removedGroupCount,
    centralGroupTargetCount: groupRepair.removedTargetCount,
    centralGroupSplitCount: groupRepair.splitCount
  };
}

function hasChanges(summary: RepairSummary): boolean {
  return summary.presetCount > 0
    || summary.presetTargetCount > 0
    || summary.centralGroupCount > 0
    || summary.centralGroupTargetCount > 0
    || summary.centralGroupSplitCount > 0;
}

function formatConfirmMessage(tr: TranslationFn, summary: RepairSummary): string {
  return tr(
    `Repair Central metadata now? This will remove ${summary.presetTargetCount} missing preset targets, update ${summary.presetCount} presets, remove ${summary.centralGroupTargetCount} missing central group targets, remove ${summary.centralGroupCount} empty central groups, and split ${summary.centralGroupSplitCount} mixed-agent central groups.`,
    `Central 메타데이터를 지금 복구할까요? 누락된 프리셋 대상 ${summary.presetTargetCount}개, 수정될 프리셋 ${summary.presetCount}개, 누락된 중앙 그룹 대상 ${summary.centralGroupTargetCount}개, 빈 중앙 그룹 ${summary.centralGroupCount}개, 여러 에이전트가 섞인 중앙 그룹 분리 ${summary.centralGroupSplitCount}개를 반영합니다.`
  );
}

function formatDoneMessage(tr: TranslationFn, summary: RepairSummary): string {
  return tr(
    `Central metadata repaired: presets ${summary.presetCount}, preset targets removed ${summary.presetTargetCount}, central groups removed ${summary.centralGroupCount}, central group targets removed ${summary.centralGroupTargetCount}.`,
    `Central 메타데이터 복구 완료: 프리셋 ${summary.presetCount}개, 제거된 프리셋 대상 ${summary.presetTargetCount}개, 제거된 중앙 그룹 ${summary.centralGroupCount}개, 제거된 중앙 그룹 대상 ${summary.centralGroupTargetCount}개.`
  );
}

function targetsEqual(left: GroupTarget[], right: GroupTarget[]): boolean {
  if (left.length !== right.length) return false;
  const leftKeys = left.map(targetKey).sort();
  const rightKeys = right.map(targetKey).sort();
  return leftKeys.every((key, index) => key === rightKeys[index]);
}

function targetKey(target: GroupTarget): string {
  return `${target.kind}:${target.tool}:${target.relativePath}`;
}
