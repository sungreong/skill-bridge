import type { ToolType } from "./types";

export type TreeSide = "workspace" | "central";

export type GroupOverviewTarget = {
  path: string;
  kind: string;
  description: string;
  updatedAt: string;
  historyAt: string;
  historyProject: string;
};

export type GroupOverviewSkillFolder = {
  name: string;
  path: string;
  relativePath: string;
  tool: ToolType;
  files: GroupOverviewTarget[];
  latestUpdatedAt: string;
  latestHistoryAt: string;
  description: string;
};

export type GroupOverviewGroup = {
  id: string;
  name: string;
  description: string;
  side: TreeSide;
  agent: ToolType | "mixed";
  source: "manual" | "npx" | "mixed";
  sourceDetail: string;
  syncStatus: "same" | "workspaceOnly" | "centralOnly" | "different";
  health: "ready" | "needsDescription" | "brokenTargets";
  brokenTargetCount: number;
  targets: GroupOverviewTarget[];
  targetCount: number;
  latestUpdatedAt: string;
  latestHistoryAt: string;
};

export type GroupOverviewAgent = {
  agent: ToolType | "mixed";
  groups: GroupOverviewGroup[];
};

export type GroupOverviewData = {
  side: TreeSide;
  agentFilter: ToolType | "mixed" | null;
  groups: GroupOverviewGroup[];
  agents: GroupOverviewAgent[];
};
