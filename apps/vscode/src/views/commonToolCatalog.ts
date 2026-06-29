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
  "skillBridge.toggleLanguage",
  "skillBridge.diagnoseEnvironment",
  "skillBridge.setPersonalHome",
  "skillBridge.openWorkspaceFolder",
  "skillBridge.hydrateProject",
  "skillBridge.createProjectPresetFromWorkspace",
  "skillBridge.openCentralFolder",
  "skillBridge.downloadCentralSkill",
  "skillBridge.openProjectPresetOverview",
  "skillBridge.createCentralPack",
  "skillBridge.repairCentralMetadata"
]);

export function buildCommonToolNodes(language: UiLanguage): Record<CommonToolSectionId, CommonToolCommand[]> {
  return {
    common: [
      {
        kind: "command",
        sectionId: "common",
        label: localize(language, "Review Sync Changes", "동기화 변경 검토"),
        description: localize(language, "Common · compare both sides", "공통 · 양쪽 비교"),
        command: "skillBridge.openTransferExplorer",
        icon: "arrow-swap"
      },
      {
        kind: "command",
        sectionId: "common",
        label: localize(language, "Open Skill Library", "스킬 라이브러리 열기"),
        description: localize(language, "Common · browse grouped assets", "공통 · 그룹 자산 탐색"),
        command: "skillBridge.openLibraryManager",
        icon: "library"
      },
      {
        kind: "command",
        sectionId: "common",
        label: localize(language, "Open Group Overview", "그룹 Overview 열기"),
        description: localize(language, "Common · manage skill groups", "공통 · 스킬 그룹 관리"),
        command: "skillBridge.openGroupOverview",
        icon: "symbol-namespace",
        tier: "advanced"
      },
      {
        kind: "command",
        sectionId: "common",
        label: localize(language, "Open NPX Skill Library", "NPX 스킬 라이브러리 열기"),
        description: localize(language, "Common · manage npx downloads", "공통 · npx 다운로드 관리"),
        command: "skillBridge.openNpxSkillLibrary",
        icon: "cloud",
        tier: "advanced"
      },
      {
        kind: "command",
        sectionId: "common",
        label: localize(language, "Download Skill Manager Skill", "스킬 매니저 스킬 다운로드"),
        description: localize(language, "Common · install bundled helper", "공통 · 번들 도우미 설치"),
        command: "skillBridge.downloadSkillManagerSkill",
        icon: "cloud-download",
        tier: "advanced"
      },
      {
        kind: "command",
        sectionId: "common",
        label: localize(language, "Copy Between Agents", "에이전트 간 복사"),
        description: localize(language, "Common · cross-agent copy", "공통 · 에이전트 간 복사"),
        command: "skillBridge.copyBetweenAgents",
        icon: "arrow-both",
        tier: "advanced"
      },
      {
        kind: "command",
        sectionId: "common",
        label: localize(language, "Switch Agent View", "에이전트 보기 전환"),
        description: localize(language, "Common · filter source agent", "공통 · 에이전트 필터"),
        command: "skillBridge.switchTab",
        icon: "list-tree"
      },
      {
        kind: "command",
        sectionId: "common",
        label: localize(language, "Filter Skill Tree", "스킬 트리 필터"),
        description: localize(language, "Common · status filters", "공통 · 상태 필터"),
        command: "skillBridge.switchTreeFilter",
        icon: "filter"
      },
      {
        kind: "command",
        sectionId: "common",
        label: localize(language, "Manage Quick Tools", "빠른 도구 관리"),
        description: localize(language, "Common · choose visible tools", "공통 · 표시할 도구 선택"),
        command: MANAGE_QUICK_TOOLS_COMMAND,
        icon: "checklist"
      },
      {
        kind: "command",
        sectionId: "common",
        label: localize(language, "Toggle Language", "언어 전환"),
        description: localize(language, "Common · Korean/English UI", "공통 · 한국어/영어 UI"),
        command: "skillBridge.toggleLanguage",
        icon: "globe"
      },
      {
        kind: "command",
        sectionId: "common",
        label: localize(language, "Check Setup and Repair", "설정 점검 및 복구"),
        description: localize(language, "Common · diagnose paths", "공통 · 경로 진단"),
        command: "skillBridge.diagnoseEnvironment",
        icon: "pulse"
      },
      {
        kind: "command",
        sectionId: "common",
        label: localize(language, "Reset Central Library Folder", "중앙 라이브러리 폴더 초기화"),
        description: localize(language, "Common · restore default path", "공통 · 기본 경로 복원"),
        command: "skillBridge.resetPersonalHome",
        icon: "discard",
        tier: "advanced"
      }
    ],
    workspace: [
      {
        kind: "command",
        sectionId: "workspace",
        label: localize(language, "Open Workspace Skills Folder", "작업공간 스킬 폴더 열기"),
        description: localize(language, "Workspace only · local files", "작업공간 전용 · 로컬 파일"),
        command: "skillBridge.openWorkspaceFolder",
        icon: "folder-opened"
      },
      {
        kind: "command",
        sectionId: "workspace",
        label: localize(language, "Apply Project Preset", "프로젝트 프리셋 적용"),
        description: localize(language, "Workspace only · apply presets", "작업공간 전용 · 프리셋 적용"),
        command: "skillBridge.hydrateProject",
        icon: "repo-pull"
      },
      {
        kind: "command",
        sectionId: "workspace",
        label: localize(language, "Create Project Preset from Workspace", "현재 Workspace로 프로젝트 프리셋 만들기"),
        description: localize(language, "Workspace only · save as Central preset", "작업공간 전용 · 중앙 프리셋 저장"),
        command: "skillBridge.createProjectPresetFromWorkspace",
        icon: "package"
      },
      {
        kind: "command",
        sectionId: "workspace",
        label: localize(language, "Configure Workspace Auto Sync", "작업공간 자동 동기화 설정"),
        description: localize(language, "Workspace only · sync settings", "작업공간 전용 · 동기화 설정"),
        command: "skillBridge.configureWorkspaceAutoSync",
        icon: "sync-ignored",
        tier: "advanced"
      },
      {
        kind: "command",
        sectionId: "workspace",
        label: localize(language, "Sync Workspace Agent to Central Now", "지금 작업공간 에이전트를 중앙으로 동기화"),
        description: localize(language, "Workspace only · push to Central", "작업공간 전용 · 중앙으로 반영"),
        command: "skillBridge.syncWorkspaceAgentNow",
        icon: "sync",
        tier: "advanced"
      }
    ],
    central: [
      {
        kind: "command",
        sectionId: "central",
        label: localize(language, "Open Central Library Folder", "중앙 라이브러리 폴더 열기"),
        description: localize(language, "Central only · library files", "중앙 전용 · 라이브러리 파일"),
        command: "skillBridge.openCentralFolder",
        icon: "folder-library"
      },
      {
        kind: "command",
        sectionId: "central",
        label: localize(language, "Set Central Library Folder", "중앙 라이브러리 폴더 설정"),
        description: localize(language, "Central only · choose library path", "중앙 전용 · 라이브러리 경로 선택"),
        command: "skillBridge.setPersonalHome",
        icon: "home"
      },
      {
        kind: "command",
        sectionId: "central",
        label: localize(language, "Download or Update Skill", "스킬 다운로드 또는 업데이트"),
        description: localize(language, "Central only · update from source", "중앙 전용 · 소스에서 업데이트"),
        command: "skillBridge.downloadCentralSkill",
        icon: "cloud-download"
      },
      {
        kind: "command",
        sectionId: "central",
        label: localize(language, "Open Project Presets", "프로젝트 프리셋 열기"),
        description: localize(language, "Central only · manage presets", "중앙 전용 · 프리셋 관리"),
        command: "skillBridge.openProjectPresetOverview",
        icon: "library"
      },
      {
        kind: "command",
        sectionId: "central",
        label: localize(language, "Create Project Preset", "프로젝트 프리셋 만들기"),
        description: localize(language, "Central only · save selected assets", "중앙 전용 · 선택 자산 저장"),
        command: "skillBridge.createCentralPack",
        icon: "package"
      },
      {
        kind: "command",
        sectionId: "central",
        label: localize(language, "Check and Repair Central Metadata", "Central 메타데이터 점검 및 복구"),
        description: localize(language, "Central only · clean preset and group JSON", "중앙 전용 · 프리셋/그룹 JSON 정리"),
        command: "skillBridge.repairCentralMetadata",
        icon: "tools",
        tier: "advanced"
      }
    ]
  };
}
