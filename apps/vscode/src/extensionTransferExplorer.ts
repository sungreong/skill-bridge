import { promises as fs } from "node:fs";
import * as vscode from "vscode";
import type { GroupTarget, SelectionGroup, SkillFile, ToolType, TransferStatus } from "./types";
import { renderComparedTransferExplorerHtml } from "./comparedTransferExplorerView";
import {
  dedupeGroupTargets,
  getSkillInnerRelativePath,
  isManagedSkillPath,
  isToolType,
  normalizeRel,
  targetExistsInFiles
} from "./extensionSupport";
import {
  getGroupTool,
  normalizeGroupNameKey,
  summarizeGroupTargets
} from "./extensionGroupTools";
import type { UiLanguage } from "./uiLanguage";

type TreeSide = "workspace" | "central";
type TranslationFn = (message: string, ...args: Array<string | number | boolean>) => string;
type ExplorerTarget = { tool: ToolType; relativePath: string; kind: "file" | "folder" };
type ExplorerTransferSummary = { requested: number; processed: number; copied: number; deleted: number; unchanged: number; skipped: number; mirroredGroups: number };
type ExplorerGroupSummary = { changed: number; skipped: number };
type ExplorerGroupStatus = "same" | "modified" | "onlyWorkspace" | "onlyCentral";
type ExplorerSkillStatus = "same" | "modified" | "onlyWorkspace" | "onlyCentral";
type ExplorerSkill = {
  key: string;
  tool: ToolType;
  folder: string;
  skillName: string;
  status: ExplorerSkillStatus;
  workspaceExists: boolean;
  centralExists: boolean;
  workspaceFileCount: number;
  centralFileCount: number;
  modifiedFileCount: number;
  workspaceOnlyFileCount: number;
  centralOnlyFileCount: number;
  workspaceGroupNames: string[];
  centralGroupNames: string[];
};
type ExplorerGroupDiff = {
  key: string;
  tool: ToolType;
  name: string;
  status: ExplorerGroupStatus;
  workspaceGroupId: string | null;
  centralGroupId: string | null;
  workspaceTargetCount: number;
  centralTargetCount: number;
  workspaceTargets: string[];
  centralTargets: string[];
};
type ExplorerGroupView = { id: string; name: string; targetSummary: string; targetCount: number; tools: ToolType[] };
type ExplorerFolderView = {
  tool: ToolType;
  folder: string;
  fileCount: number;
  groupNames: string[];
  files: string[];
  subfolders: Array<{ path: string; fileCount: number }>;
};
type ExplorerSideView = {
  folders: ExplorerFolderView[];
  groups: ExplorerGroupView[];
};
type ExplorerPayload = {
  tools: ToolType[];
  skills: ExplorerSkill[];
  groupDiffs: ExplorerGroupDiff[];
  groups: { workspace: ExplorerGroupView[]; central: ExplorerGroupView[] };
  workspace: ExplorerSideView;
  central: ExplorerSideView;
  summary: { total: number; modified: number; onlyWorkspace: number; onlyCentral: number; same: number };
  groupSummary: { total: number; modified: number; onlyWorkspace: number; onlyCentral: number; same: number };
};
type ExplorerState = {
  workspaceSkills: SkillFile[];
  centralSkills: SkillFile[];
  groups: SelectionGroup[];
};
type ExplorerDeps = {
  state: ExplorerState;
  tr: TranslationFn;
  getUiLanguage: () => UiLanguage;
  refresh: () => Promise<void>;
  applyPanelBranding: (panel: vscode.WebviewPanel, render: () => void | Promise<void>) => void;
  getSkillFolderRelativePath: (relativePath: string) => string | null;
  transferPathFromExplorer: (
    sourceSide: TreeSide,
    tool: ToolType,
    relativePath: string,
    kind: "file" | "folder",
    preferredGroupIds?: string[]
  ) => Promise<void>;
  transferComparedTargetsFromExplorer: (
    sourceSide: TreeSide,
    targets: ExplorerTarget[],
    selectedStatuses: TransferStatus[]
  ) => Promise<ExplorerTransferSummary>;
  mirrorComparedGroupsFromExplorer: (sourceSide: TreeSide, groupIds: string[]) => Promise<ExplorerGroupSummary>;
  deleteComparedGroupsFromExplorer: (targetSide: TreeSide, groupIds: string[]) => Promise<ExplorerGroupSummary>;
  openLibraryDiff: (sourceSide: TreeSide, tool: ToolType, relativePath: string, kind: "file" | "folder") => Promise<void>;
  exportGroup: (side: TreeSide, group?: SelectionGroup) => Promise<unknown>;
  isSameFileContent: (src: string, dst: string, srcSize: number, dstSize: number) => Promise<boolean>;
  toUserError: (error: unknown) => string;
  handleError: (error: unknown) => Promise<void>;
};

