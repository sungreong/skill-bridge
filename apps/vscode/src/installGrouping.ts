import type { GroupTarget, SkillFile, ToolType } from "./types";

function getSkillFolderRelativePath(relativePath: string): string | null {
  const parts = relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts[0] !== "skills" || !parts[1]) return null;
  return `skills/${parts[1]}`;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

export function extractInstalledSkillFolderNames(output: string): string[] {
  const names = new Set<string>();
  for (const rawLine of output.split(/\r?\n/)) {
    const line = stripAnsi(rawLine);
    const skillMdMatch = line.match(/skills[\\/]+([^/\\\s]+)[\\/]+SKILL\.md/i);
    if (skillMdMatch?.[1]) {
      names.add(skillMdMatch[1]);
      continue;
    }
    const folderMatch = line.match(/(?:^|[\\/])skills[\\/]+([^/\\\s]+)(?:[\\/]|[\s|]|$)/i);
    if (folderMatch?.[1]) names.add(folderMatch[1]);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

export function inferNewSkillFolderNames(beforeFiles: SkillFile[], afterFiles: SkillFile[]): string[] {
  const beforeKeys = new Set(beforeFiles.map((file) => `${file.tool}:${file.relativePath.replace(/\\/g, "/")}`));
  const names = new Set<string>();
  for (const file of afterFiles) {
    const relativePath = file.relativePath.replace(/\\/g, "/");
    if (beforeKeys.has(`${file.tool}:${relativePath}`)) continue;
    const skillFolderRel = getSkillFolderRelativePath(relativePath);
    if (!skillFolderRel) continue;
    const skillName = skillFolderRel.split("/")[1];
    if (skillName) names.add(skillName);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

export function buildGroupTargetsFromNames(items: SkillFile[], folderNames: string[]): GroupTarget[] {
  const names = new Set(folderNames.map((name) => name.trim()).filter(Boolean));
  const targets: GroupTarget[] = [];
  for (const item of items) {
    const skillFolderRel = getSkillFolderRelativePath(item.relativePath);
    if (!skillFolderRel) continue;
    const skillName = skillFolderRel.split("/")[1];
    if (!skillName || !names.has(skillName)) continue;
    if (targets.some((target) => target.tool === item.tool && target.relativePath === skillFolderRel)) continue;
    targets.push({ kind: "folder", tool: item.tool, relativePath: skillFolderRel });
  }
  return targets.sort((a, b) => a.tool.localeCompare(b.tool) || a.relativePath.localeCompare(b.relativePath));
}

export function getUniqueTargetTools(targets: GroupTarget[]): ToolType[] {
  return [...new Set(targets.map((target) => target.tool))].sort((a, b) => a.localeCompare(b));
}

export function collectSkillFolderSyncTargets(
  targets: GroupTarget[],
  tool?: ToolType
): Array<{ tool: ToolType; skillFolderRel: string }> {
  const entries = new Map<string, { tool: ToolType; skillFolderRel: string }>();
  for (const target of targets) {
    if (tool && target.tool !== tool) continue;
    const skillFolderRel = getSkillFolderRelativePath(target.relativePath);
    if (!skillFolderRel) continue;
    entries.set(`${target.tool}:${skillFolderRel}`, { tool: target.tool, skillFolderRel });
  }
  return [...entries.values()].sort((a, b) => a.tool.localeCompare(b.tool) || a.skillFolderRel.localeCompare(b.skillFolderRel));
}
