import * as vscode from "vscode";
import type {
  GroupTreeNode,
  InstructionFile,
  ProjectPreset,
  SelectionGroup,
  SkillAssetTreeMeta,
  SkillFile,
  SkillSelection,
  SkillTreeFilterMode,
  SkillTreeNode,
  ToolType
} from "../types";
import { localize, type UiLanguage } from "../uiLanguage";
import { buildEmbeddedCommonTools } from "./embeddedCommonTools";
import { buildPresetRoot } from "./projectPresetTree";

type SourceTab = "all" | ToolType[];

export class SkillTreeItem extends vscode.TreeItem {
  constructor(public readonly node: SkillTreeNode, commandId: string, private readonly language: UiLanguage) {
    super(node.label, collapsibleStateOf(node));
    this.contextValue = resolveContextValue(node);
    this.description = resolveDescription(node, this.language);
    this.tooltip = resolveTooltip(node, this.language);

    if ((node.kind === "group" || node.kind === "skillGroup") && node.groupId) {
      const payload: GroupTreeNode = {
        id: node.groupId ?? "",
        kind: "group",
        side: node.side === "central" ? "central" : "workspace",
        label: node.label,
        count: node.count ?? 0,
        selected: !!node.selected
      };
      this.command = {
        command: "skillBridge.selectGroup",
        title: localize(this.language, "Select Group", "그룹 선택"),
        arguments: [payload]
      };
    } else if (node.kind === "preset" && node.presetId) {
      this.command = {
        command: "skillBridge.openProjectPresetOverview",
        title: localize(this.language, "Open Project Preset Overview", "프로젝트 프리셋 개요 열기"),
        arguments: [node]
      };
    } else if (node.kind === "toolCommand" && node.commandId) {
      this.command = {
        command: node.commandId,
        title: node.label
      };
    } else if (node.kind === "file" || node.kind === "folder" || node.kind === "instructionFolder" || node.kind === "instructionFile") {
      this.command = {
        command: commandId,
        title: localize(this.language, "Select", "선택"),
        arguments: [node]
      };
    }

    const color = node.highlighted ? new vscode.ThemeColor("charts.blue") : undefined;
    this.iconPath = resolveIcon(node, color);
  }
}

function collapsibleStateOf(node: SkillTreeNode): vscode.TreeItemCollapsibleState {
  if (node.kind === "skillGroup") {
    return node.children.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
  }
  if (node.kind === "file" || node.kind === "instructionFile" || node.kind === "group" || node.kind === "preset" || node.kind === "toolCommand") return vscode.TreeItemCollapsibleState.None;
  if (node.kind === "toolSection") return node.collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded;
  if (node.kind === "groupRoot" || node.kind === "groupTool" || node.kind === "presetRoot") return vscode.TreeItemCollapsibleState.Expanded;
  return vscode.TreeItemCollapsibleState.Collapsed;
}

function resolveContextValue(node: SkillTreeNode): string {
  if (node.kind === "toolSection") return "skillBridge.embeddedToolSection";
  if (node.kind === "toolCommand") return "skillBridge.embeddedToolCommand";
  if (node.kind === "presetRoot") return "skillBridge.presetRoot.central";
  if (node.kind === "preset") return "skillBridge.preset.central";
  if (node.kind === "skillGroup") {
    return node.groupId
      ? `skillBridge.group.${node.side === "central" ? "central" : "workspace"}`
      : "skillBridge.virtualGroup";
  }
  if (node.kind === "groupRoot") return `skillBridge.groupRoot.${node.side === "central" ? "central" : "workspace"}`;
  if (node.kind === "groupTool") return `skillBridge.groupTool.${node.side === "central" ? "central" : "workspace"}`;
  if (node.kind === "group") return `skillBridge.group.${node.side === "central" ? "central" : "workspace"}`;
  if (node.kind === "instructionRoot") return "skillBridge.instructionRoot";
  if (node.kind === "instructionFolder") return "skillBridge.instructionFolder";
  if (node.kind === "instructionFile") return "skillBridge.instructionFile";
  if (node.kind === "file") return "skillBridge.file";
  const rel = node.relativePath.replace(/\\/g, "/");
  if (rel === "") return "skillBridge.folderRoot";
  if (rel === "skills") return "skillBridge.skillsRoot";
  return "skillBridge.folder";
}