function parseLibraryTargets(rawTargets: unknown): ExplorerTarget[] {
  return (Array.isArray(rawTargets) ? rawTargets : [])
    .map((target) => {
      const item = (target && typeof target === "object") ? target as { tool?: unknown; relativePath?: unknown; kind?: unknown } : {};
      const tool = isToolType(String(item.tool ?? "")) ? String(item.tool ?? "") as ToolType : null;
      const relativePath = normalizeRel(String(item.relativePath ?? ""));
      const kind = item.kind === "file" ? "file" : "folder";
      if (!tool || !relativePath || !isManagedSkillPath(relativePath)) return null;
      if (relativePath.toLowerCase() === "skills") return null;
      return { tool, relativePath, kind };
    })
    .filter((target): target is ExplorerTarget => !!target);
}

function normalizeTransferExplorerActionStatus(status: unknown): TransferStatus {
  if (status === "added" || status === "removed" || status === "modified" || status === "typeChanged" || status === "same") {
    return status;
  }
  return "modified";
}

function transferExplorerSelectedStatuses(status: TransferStatus): TransferStatus[] {
  if (status === "same") return [];
  if (status === "removed") return ["removed"];
  if (status === "added") return ["added", "typeChanged"];
  if (status === "typeChanged") return ["typeChanged"];
  return ["added", "modified", "typeChanged"];
}

