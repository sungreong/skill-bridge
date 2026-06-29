import * as vscode from "vscode";
import { renderAddMoveWizardHtml, type AddMoveWizardPayload } from "./addMoveWizardView";
import type { SkillAssetTreeMeta, ToolType } from "./types";
import { coerceUiLanguage, type UiLanguage } from "./uiLanguage";

type TranslationFn = (english: string, korean: string) => string;

export type WizardAssetPick = {
  tool: ToolType;
  rootRelativePath: string;
  skillName: string;
  status: SkillAssetTreeMeta["status"];
  warnings: Array<unknown>;
  fileCount: number;
  updatedAt: string | null;
};

export function summarizeWizardAssets(assets: WizardAssetPick[]): AddMoveWizardPayload["workspace"] {
  return {
    total: assets.length,
    changed: assets.filter((asset) => asset.status === "changed").length,
    fresh: assets.filter((asset) => asset.status === "new").length,
    risk: assets.filter((asset) => asset.status === "risk").length,
    missing: assets.filter((asset) => asset.status === "missingSkillMd").length,
    recent: assets.filter((asset) => asset.status === "recent").length,
    preview: assets.slice(0, 8).map((asset) => ({
      tool: asset.tool,
      skillName: asset.skillName,
      status: asset.status,
      warnings: asset.warnings.length,
      fileCount: asset.fileCount
    }))
  };
}