function resolveDescription(node: SkillTreeNode, language: UiLanguage): string | undefined {
  if (node.kind === "toolSection" || node.kind === "toolCommand") {
    return node.description;
  }
  if (node.kind === "file") {
    return `${node.tool} · ${shortParentPath(node.relativePath, language)}`;
  }
  if (node.kind === "instructionFile") {
    return shortParentPath(node.relativePath, language);
  }
  if (node.kind === "instructionFolder") {
    return localize(language, `files ${countFiles(node)}`, `파일 ${countFiles(node)}`);
  }
  if (node.kind === "skillGroup") {
    return node.selected
      ? localize(language, `selected · skills ${node.count ?? 0}`, `선택됨 · 스킬 ${node.count ?? 0}`)
      : localize(language, `skills ${node.count ?? 0}`, `스킬 ${node.count ?? 0}`);
  }
  if (node.kind === "group") {
    return node.selected
      ? localize(language, `selected · targets ${node.count ?? 0}`, `선택됨 · 대상 ${node.count ?? 0}`)
      : localize(language, `targets ${node.count ?? 0}`, `대상 ${node.count ?? 0}`);
  }
  if (node.kind === "groupTool" || node.kind === "groupRoot") {
    return localize(language, `groups ${node.count ?? 0}`, `그룹 ${node.count ?? 0}`);
  }
  if (node.kind === "presetRoot") {
    return localize(language, `presets ${node.count ?? 0}`, `프리셋 ${node.count ?? 0}`);
  }
  if (node.kind === "preset") {
    const skills = node.count ?? 0;
    const agents = node.assetFileCount ?? 0;
    return localize(language, `skills ${skills} · agents ${agents}`, `스킬 ${skills} · 에이전트 ${agents}`);
  }
  if (node.relativePath === "") {
    return formatSkillTreeCount(node, language);
  }
  if (node.relativePath === "skills") {
    return formatSkillTreeCount(node, language);
  }
  if (node.assetStatus) {
    const labels: Record<string, string> = {
      same: localize(language, "same", "동일"),
      new: localize(language, "new skill", "새 스킬"),
      changed: localize(language, "changed", "변경"),
      missingSkillMd: localize(language, "missing SKILL.md", "SKILL.md 없음"),
      risk: localize(language, "warning", "경고"),
      recent: localize(language, "recent", "최근")
    };
    return labels[node.assetStatus] ?? node.assetStatus;
  }
  return undefined;
}

function resolveTooltip(node: SkillTreeNode, language: UiLanguage): string {
  if (node.kind === "toolSection" || node.kind === "toolCommand") {
    return node.description ? `${node.label} - ${node.description}` : node.label;
  }
  if (node.kind === "skillGroup") {
    const label = node.groupId
      ? localize(language, "Group", "그룹")
      : localize(language, "Ungrouped", "미분류");
    return localize(language, `${label}: ${node.label} (skills ${node.count ?? 0})`, `${label}: ${node.label} (스킬 ${node.count ?? 0})`);
  }
  if (node.kind === "group") {
    return localize(language, `${node.label} (targets ${node.count ?? 0})`, `${node.label} (대상 ${node.count ?? 0})`);
  }
  if (node.kind === "groupTool") {
    return localize(language, `${node.label} groups ${node.count ?? 0}`, `${node.label} 그룹 ${node.count ?? 0}`);
  }
  if (node.kind === "groupRoot") {
    return localize(
      language,
      `${node.side === "central" ? "Central" : "Workspace"} groups ${node.count ?? 0}`,
      `${node.side === "central" ? "중앙" : "작업공간"} 그룹 ${node.count ?? 0}`
    );
  }
  if (node.kind === "presetRoot") {
    return localize(language, `Central project presets ${node.count ?? 0}`, `중앙 프로젝트 프리셋 ${node.count ?? 0}`);
  }
  if (node.kind === "preset") {
    return node.description
      ? `${node.label}\n${node.description}`
      : localize(language, `Project preset: ${node.label}`, `프로젝트 프리셋: ${node.label}`);
  }
  if (node.kind === "instructionRoot") {
    return localize(
      language,
      `${node.side === "central" ? "Central" : "Workspace"} instruction files ${node.count ?? countFiles(node)}`,
      `${node.side === "central" ? "중앙" : "작업공간"} instruction 파일 ${node.count ?? countFiles(node)}`
    );
  }
  if (node.kind === "instructionFolder") {
    return localize(language, `instruction folder: ${node.relativePath} (files ${countFiles(node)})`, `instruction 폴더: ${node.relativePath} (파일 ${countFiles(node)})`);
  }
  if (node.kind === "instructionFile") {
    return `${localize(language, "instructions", "지침")}/${node.relativePath}${node.absolutePath ? `\n${node.absolutePath}` : ""}`;
  }
  const tool = node.tool;
  const rel = node.relativePath;
  const warnings = node.assetWarnings && node.assetWarnings.length > 0
    ? `\n\n${node.assetWarnings.map((warning) => `- ${warning.message}`).join("\n")}`
    : "";
  const asset = node.assetStatus
    ? localize(
      language,
      `\nStatus: ${assetStatusLabel(node.assetStatus, language)} · files ${node.assetFileCount ?? countFiles(node)}`,
      `\n상태: ${assetStatusLabel(node.assetStatus, language)} · 파일 ${node.assetFileCount ?? countFiles(node)}`
    )
    : "";
  return `${tool}/${rel}${asset}${warnings}`;
}

