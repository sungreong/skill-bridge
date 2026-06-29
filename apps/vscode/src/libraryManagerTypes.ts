import type { SelectionGroup, SkillFile, ToolType } from "./types";

export type TreeSide = "workspace" | "central";

export type LibraryStatus = "added" | "removed" | "modified" | "typeChanged" | "same";

export type LibraryEntry = {
  key: string;
  tool: ToolType;
  relativePath: string;
  folder: string;
  innerPath: string;
  exists: boolean;
  status: LibraryStatus;
  createdAt: string | null;
  updatedAt: string | null;
  groupIds: string[];
  groupNames: string[];
};

export type LibraryGroupView = {
  id: string;
  name: string;
  targetSummary: string;
  targetCount: number;
  tools: ToolType[];
};

export type LibrarySideView = {
  entries: LibraryEntry[];
  groups: LibraryGroupView[];
};

export type LibraryPayload = {
  tools: ToolType[];
  workspace: LibrarySideView;
  central: LibrarySideView;
  diagnostics: {
    workspaceMissingSkillFolders: Array<{ tool: ToolType; relativePath: string }>;
    centralMissingSkillFolders: Array<{ tool: ToolType; relativePath: string }>;
  };
};

export type LibraryTarget = { tool: ToolType; relativePath: string; kind: "file" | "folder" };
export type GroupMutationSummary = { affectedCount: number; skippedCount: number };
export type CreateGroupSummary = { groupId: string; name: string; addedCount: number; skippedCount: number; tool: ToolType };

export type LibraryManagerStateShape = {
  workspacePath: string;
  centralRepoPath: string;
  workspaceSkills: SkillFile[];
  centralSkills: SkillFile[];
  workspaceMissingSkillFolders: Array<{ tool: ToolType; relativePath: string }>;
  centralMissingSkillFolders: Array<{ tool: ToolType; relativePath: string }>;
  workspaceAssetMeta: Map<string, { fileCount: number; updatedAt: string | null }>;
  centralAssetMeta: Map<string, { fileCount: number; updatedAt: string | null }>;
  groups: SelectionGroup[];
  agents: ToolType[];
};
