import { promises as fs } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import {
  collectFiles,
  getSkillRootCandidates,
  INSTRUCTION_ROOT,
  INSTRUCTION_RULE_DIRS,
  NESTED_INSTRUCTION_FILES,
  ROOT_INSTRUCTION_FILES
} from "./skillPaths";
import {
  GROUP_MARKDOWN_FILE,
  GROUP_STORE_FILE,
  LEGACY_GROUP_STORE_FILE,
  SKILL_BRIDGE_STATE_DIR
} from "./storagePaths";
import type { InstructionFile, ProjectPreset, SelectionGroup, SkillAssetTreeMeta, SkillFile, SkillTreeFilterMode, SkillTreeNode, ToolType } from "./types";
import { normalizeSourceTab, type SourceTab } from "./extensionSupport";

export type ExtensionRefreshResult = {
  workspaceFileCount: number;
  centralFileCount: number;
  workspaceGroupCount: number;
  centralGroupCount: number;
  centralRepoPath: string;
  groupNormalization: {
    changed: boolean;
    splitCount: number;
    removedTargetCount: number;
    removedGroupCount: number;
  };
};

type TreeSide = "workspace" | "central";

type SkillBridgeStateRepairResult = {
  workspace: SkillBridgeStateSideRepairResult;
  central: SkillBridgeStateSideRepairResult;
};

type SkillBridgeStateSideRepairResult = {
  createdStateDir: boolean;
  createdGroupFile: boolean;
  migratedGroupFile: boolean;
  regeneratedGroupMarkdown: boolean;
  migratedSkillsLock: boolean;
};

type TimedResult<T> = {
  value: T;
  ms: number;
};

const WATCHER_REFRESH_DEBOUNCE_MS = 750;
const WATCHED_FILE_STAT_CONCURRENCY = 24;

type RefreshContext = {
  workspacePath: string;
  centralRepoPath: string;
  agents: ToolType[];
};

type WatchedFileInput = {
  ctx: RefreshContext;
  workspaceSkills: SkillFile[];
  centralSkills: SkillFile[];
  workspaceInstructions: InstructionFile[];
  centralInstructions: InstructionFile[];
};

async function measureAsync<T>(operation: () => Promise<T>): Promise<TimedResult<T>> {
  const startedAt = Date.now();
  const value = await operation();
  return {
    value,
    ms: Date.now() - startedAt
  };
}

function hasStateRepairChanges(result: SkillBridgeStateRepairResult): boolean {
  return [result.workspace, result.central].some((side) =>
    side.createdStateDir
    || side.createdGroupFile
    || side.migratedGroupFile
    || side.migratedSkillsLock
  );
}

function normalizeFsKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function normalizeRel(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

function isWithinPath(basePath: string, targetPath: string): boolean {
  const relative = path.relative(path.resolve(basePath), path.resolve(targetPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function watchedFileSignature(stat: { size: number; mtimeMs: number; ctimeMs: number }): string {
  return `${stat.size}:${Math.trunc(stat.mtimeMs)}:${Math.trunc(stat.ctimeMs)}`;
}

function isManagedInstructionPath(relativePath: string): boolean {
  const normalized = normalizeRel(relativePath).toLowerCase();
  if (!normalized || normalized.includes("..") || path.isAbsolute(normalized)) return false;
  if (ROOT_INSTRUCTION_FILES.some((item) => item.toLowerCase() === normalized)) return true;
  if (NESTED_INSTRUCTION_FILES.some((item) => item.toLowerCase() === normalized)) return true;
  for (const ruleDir of INSTRUCTION_RULE_DIRS) {
    const prefix = `${ruleDir.dir.toLowerCase()}/`;
    if (!normalized.startsWith(prefix)) continue;
    const rest = normalized.slice(prefix.length);
    if (!rest || rest.includes("/")) return false;
    return ruleDir.extensions.has(path.extname(rest).toLowerCase());
  }
  return false;
}

function isRelevantRefreshFile(absolutePath: string, ctx: RefreshContext): boolean {
  const resolved = path.resolve(absolutePath);
  for (const side of ["workspace", "central"] as const) {
    const basePath = side === "workspace" ? ctx.workspacePath : ctx.centralRepoPath;
    for (const tool of ctx.agents) {
      for (const root of getSkillRootCandidates(basePath, tool, side)) {
        const skillsRoot = path.join(root, "skills");
        if (isWithinPath(skillsRoot, resolved)) return true;
      }
    }
  }

  const workspaceRel = normalizeRel(path.relative(ctx.workspacePath, resolved));
  if (isManagedInstructionPath(workspaceRel)) return true;

  const centralInstructionsRoot = path.join(ctx.centralRepoPath, INSTRUCTION_ROOT);
  if (isWithinPath(centralInstructionsRoot, resolved)) {
    const centralRel = normalizeRel(path.relative(centralInstructionsRoot, resolved));
    const [, ...instructionParts] = centralRel.split("/");
    if (instructionParts.length > 0 && isManagedInstructionPath(instructionParts.join("/"))) return true;
  }

  return relevantGroupFilePaths(ctx).some((item) => normalizeFsKey(item) === normalizeFsKey(resolved));
}

function relevantGroupFilePaths(ctx: RefreshContext): string[] {
  return [ctx.workspacePath, ctx.centralRepoPath].flatMap((basePath) => [
    path.join(basePath, SKILL_BRIDGE_STATE_DIR, GROUP_STORE_FILE),
    path.join(basePath, SKILL_BRIDGE_STATE_DIR, GROUP_MARKDOWN_FILE),
    path.join(basePath, LEGACY_GROUP_STORE_FILE),
    path.join(basePath, GROUP_MARKDOWN_FILE)
  ]);
}

async function statWatchedFile(absolutePath: string): Promise<[string, string] | null> {
  const stat = await fs.stat(absolutePath).catch(() => null);
  if (!stat?.isFile()) return null;
  return [normalizeFsKey(absolutePath), watchedFileSignature(stat)];
}

async function buildWatchedFileStats(input: WatchedFileInput): Promise<Map<string, string>> {
  const files = [
    ...input.workspaceSkills.map((item) => item.absolutePath),
    ...input.centralSkills.map((item) => item.absolutePath),
    ...input.workspaceInstructions.map((item) => item.absolutePath),
    ...input.centralInstructions.map((item) => item.absolutePath),
    ...relevantGroupFilePaths(input.ctx)
  ];
  const stats = new Map<string, string>();
  await mapWithConcurrency(files, WATCHED_FILE_STAT_CONCURRENCY, async (filePath) => {
    const entry = await statWatchedFile(filePath);
    if (entry) stats.set(entry[0], entry[1]);
  });
  return stats;
}

function hasWatchedFileUnder(stats: Map<string, string>, directoryPath: string): boolean {
  const directoryKey = normalizeFsKey(directoryPath);
  const prefix = directoryKey.endsWith(path.sep) ? directoryKey : `${directoryKey}${path.sep}`;
  for (const key of stats.keys()) {
    if (key === directoryKey || key.startsWith(prefix)) return true;
  }
  return false;
}

async function collectCurrentStatsUnderDirectory(directoryPath: string, ctx: RefreshContext): Promise<Map<string, string>> {
  const stats = new Map<string, string>();
  const relativeFiles = await collectFiles(directoryPath, directoryPath).catch(() => []);
  await mapWithConcurrency(relativeFiles, WATCHED_FILE_STAT_CONCURRENCY, async (relativePath) => {
    const absolutePath = path.join(directoryPath, ...normalizeRel(relativePath).split("/"));
    if (!isRelevantRefreshFile(absolutePath, ctx)) return;
    const entry = await statWatchedFile(absolutePath);
    if (entry) stats.set(entry[0], entry[1]);
  });
  return stats;
}

function watchedDirectoryChanged(previous: Map<string, string>, current: Map<string, string>, directoryPath: string): boolean {
  const directoryKey = normalizeFsKey(directoryPath);
  const prefix = directoryKey.endsWith(path.sep) ? directoryKey : `${directoryKey}${path.sep}`;
  for (const [key, signature] of previous) {
    if (key !== directoryKey && !key.startsWith(prefix)) continue;
    if (current.get(key) !== signature) return true;
  }
  for (const key of current.keys()) {
    if (!previous.has(key)) return true;
  }
  return false;
}

async function hasWatchedPathChanged(stats: Map<string, string>, ctx: RefreshContext, absolutePath: string): Promise<boolean> {
  const key = normalizeFsKey(absolutePath);
  const stat = await fs.stat(absolutePath).catch(() => null);
  if (!stat) return stats.has(key) || hasWatchedFileUnder(stats, absolutePath);
  if (stat.isDirectory()) {
    if (!hasWatchedFileUnder(stats, absolutePath)) {
      const current = await collectCurrentStatsUnderDirectory(absolutePath, ctx);
      return current.size > 0;
    }
    const current = await collectCurrentStatsUnderDirectory(absolutePath, ctx);
    return watchedDirectoryChanged(stats, current, absolutePath);
  }
  if (!stat.isFile()) return false;
  if (!stats.has(key) && !isRelevantRefreshFile(absolutePath, ctx)) return false;
  return stats.get(key) !== watchedFileSignature(stat);
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  mapper: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  const cappedLimit = Math.max(1, Math.min(limit, items.length));
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await mapper(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: cappedLimit }, () => worker()));
}

export function createExtensionRefreshRuntime(args: {
  tr: (english: string, korean: string) => string;
  toUserError: (error: unknown) => string;
  output: vscode.OutputChannel;
  state: {
    workspacePath: string;
    centralRepoPath: string;
    activeTab: SourceTab;
    workspaceSkills: SkillFile[];
    centralSkills: SkillFile[];
    workspaceInstructions: InstructionFile[];
    centralInstructions: InstructionFile[];
    workspaceMissingSkillFolders: Array<{ tool: ToolType; relativePath: string }>;
    centralMissingSkillFolders: Array<{ tool: ToolType; relativePath: string }>;
    workspaceAssetMeta: Map<string, SkillAssetTreeMeta>;
    centralAssetMeta: Map<string, SkillAssetTreeMeta>;
    treeFilter: SkillTreeFilterMode;
    agents: ToolType[];
    groups: SelectionGroup[];
    centralProjectPresets: ProjectPreset[];
    workspaceSelection: SkillTreeNode[];
    centralSelection: SkillTreeNode[];
    selectedGroupId: string | null;
  };
  workspaceProvider: {
    setMissingSkillFolders: (items: Array<{ tool: ToolType; relativePath: string }>) => void;
    setAssetMeta: (meta: Map<string, SkillAssetTreeMeta>) => void;
    setInstructions: (items: InstructionFile[]) => void;
    setGroups: (groups: SelectionGroup[]) => void;
    setProjectPresets?: (presets: ProjectPreset[]) => void;
    setSelectedGroup: (groupId: string | null) => void;
    setHighlight: (keys: Set<string>) => void;
  };
  centralProvider: {
    setMissingSkillFolders: (items: Array<{ tool: ToolType; relativePath: string }>) => void;
    setAssetMeta: (meta: Map<string, SkillAssetTreeMeta>) => void;
    setInstructions: (items: InstructionFile[]) => void;
    setGroups: (groups: SelectionGroup[]) => void;
    setProjectPresets: (presets: ProjectPreset[]) => void;
    setSelectedGroup: (groupId: string | null) => void;
    setHighlight: (keys: Set<string>) => void;
  };
  applyGroupHighlight: (group: SelectionGroup) => void;
  applyTabFilter: () => void;
  updateStatusChrome: () => void;
  qualityStatusBar: vscode.StatusBarItem;
  skillDiagnostics: vscode.DiagnosticCollection;
  createWatchers: (workspacePath: string, centralRepoPath: string) => vscode.FileSystemWatcher[];
  resolveContext: () => { workspacePath: string; centralRepoPath: string; agents: ToolType[] };
  ensureSkillBridgeState: (workspacePath: string, centralRepoPath: string) => Promise<SkillBridgeStateRepairResult>;
  scanSkills: (basePath: string, side: TreeSide, agents: ToolType[]) => Promise<SkillFile[]>;
  scanWorkspaceInstructions: (workspacePath: string) => Promise<InstructionFile[]>;
  scanCentralInstructions: (centralRepoPath: string) => Promise<InstructionFile[]>;
  enforceSkillMdInventory: (files: SkillFile[]) => { validFiles: SkillFile[]; missingFolders: Array<{ tool: ToolType; relativePath: string }> };
  buildTreeAssetMeta: (args: {
    workspacePath: string;
    centralRepoPath: string;
    workspaceSkills: SkillFile[];
    centralSkills: SkillFile[];
    workspaceMissingSkillFolders: Array<{ tool: ToolType; relativePath: string }>;
    centralMissingSkillFolders: Array<{ tool: ToolType; relativePath: string }>;
  }) => Promise<{ workspace: Map<string, SkillAssetTreeMeta>; central: Map<string, SkillAssetTreeMeta> }>;
  updateSkillDiagnostics: () => { errors: number; warnings: number };
  loadSelectionGroups: (workspacePath: string, centralRepoPath: string) => Promise<{ groups: SelectionGroup[]; needsSave: boolean; migratedCentralGroupCount: number }>;
  loadProjectPresets: (centralRepoPath: string) => Promise<{ file: { presets: ProjectPreset[] }; migratedFromLegacy: boolean }>;
  saveProjectPresets: (centralRepoPath: string, file: { version: 1; updatedAt: string; presets: ProjectPreset[] }) => Promise<void>;
  normalizeGroupsForCurrentSkills: (args: {
    input: SelectionGroup[];
    workspaceSkills: SkillFile[];
    centralSkills: SkillFile[];
    dedupeGroupTargets: (targets: import("./types").GroupTarget[]) => import("./types").GroupTarget[];
    targetExistsInFiles: (target: import("./types").GroupTarget, files: SkillFile[]) => boolean;
    options?: { skipExistenceValidation?: boolean };
  }) => { groups: SelectionGroup[]; changed: boolean; splitCount: number; removedTargetCount: number; removedGroupCount: number };
  dedupeGroupTargets: (targets: import("./types").GroupTarget[]) => import("./types").GroupTarget[];
  targetExistsInFiles: (target: import("./types").GroupTarget, files: SkillFile[]) => boolean;
  saveSelectionGroups: (workspacePath: string, centralRepoPath: string, groups: SelectionGroup[]) => Promise<void>;
  filterGroupsByTab: (groups: SelectionGroup[], activeTab: SourceTab) => SelectionGroup[];
  countGroups: (groups: SelectionGroup[]) => { workspace: number; central: number };
  getWorkspaceChangedSkillFolder: (absolutePath: string) => { tool: ToolType; skillFolderRel: string } | null;
  getAutoSyncWorkspaceAgents: () => ToolType[];
  enqueueWorkspaceAutoSync: (tool: ToolType, skillFolderRel: string) => void;
  syncWorkspaceAgentFoldersToCentral: (pending: Array<{ tool: ToolType; skillFolderRel: string }>, reason: "auto" | "manual") => Promise<{ syncedFolders: number; copied: number; deleted: number; unchanged: number; mirroredGroups: number; centralFolders: number; centralFiles: number; skippedMissingSkillMd: number }>;
}): {
  createRefreshState: () => {
    refreshTimer: NodeJS.Timeout | null;
    refreshInFlight: Promise<ExtensionRefreshResult> | null;
    refreshAgainRequested: boolean;
    scheduledRefreshAfterInFlight: boolean;
    watchedFileStats: Map<string, string>;
    pendingWatcherPaths: Set<string>;
    refreshGeneration: number;
    watchers: vscode.FileSystemWatcher[];
    watcherKey: string | null;
    autoSyncTimer: NodeJS.Timeout | null;
    autoSyncInFlight: Promise<void> | null;
    autoSyncPending: Map<string, { tool: ToolType; skillFolderRel: string }>;
  };
  scheduleRefresh: (runtime: ReturnType<typeof createExtensionRefreshRuntime>["createRefreshState"] extends () => infer R ? R : never) => void;
  flushWorkspaceAutoSync: (runtime: ReturnType<typeof createExtensionRefreshRuntime>["createRefreshState"] extends () => infer R ? R : never) => Promise<void>;
  refresh: (runtime: ReturnType<typeof createExtensionRefreshRuntime>["createRefreshState"] extends () => infer R ? R : never) => Promise<ExtensionRefreshResult>;
  registerWatcherEvent: (runtime: ReturnType<typeof createExtensionRefreshRuntime>["createRefreshState"] extends () => infer R ? R : never, uri: vscode.Uri) => void;
} {
  type RuntimeState = {
    refreshTimer: NodeJS.Timeout | null;
    refreshInFlight: Promise<ExtensionRefreshResult> | null;
    refreshAgainRequested: boolean;
    scheduledRefreshAfterInFlight: boolean;
    watchedFileStats: Map<string, string>;
    pendingWatcherPaths: Set<string>;
    refreshGeneration: number;
    watchers: vscode.FileSystemWatcher[];
    watcherKey: string | null;
    autoSyncTimer: NodeJS.Timeout | null;
    autoSyncInFlight: Promise<void> | null;
    autoSyncPending: Map<string, { tool: ToolType; skillFolderRel: string }>;
  };

  const createRefreshState = (): RuntimeState => ({
    refreshTimer: null,
    refreshInFlight: null,
    refreshAgainRequested: false,
    scheduledRefreshAfterInFlight: false,
    watchedFileStats: new Map(),
    pendingWatcherPaths: new Set(),
    refreshGeneration: 0,
    watchers: [],
    watcherKey: null,
    autoSyncTimer: null,
    autoSyncInFlight: null,
    autoSyncPending: new Map()
  });

  const scheduleRefresh = (runtime: RuntimeState): void => {
    if (runtime.refreshTimer) clearTimeout(runtime.refreshTimer);
    runtime.refreshTimer = setTimeout(() => {
      runtime.refreshTimer = null;
      if (runtime.refreshInFlight) {
        if (runtime.scheduledRefreshAfterInFlight) return;
        runtime.scheduledRefreshAfterInFlight = true;
        void runtime.refreshInFlight.finally(() => {
          runtime.scheduledRefreshAfterInFlight = false;
          scheduleRefresh(runtime);
        });
        return;
      }
      void refresh(runtime);
    }, WATCHER_REFRESH_DEBOUNCE_MS);
  };

  const watcherRefreshNeeded = async (runtime: RuntimeState): Promise<boolean> => {
    const pendingPaths = [...runtime.pendingWatcherPaths];
    runtime.pendingWatcherPaths.clear();
    if (pendingPaths.length === 0) return false;
    if (runtime.watchedFileStats.size === 0) return true;
    const ctx = args.resolveContext();
    for (const pendingPath of pendingPaths) {
      if (await hasWatchedPathChanged(runtime.watchedFileStats, ctx, pendingPath)) return true;
    }
    return false;
  };

  const runScheduledWatcherRefresh = async (runtime: RuntimeState): Promise<void> => {
    runtime.refreshTimer = null;
    if (runtime.refreshInFlight) {
      if (runtime.scheduledRefreshAfterInFlight) return;
      runtime.scheduledRefreshAfterInFlight = true;
      void runtime.refreshInFlight.finally(() => {
        runtime.scheduledRefreshAfterInFlight = false;
        scheduleWatcherRefresh(runtime);
      });
      return;
    }
    if (!(await watcherRefreshNeeded(runtime))) return;
    await refresh(runtime);
  };

  const scheduleWatcherRefresh = (runtime: RuntimeState, uri?: vscode.Uri): void => {
    if (uri) runtime.pendingWatcherPaths.add(uri.fsPath);
    if (runtime.refreshTimer) clearTimeout(runtime.refreshTimer);
    runtime.refreshTimer = setTimeout(() => {
      void runScheduledWatcherRefresh(runtime).catch((error) => {
        args.output.appendLine(`[Refresh:watcher] ${args.toUserError(error)}`);
      });
    }, WATCHER_REFRESH_DEBOUNCE_MS);
  };

  const flushWorkspaceAutoSync = async (runtime: RuntimeState): Promise<void> => {
    if (runtime.autoSyncInFlight) return;
    const allowedAgents = new Set(args.getAutoSyncWorkspaceAgents());
    const pending = [...runtime.autoSyncPending.values()].filter((item) => allowedAgents.has(item.tool));
    runtime.autoSyncPending.clear();
    if (pending.length === 0) return;

    runtime.autoSyncInFlight = (async () => {
      try {
        const summary = await args.syncWorkspaceAgentFoldersToCentral(pending, "auto");
        if (summary.syncedFolders === 0) return;
        args.output.appendLine(args.tr(
          `[AutoSave] Workspace → Central folders=${summary.syncedFolders} copied=${summary.copied} deleted=${summary.deleted} unchanged=${summary.unchanged} mirroredGroups=${summary.mirroredGroups} centralFolders=${summary.centralFolders} centralFiles=${summary.centralFiles} skippedMissingSkillMd=${summary.skippedMissingSkillMd}`,
          `[AutoSave] 작업공간 → 중앙 폴더=${summary.syncedFolders} 복사=${summary.copied} 삭제=${summary.deleted} 변경없음=${summary.unchanged} 그룹반영=${summary.mirroredGroups} 중앙확인폴더=${summary.centralFolders} 중앙확인파일=${summary.centralFiles} SKILL.md없음제외=${summary.skippedMissingSkillMd}`
        ));
        vscode.window.setStatusBarMessage(
          args.tr(
            `Skill Bridge auto save to Central: ${summary.syncedFolders} folder(s) · copied ${summary.copied} · deleted ${summary.deleted} · groups ${summary.mirroredGroups} · central ${summary.centralFolders}/${summary.centralFiles} · skipped ${summary.skippedMissingSkillMd}`,
            `Skill Bridge 자동 중앙 반영: 폴더 ${summary.syncedFolders}개 · 복사 ${summary.copied} · 삭제 ${summary.deleted} · 그룹 ${summary.mirroredGroups}개 · 중앙 ${summary.centralFolders}/${summary.centralFiles} · 제외 ${summary.skippedMissingSkillMd}`
          ),
          3500
        );
      } catch (error) {
        args.output.appendLine(`[AutoSave] ${args.toUserError(error)}`);
      } finally {
        runtime.autoSyncInFlight = null;
        if (runtime.autoSyncPending.size > 0) {
          if (runtime.autoSyncTimer) clearTimeout(runtime.autoSyncTimer);
          runtime.autoSyncTimer = setTimeout(() => {
            runtime.autoSyncTimer = null;
            void flushWorkspaceAutoSync(runtime);
          }, 900);
        }
      }
    })();
    await runtime.autoSyncInFlight;
  };

  const runPostRefreshAnalysis = async (
    runtime: RuntimeState,
    refreshGeneration: number,
    input: {
      workspacePath: string;
      centralRepoPath: string;
      workspaceSkills: SkillFile[];
      centralSkills: SkillFile[];
      workspaceMissingSkillFolders: Array<{ tool: ToolType; relativePath: string }>;
      centralMissingSkillFolders: Array<{ tool: ToolType; relativePath: string }>;
    }
  ): Promise<void> => {
    const startedAt = Date.now();
    const assetMeta = await args.buildTreeAssetMeta(input);
    if (runtime.refreshGeneration !== refreshGeneration) return;

    args.state.workspaceAssetMeta = assetMeta.workspace;
    args.state.centralAssetMeta = assetMeta.central;

    const providerStartedAt = Date.now();
    args.workspaceProvider.setAssetMeta(args.state.workspaceAssetMeta);
    args.centralProvider.setAssetMeta(args.state.centralAssetMeta);
    const diagnosticCounts = args.updateSkillDiagnostics();
    if (diagnosticCounts.errors + diagnosticCounts.warnings > 0) {
      args.qualityStatusBar.text = `$(shield) ${diagnosticCounts.errors}E/${diagnosticCounts.warnings}W`;
      args.qualityStatusBar.show();
    } else {
      args.qualityStatusBar.hide();
    }
    const providerMs = Date.now() - providerStartedAt;
    args.output.appendLine(
      `[Refresh:enrich] metadata=${Date.now() - startedAt}ms providers+diagnostics=${providerMs}ms workspaceMeta=${assetMeta.workspace.size} centralMeta=${assetMeta.central.size}`
    );
  };

  const runRefresh = async (runtime: RuntimeState): Promise<ExtensionRefreshResult> => {
    const startedAt = Date.now();
    const refreshGeneration = runtime.refreshGeneration + 1;
    runtime.refreshGeneration = refreshGeneration;
    const ctx = args.resolveContext();
    args.state.workspacePath = ctx.workspacePath;
    args.state.centralRepoPath = ctx.centralRepoPath;
    args.state.agents = ctx.agents;
    args.state.activeTab = args.state.activeTab === "all" ? "all" : normalizeSourceTab(args.state.activeTab, args.state.agents);
    const stateRepair = await args.ensureSkillBridgeState(ctx.workspacePath, ctx.centralRepoPath);
    if (hasStateRepairChanges(stateRepair)) {
      args.output.appendLine(`[StateStore] ensured .skillbridge ${JSON.stringify(stateRepair)}`);
    }

    const scanStartedAt = Date.now();
    const [workspaceSkillScan, centralSkillScan, workspaceInstructionScan, centralInstructionScan] = await Promise.all([
      measureAsync(() => args.scanSkills(ctx.workspacePath, "workspace", ctx.agents)),
      measureAsync(() => args.scanSkills(ctx.centralRepoPath, "central", ctx.agents)),
      measureAsync(() => args.scanWorkspaceInstructions(ctx.workspacePath)),
      measureAsync(() => args.scanCentralInstructions(ctx.centralRepoPath))
    ]);
    const workspaceSkills = workspaceSkillScan.value;
    const centralSkills = centralSkillScan.value;
    const workspaceInstructions = workspaceInstructionScan.value;
    const centralInstructions = centralInstructionScan.value;
    const scanMs = Date.now() - scanStartedAt;

    const inventoryStartedAt = Date.now();
    const workspaceInventory = args.enforceSkillMdInventory(workspaceSkills);
    const centralInventory = args.enforceSkillMdInventory(centralSkills);
    args.state.workspaceSkills = workspaceInventory.validFiles;
    args.state.centralSkills = centralInventory.validFiles;
    args.state.workspaceInstructions = workspaceInstructions;
    args.state.centralInstructions = centralInstructions;
    args.state.workspaceMissingSkillFolders = workspaceInventory.missingFolders;
    args.state.centralMissingSkillFolders = centralInventory.missingFolders;
    args.skillDiagnostics.clear();
    args.qualityStatusBar.hide();
    const enrichmentInput = {
      workspacePath: ctx.workspacePath,
      centralRepoPath: ctx.centralRepoPath,
      workspaceSkills: args.state.workspaceSkills,
      centralSkills: args.state.centralSkills,
      workspaceMissingSkillFolders: args.state.workspaceMissingSkillFolders,
      centralMissingSkillFolders: args.state.centralMissingSkillFolders
    };
    const inventoryMs = Date.now() - inventoryStartedAt;

    const providerMs = 0;

    const groupsStartedAt = Date.now();
    const loadedGroupResult = await args.loadSelectionGroups(ctx.workspacePath, ctx.centralRepoPath);
    try {
      const presetResult = await args.loadProjectPresets(ctx.centralRepoPath);
      args.state.centralProjectPresets = presetResult.file.presets;
      args.centralProvider.setProjectPresets(args.state.centralProjectPresets);
      args.workspaceProvider.setProjectPresets?.([]);
      if (presetResult.migratedFromLegacy) {
        await args.saveProjectPresets(ctx.centralRepoPath, {
          version: 1,
          updatedAt: new Date().toISOString(),
          presets: args.state.centralProjectPresets
        });
      }
    } catch (error) {
      args.state.centralProjectPresets = [];
      args.centralProvider.setProjectPresets([]);
      args.output.appendLine(`[ProjectPresets] ${args.toUserError(error)}`);
    }
    const normalizedGroupResult = args.normalizeGroupsForCurrentSkills({
      input: loadedGroupResult.groups,
      workspaceSkills: args.state.workspaceSkills,
      centralSkills: args.state.centralSkills,
      dedupeGroupTargets: args.dedupeGroupTargets,
      targetExistsInFiles: args.targetExistsInFiles,
      options: { skipExistenceValidation: true }
    });
    args.state.groups = normalizedGroupResult.groups;
    if (normalizedGroupResult.changed || loadedGroupResult.needsSave) {
      await args.saveSelectionGroups(ctx.workspacePath, ctx.centralRepoPath, args.state.groups);
    }
    if (args.state.selectedGroupId && !args.state.groups.some((item) => item.id === args.state.selectedGroupId)) {
      args.state.selectedGroupId = null;
    }
    args.workspaceProvider.setGroups(args.state.groups);
    args.centralProvider.setGroups(args.state.groups);
    args.workspaceProvider.setSelectedGroup(args.state.selectedGroupId);
    args.centralProvider.setSelectedGroup(args.state.selectedGroupId);
    if (args.state.selectedGroupId) {
      const selected = args.state.groups.find((item) => item.id === args.state.selectedGroupId);
      if (selected) {
        args.applyGroupHighlight(selected);
      }
    } else {
      args.workspaceProvider.setHighlight(new Set());
      args.centralProvider.setHighlight(new Set());
    }
    args.applyTabFilter();
    args.updateStatusChrome();
    const groupsMs = Date.now() - groupsStartedAt;

    const watchersStartedAt = Date.now();
    const watcherKey = `${ctx.workspacePath}\n${ctx.centralRepoPath}`;
    if (runtime.watcherKey !== watcherKey) {
      for (const watcher of runtime.watchers) watcher.dispose();
      runtime.watchers = args.createWatchers(ctx.workspacePath, ctx.centralRepoPath);
      runtime.watcherKey = watcherKey;
      const onWatcherEvent = (uri: vscode.Uri): void => {
        scheduleWatcherRefresh(runtime, uri);
        const changed = args.getWorkspaceChangedSkillFolder(uri.fsPath);
        if (!changed) return;
        if (!args.getAutoSyncWorkspaceAgents().includes(changed.tool)) return;
        args.enqueueWorkspaceAutoSync(changed.tool, changed.skillFolderRel);
      };
      for (const watcher of runtime.watchers) {
        watcher.onDidCreate(onWatcherEvent);
        watcher.onDidChange(onWatcherEvent);
        watcher.onDidDelete(onWatcherEvent);
      }
    }
    const watchersMs = Date.now() - watchersStartedAt;
    const fingerprintStartedAt = Date.now();
    runtime.watchedFileStats = await buildWatchedFileStats({
      ctx,
      workspaceSkills: args.state.workspaceSkills,
      centralSkills: args.state.centralSkills,
      workspaceInstructions: args.state.workspaceInstructions,
      centralInstructions: args.state.centralInstructions
    });
    const fingerprintMs = Date.now() - fingerprintStartedAt;

    const groupCounts = args.countGroups(args.filterGroupsByTab(args.state.groups, args.state.activeTab));
    const totalMs = Date.now() - startedAt;
    args.output.appendLine(`[Refresh] completed in ${totalMs}ms - workspace=${args.state.workspaceSkills.length}, central=${args.state.centralSkills.length}`);
    args.output.appendLine(`[Refresh:visible] completed=${totalMs}ms workspace=${args.state.workspaceSkills.length} central=${args.state.centralSkills.length}`);
    args.output.appendLine(`[Refresh:timing] scan=${scanMs}ms inventory+meta=${inventoryMs}ms providers+diagnostics=${providerMs}ms groups+chrome=${groupsMs}ms watchers=${watchersMs}ms fingerprint=${fingerprintMs}ms`);
    args.output.appendLine(
      `[Refresh:scan] workspaceSkills=${workspaceSkillScan.ms}ms/${workspaceSkills.length} centralSkills=${centralSkillScan.ms}ms/${centralSkills.length} workspaceInstructions=${workspaceInstructionScan.ms}ms/${workspaceInstructions.length} centralInstructions=${centralInstructionScan.ms}ms/${centralInstructions.length} agents=${ctx.agents.length}`
    );
    void runPostRefreshAnalysis(runtime, refreshGeneration, enrichmentInput).catch((error) => {
      args.output.appendLine(`[Refresh:enrich] ${args.toUserError(error)}`);
    });
    return {
      workspaceFileCount: args.state.workspaceSkills.length,
      centralFileCount: args.state.centralSkills.length,
      workspaceGroupCount: groupCounts.workspace,
      centralGroupCount: groupCounts.central,
      centralRepoPath: ctx.centralRepoPath,
      groupNormalization: {
        changed: normalizedGroupResult.changed,
        splitCount: normalizedGroupResult.splitCount,
        removedTargetCount: normalizedGroupResult.removedTargetCount,
        removedGroupCount: normalizedGroupResult.removedGroupCount
      }
    };
  };

  const refresh = async (runtime: RuntimeState): Promise<ExtensionRefreshResult> => {
    if (runtime.refreshInFlight) {
      runtime.refreshAgainRequested = true;
      return runtime.refreshInFlight;
    }
    runtime.refreshAgainRequested = false;
    runtime.refreshInFlight = (async () => {
      let result = await runRefresh(runtime);
      while (runtime.refreshAgainRequested) {
        runtime.refreshAgainRequested = false;
        result = await runRefresh(runtime);
      }
      return result;
    })().finally(() => {
      runtime.refreshInFlight = null;
    });
    return runtime.refreshInFlight;
  };

  const registerWatcherEvent = (runtime: RuntimeState, uri: vscode.Uri): void => {
    scheduleWatcherRefresh(runtime, uri);
    const changed = args.getWorkspaceChangedSkillFolder(uri.fsPath);
    if (!changed) return;
    if (!args.getAutoSyncWorkspaceAgents().includes(changed.tool)) return;
    args.enqueueWorkspaceAutoSync(changed.tool, changed.skillFolderRel);
  };

  return {
    createRefreshState,
    scheduleRefresh,
    flushWorkspaceAutoSync,
    refresh,
    registerWatcherEvent
  };
}