function assetStatusLabel(status: SkillAssetTreeMeta["status"], language: UiLanguage): string {
  if (status === "same") return localize(language, "same", "동일");
  if (status === "new") return localize(language, "new skill", "새 스킬");
  if (status === "changed") return localize(language, "changed", "변경");
  if (status === "missingSkillMd") return localize(language, "missing SKILL.md", "SKILL.md 없음");
  if (status === "risk") return localize(language, "warning", "경고");
  return localize(language, "recent", "최근");
}

function resolveIcon(node: SkillTreeNode, color: vscode.ThemeColor | undefined): vscode.ThemeIcon {
  if (node.kind === "toolSection" || node.kind === "toolCommand") {
    return new vscode.ThemeIcon(node.icon ?? "tools");
  }
  if (node.kind === "skillGroup") {
    if (!node.groupId) return new vscode.ThemeIcon("folder-library");
    return new vscode.ThemeIcon("tag", node.selected ? new vscode.ThemeColor("charts.green") : undefined);
  }
  if (node.kind === "groupRoot") {
    return new vscode.ThemeIcon(node.side === "central" ? "repo" : "folder");
  }
  if (node.kind === "groupTool") return new vscode.ThemeIcon("folder-library");
  if (node.kind === "group") {
    return new vscode.ThemeIcon("tag", node.selected ? new vscode.ThemeColor("charts.green") : undefined);
  }
  if (node.kind === "presetRoot") return new vscode.ThemeIcon("library");
  if (node.kind === "preset") return new vscode.ThemeIcon("package");
  if (node.kind === "instructionRoot") return new vscode.ThemeIcon("book");
  if (node.kind === "instructionFolder") return new vscode.ThemeIcon("folder-library", color);
  if (node.kind === "instructionFile") return new vscode.ThemeIcon("markdown", color);
  if (node.kind === "folder") {
    if (node.assetStatus === "missingSkillMd" || node.assetStatus === "risk") {
      return new vscode.ThemeIcon("warning", new vscode.ThemeColor("charts.orange"));
    }
    if (node.assetStatus === "new") {
      return new vscode.ThemeIcon("add", new vscode.ThemeColor("charts.green"));
    }
    if (node.assetStatus === "changed") {
      return new vscode.ThemeIcon("diff-modified", new vscode.ThemeColor("charts.yellow"));
    }
    if (node.assetStatus === "recent") {
      return new vscode.ThemeIcon("history", new vscode.ThemeColor("charts.blue"));
    }
    return new vscode.ThemeIcon("folder", color);
  }
  return new vscode.ThemeIcon("file", color);
}

function shortParentPath(relativePath: string, language: UiLanguage): string {
  const normalized = relativePath.replace(/\\/g, "/");
  const parent = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "";
  if (!parent) return localize(language, "root", "루트");
  if (parent.length <= 24) return parent;
  return `...${parent.slice(-24)}`;
}

function countFiles(node: SkillTreeNode): number {
  if (typeof node.treeFileCount === "number") return node.treeFileCount;
  const seen = new Set<string>();
  const walk = (entry: SkillTreeNode): void => {
    if (entry.kind === "file" || entry.kind === "instructionFile") {
      seen.add(`${entry.tool}:${entry.relativePath}`);
      return;
    }
    for (const child of entry.children) walk(child);
  };
  walk(node);
  return seen.size;
}

function countSkillFolders(node: SkillTreeNode): number {
  if (typeof node.treeSkillCount === "number") return node.treeSkillCount;
  const seen = new Set<string>();
  const walk = (entry: SkillTreeNode): void => {
    const skillFolder = getSkillFolderRelativePath(entry.relativePath);
    if (skillFolder) seen.add(`${entry.tool}:${skillFolder}`);
    for (const child of entry.children) walk(child);
  };
  walk(node);
  return seen.size;
}

function formatSkillTreeCount(node: SkillTreeNode, language: UiLanguage): string {
  const skillCount = countSkillFolders(node);
  const fileCount = countFiles(node);
  if (skillCount === 0) return localize(language, `files ${fileCount}`, `파일 ${fileCount}`);
  return localize(language, `skills ${skillCount} · files ${fileCount}`, `스킬 ${skillCount} · 파일 ${fileCount}`);
}

