import * as vscode from "vscode";
import type { GroupTarget, ProjectPreset, ProjectPresetsFile, SelectionGroup, SkillFile } from "./types";

type TranslationFn = (message: string, ...args: Array<string | number | boolean>) => string;

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
  handleError: (error: unknown) => Promise<void>;
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
        vscode.window.showInformationMessage(args.tr("Central metadata is already up to date."));
        return;
      }

      const ok = await vscode.window.showWarningMessage(
        formatConfirmMessage(args.tr, summary),
        { modal: true },
        args.tr("Repair Metadata")
      );
      if (ok !== args.tr("Repair Metadata")) return;

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
      await args.handleError(error);
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
  return tr("Repair Central metadata now? This will remove {0} missing preset targets, update {1} presets, remove {2} missing central group targets, remove {3} empty central groups, and split {4} mixed-agent central groups.", String(summary.presetTargetCount), String(summary.presetCount), String(summary.centralGroupTargetCount), String(summary.centralGroupCount), String(summary.centralGroupSplitCount));
}

function formatDoneMessage(tr: TranslationFn, summary: RepairSummary): string {
  return tr("Central metadata repaired: presets {0}, preset targets removed {1}, central groups removed {2}, central group targets removed {3}.", String(summary.presetCount), String(summary.presetTargetCount), String(summary.centralGroupCount), String(summary.centralGroupTargetCount));
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
