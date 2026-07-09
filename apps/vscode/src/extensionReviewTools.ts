import { promises as fs } from "node:fs";
import * as vscode from "vscode";
import type { SkillAssetTreeMeta, SkillAssetWarning, SkillTreeNode, TransferPlanItem } from "./types";
import { buildFolderDiffRows, type FolderEntryRow } from "./skillPaths";
import { createFileUriFromAbsolutePath } from "./extensionSupport";
import { renderFolderTransferDiffHtml, renderTypeChangedTransferDiffHtml } from "./transferDiffViews";
import type { SkillTreeProvider } from "./views/skillTreeProvider";
import type { UiLanguage } from "./uiLanguage";

type TreeSide = "workspace" | "central";
type TranslationFn = (english: string, korean: string) => string;

export function createReviewTools(args: {
  tr: TranslationFn;
  toUserError: (error: unknown) => string;
  workspaceProvider: SkillTreeProvider;
  centralProvider: SkillTreeProvider;
  getWorkspaceSelection: () => SkillTreeNode[];
  getCentralSelection: () => SkillTreeNode[];
  registerLanguageRefresh: (panel: vscode.WebviewPanel, render: () => void | Promise<void>) => void;
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
    if (severity === "danger") return args.tr("Danger", "위험");
    if (severity === "warning") return args.tr("Warning", "주의");
    return args.tr("Info", "정보");
  };

  const warningCodeLabel = (code: SkillAssetWarning["code"]): string => {
    const labels: Record<SkillAssetWarning["code"], string> = {
      "missing-skill-md": args.tr("Missing SKILL.md", "SKILL.md 누락"),
      "duplicate-name": args.tr("Duplicate Name", "중복 이름"),
      "broken-reference": args.tr("Broken Relative Link", "깨진 상대 링크"),
      "sensitive-content": args.tr("Possible Sensitive Info", "민감정보 의심"),
      "workspace-specific-path": args.tr("Workspace-Specific Path", "작업공간 전용 경로"),
      "script-file": args.tr("Contains Script File", "스크립트 파일 포함"),
      "target-newer": args.tr("Other Side Is Newer", "반대편이 더 최신")
    };
    return labels[code];
  };

  const skillAssetStatusLabel = (status: SkillAssetTreeMeta["status"]): string => {
    if (status === "same") return args.tr("Same", "동일");
    if (status === "new") return args.tr("New Skill", "새 스킬");
    if (status === "changed") return args.tr("Changed", "변경");
    if (status === "missingSkillMd") return args.tr("Missing SKILL.md", "SKILL.md 없음");
    if (status === "risk") return args.tr("Warning", "주의");
    return args.tr("Recent", "최근");
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

  const showNodeWarningReasons = async (side: TreeSide, node?: SkillTreeNode): Promise<void> => {
    try {
      const provider = side === "workspace" ? args.workspaceProvider : args.centralProvider;
      const selection = side === "workspace" ? args.getWorkspaceSelection() : args.getCentralSelection();
      const target = node ?? provider.getSelected() ?? selection[0];
      if (!target) {
        vscode.window.showWarningMessage(args.tr("Select a skill item to inspect warning reasons.", "주의 이유를 확인할 스킬 항목을 선택하세요."));
        return;
      }

      const warnings = collectWarningReasons(target);
      if (warnings.length === 0) {
        vscode.window.showInformationMessage(args.tr("This item has no recorded warning reasons. If it still appears as a warning after refresh, check the child skill folder.", "이 항목에는 기록된 주의 사유가 없습니다. 새로고침 후에도 계속 주의로 보이면 하위 스킬 폴더에서 다시 확인하세요."));
        return;
      }

      const titlePath = target.relativePath || target.label;
      const sideLabel = side === "workspace" ? args.tr("Workspace", "작업공간") : args.tr("Central", "중앙");
      const lines = [
        args.tr("# Skill Bridge Warning Reasons", "# Skill Bridge 주의 이유"),
        "",
        args.tr(`- Location: ${sideLabel}`, `- 위치: ${sideLabel}`),
        args.tr(`- Item: ${target.tool}/${titlePath}`, `- 항목: ${target.tool}/${titlePath}`),
        args.tr(`- Current status: ${target.assetStatus ? skillAssetStatusLabel(target.assetStatus) : "Includes child item warnings"}`, `- 현재 상태: ${target.assetStatus ? skillAssetStatusLabel(target.assetStatus) : "하위 항목 경고 포함"}`),
        args.tr(`- Warning count: ${warnings.length}`, `- 경고 수: ${warnings.length}`),
        "",
        args.tr("## Warning List", "## 경고 목록"),
        ""
      ];

      for (const [index, item] of warnings.entries()) {
        lines.push(
          `### ${index + 1}. ${warningSeverityLabel(item.warning.severity)} · ${warningCodeLabel(item.warning.code)}`,
          "",
          args.tr(`- Message: ${item.warning.message}`, `- 메시지: ${item.warning.message}`),
          args.tr(`- Path: ${(item.warning.relativePath ?? item.node.relativePath) || item.node.label}`, `- 경로: ${(item.warning.relativePath ?? item.node.relativePath) || item.node.label}`),
          args.tr(`- Code: ${item.warning.code}`, `- 코드: ${item.warning.code}`),
          ""
        );
      }

      const doc = await vscode.workspace.openTextDocument({
        language: "markdown",
        content: lines.join("\n")
      });
      await vscode.window.showTextDocument(doc, { preview: true });
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
      args.tr(`Type Changed: ${item.tool}/${item.relativePath}`, `타입 충돌: ${item.tool}/${item.relativePath}`),
      vscode.ViewColumn.Active,
      { enableScripts: false }
    );
    const render = (): void => {
      panel.title = args.tr(`Type Changed: ${item.tool}/${item.relativePath}`, `타입 충돌: ${item.tool}/${item.relativePath}`);
      panel.webview.html = renderTypeChangedTransferDiffHtml(panel.webview, {
        tool: item.tool,
        relativePath: item.relativePath,
        sourceKind: srcKind,
        targetKind: dstKind,
        sourceRows: srcRows,
        targetRows: dstRows
      }, args.getUiLanguage(), { scriptsEnabled: false });
    };
    args.registerLanguageRefresh(panel, render);
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
      args.tr(`Folder Diff: ${item.tool}/${item.relativePath}`, `폴더 Diff: ${item.tool}/${item.relativePath}`),
      vscode.ViewColumn.Active,
      { enableScripts: false }
    );
    const render = (): void => {
      panel.title = args.tr(`Folder Diff: ${item.tool}/${item.relativePath}`, `폴더 Diff: ${item.tool}/${item.relativePath}`);
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
    args.registerLanguageRefresh(panel, render);
    render();
  };

  const openTransferDiff = async (item: TransferPlanItem): Promise<void> => {
    try {
      if (item.status === "same") {
        vscode.window.showInformationMessage(args.tr("Both files are identical, so there is no diff highlight.", "두 파일 내용이 동일해서 diff 하이라이트가 없습니다."));
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
        vscode.window.showInformationMessage(args.tr("For folder type changes, check the path information instead of a text diff.", "폴더 타입 변경은 텍스트 diff 대신 경로 정보를 확인해주세요."));
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
      vscode.window.showInformationMessage(args.tr("This file cannot be opened as a text diff.", "텍스트 diff를 열 수 없는 파일입니다."));
    }
  };

  return {
    showNodeWarningReasons,
    openTransferDiff
  };
}