export function createTransferExplorerTools(deps: ExplorerDeps): {
  openTransferExplorerPanel: () => Promise<void>;
} {
  const buildTransferExplorerPayload = async (): Promise<ExplorerPayload> => {
    type SkillFolderDraft = {
      tool: ToolType;
      folder: string;
      files: SkillFile[];
      groupNames: Set<string>;
    };

    const buildGroupViews = (side: TreeSide): ExplorerGroupView[] =>
      deps.state.groups
        .filter((group) => group.side === side)
        .map((group) => ({
          id: group.id,
          name: group.name,
          targetSummary: summarizeGroupTargets(deps.tr, group.targets),
          targetCount: group.targets.length,
          tools: [...new Set(group.targets.map((target) => target.tool))].sort((a, b) => a.localeCompare(b))
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

    const buildDrafts = (side: TreeSide): Map<string, SkillFolderDraft> => {
      const files = side === "workspace" ? deps.state.workspaceSkills : deps.state.centralSkills;
      const sideGroups = deps.state.groups.filter((group) => group.side === side);
      const drafts = new Map<string, SkillFolderDraft>();

      for (const file of files) {
        const folder = deps.getSkillFolderRelativePath(file.relativePath);
        if (!folder) continue;
        const key = `${file.tool}:${folder}`;
        const draft = drafts.get(key) ?? { tool: file.tool, folder, files: [], groupNames: new Set<string>() };
        draft.files.push({ ...file, relativePath: normalizeRel(file.relativePath) });
        drafts.set(key, draft);
      }

      for (const group of sideGroups) {
        for (const target of group.targets) {
          const folder = deps.getSkillFolderRelativePath(target.relativePath);
          if (!folder) continue;
          const key = `${target.tool}:${folder}`;
          const draft = drafts.get(key) ?? { tool: target.tool, folder, files: [], groupNames: new Set<string>() };
          draft.groupNames.add(group.name);
          drafts.set(key, draft);
        }
      }
      return drafts;
    };

    const buildSideView = (drafts: Map<string, SkillFolderDraft>, groups: ExplorerGroupView[]): ExplorerSideView => {
      const folders = [...drafts.values()]
        .map((draft) => {
          const folder = draft.folder.split("/")[1] ?? draft.folder;
          const files = new Set<string>();
          const subfolderCounts = new Map<string, number>();
          for (const file of draft.files) {
            const inner = getSkillInnerRelativePath(file.relativePath);
            if (!inner) continue;
            files.add(inner);
            const parts = inner.split("/").filter(Boolean);
            let prefix = "";
            for (let i = 0; i < parts.length - 1; i += 1) {
              prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
              subfolderCounts.set(prefix, (subfolderCounts.get(prefix) ?? 0) + 1);
            }
          }
          return {
            tool: draft.tool,
            folder,
            fileCount: draft.files.length,
            groupNames: [...draft.groupNames].sort((a, b) => a.localeCompare(b)),
            files: [...files].sort((a, b) => a.localeCompare(b)),
            subfolders: [...subfolderCounts.entries()]
              .map(([path, fileCount]) => ({ path, fileCount }))
              .sort((a, b) => a.path.localeCompare(b.path))
          };
        })
        .sort((a, b) => a.tool.localeCompare(b.tool) || a.folder.localeCompare(b.folder));
      return { folders, groups };
    };

    const groupTargetKey = (target: GroupTarget): string =>
      `${target.kind}:${target.tool}:${normalizeRel(target.relativePath)}`;
    const groupTargetLabel = (target: GroupTarget): string =>
      `${target.tool}/${normalizeRel(target.relativePath)}`;
    const groupsEqual = (left: string[], right: string[]): boolean =>
      left.length === right.length && left.every((value, index) => value === right[index]);

    const buildGroupDiffs = (): ExplorerGroupDiff[] => {
      type Draft = { group: SelectionGroup; tool: ToolType; targets: string[]; labels: string[]; mirrorKey: string | null };
      const build = (side: TreeSide): Draft[] => {
        const drafts: Draft[] = [];
        for (const group of deps.state.groups.filter((item) => item.side === side)) {
          const tool = getGroupTool(group);
          if (!tool) continue;
          drafts.push({
            group,
            tool,
            targets: dedupeGroupTargets(group.targets).map(groupTargetKey).sort((a, b) => a.localeCompare(b)),
            labels: dedupeGroupTargets(group.targets).map(groupTargetLabel).sort((a, b) => a.localeCompare(b)),
            mirrorKey: typeof group.meta?.mirroredFrom === "string" ? group.meta.mirroredFrom : null
          });
        }
        return drafts.sort((a, b) => a.tool.localeCompare(b.tool) || a.group.name.localeCompare(b.group.name) || a.group.id.localeCompare(b.group.id));
      };

      const workspace = build("workspace");
      const central = build("central");
      const centralByMirrorKey = new Map<string, Draft>();
      const centralNameBuckets = new Map<string, Draft[]>();
      for (const draft of central) {
        if (draft.mirrorKey) centralByMirrorKey.set(draft.mirrorKey, draft);
        const bucketKey = `${draft.tool}:${normalizeGroupNameKey(draft.group.name)}`;
        const bucket = centralNameBuckets.get(bucketKey) ?? [];
        bucket.push(draft);
        centralNameBuckets.set(bucketKey, bucket);
      }

      const matchedCentralIds = new Set<string>();
      const rows: ExplorerGroupDiff[] = [];
      const pushDiff = (workspaceDraft?: Draft, centralDraft?: Draft): void => {
        const draft = workspaceDraft ?? centralDraft;
        if (!draft) return;
        const status: ExplorerGroupStatus = workspaceDraft && centralDraft
          ? groupsEqual(workspaceDraft.targets, centralDraft.targets) ? "same" : "modified"
          : workspaceDraft ? "onlyWorkspace" : "onlyCentral";
        rows.push({
          key: workspaceDraft && centralDraft
            ? `${draft.tool}:pair:${workspaceDraft.group.id}:${centralDraft.group.id}`
            : workspaceDraft
              ? `${draft.tool}:workspace:${workspaceDraft.group.id}`
              : `${draft.tool}:central:${centralDraft?.group.id ?? "unknown"}`,
          tool: draft.tool,
          name: draft.group.name,
          status,
          workspaceGroupId: workspaceDraft?.group.id ?? null,
          centralGroupId: centralDraft?.group.id ?? null,
          workspaceTargetCount: workspaceDraft?.targets.length ?? 0,
          centralTargetCount: centralDraft?.targets.length ?? 0,
          workspaceTargets: workspaceDraft?.labels ?? [],
          centralTargets: centralDraft?.labels ?? []
        });
      };

      for (const workspaceDraft of workspace) {
        let centralDraft = centralByMirrorKey.get(`workspace:${workspaceDraft.group.id}`);
        if (centralDraft && matchedCentralIds.has(centralDraft.group.id)) centralDraft = undefined;
        if (!centralDraft) {
          const bucketKey = `${workspaceDraft.tool}:${normalizeGroupNameKey(workspaceDraft.group.name)}`;
          centralDraft = (centralNameBuckets.get(bucketKey) ?? []).find((item) => !matchedCentralIds.has(item.group.id));
        }
        if (centralDraft) matchedCentralIds.add(centralDraft.group.id);
        pushDiff(workspaceDraft, centralDraft);
      }
      for (const centralDraft of central) {
        if (!matchedCentralIds.has(centralDraft.group.id)) pushDiff(undefined, centralDraft);
      }
      return rows.sort((a, b) =>
        a.tool.localeCompare(b.tool)
        || a.name.localeCompare(b.name)
        || (a.workspaceGroupId ?? "").localeCompare(b.workspaceGroupId ?? "")
        || (a.centralGroupId ?? "").localeCompare(b.centralGroupId ?? "")
      );
    };

    const compareDrafts = async (
      workspaceDraft: SkillFolderDraft | undefined,
      centralDraft: SkillFolderDraft | undefined
    ): Promise<{ status: ExplorerSkillStatus; modifiedFileCount: number; workspaceOnlyFileCount: number; centralOnlyFileCount: number }> => {
      if (workspaceDraft && !centralDraft) {
        return { status: "onlyWorkspace", modifiedFileCount: 0, workspaceOnlyFileCount: workspaceDraft.files.length, centralOnlyFileCount: 0 };
      }
      if (!workspaceDraft && centralDraft) {
        return { status: "onlyCentral", modifiedFileCount: 0, workspaceOnlyFileCount: 0, centralOnlyFileCount: centralDraft.files.length };
      }
      if (!workspaceDraft || !centralDraft) {
        return { status: "same", modifiedFileCount: 0, workspaceOnlyFileCount: 0, centralOnlyFileCount: 0 };
      }

      const workspaceByInner = new Map(workspaceDraft.files.map((file) => [getSkillInnerRelativePath(file.relativePath), file] as const));
      const centralByInner = new Map(centralDraft.files.map((file) => [getSkillInnerRelativePath(file.relativePath), file] as const));
      const allInner = new Set<string>([...workspaceByInner.keys(), ...centralByInner.keys()]);
      let modifiedFileCount = 0;
      let workspaceOnlyFileCount = 0;
      let centralOnlyFileCount = 0;

      for (const inner of allInner) {
        const workspaceFile = workspaceByInner.get(inner);
        const centralFile = centralByInner.get(inner);
        if (workspaceFile && !centralFile) {
          workspaceOnlyFileCount += 1;
          continue;
        }
        if (!workspaceFile && centralFile) {
          centralOnlyFileCount += 1;
          continue;
        }
        if (!workspaceFile || !centralFile) continue;
        const [workspaceStat, centralStat] = await Promise.all([
          fs.stat(workspaceFile.absolutePath).catch(() => null),
          fs.stat(centralFile.absolutePath).catch(() => null)
        ]);
        if (!workspaceStat?.isFile() || !centralStat?.isFile()) {
          modifiedFileCount += 1;
          continue;
        }
        if (!(await deps.isSameFileContent(workspaceFile.absolutePath, centralFile.absolutePath, workspaceStat.size, centralStat.size))) {
          modifiedFileCount += 1;
        }
      }

      return {
        status: modifiedFileCount > 0 || workspaceOnlyFileCount > 0 || centralOnlyFileCount > 0 ? "modified" : "same",
        modifiedFileCount,
        workspaceOnlyFileCount,
        centralOnlyFileCount
      };
    };

    const workspaceDrafts = buildDrafts("workspace");
    const centralDrafts = buildDrafts("central");
    const workspaceGroups = buildGroupViews("workspace");
    const centralGroups = buildGroupViews("central");
    const groupDiffs = buildGroupDiffs();
    const allKeys = [...new Set([...workspaceDrafts.keys(), ...centralDrafts.keys()])].sort((a, b) => a.localeCompare(b));
    const skills: ExplorerSkill[] = [];

    for (const key of allKeys) {
      const workspaceDraft = workspaceDrafts.get(key);
      const centralDraft = centralDrafts.get(key);
      const draft = workspaceDraft ?? centralDraft;
      if (!draft) continue;
      const compared = await compareDrafts(workspaceDraft, centralDraft);
      skills.push({
        key,
        tool: draft.tool,
        folder: draft.folder,
        skillName: draft.folder.split("/")[1] ?? draft.folder,
        status: compared.status,
        workspaceExists: !!workspaceDraft && workspaceDraft.files.length > 0,
        centralExists: !!centralDraft && centralDraft.files.length > 0,
        workspaceFileCount: workspaceDraft?.files.length ?? 0,
        centralFileCount: centralDraft?.files.length ?? 0,
        modifiedFileCount: compared.modifiedFileCount,
        workspaceOnlyFileCount: compared.workspaceOnlyFileCount,
        centralOnlyFileCount: compared.centralOnlyFileCount,
        workspaceGroupNames: [...(workspaceDraft?.groupNames ?? new Set<string>())].sort((a, b) => a.localeCompare(b)),
        centralGroupNames: [...(centralDraft?.groupNames ?? new Set<string>())].sort((a, b) => a.localeCompare(b))
      });
    }

    const tools = [...new Set<ToolType>([
      ...skills.map((item) => item.tool),
      ...deps.state.groups.flatMap((group) => group.targets.map((target) => target.tool))
    ])].sort((a, b) => a.localeCompare(b));

    return {
      tools,
      skills: skills.sort((a, b) => a.tool.localeCompare(b.tool) || a.folder.localeCompare(b.folder)),
      groupDiffs,
      groups: { workspace: workspaceGroups, central: centralGroups },
      workspace: buildSideView(workspaceDrafts, workspaceGroups),
      central: buildSideView(centralDrafts, centralGroups),
      summary: {
        total: skills.length,
        modified: skills.filter((item) => item.status === "modified").length,
        onlyWorkspace: skills.filter((item) => item.status === "onlyWorkspace").length,
        onlyCentral: skills.filter((item) => item.status === "onlyCentral").length,
        same: skills.filter((item) => item.status === "same").length
      },
      groupSummary: {
        total: groupDiffs.length,
        modified: groupDiffs.filter((item) => item.status === "modified").length,
        onlyWorkspace: groupDiffs.filter((item) => item.status === "onlyWorkspace").length,
        onlyCentral: groupDiffs.filter((item) => item.status === "onlyCentral").length,
        same: groupDiffs.filter((item) => item.status === "same").length
      }
    };
  };

  const openTransferExplorerPanel = async (): Promise<void> => {
    await deps.refresh();
    const panel = vscode.window.createWebviewPanel(
      "skillBridgeTransferExplorer",
      deps.tr("Compare and Apply Changes (Workspace ↔ Central)"),
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    const postState = async (): Promise<void> => {
      panel.webview.postMessage({ type: "state", payload: await buildTransferExplorerPayload() });
    };
    const postUi = (payload: { busy?: boolean; message?: string; tone?: "info" | "warn" | "error" }): void => {
      panel.webview.postMessage({ type: "ui", payload });
    };
    const render = async (): Promise<void> => {
      panel.title = deps.tr("Compare and Apply Changes (Workspace ↔ Central)");
      panel.webview.html = renderComparedTransferExplorerHtml(panel.webview, await buildTransferExplorerPayload(), deps.getUiLanguage());
    };
    deps.applyPanelBranding(panel, render);

    await render();
    panel.webview.onDidReceiveMessage(async (msg: unknown) => {
      if (!msg || typeof msg !== "object") return;
      const message = msg as { type?: string; payload?: unknown };
      try {
        if (message.type === "refresh") {
          postUi({ busy: true, message: deps.tr("Refreshing list..."), tone: "info" });
          await deps.refresh();
          await postState();
          postUi({ busy: false, message: deps.tr("List refreshed."), tone: "info" });
          return;
        }
        if (message.type === "movePath") {
          const payload = (message.payload as { sourceSide?: string; tool?: string; relativePath?: string; kind?: string; selectedGroupIds?: string[] } | undefined) ?? {};
          const sourceSide = payload.sourceSide === "central" ? "central" : "workspace";
          const tool = isToolType(String(payload.tool ?? "")) ? String(payload.tool ?? "") as ToolType : null;
          const relativePath = normalizeRel(String(payload.relativePath ?? ""));
          const kind = payload.kind === "file" ? "file" : "folder";
          if (!tool || !relativePath) return;
          postUi({ busy: true, message: `${kind === "file" ? deps.tr("File") : deps.tr("Folder")} apply in progress: ${tool}/${relativePath}`, tone: "info" });
          await deps.transferPathFromExplorer(sourceSide, tool, relativePath, kind, payload.selectedGroupIds);
          await postState();
          postUi({ busy: false, message: `${kind === "file" ? deps.tr("File") : deps.tr("Folder")} apply completed: ${tool}/${relativePath}`, tone: "info" });
          return;
        }
        if (message.type === "moveGroup") {
          const payload = (message.payload as { sourceSide?: string; groupId?: string } | undefined) ?? {};
          const sourceSide = payload.sourceSide === "central" ? "central" : "workspace";
          const groupId = String(payload.groupId ?? "");
          if (!groupId) return;
          const group = deps.state.groups.find((entry) => entry.id === groupId && entry.side === sourceSide);
          if (!group) {
            vscode.window.showWarningMessage(deps.tr("The group to apply was not found."));
            return;
          }
          postUi({ busy: true, message: deps.tr("Group apply in progress: {0}", String(group.name)), tone: "info" });
          await deps.exportGroup(sourceSide, group);
          await postState();
          postUi({ busy: false, message: deps.tr("Group apply completed: {0}", String(group.name)), tone: "info" });
          return;
        }
        if (message.type === "moveCompared") {
          const payload = (message.payload as { mode?: string; status?: string; targets?: unknown } | undefined) ?? {};
          const mode = payload.mode === "centralToWorkspace" ? "centralToWorkspace" : "workspaceToCentral";
          const sourceSide: TreeSide = mode === "workspaceToCentral" ? "workspace" : "central";
          const targets = parseLibraryTargets(payload.targets).map((target) => ({ ...target, kind: "folder" as const }));
          if (targets.length === 0) throw new Error(deps.tr("There are no skills to apply."));
          const status = normalizeTransferExplorerActionStatus(payload.status);
          const selectedStatuses = transferExplorerSelectedStatuses(status);
          postUi({ busy: true, message: deps.tr("Reviewing compared area apply... ({0} skills)", String(targets.length)), tone: "info" });
          const summary = await deps.transferComparedTargetsFromExplorer(sourceSide, targets, selectedStatuses);
          await postState();
          const groupSuffix = summary.mirroredGroups > 0
            ? deps.tr(" · applied groups {0}", String(summary.mirroredGroups))
            : "";
          postUi({
            busy: false,
            message: deps.tr("Area applied: requested {0} skills · reviewed {1} skills · copied {2} · deleted {3} · unchanged {4} · skipped {5}{6}", String(summary.requested), String(summary.processed), String(summary.copied), String(summary.deleted), String(summary.unchanged), String(summary.skipped), String(groupSuffix)),
            tone: summary.copied + summary.deleted > 0 ? "info" : "warn"
          });
          return;
        }
        if (message.type === "moveComparedGroups") {
          const payload = (message.payload as { mode?: string; status?: string; groupIds?: string[] } | undefined) ?? {};
          const mode = payload.mode === "centralToWorkspace" ? "centralToWorkspace" : "workspaceToCentral";
          const sourceSide: TreeSide = mode === "workspaceToCentral" ? "workspace" : "central";
          const targetSide: TreeSide = sourceSide === "workspace" ? "central" : "workspace";
          const status = normalizeTransferExplorerActionStatus(payload.status);
          const groupIds = (Array.isArray(payload.groupIds) ? payload.groupIds : []).map((id) => String(id)).filter(Boolean);
          if (groupIds.length === 0) throw new Error(deps.tr("There are no groups to apply."));
          if (groupIds.length > 1) {
            const continueLabel = deps.tr("Continue");
            const confirm = await vscode.window.showWarningMessage(
              deps.tr("Apply {0} groups at once? This updates multiple group definitions in one pass.", String(groupIds.length)),
              { modal: true },
              continueLabel
            );
            if (confirm !== continueLabel) {
              postUi({ busy: false, message: deps.tr("Bulk group apply was canceled."), tone: "warn" });
              return;
            }
          }

          postUi({ busy: true, message: deps.tr("Applying group differences... ({0} groups)", String(groupIds.length)), tone: "info" });
          const result = status === "removed"
            ? await deps.deleteComparedGroupsFromExplorer(targetSide, groupIds)
            : await deps.mirrorComparedGroupsFromExplorer(sourceSide, groupIds);
          await postState();
          postUi({
            busy: false,
            message: deps.tr("Groups applied: requested {0} · changed {1} · skipped {2}", String(groupIds.length), String(result.changed), String(result.skipped)),
            tone: result.changed > 0 ? "info" : "warn"
          });
          return;
        }
        if (message.type === "openComparedDiff") {
          const payload = (message.payload as { mode?: string; tool?: string; relativePath?: string } | undefined) ?? {};
          const mode = payload.mode === "centralToWorkspace" ? "centralToWorkspace" : "workspaceToCentral";
          const sourceSide: TreeSide = mode === "workspaceToCentral" ? "workspace" : "central";
          const tool = isToolType(String(payload.tool ?? "")) ? String(payload.tool ?? "") as ToolType : null;
          const relativePath = normalizeRel(String(payload.relativePath ?? ""));
          if (!tool || !relativePath) return;
          await deps.openLibraryDiff(sourceSide, tool, relativePath, "folder");
        }
      } catch (error) {
        postUi({ busy: false, message: deps.toUserError(error), tone: "error" });
        await deps.handleError(error);
      }
    });
  };

  return { openTransferExplorerPanel };
}
