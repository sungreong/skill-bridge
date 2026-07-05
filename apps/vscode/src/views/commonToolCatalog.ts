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
        label: localize(language, "Compare and Apply Changes", "변경 비교/반영"),
        description: localize(language, "Start here · review Workspace and Central", "처음 시작 · 작업공간과 중앙 비교"),
        command: "skillBridge.openTransferExplorer",
        icon: "arrow-swap"
      },
      {
        kind: "command",
        sectionId: "common",
        label: localize(language, "Manage Skill Library", "스킬 라이브러리 관리"),
        description: localize(language, "Browse, filter, save, and bring skills", "스킬 탐색·필터·반영"),
        command: "skillBridge.openLibraryManager",
        icon: "library"
      },
      {
        kind: "command",
        sectionId: "common",
        label: localize(language, "Manage Skill Groups", "스킬 그룹 관리"),
        description: localize(language, "Advanced · edit groups and their skills", "고급 · 그룹과 포함 스킬 편집"),
        command: "skillBridge.openGroupOverview",
        icon: "symbol-namespace",
        tier: "advanced"
      },
      {
        kind: "command",
        sectionId: "common",
        label: localize(language, "Manage npx-installed Skills", "npx 설치 스킬 관리"),
        description: localize(language, "Advanced · update skills installed from npx", "고급 · npx로 받은 스킬 업데이트"),
        command: "skillBridge.openNpxSkillLibrary",
        icon: "cloud",
        tier: "advanced"
      },
      {
        kind: "command",
        sectionId: "common",
        label: localize(language, "Install Skill Manager Helper", "Skill Manager 도우미 설치"),
        description: localize(language, "Advanced · add the bundled helper skill", "고급 · 번들 도우미 스킬 추가"),
        command: "skillBridge.downloadSkillManagerSkill",
        icon: "cloud-download",
        tier: "advanced"
      },
      {
        kind: "command",
        sectionId: "common",
        label: localize(language, "Copy to Another Agent", "다른 에이전트로 복사"),
        description: localize(language, "Advanced · copy within the same side", "고급 · 같은 쪽 안에서 복사"),
        command: "skillBridge.copyBetweenAgents",
        icon: "arrow-both",
        tier: "advanced"
      },
      {
        kind: "command",
        sectionId: "common",
        label: localize(language, "Choose Visible Agents", "보일 에이전트 선택"),
        description: localize(language, "View · show selected agent folders", "보기 · 표시할 에이전트 폴더"),
        command: "skillBridge.switchTab",
        icon: "list-tree"
      },
      {
        kind: "command",
        sectionId: "common",
        label: localize(language, "Filter by Skill Status", "스킬 상태 필터"),
        description: localize(language, "View · changed, new, warning, recent", "보기 · 변경/신규/경고/최근"),
        command: "skillBridge.switchTreeFilter",
        icon: "filter"
      },
      {
        kind: "command",
        sectionId: "common",
        label: localize(language, "Manage Quick Tools", "빠른 도구 관리"),
        description: localize(language, "View · choose the shortcuts shown here", "보기 · 여기 표시할 바로가기 선택"),
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
        label: localize(language, "Check Setup", "설정 점검"),
        description: localize(language, "Setup · diagnose paths and tools", "설정 · 경로와 도구 진단"),
        command: "skillBridge.diagnoseEnvironment",
        icon: "pulse"
      },
      {
        kind: "command",
        sectionId: "common",
        label: localize(language, "Reset Central Folder Setting", "중앙 폴더 설정 되돌리기"),
        description: localize(language, "Advanced · restore the default folder path", "고급 · 기본 폴더 경로 복원"),
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
        description: localize(language, "Workspace · open local skill files", "작업공간 · 로컬 스킬 파일"),
        command: "skillBridge.openWorkspaceFolder",
        icon: "folder-opened"
      },
      {
        kind: "command",
        sectionId: "workspace",
        label: localize(language, "Apply Preset to Workspace", "프리셋을 작업공간에 적용"),
        description: localize(language, "Bring a saved Central preset into this project", "중앙 프리셋을 이 프로젝트로 가져오기"),
        command: "skillBridge.hydrateProject",
        icon: "repo-pull"
      },
      {
        kind: "command",
        sectionId: "workspace",
        label: localize(language, "Save Workspace as Central Preset", "작업공간 스킬로 중앙 프리셋 만들기"),
        description: localize(language, "Save selected Workspace skills for reuse", "작업공간 스킬을 재사용 프리셋으로 저장"),
        command: "skillBridge.createProjectPresetFromWorkspace",
        icon: "package"
      },
      {
        kind: "command",
        sectionId: "workspace",
        label: localize(language, "Configure Auto Save to Central", "자동 중앙 반영 설정"),
        description: localize(language, "Advanced · watch Workspace skills for changes", "고급 · 작업공간 스킬 변경 감시"),
        command: "skillBridge.configureWorkspaceAutoSync",
        icon: "sync-ignored",
        tier: "advanced"
      },
      {
        kind: "command",
        sectionId: "workspace",
        label: localize(language, "Save Workspace Agent to Central Now", "지금 중앙에 반영"),
        description: localize(language, "Advanced · copy one Workspace agent to Central", "고급 · 작업공간 에이전트 하나를 중앙에 복사"),
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
        description: localize(language, "Central · open reusable skill files", "중앙 · 재사용 스킬 파일"),
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
        label: localize(language, "Bring Central Skill to Workspace", "중앙 스킬을 작업공간으로 가져오기"),
        description: localize(language, "Choose one Central skill and target agent", "중앙 스킬 하나와 받을 에이전트 선택"),
        command: "skillBridge.downloadCentralSkill",
        icon: "cloud-download"
      },
      {
        kind: "command",
        sectionId: "central",
        label: localize(language, "Manage Project Presets", "프로젝트 프리셋 관리"),
        description: localize(language, "Central · review, edit, apply presets", "중앙 · 프리셋 검토·편집·적용"),
        command: "skillBridge.openProjectPresetOverview",
        icon: "library"
      },
      {
        kind: "command",
        sectionId: "central",
        label: localize(language, "Create Preset from Central Skills", "중앙 스킬로 프리셋 만들기"),
        description: localize(language, "Advanced · save selected Central skills", "고급 · 선택한 중앙 스킬 저장"),
        command: "skillBridge.createCentralPack",
        icon: "package"
      },
      {
        kind: "command",
        sectionId: "central",
        label: localize(language, "Clean Central Presets and Groups", "중앙 프리셋/그룹 정리"),
        description: localize(language, "Advanced · remove stale metadata entries", "고급 · 오래된 메타데이터 정리"),
        command: "skillBridge.repairCentralMetadata",
        icon: "tools",
        tier: "advanced"
      }
    ]
  };
}
