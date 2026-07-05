import { promises as fs } from "node:fs";
import * as vscode from "vscode";
import { resolveSkillPath } from "./skillPaths";
import { isManagedSkillPath, normalizeRel } from "./extensionSupport";
import type { CentralSkillHistoryFile } from "./extensionHistoryTools";
import { healthLabel, renderBadge, sideLabel, sourceDetail, sourceLabel, syncLabel } from "./groupOverviewLabels";
import { renderGroupOverviewStyles } from "./groupOverviewStyles";
import { ALL_AGENTS, type GroupTreeNode, type GroupTarget, type SelectionGroup, type SkillFile, type SkillSelection, type ToolType } from "./types";
import type { UiLanguage } from "./uiLanguage";
import type { GroupMutationSummary, LibraryTarget } from "./libraryManagerTypes";
type TranslationFn = (english: string, korean: string) => string;
type TreeSide = "workspace" | "central";

type GroupOverviewTarget = {
  path: string;
  kind: string;
  description: string;
  updatedAt: string;
  historyAt: string;
  historyProject: string;
};

type GroupOverviewSkillFolder = {
  name: string;
  path: string;
  relativePath: string;
  tool: ToolType;
  files: GroupOverviewTarget[];
  latestUpdatedAt: string;
  latestHistoryAt: string;
  description: string;
};

type GroupOverviewGroup = {
  id: string;
  name: string;
  description: string;
  side: TreeSide;
  agent: ToolType | "mixed";
  source: "manual" | "npx" | "mixed";
  sourceDetail: string;
  syncStatus: "same" | "workspaceOnly" | "centralOnly" | "different";
  health: "ready" | "needsDescription" | "brokenTargets";
  brokenTargetCount: number;
  targets: GroupOverviewTarget[];
  targetCount: number;
  latestUpdatedAt: string;
  latestHistoryAt: string;
};

type GroupOverviewAgent = {
  agent: ToolType | "mixed";
  groups: GroupOverviewGroup[];
};

type GroupOverviewData = {
  side: TreeSide;
  agentFilter: ToolType | "mixed" | null;
  groups: GroupOverviewGroup[];
  agents: GroupOverviewAgent[];
};