export class SkillTreeProvider implements vscode.TreeDataProvider<SkillTreeItem> {
  private readonly emitter = new vscode.EventEmitter<SkillTreeItem | undefined>();
  private roots: SkillTreeNode[] = [];
  private highlight = new Set<string>();
  private selected: SkillTreeNode | null = null;
  private skills: SkillFile[] = [];
  private instructions: InstructionFile[] = [];
  private groups: SelectionGroup[] = [];
  private projectPresets: ProjectPreset[] = [];
  private selectedGroupId: string | null = null;
  private activeTab: SourceTab = "all";
  private assetMeta = new Map<string, SkillAssetTreeMeta>();
  private missingSkillFolders: Array<{ tool: ToolType; relativePath: string }> = [];
  private filterMode: SkillTreeFilterMode = "all";
  private language: UiLanguage = "en";
  private batchDepth = 0;
  private needsRebuild = false;

  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly commandId: string,
    private readonly side: "workspace" | "central"
  ) {}

  setLanguage(language: UiLanguage): void {
    this.language = language;
    this.requestRebuild();
  }

  setSkills(skills: SkillFile[]): void {
    this.skills = skills;
    this.requestRebuild();
  }

  setInstructions(instructions: InstructionFile[]): void {
    this.instructions = instructions;
    this.requestRebuild();
  }

  setGroups(groups: SelectionGroup[]): void {
    this.groups = groups.filter((group) => group.side === this.side);
    this.requestRebuild();
  }

  setProjectPresets(presets: ProjectPreset[]): void {
    this.projectPresets = this.side === "central" ? presets : [];
    this.requestRebuild();
  }

  setAssetMeta(meta: Map<string, SkillAssetTreeMeta>): void {
    this.assetMeta = meta;
    this.requestRebuild();
  }

  setMissingSkillFolders(folders: Array<{ tool: ToolType; relativePath: string }>): void {
    this.missingSkillFolders = folders;
    this.requestRebuild();
  }

  setFilterMode(filterMode: SkillTreeFilterMode): void {
    this.filterMode = filterMode;
    this.requestRebuild();
  }

  setSelectedGroup(groupId: string | null): void {
    this.selectedGroupId = groupId;
    this.requestRebuild();
  }

  setActiveTab(tab: SourceTab): void {
    this.activeTab = tab;
    this.requestRebuild();
  }

  updateState(input: {
    activeTab?: SourceTab;
    assetMeta?: Map<string, SkillAssetTreeMeta>;
    filterMode?: SkillTreeFilterMode;
    groups?: SelectionGroup[];
    instructions?: InstructionFile[];
    missingSkillFolders?: Array<{ tool: ToolType; relativePath: string }>;
    projectPresets?: ProjectPreset[];
    selectedGroupId?: string | null;
    skills?: SkillFile[];
  }): void {
    this.batch(() => {
      if (input.activeTab !== undefined) this.activeTab = input.activeTab;
      if (input.assetMeta !== undefined) this.assetMeta = input.assetMeta;
      if (input.filterMode !== undefined) this.filterMode = input.filterMode;
      if (input.groups !== undefined) this.groups = input.groups.filter((group) => group.side === this.side);
      if (input.instructions !== undefined) this.instructions = input.instructions;
      if (input.missingSkillFolders !== undefined) this.missingSkillFolders = input.missingSkillFolders;
      if (input.projectPresets !== undefined) this.projectPresets = this.side === "central" ? input.projectPresets : [];
      if (input.selectedGroupId !== undefined) this.selectedGroupId = input.selectedGroupId;
      if (input.skills !== undefined) this.skills = input.skills;
      this.requestRebuild();
    });
  }

  setHighlight(highlight: Set<string>): void {
    this.highlight = highlight;
    applyHighlight(this.roots, this.highlight);
    this.emitter.fire(undefined);
  }

  setSelected(node: SkillTreeNode | null): void {
    this.selected = node;
  }

  getSelected(): SkillTreeNode | null {
    return this.selected;
  }

  getSelectionsFromNode(node: SkillTreeNode | null): SkillSelection[] {
    if (!node) return [];
    if (node.kind === "skillGroup") return flattenFiles([node]);
    if (node.kind === "group" || node.kind === "groupRoot" || node.kind === "groupTool" || node.kind === "presetRoot" || node.kind === "preset" || node.kind === "instructionRoot" || node.kind === "instructionFolder" || node.kind === "instructionFile") return [];
    if (node.kind === "file") {
      if (!node.tool || !node.relativePath) return [];
      return [{ tool: node.tool, relativePath: node.relativePath }];
    }

    if (!node.tool || typeof node.relativePath !== "string") return [];
    const files = flattenFiles(this.roots);
    const prefix = node.relativePath;
    return files.filter((f) => {
      if (f.tool !== node.tool) return false;
      if (!prefix) return true;
      return f.relativePath === prefix || f.relativePath.startsWith(`${prefix}/`);
    });
  }

  getSelectionsFromNodes(nodes: SkillTreeNode[]): SkillSelection[] {
    const map = new Map<string, SkillSelection>();
    for (const node of nodes) {
      for (const item of this.getSelectionsFromNode(node)) {
        map.set(`${item.tool}:${item.relativePath}`, item);
      }
    }
    return [...map.values()];
  }

  getAllSelections(): SkillSelection[] {
    return flattenFiles(this.roots);
  }

  getTreeItem(element: SkillTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SkillTreeItem): SkillTreeItem[] {
    if (!element) return this.roots.map((node) => new SkillTreeItem(node, this.commandId, this.language));
    return element.node.children.map((child) => new SkillTreeItem(child, this.commandId, this.language));
  }

  private batch(callback: () => void): void {
    this.batchDepth += 1;
    try {
      callback();
    } finally {
      this.batchDepth -= 1;
      if (this.batchDepth === 0 && this.needsRebuild) {
        this.needsRebuild = false;
        this.rebuild();
      }
    }
  }

  private requestRebuild(): void {
    if (this.batchDepth > 0) {
      this.needsRebuild = true;
      return;
    }
    this.rebuild();
  }

  private rebuild(): void {
    const visibleSkills = this.activeTab === "all"
      ? this.skills
      : this.skills.filter((item) => sourceTabIncludes(this.activeTab, item.tool));
    const visibleMissing = this.activeTab === "all"
      ? this.missingSkillFolders
      : this.missingSkillFolders.filter((item) => sourceTabIncludes(this.activeTab, item.tool));
    const visibleGroups = this.activeTab === "all"
      ? this.groups
      : this.groups.filter((group) => group.targets.some((target) => sourceTabIncludes(this.activeTab, target.tool)));
    const visibleInstructions = this.activeTab === "all" || sourceTabIncludes(this.activeTab, "agents")
      ? this.instructions
      : [];
    const skillRoots = buildSkillTree(
      visibleSkills,
      visibleMissing,
      this.assetMeta,
      this.filterMode,
      this.side,
      visibleGroups,
      this.selectedGroupId,
      this.language
    );
    const instructionRoot = buildInstructionRoot(visibleInstructions, this.side, this.language);
    const groupRoot = buildGroupRoot(visibleGroups, this.side, this.selectedGroupId, this.language);
    const commonToolRoot = buildEmbeddedCommonTools(this.language, this.side);
    const presetRoot = this.side === "central" ? buildPresetRoot(this.projectPresets, this.language) : null;
    this.roots = [
      ...(commonToolRoot ? [commonToolRoot] : []),
      ...(presetRoot ? [presetRoot] : []),
      ...skillRoots,
      ...(instructionRoot ? [instructionRoot] : []),
      ...(groupRoot ? [groupRoot] : [])
    ];
    annotateTreeCounts(this.roots);
    applyHighlight(this.roots, this.highlight);
    this.emitter.fire(undefined);
  }
}

