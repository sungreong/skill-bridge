import { promises as fs } from "node:fs";
import path from "node:path";
import { existsPath } from "./shared";
import { groupStorePath, legacyGroupStorePath } from "./storagePaths";
import type { WorkspaceGroupFile } from "./types";

export async function loadWorkspaceGroupFile(workspacePath: string): Promise<WorkspaceGroupFile> {
  const target = await resolveExistingGroupStorePath(workspacePath);
  if (!(await existsPath(target))) {
    return { version: 1, groups: [] };
  }

  try {
    const raw = await fs.readFile(target, "utf8");
    const parsed = JSON.parse(raw) as Partial<WorkspaceGroupFile>;
    const groups = Array.isArray(parsed.groups) ? parsed.groups : [];
    return {
      version: 1,
      groups: groups
        .filter((group) => group && typeof group.id === "string" && typeof group.name === "string")
        .map((group) => ({
          id: group.id,
          name: group.name,
          description: typeof group.description === "string" ? group.description : "",
          side: group.side === "central" ? "central" : "workspace",
          targets: Array.isArray(group.targets)
            ? group.targets
                .filter((target) => target && (target.kind === "file" || target.kind === "folder"))
                .map((target) => ({
                  kind: target.kind!,
                  tool: target.tool!,
                  relativePath: String(target.relativePath ?? "")
                }))
            : []
        }))
    };
  } catch {
    return { version: 1, groups: [] };
  }
}

export async function saveWorkspaceGroupFile(workspacePath: string, data: WorkspaceGroupFile): Promise<void> {
  const target = groupStorePath(workspacePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify({ version: 1, groups: data.groups ?? [] }, null, 2), "utf8");
}

async function resolveExistingGroupStorePath(workspacePath: string): Promise<string> {
  const current = groupStorePath(workspacePath);
  if (await existsPath(current)) return current;
  return legacyGroupStorePath(workspacePath);
}
