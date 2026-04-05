export type ToolType = "claude" | "codex" | "gemini" | "cursor" | "antigravity" | "agents";

export const ALL_AGENTS: ToolType[] = ["claude", "codex", "gemini", "cursor", "antigravity", "agents"];

export type SkillFile = {
  tool: ToolType;
  relativePath: string;
  absolutePath: string;
};

export type SkillTreeNode = {
  key: string;
  kind: "file" | "folder" | "groupRoot" | "groupTool" | "group";
  tool: ToolType;
  relativePath: string;
  label: string;
  children: SkillTreeNode[];
  highlighted?: boolean;
  side?: "workspace" | "central";
  groupId?: string;
  count?: number;
  selected?: boolean;
};

export type SkillSelection = {
  tool: ToolType;
  relativePath: string;
};

export type GroupTarget = {
  kind: "file" | "folder";
  tool: ToolType;
  relativePath: string;
};

export type SelectionGroup = {
  id: string;
  name: string;
  side: "workspace" | "central";
  targets: GroupTarget[];
  meta?: {
    source?: "manual" | "npx";
    repoKey?: string;
    repoUrl?: string;
    lastInstalledAt?: string;
    mirroredFrom?: string;
  };
};

export type WorkspaceGroupFile = {
  version: 1 | 2;
  groups: SelectionGroup[];
};

export type TransferStatus = "added" | "removed" | "modified" | "same" | "typeChanged";

export type TransferPlanItem = {
  key: string;
  tool: ToolType;
  relativePath: string;
  entryKind: "file" | "folder";
  changeKind: TransferStatus;
  src: string;
  dst: string;
  status: TransferStatus;
  reason: string;
  srcMtime: string | null;
  dstMtime: string | null;
  srcSize: number | null;
  dstSize: number | null;
  selected: boolean;
  groupType: "selected" | "mirror" | "manual" | "none";
  groupName: string | null;
};

export type TransferPlanSummary = {
  total: number;
  addedCount: number;
  removedCount: number;
  modifiedCount: number;
  typeChangedCount: number;
  sameCount: number;
  unchangedCount: number;
};

export type TransferPlan = {
  mode: "workspaceToCentral" | "centralToWorkspace";
  items: TransferPlanItem[];
  summary: TransferPlanSummary;
  groupContext?: {
    id: string;
    name: string;
    side: "workspace" | "central";
  };
  repoContext?: {
    repo: string;
  };
};

export type GroupTreeNode = {
  id: string;
  kind: "root" | "tool" | "group";
  side: "workspace" | "central";
  label: string;
  count: number;
  tool?: ToolType | "mixed";
  selected?: boolean;
};
