import { promises as fs } from "node:fs";
import * as vscode from "vscode";
import type { SkillAssetTreeMeta, SkillAssetWarning, SkillTreeNode, TransferPlanItem } from "./types";
import { buildFolderDiffRows, resolveSkillPath, type FolderEntryRow } from "./skillPaths";
import { createFileUriFromAbsolutePath } from "./extensionSupport";
import { renderFolderTransferDiffHtml, renderTypeChangedTransferDiffHtml } from "./transferDiffViews";
import type { SkillTreeProvider } from "./views/skillTreeProvider";
import type { UiLanguage } from "./uiLanguage";

type TreeSide = "workspace" | "central";
type TranslationFn = (message: string, ...args: Array<string | number | boolean>) => string;

export function createReviewTools(args: {
  tr: TranslationFn;
  toUserError: (error: unknown) => string;
  workspaceProvider: SkillTreeProvider;
  centralProvider: SkillTreeProvider;
  state: {
    workspacePath: string;
    centralRepoPath: string;
    workspaceAssetMeta: Map<string, SkillAssetTreeMeta>;
    centralAssetMeta: Map<string, SkillAssetTreeMeta>;
  };
  getWorkspaceSelection: () => SkillTreeNode[];
  getCentralSelection: () => SkillTreeNode[];
  applyPanelBranding: (panel: vscode.WebviewPanel, render: () => void | Promise<void>) => void;
  getUiLanguage: () => UiLanguage;
  exists: (targetPath: string) => Promise<boolean>;
  collectFolderEntryRows: (targetPath: string) => Promise<FolderEntryRow[]>;
}): {
  showNodeWarningReasons: (side: TreeSide, node?: SkillTreeNode) => Promise<void>;
  openTransferDiff: (item: TransferPlanItem) => Promise<void>;
} {
  const warningSeverityRank = (severity: SkillAssetWarning["severity"]): number => {
    if (severity === "danger") return 2;
    if (severity === "warning") return 1;
    return 0;
  };

  const warningSeverityLabel = (severity: SkillAssetWarning["severity"]): string => {
    if (severity === "danger") return args.tr("Danger");
    if (severity === "warning") return args.tr("Warning");
    return args.tr("Info");
  };

  const warningCodeLabel = (code: SkillAssetWarning["code"]): string => {
    const labels: Record<SkillAssetWarning["code"], string> = {
      "missing-skill-md": args.tr("Missing SKILL.md"),
      "duplicate-name": args.tr("Duplicate Name"),
      "broken-reference": args.tr("Broken Relative Link"),
      "sensitive-content": args.tr("Possible Sensitive Info"),
      "workspace-specific-path": args.tr("Workspace-Specific Path"),
      "script-file": args.tr("Contains Script File"),
      "target-newer": args.tr("Other Side Is Newer")
    };
    return labels[code];
  };

  const skillAssetStatusLabel = (status: SkillAssetTreeMeta["status"]): string => {
    if (status === "same") return args.tr("Same");
    if (status === "new") return args.tr("New Skill");
    if (status === "changed") return args.tr("Changed");
    if (status === "missingSkillMd") return args.tr("Missing SKILL.md");
    if (status === "risk") return args.tr("Warning");
    return args.tr("Recent");
  };

  const skillAssetStatusDescription = (status: SkillAssetTreeMeta["status"]): string => {
    if (status === "same") return args.tr("Workspace and Central have the same files and content.");
    if (status === "new") return args.tr("The matching skill does not exist on the other side.");
    if (status === "changed") return args.tr("Workspace and Central have different files or content.");
    if (status === "missingSkillMd") return args.tr("The skill folder does not contain SKILL.md.");
    if (status === "risk") return args.tr("One or more warning checks take precedence over the comparison status.");
    return args.tr("The skill was updated within the last 7 days.");
  };

  const collectWarningReasons = (node: SkillTreeNode): Array<{ node: SkillTreeNode; warning: SkillAssetWarning }> => {
    const out = new Map<string, { node: SkillTreeNode; warning: SkillAssetWarning }>();
    const walk = (entry: SkillTreeNode): void => {
      for (const warning of entry.assetWarnings ?? []) {
        const key = `${warning.code}:${warning.relativePath ?? entry.relativePath}:${warning.message}`;
        out.set(key, { node: entry, warning });
      }
      for (const child of entry.children) walk(child);
    };
    walk(node);
    return [...out.values()].sort((a, b) => (
      warningSeverityRank(b.warning.severity) - warningSeverityRank(a.warning.severity)
      || (a.warning.relativePath ?? a.node.relativePath).localeCompare(b.warning.relativePath ?? b.node.relativePath)
      || a.warning.code.localeCompare(b.warning.code)
    ));
  };

  const getAbsoluteSkillPath = (side: TreeSide, tool: SkillTreeNode["tool"], relativePath: string): string => {
    const basePath = side === "workspace" ? args.state.workspacePath : args.state.centralRepoPath;
    return resolveSkillPath(basePath, tool, relativePath, side);
  };

  const resolveSkillAssetNode = (side: TreeSide, node: SkillTreeNode | null | undefined): SkillTreeNode | null => {
    if (!node) return null;
    const normalized = node.relativePath.replace(/\\/g, "/");
    const parts = normalized.split("/").filter(Boolean);
    const skillsIndex = parts.indexOf("skills");
    const skillName = skillsIndex >= 0 ? parts[skillsIndex + 1] : undefined;
    if (!skillName) return null;
    const relativePath = `skills/${skillName}`;
    const meta = (side === "workspace" ? args.state.workspaceAssetMeta : args.state.centralAssetMeta).get(`${node.tool}:${relativePath}`);
    if (!meta) return null;
    return {
      key: `${node.tool}:${relativePath}`,
      kind: "folder",
      tool: node.tool,
      relativePath,
      label: skillName,
      children: [],
      assetStatus: meta.status,
      assetWarnings: meta.warnings,
      assetFileCount: meta.fileCount,
      assetUpdatedAt: meta.updatedAt
    };
  };

  const buildFixPrompt = (
    side: TreeSide,
    target: SkillTreeNode,
    sideLabel: string,
    warnings: Array<{ node: SkillTreeNode; warning: SkillAssetWarning }>
  ): string => {
    const skillRoot = getAbsoluteSkillPath(side, target.tool, target.relativePath);
    const lines = [
      args.tr("# Fix Skill Bridge warnings"),
      "",
      args.tr("Please inspect and fix the Skill Bridge warnings for the skill below. Verify each warning first, make only the necessary changes, and preserve the skill's intended behavior."),
      "",
      args.tr("- Location: {0}", String(sideLabel)),
      args.tr("- Agent: {0}", String(target.tool)),
      args.tr("- Skill: {0}", String(target.label)),
      args.tr("- Skill root: {0}", String(skillRoot)),
      args.tr("- Current status: {0}", String(target.assetStatus ? skillAssetStatusLabel(target.assetStatus) : "Unknown")),
      "",
      args.tr("## Warnings to fix"),
      ""
    ];

    for (const [index, item] of warnings.entries()) {
      const relativePath = item.warning.relativePath ?? item.node.relativePath;
      lines.push(
        `${index + 1}. ${warningCodeLabel(item.warning.code)} (${item.warning.code})`,
        args.tr("   - File: {0}", String(getAbsoluteSkillPath(side, target.tool, relativePath))),
        args.tr("   - Message: {0}", String(item.warning.message)),
        ""
      );
    }

    lines.push(
      args.tr("## Requirements"),
      "",
      args.tr("- Keep all changes inside the skill folder shown above."),
      args.tr("- Preserve SKILL.md and all required references, scripts, and assets."),
      args.tr("- Repair broken links and local paths so the skill remains portable."),
      args.tr("- If sensitive content is real, remove or replace it without exposing the value. If it is only example text, keep the meaning while avoiding the false positive."),
      args.tr("- After editing, explain the root cause, changed files, and how you verified the warning is resolved.")
    );
    return lines.join("\n");
  };

  const showNodeWarningReasons = async (side: TreeSide, node?: SkillTreeNode): Promise<void> => {
    try {
      const provider = side === "workspace" ? args.workspaceProvider : args.centralProvider;
      const selection = side === "workspace" ? args.getWorkspaceSelection() : args.getCentralSelection();
      const selectedTarget = node ?? provider.getSelected() ?? selection[0];
      const target = resolveSkillAssetNode(side, selectedTarget);
      if (!target) {
        vscode.window.showWarningMessage(args.tr("Select an item inside a skill folder to inspect its status."));
        return;
      }

      const warnings = collectWarningReasons(target);
      const titlePath = target.relativePath || target.label;
      const sideLabel = side === "workspace" ? args.tr("Workspace") : args.tr("Central");
      const skillRoot = getAbsoluteSkillPath(side, target.tool, target.relativePath);
      const currentStatus = target.assetStatus ? skillAssetStatusLabel(target.assetStatus) : args.tr("Unknown");
      const lines = [
        args.tr("# Skill Bridge Skill Status"),
        "",
        args.tr("- Location: {0}", String(sideLabel)),
        args.tr("- Item: {0}/{1}", String(target.tool), String(titlePath)),
        args.tr("- Skill root: {0}", String(skillRoot)),
        args.tr("- Current status: {0}", String(currentStatus)),
        args.tr("- Status basis: {0}", String(target.assetStatus ? skillAssetStatusDescription(target.assetStatus) : "Status metadata is unavailable.")),
        args.tr("- File count: {0}", String(target.assetFileCount ?? 0)),
        args.tr("- Last updated: {0}", String(target.assetUpdatedAt ?? "-")),
        args.tr("- Warning count: {0}", String(warnings.length)),
        "",
        args.tr("## Warning List"),
        ""
      ];

      if (warnings.length === 0) {
        lines.push(args.tr("No warnings were recorded for this skill."));
      } else {
        for (const [index, item] of warnings.entries()) {
          const relativePath = item.warning.relativePath ?? item.node.relativePath;
          lines.push(
            `### ${index + 1}. ${warningSeverityLabel(item.warning.severity)} · ${warningCodeLabel(item.warning.code)}`,
            "",
            args.tr("- Message: {0}", String(item.warning.message)),
            args.tr("- Relative path: {0}", String(relativePath)),
            args.tr("- Absolute path: {0}", String(getAbsoluteSkillPath(side, target.tool, relativePath))),
            args.tr("- Code: {0}", String(item.warning.code)),
            ""
          );
        }
      }

      const statusReport = lines.join("\n");
      const doc = await vscode.workspace.openTextDocument({
        language: "markdown",
        content: statusReport
      });
      await vscode.window.showTextDocument(doc, { preview: true });

      const copyStatusLabel = args.tr("Copy Status");
      const copyFixPromptLabel = args.tr("Copy Fix Prompt");
      const action = warnings.length > 0
        ? await vscode.window.showInformationMessage(args.tr("Skill status opened."), copyStatusLabel, copyFixPromptLabel)
        : await vscode.window.showInformationMessage(args.tr("Skill status opened."), copyStatusLabel);
      if (action === copyStatusLabel) {
        await vscode.env.clipboard.writeText(statusReport);
        vscode.window.setStatusBarMessage(args.tr("Skill status copied."), 3000);
      } else if (action === copyFixPromptLabel) {
        await vscode.env.clipboard.writeText(buildFixPrompt(side, target, sideLabel, warnings));
        vscode.window.setStatusBarMessage(args.tr("Fix Prompt copied."), 3000);
      }
    } catch (error) {
      vscode.window.showErrorMessage(args.toUserError(error));
    }
  };

  const openTypeChangedTransferDiff = async (item: TransferPlanItem): Promise<void> => {
    const srcExists = await args.exists(item.src);
    const dstExists = await args.exists(item.dst);
    const srcStat = srcExists ? await fs.stat(item.src).catch(() => null) : null;
    const dstStat = dstExists ? await fs.stat(item.dst).catch(() => null) : null;
    const srcKind = srcStat ? (srcStat.isDirectory() ? "folder" : "file") : "none";
    const dstKind = dstStat ? (dstStat.isDirectory() ? "folder" : "file") : "none";

    const srcRows = srcKind === "folder" ? await args.collectFolderEntryRows(item.src) : [];
    const dstRows = dstKind === "folder" ? await args.collectFolderEntryRows(item.dst) : [];
    const panel = vscode.window.createWebviewPanel(
      "skillBridgeTypeChangedDiff",
      args.tr("Type Changed: {0}/{1}", String(item.tool), String(item.relativePath)),
      vscode.ViewColumn.Active,
      { enableScripts: false }
    );
    const render = (): void => {
      panel.title = args.tr("Type Changed: {0}/{1}", String(item.tool), String(item.relativePath));
      panel.webview.html = renderTypeChangedTransferDiffHtml(panel.webview, {
        tool: item.tool,
        relativePath: item.relativePath,
        sourceKind: srcKind,
        targetKind: dstKind,
        sourceRows: srcRows,
        targetRows: dstRows
      }, args.getUiLanguage(), { scriptsEnabled: false });
    };
    args.applyPanelBranding(panel, render);
    render();
  };

  const openFolderTransferDiff = async (item: TransferPlanItem): Promise<void> => {
    const [sourceRows, targetRows] = await Promise.all([
      args.collectFolderEntryRows(item.src),
      args.collectFolderEntryRows(item.dst)
    ]);
    const diffRows = buildFolderDiffRows(sourceRows, targetRows);
    const panel = vscode.window.createWebviewPanel(
      "skillBridgeFolderDiff",
      args.tr("Folder Diff: {0}/{1}", String(item.tool), String(item.relativePath)),
      vscode.ViewColumn.Active,
      { enableScripts: false }
    );
    const render = (): void => {
      panel.title = args.tr("Folder Diff: {0}/{1}", String(item.tool), String(item.relativePath));
      panel.webview.html = renderFolderTransferDiffHtml(panel.webview, {
        tool: item.tool,
        relativePath: item.relativePath,
        status: item.status,
        totalFiles: diffRows.length,
        totalSourceBytes: sourceRows.reduce((sum, entry) => sum + entry.size, 0),
        totalTargetBytes: targetRows.reduce((sum, entry) => sum + entry.size, 0),
        addedCount: diffRows.filter((entry) => entry.status === "A").length,
        removedCount: diffRows.filter((entry) => entry.status === "D").length,
        modifiedCount: diffRows.filter((entry) => entry.status === "M").length,
        sameCount: diffRows.filter((entry) => entry.status === "=").length,
        skillMdCount: diffRows.filter((entry) => /(^|\/)SKILL\.md$/i.test(entry.relativePath)).length,
        rows: diffRows
      }, args.getUiLanguage(), { scriptsEnabled: false });
    };
    args.applyPanelBranding(panel, render);
    render();
  };

  const openTransferDiff = async (item: TransferPlanItem): Promise<void> => {
    try {
      if (item.status === "same") {
        vscode.window.showInformationMessage(args.tr("Both files are identical, so there is no diff highlight."));
        return;
      }
      if (item.status === "typeChanged") {
        await openTypeChangedTransferDiff(item);
        return;
      }
      if (item.entryKind === "folder") {
        if (item.status === "added" || item.status === "removed") {
          await openFolderTransferDiff(item);
          return;
        }
        vscode.window.showInformationMessage(args.tr("For folder type changes, check the path information instead of a text diff."));
        return;
      }

      const emptyDoc = await vscode.workspace.openTextDocument({ language: "plaintext", content: "" });
      const srcDocPromise = vscode.workspace.openTextDocument(createFileUriFromAbsolutePath(item.src));
      const dstDocPromise = vscode.workspace.openTextDocument(createFileUriFromAbsolutePath(item.dst));
      let leftDoc: vscode.TextDocument;
      let rightDoc: vscode.TextDocument;
      if (item.status === "added") {
        leftDoc = emptyDoc;
        rightDoc = await srcDocPromise;
      } else if (item.status === "removed") {
        leftDoc = await dstDocPromise;
        rightDoc = emptyDoc;
      } else {
        leftDoc = await dstDocPromise;
        rightDoc = await srcDocPromise;
      }
      const title = `Diff: ${item.tool}/${item.relativePath}`;
      await vscode.commands.executeCommand("vscode.diff", leftDoc.uri, rightDoc.uri, title, {
        preview: true,
        preserveFocus: false
      });
    } catch {
      vscode.window.showInformationMessage(args.tr("This file cannot be opened as a text diff."));
    }
  };

  return {
    showNodeWarningReasons,
    openTransferDiff
  };
}
