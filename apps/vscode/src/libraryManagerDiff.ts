import * as vscode from "vscode";
import type { ToolType, TransferPlan, TransferPlanItem } from "./types";
import {
  buildFolderDiffSummaryRows,
  renderFolderDiffSummaryHtml
} from "./transferDiffViews";
import type { TreeSide } from "./libraryManagerTypes";
import type { UiLanguage } from "./uiLanguage";

type TranslationFn = (message: string, ...args: Array<string | number | boolean>) => string;

export type LibraryDiffDeps = {
  tr: TranslationFn;
  getUiLanguage: () => UiLanguage;
  applyPanelBranding: (panel: vscode.WebviewPanel, render: () => void | Promise<void>) => void;
  buildTransferPlan: (
    sourceSide: TreeSide,
    selections: Array<{ tool: ToolType; relativePath: string }>,
    options?: { scopeHints?: Array<{ tool: ToolType; relativePath: string; kind: "file" | "folder" }> }
  ) => Promise<TransferPlan>;
  openTransferDiff: (item: TransferPlanItem) => Promise<void>;
};

export function createLibraryDiffOpener(deps: LibraryDiffDeps) {
  return async (
    sourceSide: TreeSide,
    tool: ToolType,
    relativePath: string,
    kind: "file" | "folder"
  ): Promise<void> => {
    const scopeHints = [{ tool, relativePath, kind }] as const;
    const plan = await deps.buildTransferPlan(sourceSide, [], { scopeHints: [...scopeHints] });
    if (kind === "file") {
      const item = plan.items.find((entry) => entry.tool === tool && entry.relativePath === relativePath);
      if (!item) {
        vscode.window.showWarningMessage(deps.tr("Could not find a diff target."));
        return;
      }
      await deps.openTransferDiff(item);
      return;
    }

    const targets = plan.items.filter((entry) =>
      entry.tool === tool && (entry.relativePath === relativePath || entry.relativePath.startsWith(`${relativePath}/`))
    );
    if (targets.length === 0) {
      vscode.window.showWarningMessage(deps.tr("Could not find a folder diff summary target."));
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "skillBridgeFolderDiffSummaryFromLibrary",
      deps.tr("Folder Diff Summary: {0}/{1}", String(tool), String(relativePath)),
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: false }
    );
    const render = (): void => {
      const language = deps.getUiLanguage();
      panel.title = deps.tr("Folder Diff Summary: {0}/{1}", String(tool), String(relativePath));
      panel.webview.html = renderFolderDiffSummaryHtml(panel.webview, {
        mode: sourceSide === "workspace" ? "workspaceToCentral" : "centralToWorkspace",
        tool,
        relativePath,
        rows: buildFolderDiffSummaryRows(targets, sourceSide === "workspace" ? "workspaceToCentral" : "centralToWorkspace")
      }, language);
    };
    deps.applyPanelBranding(panel, render);
    render();
    panel.webview.onDidReceiveMessage(async (subMsg: unknown) => {
      if (!subMsg || typeof subMsg !== "object") return;
      const inner = subMsg as { type?: string; payload?: unknown };
      if (inner.type !== "openDiff") return;
      const key = String((inner.payload as { key?: string } | undefined)?.key ?? "");
      const target = targets.find((entry) => entry.key === key);
      if (!target) return;
      await deps.openTransferDiff(target);
    });
  };
}