export function createGroupOverviewTools(args: {
  tr: TranslationFn;
  getUiLanguage: () => UiLanguage;
  refresh: () => Promise<void>;
  registerLanguageRefresh: (panel: vscode.WebviewPanel, render: () => void | Promise<void>) => void;
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
        args.tr("Group Overview", "그룹 개요"),
        vscode.ViewColumn.Active,
        { enableScripts: true }
      );

      const render = async (): Promise<void> => {
        const data = await buildGroupOverviewData(args, side, agentFilter, groupFilterId);
        panel.title = args.tr(
          `Group Overview: ${side}${agentFilter ? `/${agentFilter}` : ""}`,
          `그룹 개요: ${side}${agentFilter ? `/${agentFilter}` : ""}`
        );
        panel.webview.html = renderGroupOverviewHtml(panel.webview, data, args.getUiLanguage());
      };

      panel.webview.onDidReceiveMessage(async (message: unknown) => {
        try {
          if (isEditGroupMessage(message)) {
            const group = findGroupOrThrow(args, message.groupId, args.tr("Could not find the group to edit.", "편집할 그룹을 찾지 못했습니다."));
            const name = message.name.trim();
            if (!name) throw new Error(args.tr("Group name is required.", "그룹 이름은 필수입니다."));
            const groupTool = args.getGroupTool(group);
            if (!groupTool || groupTool === "mixed") {
              throw new Error(args.tr("Mixed-agent groups cannot be renamed in this view.", "여러 에이전트가 섞인 그룹은 이 화면에서 이름을 바꿀 수 없습니다."));
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
            vscode.window.setStatusBarMessage(args.tr(`Group updated: ${name}`, `그룹 수정 완료: ${name}`), 2000);
          } else if (isTransferGroupMessage(message)) {
            const group = findGroupOrThrow(args, message.groupId, args.tr("Could not find the group to transfer.", "전송할 그룹을 찾지 못했습니다."));
            if (message.mode === "groupOnly") {
              const ok = await vscode.window.showWarningMessage(
                args.tr(
                  `Create/update only the group "${group.name}" on the opposite side? Skill files will not be copied.`,
                  `반대편에 그룹 "${group.name}" 정보만 만들거나 갱신할까요? 스킬 파일은 복사하지 않습니다.`
                ),
                { modal: true },
                args.tr("Continue", "진행")
              );
              if (ok !== args.tr("Continue", "진행")) {
                await render();
                return;
              }
              const mirrored = await args.mirrorGroupToOtherSide(group, { requireExistingTargets: false });
              vscode.window.setStatusBarMessage(
                mirrored
                  ? args.tr(`Group metadata mirrored: ${group.name}`, `그룹 정보 복제 완료: ${group.name}`)
                  : args.tr(`No group targets to mirror: ${group.name}`, `복제할 그룹 대상 없음: ${group.name}`),
                2500
              );
            } else {
              await args.exportGroup(group.side, group);
            }
            await args.refresh();
          } else if (isInstallNpxMessage(message)) {
            await args.installSkillsForSide(message.side);
            await args.refresh();
          } else if (isAddSkillsToGroupsMessage(message)) {
            await addSkillsToGroups(args, message.groupIds);
          } else if (isTransferGroupsMessage(message)) {
            await transferGroups(args, message.groupIds, message.mode);
          } else if (isAddSkillsMessage(message)) {
            const group = findGroupOrThrow(args, message.groupId, args.tr("Could not find the group to update.", "수정할 그룹을 찾지 못했습니다."));
            await addSkillsToGroup(args, group);
          } else if (isRemoveSkillsMessage(message)) {
            const group = findGroupOrThrow(args, message.groupId, args.tr("Could not find the group to update.", "수정할 그룹을 찾지 못했습니다."));
            await removeSkillsFromGroup(args, group, message.targets);
          } else if (!!message && typeof message === "object" && (message as Record<string, unknown>).type === "toggleLanguage") {
            await vscode.commands.executeCommand("skillBridge.toggleLanguage");
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
      args.registerLanguageRefresh(panel, render);
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
      kind: tr("Unavailable", "확인 불가"),
      description: tr("This group target is not under skills/ and was skipped safely.", "이 그룹 대상은 skills/ 하위 경로가 아니라 안전하게 건너뛰었습니다."),
      updatedAt: "-",
      historyAt: record?.lastUpdatedAt ?? "-",
      historyProject: record?.lastSourceProjectPath ?? tr("No history", "기록 없음")
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
      kind: tr("Unavailable", "확인 불가"),
      description: tr("This group target path could not be resolved safely.", "이 그룹 대상 경로를 안전하게 해석할 수 없습니다."),
      updatedAt: "-",
      historyAt: record?.lastUpdatedAt ?? "-",
      historyProject: record?.lastSourceProjectPath ?? tr("No history", "기록 없음")
    };
  }
  const stat = await fs.stat(absolutePath).catch(() => null);
  const description = /\/SKILL\.md$/i.test(relativePath)
    ? await readSkillDescription(absolutePath)
    : "";
  return {
    path: `${selection.tool}/${relativePath}`,
    kind: /\/SKILL\.md$/i.test(relativePath) ? "SKILL.md" : tr("File", "파일"),
    description,
    updatedAt: stat ? stat.mtime.toISOString() : "-",
    historyAt: record?.lastUpdatedAt ?? "-",
    historyProject: record?.lastSourceProjectPath ?? tr("No history", "기록 없음")
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
    throw new Error(args.tr("Choose a single-agent group before adding skills.", "스킬을 추가하려면 단일 에이전트 그룹을 선택하세요."));
  }
  const candidates = getAvailableSkillFolderTargets(args, group, groupTool);
  if (candidates.length === 0) {
    vscode.window.showInformationMessage(args.tr("No ungrouped skills are available for this group.", "이 그룹에 추가할 수 있는 미등록 스킬이 없습니다."));
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
      title: args.tr(`Add skills to "${group.name}"`, `"${group.name}"에 스킬 추가`),
      placeHolder: args.tr("Choose one or more skill folders.", "추가할 스킬 폴더를 하나 이상 선택하세요.")
    }
  );
  if (!picks || picks.length === 0) return;
  const result = await args.assignTargetsToGroupMany(group.side, group.id, picks.map((pick) => pick.value));
  await markGroupMixedIfNeeded(args, group);
  const skipped = result.skippedCount > 0 ? args.tr(` · skipped ${result.skippedCount}`, ` · 제외 ${result.skippedCount}개`) : "";
  vscode.window.showInformationMessage(args.tr(
    `Added ${result.affectedCount} skill(s) to ${group.name}${skipped}`,
    `${group.name}에 스킬 ${result.affectedCount}개 추가 완료${skipped}`
  ));
}

async function addSkillsToGroups(args: Parameters<typeof createGroupOverviewTools>[0], groupIds: string[]): Promise<void> {
  const groups = groupIds.map((id) => args.state.groups.find((group) => group.id === id)).filter((group): group is SelectionGroup => !!group);
  if (groups.length === 0) throw new Error(args.tr("Select one or more groups first.", "먼저 그룹을 하나 이상 선택하세요."));
  const tools = [...new Set(groups.map((group) => args.getGroupTool(group)))];
  if (tools.length !== 1 || !tools[0] || tools[0] === "mixed") throw new Error(args.tr("Select groups from one agent before adding skills.", "스킬을 추가하려면 같은 에이전트의 그룹만 선택하세요."));
  const candidates = getAvailableSkillFolderTargetsForGroups(args, groups, tools[0]);
  if (candidates.length === 0) {
    vscode.window.showInformationMessage(args.tr("No available skills can be added to the selected groups.", "선택한 그룹에 추가할 수 있는 스킬이 없습니다."));
    return;
  }
  const picks = await vscode.window.showQuickPick(candidates.map((target) => ({ label: skillNameFromRelativePath(target.relativePath), description: `${target.tool}/${target.relativePath}`, value: target })), { canPickMany: true, title: args.tr(`Add skills to ${groups.length} group(s)`, `그룹 ${groups.length}개에 스킬 추가`), placeHolder: args.tr("Choose one or more skill folders to add to every selected group.", "선택한 모든 그룹에 추가할 스킬 폴더를 고르세요.") });
  if (!picks || picks.length === 0) return;
  let affected = 0;
  let skipped = 0;
  for (const group of groups) {
    const result = await args.assignTargetsToGroupMany(group.side, group.id, picks.map((pick) => pick.value));
    await markGroupMixedIfNeeded(args, group);
    affected += result.affectedCount;
    skipped += result.skippedCount;
  }
  vscode.window.showInformationMessage(args.tr(`Added skills to ${groups.length} group(s): added ${affected}, skipped ${skipped}`, `그룹 ${groups.length}개에 스킬 추가 완료: 추가 ${affected}개, 제외 ${skipped}개`));
}

async function transferGroups(args: Parameters<typeof createGroupOverviewTools>[0], groupIds: string[], mode: "withSkills" | "groupOnly"): Promise<void> {
  const groups = groupIds.map((id) => args.state.groups.find((group) => group.id === id)).filter((group): group is SelectionGroup => !!group);
  if (groups.length === 0) throw new Error(args.tr("Select one or more groups first.", "먼저 그룹을 하나 이상 선택하세요."));
  let changed = 0;
  for (const group of groups) {
    if (mode === "groupOnly" && await args.mirrorGroupToOtherSide(group, { requireExistingTargets: false })) changed += 1;
    if (mode === "withSkills") {
      const result = await args.exportGroup(group.side, group, { skipConfirm: true, skipNotify: true, skipRefresh: true });
      if (result && result.copied + result.deleted > 0) changed += 1;
    }
  }
  await args.refresh();
  vscode.window.showInformationMessage(args.tr(`Selected group action complete: ${changed}/${groups.length} changed`, `선택 그룹 작업 완료: ${groups.length}개 중 ${changed}개 변경`));
}

async function removeSkillsFromGroup(
  args: Parameters<typeof createGroupOverviewTools>[0],
  group: SelectionGroup,
  targets: LibraryTarget[]
): Promise<void> {
  if (targets.length === 0) {
    vscode.window.showWarningMessage(args.tr("Select skills in the group detail first.", "먼저 그룹 상세에서 제거할 스킬을 선택하세요."));
    return;
  }
  const currentSkillFolders = new Set(group.targets.map((target) => `${target.tool}:${normalizeRel(skillFolderRelativePath(target.relativePath))}`).filter((key) => !key.endsWith(":")));
  const selectedSkillFolders = new Set(targets.map((target) => `${target.tool}:${normalizeRel(skillFolderRelativePath(target.relativePath))}`).filter((key) => !key.endsWith(":")));
  if (currentSkillFolders.size > 0 && selectedSkillFolders.size >= currentSkillFolders.size) {
    vscode.window.showWarningMessage(args.tr(
      "This would leave the group empty. Delete the group instead if needed.",
      "그룹이 비게 됩니다. 필요하면 그룹 삭제를 사용하세요."
    ));
    return;
  }
  const ok = await vscode.window.showWarningMessage(
    args.tr(
      `Remove ${targets.length} skill folder(s) from group "${group.name}"? Skill files are not deleted.`,
      `그룹 "${group.name}"에서 스킬 폴더 ${targets.length}개를 제거할까요? 스킬 파일은 삭제되지 않습니다.`
    ),
    { modal: true },
    args.tr("Remove", "제거")
  );
  if (ok !== args.tr("Remove", "제거")) return;
  const result = await args.unassignTargetsFromGroupMany(group.side, group.id, targets);
  await markGroupMixedIfNeeded(args, group);
  const skipped = result.skippedCount > 0 ? args.tr(` · skipped ${result.skippedCount}`, ` · 제외 ${result.skippedCount}개`) : "";
  vscode.window.showInformationMessage(args.tr(
    `Removed ${result.affectedCount} skill(s) from ${group.name}${skipped}`,
    `${group.name}에서 스킬 ${result.affectedCount}개 제거 완료${skipped}`
  ));
}

function localizeGroupOverviewError(args: Parameters<typeof createGroupOverviewTools>[0], error: unknown): string {
  const message = args.toUserError(error);
  return message === "This would leave the group empty. Delete the group instead if needed." ? args.tr(message, "그룹이 비게 됩니다. 필요하면 그룹 삭제를 사용하세요.") : message;
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
  const unavailable = targets.filter((target) => target.kind === "Unavailable" || target.kind === "확인 불가").length;
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

function renderGroupOverviewHtml(webview: vscode.Webview, data: GroupOverviewData, language: UiLanguage): string {
  void webview;
  const isKo = language === "ko";
  const t = (english: string, korean: string): string => isKo ? korean : english;
  const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const activeAgent = data.agentFilter ?? "all";
  const agentButtons = [`<button class="chip ${activeAgent === "all" ? "active" : ""}" data-agent-filter="all" type="button">All</button>`, ...data.agents.map((agent) => `<button class="chip ${activeAgent === agent.agent ? "active" : ""}" data-agent-filter="${escAttr(agent.agent)}" type="button">${esc(formatAgent(agent.agent))}</button>`)].join("");
  const groupsForView = data.agents.flatMap((agent) => agent.groups);
  const selectedGroupId = groupsForView[0]?.id ?? "";
  const groupRows = groupsForView.map((group, index) => renderGroupRow(group, t, index === 0)).join("");
  const groupDetails = groupsForView.map((group, index) => renderGroupCard(group, t, index === 0)).join("");

  return `<!doctype html>
<html lang="${language}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(t("Group Overview", "그룹 개요"))}</title>
  <style>${renderGroupOverviewStyles()}</style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <h1>${esc(t("Group Overview", "그룹 개요"))}: ${esc(data.side)}${data.agentFilter ? ` / ${esc(data.agentFilter)}` : ""}</h1>
      <div class="top-actions">
        <div id="summary" class="summary">${data.groups.length} ${esc(t("groups", "그룹"))}</div>
        <button id="languageToggle" type="button">${esc(isKo ? "English" : "한국어")}</button>
      </div>
    </div>
    <div class="controls">
      <div class="toolbar">
        <input id="search" placeholder="${esc(t("Search agent, group, skill, or description...", "에이전트, 그룹, 스킬, 설명 검색..."))}" />
        <button id="expandAll">${esc(t("Expand all", "모두 펼치기"))}</button>
        <button id="collapseAll">${esc(t("Collapse all", "모두 접기"))}</button>
      </div>
      <div class="batch-actions">
        <span id="selectedGroupCount" class="summary">${esc(t("No groups selected", "선택 그룹 없음"))}</span>
        <button id="batchAddSkills" type="button">${esc(t("Add skills to selected groups", "선택 그룹에 스킬 추가"))}</button>
        <button id="batchTransferWithSkills" class="primary" type="button">${esc(t("Transfer selected groups + skills", "선택 그룹+스킬 전송"))}</button>
        <button id="batchTransferGroupOnly" type="button">${esc(t("Transfer selected groups only", "선택 그룹만 전송"))}</button>
      </div>
    </div>
    <div id="agentFilter" class="agent-filter">
      ${agentButtons}
    </div>
    <main class="content">
      <section class="group-list">
        <table>
          <thead>
            <tr>
              <th style="width: 96px;">${esc(t("Agent", "에이전트"))}</th>
              <th class="group-check"><input id="toggleGroups" type="checkbox" title="${escAttr(t("Select visible groups", "보이는 그룹 선택"))}" /></th>
              <th>${esc(t("Group", "그룹"))}</th>
              <th style="width: 96px;">${esc(t("Side", "위치"))}</th>
              <th style="width: 96px;">${esc(t("Source", "출처"))}</th>
              <th style="width: 94px;">${esc(t("Sync", "동기화"))}</th>
              <th style="width: 82px;">${esc(t("Skills", "스킬"))}</th>
              <th style="width: 180px;">${esc(t("Latest file", "최신 파일"))}</th>
            </tr>
          </thead>
          <tbody>${groupRows || `<tr><td colspan="8">${esc(t("No groups to show.", "표시할 그룹이 없습니다."))}</td></tr>`}</tbody>
        </table>
      </section>
      <section class="detail-shell">
        ${groupDetails || `<div class="empty">${esc(t("Select a group to inspect.", "살펴볼 그룹을 선택하세요."))}</div>`}
      </section>
    </main>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const search = document.getElementById("search");
    const summary = document.getElementById("summary");
    const agentFilter = document.getElementById("agentFilter");
    const rows = Array.from(document.querySelectorAll(".group-row"));
    const details = Array.from(document.querySelectorAll(".group-detail"));
    let activeGroup = "${esc(selectedGroupId)}";
    const activeAgents = new Set("${esc(activeAgent)}" === "all" ? [] : ["${esc(activeAgent)}"]);
    let busy = false;
    const selectedGroupCount = document.getElementById("selectedGroupCount");
    const toggleGroups = document.getElementById("toggleGroups");
    function selectedGroupIds() { return Array.from(document.querySelectorAll(".group-row:not(.hidden) input[data-group-select]:checked")).map((item) => item.getAttribute("data-group-select") || "").filter(Boolean); }
    function syncBatchState() {
      const ids = selectedGroupIds();
      if (selectedGroupCount) selectedGroupCount.textContent = ids.length === 0 ? "${esc(t("No groups selected", "선택 그룹 없음"))}" : ids.length + " ${esc(t("groups selected", "개 그룹 선택"))}";
      document.querySelectorAll("#batchAddSkills,#batchTransferWithSkills,#batchTransferGroupOnly").forEach((item) => { if (item instanceof HTMLButtonElement) item.disabled = ids.length === 0; });
      const visibleChecks = Array.from(document.querySelectorAll(".group-row:not(.hidden) input[data-group-select]"));
      if (toggleGroups instanceof HTMLInputElement) {
        toggleGroups.checked = visibleChecks.length > 0 && visibleChecks.every((item) => item instanceof HTMLInputElement && item.checked);
        toggleGroups.indeterminate = visibleChecks.some((item) => item instanceof HTMLInputElement && item.checked) && !toggleGroups.checked;
      }
    }
    function postAction(message, button) { if (busy) return; busy = true; document.querySelectorAll("button").forEach((item) => { item.disabled = true; }); vscode.postMessage(message); }
    function applySearch() {
      const q = search instanceof HTMLInputElement ? search.value.trim().toLowerCase() : "";
      let visible = 0;
      let firstVisible = "";
      for (const row of rows) {
        const agentKey = String(row.getAttribute("data-agent") || "");
        const matchesActiveAgent = activeAgents.size === 0 || activeAgents.has(agentKey);
        const matches = matchesActiveAgent && (!q || String(row.getAttribute("data-search") || "").includes(q));
        row.classList.toggle("hidden", !matches);
        if (matches) {
          visible += 1;
          if (!firstVisible) firstVisible = String(row.getAttribute("data-group-id") || "");
        }
      }
      if (!activeGroup || !rows.some((row) => !row.classList.contains("hidden") && row.getAttribute("data-group-id") === activeGroup)) activeGroup = firstVisible;
      showGroup(activeGroup);
      if (summary) summary.textContent = visible + " ${esc(t("groups", "그룹"))}";
      syncBatchState();
    }
    function showGroup(groupId) { activeGroup = groupId || ""; for (const row of rows) row.classList.toggle("active", row.getAttribute("data-group-id") === activeGroup); for (const detail of details) detail.classList.toggle("hidden", detail.getAttribute("data-group-id") !== activeGroup); }
    function chooseAgent(value) {
      if (!value || value === "all") activeAgents.clear();
      else if (activeAgents.has(value)) activeAgents.delete(value);
      else activeAgents.add(value);
      agentFilter?.querySelectorAll("[data-agent-filter]").forEach((button) => {
        const value = button.getAttribute("data-agent-filter") || "all";
        button.classList.toggle("active", value === "all" ? activeAgents.size === 0 : activeAgents.has(value));
      });
      applySearch();
    }
    document.body.addEventListener("click", (event) => {
      const target = event.target;
      const save = target instanceof Element ? target.closest("button[data-save]") : null;
      if (save instanceof HTMLButtonElement) {
        const group = save.closest(".group-detail");
        const name = group?.querySelector("input[data-name]");
        const description = group?.querySelector("textarea[data-description]");
        postAction({
          type: "editGroup",
          groupId: save.getAttribute("data-save") || "",
          name: name instanceof HTMLInputElement ? name.value : "",
          description: description instanceof HTMLTextAreaElement ? description.value : ""
        }, save);
      }
      const transfer = target instanceof Element ? target.closest("button[data-transfer-group]") : null;
      if (transfer instanceof HTMLButtonElement) {
        postAction({
          type: "transferGroup",
          groupId: transfer.getAttribute("data-transfer-group") || "",
          mode: transfer.getAttribute("data-transfer-mode") || "withSkills"
        }, transfer);
      }
      const installNpx = target instanceof Element ? target.closest("button[data-install-npx]") : null;
      if (installNpx instanceof HTMLButtonElement) {
        postAction({ type: "installNpx", side: installNpx.getAttribute("data-install-npx") || "workspace" }, installNpx);
      }
      const addSkills = target instanceof Element ? target.closest("button[data-add-skills]") : null;
      if (addSkills instanceof HTMLButtonElement) {
        postAction({ type: "addSkills", groupId: addSkills.getAttribute("data-add-skills") || "" }, addSkills);
      }
      const removeSkills = target instanceof Element ? target.closest("button[data-remove-skills]") : null;
      if (removeSkills instanceof HTMLButtonElement) {
        const group = removeSkills.closest(".group-detail");
        const targets = Array.from(group?.querySelectorAll("input[data-skill-target]:checked") || []).map((input) => ({
          tool: input.getAttribute("data-tool") || "",
          relativePath: input.getAttribute("data-relative-path") || "",
          kind: "folder"
        }));
        postAction({ type: "removeSkills", groupId: removeSkills.getAttribute("data-remove-skills") || "", targets }, removeSkills);
      }
      if (target instanceof HTMLElement && target.id === "batchAddSkills") postAction({ type: "addSkillsToGroups", groupIds: selectedGroupIds() }, target);
      if (target instanceof HTMLElement && target.id === "batchTransferWithSkills") postAction({ type: "transferGroups", groupIds: selectedGroupIds(), mode: "withSkills" }, target);
      if (target instanceof HTMLElement && target.id === "batchTransferGroupOnly") postAction({ type: "transferGroups", groupIds: selectedGroupIds(), mode: "groupOnly" }, target);
      if (target instanceof HTMLElement && target.id === "expandAll") document.querySelectorAll("details").forEach((item) => { item.open = true; });
      if (target instanceof HTMLElement && target.id === "collapseAll") document.querySelectorAll("details").forEach((item) => { item.open = false; });
      if (target instanceof HTMLElement && target.id === "languageToggle") postAction({ type: "toggleLanguage" }, target);
      if (target instanceof HTMLInputElement && target.hasAttribute("data-group-select")) { syncBatchState(); return; }
      if (target instanceof HTMLInputElement && target.id === "toggleGroups") {
        document.querySelectorAll(".group-row:not(.hidden) input[data-group-select]").forEach((item) => { if (item instanceof HTMLInputElement) item.checked = target.checked; });
        syncBatchState();
        return;
      }
      const row = target instanceof Element ? target.closest(".group-row") : null;
      if (row instanceof HTMLElement) {
        showGroup(row.getAttribute("data-group-id") || "");
      }
    });
    document.querySelectorAll("input[data-skill-target]").forEach((item) => item.addEventListener("click", (event) => event.stopPropagation()));
    document.querySelectorAll("input[data-group-select]").forEach((item) => item.addEventListener("click", (event) => event.stopPropagation()));
    agentFilter?.addEventListener("click", (event) => { const target = event.target; const button = target instanceof Element ? target.closest("[data-agent-filter]") : null; if (button instanceof HTMLElement) chooseAgent(button.getAttribute("data-agent-filter") || "all"); });
    search?.addEventListener("input", applySearch);
    applySearch();
  </script>
</body>
</html>`;
}

function renderGroupCard(group: GroupOverviewGroup, t: (english: string, korean: string) => string, active: boolean): string {
  const skillFolders = groupTargetsBySkillFolder(group.targets);
  const folderHtml = skillFolders.slice(0, 80).map((folder) => renderSkillFolder(folder, t)).join("");
  const searchText = `${group.agent} ${group.sourceDetail} ${group.name} ${group.description} ${group.targets.map((target) => `${target.path} ${target.description} ${target.historyProject}`).join(" ")}`;
  const primaryAction = group.side === "workspace"
    ? t("Send group + skills to Central", "그룹+스킬을 중앙으로 보내기")
    : t("Bring group + skills to Workspace", "그룹+스킬을 작업공간으로 가져오기");
  return `
    <article class="group-detail ${active ? "" : "hidden"}" data-group-id="${escAttr(group.id)}" data-search="${esc(searchText.toLowerCase())}">
      <div class="group-head">
        <div>
          <h3>${esc(group.name)}</h3>
          <div class="meta">
            ${renderBadge(sideLabel(group.side, t), group.side)}
            ${renderBadge(sourceLabel(group.source, t), group.source)}
            ${group.sourceDetail ? `<span class="pill source-detail" title="${escAttr(group.sourceDetail)}">${esc(group.sourceDetail)}</span>` : ""}
            ${renderBadge(syncLabel(group.syncStatus, t), group.syncStatus)}
            ${renderBadge(healthLabel(group.health, group.brokenTargetCount, t), group.health)}
            <span class="pill">${esc(t("Targets", "대상"))}: ${group.targetCount}</span>
            <span class="pill">${esc(t("Latest file", "최신 파일"))}: ${esc(group.latestUpdatedAt)}</span>
            <span class="pill">${esc(t("Latest sync", "최신 동기화"))}: ${esc(group.latestHistoryAt)}</span>
          </div>
        </div>
        <div class="actions">
          <button class="primary" data-transfer-group="${escAttr(group.id)}" data-transfer-mode="withSkills">${esc(primaryAction)}</button>
          <button data-transfer-group="${escAttr(group.id)}" data-transfer-mode="groupOnly">${esc(t("Group only", "그룹만"))}</button>
          <button data-add-skills="${escAttr(group.id)}">${esc(t("Add skills", "스킬 추가"))}</button>
          <button data-remove-skills="${escAttr(group.id)}">${esc(t("Remove selected", "선택 제거"))}</button>
          <button data-install-npx="${escAttr(group.side)}">${esc(t("npx skills add", "npx skills add"))}</button>
        </div>
      </div>
      <div class="edit">
        <input data-name value="${escAttr(group.name)}" aria-label="${escAttr(t("Group name", "그룹 이름"))}" />
        <textarea data-description aria-label="${escAttr(t("Group description", "그룹 설명"))}">${esc(group.description)}</textarea>
        <button class="primary" data-save="${escAttr(group.id)}">${esc(t("Save", "저장"))}</button>
      </div>
      <details class="skill-section" open>
        <summary>${esc(t("Skills in this group", "이 그룹의 스킬"))} <span class="meta-inline">${skillFolders.length} ${esc(t("skills", "스킬"))}</span></summary>
        <div class="skill-folders">
          ${folderHtml || `<div class="empty">${esc(t("No skills found.", "스킬을 찾지 못했습니다."))}</div>`}
        </div>
      </details>
    </article>
  `;
}

function renderGroupRow(group: GroupOverviewGroup, t: (english: string, korean: string) => string, active: boolean): string {
  const skillCount = groupTargetsBySkillFolder(group.targets).length;
  const searchText = `${group.agent} ${group.side} ${group.source} ${group.sourceDetail} ${group.syncStatus} ${group.name} ${group.description} ${group.targets.map((target) => `${target.path} ${target.description} ${target.historyProject}`).join(" ")}`;
  return `
    <tr class="group-row ${active ? "active" : ""}" data-group-id="${escAttr(group.id)}" data-agent="${escAttr(group.agent)}" data-search="${esc(searchText.toLowerCase())}">
      <td><span class="agent-label">${esc(formatAgent(group.agent))}</span></td>
      <td class="group-check"><input type="checkbox" data-group-select="${escAttr(group.id)}" title="${escAttr(t("Select group", "그룹 선택"))}" /></td>
      <td>
        <div class="group-name">${esc(group.name)}</div>
        <div class="group-desc" title="${escAttr(group.description || "-")}">${esc(group.description || t("No description", "설명 없음"))}</div>
      </td>
      <td>${renderBadge(sideLabel(group.side, t), group.side)}</td>
      <td>${renderBadge(sourceLabel(group.source, t), group.source)}</td>
      <td>${renderBadge(syncLabel(group.syncStatus, t), group.syncStatus)}</td>
      <td>${skillCount}</td>
      <td>${esc(group.latestUpdatedAt)}</td>
    </tr>
  `;
}

function renderSkillFolder(folder: GroupOverviewSkillFolder, t: (english: string, korean: string) => string): string {
  const rowHtml = folder.files.map((target) => `
    <tr>
      <td><div class="path" title="${esc(target.path)}">${esc(relativeFileLabel(target.path, folder.path))}</div></td>
      <td>${esc(target.kind)}</td>
      <td>${esc(target.updatedAt)}</td>
      <td>${esc(target.historyAt)}</td>
      <td>${esc(target.historyProject)}</td>
      <td><div class="skill-desc">${esc(target.description || "-")}</div></td>
    </tr>
  `).join("");
  return `
    <details class="skill-folder">
      <summary>
        <input type="checkbox" data-skill-target data-tool="${escAttr(folder.tool)}" data-relative-path="${escAttr(folder.relativePath)}" />
        <span class="folder-name">${esc(folder.name)}</span>
        <span class="folder-path">${esc(folder.path)}</span>
        <span class="meta-inline">${folder.files.length} ${esc(t("files", "파일"))}</span>
      </summary>
      <div class="folder-summary">
        <span class="pill">${esc(t("Latest file", "최신 파일"))}: ${esc(folder.latestUpdatedAt)}</span>
        <span class="pill">${esc(t("Latest sync", "최신 동기화"))}: ${esc(folder.latestHistoryAt)}</span>
        ${folder.description ? `<span class="skill-desc">${esc(folder.description)}</span>` : ""}
      </div>
      <table>
        <thead>
          <tr>
            <th>${esc(t("File", "파일"))}</th>
            <th>${esc(t("Type", "종류"))}</th>
            <th>${esc(t("File updated", "파일 수정"))}</th>
            <th>${esc(t("Synced", "동기화"))}</th>
            <th>${esc(t("Source", "출처"))}</th>
            <th>${esc(t("Description", "설명"))}</th>
          </tr>
        </thead>
        <tbody>${rowHtml}</tbody>
      </table>
    </details>
  `;
}

function groupTargetsBySkillFolder(targets: GroupOverviewTarget[]): GroupOverviewSkillFolder[] {
  const folders = new Map<string, GroupOverviewSkillFolder>();
  for (const target of targets) {
    const folderPath = skillFolderPathFromDisplayPath(target.path);
    const parsed = parseDisplaySkillFolder(folderPath);
    const folder = folders.get(folderPath) ?? {
      name: skillNameFromDisplayPath(folderPath),
      path: folderPath,
      relativePath: parsed?.relativePath ?? "skills",
      tool: parsed?.tool ?? "agents",
      files: [],
      latestUpdatedAt: "-",
      latestHistoryAt: "-",
      description: ""
    };
    folder.files.push(target);
    folder.latestUpdatedAt = maxIso([folder.latestUpdatedAt, target.updatedAt]);
    folder.latestHistoryAt = maxIso([folder.latestHistoryAt, target.historyAt]);
    if (!folder.description && /\/SKILL\.md$/i.test(target.path) && target.description && target.description !== "-") {
      folder.description = target.description;
    }
    folders.set(folderPath, folder);
  }
  return [...folders.values()].sort((left, right) =>
    right.latestUpdatedAt.localeCompare(left.latestUpdatedAt) || left.path.localeCompare(right.path)
  );
}

function skillFolderPathFromDisplayPath(value: string): string {
  const parts = value.split("/").filter(Boolean);
  const skillsIndex = parts.indexOf("skills");
  if (skillsIndex < 0 || !parts[skillsIndex + 1]) return value;
  return parts.slice(0, skillsIndex + 2).join("/");
}

function parseDisplaySkillFolder(value: string): { tool: ToolType; relativePath: string } | null {
  const parts = value.split("/").filter(Boolean);
  if (!isToolType(parts[0])) return null;
  const skillsIndex = parts.indexOf("skills");
  if (skillsIndex < 0 || !parts[skillsIndex + 1]) return null;
  return {
    tool: parts[0],
    relativePath: parts.slice(1, skillsIndex + 2).join("/")
  };
}

function skillFolderRelativePath(value: string): string {
  const relativePath = normalizeRel(value);
  const parts = relativePath.split("/").filter(Boolean);
  const skillsIndex = parts.indexOf("skills");
  if (skillsIndex < 0 || !parts[skillsIndex + 1]) return relativePath;
  return parts.slice(0, skillsIndex + 2).join("/");
}

function skillNameFromRelativePath(value: string): string {
  const parts = normalizeRel(value).split("/").filter(Boolean);
  return parts[parts.length - 1] ?? value;
}

function skillNameFromDisplayPath(value: string): string {
  const parts = value.split("/").filter(Boolean);
  return parts[parts.length - 1] || value;
}

function relativeFileLabel(value: string, folderPath: string): string {
  if (value === folderPath) return ".";
  const prefix = `${folderPath}/`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function formatAgent(agent: ToolType | "mixed"): string {
  return agent;
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escAttr(value: string): string {
  return esc(value).replace(/'/g, "&#39;");
}
