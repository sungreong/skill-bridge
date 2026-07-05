import path from "node:path";
import { promises as fs } from "node:fs";
import * as vscode from "vscode";
import { buildAgentReviewPrompt } from "./reviewPrompt";
import { buildFolderDiffSummaryRows, renderFolderDiffSummaryHtml } from "./transferDiffViews";
import { renderTransferManagerHtml } from "./transferManagerView";
import { collectScopeEntries, getSkillRoot, getWritableSkillRoot } from "./skillPaths";
import { isManagedSkillPath, mapWithConcurrency, normalizeRel } from "./extensionSupport";
import type { SelectionGroup, SkillSelection, ToolType, TransferPlan, TransferPlanItem, TransferPlanSummary, TransferStatus } from "./types";
import type { UiLanguage } from "./uiLanguage";

type TranslationFn = (english: string, korean: string) => string;
type TreeSide = "workspace" | "central";
export type TransferScopeHint = { tool: ToolType; relativePath: string; kind: "file" | "folder" };
export type TransferPlanOptions = Pick<TransferPlan, "groupContext" | "repoContext" | "scopeContext"> & { scopeHints?: TransferScopeHint[] };

type CreateTransferManagerArgs = {
  tr: TranslationFn;
  toUserError: (error: unknown) => string;
  handleError: (error: unknown) => Promise<void>;
  getUiLanguage: () => UiLanguage;
  registerLanguageRefresh: (panel: vscode.WebviewPanel, render: () => void | Promise<void>) => void;
  getWorkspacePath: () => string;
  getCentralRepoPath: () => string;
  getGroups: () => SelectionGroup[];
  uniqueSelections: (selections: SkillSelection[]) => SkillSelection[];
  exists: (targetPath: string) => Promise<boolean>;
  copyNode: (src: string, dst: string) => Promise<void>;
  openTransferDiff: (item: TransferPlanItem) => Promise<void>;
  isSameFileContent: (src: string, dst: string, srcSize: number, dstSize: number) => Promise<boolean>;
  updateCentralSkillHistory: (copiedItems: TransferPlanItem[], sourceProjectPath: string) => Promise<void>;
};

