import path from "node:path";
import { promises as fs } from "node:fs";
import * as vscode from "vscode";
import { renderGroupInfoHtml as renderGroupInfoHtmlMarkup } from "./groupMetadata";
import { isManagedSkillPath, normalizeRel } from "./extensionSupport";
import { resolveSkillPath, getWritableSkillRoot } from "./skillPaths";
import { legacySkillHistoryStorePath, skillHistoryStorePath } from "./storagePaths";
import type { SelectionGroup, SkillFile, SkillSelection, SkillTreeNode, ToolType, TransferPlanItem } from "./types";
import type { UiLanguage } from "./uiLanguage";

type TranslationFn = (message: string, ...args: Array<string | number | boolean>) => string;
type TreeSide = "workspace" | "central";
type SkillHistoryLog = {
  at: string;
  action: "copyToCentral";
  sourceProjectPath: string;
  sourceAbsolutePath: string;
};
type SkillHistoryRecord = {
  tool: ToolType;
  relativePath: string;
  lastUpdatedAt: string;
  lastSourceProjectPath: string;
  lastSourceAbsolutePath: string;
  history: SkillHistoryLog[];
};
export type CentralSkillHistoryFile = {
  version: 1;
  updatedAt: string;
  records: Record<string, SkillHistoryRecord>;
};

