export type ToolType = "claude" | "codex" | "gemini" | "cursor" | "antigravity" | "agents";

export const ALL_AGENTS: ToolType[] = ["claude", "codex", "gemini", "cursor", "antigravity", "agents"];

export type SkillFile = {
  tool: ToolType;
  relativePath: string;
  absolutePath: string;
};

export type InstructionFile = {
  relativePath: string;
  absolutePath: string;
  displayPath?: string;
  profileId?: string;
};

export type SkillAssetWarningSeverity = "info" | "warning" | "danger";

export type SkillAssetWarning = {
  code:
    | "missing-skill-md"
    | "duplicate-name"
    | "broken-reference"
    | "sensitive-content"
    | "workspace-specific-path"
    | "script-file"
    | "target-newer";
  severity: SkillAssetWarningSeverity;
  message: string;
  relativePath?: string;
};

export type SkillAssetTreeStatus = "same" | "new" | "changed" | "missingSkillMd" | "risk" | "recent";

export type SkillAssetTreeMeta = {
  status: SkillAssetTreeStatus;
  warnings: SkillAssetWarning[];
  fileCount: number;
  updatedAt: string | null;
};

export type SkillTreeFilterMode = "all" | "changed" | "new" | "risk" | "missingSkillMd" | "recent";

export type SkillTreeNode = {
  key: string;
  kind:
    | "file"
    | "folder"
    | "instructionRoot"
    | "instructionFolder"
    | "instructionFile"
    | "groupRoot"
    | "groupTool"
    | "group"
    | "skillGroup"
    | "presetRoot"
    | "preset"
    | "toolSection"
    | "toolCommand";
  tool: ToolType;
  relativePath: string;
  absolutePath?: string;
  label: string;
  children: SkillTreeNode[];
  description?: string;
  highlighted?: boolean;
  assetStatus?: SkillAssetTreeStatus;
  assetWarnings?: SkillAssetWarning[];
  assetFileCount?: number;
  assetUpdatedAt?: string | null;
  treeFileCount?: number;
  treeSkillCount?: number;
  side?: "workspace" | "central";
  instructionProfile?: string;
  groupId?: string;
  presetId?: string;
  commandId?: string;
  icon?: string;
  count?: number;
  collapsed?: boolean;
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
  description?: string;
  side: "workspace" | "central";
  targets: GroupTarget[];
  meta?: {
    source?: "manual" | "npx" | "mixed";
    tool?: ToolType;
    repoKey?: string;
    repoUrl?: string;
    lastInstalledAt?: string;
    installCwd?: string;
    installSkills?: string[];
    mirroredFrom?: string;
  };
};

export type WorkspaceGroupFile = {
  version: 1 | 2;
  groups: SelectionGroup[];
};

export type ProjectPreset = {
  id: string;
  name: string;
  description: string;
  targets: GroupTarget[];
  createdAt: string;
  updatedAt: string;
  lastAppliedAt?: string;
};

export type ProjectPresetsFile = {
  version: 1;
  updatedAt: string;
  presets: ProjectPreset[];
};

export type PersonalSkillPack = ProjectPreset & {
  lastHydratedAt?: string;
};

export type CentralPacksFile = {
  version: 1;
  updatedAt: string;
  packs: PersonalSkillPack[];
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
  scopeContext?: {
    type: "all" | "selection" | "group";
    label: string;
    count: number;
    expandable: boolean;
  };
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