function sourceTabIncludes(tab: SourceTab, tool: ToolType): boolean {
  return tab === "all" || tab.includes(tool);
}

function annotateTreeCounts(nodes: SkillTreeNode[]): void {
  for (const node of nodes) annotateTreeCount(node);
}

function annotateTreeCount(node: SkillTreeNode): { files: Set<string>; skills: Set<string> } {
  const files = new Set<string>();
  const skills = new Set<string>();
  if (node.kind === "file" || node.kind === "instructionFile") {
    files.add(`${node.tool}:${node.relativePath}`);
  }
  const skillFolder = getSkillFolderRelativePath(node.relativePath);
  if (skillFolder) {
    skills.add(`${node.tool}:${skillFolder}`);
  }
  for (const child of node.children) {
    const childCounts = annotateTreeCount(child);
    for (const file of childCounts.files) files.add(file);
    for (const skill of childCounts.skills) skills.add(skill);
  }
  node.treeFileCount = files.size;
  node.treeSkillCount = skills.size;
  return { files, skills };
}

function buildSkillTree(
  skills: SkillFile[],
  missingSkillFolders: Array<{ tool: ToolType; relativePath: string }>,
  assetMeta: Map<string, SkillAssetTreeMeta>,
  filterMode: SkillTreeFilterMode,
  side: "workspace" | "central",
  groups: SelectionGroup[],
  selectedGroupId: string | null,
  language: UiLanguage
): SkillTreeNode[] {
  const roots = new Map<string, SkillTreeNode>();

  for (const skill of skills) {
    const skillFolder = getSkillFolderRelativePath(skill.relativePath);
    const meta = skillFolder ? assetMeta.get(`${skill.tool}:${skillFolder}`) : undefined;
    if (skillFolder && !assetMatchesFilter(meta, filterMode)) continue;
    let root = roots.get(skill.tool);
    if (!root) {
      root = {
        key: `${skill.tool}:`,
        kind: "folder",
        tool: skill.tool,
        relativePath: "",
        label: skill.tool,
        children: []
      };
      roots.set(skill.tool, root);
    }

    const parts = skill.relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
    let cursor = root;
    let soFar = "";

    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      soFar = soFar ? `${soFar}/${part}` : part;

      let child = cursor.children.find((item) => item.label === part && item.kind === (isLast ? "file" : "folder"));
      if (!child) {
        child = {
          key: `${skill.tool}:${soFar}`,
          kind: isLast ? "file" : "folder",
          tool: skill.tool,
        relativePath: soFar,
        label: part,
        children: []
      };
        if (!isLast) {
          const folderMeta = assetMeta.get(`${skill.tool}:${soFar}`);
          if (folderMeta) {
            child.assetStatus = folderMeta.status;
            child.assetWarnings = folderMeta.warnings;
            child.assetFileCount = folderMeta.fileCount;
            child.assetUpdatedAt = folderMeta.updatedAt;
          }
        }
        cursor.children.push(child);
      }
      cursor = child;
    }
  }

  for (const missing of missingSkillFolders) {
    const normalized = missing.relativePath.replace(/\\/g, "/");
    const meta = assetMeta.get(`${missing.tool}:${normalized}`) ?? {
      status: "missingSkillMd" as const,
      warnings: [{
        code: "missing-skill-md" as const,
        severity: "danger" as const,
        message: localize(language, "SKILL.md is missing.", "SKILL.md가 없습니다."),
        relativePath: normalized
      }],
      fileCount: 0,
      updatedAt: null
    };
    if (!assetMatchesFilter(meta, filterMode)) continue;
    let root = roots.get(missing.tool);
    if (!root) {
      root = {
        key: `${missing.tool}:`,
        kind: "folder",
        tool: missing.tool,
        relativePath: "",
        label: missing.tool,
        children: []
      };
      roots.set(missing.tool, root);
    }
    ensureFolderNode(root, missing.tool, normalized, meta);
  }

  const list = [...roots.values()];
  sortNodes(list);
  applySkillGroupBuckets(list, side, groups, selectedGroupId, language);
  return list;
}