export function createHistoryTools(args: {
  tr: TranslationFn;
  toUserError: (error: unknown) => string;
  handleError: (error: unknown) => Promise<void>;
  getUiLanguage: () => UiLanguage;
  refresh: () => Promise<void>;
  state: {
    workspacePath: string;
    centralRepoPath: string;
    workspaceSkills: SkillFile[];
    centralSkills: SkillFile[];
    workspaceSelection: SkillTreeNode[];
    centralSelection: SkillTreeNode[];
  };
  workspaceProviderGetSelected: () => SkillTreeNode | null | undefined;
  centralProviderGetSelected: () => SkillTreeNode | null | undefined;
  buildSkillMdTemplate: (name: string) => string;
  applyPanelBranding: (panel: vscode.WebviewPanel, render: () => void | Promise<void>) => void;
  targetsToSelections: (files: SkillFile[], targets: SelectionGroup["targets"]) => SkillSelection[];
  exists: (targetPath: string) => Promise<boolean>;
}): {
  showSkillHistory: (node?: SkillTreeNode) => Promise<void>;
  loadCentralSkillHistory: () => Promise<CentralSkillHistoryFile>;
  saveCentralSkillHistory: (db: CentralSkillHistoryFile) => Promise<void>;
  updateCentralSkillHistory: (copiedItems: TransferPlanItem[], sourceProjectPath: string) => Promise<void>;
  createSkillFolder: (side: TreeSide, node?: SkillTreeNode) => Promise<void>;
  pickTool: () => Promise<ToolType | undefined>;
  showGroupInfo: (group: SelectionGroup) => Promise<void>;
  suggestDuplicateName: (name: string) => string;
} {
  const loadCentralSkillHistory = async (): Promise<CentralSkillHistoryFile> => {
    const target = await resolveExistingSkillHistoryStorePath(args.state.centralRepoPath, args.exists);
    if (!(await args.exists(target))) {
      return { version: 1, updatedAt: new Date().toISOString(), records: {} };
    }
    try {
      const raw = await fs.readFile(target, "utf8");
      const parsed = JSON.parse(raw) as Partial<CentralSkillHistoryFile>;
      if (!parsed || typeof parsed !== "object") {
        return { version: 1, updatedAt: new Date().toISOString(), records: {} };
      }
      return {
        version: 1,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
        records: parsed.records && typeof parsed.records === "object" ? parsed.records : {}
      };
    } catch {
      return { version: 1, updatedAt: new Date().toISOString(), records: {} };
    }
  };

  const saveCentralSkillHistory = async (db: CentralSkillHistoryFile): Promise<void> => {
    const target = skillHistoryStorePath(args.state.centralRepoPath);
    db.updatedAt = new Date().toISOString();
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify(db, null, 2), "utf8");
  };

  const updateCentralSkillHistory = async (copiedItems: TransferPlanItem[], sourceProjectPath: string): Promise<void> => {
    const db = await loadCentralSkillHistory();
    for (const item of copiedItems) {
      if (item.entryKind !== "file") continue;
      const key = `${item.tool}:${item.relativePath}`;
      const previous = db.records[key];
      const nextLog: SkillHistoryLog = {
        at: new Date().toISOString(),
        action: "copyToCentral",
        sourceProjectPath,
        sourceAbsolutePath: item.src
      };
      db.records[key] = {
        tool: item.tool,
        relativePath: item.relativePath,
        lastUpdatedAt: nextLog.at,
        lastSourceProjectPath: sourceProjectPath,
        lastSourceAbsolutePath: item.src,
        history: [nextLog, ...(previous?.history ?? [])].slice(0, 50)
      };
    }
    await saveCentralSkillHistory(db);
  };

  const showSkillHistory = async (node?: SkillTreeNode): Promise<void> => {
    try {
      if (!args.state.centralRepoPath || !args.state.workspacePath) await args.refresh();
      const target = node
        ?? args.centralProviderGetSelected()
        ?? args.workspaceProviderGetSelected()
        ?? args.state.centralSelection[0]
        ?? args.state.workspaceSelection[0];
      if (!target) {
        vscode.window.showWarningMessage(args.tr("Select a skill item to view history."));
        return;
      }
      if (!target.relativePath || !isManagedSkillPath(target.relativePath)) {
        vscode.window.showWarningMessage(args.tr("History is only available for items under the skills folder."));
        return;
      }

      const db = await loadCentralSkillHistory();
      const prefix = `${target.tool}:${normalizeRel(target.relativePath)}`;
      const matched = Object.entries(db.records)
        .filter(([key]) => key === prefix || key.startsWith(`${prefix}/`))
        .map(([, record]) => record)
        .sort((left, right) => right.lastUpdatedAt.localeCompare(left.lastUpdatedAt));
      if (matched.length === 0) {
        vscode.window.showInformationMessage(args.tr("No history is recorded."));
        return;
      }

      const picked = await vscode.window.showQuickPick(
        matched.map((record) => ({
          label: `${record.tool}/${record.relativePath}`,
          description: args.tr("Last source: {0}", String(record.lastSourceProjectPath)),
          detail: args.tr("{0} · {1} log(s)", String(record.lastUpdatedAt), String(record.history.length)),
          value: record
        })),
        {
          title: args.tr("Skill History ({0} skill(s))", String(matched.length)),
          matchOnDescription: true,
          matchOnDetail: true
        }
      );
      if (!picked) return;

      const lines = [
        args.tr("Path: {0}/{1}", String(picked.value.tool), String(picked.value.relativePath)),
        args.tr("Last updated: {0}", String(picked.value.lastUpdatedAt)),
        args.tr("Last source project: {0}", String(picked.value.lastSourceProjectPath)),
        args.tr("Last source absolute path: {0}", String(picked.value.lastSourceAbsolutePath)),
        "",
        args.tr("Recent logs:")
      ];
      for (const log of picked.value.history.slice(0, 15)) {
        lines.push(`- ${log.at} · ${log.sourceProjectPath}`);
      }
      const doc = await vscode.workspace.openTextDocument({
        language: "markdown",
        content: `# Skill History\n\n${lines.join("\n")}`
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (error) {
      await args.handleError(error);
    }
  };

  const pickTool = async (): Promise<ToolType | undefined> => {
    const pick = await vscode.window.showQuickPick(
      [
        { label: ".claude", value: "claude" as ToolType },
        { label: ".codex", value: "codex" as ToolType },
        { label: ".gemini", value: "gemini" as ToolType },
        { label: ".cursor", value: "cursor" as ToolType },
        { label: ".antigravity", value: "antigravity" as ToolType },
        { label: ".agents", value: "agents" as ToolType }
      ],
      { title: args.tr("Select Create Target") }
    );
    return pick?.value;
  };

  const createSkillFolder = async (side: TreeSide, node?: SkillTreeNode): Promise<void> => {
    try {
      if (!args.state.workspacePath || !args.state.centralRepoPath) await args.refresh();
      const basePath = side === "workspace" ? args.state.workspacePath : args.state.centralRepoPath;
      const baseNode = node ?? (side === "workspace" ? args.workspaceProviderGetSelected() : args.centralProviderGetSelected());
      const tool = baseNode?.tool ?? await pickTool();
      if (!tool) return;
      const toolRoot = getWritableSkillRoot(basePath, tool, side);
      const name = await vscode.window.showInputBox({
        title: args.tr("New Skill Folder"),
        prompt: args.tr("Enter a folder name"),
        value: ""
      });
      if (!name?.trim()) return;
      const folderRel = normalizeRel(path.join("skills", name.trim()));
      if (!isManagedSkillPath(folderRel) || folderRel.includes("..")) {
        vscode.window.showWarningMessage(args.tr("Items can only be created under the skills folder."));
        return;
      }
      const folderPath = path.join(toolRoot, folderRel);
      if (await args.exists(folderPath)) {
        vscode.window.showWarningMessage(args.tr("An item with the same name already exists."));
        return;
      }
      await fs.mkdir(toolRoot, { recursive: true });
      await fs.mkdir(folderPath, { recursive: true });
      await fs.writeFile(path.join(folderPath, "SKILL.md"), args.buildSkillMdTemplate(name.trim()), "utf8");
      await args.refresh();
      vscode.window.showInformationMessage(args.tr("Skill created with SKILL.md."));
    } catch (error) {
      await args.handleError(error);
    }
  };

  const showGroupInfo = async (group: SelectionGroup): Promise<void> => {
    if (group.targets.length === 0) {
      vscode.window.showWarningMessage(args.tr("The group has no items."));
      return;
    }
    const db = await loadCentralSkillHistory();
    const sourceFiles = group.side === "workspace" ? args.state.workspaceSkills : args.state.centralSkills;
    const fileSelections = args.targetsToSelections(sourceFiles, group.targets);
    if (fileSelections.length === 0) {
      vscode.window.showWarningMessage(args.tr("Could not find files to show inside the group."));
      return;
    }

    const basePath = group.side === "workspace" ? args.state.workspacePath : args.state.centralRepoPath;
    const mode = group.side === "workspace" ? "workspace" : "central";
    const rows: Array<{ targetPath: string; kind: string; fileMtime: string; fileSize: string; latestAt: string; latestProject: string; latestSource: string }> = [];
    const files = [...fileSelections].sort((left, right) => {
      const leftSkill = /\/SKILL\.md$/i.test(left.relativePath) ? 0 : 1;
      const rightSkill = /\/SKILL\.md$/i.test(right.relativePath) ? 0 : 1;
      if (leftSkill !== rightSkill) return leftSkill - rightSkill;
      return `${left.tool}/${left.relativePath}`.localeCompare(`${right.tool}/${right.relativePath}`);
    });
    for (const file of files) {
      const key = `${file.tool}:${normalizeRel(file.relativePath)}`;
      const history = db.records[key];
      const absolutePath = resolveSkillPath(basePath, file.tool, file.relativePath, mode);
      const stat = await fs.stat(absolutePath).catch(() => null);
      rows.push({
        targetPath: `${file.tool}/${file.relativePath}`,
        kind: /\/SKILL\.md$/i.test(file.relativePath) ? "SKILL.md" : args.tr("File"),
        fileMtime: stat ? stat.mtime.toISOString() : "-",
        fileSize: stat ? `${stat.size} B` : "-",
        latestAt: history?.lastUpdatedAt ?? "-",
        latestProject: history?.lastSourceProjectPath ?? args.tr("No history"),
        latestSource: history?.lastSourceAbsolutePath ?? "-"
      });
    }

    const panel = vscode.window.createWebviewPanel(
      "skillBridgeGroupInfo",
      args.tr("Group Info: {0}", String(group.name)),
      vscode.ViewColumn.Active,
      { enableScripts: false }
    );
    const render = (): void => {
      panel.title = args.tr("Group Info: {0}", String(group.name));
      panel.webview.html = renderGroupInfoHtmlMarkup(panel.webview, {
        name: group.name,
        description: group.description ?? "",
        side: group.side,
        count: rows.length,
        source: group.meta?.source ?? "manual",
        repoKey: group.meta?.repoKey ?? "-",
        repoUrl: group.meta?.repoUrl ?? "-",
        lastInstalledAt: group.meta?.lastInstalledAt ?? "-",
        mirroredFrom: group.meta?.mirroredFrom ?? "-",
        rows
      }, args.getUiLanguage(), { scriptsEnabled: false });
    };
    render();
    args.applyPanelBranding(panel, render);
  };

  const suggestDuplicateName = (name: string): string => {
    const dot = name.lastIndexOf(".");
    return dot <= 0 ? `${name}-copy` : `${name.slice(0, dot)}-copy${name.slice(dot)}`;
  };

  return {
    showSkillHistory,
    loadCentralSkillHistory,
    saveCentralSkillHistory,
    updateCentralSkillHistory,
    createSkillFolder,
    pickTool,
    showGroupInfo,
    suggestDuplicateName
  };
}

async function resolveExistingSkillHistoryStorePath(
  centralRepoPath: string,
  exists: (targetPath: string) => Promise<boolean>
): Promise<string> {
  const current = skillHistoryStorePath(centralRepoPath);
  if (await exists(current)) return current;
  return legacySkillHistoryStorePath(centralRepoPath);
}
