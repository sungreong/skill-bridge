import { promises as fs } from "node:fs";
import * as vscode from "vscode";
import { resolveSkillPath } from "./skillPaths";
import { isManagedSkillPath, normalizeRel } from "./extensionSupport";
import type { CentralSkillHistoryFile } from "./extensionHistoryTools";
import { sourceDetail } from "./groupOverviewLabels";
import { renderGroupOverviewHtml, skillFolderRelativePath, skillNameFromRelativePath } from "./groupOverviewRender";
import type { GroupOverviewData, GroupOverviewGroup, GroupOverviewTarget, TreeSide } from "./groupOverviewTypes";
import { ALL_AGENTS, type GroupTreeNode, type GroupTarget, type SelectionGroup, type SkillFile, type SkillSelection, type ToolType } from "./types";
import { localize, type UiLanguage } from "./uiLanguage";
import type { GroupMutationSummary, LibraryTarget } from "./libraryManagerTypes";
import { collectNpxSkillLibraryDiagnosis } from "./npxSkillLibraryDiagnostics";
import { canUpdateNpxGroup, updateNpxGroupFromMetadata } from "./npxGroupUpdate";
import type { NpxInstallPreset } from "./extensionInstallTransfer";
type TranslationFn = (message: string, ...args: Array<string | number | boolean>) => string;