function applySkillGroupBuckets(
  roots: SkillTreeNode[],
  side: "workspace" | "central",
  groups: SelectionGroup[],
  selectedGroupId: string | null,
  language: UiLanguage
): void {
  const groupsByTool = new Map<ToolType, SelectionGroup[]>();
  for (const group of groups) {
    if (group.side !== side) continue;
    const tools = new Set(group.targets.map((target) => target.tool));
    for (const tool of tools) {
      const bucket = groupsByTool.get(tool) ?? [];
      bucket.push(group);
      groupsByTool.set(tool, bucket);
    }
  }

  for (const root of roots) {
    const toolGroups = (groupsByTool.get(root.tool) ?? []).sort((a, b) => a.name.localeCompare(b.name));
    if (toolGroups.length === 0) continue;

    const skillsRoot = root.children.find((child) => child.kind === "folder" && child.relativePath === "skills");
    if (!skillsRoot) continue;

    const foldersByPath = new Map<string, SkillTreeNode>();
    const passthrough: SkillTreeNode[] = [];
    for (const child of skillsRoot.children) {
      const skillFolder = child.kind === "folder" ? getSkillFolderRelativePath(child.relativePath) : null;
      if (skillFolder && skillFolder === child.relativePath) {
        foldersByPath.set(skillFolder, child);
      } else {
        passthrough.push(child);
      }
    }
    if (foldersByPath.size === 0) continue;

    const assigned = new Set<string>();
    const groupNodes: SkillTreeNode[] = [];

    for (const group of toolGroups) {
      const childNodes = skillGroupFolderTargets(group, root.tool)
        .map((relativePath) => foldersByPath.get(relativePath))
        .filter((node): node is SkillTreeNode => !!node)
        .map((node) => cloneTreeNode(node, `skill-group:${side}:${root.tool}:${group.id}`));

      if (childNodes.length === 0) continue;
      for (const child of childNodes) assigned.add(child.relativePath);

      groupNodes.push({
        key: `skill-group:${side}:${root.tool}:${group.id}`,
        kind: "skillGroup",
        tool: root.tool,
        relativePath: `__skill_groups__/${group.id}`,
        label: group.name,
        children: childNodes,
        side,
        groupId: group.id,
        count: childNodes.length,
        selected: group.id === selectedGroupId
      });
    }

    const projectedFolderPaths = collectSkillGroupFolderPaths(groupNodes);
    const ungrouped = [...foldersByPath.entries()]
      .filter(([relativePath]) => !assigned.has(relativePath))
      .map(([, node]) => cloneTreeNode(node, `skill-group:${side}:${root.tool}:ungrouped`));
    for (const [relativePath, node] of foldersByPath.entries()) {
      if (projectedFolderPaths.has(relativePath)) continue;
      if (ungrouped.some((entry) => entry.relativePath === relativePath)) continue;
      ungrouped.push(cloneTreeNode(node, `skill-group:${side}:${root.tool}:ungrouped-fallback`));
    }
    if (ungrouped.length > 0) {
      groupNodes.push({
        key: `skill-group:${side}:${root.tool}:ungrouped`,
        kind: "skillGroup",
        tool: root.tool,
        relativePath: "__skill_groups__/ungrouped",
        label: localize(language, "Ungrouped", "미분류"),
        children: ungrouped,
        side,
        count: ungrouped.length
      });
    }

    if (groupNodes.length > 0) {
      skillsRoot.children = [...groupNodes, ...passthrough];
    }
  }
}

