import type { ToolType } from "./types";
import {
  isManagedSkillPath,
  isToolType,
  normalizeRel
} from "./extensionSupport";
import type { LibraryTarget } from "./libraryManagerTypes";

export const LIBRARY_WEBVIEW_COMMANDS = new Set<string>([
  "skillBridge.openTransferExplorer",
  "skillBridge.openAddMoveWizard",
  "skillBridge.hydrateProject",
  "skillBridge.downloadCentralSkill",
  "skillBridge.downloadSkillManagerSkill",
  "skillBridge.copyBetweenAgents",
  "skillBridge.toggleLanguage",
  "skillBridge.createCentralPack",
  "skillBridge.diagnoseEnvironment",
  "skillBridge.configureWorkspaceAutoSync",
  "skillBridge.syncWorkspaceAgentNow",
  "skillBridge.setPersonalHome",
  "skillBridge.resetPersonalHome",
  "skillBridge.openWorkspaceFolder",
  "skillBridge.openCentralFolder"
]);

export function parseLibraryTargets(rawTargets: unknown): LibraryTarget[] {
  return (Array.isArray(rawTargets) ? rawTargets : [])
    .map((target) => {
      const item = (target && typeof target === "object") ? target as { tool?: unknown; relativePath?: unknown; kind?: unknown } : {};
      const tool = isToolType(String(item.tool ?? "")) ? String(item.tool ?? "") as ToolType : null;
      const relativePath = normalizeRel(String(item.relativePath ?? ""));
      const kind = item.kind === "file" ? "file" : "folder";
      if (!tool || !relativePath || !isManagedSkillPath(relativePath)) return null;
      if (relativePath.toLowerCase() === "skills") return null;
      return { tool, relativePath, kind };
    })
    .filter((target): target is LibraryTarget => !!target);
}

export function parseGroupIds(rawGroupIds: unknown): string[] {
  return [...new Set((Array.isArray(rawGroupIds) ? rawGroupIds : []).map((item) => String(item ?? "")).filter(Boolean))];
}

export function suggestGroupNameForTargets(
  getSkillFolderRelativePath: (relativePath: string) => string | null,
  targets: Array<{ tool: ToolType; relativePath: string }>
): string {
  const first = targets[0];
  if (!first) return "new-skill-group";
  const skillNames = [...new Set(targets
    .map((target) => getSkillFolderRelativePath(target.relativePath)?.split("/")[1])
    .filter((name): name is string => !!name)
  )];
  if (skillNames.length === 1) return `${skillNames[0]}-group`;
  const commonPrefix = findCommonSkillPrefix(skillNames);
  if (commonPrefix && commonPrefix.length >= 3) return `${commonPrefix}-group`;
  return `${first.tool}-group`;
}

function findCommonSkillPrefix(names: string[]): string | null {
  if (names.length < 2) return null;
  const [first, ...rest] = names.map((name) => name.toLowerCase());
  let end = first.length;
  for (const name of rest) {
    while (end > 0 && !name.startsWith(first.slice(0, end))) {
      end -= 1;
    }
    if (end === 0) return null;
  }
  return first.slice(0, end).replace(/[-_]+$/g, "");
}