export function createGroupOverviewTools(args: {
  tr: TranslationFn;
  getUiLanguage: () => UiLanguage;
  refresh: () => Promise<void>;
  applyPanelBranding: (panel: vscode.WebviewPanel, render: () => void | Promise<void>) => void;
  state: {
    workspacePath: string;
    centralRepoPath: string;
    workspaceSkills: SkillFile[];
    centralSkills: SkillFile[];
    groups: SelectionGroup[];
  };
  loadCentralSkillHistory: () => Promise<CentralSkillHistoryFile>;
  targetsToSelections: (files: SkillFile[], targets: SelectionGroup["targets"]) => SkillSelection[];
  persistGroups: (next: SelectionGroup[], selectedGroupId: string | null, options?: { skipExistenceValidation?: boolean }) => Promise<void>;
  getGroupTool: (group: SelectionGroup) => ToolType | "mixed" | null;
  exportGroup: (side: TreeSide, selectedGroup?: SelectionGroup, options?: { skipConfirm?: boolean; skipNotify?: boolean; skipRefresh?: boolean }) => Promise<{ copied: number; deleted: number; unchanged: number } | null>;
  mirrorGroupToOtherSide: (group: SelectionGroup, options?: { requireExistingTargets?: boolean }) => Promise<boolean>;
  installSkillsForSide: (side: TreeSide) => Promise<void>;
  installNpxRepoForSide: (side: TreeSide, preset: NpxInstallPreset) => Promise<boolean>;
  assignTargetsToGroupMany: (side: TreeSide, groupId: string, targets: LibraryTarget[]) => Promise<GroupMutationSummary>;
  unassignTargetsFromGroupMany: (side: TreeSide, groupId: string, targets: LibraryTarget[]) => Promise<GroupMutationSummary>;
  ensureUniqueGroupNameForTool: (input: {
    groups: SelectionGroup[];
    tr: TranslationFn;
    side: TreeSide;
    tool: ToolType;
    name: string;
    excludeId?: string;
  }) => void;
  toUserError: (error: unknown) => string;
}): {
  openGroupOverview: (node?: GroupTreeNode) => Promise<void>;
} {
  const openGroupOverview = async (node?: GroupTreeNode): Promise<void> => {
    try {
      if (!args.state.workspacePath || !args.state.centralRepoPath) await args.refresh();
      const contextNode = normalizeGroupContextNode(node);
      const side = contextNode?.side ?? "workspace";
      const agentFilter = contextNode?.kind === "tool" ? contextNode.tool ?? null : null;
      const groupFilterId = contextNode?.kind === "group" ? contextNode.id : null;
      const panel = vscode.window.createWebviewPanel(
        "skillBridgeGroupOverview",
        args.tr("Group Overview"),
        vscode.ViewColumn.Active,
        { enableScripts: true }
      );

      const render = async (): Promise<void> => {
        const data = await buildGroupOverviewData(args, side, agentFilter, groupFilterId);
        panel.title = args.tr("Group Overview: {0}{1}", String(side), String(agentFilter ? `/${agentFilter}` : ""));
        panel.webview.html = renderGroupOverviewHtml(panel.webview, data, args.getUiLanguage());
      };

      panel.webview.onDidReceiveMessage(async (message: unknown) => {
        try {
          if (isEditGroupMessage(message)) {
            const group = findGroupOrThrow(args, message.groupId, args.tr("Could not find the group to edit."));
            const name = message.name.trim();
            if (!name) throw new Error(args.tr("Group name is required."));
            const groupTool = args.getGroupTool(group);
            if (!groupTool || groupTool === "mixed") {
              throw new Error(args.tr("Mixed-agent groups cannot be renamed in this view."));
            }
            args.ensureUniqueGroupNameForTool({
              groups: args.state.groups,
              tr: args.tr,
              side: group.side,
              tool: groupTool,
              name,
              excludeId: group.id
            });
            const nextGroups = args.state.groups.map((item) =>
              item.id === group.id
                ? { ...item, name, description: message.description.trim() }
                : item
            );
            await args.persistGroups(nextGroups, group.id);
            vscode.window.setStatusBarMessage(args.tr("Group updated: {0}", String(name)), 2000);
          } else if (isTransferGroupMessage(message)) {
            const group = findGroupOrThrow(args, message.groupId, args.tr("Could not find the group to apply."));
            if (message.mode === "groupOnly") {
              const ok = await vscode.window.showWarningMessage(
                args.tr("Create/update only the group \"{0}\" on the opposite side? Skill files will not be copied.", String(group.name)),
                { modal: true },
                args.tr("Continue")
              );
              if (ok !== args.tr("Continue")) {
                await render();
                return;
              }
              const mirrored = await args.mirrorGroupToOtherSide(group, { requireExistingTargets: false });
              vscode.window.setStatusBarMessage(
                mirrored
                  ? args.tr("Group metadata mirrored: {0}", String(group.name))
                  : args.tr("No group targets to mirror: {0}", String(group.name)),
                2500
              );
            } else {
              await args.exportGroup(group.side, group);
            }
            await args.refresh();
          } else if (isInstallNpxMessage(message)) {
            await args.installSkillsForSide(message.side);
            await args.refresh();
          } else if (isUpdateNpxGroupMessage(message)) {
            const group = findGroupOrThrow(args, message.groupId, args.tr("Could not find the npx group to update."));
            if (group.meta?.source !== "npx") {
              throw new Error(args.tr("Only npx groups can be updated from this action."));
            }
            const diagnosis = await collectNpxSkillLibraryDiagnosis({ tr: args.tr, toUserError: args.toUserError });
            if (diagnosis.status !== "ready") {
              const missing = diagnosis.requirements.filter((item) => item.status === "missing").map((item) => item.label).join(", ");
              throw new Error(args.tr("NPX update requirements are missing: {0}. Open NPX Skill Library for details.", String(missing || diagnosis.summary)));
            }
            const updated = await updateNpxGroupFromMetadata(args, group, false);
            if (updated) await args.refresh();
          } else if (isAddSkillsToGroupsMessage(message)) {
            await addSkillsToGroups(args, message.groupIds);
          } else if (isTransferGroupsMessage(message)) {
            await transferGroups(args, message.groupIds, message.mode);
          } else if (isAddSkillsMessage(message)) {
            const group = findGroupOrThrow(args, message.groupId, args.tr("Could not find the group to update."));
            await addSkillsToGroup(args, group);
          } else if (isRemoveSkillsMessage(message)) {
            const group = findGroupOrThrow(args, message.groupId, args.tr("Could not find the group to update."));
            await removeSkillsFromGroup(args, group, message.targets);
          } else {
            return;
          }
          await render();
        } catch (error) {
          vscode.window.showErrorMessage(localizeGroupOverviewError(args, error));
          await render().catch(() => undefined);
        }
      });

      await render();
      args.applyPanelBranding(panel, render);
    } catch (error) {
      vscode.window.showErrorMessage(localizeGroupOverviewError(args, error));
    }
  };

  return { openGroupOverview };
}

