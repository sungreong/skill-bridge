import path from "node:path";

export const SKILL_BRIDGE_STATE_DIR = ".skillbridge";
export const LEGACY_SKILL_BRIDGE_STATE_DIR = ".skill-bridge";
export const GROUP_STORE_FILE = "skill-workspace.json";
export const LEGACY_GROUP_STORE_FILE = "skill_workspace.json";
export const GROUP_MARKDOWN_FILE = "SKILL_GROUP.md";
export const PROJECT_PRESETS_FILE = "project-presets.json";
export const PACKS_FILE = "packs.json";
export const SKILL_HISTORY_FILE = "skill-history.json";
export const LEGACY_SKILL_HISTORY_FILE = ".skill-bridge-history.json";
export const SKILLS_LOCK_FILE = "skills-lock.json";

export function skillBridgeStateDir(basePath: string): string {
  return path.join(basePath, SKILL_BRIDGE_STATE_DIR);
}

export function legacySkillBridgeStateDir(basePath: string): string {
  return path.join(basePath, LEGACY_SKILL_BRIDGE_STATE_DIR);
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

export function projectPresetStorePath(centralRepoPath: string): string {
  return path.join(skillBridgeStateDir(centralRepoPath), PROJECT_PRESETS_FILE);
}

export function legacyProjectPresetStorePath(centralRepoPath: string): string {
  return path.join(legacySkillBridgeStateDir(centralRepoPath), PROJECT_PRESETS_FILE);
}

export function packStorePath(centralRepoPath: string): string {
  return path.join(skillBridgeStateDir(centralRepoPath), PACKS_FILE);
}

export function legacyPackStorePath(centralRepoPath: string): string {
  return path.join(legacySkillBridgeStateDir(centralRepoPath), PACKS_FILE);
}

export function skillHistoryStorePath(centralRepoPath: string): string {
  return path.join(skillBridgeStateDir(centralRepoPath), SKILL_HISTORY_FILE);
}

export function legacySkillHistoryStorePath(centralRepoPath: string): string {
  return path.join(centralRepoPath, LEGACY_SKILL_HISTORY_FILE);
}

export function skillsLockPath(basePath: string): string {
  return path.join(skillBridgeStateDir(basePath), SKILLS_LOCK_FILE);
}

export function legacySkillsLockPath(basePath: string): string {
  return path.join(basePath, SKILLS_LOCK_FILE);
}