export function createAddMoveWizardPanelOpener(input: {
  tr: TranslationFn;
  settingsSection: string;
  getPayload: () => AddMoveWizardPayload;
  registerLanguageRefresh: (panel: vscode.WebviewPanel, render: () => void | Promise<void>) => void;
  setLanguage: (language: UiLanguage) => Promise<void>;
  refresh: () => Promise<void>;
  runNewSkillWizard: () => Promise<void>;
  runAssetTransferWizard: (side: "workspace" | "central") => Promise<void>;
  runAgentCopyWizard: () => Promise<void>;
  installSkills: () => Promise<void>;
  hydrateCurrentProject: () => Promise<void>;
  downloadCentralSkillToWorkspace: () => Promise<void>;
  downloadSkillManagerSkillToWorkspace: () => Promise<void>;
  createCentralPack: () => Promise<void>;
  toUserError: (error: unknown) => string;
}): () => Promise<void> {
  return async function openAddMoveWizardPanel(): Promise<void> {
    const panel = vscode.window.createWebviewPanel(
      "skillBridgeAddMoveWizard",
      input.tr("Skill Manager", "스킬 관리자"),
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    const postState = (): void => {
      panel.webview.postMessage({ type: "state", payload: input.getPayload() });
    };
    const postUi = (
      message: string,
      tone: "info" | "warn" | "error" = "info",
      busy = false,
      action = ""
    ): void => {
      panel.webview.postMessage({ type: "ui", payload: { message, tone, busy, action } });
    };
    const render = (): void => {
      panel.title = input.tr("Skill Manager", "스킬 관리자");
      panel.webview.html = renderAddMoveWizardHtml(panel.webview, input.getPayload());
    };
    input.registerLanguageRefresh(panel, render);

    render();
    panel.webview.onDidReceiveMessage(async (msg: unknown) => {
      if (!msg || typeof msg !== "object") return;
      const message = msg as { type?: string; payload?: unknown };
      try {
        if (message.type === "setLanguage") {
          const payload = (message.payload && typeof message.payload === "object") ? message.payload as { language?: unknown } : {};
          const next: UiLanguage = coerceUiLanguage(payload.language);
          await input.setLanguage(next);
          panel.title = input.tr("Skill Manager", "스킬 관리자");
          postState();
          postUi(input.tr("Language switched.", "언어를 전환했습니다."));
          return;
        }
        if (message.type === "refresh") {
          postUi(input.tr("Refreshing skill assets...", "스킬 자산 목록을 새로고침하는 중입니다..."), "info", true, "refresh");
          await input.refresh();
          postState();
          postUi(input.tr("Skill assets refreshed.", "스킬 자산 목록을 갱신했습니다."));
          return;
        }
        if (message.type === "newSkill") {
          postUi(input.tr("Opening Create New Skill...", "새 스킬 만들기 입력창을 여는 중입니다..."), "info", true, "newSkill");
          await input.runNewSkillWizard();
          await input.refresh();
          postState();
          postUi(input.tr("Create New Skill completed.", "새 스킬 생성 흐름을 완료했습니다."));
          return;
        }
        if (message.type === "promoteAsset") {
          postUi(input.tr("Opening Send to Central...", "작업공간 스킬 선택창을 여는 중입니다..."), "info", true, "promoteAsset");
          await input.runAssetTransferWizard("workspace");
          await input.refresh();
          postState();
          postUi(input.tr("Workspace to Central review completed.", "작업공간 → 중앙 검토 흐름을 완료했습니다."));
          return;
        }
        if (message.type === "importAsset") {
          postUi(input.tr("Opening Bring to Workspace...", "중앙 스킬 선택창을 여는 중입니다..."), "info", true, "importAsset");
          await input.runAssetTransferWizard("central");
          await input.refresh();
          postState();
          postUi(input.tr("Central to Workspace review completed.", "중앙 → 작업공간 검토 흐름을 완료했습니다."));
          return;
        }
        if (message.type === "copyAgent") {
          postUi(input.tr("Opening Copy Between Agents...", "에이전트 간 복사 선택창을 여는 중입니다..."), "info", true, "copyAgent");
          await input.runAgentCopyWizard();
          await input.refresh();
          postState();
          postUi(input.tr("Copy Between Agents completed.", "에이전트 간 복사 흐름을 완료했습니다."));
          return;
        }
        if (message.type === "installNpx") {
          postUi(input.tr("Opening npx skills add...", "npx skills add 흐름을 여는 중입니다..."), "info", true, "installNpx");
          await input.installSkills();
          await input.refresh();
          postState();
          postUi(input.tr("npx skills add completed.", "npx skills add 흐름을 완료했습니다."));
          return;
        }
        if (message.type === "hydrateProject") {
          postUi(input.tr("Opening Add Skills to Workspace...", "현재 프로젝트에 스킬을 채우는 흐름을 여는 중입니다..."), "info", true, "hydrateProject");
          await input.hydrateCurrentProject();
          await input.refresh();
          postState();
          postUi(input.tr("Add Skills to Workspace completed.", "프로젝트에 스킬 채우기를 완료했습니다."));
          return;
        }
        if (message.type === "downloadCentralSkill") {
          postUi(input.tr("Opening Download or Update Skill...", "스킬 다운로드/업데이트 흐름을 여는 중입니다..."), "info", true, "downloadCentralSkill");
          await input.downloadCentralSkillToWorkspace();
          await input.refresh();
          postState();
          postUi(input.tr("Download or Update Skill completed.", "스킬 다운로드/업데이트를 완료했습니다."));
          return;
        }
        if (message.type === "downloadSkillManagerSkill") {
          postUi(
            input.tr("Downloading bundled skill-manager skill...", "번들된 skill-manager 스킬을 다운로드하는 중입니다..."),
            "info",
            true,
            "downloadSkillManagerSkill"
          );
          await input.downloadSkillManagerSkillToWorkspace();
          await input.refresh();
          postState();
          postUi(input.tr("Bundled skill-manager skill download completed.", "skill-manager 스킬 다운로드를 완료했습니다."));
          return;
        }
        if (message.type === "createPack") {
          postUi(input.tr("Opening Create Project Preset...", "프로젝트 프리셋 생성 흐름을 여는 중입니다..."), "info", true, "createPack");
          await input.createCentralPack();
          await input.refresh();
          postState();
          postUi(input.tr("Create Project Preset completed.", "프로젝트 프리셋 생성을 완료했습니다."));
        }
      } catch (error) {
        const text = input.toUserError(error);
        postUi(text, "error", false);
        vscode.window.showErrorMessage(text);
      }
    });
  };
}