async function buildGroupOverviewData(
  args: Parameters<typeof createGroupOverviewTools>[0],
  side: TreeSide,
  agentFilter: ToolType | "mixed" | null,
  groupFilterId: string | null
): Promise<GroupOverviewData> {
  const history = await args.loadCentralSkillHistory();
  const sourceFiles = side === "workspace" ? args.state.workspaceSkills : args.state.centralSkills;
  const basePath = side === "workspace" ? args.state.workspacePath : args.state.centralRepoPath;
  const groups = args.state.groups
    .filter((group) => group.side === side)
    .filter((group) => !groupFilterId || group.id === groupFilterId);

  const overviewGroups = await Promise.all(groups.map(async (group) => {
    const selections = args.targetsToSelections(sourceFiles, group.targets);
    const targets = await Promise.all(selections.map((selection) =>
      buildTargetRow(basePath, side, selection, history, args.tr)
    ));
    const brokenTargetCount = estimateBrokenTargetCount(group, targets);
    const latestUpdatedAt = maxIso(targets.map((target) => target.updatedAt));
    const latestHistoryAt = maxIso(targets.map((target) => target.historyAt));
    return {
      id: group.id,
      name: group.name,
      description: group.description ?? "",
      side: group.side,
      agent: args.getGroupTool(group) ?? "mixed",
      source: group.meta?.source ?? "manual",
      sourceDetail: sourceDetail(group.meta, args.tr),
      syncStatus: getGroupSyncStatus(group, args.state.groups),
      health: brokenTargetCount > 0 ? "brokenTargets" as const : group.description?.trim() ? "ready" as const : "needsDescription" as const,
      brokenTargetCount,
      targets: targets.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.path.localeCompare(right.path)),
      targetCount: group.targets.length,
      availableTargetCount: targets.length,
      npxUpdateAvailable: canUpdateNpxGroup(group),
      latestUpdatedAt,
      latestHistoryAt
    };
  }));

  overviewGroups.sort((left, right) =>
    right.latestUpdatedAt.localeCompare(left.latestUpdatedAt) || left.agent.localeCompare(right.agent) || left.name.localeCompare(right.name)
  );

  const byAgent = new Map<ToolType | "mixed", GroupOverviewGroup[]>();
  for (const group of overviewGroups) {
    const bucket = byAgent.get(group.agent) ?? [];
    bucket.push(group);
    byAgent.set(group.agent, bucket);
  }
  const agents = [...byAgent.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([agent, agentGroups]) => ({ agent, groups: agentGroups }));

  return { side, agentFilter, groups: overviewGroups, agents };
}

async function buildTargetRow(
  basePath: string,
  side: TreeSide,
  selection: SkillSelection,
  history: CentralSkillHistoryFile,
  tr: TranslationFn
): Promise<GroupOverviewTarget> {
  const relativePath = normalizeRel(selection.relativePath);
  const key = `${selection.tool}:${relativePath}`;
  const record = history.records[key];
  if (!isManagedSkillPath(relativePath)) {
    return {
      path: `${selection.tool}/${relativePath || "-"}`,
      kind: tr("Unavailable"),
      description: tr("This group target is not under skills/ and was skipped safely."),
      updatedAt: "-",
      historyAt: record?.lastUpdatedAt ?? "-",
      historyProject: record?.lastSourceProjectPath ?? tr("No history")
    };
  }
  const absolutePath = (() => {
    try {
      return resolveSkillPath(basePath, selection.tool, relativePath, side);
    } catch {
      return null;
    }
  })();
  if (!absolutePath) {
    return {
      path: `${selection.tool}/${relativePath}`,
      kind: tr("Unavailable"),
      description: tr("This group target path could not be resolved safely."),
      updatedAt: "-",
      historyAt: record?.lastUpdatedAt ?? "-",
      historyProject: record?.lastSourceProjectPath ?? tr("No history")
    };
  }
  const stat = await fs.stat(absolutePath).catch(() => null);
  const description = /\/SKILL\.md$/i.test(relativePath)
    ? await readSkillDescription(absolutePath)
    : "";
  return {
    path: `${selection.tool}/${relativePath}`,
    kind: /\/SKILL\.md$/i.test(relativePath) ? "SKILL.md" : tr("File"),
    description,
    updatedAt: stat ? stat.mtime.toISOString() : "-",
    historyAt: record?.lastUpdatedAt ?? "-",
    historyProject: record?.lastSourceProjectPath ?? tr("No history")
  };
}