export function createTransferManager(args: CreateTransferManagerArgs): {
  buildTransferPlan: (side: TreeSide, selections: SkillSelection[], options?: TransferPlanOptions) => Promise<TransferPlan>;
  openTransferManagerTab: (
    plan: TransferPlan,
    rebuildPlan: () => Promise<TransferPlan>,
    expandPlan?: () => Promise<TransferPlan>
  ) => Promise<TransferPlan | null>;
  applyTransferPlan: (
    items: TransferPlanItem[],
    sourceProjectPath: string | null
  ) => Promise<{ copied: number; deleted: number; unchanged: number; failed: number }>;
  collapseTransferItems: (items: TransferPlanItem[]) => TransferPlanItem[];
} {
  const summarizeStatuses = (statuses: TransferStatus[]): TransferStatus => {
    if (statuses.some((status) => status === "typeChanged")) return "typeChanged";
    if (statuses.some((status) => status === "modified")) return "modified";
    const hasAdded = statuses.some((status) => status === "added");
    const hasRemoved = statuses.some((status) => status === "removed");
    if (hasAdded && hasRemoved) return "modified";
    if (hasAdded) return "added";
    if (hasRemoved) return "removed";
    return "same";
  };

  const reasonByStatus = (status: TransferStatus): string => {
    if (status === "added") return "Child file added";
    if (status === "removed") return "Child file deleted";
    if (status === "modified") return "Child file changed";
    if (status === "typeChanged") return "Child type mismatch";
    return "Child items are the same";
  };

  const collapseTransferItems = (items: TransferPlanItem[]): TransferPlanItem[] => {
    const sorted = [...items].sort((left, right) => {
      const leftFolder = left.entryKind === "folder" ? 0 : 1;
      const rightFolder = right.entryKind === "folder" ? 0 : 1;
      if (leftFolder !== rightFolder) return leftFolder - rightFolder;
      if (left.relativePath.length !== right.relativePath.length) return left.relativePath.length - right.relativePath.length;
      return left.relativePath.localeCompare(right.relativePath);
    });
    const kept: TransferPlanItem[] = [];
    for (const item of sorted) {
      const covered = kept.some((parent) => (
        parent.tool === item.tool
        && parent.entryKind === "folder"
        && item.relativePath.startsWith(`${parent.relativePath}/`)
      ));
      if (!covered) kept.push(item);
    }
    return kept;
  };

  const buildTransferPlan = async (
    side: TreeSide,
    selections: SkillSelection[],
    options?: TransferPlanOptions
  ): Promise<TransferPlan> => {
    const sourceGroup = options?.groupContext
      ? args.getGroups().find((group) => group.id === options.groupContext?.id && group.side === options.groupContext?.side)
      : undefined;
    const groupType: TransferPlanItem["groupType"] = sourceGroup
      ? sourceGroup.meta?.mirroredFrom
        ? "mirror"
        : sourceGroup.meta?.source === "manual"
          ? "manual"
          : "selected"
      : "none";
    const groupName = sourceGroup?.name ?? options?.groupContext?.name ?? null;
    const sourceBasePath = side === "workspace" ? args.getWorkspacePath() : args.getCentralRepoPath();
    const targetBasePath = side === "workspace" ? args.getCentralRepoPath() : args.getWorkspacePath();
    const sourceMode = side === "workspace" ? "workspace" as const : "central" as const;
    const targetMode = side === "workspace" ? "central" as const : "workspace" as const;
    const inferredScopeHints: TransferScopeHint[] = options?.scopeHints && options.scopeHints.length > 0
      ? options.scopeHints
      : sourceGroup
        ? sourceGroup.targets.map((target) => ({ ...target }))
        : args.uniqueSelections(selections).map((selected) => ({
            tool: selected.tool,
            relativePath: selected.relativePath,
            kind: "file" as const
          }));

    const scopeByTool = new Map<ToolType, Map<string, "file" | "folder">>();
    for (const selected of inferredScopeHints) {
      const scope = normalizeRel(selected.relativePath);
      if (!scope || !isManagedSkillPath(scope)) continue;
      const existing = scopeByTool.get(selected.tool) ?? new Map<string, "file" | "folder">();
      const previousKind = existing.get(scope);
      existing.set(scope, previousKind === "folder" || selected.kind === "folder" ? "folder" : "file");
      scopeByTool.set(selected.tool, existing);
    }

    const itemsMap = new Map<string, TransferPlanItem>();
    for (const [tool, scopes] of scopeByTool.entries()) {
      const sourceToolRoot = getSkillRoot(sourceBasePath, tool, sourceMode);
      const targetToolRoot = getWritableSkillRoot(targetBasePath, tool, targetMode);
      for (const [scope, scopeKind] of scopes.entries()) {
        const [sourceEntries, targetEntries] = await Promise.all([
          collectScopeEntries(sourceToolRoot, scope, scopeKind),
          collectScopeEntries(targetToolRoot, scope, scopeKind)
        ]);
        const allPaths = new Set<string>([...sourceEntries.keys(), ...targetEntries.keys()]);
        const scopeItems = await mapWithConcurrency([...allPaths], 12, async (relativePath) => {
          if (!isManagedSkillPath(relativePath)) return null;
          const sourceEntry = sourceEntries.get(relativePath);
          const targetEntry = targetEntries.get(relativePath);
          let status: TransferStatus = "same";
          let reason = "Same";
          let entryKind: "file" | "folder" = sourceEntry?.kind ?? targetEntry?.kind ?? "file";

          if (sourceEntry && !targetEntry) {
            status = "added";
            reason = "Missing in target";
            entryKind = sourceEntry.kind;
          } else if (!sourceEntry && targetEntry) {
            status = "removed";
            reason = "Missing in source";
            entryKind = targetEntry.kind;
          } else if (sourceEntry && targetEntry && sourceEntry.kind !== targetEntry.kind) {
            status = "typeChanged";
            reason = "Type mismatch";
            entryKind = sourceEntry.kind;
          } else if (sourceEntry && targetEntry && sourceEntry.kind === "folder") {
            status = "same";
            reason = "Folder is the same";
            entryKind = "folder";
          } else if (sourceEntry && targetEntry) {
            const same = await args.isSameFileContent(
              sourceEntry.absolutePath,
              targetEntry.absolutePath,
              sourceEntry.size ?? 0,
              targetEntry.size ?? 0
            );
            status = same ? "same" : "modified";
            reason = same ? "Contents are the same" : "Contents changed";
            entryKind = "file";
          }

          const srcPath = sourceEntry?.absolutePath ?? path.join(sourceToolRoot, relativePath);
          const dstPath = targetEntry?.absolutePath ?? path.join(targetToolRoot, relativePath);
          const key = `${tool}:${relativePath}`;
          return {
            key,
            tool,
            relativePath,
            entryKind,
            changeKind: status,
            src: srcPath,
            dst: dstPath,
            status,
            reason,
            srcMtime: sourceEntry?.mtime ?? null,
            dstMtime: targetEntry?.mtime ?? null,
            srcSize: sourceEntry?.size ?? null,
            dstSize: targetEntry?.size ?? null,
            selected: status === "added" || status === "modified" || status === "typeChanged",
            groupType,
            groupName
          };
        });
        for (const item of scopeItems) {
          if (!item) continue;
          itemsMap.set(item.key, item);
        }
      }
    }

    const allItems = [...itemsMap.values()];
    for (const folderItem of allItems.filter((item) => item.entryKind === "folder")) {
      const prefix = `${folderItem.relativePath}/`;
      const childStatuses = allItems
        .filter((item) => item.tool === folderItem.tool && item.relativePath.startsWith(prefix))
        .map((item) => item.status);
      if (childStatuses.length === 0) continue;
      const nextStatus = summarizeStatuses(childStatuses);
      folderItem.status = nextStatus;
      folderItem.changeKind = nextStatus;
      folderItem.reason = reasonByStatus(nextStatus);
      folderItem.selected = nextStatus === "added" || nextStatus === "modified" || nextStatus === "typeChanged";
      itemsMap.set(folderItem.key, folderItem);
    }

    const items = [...itemsMap.values()].sort((left, right) => (
      left.tool.localeCompare(right.tool) || left.relativePath.localeCompare(right.relativePath)
    ));
    const summary: TransferPlanSummary = {
      total: items.length,
      addedCount: items.filter((item) => item.status === "added").length,
      removedCount: items.filter((item) => item.status === "removed").length,
      modifiedCount: items.filter((item) => item.status === "modified").length,
      typeChangedCount: items.filter((item) => item.status === "typeChanged").length,
      sameCount: items.filter((item) => item.status === "same").length,
      unchangedCount: items.filter((item) => item.status === "same").length
    };
    return {
      mode: side === "workspace" ? "workspaceToCentral" : "centralToWorkspace",
      items,
      summary,
      scopeContext: options?.scopeContext,
      groupContext: options?.groupContext,
      repoContext: options?.repoContext
    };
  };

  const openTransferManagerTab = async (
    plan: TransferPlan,
    rebuildPlan: () => Promise<TransferPlan>,
    expandPlan?: () => Promise<TransferPlan>
  ): Promise<TransferPlan | null> => {
    let currentPlan = plan;
    const titleForPlan = (): string => currentPlan.mode === "workspaceToCentral"
      ? args.tr("Save to Central - Review Before Applying", "중앙 반영 - 적용 전 검토")
      : args.tr("Bring to Workspace - Review Before Applying", "작업공간으로 가져오기 - 적용 전 검토");
    const panel = vscode.window.createWebviewPanel(
      "skillBridgeTransferManager",
      titleForPlan(),
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    const render = (): void => {
      panel.title = titleForPlan();
      panel.webview.html = renderTransferManagerHtml(panel.webview, currentPlan, args.getUiLanguage());
    };
    render();
    args.registerLanguageRefresh(panel, render);

    return new Promise<TransferPlan | null>((resolve) => {
      let settled = false;
      const done = (value: TransferPlan | null): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      panel.onDidDispose(() => done(null));
      panel.webview.onDidReceiveMessage(async (messageValue: unknown) => {
        if (!messageValue || typeof messageValue !== "object") return;
        const message = messageValue as { type?: string; payload?: unknown };
        if (message.type === "cancel") {
          done(null);
          panel.dispose();
          return;
        }
        if (message.type === "openDiff") {
          const key = String((message.payload as { key?: string } | undefined)?.key ?? "");
          const item = currentPlan.items.find((entry) => entry.key === key);
          if (item) await args.openTransferDiff(item);
          return;
        }
        if (message.type === "openFolderDiffSummary") {
          const payload = (message.payload as { tool?: string; relativePath?: string; itemKeys?: string[] } | undefined) ?? {};
          const tool = String(payload.tool ?? "");
          const relativePath = String(payload.relativePath ?? "");
          const selectedKeys = new Set(Array.isArray(payload.itemKeys) ? payload.itemKeys : []);
          const targets = currentPlan.items.filter((entry) => selectedKeys.has(entry.key));
          if (targets.length === 0) return;
          const summaryPanel = vscode.window.createWebviewPanel(
            "skillBridgeFolderDiffSummary",
            args.tr(`Folder Diff Summary: ${tool}/${relativePath}`, `폴더 Diff 요약: ${tool}/${relativePath}`),
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: false }
          );
          const renderSummary = (): void => {
            summaryPanel.title = args.tr(`Folder Diff Summary: ${tool}/${relativePath}`, `폴더 Diff 요약: ${tool}/${relativePath}`);
            summaryPanel.webview.html = renderFolderDiffSummaryHtml(summaryPanel.webview, {
              mode: currentPlan.mode,
              tool,
              relativePath,
              rows: buildFolderDiffSummaryRows(targets, currentPlan.mode)
            }, args.getUiLanguage());
          };
          renderSummary();
          args.registerLanguageRefresh(summaryPanel, renderSummary);
          summaryPanel.webview.onDidReceiveMessage(async (innerValue: unknown) => {
            if (!innerValue || typeof innerValue !== "object") return;
            const inner = innerValue as { type?: string; payload?: unknown };
            if (inner.type !== "openDiff") return;
            const key = String((inner.payload as { key?: string } | undefined)?.key ?? "");
            const target = currentPlan.items.find((entry) => entry.key === key);
            if (target) await args.openTransferDiff(target);
          });
          return;
        }
        if (message.type === "refreshPlan") {
          const selectedKeys = new Set(
            Array.isArray((message.payload as { selectedKeys?: string[] } | undefined)?.selectedKeys)
              ? (message.payload as { selectedKeys?: string[] }).selectedKeys
              : []
          );
          try {
            const refreshed = await rebuildPlan();
            currentPlan = {
              ...refreshed,
              items: refreshed.items.map((item) => ({
                ...item,
                selected: selectedKeys.has(item.key) || (item.selected && selectedKeys.size === 0)
              }))
            };
            render();
          } catch (error) {
            await args.handleError(error);
          }
          return;
        }
        if (message.type === "expandScope") {
          if (!expandPlan) return;
          try {
            currentPlan = await expandPlan();
            render();
          } catch (error) {
            await args.handleError(error);
          }
          return;
        }
        if (message.type === "copyReviewPrompt") {
          const selectedKeys = new Set(
            Array.isArray((message.payload as { selectedKeys?: string[] } | undefined)?.selectedKeys)
              ? (message.payload as { selectedKeys?: string[] }).selectedKeys
              : []
          );
          if (selectedKeys.size === 0) {
            const errorMessage = args.tr("No items are selected.", "선택된 항목이 없습니다.");
            vscode.window.showWarningMessage(args.tr("There are no items to include in the AI review prompt. Select items first.", "AI 검토 프롬프트에 담을 대상이 없습니다. 먼저 항목을 선택하세요."));
            void panel.webview.postMessage({ type: "promptCopyFailed", payload: { message: errorMessage } });
            return;
          }
          const validSelectedKeys = new Set(currentPlan.items.filter((item) => selectedKeys.has(item.key)).map((item) => item.key));
          if (validSelectedKeys.size === 0) {
            const errorMessage = args.tr("Could not find selected items in the current plan.", "현재 계획에서 선택 항목을 찾지 못했습니다.");
            vscode.window.showWarningMessage(args.tr("Could not find selected items in the current apply plan. Refresh and select again.", "현재 반영 계획에서 선택 항목을 찾지 못했습니다. 새로고침 후 다시 선택하세요."));
            void panel.webview.postMessage({ type: "promptCopyFailed", payload: { message: errorMessage } });
            return;
          }
          try {
            const prompt = buildAgentReviewPrompt(currentPlan, validSelectedKeys, args.getUiLanguage());
            await vscode.env.clipboard.writeText(prompt);
            vscode.window.showInformationMessage(args.tr(`AI review prompt copied: ${validSelectedKeys.size} selected row(s)`, `AI 검토 프롬프트 복사 완료: 선택 행 ${validSelectedKeys.size}개`));
            void panel.webview.postMessage({ type: "promptCopied", payload: { selectedCount: validSelectedKeys.size } });
          } catch (error) {
            const messageText = args.tr(`Prompt copy failed: ${args.toUserError(error)}`, `프롬프트 복사 실패: ${args.toUserError(error)}`);
            vscode.window.showWarningMessage(messageText);
            void panel.webview.postMessage({ type: "promptCopyFailed", payload: { message: messageText } });
          }
          return;
        }
        if (message.type === "apply") {
          const selectedKeys = new Set(
            Array.isArray((message.payload as { selectedKeys?: string[] } | undefined)?.selectedKeys)
              ? (message.payload as { selectedKeys?: string[] }).selectedKeys
              : []
          );
          done({
            ...currentPlan,
            items: currentPlan.items.map((item) => ({ ...item, selected: selectedKeys.has(item.key) }))
          });
          panel.dispose();
        }
      });
    });
  };

  const applyTransferPlan = async (
    items: TransferPlanItem[],
    sourceProjectPath: string | null
  ): Promise<{ copied: number; deleted: number; unchanged: number; failed: number }> => {
    const selected = collapseTransferItems(items.filter((item) => item.selected));
    let copied = 0;
    let deleted = 0;
    let unchanged = 0;
    let failed = 0;
    const copiedItems: TransferPlanItem[] = [];
    const firstPass = selected.filter((item) => item.status === "removed" || item.status === "typeChanged");
    const secondPass = selected.filter((item) => item.status !== "removed" && item.status !== "typeChanged");

    const applyItem = async (item: TransferPlanItem): Promise<void> => {
      try {
        if (item.status === "same") {
          unchanged += 1;
          return;
        }
        if (item.status === "removed") {
          if (await args.exists(item.dst)) {
            await fs.rm(item.dst, { recursive: true, force: true });
            deleted += 1;
          } else {
            unchanged += 1;
          }
          return;
        }
        if (item.status === "typeChanged" && await args.exists(item.dst)) {
          await fs.rm(item.dst, { recursive: true, force: true });
        }
        if (item.entryKind === "folder") {
          await args.copyNode(item.src, item.dst);
        } else {
          await fs.mkdir(path.dirname(item.dst), { recursive: true });
          await fs.copyFile(item.src, item.dst);
        }
        copied += 1;
        copiedItems.push(item);
      } catch {
        failed += 1;
      }
    };

    await mapWithConcurrency(firstPass, 6, applyItem);
    await mapWithConcurrency(secondPass, 6, applyItem);

    if (copiedItems.length > 0 && sourceProjectPath) {
      await args.updateCentralSkillHistory(copiedItems, sourceProjectPath);
    }
    return { copied, deleted, unchanged, failed };
  };

  return {
    buildTransferPlan,
    openTransferManagerTab,
    applyTransferPlan,
    collapseTransferItems
  };
}
