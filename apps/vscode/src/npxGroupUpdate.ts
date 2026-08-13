import type { NpxInstallPreset } from "./extensionInstallTransfer";
import type { SelectionGroup, ToolType } from "./types";

type TranslationFn = (message: string, ...args: Array<string | number | boolean>) => string;

export type NpxGroupUpdateArgs = {
  tr: TranslationFn;
  state: { workspacePath: string; centralRepoPath: string };
  getGroupTool: (group: SelectionGroup) => ToolType | "mixed" | null;
  installNpxRepoForSide: (side: SelectionGroup["side"], preset: NpxInstallPreset) => Promise<boolean>;
};

export function npxSkillNamesFromGroup(group: SelectionGroup): string[] {
  const metaSkills = group.meta?.installSkills?.filter((skill) => skill && skill !== "*") ?? [];
  const targetSkills = group.targets
    .map((target) => skillNameFromRelativePath(target.relativePath))
    .filter((skill) => !!skill);
  return [...new Set([...metaSkills, ...targetSkills])].sort((left, right) => left.localeCompare(right));
}

export function canUpdateNpxGroup(group: SelectionGroup): boolean {
  return group.meta?.source === "npx"
    && !!group.meta.repoUrl?.trim()
    && npxSkillNamesFromGroup(group).length > 0;
}

export async function updateNpxGroupFromMetadata(
  args: NpxGroupUpdateArgs,
  group: SelectionGroup,
  skipCommandConfirm: boolean
): Promise<boolean> {
  if (group.meta?.source !== "npx" && group.meta?.source !== "mixed") {
    throw new Error(args.tr("Only npx-tracked groups can be updated from npx."));
  }
  const repoUrl = group.meta.repoUrl?.trim() ?? "";
  if (!repoUrl) {
    throw new Error(args.tr("This npx group has no repo URL to update from."));
  }
  const skills = npxSkillNamesFromGroup(group);
  if (skills.length === 0) {
    throw new Error(args.tr("This npx group has no tracked skill folders."));
  }
  const groupTool = args.getGroupTool(group);
  return await args.installNpxRepoForSide(group.side, {
    repoUrl,
    skills,
    cwd: group.meta.installCwd?.trim() || (group.side === "workspace" ? args.state.workspacePath : args.state.centralRepoPath),
    tool: groupTool && groupTool !== "mixed" ? groupTool : undefined,
    skipCommandConfirm,
    skipPostInstallSyncPrompt: true
  });
}

function skillNameFromRelativePath(value: string): string {
  const parts = value.replace(/\\/g, "/").replace(/^\/+/, "").trim().split("/").filter(Boolean);
  const skillsIndex = parts.indexOf("skills");
  const folderParts = skillsIndex >= 0 && parts[skillsIndex + 1]
    ? parts.slice(0, skillsIndex + 2)
    : parts;
  return folderParts[folderParts.length - 1] ?? "";
}