function skillGroupFolderTargets(group: SelectionGroup, tool: ToolType): string[] {
  const targets = new Set<string>();
  for (const target of group.targets) {
    if (target.tool !== tool) continue;
    const skillFolder = getSkillFolderRelativePath(target.relativePath);
    if (skillFolder) targets.add(skillFolder);
  }
  return [...targets].sort((a, b) => a.localeCompare(b));
}

function cloneTreeNode(node: SkillTreeNode, keyPrefix: string): SkillTreeNode {
  return {
    ...node,
    key: `${keyPrefix}:${node.relativePath}`,
    children: node.children.map((child) => cloneTreeNode(child, keyPrefix))
  };
}

function collectSkillGroupFolderPaths(nodes: SkillTreeNode[]): Set<string> {
  const paths = new Set<string>();
  const walk = (entries: SkillTreeNode[]): void => {
    for (const entry of entries) {
      const skillFolder = entry.kind === "folder" ? getSkillFolderRelativePath(entry.relativePath) : null;
      if (skillFolder && skillFolder === entry.relativePath) {
        paths.add(skillFolder);
      }
      walk(entry.children);
    }
  };
  walk(nodes);
  return paths;
}

function ensureFolderNode(
  root: SkillTreeNode,
  tool: ToolType,
  relativePath: string,
  meta: SkillAssetTreeMeta
): SkillTreeNode {
  const parts = relativePath.split("/").filter(Boolean);
  let cursor = root;
  let soFar = "";
  for (const part of parts) {
    soFar = soFar ? `${soFar}/${part}` : part;
    let child = cursor.children.find((item) => item.label === part && item.kind === "folder");
    if (!child) {
      child = {
        key: `${tool}:${soFar}`,
        kind: "folder",
        tool,
        relativePath: soFar,
        label: part,
        children: []
      };
      cursor.children.push(child);
    }
    const childMeta = soFar === relativePath ? meta : undefined;
    if (childMeta) {
      child.assetStatus = childMeta.status;
      child.assetWarnings = childMeta.warnings;
      child.assetFileCount = childMeta.fileCount;
      child.assetUpdatedAt = childMeta.updatedAt;
    }
    cursor = child;
  }
  return cursor;
}

function assetMatchesFilter(meta: SkillAssetTreeMeta | undefined, filterMode: SkillTreeFilterMode): boolean {
  if (filterMode === "all") return true;
  if (!meta) return false;
  if (filterMode === "changed") return meta.status === "changed";
  if (filterMode === "new") return meta.status === "new";
  if (filterMode === "risk") return meta.status === "risk" || meta.warnings.length > 0;
  if (filterMode === "missingSkillMd") return meta.status === "missingSkillMd";
  if (filterMode === "recent") return meta.status === "recent";
  return true;
}

function getSkillFolderRelativePath(relativePath: string): string | null {
  const parts = relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts[0] !== "skills" || !parts[1]) return null;
  return `skills/${parts[1]}`;
}

