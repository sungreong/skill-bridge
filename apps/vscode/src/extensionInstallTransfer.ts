import { promises as fs } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { copyNode } from "./extensionSupport";
import {
  buildGroupTargetsFromNames,
  collectSkillFolderSyncTargets,
  extractInstalledSkillFolderNames,
  getUniqueTargetTools,
  inferNewSkillFolderNames
} from "./installGrouping";
import { getWritableSkillRoot } from "./skillPaths";
import type { SelectionGroup, SkillFile, SkillSelection, SkillTreeNode, ToolType, TransferPlan, TransferPlanItem } from "./types";

type TreeSide = "workspace" | "central";
type TranslationFn = (english: string, korean: string) => string;
type TransferScopeHint = { tool: ToolType; relativePath: string; kind: "file" | "folder" };
type TransferPlanOptions = Pick<TransferPlan, "groupContext" | "repoContext" | "scopeContext"> & { scopeHints?: TransferScopeHint[] };
export type NpxInstallPreset = {
  repoUrl: string;
  skills: string[];
  cwd?: string;
  tool?: ToolType;
  skipCommandConfirm?: boolean;
  skipPostInstallSyncPrompt?: boolean;
};

export function createInstallTransferTools(args: {
  tr: TranslationFn;
  toUserError: (error: unknown) => string;
  handleError: (error: unknown) => Promise<void>;
  refresh: () => Promise<void>;
  output: vscode.OutputChannel;
  state: {
    workspacePath: string;
    centralRepoPath: string;
    agents: ToolType[];
    groups: SelectionGroup[];
    workspaceSelection: SkillTreeNode[];
    centralSelection: SkillTreeNode[];
    workspaceSkills: SkillFile[];
    centralSkills: SkillFile[];
  };
  workspaceProvider: {
    getSelected: () => SkillTreeNode | null | undefined;
    getAllSelections: () => SkillSelection[];
  };
  centralProvider: {
    getSelected: () => SkillTreeNode | null | undefined;
    getAllSelections: () => SkillSelection[];
  };
  exists: (targetPath: string) => Promise<boolean>;
  parseSkillInputs: (value: string) => string[];
  formatCommandForDisplay: (command: string, args: string[]) => string;
  loadSkillFilesBySide: (side: TreeSide, workspacePath: string, centralRepoPath: string, agents: ToolType[]) => Promise<SkillFile[]>;
  runSkillsAdd: (cwd: string, repo: string, skills: string[]) => Promise<{ ok: boolean; command: string; stdout: string; stderr: string }>;
  resolveSelectedAgentToolForSide: (side: TreeSide, node?: SkillTreeNode) => ToolType | undefined;
  formatAgentFolderLabel: (tool: ToolType) => string;
  getAutoSyncWorkspaceAgents: () => ToolType[];
  syncWorkspaceAgentFoldersToCentral: (
    targets: Array<{ tool: ToolType; skillFolderRel: string }>,
    reason: "manual" | "auto"
  ) => Promise<{ syncedFolders: number; copied: number; deleted: number; mirroredGroups: number; unchanged: number }>;
  normalizeRepoName: (raw: string) => string;
  persistGroups: (next: SelectionGroup[], selectedGroupId: string | null) => Promise<void>;
  targetsToSelections: (files: SkillFile[], targets: SelectionGroup["targets"]) => SkillSelection[];
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
  collectScopeHintsFromPlanItems: (items: TransferPlanItem[]) => TransferScopeHint[];
  collapseLibraryTargets: (targets: TransferScopeHint[]) => TransferScopeHint[];
  collectAffectedGroupIdsForScopeHints: (side: TreeSide, scopeHints: TransferScopeHint[]) => string[];
  mirrorGroupToOtherSide: (group: SelectionGroup, options?: { requireExistingTargets?: boolean }) => Promise<boolean>;
  getSkillFolderRelativePath: (relativePath: string) => string | null;
  normalizeRel: (value: string | undefined | null) => string;
}): {
  installSkills: (node?: SkillTreeNode) => Promise<void>;
  installSkillsForSide: (side: TreeSide) => Promise<void>;
  installNpxRepoForSide: (side: TreeSide, preset: NpxInstallPreset) => Promise<boolean>;
  resolveInstallSide: (node?: SkillTreeNode) => Promise<TreeSide | undefined>;
  transferSelections: (
    side: TreeSide,
    selections: SkillSelection[],
    options?: TransferPlanOptions
  ) => Promise<{ copied: number; deleted: number; unchanged: number; failed: number; appliedScopeHints: TransferScopeHint[]; affectedGroupIds: string[] }>;
  resolveCommandNodes: (side: TreeSide, node?: SkillTreeNode) => SkillTreeNode[];
  pickEmptyTransferScope: (side: TreeSide) => Promise<"all" | "cancel">;
  buildTransferScopeContext: (input: {
    side: TreeSide;
    nodes: SkillTreeNode[];
    hints: TransferScopeHint[] | undefined;
    selectedGroup: SelectionGroup | undefined;
    isWholeTreeScope: boolean;
  }) => TransferPlan["scopeContext"];
  formatTransferScopeLabel: (hints: TransferScopeHint[]) => string;
  getAllSelectionsForSide: (side: TreeSide) => SkillSelection[];
} {
  const getAllSelectionsForSide = (side: TreeSide): SkillSelection[] =>
    side === "workspace" ? args.workspaceProvider.getAllSelections() : args.centralProvider.getAllSelections();

  const resolveInstallSide = async (node?: SkillTreeNode): Promise<TreeSide | undefined> => {
    if (node) {
      const workspaceSelected = args.state.workspaceSelection.some((item) => item.key === node.key)
        || args.workspaceProvider.getSelected()?.key === node.key;
      if (workspaceSelected) return "workspace";
      const centralSelected = args.state.centralSelection.some((item) => item.key === node.key)
        || args.centralProvider.getSelected()?.key === node.key;
      if (centralSelected) return "central";
    }
    if (args.state.workspaceSelection.length > 0 && args.state.centralSelection.length === 0) return "workspace";
    if (args.state.centralSelection.length > 0 && args.state.workspaceSelection.length === 0) return "central";
    const pick = await vscode.window.showQuickPick(
      [
        { label: args.tr("Workspace", "작업공간"), value: "workspace" as TreeSide },
        { label: args.tr("Central", "중앙"), value: "central" as TreeSide }
      ],
      { title: args.tr("Select Where to Run npx skills add", "npx skills add 실행 위치 선택") }
    );
    return pick?.value;
  };

  const transferSelections = async (
    side: TreeSide,
    selections: SkillSelection[],
    options?: TransferPlanOptions
  ): Promise<{ copied: number; deleted: number; unchanged: number; failed: number; appliedScopeHints: TransferScopeHint[]; affectedGroupIds: string[] }> => {
    const plan = await args.buildTransferPlan(side, selections, options);
    if (plan.items.length === 0) return { copied: 0, deleted: 0, unchanged: 0, failed: 0, appliedScopeHints: [], affectedGroupIds: [] };
    const resolved = await args.openTransferManagerTab(
      plan,
      async () => await args.buildTransferPlan(side, selections, options),
      plan.scopeContext?.expandable
        ? async () => await args.buildTransferPlan(side, getAllSelectionsForSide(side), {
            scopeContext: {
              type: "all",
              label: side === "workspace" ? args.tr("All Workspace", "작업공간 전체") : args.tr("All Central", "중앙 전체"),
              count: 0,
              expandable: false
            }
          })
        : undefined
    );
    if (!resolved) return { copied: 0, deleted: 0, unchanged: 0, failed: 0, appliedScopeHints: [], affectedGroupIds: [] };
    const appliedScopeHints = args.collectScopeHintsFromPlanItems(resolved.items);
    const requestedScopeHints = options?.scopeHints ? args.collapseLibraryTargets(options.scopeHints) : [];
    const affectedGroupIds = appliedScopeHints.length > 0
      ? args.collectAffectedGroupIdsForScopeHints(side, appliedScopeHints)
      : requestedScopeHints.length > 0
        ? args.collectAffectedGroupIdsForScopeHints(side, requestedScopeHints)
        : [];
    const result = await args.applyTransferPlan(resolved.items, side === "workspace" ? args.state.workspacePath : null);
    if (result.failed > 0) {
      vscode.window.showWarningMessage(args.tr(
        `Apply result: copied ${result.copied}, deleted ${result.deleted}, unchanged ${result.unchanged}, failed ${result.failed}`,
        `반영 결과: 복사 행 ${result.copied}개 / 삭제 행 ${result.deleted}개 / 변경없음 행 ${result.unchanged}개 / 실패 행 ${result.failed}개`
      ));
    }
    return { ...result, appliedScopeHints, affectedGroupIds };
  };

  const resolveCommandNodes = (side: TreeSide, node?: SkillTreeNode): SkillTreeNode[] => {
    const selection = side === "workspace" ? args.state.workspaceSelection : args.state.centralSelection;
    if (!node) return selection;
    return selection.some((item) => item.key === node.key) ? selection : [node];
  };

  const pickEmptyTransferScope = async (side: TreeSide): Promise<"all" | "cancel"> => {
    const direction = side === "workspace" ? args.tr("Send to Central", "중앙으로 보내기") : args.tr("Bring to Workspace", "작업공간으로 가져오기");
    const pick = await vscode.window.showQuickPick(
      [
        {
          label: args.tr("Review All Visible Skills for Transfer", "현재 보이는 전체 스킬 전송 검토"),
          description: direction,
          detail: args.tr("Only when nothing is selected, this opens all visible skills in the review screen.", "선택한 항목이 없을 때만 전체를 검토 화면에 올립니다."),
          value: "all" as const
        },
        {
          label: args.tr("Cancel", "취소"),
          description: args.tr("Select a skill or folder in the tree first", "먼저 트리에서 스킬이나 폴더를 선택"),
          detail: args.tr("To transfer specific items, right-click or select them in the tree and run this again.", "특정 항목만 전송하려면 트리에서 우클릭하거나 선택 후 다시 실행하세요."),
          value: "cancel" as const
        }
      ],
      {
        title: args.tr("Select Transfer Scope", "전송 범위를 선택하세요"),
        matchOnDescription: true,
        matchOnDetail: true
      }
    );
    return pick?.value ?? "cancel";
  };

  const pickNpxTargetAgent = async (side: TreeSide): Promise<ToolType | undefined> => {
    const picked = await vscode.window.showQuickPick(
      args.state.agents.map((tool) => ({
        label: args.formatAgentFolderLabel(tool),
        description: side === "workspace"
          ? args.tr("Save installed skills in this workspace agent folder.", "설치한 스킬을 이 작업공간 에이전트 폴더에 저장합니다.")
          : args.tr("Save installed skills in this Central agent folder.", "설치한 스킬을 이 Central 에이전트 폴더에 저장합니다."),
        value: tool
      })),
      {
        title: args.tr("Choose target agent for npx skills", "npx 스킬을 저장할 에이전트 선택"),
        placeHolder: args.tr("Pick where the installed skill folders should be saved.", "설치된 스킬 폴더를 저장할 위치를 선택하세요.")
      }
    );
    return picked?.value;
  };

  const formatTransferScopeLabel = (hints: TransferScopeHint[]): string => {
    const preview = hints.slice(0, 3).map((hint) => {
      const rel = args.normalizeRel(hint.relativePath);
      const skillFolder = args.getSkillFolderRelativePath(rel);
      return `${hint.tool}/${skillFolder ?? rel}`;
    });
    const label = preview.join(", ");
    return hints.length > preview.length
      ? args.tr(`${label} and ${hints.length - preview.length} more`, `${label} 외 ${hints.length - preview.length}개`)
      : label;
  };

  const buildTransferScopeContext = (input: {
    side: TreeSide;
    nodes: SkillTreeNode[];
    hints: TransferScopeHint[] | undefined;
    selectedGroup: SelectionGroup | undefined;
    isWholeTreeScope: boolean;
  }): TransferPlan["scopeContext"] => {
    if (input.selectedGroup) {
      return { type: "group", label: args.tr(`Group: ${input.selectedGroup.name}`, `그룹: ${input.selectedGroup.name}`), count: input.selectedGroup.targets.length, expandable: false };
    }
    if (input.hints && input.hints.length > 0) {
      return { type: "selection", label: formatTransferScopeLabel(input.hints), count: input.hints.length, expandable: false };
    }
    if (input.isWholeTreeScope || input.nodes.some((node) => node.relativePath === "")) {
      return { type: "all", label: input.side === "workspace" ? args.tr("All Workspace", "작업공간 전체") : args.tr("All Central", "중앙 전체"), count: 0, expandable: false };
    }
    if (input.nodes.length > 0) {
      return { type: "selection", label: input.nodes.map((node) => `${node.tool}/${node.label}`).join(", "), count: input.nodes.length, expandable: false };
    }
    return undefined;
  };

  const runInstallSkills = async (side: TreeSide, node?: SkillTreeNode, preset?: NpxInstallPreset): Promise<boolean> => {
      const selectedTool = preset?.tool ?? args.resolveSelectedAgentToolForSide(side, node) ?? await pickNpxTargetAgent(side);
      if (!selectedTool) return false;
      const repoInput = preset?.repoUrl ?? await vscode.window.showInputBox({
        title: side === "workspace" ? "Workspace: npx skills add" : "Central: npx skills add",
        prompt: args.tr("Enter the skill repository URL to install", "설치할 스킬 저장소 URL을 입력하세요"),
        value: "https://github.com/vercel-labs/skills",
        ignoreFocusOut: true
      });
      const repo = repoInput?.trim();
      if (!repo) return false;
      const skillsInput = preset ? preset.skills.join(", ") : await vscode.window.showInputBox({
        title: args.tr("Skill Names to Install", "설치할 스킬 이름"),
        prompt: args.tr("Enter names separated by commas. Leave empty for all (*).", "콤마(,)로 구분해 입력하세요. 비우면 전체(*)"),
        value: "*",
        ignoreFocusOut: true
      });
      if (skillsInput === undefined) return false;
      const skills = preset ? preset.skills : args.parseSkillInputs(skillsInput);
      const sideBasePath = side === "workspace" ? args.state.workspacePath : args.state.centralRepoPath;
      const defaultCwd = sideBasePath;
      const useStaging = selectedTool !== "agents";
      const cwdInput = preset?.cwd ?? (useStaging ? defaultCwd : await vscode.window.showInputBox({
        title: args.tr("Run Directory", "실행 디렉터리"),
        prompt: args.tr("Enter the directory where npx skills add should run", "npx skills add를 실행할 디렉터리를 입력하세요"),
        value: defaultCwd,
        ignoreFocusOut: true
      }));
      if (cwdInput === undefined) return false;
      const cwd = cwdInput.trim() || defaultCwd;
      if (!(await args.exists(cwd))) {
        vscode.window.showErrorMessage(args.tr(`Run directory not found: ${cwd}`, `실행 디렉터리를 찾을 수 없습니다: ${cwd}`));
        return false;
      }
      const stat = await fs.stat(cwd).catch(() => null);
      if (!stat?.isDirectory()) {
        vscode.window.showErrorMessage(args.tr(`Enter a directory path: ${cwd}`, `디렉터리 경로를 입력해주세요: ${cwd}`));
        return false;
      }
      const stagingDir = useStaging ? await fs.mkdtemp(path.join(os.tmpdir(), `skill-bridge-npx-${side}-`)) : null;
      const commandCwd = stagingDir ?? cwd;
      const targetSkillRoot = path.join(getWritableSkillRoot(sideBasePath, selectedTool, side), "skills");
      const commandArgs = ["-y", "skills", "add", repo, ...skills.flatMap((skill) => ["--skill", skill]), "--yes"];
      const runLabel = args.tr("Run", "실행");
      if (!preset?.skipCommandConfirm) {
        const confirm = await vscode.window.showWarningMessage(
          args.tr(
            `Run this command?\n\nTarget agent: ${args.formatAgentFolderLabel(selectedTool)}\nSave location: ${targetSkillRoot}\nWorking directory: ${commandCwd}\nCommand: ${args.formatCommandForDisplay("npx", commandArgs)}`,
            `다음 명령을 실행할까요?\n\n대상 에이전트: ${args.formatAgentFolderLabel(selectedTool)}\n저장 위치: ${targetSkillRoot}\n작업 디렉터리: ${commandCwd}\n명령: ${args.formatCommandForDisplay("npx", commandArgs)}`
          ),
          { modal: true },
          runLabel
        );
        if (confirm !== runLabel) {
          if (stagingDir) await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
          return false;
        }
      }

      const beforeFiles = await args.loadSkillFilesBySide(side, args.state.workspacePath, args.state.centralRepoPath, args.state.agents);
      const result = await args.runSkillsAdd(commandCwd, repo, skills);
      const text = [result.command, result.stdout, result.stderr].filter(Boolean).join("\n");
      args.output.appendLine(`[skills:add] side=${side} target=${selectedTool} cwd=${commandCwd}`);
      args.output.appendLine(text || "(no output)");
      args.output.show(true);
      if (!result.ok) {
        if (stagingDir) await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
        vscode.window.showErrorMessage(args.tr("npx skills add failed. Check the Output panel.", "npx skills add 실행에 실패했습니다. Output 패널을 확인하세요."));
        return false;
      }

      const stagedNames = stagingDir ? await listStagedSkillNames(stagingDir) : [];
      const installedNames = extractInstalledSkillFolderNames(`${result.stdout}\n${result.stderr}`);
      const presetNames = preset?.skills.filter((skill) => skill !== "*") ?? [];
      const targetNames = installedNames.length > 0 ? installedNames : stagedNames.length > 0 ? stagedNames : presetNames;
      if (stagingDir) {
        const copied = await copyStagedSkillsToTarget(stagingDir, targetSkillRoot, targetNames, !preset?.skipCommandConfirm, args.tr);
        await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
        if (!copied) return false;
      }
      await args.refresh();
      const afterFiles = await args.loadSkillFilesBySide(side, args.state.workspacePath, args.state.centralRepoPath, args.state.agents);
      const fallbackNames = inferNewSkillFolderNames(beforeFiles, afterFiles);
      const groupNames = targetNames.length > 0 ? targetNames : fallbackNames;
      const rawTargets = buildGroupTargetsFromNames(afterFiles, groupNames).filter((target) => target.tool === selectedTool);
      const availableTools = getUniqueTargetTools(rawTargets);

      let groupingTool: ToolType | undefined = selectedTool;
      if (!groupingTool && availableTools.length === 1) groupingTool = availableTools[0];
      if (!groupingTool && availableTools.length > 1) {
        const picked = await vscode.window.showQuickPick(
          availableTools.map((tool) => ({
            label: args.formatAgentFolderLabel(tool),
            description: args.tr("Track this install as a group for this agent only.", "이 에이전트 기준으로만 설치 그룹을 추적합니다."),
            value: tool
          })),
          {
            title: args.tr("Choose the agent for this installed skill group", "설치 그룹을 묶을 에이전트 선택"),
            placeHolder: args.tr("A single npx install matched more than one agent. Pick the agent group to update.", "이번 npx 설치가 여러 에이전트와 연결되었습니다. 갱신할 에이전트 그룹을 고르세요.")
          }
        );
        groupingTool = picked?.value;
      }
      const targets = groupingTool ? rawTargets.filter((target) => target.tool === groupingTool) : rawTargets;
      if (targets.length === 0) {
        vscode.window.showWarningMessage(args.tr("Install completed, but no new skill folders were found to register as a group.", "설치는 완료되었지만 그룹으로 등록할 새 스킬 폴더를 찾지 못했습니다."));
        return false;
      }

      const repoKey = args.normalizeRepoName(repo);
      const now = new Date().toISOString();
      const generatedDescription = args.tr(`Installed from ${repo}`, `${repo}에서 설치한 스킬 그룹`);
      const existing = args.state.groups.find((group) =>
        group.side === side
        && group.meta?.repoKey === repoKey
        && (groupingTool ? (group.meta?.tool === groupingTool || group.targets[0]?.tool === groupingTool) : true)
      );

      let sourceGroup: SelectionGroup;
      if (existing) {
        const nextGroups = args.state.groups.map((group) => group.id !== existing.id ? group : {
          ...group,
          name: repoKey || group.name,
          description: group.description?.trim() ? group.description : generatedDescription,
          targets,
          meta: {
            ...group.meta,
            source: "npx" as const,
            tool: groupingTool ?? group.meta?.tool,
            repoKey,
            repoUrl: repo,
            lastInstalledAt: now,
            installCwd: cwd,
            installSkills: skills
          }
        });
        await args.persistGroups(nextGroups, existing.id);
        sourceGroup = nextGroups.find((group) => group.id === existing.id) ?? existing;
        vscode.window.showInformationMessage(args.tr(`Install and group update complete: ${repoKey} (${targets.length} skill(s))`, `설치 및 그룹 갱신 완료: ${repoKey} (스킬 ${targets.length}개)`));
      } else {
        const groupId = `${side}-${Date.now()}`;
        sourceGroup = {
          id: groupId,
          name: repoKey || "skills-installed",
          description: generatedDescription,
          side,
          targets,
          meta: {
            source: "npx",
            tool: groupingTool,
            repoKey,
            repoUrl: repo,
            lastInstalledAt: now,
            installCwd: cwd,
            installSkills: skills
          }
        };
        await args.persistGroups([...args.state.groups, sourceGroup], groupId);
        vscode.window.showInformationMessage(args.tr(`Install and group creation complete: ${sourceGroup.name} (${targets.length} skill(s))`, `설치 및 그룹 생성 완료: ${sourceGroup.name} (스킬 ${targets.length}개)`));
      }
      if (preset?.skipPostInstallSyncPrompt) return true;

      if (side === "workspace") {
        const autoSyncAgents = new Set(args.getAutoSyncWorkspaceAgents());
        const syncFolders = collectSkillFolderSyncTargets(sourceGroup.targets, groupingTool);
        const shouldAutoSync = syncFolders.length > 0 && syncFolders.every((entry) => autoSyncAgents.has(entry.tool));
        if (shouldAutoSync) {
          const summary = await args.syncWorkspaceAgentFoldersToCentral(syncFolders, "manual");
          const syncedToolLabel = groupingTool ? args.formatAgentFolderLabel(groupingTool) : args.tr("workspace agent", "작업공간 에이전트");
          vscode.window.showInformationMessage(args.tr(
            `Install, group, and auto sync complete: ${syncedToolLabel} · folders ${summary.syncedFolders} · copied ${summary.copied} · deleted ${summary.deleted} · groups ${summary.mirroredGroups}`,
            `설치, 그룹 생성, 자동 sync 완료: ${syncedToolLabel} · 폴더 ${summary.syncedFolders}개 · 복사 ${summary.copied}개 · 삭제 ${summary.deleted}개 · 그룹 ${summary.mirroredGroups}개`
          ));
          return true;
        }
      }

      const copyLabel = args.tr("Copy", "복사");
      const shouldSync = await vscode.window.showInformationMessage(
        side === "workspace"
          ? args.tr("Copy installed skills to the central repository?", "설치된 스킬을 중앙 저장소로 복사할까요?")
          : args.tr("Copy installed skills to the workspace?", "설치된 스킬을 작업 폴더로 복사할까요?"),
        copyLabel
      );
      if (shouldSync === copyLabel) {
        const selections = args.targetsToSelections(afterFiles, sourceGroup.targets);
        const transferResult = await transferSelections(side, selections, {
          groupContext: { id: sourceGroup.id, name: sourceGroup.name, side: sourceGroup.side },
          repoContext: { repo },
          scopeHints: sourceGroup.targets.map((target) => ({ ...target }))
        });
        const mirroredGroup = await args.mirrorGroupToOtherSide(sourceGroup, { requireExistingTargets: true });
        if (transferResult.copied + transferResult.deleted > 0 || mirroredGroup) {
          await args.refresh();
          vscode.window.showInformationMessage(args.tr(
            `Installed skills applied: copied ${transferResult.copied}, deleted ${transferResult.deleted}, unchanged ${transferResult.unchanged}${mirroredGroup ? " · group synced" : ""}`,
            `설치 스킬 반영: 복사 행 ${transferResult.copied}개 / 삭제 행 ${transferResult.deleted}개 / 변경없음 행 ${transferResult.unchanged}개${mirroredGroup ? " · 그룹 동기화됨" : ""}`
          ));
        }
      }
      return true;
  };

  const installSkills = async (node?: SkillTreeNode): Promise<void> => {
    try {
      if (!args.state.workspacePath || !args.state.centralRepoPath) await args.refresh();
      const side = await resolveInstallSide(node);
      if (!side) return;
      await runInstallSkills(side, node);
    } catch (error) {
      await args.handleError(error);
    }
  };

  const installSkillsForSide = async (side: TreeSide): Promise<void> => {
    try {
      if (!args.state.workspacePath || !args.state.centralRepoPath) await args.refresh();
      await runInstallSkills(side);
    } catch (error) {
      await args.handleError(error);
    }
  };

  const installNpxRepoForSide = async (side: TreeSide, preset: NpxInstallPreset): Promise<boolean> => {
    try {
      if (!args.state.workspacePath || !args.state.centralRepoPath) await args.refresh();
      return await runInstallSkills(side, undefined, preset);
    } catch (error) {
      await args.handleError(error);
      return false;
    }
  };

  return {
    installSkills,
    installSkillsForSide,
    installNpxRepoForSide,
    resolveInstallSide,
    transferSelections,
    resolveCommandNodes,
    pickEmptyTransferScope,
    buildTransferScopeContext,
    formatTransferScopeLabel,
    getAllSelectionsForSide
  };
}

