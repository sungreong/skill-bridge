import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GLOBAL_WORKSPACE_ID, GLOBAL_WORKSPACE_NAME, TOOL_PATHS } from "./constants";
import type { AppConfig, ToolType } from "./types";

export function getConfigPath(): string {
  return path.join(os.homedir(), ".skill_bridge_config.json");
}

export async function loadConfig(): Promise<AppConfig> {
  try {
    const raw = await fs.readFile(getConfigPath(), "utf8");
    return normalizeConfig(JSON.parse(raw) as Partial<AppConfig>);
  } catch {
    return normalizeConfig({});
  }
}

export async function saveConfig(input: Partial<AppConfig>): Promise<AppConfig> {
  const current = await loadConfig();
  const next = normalizeConfig({ ...current, ...input });
  await fs.writeFile(getConfigPath(), JSON.stringify(next, null, 2), "utf8");
  return next;
}

function normalizeConfig(input: Partial<AppConfig>): AppConfig {
  const defaultCentral = path.join(os.homedir(), "skill-bridge-repo");
  const userWorkspaces = (input.workspaces ?? [])
    .filter((item) => item?.id && item?.path && item.id !== GLOBAL_WORKSPACE_ID)
    .map((item) => ({
      id: item.id,
      name: item.name || path.basename(item.path),
      path: item.path,
      autoRefreshSeconds: normalizeAutoRefreshSeconds(item.autoRefreshSeconds)
    }));

  const hasGlobal = hasGlobalSkillWorkspace();
  const homePath = os.homedir();
  const dedupedUser = hasGlobal
    ? userWorkspaces.filter((item) => path.resolve(item.path) !== path.resolve(homePath))
    : userWorkspaces;

  const workspaces = hasGlobal
    ? [{ id: GLOBAL_WORKSPACE_ID, name: GLOBAL_WORKSPACE_NAME, path: homePath, autoRefreshSeconds: 0 }, ...dedupedUser]
    : dedupedUser;

  const activeWorkspaceId = workspaces.some((item) => item.id === input.activeWorkspaceId)
    ? input.activeWorkspaceId!
    : workspaces[0]?.id ?? null;

  return {
    centralRepo: input.centralRepo?.trim() || defaultCentral,
    autoPush: input.autoPush ?? true,
    defaultTool: input.defaultTool ?? "claude",
    fontSize: Math.max(11, Math.min(22, input.fontSize ?? 15)),
    treeFontScale: normalizeTreeFontScale(input.treeFontScale),
    workspaces,
    activeWorkspaceId
  };
}

function normalizeAutoRefreshSeconds(value: unknown): number {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return 0;
  const integer = Math.floor(raw);
  if (integer < 0) return 0;
  if (integer > 3600) return 3600;
  return integer;
}

function normalizeTreeFontScale(value: unknown): number {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return 1;
  if (raw < 0.85) return 0.85;
  if (raw > 1.2) return 1.2;
  return Math.round(raw * 100) / 100;
}

function hasGlobalSkillWorkspace(): boolean {
  const home = os.homedir();
  for (const tool of Object.keys(TOOL_PATHS) as ToolType[]) {
    if (existsSync(path.join(home, TOOL_PATHS[tool].workspace))) {
      return true;
    }
  }
  return false;
}
