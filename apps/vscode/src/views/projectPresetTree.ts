import type { ProjectPreset, SkillTreeNode, ToolType } from "../types";
import { localize, type UiLanguage } from "../uiLanguage";

export function buildPresetRoot(presets: ProjectPreset[], language: UiLanguage): SkillTreeNode | null {
  const children = presets
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((preset) => {
      const agents = uniquePresetTools(preset).length;
      return {
        key: `preset:${preset.id}`,
        kind: "preset" as const,
        tool: "agents" as const,
        relativePath: `__project_presets__/${preset.id}`,
        label: preset.name,
        description: preset.description,
        side: "central" as const,
        presetId: preset.id,
        count: preset.targets.length,
        treeSkillCount: preset.targets.length,
        children: [],
        assetFileCount: agents
      };
    });
  return {
    key: "project-presets:central",
    kind: "presetRoot",
    tool: "agents",
    relativePath: "__project_presets__",
    label: localize("Project Presets"),
    side: "central",
    count: presets.length,
    children
  };
}

export function uniquePresetTools(preset: ProjectPreset): ToolType[] {
  return [...new Set(preset.targets.map((target) => target.tool))].sort((a, b) => a.localeCompare(b));
}
