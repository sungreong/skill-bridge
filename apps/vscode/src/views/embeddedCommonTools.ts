import * as vscode from "vscode";
import type { SkillTreeNode } from "../types";
import { localize, type UiLanguage } from "../uiLanguage";
import { buildCommonToolNodes, COMMON_TOOL_SECTION_ORDER, DEFAULT_QUICK_TOOL_COMMANDS, MANAGE_QUICK_TOOLS_COMMAND, type CommonToolCommand, type CommonToolSectionId } from "./commonToolCatalog";

export function buildEmbeddedCommonTools(language: UiLanguage, side: "workspace" | "central"): SkillTreeNode {
  const nodes = buildCommonToolNodes(language);
  const visibleCommands = getVisibleQuickToolCommands();
  const sectionOrder = COMMON_TOOL_SECTION_ORDER.filter((sectionId) =>
    side === "workspace" ? sectionId !== "central" : sectionId === "central"
  );
  const children: SkillTreeNode[] = sectionOrder
    .map((sectionId) => {
      const sectionChildren = nodes[sectionId]
        .filter((node) => node.command === MANAGE_QUICK_TOOLS_COMMAND || visibleCommands.has(node.command))
        .filter((node) => node.tier !== "advanced")
        .map((node) => toCommandNode(sectionId, node));
      return {
        key: `embeddedTools:${sectionId}`,
        kind: "toolSection" as const,
        tool: "agents" as const,
        relativePath: "",
        label: sectionLabel(sectionId, language),
        description: sectionDescription(sectionId, language),
        icon: sectionIcon(sectionId),
        count: sectionChildren.length,
        collapsed: true,
        children: sectionChildren
      };
    })
    .filter((section) => section.children.length > 0);
  const advancedChildren = sectionOrder.flatMap((sectionId) =>
    nodes[sectionId]
      .filter((node) => visibleCommands.has(node.command))
      .filter((node) => node.tier === "advanced")
      .map((node) => toCommandNode(sectionId, node))
  );
  if (advancedChildren.length > 0) {
    children.push({
      key: `embeddedTools:${side}:advanced`,
      kind: "toolSection",
      tool: "agents",
      relativePath: "__quick_tools_advanced__",
      label: localize("Advanced Tools"),
      description: localize("Less common actions"),
      icon: "settings-gear",
      count: advancedChildren.length,
      collapsed: true,
      children: advancedChildren
    });
  }
  return {
    key: `embeddedTools:${side}`,
    kind: "toolSection",
    tool: "agents",
    relativePath: "",
    label: localize("Quick Tools"),
    description: side === "workspace"
      ? localize("Common and workspace actions")
      : localize("Central actions"),
    icon: "tools",
    count: children.length,
    collapsed: true,
    children
  };
}

function getVisibleQuickToolCommands(): Set<string> {
  const configured = vscode.workspace.getConfiguration("skillBridge").get<string[]>("visibleQuickTools", []);
  return configured.length > 0 ? new Set(configured) : new Set(DEFAULT_QUICK_TOOL_COMMANDS);
}

function sectionLabel(sectionId: CommonToolSectionId, language: UiLanguage): string {
  if (sectionId === "common") return localize("Common Functions");
  if (sectionId === "workspace") return localize("Workspace Functions");
  return localize("Central Functions");
}

function sectionDescription(sectionId: CommonToolSectionId, language: UiLanguage): string {
  if (sectionId === "common") return localize("Shared tools");
  if (sectionId === "workspace") return localize("Workspace-only actions");
  return localize("Central-only actions");
}

function sectionIcon(sectionId: CommonToolSectionId): string {
  if (sectionId === "common") return "tools";
  if (sectionId === "workspace") return "repo";
  return "database";
}

function toCommandNode(sectionId: CommonToolSectionId, node: CommonToolCommand): SkillTreeNode {
  return {
    key: `embeddedTools:${sectionId}:${node.command}`,
    kind: "toolCommand",
    tool: "agents",
    relativePath: "",
    label: node.label,
    description: node.description,
    commandId: node.command,
    icon: node.icon,
    children: []
  };
}