async function readSkillDescription(skillMdPath: string): Promise<string> {
  const raw = await fs.readFile(skillMdPath, "utf8").catch(() => "");
  if (!raw.trim()) return "";
  const lines = raw.split(/\r?\n/);
  const explicit = lines.find((line) => /^description\s*:/i.test(line.trim()));
  if (explicit) return explicit.replace(/^description\s*:/i, "").trim();
  const firstParagraph = lines
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#") && !line.startsWith("---") && !line.startsWith("|"));
  return firstParagraph ?? "";
}
function isEditGroupMessage(message: unknown): message is { type: "editGroup"; groupId: string; name: string; description: string } {
  if (!message || typeof message !== "object") return false;
  const record = message as Record<string, unknown>;
  return record.type === "editGroup"
    && typeof record.groupId === "string"
    && typeof record.name === "string"
    && typeof record.description === "string";
}
function isTransferGroupMessage(message: unknown): message is { type: "transferGroup"; groupId: string; mode: "withSkills" | "groupOnly" } {
  if (!message || typeof message !== "object") return false;
  const record = message as Record<string, unknown>;
  return record.type === "transferGroup"
    && typeof record.groupId === "string"
    && (record.mode === "withSkills" || record.mode === "groupOnly");
}
function isInstallNpxMessage(message: unknown): message is { type: "installNpx"; side: TreeSide } {
  if (!message || typeof message !== "object") return false;
  const record = message as Record<string, unknown>;
  return record.type === "installNpx"
    && (record.side === "workspace" || record.side === "central");
}
function isUpdateNpxGroupMessage(message: unknown): message is { type: "updateNpxGroup"; groupId: string } {
  if (!message || typeof message !== "object") return false;
  const record = message as Record<string, unknown>;
  return record.type === "updateNpxGroup" && typeof record.groupId === "string";
}
function isAddSkillsToGroupsMessage(message: unknown): message is { type: "addSkillsToGroups"; groupIds: string[] } {
  if (!message || typeof message !== "object") return false;
  const record = message as Record<string, unknown>;
  return record.type === "addSkillsToGroups" && Array.isArray(record.groupIds) && record.groupIds.every((id) => typeof id === "string");
}
function isTransferGroupsMessage(message: unknown): message is { type: "transferGroups"; groupIds: string[]; mode: "withSkills" | "groupOnly" } {
  if (!message || typeof message !== "object") return false;
  const record = message as Record<string, unknown>;
  return record.type === "transferGroups" && Array.isArray(record.groupIds) && record.groupIds.every((id) => typeof id === "string") && (record.mode === "withSkills" || record.mode === "groupOnly");
}
function isAddSkillsMessage(message: unknown): message is { type: "addSkills"; groupId: string } {
  if (!message || typeof message !== "object") return false;
  const record = message as Record<string, unknown>;
  return record.type === "addSkills" && typeof record.groupId === "string";
}
function isRemoveSkillsMessage(message: unknown): message is { type: "removeSkills"; groupId: string; targets: LibraryTarget[] } {
  if (!message || typeof message !== "object") return false;
  const record = message as Record<string, unknown>;
  return record.type === "removeSkills"
    && typeof record.groupId === "string"
    && Array.isArray(record.targets)
    && record.targets.every(isLibraryTarget);
}
function isLibraryTarget(value: unknown): value is LibraryTarget {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return isToolType(record.tool)
    && typeof record.relativePath === "string"
    && (record.kind === "file" || record.kind === "folder");
}

