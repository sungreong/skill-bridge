import type { SelectionGroup } from "../types";
import { localize, type UiLanguage } from "../uiLanguage";

export function formatSkillGroupLabel(group: SelectionGroup, language: UiLanguage): string {
  void language;
  if (group.meta?.mirroredFrom !== "central-preset" || !group.name.startsWith("Preset: ")) {
    return group.name;
  }
  const presetName = group.name.slice("Preset: ".length).trim();
  if (presetName.startsWith("Install: ")) {
    return localize("Preset: Install: {0}", presetName.slice("Install: ".length).trim());
  }
  return localize("Preset: {0}", presetName);
}
