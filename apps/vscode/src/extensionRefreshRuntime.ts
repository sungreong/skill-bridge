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
  SKILL_BRIDGE_STATE_DIR,
  legacySkillsLockPath,
  skillsLockPath
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

type PostRefreshAnalysisInput = {
  workspacePath: string;
  centralRepoPath: string;
  workspaceSkills: SkillFile[];
  centralSkills: SkillFile[];
  workspaceMissingSkillFolders: Array<{ tool: ToolType; relativePath: string }>;
  centralMissingSkillFolders: Array<{ tool: ToolType; relativePath: string }>;
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
  tr: (message: string, ...args: Array<string | number | boolean>) => string;
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
    watchedFileStatsGeneration: number;
    pendingWatcherPaths: Set<string>;
    refreshGeneration: number;
    watchers: vscode.FileSystemWatcher[];
    watcherKey: string | null;
    autoSyncTimer: NodeJS.Timeout | null;
    autoSyncInFlight: Promise<void> | null;
    autoSyncPending: Map<string, { tool: ToolType; skillFolderRel: string }>;
    postRefreshTimer: NodeJS.Timeout | null;
    postRefreshInFlight: Promise<void> | null;
    pendingPostRefreshAnalysis: { refreshGeneration: number; input: PostRefreshAnalysisInput } | null;
    fingerprintImmediate: NodeJS.Immediate | null;
    fingerprintInFlight: Promise<void> | null;
    pendingFingerprint: { refreshGeneration: number; input: WatchedFileInput } | null;
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
    watchedFileStatsGeneration: number;
    pendingWatcherPaths: Set<string>;
    refreshGeneration: number;
    watchers: vscode.FileSystemWatcher[];
    watcherKey: string | null;
    autoSyncTimer: NodeJS.Timeout | null;
    autoSyncInFlight: Promise<void> | null;
    autoSyncPending: Map<string, { tool: ToolType; skillFolderRel: string }>;
    postRefreshTimer: NodeJS.Timeout | null;
    postRefreshInFlight: Promise<void> | null;
    pendingPostRefreshAnalysis: { refreshGeneration: number; input: PostRefreshAnalysisInput } | null;
    fingerprintImmediate: NodeJS.Immediate | null;
    fingerprintInFlight: Promise<void> | null;
    pendingFingerprint: { refreshGeneration: number; input: WatchedFileInput } | null;
  };

  const createRefreshState = (): RuntimeState => ({
    refreshTimer: null,
    refreshInFlight: null,
    refreshAgainRequested: false,
    scheduledRefreshAfterInFlight: false,
    watchedFileStats: new Map(),
    watchedFileStatsGeneration: 0,
    pendingWatcherPaths: new Set(),
    refreshGeneration: 0,
    watchers: [],
    watcherKey: null,
    autoSyncTimer: null,
    autoSyncInFlight: null,
    autoSyncPending: new Map(),
    postRefreshTimer: null,
    postRefreshInFlight: null,
    pendingPostRefreshAnalysis: null,
    fingerprintImmediate: null,
    fingerprintInFlight: null,
    pendingFingerprint: null
  });

  const startPendingFingerprint = (runtime: RuntimeState): Promise<void> | null => {
    if (runtime.fingerprintInFlight) return runtime.fingerprintInFlight;
    const pending = runtime.pendingFingerprint;
    if (!pending) return null;
    runtime.pendingFingerprint = null;
    const fingerprint = (async () => {
      const startedAt = Date.now();
      const stats = await buildWatchedFileStats(pending.input);
      const stale = runtime.refreshGeneration !== pending.refreshGeneration;
      if (!stale) {
        runtime.watchedFileStats = stats;
        runtime.watchedFileStatsGeneration = pending.refreshGeneration;
      }
      args.output.appendLine(
        `[Refresh:fingerprint] completed=${Date.now() - startedAt}ms files=${stats.size} generation=${pending.refreshGeneration}${stale ? " stale=true" : ""}`
      );
    })().catch((error) => {
      args.output.appendLine(`[Refresh:fingerprint] ${args.toUserError(error)}`);
    });
    runtime.fingerprintInFlight = fingerprint;
    void fingerprint.finally(() => {
      if (runtime.fingerprintInFlight === fingerprint) runtime.fingerprintInFlight = null;
      if (runtime.pendingFingerprint) armFingerprint(runtime);
    });
    return fingerprint;
  };

  const armFingerprint = (runtime: RuntimeState): void => {
    if (runtime.fingerprintImmediate) clearImmediate(runtime.fingerprintImmediate);
    runtime.fingerprintImmediate = setImmediate(() => {
      runtime.fingerprintImmediate = null;
      startPendingFingerprint(runtime);
    });
  };

  const scheduleFingerprint = (
    runtime: RuntimeState,
    refreshGeneration: number,
    input: WatchedFileInput
  ): void => {
    runtime.pendingFingerprint = { refreshGeneration, input };
    if (!runtime.fingerprintInFlight) armFingerprint(runtime);
  };

  const waitForCurrentFingerprint = async (runtime: RuntimeState): Promise<void> => {
    while (runtime.watchedFileStatsGeneration !== runtime.refreshGeneration) {
      if (runtime.fingerprintImmediate) {
        clearImmediate(runtime.fingerprintImmediate);
        runtime.fingerprintImmediate = null;
      }
      const fingerprint = runtime.fingerprintInFlight ?? startPendingFingerprint(runtime);
      if (!fingerprint) return;
      await fingerprint;
    }
  };

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
    await waitForCurrentFingerprint(runtime);
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
        const changed = summary.copied + summary.deleted + summary.mirroredGroups;
        if (summary.syncedFolders === 0 || changed === 0) return;
        args.output.appendLine(args.tr("[AutoSave] Workspace → Central folders={0} copied={1} deleted={2} unchanged={3} mirroredGroups={4} centralFolders={5} centralFiles={6} skippedMissingSkillMd={7}", String(summary.syncedFolders), String(summary.copied), String(summary.deleted), String(summary.unchanged), String(summary.mirroredGroups), String(summary.centralFolders), String(summary.centralFiles), String(summary.skippedMissingSkillMd)));
        vscode.window.setStatusBarMessage(
          args.tr("Skill Bridge auto save to Central: {0} folder(s) · copied {1} · deleted {2} · groups {3} · central {4}/{5} · skipped {6}", String(summary.syncedFolders), String(summary.copied), String(summary.deleted), String(summary.mirroredGroups), String(summary.centralFolders), String(summary.centralFiles), String(summary.skippedMissingSkillMd)),
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
    input: PostRefreshAnalysisInput
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

  const armPostRefreshAnalysis = (runtime: RuntimeState): void => {
    if (runtime.postRefreshTimer) clearTimeout(runtime.postRefreshTimer);
    runtime.postRefreshTimer = setTimeout(() => {
      runtime.postRefreshTimer = null;
      if (runtime.postRefreshInFlight) return;
      const pending = runtime.pendingPostRefreshAnalysis;
      if (!pending) return;
      runtime.pendingPostRefreshAnalysis = null;
      const analysis = runPostRefreshAnalysis(runtime, pending.refreshGeneration, pending.input).catch((error) => {
        args.output.appendLine(`[Refresh:enrich] ${args.toUserError(error)}`);
      });
      runtime.postRefreshInFlight = analysis;
      void analysis.finally(() => {
        if (runtime.postRefreshInFlight === analysis) runtime.postRefreshInFlight = null;
        if (runtime.pendingPostRefreshAnalysis) armPostRefreshAnalysis(runtime);
      });
    }, WATCHER_REFRESH_DEBOUNCE_MS);
  };

  const schedulePostRefreshAnalysis = (
    runtime: RuntimeState,
    refreshGeneration: number,
    input: PostRefreshAnalysisInput
  ): void => {
    runtime.pendingPostRefreshAnalysis = { refreshGeneration, input };
    if (!runtime.postRefreshInFlight) armPostRefreshAnalysis(runtime);
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
      if (presetResult.migratedFromLegacy) {
        await args.saveProjectPresets(ctx.centralRepoPath, {
          version: 1,
          updatedAt: new Date().toISOString(),
          presets: args.state.centralProjectPresets
        });
      }
    } catch (error) {
      args.state.centralProjectPresets = [];
      args.output.appendLine(`[ProjectPresets] ${args.toUserError(error)}`);
    }
    const lockGroupResult = await addNpxGroupsFromSkillLocks({
      workspacePath: ctx.workspacePath,
      centralRepoPath: ctx.centralRepoPath,
      groups: loadedGroupResult.groups,
      workspaceSkills: args.state.workspaceSkills,
      centralSkills: args.state.centralSkills
    });
    const normalizedGroupResult = args.normalizeGroupsForCurrentSkills({
      input: lockGroupResult.groups,
      workspaceSkills: args.state.workspaceSkills,
      centralSkills: args.state.centralSkills,
      dedupeGroupTargets: args.dedupeGroupTargets,
      targetExistsInFiles: args.targetExistsInFiles,
      options: { skipExistenceValidation: true }
    });
    args.state.groups = normalizedGroupResult.groups;
    if (normalizedGroupResult.changed || loadedGroupResult.needsSave || lockGroupResult.changed) {
      await args.saveSelectionGroups(ctx.workspacePath, ctx.centralRepoPath, args.state.groups);
    }
    if (args.state.selectedGroupId && !args.state.groups.some((item) => item.id === args.state.selectedGroupId)) {
      args.state.selectedGroupId = null;
    }
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
    scheduleFingerprint(runtime, refreshGeneration, {
      ctx,
      workspaceSkills: args.state.workspaceSkills,
      centralSkills: args.state.centralSkills,
      workspaceInstructions: args.state.workspaceInstructions,
      centralInstructions: args.state.centralInstructions
    });

    const groupCounts = args.countGroups(args.filterGroupsByTab(args.state.groups, args.state.activeTab));
    const totalMs = Date.now() - startedAt;
    args.output.appendLine(`[Refresh] completed in ${totalMs}ms - workspace=${args.state.workspaceSkills.length}, central=${args.state.centralSkills.length}`);
    args.output.appendLine(`[Refresh:visible] completed=${totalMs}ms workspace=${args.state.workspaceSkills.length} central=${args.state.centralSkills.length}`);
    args.output.appendLine(`[Refresh:timing] scan=${scanMs}ms inventory+meta=${inventoryMs}ms providers+diagnostics=${providerMs}ms groups+chrome=${groupsMs}ms watchers=${watchersMs}ms fingerprint=0ms`);
    args.output.appendLine(
      `[Refresh:scan] workspaceSkills=${workspaceSkillScan.ms}ms/${workspaceSkills.length} centralSkills=${centralSkillScan.ms}ms/${centralSkills.length} workspaceInstructions=${workspaceInstructionScan.ms}ms/${workspaceInstructions.length} centralInstructions=${centralInstructionScan.ms}ms/${centralInstructions.length} agents=${ctx.agents.length}`
    );
    schedulePostRefreshAnalysis(runtime, refreshGeneration, enrichmentInput);
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

type SkillsLockFile = {
  version?: number;
  skills?: Record<string, {
    source?: string;
    sourceType?: string;
    skillPath?: string;
  }>;
};

async function addNpxGroupsFromSkillLocks(args: {
  workspacePath: string;
  centralRepoPath: string;
  groups: SelectionGroup[];
  workspaceSkills: SkillFile[];
  centralSkills: SkillFile[];
}): Promise<{ groups: SelectionGroup[]; changed: boolean }> {
  let groups = args.groups;
  let changed = false;
  const workspace = await buildNpxGroupsFromLock("workspace", args.workspacePath, args.workspaceSkills, groups);
  groups = workspace.groups;
  changed = changed || workspace.changed;
  const central = await buildNpxGroupsFromLock("central", args.centralRepoPath, args.centralSkills, groups);
  groups = central.groups;
  changed = changed || central.changed;
  return { groups, changed };
}

async function buildNpxGroupsFromLock(
  side: TreeSide,
  basePath: string,
  skills: SkillFile[],
  groups: SelectionGroup[]
): Promise<{ groups: SelectionGroup[]; changed: boolean }> {
  const lock = await loadSkillsLock(basePath);
  if (!lock?.skills) return { groups, changed: false };

  const skillFoldersByName = new Map<string, Array<{ tool: ToolType; relativePath: string }>>();
  for (const file of skills) {
    const folder = skillFolderFromRelativePath(file.relativePath);
    if (!folder) continue;
    const name = folder.split("/")[1];
    if (!name) continue;
    const entries = skillFoldersByName.get(name) ?? [];
    if (!entries.some((entry) => entry.tool === file.tool && entry.relativePath === folder)) {
      entries.push({ tool: file.tool, relativePath: folder });
    }
    skillFoldersByName.set(name, entries);
  }

  const byRepoTool = new Map<string, { repoKey: string; repoUrl: string; tool: ToolType; skillNames: Set<string>; targets: Array<{ kind: "folder"; tool: ToolType; relativePath: string }> }>();
  for (const [skillName, entry] of Object.entries(lock.skills)) {
    const repoKey = normalizeRepoKey(entry.source ?? "");
    if (!repoKey) continue;
    const installedFolders = skillFoldersByName.get(skillName) ?? [];
    for (const folder of installedFolders) {
      const key = `${repoKey}:${folder.tool}`;
      const bucket = byRepoTool.get(key) ?? {
        repoKey,
        repoUrl: repoUrlFromKey(repoKey),
        tool: folder.tool,
        skillNames: new Set<string>(),
        targets: []
      };
      bucket.skillNames.add(skillName);
      if (!bucket.targets.some((target) => target.tool === folder.tool && target.relativePath === folder.relativePath)) {
        bucket.targets.push({ kind: "folder", tool: folder.tool, relativePath: folder.relativePath });
      }
      byRepoTool.set(key, bucket);
    }
  }

  if (byRepoTool.size === 0) return { groups, changed: false };

  const nextGroups = [...groups];
  let changed = false;
  for (const bucket of byRepoTool.values()) {
    bucket.targets.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    const existingIndex = nextGroups.findIndex((group) =>
      group.side === side
      && group.meta?.source === "npx"
      && group.meta.repoKey === bucket.repoKey
      && (group.meta.tool === bucket.tool || group.targets.some((target) => target.tool === bucket.tool))
    );
    const now = new Date().toISOString();
    const nextGroup: SelectionGroup = {
      ...(existingIndex >= 0 ? nextGroups[existingIndex] as SelectionGroup : {
        id: uniqueGroupId(nextGroups, `${side}-npx-${bucket.tool}-${slugifyGroupId(bucket.repoKey)}`),
        name: bucket.repoKey,
        description: `Installed from ${bucket.repoUrl}`,
        side
      }),
      targets: bucket.targets,
      meta: {
        ...(existingIndex >= 0 ? nextGroups[existingIndex]?.meta : undefined),
        source: "npx",
        tool: bucket.tool,
        repoKey: bucket.repoKey,
        repoUrl: bucket.repoUrl,
        lastInstalledAt: existingIndex >= 0 ? nextGroups[existingIndex]?.meta?.lastInstalledAt : now,
        installSkills: [...bucket.skillNames].sort((left, right) => left.localeCompare(right))
      }
    };
    if (existingIndex >= 0) {
      if (!selectionGroupsEqual(nextGroups[existingIndex] as SelectionGroup, nextGroup)) {
        nextGroups[existingIndex] = nextGroup;
        changed = true;
      }
    } else {
      nextGroups.push(nextGroup);
      changed = true;
    }
  }
  return { groups: nextGroups, changed };
}

async function loadSkillsLock(basePath: string): Promise<SkillsLockFile | null> {
  for (const target of [skillsLockPath(basePath), legacySkillsLockPath(basePath)]) {
    try {
      const raw = await fs.readFile(target, "utf8");
      const parsed = JSON.parse(raw) as SkillsLockFile;
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Try the next lock location.
    }
  }
  return null;
}

function skillFolderFromRelativePath(relativePath: string): string | null {
  const parts = relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts[0] !== "skills" || !parts[1]) return null;
  return `skills/${parts[1]}`;
}

function normalizeRepoKey(source: string): string {
  return source
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "")
    .trim();
}

function repoUrlFromKey(repoKey: string): string {
  return /^https?:\/\//i.test(repoKey) ? repoKey : `https://github.com/${repoKey}`;
}

function slugifyGroupId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "skills";
}

function uniqueGroupId(groups: SelectionGroup[], baseId: string): string {
  const used = new Set(groups.map((group) => group.id));
  if (!used.has(baseId)) return baseId;
  let index = 2;
  while (used.has(`${baseId}-${index}`)) index += 1;
  return `${baseId}-${index}`;
}

function selectionGroupsEqual(left: SelectionGroup, right: SelectionGroup): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
