import * as vscode from "vscode";
import type {
  GroupTreeNode,
  InstructionFile,
  SelectionGroup,
  SkillAssetTreeMeta,
  SkillFile,
  SkillSelection,
  SkillTreeFilterMode,
  SkillTreeNode,
  ToolType
} from "../types";

type SourceTab = "all" | ToolType;

export class SkillTreeItem extends vscode.TreeItem {
  constructor(public readonly node: SkillTreeNode, commandId: string) {
    super(node.label, collapsibleStateOf(node));
    this.contextValue = resolveContextValue(node);
    this.description = resolveDescription(node);
    this.tooltip = resolveTooltip(node);

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
        title: "Select Group",
        arguments: [payload]
      };
    } else if (node.kind === "file" || node.kind === "folder" || node.kind === "instructionFile") {
      this.command = {
        command: commandId,
        title: "Select",
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
  if (node.kind === "file" || node.kind === "instructionFile" || node.kind === "group") return vscode.TreeItemCollapsibleState.None;
  if (node.kind === "groupRoot" || node.kind === "groupTool") return vscode.TreeItemCollapsibleState.Expanded;
  return vscode.TreeItemCollapsibleState.Collapsed;
}

function resolveContextValue(node: SkillTreeNode): string {
  if (node.kind === "skillGroup") {
    return node.groupId
      ? `skillBridge.group.${node.side === "central" ? "central" : "workspace"}`
      : "skillBridge.virtualGroup";
  }
  if (node.kind === "groupRoot") return `skillBridge.groupRoot.${node.side === "central" ? "central" : "workspace"}`;
  if (node.kind === "groupTool") return `skillBridge.groupTool.${node.side === "central" ? "central" : "workspace"}`;
  if (node.kind === "group") return `skillBridge.group.${node.side === "central" ? "central" : "workspace"}`;
  if (node.kind === "instructionRoot") return "skillBridge.instructionRoot";
  if (node.kind === "instructionFile") return "skillBridge.instructionFile";
  if (node.kind === "file") return "skillBridge.file";
  const rel = node.relativePath.replace(/\\/g, "/");
  if (rel === "") return "skillBridge.folderRoot";
  if (rel === "skills") return "skillBridge.skillsRoot";
  return "skillBridge.folder";
}

function resolveDescription(node: SkillTreeNode): string | undefined {
  if (node.kind === "file") {
    return `${node.tool} · ${shortParentPath(node.relativePath)}`;
  }
  if (node.kind === "instructionFile") {
    return shortParentPath(node.relativePath);
  }
  if (node.kind === "skillGroup") {
    return node.selected ? `선택됨 · ${node.count ?? 0}개` : `${node.count ?? 0}개`;
  }
  if (node.kind === "group") {
    return node.selected ? `선택됨 · ${node.count ?? 0}개` : `${node.count ?? 0}개`;
  }
  if (node.kind === "groupTool" || node.kind === "groupRoot") {
    return `${node.count ?? 0}개`;
  }
  if (node.relativePath === "") {
    return `${countFiles(node)}개`;
  }
  if (node.assetStatus) {
    const labels: Record<string, string> = {
      same: "동일",
      new: "새 스킬",
      changed: "변경",
      missingSkillMd: "SKILL.md 없음",
      risk: "주의",
      recent: "최근"
    };
    return labels[node.assetStatus] ?? node.assetStatus;
  }
  return undefined;
}

function resolveTooltip(node: SkillTreeNode): string {
  if (node.kind === "skillGroup") {
    const label = node.groupId ? "그룹" : "미분류";
    return `${label}: ${node.label} (${node.count ?? 0}개)`;
  }
  if (node.kind === "group") {
    return `${node.label} (${node.count ?? 0}개)`;
  }
  if (node.kind === "groupTool") {
    return `${node.label} 그룹`;
  }
  if (node.kind === "groupRoot") {
    return node.side === "central" ? "Central 그룹" : "Workspace 그룹";
  }
  if (node.kind === "instructionRoot") {
    return `${node.side === "central" ? "Central" : "Workspace"} instruction files (${node.count ?? countFiles(node)}개)`;
  }
  if (node.kind === "instructionFile") {
    return `instruction/${node.relativePath}`;
  }
  const tool = node.tool;
  const rel = node.relativePath;
  const warnings = node.assetWarnings && node.assetWarnings.length > 0
    ? `\n\n${node.assetWarnings.map((warning) => `- ${warning.message}`).join("\n")}`
    : "";
  const asset = node.assetStatus
    ? `\n상태: ${assetStatusLabel(node.assetStatus)} · 파일 ${node.assetFileCount ?? countFiles(node)}개`
    : "";
  return `${tool}/${rel}${asset}${warnings}`;
}

function assetStatusLabel(status: SkillAssetTreeMeta["status"]): string {
  if (status === "same") return "동일";
  if (status === "new") return "새 스킬";
  if (status === "changed") return "변경";
  if (status === "missingSkillMd") return "SKILL.md 없음";
  if (status === "risk") return "주의";
  return "최근";
}

function resolveIcon(node: SkillTreeNode, color: vscode.ThemeColor | undefined): vscode.ThemeIcon {
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
  if (node.kind === "instructionRoot") return new vscode.ThemeIcon("book");
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

function shortParentPath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/");
  const parent = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "";
  if (!parent) return "root";
  if (parent.length <= 24) return parent;
  return `...${parent.slice(-24)}`;
}

function countFiles(node: SkillTreeNode): number {
  const seen = new Set<string>();
  const walk = (entry: SkillTreeNode): void => {
    if (entry.kind === "file") {
      seen.add(`${entry.tool}:${entry.relativePath}`);
      return;
    }
    for (const child of entry.children) walk(child);
  };
  walk(node);
  return seen.size;
}

export class SkillTreeProvider implements vscode.TreeDataProvider<SkillTreeItem> {
  private readonly emitter = new vscode.EventEmitter<SkillTreeItem | undefined>();
  private roots: SkillTreeNode[] = [];
  private highlight = new Set<string>();
  private selected: SkillTreeNode | null = null;
  private skills: SkillFile[] = [];
  private instructions: InstructionFile[] = [];
  private groups: SelectionGroup[] = [];
  private selectedGroupId: string | null = null;
  private activeTab: SourceTab = "all";
  private assetMeta = new Map<string, SkillAssetTreeMeta>();
  private missingSkillFolders: Array<{ tool: ToolType; relativePath: string }> = [];
  private filterMode: SkillTreeFilterMode = "all";

  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly commandId: string,
    private readonly side: "workspace" | "central"
  ) {}

  setSkills(skills: SkillFile[]): void {
    this.skills = skills;
    this.rebuild();
  }

  setInstructions(instructions: InstructionFile[]): void {
    this.instructions = instructions;
    this.rebuild();
  }

  setGroups(groups: SelectionGroup[]): void {
    this.groups = groups.filter((group) => group.side === this.side);
    this.rebuild();
  }

  setAssetMeta(meta: Map<string, SkillAssetTreeMeta>): void {
    this.assetMeta = meta;
    this.rebuild();
  }

  setMissingSkillFolders(folders: Array<{ tool: ToolType; relativePath: string }>): void {
    this.missingSkillFolders = folders;
    this.rebuild();
  }

  setFilterMode(filterMode: SkillTreeFilterMode): void {
    this.filterMode = filterMode;
    this.rebuild();
  }

  setSelectedGroup(groupId: string | null): void {
    this.selectedGroupId = groupId;
    this.rebuild();
  }

  setActiveTab(tab: SourceTab): void {
    this.activeTab = tab;
    this.rebuild();
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
    if (node.kind === "group" || node.kind === "groupRoot" || node.kind === "groupTool" || node.kind === "instructionRoot" || node.kind === "instructionFile") return [];
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
    if (!element) return this.roots.map((node) => new SkillTreeItem(node, this.commandId));
    return element.node.children.map((child) => new SkillTreeItem(child, this.commandId));
  }

  private rebuild(): void {
    const visibleSkills = this.activeTab === "all"
      ? this.skills
      : this.skills.filter((item) => item.tool === this.activeTab);
    const visibleMissing = this.activeTab === "all"
      ? this.missingSkillFolders
      : this.missingSkillFolders.filter((item) => item.tool === this.activeTab);
    const visibleGroups = this.activeTab === "all"
      ? this.groups
      : this.groups.filter((group) => group.targets.some((target) => target.tool === this.activeTab));
    const visibleInstructions = this.activeTab === "all" || this.activeTab === "agents"
      ? this.instructions
      : [];
    const skillRoots = buildSkillTree(
      visibleSkills,
      visibleMissing,
      this.assetMeta,
      this.filterMode,
      this.side,
      visibleGroups,
      this.selectedGroupId
    );
    const instructionRoot = buildInstructionRoot(visibleInstructions, this.side);
    const groupRoot = buildGroupRoot(visibleGroups, this.side, this.selectedGroupId);
    this.roots = [
      ...skillRoots,
      ...(instructionRoot ? [instructionRoot] : []),
      ...(groupRoot ? [groupRoot] : [])
    ];
    applyHighlight(this.roots, this.highlight);
    this.emitter.fire(undefined);
  }
}

