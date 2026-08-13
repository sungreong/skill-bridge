import { localize, type UiLanguage } from "../uiLanguage";

export type CommonToolSectionId = "common" | "workspace" | "central";

export type CommonToolCommand = {
  kind: "command";
  sectionId: CommonToolSectionId;
  tier?: "core" | "advanced";
  label: string;
  description: string;
  command: string;
  icon: string;
};

export const COMMON_TOOL_SECTION_ORDER: CommonToolSectionId[] = ["common", "workspace", "central"];
export const MANAGE_QUICK_TOOLS_COMMAND = "skillBridge.manageQuickTools";
export const DEFAULT_QUICK_TOOL_COMMANDS = new Set<string>([
  "skillBridge.openTransferExplorer",
  "skillBridge.openLibraryManager",
  "skillBridge.switchTab",
  "skillBridge.switchTreeFilter",
  "skillBridge.diagnoseEnvironment",
  "skillBridge.setPersonalHome",
  "skillBridge.openWorkspaceFolder",
  "skillBridge.hydrateProject",
  "skillBridge.createProjectPresetFromWorkspace",
  "skillBridge.openCentralFolder",
  "skillBridge.downloadCentralSkill",
  "skillBridge.openProjectPresetOverview"
]);

export function buildCommonToolNodes(language: UiLanguage): Record<CommonToolSectionId, CommonToolCommand[]> {
  return {
    common: [
      {
        kind: "command",
        sectionId: "common",
        label: localize("Compare and Apply Changes"),
        description: localize("Start here · review Workspace and Central"),
        command: "skillBridge.openTransferExplorer",
        icon: "arrow-swap"
      },
      {
        kind: "command",
        sectionId: "common",
        label: localize("Manage Skill Library"),
        description: localize("Browse, filter, save, and bring skills"),
        command: "skillBridge.openLibraryManager",
        icon: "library"
      },
      {
        kind: "command",
        sectionId: "common",
        label: localize("Manage Skill Groups"),
        description: localize("Advanced · edit groups and their skills"),
        command: "skillBridge.openGroupOverview",
        icon: "symbol-namespace",
        tier: "advanced"
      },
      {
        kind: "command",
        sectionId: "common",
        label: localize("Manage npx-installed Skills"),
        description: localize("Advanced · update skills installed from npx"),
        command: "skillBridge.openNpxSkillLibrary",
        icon: "cloud",
        tier: "advanced"
      },
      {
        kind: "command",
        sectionId: "common",
        label: localize("Install Skill Manager Helper"),
        description: localize("Advanced · add the bundled helper skill"),
        command: "skillBridge.downloadSkillManagerSkill",
        icon: "cloud-download",
        tier: "advanced"
      },
      {
        kind: "command",
        sectionId: "common",
        label: localize("Copy to Another Agent"),
        description: localize("Advanced · copy within the same side"),
        command: "skillBridge.copyBetweenAgents",
        icon: "arrow-both",
        tier: "advanced"
      },
      {
        kind: "command",
        sectionId: "common",
        label: localize("Choose Visible Agents"),
        description: localize("View · show selected agent folders"),
        command: "skillBridge.switchTab",
        icon: "list-tree"
      },
      {
        kind: "command",
        sectionId: "common",
        label: localize("Filter by Skill Status"),
        description: localize("View · changed, new, warning, recent"),
        command: "skillBridge.switchTreeFilter",
        icon: "filter"
      },
      {
        kind: "command",
        sectionId: "common",
        label: localize("Manage Quick Tools"),
        description: localize("View · choose the shortcuts shown here"),
        command: MANAGE_QUICK_TOOLS_COMMAND,
        icon: "checklist"
      },
      {
        kind: "command",
        sectionId: "common",
        label: localize("Check Setup"),
        description: localize("Setup · diagnose paths and tools"),
        command: "skillBridge.diagnoseEnvironment",
        icon: "pulse"
      },
      {
        kind: "command",
        sectionId: "common",
        label: localize("Reset Central Folder Setting"),
        description: localize("Advanced · restore the default folder path"),
        command: "skillBridge.resetPersonalHome",
        icon: "discard",
        tier: "advanced"
      }
    ],
    workspace: [
      {
        kind: "command",
        sectionId: "workspace",
        label: localize("Open Workspace Skills Folder"),
        description: localize("Workspace · open local skill files"),
        command: "skillBridge.openWorkspaceFolder",
        icon: "folder-opened"
      },
      {
        kind: "command",
        sectionId: "workspace",
        label: localize("Apply Preset to Workspace"),
        description: localize("Bring a saved Central preset into this project"),
        command: "skillBridge.hydrateProject",
        icon: "repo-pull"
      },
      {
        kind: "command",
        sectionId: "workspace",
        label: localize("Save Workspace as Central Preset"),
        description: localize("Save selected Workspace skills for reuse"),
        command: "skillBridge.createProjectPresetFromWorkspace",
        icon: "package"
      },
      {
        kind: "command",
        sectionId: "workspace",
        label: localize("Configure Auto Save to Central"),
        description: localize("Advanced · watch Workspace skills for changes"),
        command: "skillBridge.configureWorkspaceAutoSync",
        icon: "sync-ignored",
        tier: "advanced"
      },
      {
        kind: "command",
        sectionId: "workspace",
        label: localize("Save Workspace Agent to Central Now"),
        description: localize("Advanced · copy one Workspace agent to Central"),
        command: "skillBridge.syncWorkspaceAgentNow",
        icon: "sync",
        tier: "advanced"
      }
    ],
    central: [
      {
        kind: "command",
        sectionId: "central",
        label: localize("Open Central Library Folder"),
        description: localize("Central · open reusable skill files"),
        command: "skillBridge.openCentralFolder",
        icon: "folder-library"
      },
      {
        kind: "command",
        sectionId: "central",
        label: localize("Set Central Library Folder"),
        description: localize("Central only · choose library path"),
        command: "skillBridge.setPersonalHome",
        icon: "home"
      },
      {
        kind: "command",
        sectionId: "central",
        label: localize("Bring Central Skill to Workspace"),
        description: localize("Choose one Central skill and target agent"),
        command: "skillBridge.downloadCentralSkill",
        icon: "cloud-download"
      },
      {
        kind: "command",
        sectionId: "central",
        label: localize("Manage Project Presets"),
        description: localize("Central · review, edit, apply presets"),
        command: "skillBridge.openProjectPresetOverview",
        icon: "library"
      },
      {
        kind: "command",
        sectionId: "central",
        label: localize("Create Preset from Central Skills"),
        description: localize("Advanced · save selected Central skills"),
        command: "skillBridge.createCentralPack",
        icon: "package"
      },
      {
        kind: "command",
        sectionId: "central",
        label: localize("Clean Central Presets and Groups"),
        description: localize("Advanced · remove stale metadata entries"),
        command: "skillBridge.repairCentralMetadata",
        icon: "tools",
        tier: "advanced"
      }
    ]
  };
}
