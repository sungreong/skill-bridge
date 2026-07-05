import { Buffer } from "node:buffer";
import * as vscode from "vscode";
import type { GroupTreeNode, SelectionGroup, SkillTreeFilterMode, SkillTreeNode, ToolType } from "./types";
import { normalizeSourceTab, sourceTabToVisibleAgents } from "./extensionSupport";
import { coerceUiLanguage, DEFAULT_UI_LANGUAGE, getNextUiLanguage, getUiLanguageOption, type UiLanguage } from "./uiLanguage";
import { buildCommonToolNodes, DEFAULT_QUICK_TOOL_COMMANDS, MANAGE_QUICK_TOOLS_COMMAND } from "./views/commonToolCatalog";

type TreeSide = "workspace" | "central";
type SourceTab = "all" | ToolType[];
type TranslationFn = (english: string, korean: string) => string;

export function registerExtensionCommands(args: {
  register: <T>(command: string, handler: (...commandArgs: T[]) => unknown) => void;
  tr: TranslationFn;
  toUserError: (error: unknown) => string;
  handleError: (error: unknown) => Promise<void>;
  settingsSection: string;
  state: {
    workspacePath: string;
    centralRepoPath: string;
    workspaceSelection: SkillTreeNode[];
    centralSelection: SkillTreeNode[];
    selectedGroupId: string | null;
    groups: SelectionGroup[];
    agents: ToolType[];
    activeTab: SourceTab;
    treeFilter: SkillTreeFilterMode;
  };
  workspaceProvider: {
    setSelected: (node: SkillTreeNode | null) => void;
    getSelected: () => SkillTreeNode | null | undefined;
    setSelectedGroup: (groupId: string | null) => void;
    setHighlight: (keys: Set<string>) => void;
    setGroups: (groups: SelectionGroup[]) => void;
    setFilterMode: (mode: SkillTreeFilterMode) => void;
  };
  centralProvider: {
    setSelected: (node: SkillTreeNode | null) => void;
    getSelected: () => SkillTreeNode | null | undefined;
    setSelectedGroup: (groupId: string | null) => void;
    setHighlight: (keys: Set<string>) => void;
    setGroups: (groups: SelectionGroup[]) => void;
    setFilterMode: (mode: SkillTreeFilterMode) => void;
  };
  unwrapSkillNode: (node?: unknown) => SkillTreeNode | undefined;
  openNodeIfFile: (basePath: string, node: SkillTreeNode, mode: TreeSide) => Promise<void>;
  openFolderInOs: (side: TreeSide, node?: SkillTreeNode) => Promise<void>;
  showGroupActions: (node?: GroupTreeNode) => Promise<void>;
  openGroupOverview: (node?: GroupTreeNode) => Promise<void>;
  openNpxSkillLibrary: () => Promise<void>;
  renameGroup: (node?: GroupTreeNode) => Promise<void>;
  editGroupDescription: (node?: GroupTreeNode) => Promise<void>;
  refresh: () => Promise<unknown>;
  saveSelectionGroups: (workspacePath: string, centralRepoPath: string, groups: SelectionGroup[]) => Promise<void>;
  applyGroupHighlight: (group: SelectionGroup) => void;
  createGroupFromSelection: (side: TreeSide, overrideNodes?: SkillTreeNode[]) => Promise<void>;
  resolveGroupingNodes: (side: TreeSide, node?: SkillTreeNode) => SkillTreeNode[];
  addSelectionToExistingGroup: (side: TreeSide, node?: SkillTreeNode) => Promise<void>;
  createSkillItem: (side: TreeSide, kind: "file" | "folder", node?: SkillTreeNode) => Promise<void>;
  createSkillFolder: (side: TreeSide, node?: SkillTreeNode) => Promise<void>;
  showQuickSkillCrud: (side: TreeSide, node?: SkillTreeNode) => Promise<void>;
  showSmartActions: (side: TreeSide, node?: SkillTreeNode) => Promise<void>;
  runNodeCrud: (side: TreeSide, action: "rename" | "delete" | "duplicate", node?: SkillTreeNode, selectedNodes?: SkillTreeNode[]) => Promise<void>;
  copyNodesToClipboard: (side: TreeSide, node?: SkillTreeNode) => void;
  copyNodePathToClipboard: (side: TreeSide, node?: SkillTreeNode) => Promise<void>;
  pasteNodesFromClipboard: (side: TreeSide, node?: SkillTreeNode) => Promise<void>;
  installSkills: (node?: SkillTreeNode) => Promise<void>;
  runAgentCopyWizard: (side?: TreeSide, node?: SkillTreeNode) => Promise<void>;
  runGroupAgentCopyWizard: (side: TreeSide, node?: GroupTreeNode) => Promise<void>;
  showSkillHistory: (node?: SkillTreeNode) => Promise<void>;
  showNodeWarningReasons: (side: TreeSide, node?: SkillTreeNode) => Promise<void>;
  openTransferExplorerPanel: () => Promise<void>;
  openLibraryManagerPanel: () => Promise<void>;
  openAddMoveWizardPanel: () => Promise<void>;
  hydrateCurrentProject: () => Promise<void>;
  downloadCentralSkillToWorkspace: () => Promise<void>;
  downloadSkillManagerSkillToWorkspace: () => Promise<void>;
  createCentralPack: () => Promise<void>;
  openProjectPresetOverview: (node?: unknown) => Promise<void>;
  applyProjectPreset: (node?: unknown) => Promise<void>;
  createProjectPresetFromCentral: () => Promise<void>;
  createProjectPresetFromWorkspace: (node?: SkillTreeNode) => Promise<void>;
  createProjectPresetFromWorkspaceGroup: (node?: unknown) => Promise<void>;
  renameProjectPreset: (node?: unknown) => Promise<void>;
  editProjectPresetDescription: (node?: unknown) => Promise<void>;
  deleteProjectPreset: (node?: unknown) => Promise<void>;
  repairCentralMetadata: () => Promise<void>;
  runEnvironmentDiagnosis: () => Promise<void>;
  getAutoSyncWorkspaceAgents: () => ToolType[];
  resolveWorkspaceAutoSyncToolFromNode: (node?: SkillTreeNode) => ToolType | undefined;
  formatAgentFolderLabel: (tool: ToolType) => string;
  toggleWorkspaceAgentAutoSync: (tool: ToolType) => Promise<boolean>;
  syncWorkspaceAgentToCentralNow: (tool: ToolType) => Promise<{ summary: { syncedFolders: number; copied: number; deleted: number; mirroredGroups: number; centralFolders: number; centralFiles: number; skippedMissingSkillMd: number } }>;
  setLanguage: (language: UiLanguage) => Promise<void>;
  applyLanguageChrome: () => void;
  updateStatusChrome: () => void;
  applyTabFilter: () => void;
  setPersonalSkillHome: () => Promise<void>;
  runResetPersonalHome: () => Promise<void>;
  promoteSelected: (node?: SkillTreeNode) => Promise<void>;
  importSelected: (node?: SkillTreeNode) => Promise<void>;
  exportGroup: (side: TreeSide) => Promise<unknown>;
}): void {
  const findWorkspaceFile = async (fileName: string): Promise<vscode.Uri | null> => {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const uri = vscode.Uri.joinPath(folder.uri, fileName);
      try {
        await vscode.workspace.fs.stat(uri);
        return uri;
      } catch {
        // Try the next workspace folder.
      }
    }
    return null;
  };

  const findWorkspaceWithPackageScript = async (scriptName: string): Promise<vscode.WorkspaceFolder | null> => {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const packageUri = vscode.Uri.joinPath(folder.uri, "package.json");
      try {
        const bytes = await vscode.workspace.fs.readFile(packageUri);
        const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as { scripts?: Record<string, unknown> };
        if (parsed.scripts && typeof parsed.scripts[scriptName] === "string") return folder;
      } catch {
        // Ignore malformed or missing package.json files in multi-root workspaces.
      }
    }
    return null;
  };

  const openPerformanceToolsCommand = async (): Promise<void> => {
    try {
      const checkCommand = "npm run check:performance";
      const comparerCheckCommand = "npm run check:file-ops-comparers";
      const benchmarkCommand = "npm run benchmark:file-ops:dist -- --preset smoke --include-control";
      const loadingBenchmarkCommand = "npm run benchmark:file-ops:dist -- --preset loading --include-control";
      const prepareArtifactsCommand = "npm run prepare:performance-artifacts -- --out-dir .benchmarks";
      const refreshTimingSummaryCommand = "npm run summarize:refresh-timings -- --input .benchmarks/refresh.log --summary .benchmarks/refresh-summary.md";
      const refreshTimingBaselineCommand = "npm run summarize:refresh-timings -- --input .benchmarks/refresh.log --write .benchmarks/refresh-baseline.json";
      const refreshTimingCompareCommand = "npm run summarize:refresh-timings -- --input .benchmarks/refresh-new.log --compare .benchmarks/refresh-baseline.json --fail-on-median-regression 25";
      const refreshTimingCheckCommand = "npm run check:refresh-timings";
      const compareBenchmarkCommand = "npm run compare:file-ops-artifacts -- --dir .benchmarks/artifacts --summary .benchmarks/file-ops-artifacts.md --require-matrix --require-preset smoke";
      const compareLoadingBenchmarkCommand = "npm run compare:loading-file-ops-artifacts -- --dir .benchmarks/loading-artifacts --summary .benchmarks/loading-file-ops-artifacts.md --require-matrix --require-preset loading";
      const compareTransferBenchmarkCommand = "npm run compare:transfer-file-ops-artifacts -- --dir .benchmarks/transfer-artifacts --summary .benchmarks/transfer-file-ops-artifacts.md --require-matrix --require-preset transfer";
      const compareSmokeCommand = "npm run compare:smoke-file-ops-artifacts -- --dir .benchmarks/smoke-artifacts --summary .benchmarks/smoke-file-ops-artifacts.md --require-matrix";
      const compareVsixCommand = "npm run compare:vsix-artifacts -- --dir .benchmarks/vsix-artifacts --summary .benchmarks/vsix-artifacts.md --require-matrix";
      const artifactLayoutNote = "# Download CI artifacts into .benchmarks/artifacts, .benchmarks/loading-artifacts, .benchmarks/transfer-artifacts, .benchmarks/smoke-artifacts, and .benchmarks/vsix-artifacts before artifact comparisons.";
      const verifyArtifactsCommand = "npm run verify:performance-artifacts -- --benchmark-dir .benchmarks/artifacts --loading-dir .benchmarks/loading-artifacts --transfer-dir .benchmarks/transfer-artifacts --smoke-dir .benchmarks/smoke-artifacts --vsix-dir .benchmarks/vsix-artifacts --out-dir .benchmarks";
      const reportCommand = "npm run report:performance-status -- --summary .benchmarks/performance-status.md";
      const pick = await vscode.window.showQuickPick(
        [
          {
            label: args.tr("Open Benchmark Guide", "벤치마크 가이드 열기"),
            description: "BENCHMARKS.md",
            value: "guide" as const
          },
          {
            label: args.tr("Run Local Performance Check", "로컬 성능 체크 실행"),
            description: checkCommand,
            value: "run" as const
          },
          {
            label: args.tr("Open Performance Status", "성능 상태 리포트 열기"),
            description: ".benchmarks/performance-status.md",
            value: "status" as const
          },
          {
            label: args.tr("Copy Performance Commands", "성능 명령 복사"),
            description: args.tr("Copy local checks, benchmarks, refresh timing, and CI artifact comparison commands", "로컬 체크/벤치마크/refresh timing/CI 아티팩트 비교 명령 복사"),
            value: "copy" as const
          }
        ],
        {
          title: args.tr("Skill Bridge Performance Tools", "Skill Bridge 성능 도구"),
          matchOnDescription: true
        }
      );
      if (!pick) return;

      if (pick.value === "guide") {
        const guide = await findWorkspaceFile("BENCHMARKS.md");
        if (!guide) {
          vscode.window.showWarningMessage(args.tr(
            "BENCHMARKS.md was not found in this workspace.",
            "이 작업공간에서 BENCHMARKS.md를 찾지 못했습니다."
          ));
          return;
        }
        await vscode.window.showTextDocument(guide, { preview: true });
        return;
      }

      if (pick.value === "status") {
        const status = await findWorkspaceFile(".benchmarks/performance-status.md");
        if (!status) {
          vscode.window.showWarningMessage(args.tr(
            "Performance status was not found. Run the local performance check first.",
            "성능 상태 리포트를 찾지 못했습니다. 먼저 로컬 성능 체크를 실행하세요."
          ));
          return;
        }
        await vscode.window.showTextDocument(status, { preview: true });
        return;
      }

      if (pick.value === "run") {
        const folder = await findWorkspaceWithPackageScript("check:performance");
        if (!folder) {
          vscode.window.showWarningMessage(args.tr(
            "No workspace package.json with check:performance was found.",
            "check:performance 스크립트가 있는 package.json을 찾지 못했습니다."
          ));
          return;
        }
        const terminal = vscode.window.createTerminal({ name: "Skill Bridge Performance", cwd: folder.uri.fsPath });
        terminal.show();
        terminal.sendText(checkCommand);
        return;
      }

      await vscode.env.clipboard.writeText([
        checkCommand,
        comparerCheckCommand,
        benchmarkCommand,
        loadingBenchmarkCommand,
        refreshTimingSummaryCommand,
        refreshTimingBaselineCommand,
        refreshTimingCompareCommand,
        refreshTimingCheckCommand,
        prepareArtifactsCommand,
        artifactLayoutNote,
        compareBenchmarkCommand,
        compareLoadingBenchmarkCommand,
        compareTransferBenchmarkCommand,
        compareSmokeCommand,
        compareVsixCommand,
        verifyArtifactsCommand,
        reportCommand
      ].join("\n"));
      vscode.window.showInformationMessage(args.tr("Performance commands copied.", "성능 명령을 복사했습니다."));
    } catch (error) {
      await args.handleError(error);
    }
  };

  const unwrapSkillNodes = (items: unknown): SkillTreeNode[] => {
    if (!Array.isArray(items)) return [];
    const nodes: SkillTreeNode[] = [];
    for (const item of items) {
      const node = args.unwrapSkillNode(item);
      if (node) nodes.push(node);
    }
    return nodes;
  };

  const deleteSelectedGroup = async (node?: GroupTreeNode): Promise<void> => {
    try {
      if (!args.state.workspacePath) await args.refresh();
      const targetId = node?.kind === "group" ? node.id : args.state.selectedGroupId;
      if (!targetId) {
        vscode.window.showWarningMessage(args.tr("Select a group to delete.", "삭제할 그룹을 선택하세요."));
        return;
      }
      const group = args.state.groups.find((item) => item.id === targetId);
      if (!group) return;
      const ok = await vscode.window.showWarningMessage(
        args.tr(`Delete group "${group.name}"?`, `그룹 "${group.name}"을 삭제할까요?`),
        { modal: true },
        args.tr("Delete", "삭제")
      );
      if (ok !== args.tr("Delete", "삭제")) return;
      args.state.groups = args.state.groups.filter((item) => item.id !== targetId);
      await args.saveSelectionGroups(args.state.workspacePath, args.state.centralRepoPath, args.state.groups);
      if (args.state.selectedGroupId === targetId) args.state.selectedGroupId = null;
      args.workspaceProvider.setGroups(args.state.groups);
      args.centralProvider.setGroups(args.state.groups);
      args.workspaceProvider.setSelectedGroup(args.state.selectedGroupId);
      args.centralProvider.setSelectedGroup(args.state.selectedGroupId);
      args.workspaceProvider.setHighlight(new Set());
      args.centralProvider.setHighlight(new Set());
      vscode.window.showInformationMessage(args.tr(`Group deleted: ${group.name}`, `그룹 삭제 완료: ${group.name}`));
    } catch (error) {
      await args.handleError(error);
    }
  };

  const configureWorkspaceAutoSync = async (): Promise<void> => {
    try {
      const picks = await vscode.window.showQuickPick(
        args.state.agents.map((tool) => ({
          label: tool === "agents" ? ".agents" : `.${tool}`,
          description: args.tr("Automatically save this workspace agent's changed skills to Central", "이 작업공간 에이전트의 변경 스킬을 중앙에 자동 반영"),
          picked: args.getAutoSyncWorkspaceAgents().includes(tool),
          value: tool
        })),
        {
          canPickMany: true,
          title: args.tr("Choose Workspace Agents for Auto Save to Central", "자동 중앙 반영할 작업공간 에이전트 선택"),
          placeHolder: args.tr("Only selected workspace agents will save changed skills to Central automatically.", "선택한 작업공간 에이전트만 변경된 스킬을 중앙에 자동 반영합니다.")
        }
      );
      if (!picks) return;
      const selected = picks.map((pick) => pick.value);
      await vscode.workspace.getConfiguration(args.settingsSection).update("autoSyncWorkspaceAgents", selected, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(
        selected.length > 0
          ? args.tr(`Auto save to Central enabled for: ${selected.join(", ")}`, `자동 중앙 반영 설정 완료: ${selected.join(", ")}`)
          : args.tr("Auto save to Central disabled.", "자동 중앙 반영을 껐습니다.")
      );
    } catch (error) {
      await args.handleError(error);
    }
  };

  const toggleWorkspaceAgentAutoSyncCommand = async (node?: SkillTreeNode): Promise<void> => {
    try {
      const presetTool = args.resolveWorkspaceAutoSyncToolFromNode(args.unwrapSkillNode(node));
      let tool = presetTool;
      if (!tool) {
        const picked = await vscode.window.showQuickPick(
          args.state.agents.map((agent) => ({
            label: args.formatAgentFolderLabel(agent),
            description: args.getAutoSyncWorkspaceAgents().includes(agent)
              ? args.tr("Auto save to Central is on", "자동 중앙 반영 켜짐")
              : args.tr("Auto save to Central is off", "자동 중앙 반영 꺼짐"),
            value: agent
          })),
          {
            title: args.tr("Turn Auto Save to Central On or Off", "자동 중앙 반영 켜기/끄기"),
            placeHolder: args.tr("Choose a workspace agent to turn auto save to Central on or off.", "자동 중앙 반영을 켜거나 끌 작업공간 에이전트를 고르세요.")
          }
        );
        if (!picked) return;
        tool = picked.value;
      }
      const enabled = await args.toggleWorkspaceAgentAutoSync(tool);
      vscode.window.showInformationMessage(enabled
        ? args.tr(`Auto save to Central turned on for ${args.formatAgentFolderLabel(tool)}.`, `${args.formatAgentFolderLabel(tool)} 자동 중앙 반영을 켰습니다.`)
        : args.tr(`Auto save to Central turned off for ${args.formatAgentFolderLabel(tool)}.`, `${args.formatAgentFolderLabel(tool)} 자동 중앙 반영을 껐습니다.`));
    } catch (error) {
      await args.handleError(error);
    }
  };

  const syncWorkspaceAgentNowCommand = async (node?: SkillTreeNode): Promise<void> => {
    try {
      if (!args.state.workspacePath || !args.state.centralRepoPath) await args.refresh();
      const presetTool = args.resolveWorkspaceAutoSyncToolFromNode(args.unwrapSkillNode(node));
      let tool = presetTool;
      if (!tool) {
        const picked = await vscode.window.showQuickPick(
          args.state.agents.map((agent) => ({
            label: args.formatAgentFolderLabel(agent),
            description: args.tr("Save all current workspace skills for this agent to Central now", "이 에이전트의 현재 작업공간 스킬 전체를 지금 중앙에 반영"),
            value: agent
          })),
          {
            title: args.tr("Choose Workspace Agent to Save to Central", "중앙에 반영할 작업공간 에이전트 선택"),
            placeHolder: args.tr("This copies the selected workspace agent's skill folders to Central and mirrors only related groups.", "선택한 작업공간 에이전트의 스킬 폴더를 중앙에 복사하고 관련 그룹만 미러링합니다.")
          }
        );
        if (!picked) return;
        tool = picked.value;
      }
      const { summary } = await args.syncWorkspaceAgentToCentralNow(tool);
      const skippedSuffix = summary.skippedMissingSkillMd > 0
        ? args.tr(` · skipped missing SKILL.md ${summary.skippedMissingSkillMd}`, ` · SKILL.md 없음 제외 ${summary.skippedMissingSkillMd}개`)
        : "";
      const message = args.tr(
        `Workspace agent saved to Central: ${tool} · folders ${summary.syncedFolders} · copied ${summary.copied} · deleted ${summary.deleted} · groups ${summary.mirroredGroups} · central ${summary.centralFolders} folder(s), ${summary.centralFiles} file(s)${skippedSuffix}`,
        `작업공간 에이전트 중앙 반영 완료: ${tool} · 폴더 ${summary.syncedFolders}개 · 복사 ${summary.copied}개 · 삭제 ${summary.deleted}개 · 그룹 ${summary.mirroredGroups}개 · 중앙 확인 폴더 ${summary.centralFolders}개, 파일 ${summary.centralFiles}개${skippedSuffix}`
      );
      if (summary.skippedMissingSkillMd > 0 && summary.copied === 0 && summary.centralFiles === 0) {
        vscode.window.showWarningMessage(message);
      } else {
        vscode.window.showInformationMessage(message);
      }
    } catch (error) {
      await args.handleError(error);
    }
  };

  const switchTabCommand = async (): Promise<void> => {
    const visibleAgents = new Set(sourceTabToVisibleAgents(args.state.activeTab, args.state.agents));
    const picks = await vscode.window.showQuickPick(
      [
        { label: ".claude", description: args.tr("Claude skills", "Claude 스킬"), value: "claude" as ToolType },
        { label: ".codex", description: args.tr("Codex skills", "Codex 스킬"), value: "codex" as ToolType },
        { label: ".gemini", description: args.tr("Gemini skills", "Gemini 스킬"), value: "gemini" as ToolType },
        { label: ".cursor", description: args.tr("Cursor skills", "Cursor 스킬"), value: "cursor" as ToolType },
        { label: ".antigravity", description: args.tr("Antigravity skills", "Antigravity 스킬"), value: "antigravity" as ToolType },
        { label: ".agents", description: args.tr("Shared agents skills", "공유 agents 스킬"), value: "agents" as ToolType }
      ].filter((item) => args.state.agents.includes(item.value)).map((item) => ({
        ...item,
        picked: visibleAgents.has(item.value)
      })),
      {
        title: args.tr("Choose Skill Source Agents", "볼 에이전트 선택"),
        placeHolder: args.tr("Select one or more agents. Selecting all or none shows all.", "하나 이상 선택하세요. 전체 또는 미선택은 전체 보기입니다."),
        matchOnDescription: true,
        canPickMany: true
      }
    );
    if (!picks) return;
    const nextAgents = picks.map((pick) => pick.value);
    args.state.activeTab = normalizeSourceTab(nextAgents, args.state.agents);
    await vscode.workspace.getConfiguration(args.settingsSection).update(
      "visibleAgents",
      args.state.activeTab === "all" ? [] : args.state.activeTab,
      vscode.ConfigurationTarget.Global
    );
    args.applyTabFilter();
    args.updateStatusChrome();
    vscode.window.showInformationMessage(
      args.state.activeTab === "all"
        ? args.tr("Agent view set to all agents.", "에이전트 보기를 전체로 설정했습니다.")
        : args.tr(`Agent view set to: ${args.state.activeTab.join(", ")}`, `에이전트 보기: ${args.state.activeTab.join(", ")}`)
    );
  };

  const switchTreeFilterCommand = async (): Promise<void> => {
    const pick = await vscode.window.showQuickPick(
      [
        { label: args.tr("All", "전체"), description: args.tr("All skills", "모든 스킬"), value: "all" as SkillTreeFilterMode },
        { label: args.tr("Changed", "변경"), description: args.tr("Skills with content that differs from the opposite side", "반대편과 내용이 다른 스킬"), value: "changed" as SkillTreeFilterMode },
        { label: args.tr("New", "신규"), description: args.tr("Skills that exist only on the current side", "현재 쪽에만 있는 스킬"), value: "new" as SkillTreeFilterMode },
        { label: args.tr("Warnings", "경고"), description: args.tr("Skills with sensitive data, scripts, absolute paths, or other warnings", "민감정보, 스크립트, 절대경로 등 경고가 있는 스킬"), value: "risk" as SkillTreeFilterMode },
        { label: args.tr("Missing SKILL.md", "SKILL.md 없음"), description: args.tr("Folders without a skill manifest", "스킬 매니페스트가 없는 폴더"), value: "missingSkillMd" as SkillTreeFilterMode },
        { label: args.tr("Recent", "최근"), description: args.tr("Skills modified in the last 7 days", "최근 7일 안에 수정된 스킬"), value: "recent" as SkillTreeFilterMode }
      ],
      { title: args.tr("Choose Tree Filter", "트리 필터 선택"), matchOnDescription: true }
    );
    if (!pick) return;
    args.state.treeFilter = pick.value;
    args.workspaceProvider.setFilterMode(args.state.treeFilter);
    args.centralProvider.setFilterMode(args.state.treeFilter);
    vscode.window.setStatusBarMessage(args.tr(`Skill Bridge: tree filter ${pick.label}`, `Skill Bridge: 트리 필터 ${pick.label}`), 2000);
  };

  const manageQuickToolsCommand = async (): Promise<void> => {
    const language = coerceUiLanguage(vscode.workspace.getConfiguration(args.settingsSection).get<string>("language", DEFAULT_UI_LANGUAGE));
    const configured = vscode.workspace.getConfiguration(args.settingsSection).get<string[]>("visibleQuickTools", []);
    const visible = configured.length > 0 ? new Set(configured) : DEFAULT_QUICK_TOOL_COMMANDS;
    const tools = Object.values(buildCommonToolNodes(language)).flat().filter((tool) => tool.command !== MANAGE_QUICK_TOOLS_COMMAND);
    const picks = await vscode.window.showQuickPick(
      tools.map((tool) => ({ label: tool.label, description: tool.description, detail: tool.command, picked: visible.has(tool.command), value: tool.command })),
      { title: args.tr("Manage Quick Tools", "빠른 도구 관리"), placeHolder: args.tr("Choose the tools to show in Quick Tools.", "빠른 도구에 표시할 도구를 선택하세요."), canPickMany: true, matchOnDescription: true, matchOnDetail: true }
    );
    if (!picks) return;
    const selected = picks.map((pick) => pick.value);
    await vscode.workspace.getConfiguration(args.settingsSection).update("visibleQuickTools", selected, vscode.ConfigurationTarget.Global);
    args.applyTabFilter();
    vscode.window.showInformationMessage(args.tr(`Quick Tools updated: ${selected.length} visible`, `빠른 도구 표시 설정 완료: ${selected.length}개`));
  };

  args.register("skillBridge.selectWorkspaceNode", (node: SkillTreeNode) => {
    args.state.workspaceSelection = [node];
    args.state.centralSelection = [];
    args.workspaceProvider.setSelected(node);
    args.centralProvider.setSelected(null);
    void args.openNodeIfFile(args.state.workspacePath, node, "workspace");
  });
  args.register("skillBridge.selectCentralNode", (node: SkillTreeNode) => {
    args.state.centralSelection = [node];
    args.state.workspaceSelection = [];
    args.centralProvider.setSelected(node);
    args.workspaceProvider.setSelected(null);
    void args.openNodeIfFile(args.state.centralRepoPath, node, "central");
  });
  args.register("skillBridge.openWorkspaceFolder", async (node?: SkillTreeNode) => {
    await args.openFolderInOs("workspace", args.unwrapSkillNode(node));
  });
  args.register("skillBridge.openCentralFolder", async (node?: SkillTreeNode) => {
    await args.openFolderInOs("central", args.unwrapSkillNode(node));
  });
  args.register("skillBridge.selectGroup", async (node: GroupTreeNode) => {
    if (node.kind !== "group") return;
    const group = args.state.groups.find((item) => item.id === node.id);
    if (!group) return;
    if (args.state.selectedGroupId === group.id) {
      args.state.selectedGroupId = null;
      args.workspaceProvider.setSelectedGroup(null);
      args.centralProvider.setSelectedGroup(null);
      args.workspaceProvider.setHighlight(new Set());
      args.centralProvider.setHighlight(new Set());
    } else {
      args.state.selectedGroupId = group.id;
      args.workspaceProvider.setSelectedGroup(group.id);
      args.centralProvider.setSelectedGroup(group.id);
      args.applyGroupHighlight(group);
    }
    vscode.window.setStatusBarMessage(`Skill Bridge: selected group ${group.name} (targets ${group.targets.length})`, 2000);
  });
  args.register("skillBridge.groupActions", async (node?: GroupTreeNode) => {
    await args.showGroupActions(node);
  });
  args.register("skillBridge.openGroupOverview", async (node?: GroupTreeNode) => {
    await args.openGroupOverview(node);
  });
  args.register("skillBridge.openNpxSkillLibrary", async () => {
    await args.openNpxSkillLibrary();
  });
  args.register("skillBridge.workspaceGroupActions", async (node?: GroupTreeNode) => {
    await args.showGroupActions(node);
  });
  args.register("skillBridge.centralGroupActions", async (node?: GroupTreeNode) => {
    await args.showGroupActions(node);
  });
  args.register("skillBridge.renameGroup", async (node?: GroupTreeNode) => {
    await args.renameGroup(node);
  });
  args.register("skillBridge.editGroupDescription", async (node?: GroupTreeNode) => {
    await args.editGroupDescription(node);
  });
  args.register("skillBridge.deleteGroup", async (node?: GroupTreeNode) => {
    await deleteSelectedGroup(node);
  });
  args.register("skillBridge.createWorkspaceGroupFromNode", async (node: SkillTreeNode) => {
    const target = args.unwrapSkillNode(node);
    if (target) await args.createGroupFromSelection("workspace", args.resolveGroupingNodes("workspace", target));
  });
  args.register("skillBridge.createCentralGroupFromNode", async (node: SkillTreeNode) => {
    const target = args.unwrapSkillNode(node);
    if (target) await args.createGroupFromSelection("central", args.resolveGroupingNodes("central", target));
  });
  args.register("skillBridge.addWorkspaceSelectionToGroup", async (node?: SkillTreeNode) => {
    await args.addSelectionToExistingGroup("workspace", args.unwrapSkillNode(node));
  });
  args.register("skillBridge.addCentralSelectionToGroup", async (node?: SkillTreeNode) => {
    await args.addSelectionToExistingGroup("central", args.unwrapSkillNode(node));
  });
  args.register("skillBridge.createWorkspaceFolder", async (node?: SkillTreeNode) => {
    await args.createSkillItem("workspace", "folder", args.unwrapSkillNode(node));
  });
  args.register("skillBridge.createWorkspaceFile", async (node?: SkillTreeNode) => {
    await args.createSkillItem("workspace", "file", args.unwrapSkillNode(node));
  });
  args.register("skillBridge.createWorkspaceSkill", async (node?: SkillTreeNode) => {
    await args.createSkillFolder("workspace", args.unwrapSkillNode(node));
  });
  args.register("skillBridge.createCentralFolder", async (node?: SkillTreeNode) => {
    await args.createSkillItem("central", "folder", args.unwrapSkillNode(node));
  });
  args.register("skillBridge.createCentralFile", async (node?: SkillTreeNode) => {
    await args.createSkillItem("central", "file", args.unwrapSkillNode(node));
  });
  args.register("skillBridge.createCentralSkill", async (node?: SkillTreeNode) => {
    await args.createSkillFolder("central", args.unwrapSkillNode(node));
  });
  args.register("skillBridge.quickWorkspaceCrud", async (node?: SkillTreeNode) => {
    await args.showQuickSkillCrud("workspace", args.unwrapSkillNode(node));
  });
  args.register("skillBridge.quickCentralCrud", async (node?: SkillTreeNode) => {
    await args.showQuickSkillCrud("central", args.unwrapSkillNode(node));
  });
  args.register("skillBridge.smartWorkspaceActions", async (node?: SkillTreeNode) => {
    await args.showSmartActions("workspace", args.unwrapSkillNode(node));
  });
  args.register("skillBridge.smartCentralActions", async (node?: SkillTreeNode) => {
    await args.showSmartActions("central", args.unwrapSkillNode(node));
  });
  args.register("skillBridge.renameWorkspaceNode", async (node?: SkillTreeNode) => {
    await args.runNodeCrud("workspace", "rename", args.unwrapSkillNode(node));
  });
  args.register("skillBridge.renameCentralNode", async (node?: SkillTreeNode) => {
    await args.runNodeCrud("central", "rename", args.unwrapSkillNode(node));
  });
  args.register("skillBridge.deleteWorkspaceNode", async (node?: unknown, selectedItems?: unknown) => {
    await args.runNodeCrud("workspace", "delete", args.unwrapSkillNode(node), unwrapSkillNodes(selectedItems));
  });
  args.register("skillBridge.deleteCentralNode", async (node?: unknown, selectedItems?: unknown) => {
    await args.runNodeCrud("central", "delete", args.unwrapSkillNode(node), unwrapSkillNodes(selectedItems));
  });
  args.register("skillBridge.duplicateWorkspaceNode", async (node?: SkillTreeNode) => {
    await args.runNodeCrud("workspace", "duplicate", args.unwrapSkillNode(node));
  });
  args.register("skillBridge.duplicateCentralNode", async (node?: SkillTreeNode) => {
    await args.runNodeCrud("central", "duplicate", args.unwrapSkillNode(node));
  });
  args.register("skillBridge.copyWorkspaceNode", async (node?: SkillTreeNode) => {
    args.copyNodesToClipboard("workspace", args.unwrapSkillNode(node));
  });
  args.register("skillBridge.copyCentralNode", async (node?: SkillTreeNode) => {
    args.copyNodesToClipboard("central", args.unwrapSkillNode(node));
  });
  args.register("skillBridge.copyWorkspaceNodePath", async (node?: SkillTreeNode) => {
    await args.copyNodePathToClipboard("workspace", args.unwrapSkillNode(node));
  });
  args.register("skillBridge.copyCentralNodePath", async (node?: SkillTreeNode) => {
    await args.copyNodePathToClipboard("central", args.unwrapSkillNode(node));
  });
  args.register("skillBridge.pasteWorkspaceNode", async (node?: SkillTreeNode) => {
    await args.pasteNodesFromClipboard("workspace", args.unwrapSkillNode(node));
  });
  args.register("skillBridge.pasteCentralNode", async (node?: SkillTreeNode) => {
    await args.pasteNodesFromClipboard("central", args.unwrapSkillNode(node));
  });
  args.register("skillBridge.installSkills", async (node?: SkillTreeNode) => {
    await args.installSkills(args.unwrapSkillNode(node));
  });
  args.register("skillBridge.copyBetweenAgents", async () => {
    await args.runAgentCopyWizard();
    await args.refresh();
  });
  args.register("skillBridge.copyWorkspaceBetweenAgents", async (node?: SkillTreeNode) => {
    await args.runAgentCopyWizard("workspace", args.unwrapSkillNode(node));
    await args.refresh();
  });
  args.register("skillBridge.copyCentralBetweenAgents", async (node?: SkillTreeNode) => {
    await args.runAgentCopyWizard("central", args.unwrapSkillNode(node));
    await args.refresh();
  });
  args.register("skillBridge.copyWorkspaceGroupBetweenAgents", async (node?: GroupTreeNode) => {
    await args.runGroupAgentCopyWizard("workspace", node);
  });
  args.register("skillBridge.copyCentralGroupBetweenAgents", async (node?: GroupTreeNode) => {
    await args.runGroupAgentCopyWizard("central", node);
  });
  args.register("skillBridge.viewSkillHistory", async (node?: SkillTreeNode) => {
    await args.showSkillHistory(args.unwrapSkillNode(node));
  });
  args.register("skillBridge.showWorkspaceWarningReasons", async (node?: SkillTreeNode) => {
    await args.showNodeWarningReasons("workspace", args.unwrapSkillNode(node));
  });
  args.register("skillBridge.showCentralWarningReasons", async (node?: SkillTreeNode) => {
    await args.showNodeWarningReasons("central", args.unwrapSkillNode(node));
  });
  args.register("skillBridge.openTransferExplorer", async () => {
    await args.openTransferExplorerPanel();
  });
  args.register("skillBridge.openLibraryManager", async () => {
    await args.openLibraryManagerPanel();
  });
  args.register("skillBridge.openAddMoveWizard", async () => {
    await args.openAddMoveWizardPanel();
  });
  args.register("skillBridge.hydrateProject", async () => {
    await args.hydrateCurrentProject();
  });
  args.register("skillBridge.downloadCentralSkill", async () => {
    await args.downloadCentralSkillToWorkspace();
  });
  args.register("skillBridge.downloadSkillManagerSkill", async () => {
    await args.downloadSkillManagerSkillToWorkspace();
  });
  args.register("skillBridge.createCentralPack", async () => {
    await args.createProjectPresetFromCentral();
  });
  args.register("skillBridge.openProjectPresetOverview", async (node?: unknown) => {
    await args.openProjectPresetOverview(node);
  });
  args.register("skillBridge.applyProjectPreset", async (node?: unknown) => {
    await args.applyProjectPreset(node);
  });
  args.register("skillBridge.createProjectPresetFromCentral", async () => {
    await args.createProjectPresetFromCentral();
  });
  args.register("skillBridge.createProjectPresetFromWorkspace", async (node?: SkillTreeNode) => {
    await args.createProjectPresetFromWorkspace(args.unwrapSkillNode(node));
  });
  args.register("skillBridge.createProjectPresetFromWorkspaceGroup", async (node?: unknown) => {
    await args.createProjectPresetFromWorkspaceGroup(node);
  });
  args.register("skillBridge.renameProjectPreset", async (node?: unknown) => {
    await args.renameProjectPreset(node);
  });
  args.register("skillBridge.editProjectPresetDescription", async (node?: unknown) => {
    await args.editProjectPresetDescription(node);
  });
  args.register("skillBridge.deleteProjectPreset", async (node?: unknown) => {
    await args.deleteProjectPreset(node);
  });
  args.register("skillBridge.repairCentralMetadata", async () => {
    await args.repairCentralMetadata();
  });
  args.register("skillBridge.diagnoseEnvironment", async () => {
    await args.runEnvironmentDiagnosis();
  });
  args.register("skillBridge.openPerformanceTools", async () => {
    await openPerformanceToolsCommand();
  });
  args.register("skillBridge.configureWorkspaceAutoSync", async () => {
    await configureWorkspaceAutoSync();
  });
  args.register("skillBridge.toggleWorkspaceAgentAutoSync", async (node?: SkillTreeNode) => {
    await toggleWorkspaceAgentAutoSyncCommand(node);
  });
  args.register("skillBridge.syncWorkspaceAgentNow", async (node?: SkillTreeNode) => {
    await syncWorkspaceAgentNowCommand(node);
  });
  args.register("skillBridge.toggleLanguage", async () => {
    const current = vscode.workspace.getConfiguration(args.settingsSection).get<string>("language", DEFAULT_UI_LANGUAGE);
    const currentLanguage = coerceUiLanguage(current);
    const next = getNextUiLanguage(currentLanguage);
    await args.setLanguage(next);
    const selected = getUiLanguageOption(next);
    vscode.window.showInformationMessage(
      next === "ko"
        ? args.tr("Skill Bridge language switched to Korean.", "Skill Bridge 언어를 한국어로 전환했습니다.")
        : `${args.tr("Skill Bridge language switched to", "Skill Bridge 언어를")} ${selected.label}${args.tr(".", "로 전환했습니다.")}`
    );
  });
  args.register("skillBridge.setPersonalHome", async () => {
    await args.setPersonalSkillHome();
  });
  args.register("skillBridge.resetPersonalHome", async () => {
    await args.runResetPersonalHome();
  });
  args.register("skillBridge.refresh", async () => {
    try {
      await args.refresh();
    } catch (error) {
      await args.handleError(error);
    }
  });
  args.register("skillBridge.switchTab", async () => {
    await switchTabCommand();
  });
  args.register("skillBridge.switchTreeFilter", async () => {
    await switchTreeFilterCommand();
  });
  args.register("skillBridge.manageQuickTools", async () => {
    await manageQuickToolsCommand();
  });
  args.register("skillBridge.promoteSelected", async (node?: SkillTreeNode) => {
    await args.promoteSelected(args.unwrapSkillNode(node));
  });
  args.register("skillBridge.importSelected", async (node?: SkillTreeNode) => {
    await args.importSelected(args.unwrapSkillNode(node));
  });
  args.register("skillBridge.createWorkspaceGroup", async () => {
    await args.createGroupFromSelection("workspace");
  });
  args.register("skillBridge.createCentralGroup", async () => {
    await args.createGroupFromSelection("central");
  });
  args.register("skillBridge.promoteGroup", async () => {
    await args.exportGroup("workspace");
  });
  args.register("skillBridge.importGroup", async () => {
    await args.exportGroup("central");
  });
}