async function listStagedSkillNames(stagingDir: string): Promise<string[]> {
  const skillRoot = path.join(stagingDir, ".agents", "skills");
  const entries = await fs.readdir(skillRoot, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort((left, right) => left.localeCompare(right));
}

async function copyStagedSkillsToTarget(
  stagingDir: string,
  targetSkillRoot: string,
  targetNames: string[],
  confirmOverwrite: boolean,
  tr: TranslationFn
): Promise<boolean> {
  const sourceSkillRoot = path.join(stagingDir, ".agents", "skills");
  const names = targetNames.length > 0 ? targetNames : await listStagedSkillNames(stagingDir);
  const existing: string[] = [];
  const copyPairs: Array<{ source: string; target: string }> = [];
  for (const name of names) {
    const source = path.join(sourceSkillRoot, name);
    if (!(await existsPath(path.join(source, "SKILL.md")))) continue;
    const target = path.join(targetSkillRoot, name);
    if (await existsPath(target)) existing.push(name);
    copyPairs.push({ source, target });
  }
  if (copyPairs.length === 0) {
    vscode.window.showWarningMessage(tr("Install completed, but no staged skill folders were found.", "설치는 완료됐지만 임시 설치 폴더에서 스킬을 찾지 못했습니다."));
    return false;
  }
  if (existing.length > 0 && confirmOverwrite) {
    const ok = await vscode.window.showWarningMessage(
      tr(
        `Replace ${existing.length} existing skill folder(s) in the selected agent?\n\n${existing.slice(0, 8).join(", ")}`,
        `선택한 에이전트의 기존 스킬 폴더 ${existing.length}개를 교체할까요?\n\n${existing.slice(0, 8).join(", ")}`
      ),
      { modal: true },
      tr("Replace", "교체")
    );
    if (ok !== tr("Replace", "교체")) return false;
  }
  await fs.mkdir(targetSkillRoot, { recursive: true });
  for (const pair of copyPairs) {
    await fs.rm(pair.target, { recursive: true, force: true });
    await copyNode(pair.source, pair.target);
  }
  return true;
}

async function existsPath(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