function isToolType(value: unknown): value is ToolType {
  return typeof value === "string" && (ALL_AGENTS as readonly string[]).includes(value);
}

function findGroupOrThrow(
  args: Parameters<typeof createGroupOverviewTools>[0],
  groupId: string,
  message: string
): SelectionGroup {
  const group = args.state.groups.find((item) => item.id === groupId);
  if (!group) throw new Error(message);
  return group;
}

async function addSkillsToGroup(
  args: Parameters<typeof createGroupOverviewTools>[0],
  group: SelectionGroup
): Promise<void> {
  const groupTool = args.getGroupTool(group);
  if (!groupTool || groupTool === "mixed") {
    throw new Error(args.tr("Choose a single-agent group before adding skills."));
  }
  const candidates = getAvailableSkillFolderTargets(args, group, groupTool);
  if (candidates.length === 0) {
    vscode.window.showInformationMessage(args.tr("No ungrouped skills are available for this group."));
    return;
  }
  const picks = await vscode.window.showQuickPick(
    candidates.map((target) => ({
      label: skillNameFromRelativePath(target.relativePath),
      description: `${target.tool}/${target.relativePath}`,
      value: target
    })),
    {
      canPickMany: true,
      title: args.tr("Add skills to \"{0}\"", String(group.name)),
      placeHolder: args.tr("Choose one or more skill folders.")
    }
  );
  if (!picks || picks.length === 0) return;
  const result = await args.assignTargetsToGroupMany(group.side, group.id, picks.map((pick) => pick.value));
  await markGroupMixedIfNeeded(args, group);
  const skipped = result.skippedCount > 0 ? args.tr(" · skipped {0}", String(result.skippedCount)) : "";
  vscode.window.showInformationMessage(args.tr("Added {0} skill(s) to {1}{2}", String(result.affectedCount), String(group.name), String(skipped)));
}

async function addSkillsToGroups(args: Parameters<typeof createGroupOverviewTools>[0], groupIds: string[]): Promise<void> {
  const groups = groupIds.map((id) => args.state.groups.find((group) => group.id === id)).filter((group): group is SelectionGroup => !!group);
  if (groups.length === 0) throw new Error(args.tr("Select one or more groups first."));
  const tools = [...new Set(groups.map((group) => args.getGroupTool(group)))];
  if (tools.length !== 1 || !tools[0] || tools[0] === "mixed") throw new Error(args.tr("Select groups from one agent before adding skills."));
  const candidates = getAvailableSkillFolderTargetsForGroups(args, groups, tools[0]);
  if (candidates.length === 0) {
    vscode.window.showInformationMessage(args.tr("No available skills can be added to the selected groups."));
    return;
  }
  const picks = await vscode.window.showQuickPick(candidates.map((target) => ({ label: skillNameFromRelativePath(target.relativePath), description: `${target.tool}/${target.relativePath}`, value: target })), { canPickMany: true, title: args.tr("Add skills to {0} group(s)", String(groups.length)), placeHolder: args.tr("Choose one or more skill folders to add to every selected group.") });
  if (!picks || picks.length === 0) return;
  let affected = 0;
  let skipped = 0;
  for (const group of groups) {
    const result = await args.assignTargetsToGroupMany(group.side, group.id, picks.map((pick) => pick.value));
    await markGroupMixedIfNeeded(args, group);
    affected += result.affectedCount;
    skipped += result.skippedCount;
  }
  vscode.window.showInformationMessage(args.tr("Added skills to {0} group(s): added {1}, skipped {2}", String(groups.length), String(affected), String(skipped)));
}

