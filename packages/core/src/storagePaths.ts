import path from "node:path";

export const SKILL_BRIDGE_STATE_DIR = ".skillbridge";
export const LEGACY_SKILL_BRIDGE_STATE_DIR = ".skill-bridge";
export const GROUP_STORE_FILE = "skill-workspace.json";
export const LEGACY_GROUP_STORE_FILE = "skill_workspace.json";
export const GROUP_MARKDOWN_FILE = "SKILL_GROUP.md";
export const SKILLS_LOCK_FILE = "skills-lock.json";

export function skillBridgeStateDir(basePath: string): string {
  return path.join(basePath, SKILL_BRIDGE_STATE_DIR);
}

export function groupStorePath(basePath: string): string {
  return path.join(skillBridgeStateDir(basePath), GROUP_STORE_FILE);
}

export function legacyGroupStorePath(basePath: string): string {
  return path.join(basePath, LEGACY_GROUP_STORE_FILE);
}

export function groupMarkdownPath(basePath: string): string {
  return path.join(skillBridgeStateDir(basePath), GROUP_MARKDOWN_FILE);
}

export function legacyGroupMarkdownPath(basePath: string): string {
  return path.join(basePath, GROUP_MARKDOWN_FILE);
}

export function skillsLockPath(basePath: string): string {
  return path.join(skillBridgeStateDir(basePath), SKILLS_LOCK_FILE);
}

export function legacySkillsLockPath(basePath: string): string {
  return path.join(basePath, SKILLS_LOCK_FILE);
}
