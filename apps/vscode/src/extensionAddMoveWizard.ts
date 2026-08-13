import * as vscode from "vscode";
import { renderAddMoveWizardHtml, type AddMoveWizardPayload } from "./addMoveWizardView";
import type { SkillAssetTreeMeta, ToolType } from "./types";

type TranslationFn = (message: string, ...args: Array<string | number | boolean>) => string;

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
  applyPanelBranding: (panel: vscode.WebviewPanel, render: () => void | Promise<void>) => void;
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
      input.tr("Add or Move Helper"),
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
      panel.title = input.tr("Add or Move Helper");
      panel.webview.html = renderAddMoveWizardHtml(panel.webview, input.getPayload());
    };
    input.applyPanelBranding(panel, render);

    render();
    panel.webview.onDidReceiveMessage(async (msg: unknown) => {
      if (!msg || typeof msg !== "object") return;
      const message = msg as { type?: string; payload?: unknown };
      try {
        if (message.type === "refresh") {
          postUi(input.tr("Refreshing skill assets..."), "info", true, "refresh");
          await input.refresh();
          postState();
          postUi(input.tr("Skill assets refreshed."));
          return;
        }
        if (message.type === "newSkill") {
          postUi(input.tr("Opening Create New Skill..."), "info", true, "newSkill");
          await input.runNewSkillWizard();
          await input.refresh();
          postState();
          postUi(input.tr("Create New Skill completed."));
          return;
        }
        if (message.type === "promoteAsset") {
          postUi(input.tr("Opening Save to Central review..."), "info", true, "promoteAsset");
          await input.runAssetTransferWizard("workspace");
          await input.refresh();
          postState();
          postUi(input.tr("Save to Central review completed."));
          return;
        }
        if (message.type === "importAsset") {
          postUi(input.tr("Opening Bring to Workspace..."), "info", true, "importAsset");
          await input.runAssetTransferWizard("central");
          await input.refresh();
          postState();
          postUi(input.tr("Central to Workspace review completed."));
          return;
        }
        if (message.type === "copyAgent") {
          postUi(input.tr("Opening Copy to Another Agent..."), "info", true, "copyAgent");
          await input.runAgentCopyWizard();
          await input.refresh();
          postState();
          postUi(input.tr("Copy to Another Agent completed."));
          return;
        }
        if (message.type === "installNpx") {
          postUi(input.tr("Opening npx skills add..."), "info", true, "installNpx");
          await input.installSkills();
          await input.refresh();
          postState();
          postUi(input.tr("npx skills add completed."));
          return;
        }
        if (message.type === "hydrateProject") {
          postUi(input.tr("Opening Apply Preset to Workspace..."), "info", true, "hydrateProject");
          await input.hydrateCurrentProject();
          await input.refresh();
          postState();
          postUi(input.tr("Apply Preset to Workspace completed."));
          return;
        }
        if (message.type === "downloadCentralSkill") {
          postUi(input.tr("Opening Bring Central Skill to Workspace..."), "info", true, "downloadCentralSkill");
          await input.downloadCentralSkillToWorkspace();
          await input.refresh();
          postState();
          postUi(input.tr("Bring Central Skill to Workspace completed."));
          return;
        }
        if (message.type === "downloadSkillManagerSkill") {
          postUi(
            input.tr("Installing bundled Skill Manager helper skill..."),
            "info",
            true,
            "downloadSkillManagerSkill"
          );
          await input.downloadSkillManagerSkillToWorkspace();
          await input.refresh();
          postState();
          postUi(input.tr("Bundled Skill Manager helper installed."));
          return;
        }
        if (message.type === "createPack") {
          postUi(input.tr("Opening Create Preset from Central Skills..."), "info", true, "createPack");
          await input.createCentralPack();
          await input.refresh();
          postState();
          postUi(input.tr("Create Preset from Central Skills completed."));
        }
      } catch (error) {
        const text = input.toUserError(error);
        postUi(text, "error", false);
        vscode.window.showErrorMessage(text);
      }
    });
  };
}