async function transferGroups(args: Parameters<typeof createGroupOverviewTools>[0], groupIds: string[], mode: "withSkills" | "groupOnly"): Promise<void> {
  const groups = groupIds.map((id) => args.state.groups.find((group) => group.id === id)).filter((group): group is SelectionGroup => !!group);
  if (groups.length === 0) throw new Error(args.tr("Select one or more groups first."));
  let changed = 0;
  for (const group of groups) {
    if (mode === "groupOnly" && await args.mirrorGroupToOtherSide(group, { requireExistingTargets: false })) changed += 1;
    if (mode === "withSkills") {
      const result = await args.exportGroup(group.side, group, { skipConfirm: true, skipNotify: true, skipRefresh: true });
      if (result && result.copied + result.deleted > 0) changed += 1;
    }
  }
  await args.refresh();
  vscode.window.showInformationMessage(args.tr("Selected group action complete: {0}/{1} changed", String(changed), String(groups.length)));
}

async function removeSkillsFromGroup(
  args: Parameters<typeof createGroupOverviewTools>[0],
  group: SelectionGroup,
  targets: LibraryTarget[]
): Promise<void> {
  if (targets.length === 0) {
    vscode.window.showWarningMessage(args.tr("Select skills in the group detail first."));
    return;
  }
  const currentSkillFolders = new Set(group.targets.map((target) => `${target.tool}:${normalizeRel(skillFolderRelativePath(target.relativePath))}`).filter((key) => !key.endsWith(":")));
  const selectedSkillFolders = new Set(targets.map((target) => `${target.tool}:${normalizeRel(skillFolderRelativePath(target.relativePath))}`).filter((key) => !key.endsWith(":")));
  if (currentSkillFolders.size > 0 && selectedSkillFolders.size >= currentSkillFolders.size) {
    vscode.window.showWarningMessage(args.tr("This would leave the group empty. Delete the group instead if needed."));
    return;
  }
  const ok = await vscode.window.showWarningMessage(
    args.tr("Remove {0} skill folder(s) from group \"{1}\"? Skill files are not deleted.", String(targets.length), String(group.name)),
    { modal: true },
    args.tr("Remove")
  );
  if (ok !== args.tr("Remove")) return;
  const result = await args.unassignTargetsFromGroupMany(group.side, group.id, targets);
  await markGroupMixedIfNeeded(args, group);
  const skipped = result.skippedCount > 0 ? args.tr(" · skipped {0}", String(result.skippedCount)) : "";
  vscode.window.showInformationMessage(args.tr("Removed {0} skill(s) from {1}{2}", String(result.affectedCount), String(group.name), String(skipped)));
}

function localizeGroupOverviewError(args: Parameters<typeof createGroupOverviewTools>[0], error: unknown): string {
  const message = args.toUserError(error);
  return message === "This would leave the group empty. Delete the group instead if needed."
    ? args.tr("This would leave the group empty. Delete the group instead if needed.")
    : message;
}