function buildInstructionRoot(instructions: InstructionFile[], side: "workspace" | "central", language: UiLanguage): SkillTreeNode | null {
  if (instructions.length === 0) return null;
  const root: SkillTreeNode = {
    key: `instructions:${side}`,
    kind: "instructionRoot",
    tool: "agents",
    relativePath: "__instructions__",
    label: localize(language, "instructions", "지침"),
    side,
    count: instructions.length,
    children: []
  };

  const sorted = instructions
    .slice()
    .sort((a, b) => (a.displayPath ?? a.relativePath).localeCompare(b.displayPath ?? b.relativePath));

  for (const item of sorted) {
    const displayPath = (item.displayPath ?? item.relativePath).replace(/\\/g, "/");
    const parts = displayPath.split("/").filter(Boolean);
    let cursor = root;
    let displaySoFar = "";

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      const isLast = index === parts.length - 1;
      displaySoFar = displaySoFar ? `${displaySoFar}/${part}` : part;

      if (isLast) {
        cursor.children.push({
          key: `instruction:${side}:${displaySoFar}:${item.profileId ?? ""}:${item.relativePath}`,
          kind: "instructionFile",
          tool: "agents",
          relativePath: item.relativePath,
          absolutePath: item.absolutePath,
          label: part,
          side,
          instructionProfile: item.profileId,
          children: []
        });
        continue;
      }

      let folder = cursor.children.find((child) => child.kind === "instructionFolder" && child.relativePath === displaySoFar);
      if (!folder) {
        folder = {
          key: `instruction-folder:${side}:${displaySoFar}`,
          kind: "instructionFolder",
          tool: "agents",
          relativePath: displaySoFar,
          label: part,
          side,
          instructionProfile: item.profileId,
          children: []
        };
        cursor.children.push(folder);
      }
      cursor = folder;
    }
  }

  sortNodes(root.children);
  return {
    ...root,
    children: root.children
  };
}

function buildGroupRoot(
  groups: SelectionGroup[],
  side: "workspace" | "central",
  selectedGroupId: string | null,
  language: UiLanguage
): SkillTreeNode | null {
  if (groups.length === 0) return null;
  const groupedByTool = new Map<ToolType | "mixed", SelectionGroup[]>();
  for (const group of groups) {
    const tools = [...new Set(group.targets.map((target) => target.tool))];
    const key: ToolType | "mixed" = tools.length === 1 ? tools[0] : "mixed";
    const bucket = groupedByTool.get(key) ?? [];
    bucket.push(group);
    groupedByTool.set(key, bucket);
  }

  const toolOrder: Array<ToolType | "mixed"> = ["claude", "codex", "gemini", "cursor", "antigravity", "agents", "mixed"];
  const toolNodes: SkillTreeNode[] = toolOrder
    .filter((tool) => (groupedByTool.get(tool)?.length ?? 0) > 0)
    .map((tool) => {
      const toolGroups = (groupedByTool.get(tool) ?? []).sort((a, b) => a.name.localeCompare(b.name));
      return {
        key: `group-tool:${side}:${tool}`,
        kind: "groupTool",
        tool: tool === "mixed" ? "agents" : tool,
        relativePath: `__groups__/${tool}`,
        label: tool === "mixed" ? localize(language, "Mixed", "혼합") : tool,
        side,
        count: toolGroups.length,
        children: toolGroups.map((group) => ({
          key: `group:${group.id}`,
          kind: "group",
          tool: group.targets[0]?.tool ?? "agents",
          relativePath: `__groups__/${tool}/${group.id}`,
          label: group.name,
          side,
          groupId: group.id,
          count: group.targets.length,
          selected: group.id === selectedGroupId,
          children: []
        }))
      };
    });

  return {
    key: `groups:${side}`,
    kind: "groupRoot",
    tool: "agents",
    relativePath: "__groups__",
    label: localize(language, "groups", "그룹"),
    side,
    count: groups.length,
    children: toolNodes
  };
}

function sortNodes(nodes: SkillTreeNode[]): void {
  nodes.sort((a, b) => {
    const aFolderLike = a.kind !== "file" ? 0 : 1;
    const bFolderLike = b.kind !== "file" ? 0 : 1;
    if (aFolderLike !== bFolderLike) return aFolderLike - bFolderLike;
    return a.label.localeCompare(b.label);
  });
  for (const node of nodes) sortNodes(node.children);
}

function applyHighlight(nodes: SkillTreeNode[], highlight: Set<string>): boolean {
  let any = false;
  for (const node of nodes) {
    const key = `${node.tool}:${node.relativePath}`;
    const isDirect = highlight.has(key);
    const hasChild = applyHighlight(node.children, highlight);
    node.highlighted = isDirect || hasChild;
    if (node.highlighted) any = true;
  }
  return any;
}

function flattenFiles(nodes: SkillTreeNode[]): SkillSelection[] {
  const out = new Map<string, SkillSelection>();
  const walk = (entries: SkillTreeNode[]) => {
    for (const node of entries) {
      if (node.kind === "file") {
        out.set(`${node.tool}:${node.relativePath}`, { tool: node.tool, relativePath: node.relativePath });
      } else {
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return [...out.values()];
}