function buildSkillTree(
  skills: SkillFile[],
  missingSkillFolders: Array<{ tool: ToolType; relativePath: string }>,
  assetMeta: Map<string, SkillAssetTreeMeta>,
  filterMode: SkillTreeFilterMode,
  side: "workspace" | "central",
  groups: SelectionGroup[],
  selectedGroupId: string | null
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
        message: "SKILL.md가 없습니다.",
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
  applySkillGroupBuckets(list, side, groups, selectedGroupId);
  return list;
}

function applySkillGroupBuckets(
  roots: SkillTreeNode[],
  side: "workspace" | "central",
  groups: SelectionGroup[],
  selectedGroupId: string | null
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

    const ungrouped = [...foldersByPath.entries()]
      .filter(([relativePath]) => !assigned.has(relativePath))
      .map(([, node]) => cloneTreeNode(node, `skill-group:${side}:${root.tool}:ungrouped`));
    if (ungrouped.length > 0) {
      groupNodes.push({
        key: `skill-group:${side}:${root.tool}:ungrouped`,
        kind: "skillGroup",
        tool: root.tool,
        relativePath: "__skill_groups__/ungrouped",
        label: "미분류",
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

function buildInstructionRoot(instructions: InstructionFile[], side: "workspace" | "central"): SkillTreeNode | null {
  if (instructions.length === 0) return null;
  return {
    key: `instructions:${side}`,
    kind: "instructionRoot",
    tool: "agents",
    relativePath: "__instructions__",
    label: "instructions",
    side,
    count: instructions.length,
    children: instructions
      .slice()
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
      .map((item) => ({
        key: `instruction:${side}:${item.relativePath}`,
        kind: "instructionFile",
        tool: "agents",
        relativePath: item.relativePath,
        absolutePath: item.absolutePath,
        label: item.relativePath,
        side,
        children: []
      }))
  };
}

function buildGroupRoot(
  groups: SelectionGroup[],
  side: "workspace" | "central",
  selectedGroupId: string | null
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
        label: tool === "mixed" ? "혼합" : tool,
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
    label: "groups",
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