function getAvailableSkillFolderTargets(
  args: Parameters<typeof createGroupOverviewTools>[0],
  group: SelectionGroup,
  groupTool: ToolType
): LibraryTarget[] {
  const files = group.side === "workspace" ? args.state.workspaceSkills : args.state.centralSkills;
  const existing = new Set(group.targets.map((target) => `${target.tool}:${normalizeRel(skillFolderRelativePath(target.relativePath))}`));
  const byFolder = new Map<string, LibraryTarget>();
  for (const file of files) {
    if (file.tool !== groupTool) continue;
    const folderRel = skillFolderRelativePath(file.relativePath);
    if (!folderRel || !isManagedSkillPath(folderRel)) continue;
    const key = `${file.tool}:${folderRel}`;
    if (existing.has(key)) continue;
    byFolder.set(key, { tool: file.tool, relativePath: folderRel, kind: "folder" });
  }
  return [...byFolder.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function getAvailableSkillFolderTargetsForGroups(args: Parameters<typeof createGroupOverviewTools>[0], groups: SelectionGroup[], groupTool: ToolType): LibraryTarget[] {
  const files = groups[0]?.side === "central" ? args.state.centralSkills : args.state.workspaceSkills;
  const fullyExisting = new Set<string>();
  for (const group of groups) {
    for (const target of group.targets) fullyExisting.add(`${group.id}:${target.tool}:${normalizeRel(skillFolderRelativePath(target.relativePath))}`);
  }
  const byFolder = new Map<string, LibraryTarget>();
  for (const file of files) {
    if (file.tool !== groupTool) continue;
    const folderRel = skillFolderRelativePath(file.relativePath);
    if (folderRel && isManagedSkillPath(folderRel) && !groups.every((group) => fullyExisting.has(`${group.id}:${file.tool}:${folderRel}`))) {
      byFolder.set(`${file.tool}:${folderRel}`, { tool: file.tool, relativePath: folderRel, kind: "folder" });
    }
  }
  return [...byFolder.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function markGroupMixedIfNeeded(
  args: Parameters<typeof createGroupOverviewTools>[0],
  group: SelectionGroup
): Promise<void> {
  if (group.meta?.source !== "npx") return;
  const nextGroups = args.state.groups.map((item) =>
    item.id === group.id ? { ...item, meta: { ...item.meta, source: "mixed" as const } } : item
  );
  await args.persistGroups(nextGroups, group.id, { skipExistenceValidation: true });
}

function normalizeGroupContextNode(value: unknown): GroupTreeNode | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (isGroupTreeNode(record)) return record;
  if (record.node && typeof record.node === "object") {
    const nodeRecord = record.node as Record<string, unknown>;
    if (nodeRecord.kind === "groupRoot" || nodeRecord.kind === "groupTool" || nodeRecord.kind === "group") {
      const side = nodeRecord.side === "central" ? "central" : "workspace";
      const kind = nodeRecord.kind === "groupRoot" ? "root" : nodeRecord.kind === "groupTool" ? "tool" : "group";
      return {
        id: typeof nodeRecord.groupId === "string" ? nodeRecord.groupId : typeof nodeRecord.key === "string" ? nodeRecord.key : "",
        kind,
        side,
        label: typeof nodeRecord.label === "string" ? nodeRecord.label : "",
        count: typeof nodeRecord.count === "number" ? nodeRecord.count : 0,
        tool: typeof nodeRecord.tool === "string" ? nodeRecord.tool as ToolType : undefined
      };
    }
  }
  return null;
}

function isGroupTreeNode(record: Record<string, unknown>): record is GroupTreeNode {
  return (record.kind === "root" || record.kind === "tool" || record.kind === "group")
    && (record.side === "workspace" || record.side === "central")
    && typeof record.label === "string"
    && typeof record.count === "number";
}

function maxIso(values: string[]): string {
  const valid = values.filter((value) => value && value !== "-");
  return valid.length > 0 ? valid.sort((left, right) => right.localeCompare(left))[0] : "-";
}

function estimateBrokenTargetCount(group: SelectionGroup, targets: GroupOverviewTarget[]): number {
  const unavailable = targets.filter((target) => target.kind === "Unavailable" || target.kind === localize("Unavailable")).length;
  if (unavailable > 0) return unavailable;
  return group.targets.length > 0 && targets.length === 0 ? group.targets.length : 0;
}

function getGroupSyncStatus(
  group: SelectionGroup,
  groups: SelectionGroup[]
): GroupOverviewGroup["syncStatus"] {
  const targetSide: TreeSide = group.side === "workspace" ? "central" : "workspace";
  const mirrorKey = `${group.side}:${group.id}`;
  const counterpart = groups.find((item) => item.side === targetSide && item.meta?.mirroredFrom === mirrorKey)
    ?? groups.find((item) =>
      item.side === targetSide
      && item.name.trim().toLowerCase() === group.name.trim().toLowerCase()
      && getGroupTargetTool(item) === getGroupTargetTool(group)
    );
  if (!counterpart) return group.side === "workspace" ? "workspaceOnly" : "centralOnly";
  return groupTargetSetKey(group.targets) === groupTargetSetKey(counterpart.targets) ? "same" : "different";
}

function getGroupTargetTool(group: SelectionGroup): ToolType | null {
  const tools = [...new Set(group.targets.map((target) => target.tool))];
  return tools.length === 1 ? tools[0] ?? null : null;
}

function groupTargetSetKey(targets: GroupTarget[]): string {
  return targets
    .map((target) => `${target.tool}:${target.kind}:${normalizeRel(skillFolderRelativePath(target.relativePath))}`)
    .sort()
    .join("|");
}

