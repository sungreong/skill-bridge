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
      input.tr("Add or Move Helper", "스킬 추가/이동 도우미"),
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
      panel.title = input.tr("Add or Move Helper", "스킬 추가/이동 도우미");
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
          panel.title = input.tr("Add or Move Helper", "스킬 추가/이동 도우미");
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
          postUi(input.tr("Opening Save to Central review...", "중앙 반영 검토를 여는 중입니다..."), "info", true, "promoteAsset");
          await input.runAssetTransferWizard("workspace");
          await input.refresh();
          postState();
          postUi(input.tr("Save to Central review completed.", "중앙 반영 검토를 완료했습니다."));
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
          postUi(input.tr("Opening Copy to Another Agent...", "다른 에이전트로 복사 선택창을 여는 중입니다..."), "info", true, "copyAgent");
          await input.runAgentCopyWizard();
          await input.refresh();
          postState();
          postUi(input.tr("Copy to Another Agent completed.", "다른 에이전트로 복사를 완료했습니다."));
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
          postUi(input.tr("Opening Apply Preset to Workspace...", "프리셋을 작업공간에 적용하는 흐름을 여는 중입니다..."), "info", true, "hydrateProject");
          await input.hydrateCurrentProject();
          await input.refresh();
          postState();
          postUi(input.tr("Apply Preset to Workspace completed.", "프리셋 작업공간 적용을 완료했습니다."));
          return;
        }
        if (message.type === "downloadCentralSkill") {
          postUi(input.tr("Opening Bring Central Skill to Workspace...", "중앙 스킬을 작업공간으로 가져오는 흐름을 여는 중입니다..."), "info", true, "downloadCentralSkill");
          await input.downloadCentralSkillToWorkspace();
          await input.refresh();
          postState();
          postUi(input.tr("Bring Central Skill to Workspace completed.", "중앙 스킬 가져오기를 완료했습니다."));
          return;
        }
        if (message.type === "downloadSkillManagerSkill") {
          postUi(
            input.tr("Installing bundled Skill Manager helper skill...", "번들된 Skill Manager 도우미 스킬을 설치하는 중입니다..."),
            "info",
            true,
            "downloadSkillManagerSkill"
          );
          await input.downloadSkillManagerSkillToWorkspace();
          await input.refresh();
          postState();
          postUi(input.tr("Bundled Skill Manager helper installed.", "Skill Manager 도우미 설치를 완료했습니다."));
          return;
        }
        if (message.type === "createPack") {
          postUi(input.tr("Opening Create Preset from Central Skills...", "중앙 스킬로 프리셋 만드는 흐름을 여는 중입니다..."), "info", true, "createPack");
          await input.createCentralPack();
          await input.refresh();
          postState();
          postUi(input.tr("Create Preset from Central Skills completed.", "중앙 스킬 프리셋 만들기를 완료했습니다."));
        }
      } catch (error) {
        const text = input.toUserError(error);
        postUi(text, "error", false);
        vscode.window.showErrorMessage(text);
      }
    });
  };
}
