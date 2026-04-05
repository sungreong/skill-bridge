import * as vscode from "vscode";
import type { GroupTreeNode, SelectionGroup, SkillFile, SkillSelection, SkillTreeNode, ToolType } from "../types";

type SourceTab = "all" | ToolType;

export class SkillTreeItem extends vscode.TreeItem {
  constructor(public readonly node: SkillTreeNode, commandId: string) {
    super(node.label, collapsibleStateOf(node));
    this.contextValue = resolveContextValue(node);
    this.description = resolveDescription(node);
    this.tooltip = resolveTooltip(node);

    if (node.kind === "group") {
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
    } else if (node.kind === "file" || node.kind === "folder") {
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
  if (node.kind === "file" || node.kind === "group") return vscode.TreeItemCollapsibleState.None;
  if (node.kind === "groupRoot" || node.kind === "groupTool") return vscode.TreeItemCollapsibleState.Expanded;
  return vscode.TreeItemCollapsibleState.Collapsed;
}

function resolveContextValue(node: SkillTreeNode): string {
  if (node.kind === "groupRoot") return `skillBridge.groupRoot.${node.side === "central" ? "central" : "workspace"}`;
  if (node.kind === "groupTool") return `skillBridge.groupTool.${node.side === "central" ? "central" : "workspace"}`;
  if (node.kind === "group") return `skillBridge.group.${node.side === "central" ? "central" : "workspace"}`;
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
  if (node.kind === "group") {
    return node.selected ? `선택됨 · ${node.count ?? 0}개` : `${node.count ?? 0}개`;
  }
  if (node.kind === "groupTool" || node.kind === "groupRoot") {
    return `${node.count ?? 0}개`;
  }
  if (node.relativePath === "") {
    return `${countFiles(node)}개`;
  }
  return undefined;
}

function resolveTooltip(node: SkillTreeNode): string {
  if (node.kind === "group") {
    return `${node.label} (${node.count ?? 0}개)`;
  }
  if (node.kind === "groupTool") {
    return `${node.label} 그룹`;
  }
  if (node.kind === "groupRoot") {
    return node.side === "central" ? "Central 그룹" : "Workspace 그룹";
  }
  const tool = node.tool;
  const rel = node.relativePath;
  return `${tool}/${rel}`;
}

function resolveIcon(node: SkillTreeNode, color: vscode.ThemeColor | undefined): vscode.ThemeIcon {
  if (node.kind === "groupRoot") {
    return new vscode.ThemeIcon(node.side === "central" ? "repo" : "folder");
  }
  if (node.kind === "groupTool") return new vscode.ThemeIcon("folder-library");
  if (node.kind === "group") {
    return new vscode.ThemeIcon("tag", node.selected ? new vscode.ThemeColor("charts.green") : undefined);
  }
  return node.kind === "folder"
    ? new vscode.ThemeIcon("folder", color)
    : new vscode.ThemeIcon("file", color);
}

function shortParentPath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/");
  const parent = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "";
  if (!parent) return "root";
  if (parent.length <= 24) return parent;
  return `...${parent.slice(-24)}`;
}

function countFiles(node: SkillTreeNode): number {
  if (node.kind === "file") return 1;
  let count = 0;
  for (const child of node.children) {
    count += countFiles(child);
  }
  return count;
}

export class SkillTreeProvider implements vscode.TreeDataProvider<SkillTreeItem> {
  private readonly emitter = new vscode.EventEmitter<SkillTreeItem | undefined>();
  private roots: SkillTreeNode[] = [];
  private highlight = new Set<string>();
  private selected: SkillTreeNode | null = null;
  private skills: SkillFile[] = [];
  private groups: SelectionGroup[] = [];
  private selectedGroupId: string | null = null;
  private activeTab: SourceTab = "all";

  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly commandId: string,
    private readonly side: "workspace" | "central"
  ) {}

  setSkills(skills: SkillFile[]): void {
    this.skills = skills;
    this.rebuild();
  }

  setGroups(groups: SelectionGroup[]): void {
    this.groups = groups.filter((group) => group.side === this.side);
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
    if (node.kind === "group" || node.kind === "groupRoot" || node.kind === "groupTool") return [];
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
    const visibleGroups = this.activeTab === "all"
      ? this.groups
      : this.groups.filter((group) => group.targets.some((target) => target.tool === this.activeTab));
    const skillRoots = buildSkillTree(visibleSkills);
    const groupRoot = buildGroupRoot(visibleGroups, this.side, this.selectedGroupId);
    this.roots = groupRoot ? [...skillRoots, groupRoot] : skillRoots;
    applyHighlight(this.roots, this.highlight);
    this.emitter.fire(undefined);
  }
}

function buildSkillTree(skills: SkillFile[]): SkillTreeNode[] {
  const roots = new Map<string, SkillTreeNode>();

  for (const skill of skills) {
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
        cursor.children.push(child);
      }
      cursor = child;
    }
  }

  const list = [...roots.values()];
  sortNodes(list);
  return list;
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
        label: tool === "mixed" ? "혼합" : (side === "workspace" ? `.${tool}` : tool),
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
  const out: SkillSelection[] = [];
  const walk = (entries: SkillTreeNode[]) => {
    for (const node of entries) {
      if (node.kind === "file") {
        out.push({ tool: node.tool, relativePath: node.relativePath });
      } else {
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return out;
}
