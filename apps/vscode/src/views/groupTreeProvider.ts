import * as vscode from "vscode";
import { ALL_AGENTS, type GroupTreeNode, type SelectionGroup, type ToolType } from "../types";
import type { UiLanguage } from "../uiLanguage";

function localize(language: UiLanguage, english: string, korean: string): string {
  return language === "ko" ? korean : english;
}

export class GroupTreeItem extends vscode.TreeItem {
  constructor(public readonly node: GroupTreeNode, private readonly language: UiLanguage) {
    super(
      node.label,
      node.kind === "root"
        ? vscode.TreeItemCollapsibleState.Expanded
        : node.kind === "tool"
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None
    );
    this.contextValue = node.kind === "root"
      ? `skillBridge.groupRoot.${node.side}`
      : node.kind === "tool"
        ? `skillBridge.groupTool.${node.side}`
        : `skillBridge.group.${node.side}`;
    if (node.kind === "group") {
      this.description = node.selected
        ? localize(this.language, `selected · targets ${node.count}`, `선택됨 · 대상 ${node.count}`)
        : localize(this.language, `targets ${node.count}`, `대상 ${node.count}`);
      this.tooltip = localize(this.language, `${node.label} (targets ${node.count})`, `${node.label} (대상 ${node.count})`);
    } else if (node.kind === "tool") {
      this.description = localize(this.language, `groups ${node.count}`, `그룹 ${node.count}`);
      this.tooltip = localize(this.language, `${node.label} groups ${node.count}`, `${node.label} 그룹 ${node.count}`);
    } else {
      this.description = localize(this.language, `groups ${node.count}`, `그룹 ${node.count}`);
      this.tooltip = localize(this.language, `${node.label} (groups ${node.count})`, `${node.label} (그룹 ${node.count})`);
    }
    if (node.kind === "group") {
      this.command = {
        command: "skillBridge.selectGroup",
        title: localize(this.language, "Select Group", "그룹 선택"),
        arguments: [node]
      };
    }
    this.iconPath = node.kind === "root"
      ? new vscode.ThemeIcon(node.side === "workspace" ? "folder" : "repo")
      : node.kind === "tool"
        ? new vscode.ThemeIcon("folder-library")
        : new vscode.ThemeIcon("tag", node.selected ? new vscode.ThemeColor("charts.green") : undefined);
  }
}

export class GroupTreeProvider implements vscode.TreeDataProvider<GroupTreeItem> {
  private readonly emitter = new vscode.EventEmitter<GroupTreeItem | undefined>();
  private roots: GroupTreeNode[] = [];
  private groups: SelectionGroup[] = [];
  private selectedGroupId: string | null = null;
  private language: UiLanguage = "en";

  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly sideFilter?: "workspace" | "central") {}

  setLanguage(language: UiLanguage): void {
    this.language = language;
    this.roots = buildGroupTree(this.groups, this.sideFilter, this.language);
    this.emitter.fire(undefined);
  }

  setGroups(groups: SelectionGroup[]): void {
    this.groups = groups;
    this.roots = buildGroupTree(groups, this.sideFilter, this.language);
    this.emitter.fire(undefined);
  }

  setSelectedGroup(groupId: string | null): void {
    this.selectedGroupId = groupId;
    this.emitter.fire(undefined);
  }

  getGroupById(id: string): SelectionGroup | undefined {
    return this.groups.find((group) => group.id === id);
  }

  getTreeItem(element: GroupTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: GroupTreeItem): GroupTreeItem[] {
    if (!element) return this.roots.map((node) => new GroupTreeItem(node, this.language));
    if (element.node.kind === "root") {
      const buckets = buildToolBuckets(this.groups, element.node.side);
      const orderedTools: Array<ToolType | "mixed"> = [...ALL_AGENTS, "mixed"];
      return orderedTools
        .filter((tool) => (buckets.get(tool)?.length ?? 0) > 0)
        .map((tool) => {
          const groups = buckets.get(tool) ?? [];
          return new GroupTreeItem({
            id: `${element.node.side}:${tool}`,
            kind: "tool",
            side: element.node.side,
            label: toolLabel(tool, this.language),
            count: groups.length,
            tool
          }, this.language);
        });
    }
    if (element.node.kind === "tool") {
      const tool = element.node.tool;
      if (!tool) return [];
      const buckets = buildToolBuckets(this.groups, element.node.side);
      const groups = buckets.get(tool) ?? [];
      return groups.map((group) =>
        new GroupTreeItem({
          id: group.id,
          kind: "group",
          side: group.side,
          label: group.name,
          count: group.targets.length,
          selected: group.id === this.selectedGroupId
        }, this.language)
      );
    }
    return [];
  }
}

function buildGroupTree(
  groups: SelectionGroup[],
  sideFilter?: "workspace" | "central",
  language: UiLanguage = "en"
): GroupTreeNode[] {
  if (sideFilter) {
    const buckets = buildToolBuckets(groups, sideFilter);
    const orderedTools: Array<ToolType | "mixed"> = [...ALL_AGENTS, "mixed"];
    return orderedTools
      .filter((tool) => (buckets.get(tool)?.length ?? 0) > 0)
      .map((tool) => {
        const sideGroups = buckets.get(tool) ?? [];
        return {
          id: `${sideFilter}:${tool}`,
          kind: "tool" as const,
          side: sideFilter,
          label: toolLabel(tool, language),
          count: sideGroups.length,
          tool
        };
      });
  }

  const workspaceCount = groups.filter((group) => group.side === "workspace").length;
  const centralCount = groups.filter((group) => group.side === "central").length;

  return [
    {
      id: "workspace",
      kind: "root",
      side: "workspace",
      label: localize(language, "Workspace Groups", "작업공간 그룹"),
      count: workspaceCount
    },
    {
      id: "central",
      kind: "root",
      side: "central",
      label: localize(language, "Central Groups", "중앙 그룹"),
      count: centralCount
    }
  ];
}

function buildToolBuckets(
  groups: SelectionGroup[],
  side: "workspace" | "central"
): Map<ToolType | "mixed", SelectionGroup[]> {
  const map = new Map<ToolType | "mixed", SelectionGroup[]>();
  for (const group of groups) {
    if (group.side !== side) continue;
    const tools = [...new Set(group.targets.map((target) => target.tool))];
    const key: ToolType | "mixed" = tools.length === 1 ? tools[0] : "mixed";
    const bucket = map.get(key) ?? [];
    bucket.push(group);
    map.set(key, bucket);
  }
  return map;
}

function toolLabel(tool: ToolType | "mixed", language: UiLanguage): string {
  if (tool === "mixed") return localize(language, "Mixed", "혼합");
  return tool;
}
