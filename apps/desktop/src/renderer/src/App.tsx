import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";

type ToolType = "claude" | "codex" | "gemini" | "cursor" | "antigravity";
type SkillSource = "workspace" | "central";
type TreeSide = "workspace" | "central";
type Selection = { tool: ToolType; relativePath: string };
type Skill = { tool: ToolType; relativePath: string; absolutePath: string };
type WorkspaceEntry = { id: string; name: string; path: string };
type DiffData = { hasChanges: boolean; oldText: string; newText: string; unifiedDiff: string };
type UpdateCandidate = { tool: ToolType; relativePath: string; diff: DiffData };
type WorkspaceInfo = {
  workspacePath: string;
  statuses: Array<{ tool: ToolType; workspaceDir: string; exists: boolean }>;
  workspaceSkills: Skill[];
};
type Config = {
  centralRepo: string;
  autoPush: boolean;
  defaultTool: ToolType;
  fontSize: number;
  workspaces: WorkspaceEntry[];
  activeWorkspaceId: string | null;
};
type DiffStatItem = {
  tool: ToolType;
  relativePath: string;
  status: "changed" | "onlyWorkspace" | "onlyCentral";
  workspaceBytes: number;
  centralBytes: number;
  sizeDelta: number;
  addedLines: number;
  removedLines: number;
  lineDelta: number;
};
type OverviewData = {
  totalCompared: number;
  changedCount: number;
  onlyWorkspaceCount: number;
  onlyCentralCount: number;
  sameCount: number;
  items: DiffStatItem[];
};
type GitRemoteInfo = {
  name: string;
  fetchUrl: string;
  pushUrl: string;
};
type GitDiagnostics = {
  isGitRepo: boolean;
  branch: string;
  upstream: string | null;
  changedFiles: string[];
  remotes: GitRemoteInfo[];
  originUrl: string | null;
};
type TreeNode = {
  key: string;
  side: TreeSide;
  name: string;
  type: "folder" | "file";
  tool: ToolType;
  relativePath: string;
  children: TreeNode[];
};
type TransferPreview = {
  mode: "toCentral" | "toWorkspace";
  selections: Selection[];
  existingChanged: Array<{ tool: ToolType; relativePath: string; diff: DiffData }>;
  newFiles: number;
  unchanged: number;
};
type EditorTarget = { source: SkillSource; basePath: string; tool: ToolType; relativePath: string };
type CrudAction = "createFile" | "createFolder" | "rename" | "delete" | "duplicate";
type ToolStatus = { tool: ToolType; workspaceDir: string; exists: boolean };
type ContextMenuState = {
  side: TreeSide;
  node: TreeNode;
  x: number;
  y: number;
};
type GroupTarget = {
  kind: "file" | "folder";
  tool: ToolType;
  relativePath: string;
};
type SelectionGroup = {
  id: string;
  name: string;
  side: TreeSide;
  targets: GroupTarget[];
};

const toolOrder: ToolType[] = ["claude", "codex", "gemini", "cursor", "antigravity"];
const GLOBAL_WORKSPACE_ID = "ws-global-default";

export function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [workspaceInfo, setWorkspaceInfo] = useState<WorkspaceInfo | null>(null);
  const [centralSkills, setCentralSkills] = useState<Skill[]>([]);

  const [status, setStatus] = useState("준비됨");
  const [isBusy, setIsBusy] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isSavingEditor, setIsSavingEditor] = useState(false);
  const [busyMessage, setBusyMessage] = useState("");
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [workspaceFilter, setWorkspaceFilter] = useState("");
  const [centralFilter, setCentralFilter] = useState("");
  const [treeFilterMode, setTreeFilterMode] = useState<Record<TreeSide, "text" | "group">>({
    workspace: "text",
    central: "text"
  });
  const [groupSearchSelection, setGroupSearchSelection] = useState<Record<TreeSide, string[]>>({
    workspace: [],
    central: []
  });
  const [workspaceToolFocus, setWorkspaceToolFocus] = useState<ToolType | null>(null);
  const [centralToolFocus, setCentralToolFocus] = useState<ToolType | null>(null);
  const [selectionGroups, setSelectionGroups] = useState<SelectionGroup[]>([]);
  const [activeGroupFilters, setActiveGroupFilters] = useState<Record<TreeSide, string[]>>({
    workspace: [],
    central: []
  });

  const [promptModal, setPromptModal] = useState<{
    message: string;
    defaultValue: string;
    resolve: (value: string | null) => void;
  } | null>(null);
  const [promptValue, setPromptValue] = useState("");

  const [workspaceExpanded, setWorkspaceExpanded] = useState<Record<string, boolean>>({});
  const [centralExpanded, setCentralExpanded] = useState<Record<string, boolean>>({});
  const [workspaceChecked, setWorkspaceChecked] = useState<Record<string, boolean>>({});
  const [centralChecked, setCentralChecked] = useState<Record<string, boolean>>({});
  const [workspaceActiveKey, setWorkspaceActiveKey] = useState<string | null>(null);
  const [centralActiveKey, setCentralActiveKey] = useState<string | null>(null);
  const [workspaceMulti, setWorkspaceMulti] = useState<Record<string, boolean>>({});
  const [centralMulti, setCentralMulti] = useState<Record<string, boolean>>({});
  const [workspaceAnchor, setWorkspaceAnchor] = useState<string | null>(null);
  const [centralAnchor, setCentralAnchor] = useState<string | null>(null);

  const [detailTab, setDetailTab] = useState<"editor" | "central" | "diff" | "updates" | "git">("editor");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [treePaneMode, setTreePaneMode] = useState<"narrow" | "balanced" | "wide">("narrow");
  const [leftPaneWidth, setLeftPaneWidth] = useState(520);
  const [isResizing, setIsResizing] = useState(false);
  const [stackedLayout, setStackedLayout] = useState(window.innerWidth <= 1240);
  const [preview, setPreview] = useState<TransferPreview | null>(null);
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [warnings, setWarnings] = useState<Array<{ rule: string; description: string }>>([]);
  const [updateCandidates, setUpdateCandidates] = useState<UpdateCandidate[]>([]);
  const [selectedUpdates, setSelectedUpdates] = useState<Record<string, boolean>>({});
  const [syncCommitMessage, setSyncCommitMessage] = useState("chore: sync skill bridge changes");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<{ centralRepo: string; autoPush: boolean; defaultTool: ToolType; fontSize: number }>({
    centralRepo: "",
    autoPush: true,
    defaultTool: "claude",
    fontSize: 15
  });
  const [groupSideTab, setGroupSideTab] = useState<TreeSide>("workspace");
  const [miniGroupsOpen, setMiniGroupsOpen] = useState(false);
  const [gitDiagnostics, setGitDiagnostics] = useState<GitDiagnostics | null>(null);
  const [gitBusy, setGitBusy] = useState(false);
  const [skillsCliTarget, setSkillsCliTarget] = useState<"workspace" | "central">("workspace");
  const [skillsCliCustomPath, setSkillsCliCustomPath] = useState("");
  const [skillsCliRepo, setSkillsCliRepo] = useState("https://github.com/vercel-labs/skills");
  const [skillsCliSkillNames, setSkillsCliSkillNames] = useState("");
  const [skillsCliOutput, setSkillsCliOutput] = useState("");
  const [skillsCliBusy, setSkillsCliBusy] = useState(false);

  const [editorTarget, setEditorTarget] = useState<EditorTarget | null>(null);
  const [editorText, setEditorText] = useState("");
  const [savedEditorText, setSavedEditorText] = useState("");
  const [editorEditable, setEditorEditable] = useState(false);
  const [editorMode, setEditorMode] = useState<"edit" | "view">("edit");

  const [liveDiffText, setLiveDiffText] = useState<string | null>(null);
  const [liveDiffLoading, setLiveDiffLoading] = useState(false);

  const activeWorkspace = useMemo(() => {
    if (!config?.activeWorkspaceId) return null;
    return config.workspaces.find((item) => item.id === config.activeWorkspaceId) ?? null;
  }, [config]);

  const workspaceTree = useMemo(() => buildTree("workspace", workspaceInfo?.workspaceSkills ?? []), [workspaceInfo]);
  const centralTree = useMemo(() => buildTree("central", centralSkills), [centralSkills]);
  const filteredWorkspaceTree = useMemo(() => filterTree(workspaceTree, workspaceFilter), [workspaceTree, workspaceFilter]);
  const filteredCentralTree = useMemo(() => filterTree(centralTree, centralFilter), [centralTree, centralFilter]);
  const effectiveWorkspaceGroupIds = useMemo(() => {
    const ids = new Set(activeGroupFilters.workspace);
    if (treeFilterMode.workspace === "group") {
      for (const id of groupSearchSelection.workspace) ids.add(id);
    }
    return [...ids];
  }, [activeGroupFilters.workspace, treeFilterMode.workspace, groupSearchSelection.workspace]);
  const effectiveCentralGroupIds = useMemo(() => {
    const ids = new Set(activeGroupFilters.central);
    if (treeFilterMode.central === "group") {
      for (const id of groupSearchSelection.central) ids.add(id);
    }
    return [...ids];
  }, [activeGroupFilters.central, treeFilterMode.central, groupSearchSelection.central]);
  const groupFilteredWorkspaceTree = useMemo(
    () => applyGroupFiltersToTree("workspace", filteredWorkspaceTree, effectiveWorkspaceGroupIds, selectionGroups),
    [filteredWorkspaceTree, effectiveWorkspaceGroupIds, selectionGroups]
  );
  const groupFilteredCentralTree = useMemo(
    () => applyGroupFiltersToTree("central", filteredCentralTree, effectiveCentralGroupIds, selectionGroups),
    [filteredCentralTree, effectiveCentralGroupIds, selectionGroups]
  );

  const focusedWorkspaceTree = useMemo(() => filterTreeByTool(groupFilteredWorkspaceTree, workspaceToolFocus), [groupFilteredWorkspaceTree, workspaceToolFocus]);
  const focusedCentralTree = useMemo(() => filterTreeByTool(groupFilteredCentralTree, centralToolFocus), [groupFilteredCentralTree, centralToolFocus]);
  const workspaceByKey = useMemo(() => mapNodesByKey(workspaceTree), [workspaceTree]);
  const centralByKey = useMemo(() => mapNodesByKey(centralTree), [centralTree]);
  const workspaceOrderedKeys = useMemo(() => flattenKeys(workspaceTree), [workspaceTree]);
  const centralOrderedKeys = useMemo(() => flattenKeys(centralTree), [centralTree]);

  const modalOpen = preview !== null || settingsOpen;
  const blockUi = isBusy || isSyncing || isSavingEditor;
  const editorDirty = editorText !== savedEditorText;
  const mainStripRef = useRef<HTMLElement | null>(null);
  const groupsHydratedRef = useRef(false);

  useEffect(() => {
    void initialize();
  }, []);

  useEffect(() => {
    const keyHandler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && editorEditable && editorDirty) {
        event.preventDefault();
        void saveEditor();
      }
    };
    window.addEventListener("keydown", keyHandler);
    return () => window.removeEventListener("keydown", keyHandler);
  }, [editorEditable, editorDirty, editorTarget, editorText]);

  useEffect(() => {
    if (detailTab === "updates") {
      void loadUpdates(true);
    }
  }, [detailTab]);

  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(null);
    };
    window.addEventListener("click", closeMenu);
    window.addEventListener("contextmenu", closeMenu);
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("contextmenu", closeMenu);
      window.removeEventListener("keydown", onEscape);
    };
  }, []);

  useEffect(() => {
    const onResize = () => setStackedLayout(window.innerWidth <= 1240);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!isResizing) return;

    const onMouseMove = (event: globalThis.MouseEvent) => {
      if (stackedLayout) return;
      const host = mainStripRef.current;
      if (!host) return;

      const rect = host.getBoundingClientRect();
      const rawWidth = event.clientX - rect.left;
      const minWidth = 360;
      const maxWidth = Math.max(minWidth, rect.width - 460);
      const next = Math.max(minWidth, Math.min(rawWidth, maxWidth));
      setLeftPaneWidth(next);
    };

    const onMouseUp = () => setIsResizing(false);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [isResizing, stackedLayout]);

  useEffect(() => {
    let cancelled = false;

    async function loadWorkspaceGroups() {
      if (!activeWorkspace?.path) return;
      groupsHydratedRef.current = false;
      try {
        const loaded = await window.electronAPI.loadWorkspaceGroups(activeWorkspace.path);
        if (cancelled) return;
        const groups = Array.isArray(loaded.groups) ? loaded.groups : [];
        const sanitized = sanitizeSelectionGroups(groups);
        setSelectionGroups(sanitized.groups);
        if (sanitized.removedTargets > 0 || sanitized.removedGroups > 0) {
          setStatus(`기존 그룹 정리: non-skills 타겟 ${sanitized.removedTargets}개, 빈 그룹 ${sanitized.removedGroups}개 제외`);
        }
      } catch {
        if (!cancelled) setSelectionGroups([]);
      } finally {
        if (!cancelled) groupsHydratedRef.current = true;
      }
    }

    void loadWorkspaceGroups();
    return () => {
      cancelled = true;
    };
  }, [activeWorkspace?.path]);

  useEffect(() => {
    async function persistWorkspaceGroups() {
      if (!groupsHydratedRef.current) return;
      if (!activeWorkspace?.path) return;
      try {
        await window.electronAPI.saveWorkspaceGroups({
          workspacePath: activeWorkspace.path,
          data: { version: 1, groups: selectionGroups }
        });
      } catch {
        // ignore write failures in background sync
      }
    }
    void persistWorkspaceGroups();
  }, [selectionGroups, activeWorkspace?.path]);

  useEffect(() => {
    syncCheckedWithSelectedGroups("workspace", effectiveWorkspaceGroupIds);
  }, [effectiveWorkspaceGroupIds, selectionGroups, workspaceByKey]);

  useEffect(() => {
    syncCheckedWithSelectedGroups("central", effectiveCentralGroupIds);
  }, [effectiveCentralGroupIds, selectionGroups, centralByKey]);

  function showPrompt(message: string, defaultValue = ""): Promise<string | null> {
    return new Promise((resolve) => {
      setPromptValue(defaultValue);
      setPromptModal({ message, defaultValue, resolve });
    });
  }

  async function initialize() {
    try {
      const loaded = await window.electronAPI.loadConfig();
      setConfig(loaded);
      const fontSize = loaded.fontSize ?? 15;
      document.documentElement.style.setProperty("--app-font-size", `${fontSize}px`);

      const repo = await window.electronAPI.checkCentralRepo(loaded.centralRepo);
      setStatus(repo.isGitRepo ? "설정을 불러왔습니다." : "중앙 저장소가 Git이 아닙니다. 설정에서 초기화해주세요.");

      if (loaded.activeWorkspaceId) {
        const active = loaded.workspaces.find((item) => item.id === loaded.activeWorkspaceId);
        if (active) {
          await refreshAll(active.path, loaded.centralRepo);
        }
      }
    } catch (error) {
      setStatus(`설정 로드 실패: ${String(error)}`);
    }
  }

  function clearSelections() {
    setWorkspaceChecked({});
    setCentralChecked({});
    setWorkspaceMulti({});
    setCentralMulti({});
    setWorkspaceActiveKey(null);
    setCentralActiveKey(null);
    setWorkspaceAnchor(null);
    setCentralAnchor(null);
  }

  async function refreshAll(targetWorkspacePath = activeWorkspace?.path, targetCentral = config?.centralRepo) {
    if (!targetWorkspacePath || !targetCentral) return;
    setIsBusy(true);
    setBusyMessage("목록을 새로고침하는 중...");
    try {
      const [workspace, central] = await Promise.all([
        window.electronAPI.inspectWorkspace(targetWorkspacePath),
        window.electronAPI.listCentralSkills(targetCentral)
      ]);
      setWorkspaceInfo(workspace);
      setCentralSkills(central);
      clearSelections();
      setUpdateCandidates([]);
      setSelectedUpdates({});
      void loadOverview(targetWorkspacePath, targetCentral, true);
      setStatus("목록을 갱신했습니다.");
    } catch (error) {
      setStatus(`새로고침 실패: ${String(error)}`);
    } finally {
      setIsBusy(false);
      setBusyMessage("");
    }
  }

  async function ensureCentralRepoReady() {
    if (!config) return false;
    const repo = await window.electronAPI.checkCentralRepo(config.centralRepo);
    if (repo.isGitRepo) return true;

    const ok = window.confirm(repo.exists ? "중앙 저장소가 Git이 아닙니다. 지금 Git 초기화할까요?" : "중앙 저장소 폴더를 만들고 Git 초기화할까요?");
    if (!ok) {
      setStatus("중앙 저장소 준비가 필요합니다.");
      return false;
    }

    await window.electronAPI.initializeCentralRepo(config.centralRepo);
    setStatus("중앙 저장소를 초기화했습니다.");
    return true;
  }

  async function confirmDiscardDirty(message: string) {
    if (!editorDirty) return true;
    return window.confirm(message);
  }

  async function addWorkspace() {
    if (!config || blockUi || modalOpen) return;
    const picked = await window.electronAPI.chooseDirectory();
    if (!picked) return;

    if (config.workspaces.some((item) => item.path.toLowerCase() === picked.toLowerCase())) {
      setStatus("이미 등록된 workspace입니다.");
      return;
    }

    const name = picked.split(/[\\/]/).filter(Boolean).pop() ?? "workspace";
    const entry = { id: `ws-${Date.now()}`, name, path: picked };
    const next = await window.electronAPI.saveConfig({ workspaces: [...config.workspaces, entry], activeWorkspaceId: entry.id });
    setConfig(next);
    await refreshAll(entry.path, next.centralRepo);
    setStatus(`workspace 추가: ${entry.name}`);
  }

  async function removeActiveWorkspace() {
    if (!config || !activeWorkspace || blockUi || modalOpen) return;
    if (activeWorkspace.id === GLOBAL_WORKSPACE_ID) {
      setStatus("기본 Global workspace는 삭제할 수 없습니다.");
      return;
    }

    const filtered = config.workspaces.filter((item) => item.id !== activeWorkspace.id);
    const nextActive = filtered[0]?.id ?? null;
    const next = await window.electronAPI.saveConfig({ workspaces: filtered, activeWorkspaceId: nextActive });
    setConfig(next);

    if (nextActive) {
      const ws = next.workspaces.find((item) => item.id === nextActive);
      if (ws) {
        await refreshAll(ws.path, next.centralRepo);
      }
    }

    resetEditor();
    setStatus(`workspace 삭제: ${activeWorkspace.name}`);
  }

  async function switchWorkspace(workspaceId: string) {
    if (!config || blockUi || modalOpen) return;
    if (!(await confirmDiscardDirty("저장하지 않은 변경이 있습니다. workspace를 전환할까요?"))) return;

    const next = await window.electronAPI.saveConfig({ activeWorkspaceId: workspaceId });
    setConfig(next);
    const ws = next.workspaces.find((item) => item.id === workspaceId);
    if (ws) {
      await refreshAll(ws.path, next.centralRepo);
      setTreePaneMode("narrow");
      setWorkspaceToolFocus(null);
      setCentralToolFocus(null);
      resetEditor();
      setStatus(`workspace 전환: ${ws.name}`);
    }
  }

  async function loadOverview(workspacePath = activeWorkspace?.path, centralRepoPath = config?.centralRepo, silent = false) {
    if (!workspacePath || !centralRepoPath) return;
    if (!silent) setOverviewLoading(true);
    try {
      const next = await window.electronAPI.getOverview({ workspacePath, centralRepoPath });
      setOverview(next);
    } catch {
      if (!silent) setStatus("비교 요약 로드에 실패했습니다.");
    } finally {
      if (!silent) setOverviewLoading(false);
    }
  }

  async function chooseCentralRepo() {
    if (!config || blockUi || modalOpen) return;
    const picked = await window.electronAPI.chooseDirectory();
    if (!picked) return;

    try {
      const repo = await window.electronAPI.checkCentralRepo(picked);
      if (!repo.isGitRepo) {
        const ok = window.confirm(repo.exists ? "선택 폴더는 Git 저장소가 아닙니다. 지금 초기화할까요?" : "선택 폴더를 만들고 Git 저장소를 초기화할까요?");
        if (!ok) return;
        await window.electronAPI.initializeCentralRepo(picked);
      }

      const next = await window.electronAPI.saveConfig({ centralRepo: picked });
      setConfig(next);
      if (activeWorkspace) {
        await refreshAll(activeWorkspace.path, next.centralRepo);
      }
      setStatus(`중앙 저장소 설정: ${picked}`);
    } catch (error) {
      setStatus(`중앙 저장소 설정 실패: ${String(error)}`);
    }
  }

  async function openSettingsPanel() {
    if (!config) return;
    setSettingsDraft({
      centralRepo: config.centralRepo,
      autoPush: config.autoPush,
      defaultTool: config.defaultTool,
      fontSize: config.fontSize ?? 15
    });
    setSettingsOpen(true);
    setSkillsCliOutput("");
    setSkillsCliTarget("workspace");
    await refreshGitDiagnostics(config.centralRepo);
  }

  async function refreshGitDiagnostics(centralRepoPath = settingsDraft.centralRepo || config?.centralRepo) {
    if (!centralRepoPath) return;
    setGitBusy(true);
    try {
      const info = await window.electronAPI.getGitDiagnostics(centralRepoPath);
      setGitDiagnostics(info);
    } catch (error) {
      setStatus(`Git 상태 조회 실패: ${String(error)}`);
    } finally {
      setGitBusy(false);
    }
  }

  async function pickCentralRepoInSettings() {
    const picked = await window.electronAPI.chooseDirectory();
    if (!picked) return;
    setSettingsDraft((prev) => ({ ...prev, centralRepo: picked }));
    await refreshGitDiagnostics(picked);
  }

  async function initializeCentralInSettings() {
    if (!settingsDraft.centralRepo.trim()) {
      setStatus("중앙 저장소 경로를 입력하세요.");
      return;
    }
    try {
      await window.electronAPI.initializeCentralRepo(settingsDraft.centralRepo.trim());
      setStatus("중앙 저장소 Git 초기화 완료");
      await refreshGitDiagnostics(settingsDraft.centralRepo.trim());
    } catch (error) {
      setStatus(`중앙 저장소 초기화 실패: ${String(error)}`);
    }
  }

  async function saveAdminSettings() {
    if (!config) return;
    const centralRepo = settingsDraft.centralRepo.trim();
    if (!centralRepo) {
      setStatus("중앙 저장소 경로를 입력하세요.");
      return;
    }

    try {
      const fontSize = Math.max(11, Math.min(22, settingsDraft.fontSize));
      document.documentElement.style.setProperty("--app-font-size", `${fontSize}px`);
      const next = await window.electronAPI.saveConfig({
        centralRepo,
        autoPush: settingsDraft.autoPush,
        defaultTool: settingsDraft.defaultTool,
        fontSize
      });
      setConfig(next);
      setSettingsOpen(false);
      if (activeWorkspace) {
        await refreshAll(activeWorkspace.path, next.centralRepo);
      }
      setStatus("관리자 설정 저장 완료");
    } catch (error) {
      setStatus(`설정 저장 실패: ${String(error)}`);
    }
  }

  async function testOriginRemote() {
    if (!settingsDraft.centralRepo.trim()) return;
    setGitBusy(true);
    try {
      const result = await window.electronAPI.testGitRemote({ centralRepoPath: settingsDraft.centralRepo.trim(), remote: "origin" });
      setStatus(result.message);
      await refreshGitDiagnostics(settingsDraft.centralRepo.trim());
    } catch (error) {
      setStatus(`원격 테스트 실패: ${String(error)}`);
    } finally {
      setGitBusy(false);
    }
  }

  async function openOriginUrl() {
    const url = gitDiagnostics?.originUrl;
    if (!url) {
      setStatus("origin URL이 없습니다.");
      return;
    }
    await window.electronAPI.openExternal(toBrowsableRemoteUrl(url));
  }

  async function openPathInExplorer(targetPath: string, label: string) {
    const result = await window.electronAPI.openPath(targetPath);
    if (result && result.trim()) {
      setStatus(`${label} 열기 실패: ${result}`);
      return;
    }
    setStatus(`${label} 폴더를 열었습니다.`);
  }

  function getSkillsCliCwd(target: "workspace" | "central"): string | null {
    if (skillsCliCustomPath.trim()) return skillsCliCustomPath.trim();
    if (target === "central") return settingsDraft.centralRepo.trim() || (config?.centralRepo ?? null);
    return activeWorkspace?.path ?? null;
  }

  function parseSkillsCliSkillInputs(raw: string): string[] {
    const cleaned = raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => item.replace(/^['"]+|['"]+$/g, "").trim())
      .filter(Boolean);
    return cleaned.length > 0 ? cleaned : ["*"];
  }

  async function runSkillsCliAction(action: "add" | "check" | "update" | "list" | "find") {
    const cwd = getSkillsCliCwd(skillsCliTarget);
    if (!cwd) {
      setStatus("Skills CLI 실행 경로를 찾을 수 없습니다.");
      return;
    }

    setSkillsCliBusy(true);
    try {
      const groupSide = resolveSkillsCliGroupSide(cwd, activeWorkspace?.path ?? null, config?.centralRepo ?? null);
      const beforeFiles = action === "add" && groupSide
        ? await loadSkillFilesBySide(groupSide, activeWorkspace?.path ?? null, config?.centralRepo ?? null)
        : null;
      const skills = action === "add" ? parseSkillsCliSkillInputs(skillsCliSkillNames) : [];
      const result = await window.electronAPI.runSkillsCli({
        cwd,
        action,
        repo: skillsCliRepo.trim() || undefined,
        skills,
        yes: true
      });
      const parts = [result.command];
      if (result.stdout?.trim()) parts.push("", result.stdout.trim());
      if (result.stderr?.trim()) parts.push("", "[stderr]", result.stderr.trim());
      setSkillsCliOutput(parts.join("\n") || "출력 없음");
      let statusMessage = result.ok ? `Skills CLI 완료: ${action}` : `Skills CLI: ${action} (종료코드 비정상, 위 출력 확인)`;
      if (result.ok && activeWorkspace && config) {
        await refreshAll(activeWorkspace.path, config.centralRepo);

        if (action === "add" && groupSide) {
          const afterFiles = await loadSkillFilesBySide(groupSide, activeWorkspace.path, config.centralRepo);
          const installedNames = extractInstalledSkillFolderNames(`${result.stdout}\n${result.stderr}`);
          const fallbackNames = beforeFiles ? inferNewSkillFolderNames(beforeFiles, afterFiles) : [];
          const targetNames = installedNames.length > 0 ? installedNames : fallbackNames;
          const targets = buildGroupTargetsFromNames(afterFiles, targetNames);

          if (targets.length > 0) {
            const baseName = normalizeSkillsRepoName(skillsCliRepo.trim()) || "skills-installed";
            const groupName = uniqueGroupName(selectionGroups, groupSide, baseName);
            const group: SelectionGroup = {
              id: `${groupSide}-${Date.now()}`,
              name: groupName,
              side: groupSide,
              targets
            };
            setSelectionGroups((prev) => [...prev, group]);
            statusMessage = `${statusMessage} · 그룹 생성: ${groupName} (${targets.length}개 폴더)`;
          } else {
            statusMessage = `${statusMessage} · 그룹 생성할 폴더를 찾지 못했습니다.`;
          }
        }
      }
      setStatus(statusMessage);
    } catch (error) {
      setSkillsCliOutput(String(error));
      setStatus(`Skills CLI 오류: ${String(error)}`);
    } finally {
      setSkillsCliBusy(false);
    }
  }

  function resetEditor() {
    setEditorTarget(null);
    setEditorText("");
    setSavedEditorText("");
    setEditorEditable(false);
    setEditorMode("edit");
  }

  async function openEditor(target: EditorTarget) {
    if (!target.basePath) return;
    if (
      editorDirty &&
      editorTarget &&
      (editorTarget.source !== target.source || editorTarget.tool !== target.tool || editorTarget.relativePath !== target.relativePath)
    ) {
      if (!(await confirmDiscardDirty("저장하지 않은 변경이 있습니다. 다른 파일을 열까요?"))) {
        return;
      }
    }

    try {
      const editable = await window.electronAPI.isEditableFile(target.relativePath);
      setEditorEditable(editable);
      setEditorTarget(target);
      setEditorMode("edit");
      setDetailTab("editor");

      if (!editable) {
        const msg = "이 파일 형식은 텍스트 편집을 지원하지 않습니다.";
        setEditorText(msg);
        setSavedEditorText(msg);
        return;
      }

      const text = await window.electronAPI.readText(target);
      setEditorText(text);
      setSavedEditorText(text);
      void loadLiveDiff(target);
    } catch (error) {
      setStatus(`파일 열기 실패: ${String(error)}`);
    }
  }

  async function loadLiveDiff(target: EditorTarget) {
    if (!config || target.source !== "workspace") {
      setLiveDiffText(null);
      return;
    }
    setLiveDiffLoading(true);
    try {
      const result = await window.electronAPI.compareSkill({
        workspacePath: target.basePath,
        centralRepoPath: config.centralRepo,
        tool: target.tool,
        relativePath: target.relativePath,
        mode: "promote"
      });
      setLiveDiffText(result.hasChanges ? result.unifiedDiff : null);
    } catch {
      setLiveDiffText(null);
    } finally {
      setLiveDiffLoading(false);
    }
  }

  async function saveEditor() {
    if (!editorTarget || !editorEditable || !editorDirty) return;
    setIsSavingEditor(true);
    setBusyMessage("파일 저장 중...");

    try {
      await window.electronAPI.writeText({ ...editorTarget, content: editorText });
      setSavedEditorText(editorText);
      setStatus(`저장 완료: ${editorTarget.tool}/${editorTarget.relativePath}`);
    } catch (error) {
      setStatus(`저장 실패: ${String(error)}`);
    } finally {
      setIsSavingEditor(false);
      setBusyMessage("");
    }
  }

  function cancelEditor() {
    setEditorText(savedEditorText);
  }

  function getCollections(side: TreeSide) {
    if (side === "workspace") {
      return {
        byKey: workspaceByKey,
        ordered: workspaceOrderedKeys,
        checked: workspaceChecked,
        setChecked: setWorkspaceChecked,
        multi: workspaceMulti,
        setMulti: setWorkspaceMulti,
        activeKey: workspaceActiveKey,
        setActiveKey: setWorkspaceActiveKey,
        anchor: workspaceAnchor,
        setAnchor: setWorkspaceAnchor,
        expanded: workspaceExpanded,
        setExpanded: setWorkspaceExpanded
      };
    }

    return {
      byKey: centralByKey,
      ordered: centralOrderedKeys,
      checked: centralChecked,
      setChecked: setCentralChecked,
      multi: centralMulti,
      setMulti: setCentralMulti,
      activeKey: centralActiveKey,
      setActiveKey: setCentralActiveKey,
      anchor: centralAnchor,
      setAnchor: setCentralAnchor,
      expanded: centralExpanded,
      setExpanded: setCentralExpanded
    };
  }

  function getCheckedSelections(side: TreeSide): Selection[] {
    const { checked, byKey } = getCollections(side);
    const out = new Map<string, Selection>();

    for (const key of Object.keys(checked)) {
      if (!checked[key]) continue;
      const node = byKey.get(key);
      if (!node) continue;

      if (node.type === "file") {
        out.set(`${node.tool}:${node.relativePath}`, { tool: node.tool, relativePath: node.relativePath });
      } else {
        for (const fileNode of collectFileDescendants(node)) {
          out.set(`${fileNode.tool}:${fileNode.relativePath}`, { tool: fileNode.tool, relativePath: fileNode.relativePath });
        }
      }
    }

    return [...out.values()];
  }

  function getExplorerSelections(side: TreeSide): Selection[] {
    const { multi, activeKey, byKey } = getCollections(side);
    const out = new Map<string, Selection>();

    for (const key of Object.keys(multi)) {
      if (!multi[key]) continue;
      const node = byKey.get(key);
      if (node?.type === "file") {
        out.set(`${node.tool}:${node.relativePath}`, { tool: node.tool, relativePath: node.relativePath });
      }
    }

    if (activeKey) {
      const active = byKey.get(activeKey);
      if (active?.type === "file") {
        out.set(`${active.tool}:${active.relativePath}`, { tool: active.tool, relativePath: active.relativePath });
      }
    }

    return [...out.values()];
  }

  function getTransferSelections(side: TreeSide): Selection[] {
    const checked = getCheckedSelections(side);
    if (checked.length > 0) return checked;
    return getExplorerSelections(side);
  }

  function getContextTransferSelections(side: TreeSide, node: TreeNode): Selection[] {
    const current = getTransferSelections(side);
    if (current.length > 0) return current;
    if (node.type === "file") return [{ tool: node.tool, relativePath: node.relativePath }];
    return collectFileDescendants(node).map((item) => ({ tool: item.tool, relativePath: item.relativePath }));
  }

  function getSelectionCountLabel(side: TreeSide) {
    const checkedCount = getCheckedSelections(side).length;
    const explorerCount = getExplorerSelections(side).length;
    return checkedCount > 0 ? `${checkedCount}개 파일 선택(체크)` : `${explorerCount}개 파일 선택`;
  }

  function toggleFolderCheck(side: TreeSide, key: string, value: boolean) {
    const col = getCollections(side);
    col.setChecked((prev) => {
      const next = { ...prev };
      const start = col.byKey.get(key);
      if (!start) return next;

      const stack: TreeNode[] = [start];
      while (stack.length > 0) {
        const node = stack.pop();
        if (!node || node.type !== "folder") continue;
        next[node.key] = value;
        for (const child of node.children) {
          if (child.type === "folder") stack.push(child);
        }
      }

      return next;
    });
  }

  function toggleExpand(side: TreeSide, key: string) {
    const col = getCollections(side);
    col.setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function expandAll(side: TreeSide) {
    const nodes = side === "workspace" ? workspaceTree : centralTree;
    const next = buildExpandedMap(nodes, true);
    const col = getCollections(side);
    col.setExpanded(next);
  }

  function collapseAll(side: TreeSide) {
    const nodes = side === "workspace" ? workspaceTree : centralTree;
    const next = buildExpandedMap(nodes, false);
    const col = getCollections(side);
    col.setExpanded(next);
  }

  function getSideGroups(side: TreeSide): SelectionGroup[] {
    return selectionGroups.filter((item) => item.side === side);
  }

  function setTreeFilterModeForSide(side: TreeSide, mode: "text" | "group") {
    setTreeFilterMode((prev) => ({ ...prev, [side]: mode }));
    if (mode === "text") {
      setGroupSearchSelection((prev) => ({ ...prev, [side]: [] }));
    }
  }

  function toggleGroupSearchForSide(side: TreeSide, groupId: string) {
    setGroupSearchSelection((prev) => {
      const current = prev[side] ?? [];
      const next = current.includes(groupId)
        ? current.filter((id) => id !== groupId)
        : [...current, groupId];
      return { ...prev, [side]: next };
    });
  }

  function getActiveGroupIds(side: TreeSide): string[] {
    return activeGroupFilters[side] ?? [];
  }

  function getActiveGroupNames(side: TreeSide): string[] {
    const ids = new Set(getActiveGroupIds(side));
    return getSideGroups(side).filter((group) => ids.has(group.id)).map((group) => group.name);
  }

  function toggleGroupFilter(side: TreeSide, groupId: string) {
    setActiveGroupFilters((prev) => {
      const current = prev[side] ?? [];
      const next = current.includes(groupId)
        ? current.filter((id) => id !== groupId)
        : [...current, groupId];
      return { ...prev, [side]: next };
    });
  }

  function clearGroupFilters(side: TreeSide) {
    setActiveGroupFilters((prev) => ({ ...prev, [side]: [] }));
  }

  function getCurrentGroupTargets(side: TreeSide): GroupTarget[] {
    const { checked, byKey } = getCollections(side);
    const out: GroupTarget[] = [];
    const hasFolder = new Set<string>();

    for (const key of Object.keys(checked)) {
      if (!checked[key]) continue;
      const node = byKey.get(key);
      if (!node) continue;
      if (node.type !== "folder") continue;
      const folderKey = `${node.tool}:${node.relativePath}`;
      hasFolder.add(folderKey);
      out.push({ kind: "folder", tool: node.tool, relativePath: node.relativePath });
    }

    const addFolder = (node: TreeNode | undefined) => {
      if (!node || node.type !== "folder") return;
      const folderKey = `${node.tool}:${node.relativePath}`;
      if (hasFolder.has(folderKey)) return;
      hasFolder.add(folderKey);
      out.push({ kind: "folder", tool: node.tool, relativePath: node.relativePath });
    };

    addFolder(getActiveNode(side) ?? undefined);
    for (const key of Object.keys(getCollections(side).multi)) {
      if (!getCollections(side).multi[key]) continue;
      addFolder(byKey.get(key));
    }

    const explorerFiles = getExplorerSelections(side).map((item) => ({ kind: "file" as const, tool: item.tool, relativePath: item.relativePath }));
    for (const file of explorerFiles) {
      let covered = false;
      for (const folderKey of hasFolder) {
        const [tool, folderPath] = folderKey.split(":");
        if (tool !== file.tool) continue;
        if (!folderPath || file.relativePath.startsWith(`${folderPath}/`)) {
          covered = true;
          break;
        }
      }
      if (!covered) out.push(file);
    }

    const unique = new Map<string, GroupTarget>();
    for (const target of out) {
      unique.set(`${target.kind}:${target.tool}:${target.relativePath}`, target);
    }
    return [...unique.values()].filter((target) => isSkillsRelativePath(target.relativePath));
  }

  function syncCheckedWithSelectedGroups(side: TreeSide, groupIds: string[]) {
    const col = getCollections(side);
    if (groupIds.length === 0) {
      col.setChecked({});
      return;
    }

    const selectedSet = new Set(groupIds);
    const groups = getSideGroups(side).filter((group) => selectedSet.has(group.id));
    const next: Record<string, boolean> = {};
    for (const group of groups) {
      for (const target of group.targets) {
        const key = `${side}:${target.tool}:${target.relativePath}`;
        if (col.byKey.has(key)) {
          next[key] = true;
        }
      }
    }
    col.setChecked(next);
  }

  function targetsToSelections(side: TreeSide, targets: GroupTarget[]): Selection[] {
    const byKey = side === "workspace" ? workspaceByKey : centralByKey;
    const resolved = new Map<string, Selection>();

    for (const target of targets) {
      if (!isSkillsRelativePath(target.relativePath)) continue;
      if (target.kind === "file") {
        resolved.set(`${target.tool}:${target.relativePath}`, { tool: target.tool, relativePath: target.relativePath });
        continue;
      }

      const folderNode = findFolderNode(byKey, target.tool, target.relativePath);
      if (!folderNode) continue;
      for (const fileNode of collectFileDescendants(folderNode)) {
        resolved.set(`${fileNode.tool}:${fileNode.relativePath}`, { tool: fileNode.tool, relativePath: fileNode.relativePath });
      }
    }

    return [...resolved.values()];
  }

  async function saveCurrentSelectionGroup(side: TreeSide) {
    const targets = getCurrentGroupTargets(side);
    if (targets.length === 0) {
      setStatus("그룹으로 저장할 선택이 없습니다.");
      return;
    }
    const name = await showPrompt("그룹 이름을 입력하세요", `group-${new Date().toLocaleDateString("ko")}`);
    if (!name?.trim()) return;
    const group: SelectionGroup = {
      id: `${side}-${Date.now()}`,
      name: name.trim(),
      side,
      targets
    };
    setSelectionGroups((prev) => [...prev, group]);
    const folderCount = group.targets.filter((t) => t.kind === "folder").length;
    const fileCount = group.targets.filter((t) => t.kind === "file").length;
    setStatus(`그룹 저장 완료: ${group.name} (폴더 ${folderCount}, 파일 ${fileCount})`);
  }

  async function runSavedGroup(side: TreeSide, groupId: string) {
    const group = selectionGroups.find((item) => item.id === groupId && item.side === side);
    if (!group) {
      setStatus("선택한 그룹을 찾을 수 없습니다.");
      return;
    }
    const mode = side === "workspace" ? "toCentral" : "toWorkspace";
    const selections = targetsToSelections(side, group.targets);
    if (selections.length === 0) {
      setStatus("그룹에서 전송할 파일을 찾지 못했습니다.");
      return;
    }
    await startTransferWithSelections(mode, selections);
  }

  function deleteGroup(side: TreeSide, groupId: string) {
    const target = selectionGroups.find((item) => item.id === groupId);
    if (!target) return;
    if (!window.confirm(`그룹 삭제: ${target.name}`)) return;
    setSelectionGroups((prev) => prev.filter((item) => item.id !== groupId));
    setActiveGroupFilters((prev) => ({
      workspace: (prev.workspace ?? []).filter((id) => id !== groupId),
      central: (prev.central ?? []).filter((id) => id !== groupId)
    }));
    setGroupSearchSelection((prev) => ({
      workspace: (prev.workspace ?? []).filter((id) => id !== groupId),
      central: (prev.central ?? []).filter((id) => id !== groupId)
    }));
    setStatus(`그룹 삭제: ${target.name}`);
  }

  async function saveGroupFromNode(side: TreeSide, node: TreeNode) {
    if (!isSkillsRelativePath(node.relativePath)) {
      setStatus("skills 폴더 하위 항목만 그룹으로 저장할 수 있습니다.");
      return;
    }
    const defaultName = node.type === "folder" ? `${node.name}-group` : `${node.name}-file-group`;
    const name = await showPrompt("그룹 이름을 입력하세요", defaultName);
    if (!name?.trim()) return;

    const group: SelectionGroup = {
      id: `${side}-${Date.now()}`,
      name: name.trim(),
      side,
      targets: [{ kind: node.type, tool: node.tool, relativePath: node.relativePath }]
    };
    setSelectionGroups((prev) => [...prev, group]);
    setStatus(`그룹 저장 완료: ${group.name}`);
  }

  async function onNodeClick(side: TreeSide, node: TreeNode, event: MouseEvent<HTMLButtonElement>) {
    const col = getCollections(side);
    const ordered = col.ordered;

    col.setActiveKey(node.key);

    if (!event.ctrlKey && !event.metaKey && !event.shiftKey) {
      col.setMulti({ [node.key]: true });
      col.setAnchor(node.key);
    }

    if (event.ctrlKey || event.metaKey) {
      col.setMulti((prev) => ({ ...prev, [node.key]: !prev[node.key] }));
      col.setAnchor(node.key);
    }

    if (event.shiftKey) {
      const anchor = col.anchor ?? node.key;
      const start = ordered.indexOf(anchor);
      const end = ordered.indexOf(node.key);
      if (start >= 0 && end >= 0) {
        const [from, to] = start < end ? [start, end] : [end, start];
        const next: Record<string, boolean> = {};
        for (let index = from; index <= to; index += 1) {
          next[ordered[index]] = true;
        }
        col.setMulti(next);
      } else {
        col.setMulti({ [node.key]: true });
      }
    }

    const other = side === "workspace" ? "central" : "workspace";
    const otherCol = getCollections(other);
    otherCol.setActiveKey(null);

    const shouldOpenEditor = node.type === "file" && (side === "workspace" || event.detail >= 2);
    if (shouldOpenEditor) {
      if (!(await confirmDiscardDirty("저장하지 않은 변경이 있습니다. 다른 파일을 열까요?"))) {
        return;
      }
      const source: SkillSource = side === "workspace" ? "workspace" : "central";
      const basePath = side === "workspace" ? activeWorkspace?.path ?? "" : config?.centralRepo ?? "";
      if (basePath) {
        void openEditor({ source, basePath, tool: node.tool, relativePath: node.relativePath });
      }
    }
  }

  async function promptTool(defaultTool?: ToolType): Promise<ToolType | null> {
    const raw = await showPrompt("툴 이름을 입력하세요: claude/codex/gemini/cursor/antigravity", defaultTool ?? "claude");
    if (!raw) return null;
    const value = raw.trim().toLowerCase();
    if (toolOrder.includes(value as ToolType)) return value as ToolType;
    setStatus("지원하지 않는 툴 이름입니다.");
    return null;
  }

  async function getCrudContext(side: TreeSide, node?: TreeNode | null) {
    const source: SkillSource = side === "workspace" ? "workspace" : "central";
    const basePath = side === "workspace" ? activeWorkspace?.path ?? "" : config?.centralRepo ?? "";
    if (!basePath) return null;

    if (node) {
      return {
        source,
        basePath,
        tool: node.tool,
        node,
        parentPath: node.type === "file" ? dirname(node.relativePath) : node.relativePath
      };
    }

    const tool = await promptTool(config?.defaultTool);
    if (!tool) return null;
    return {
      source,
      basePath,
      tool,
      node: null,
      parentPath: ""
    };
  }

  async function runCrud(side: TreeSide, action: CrudAction, node?: TreeNode) {
    if (!config || !activeWorkspace || blockUi || modalOpen) return;
    if (!(await confirmDiscardDirty("저장하지 않은 변경이 있습니다. 작업을 진행할까요?"))) return;

    const context = await getCrudContext(side, node ?? getActiveNode(side));
    if (!context) return;
    if (
      context.node &&
      context.node.relativePath === "" &&
      (action === "rename" || action === "delete" || action === "duplicate")
    ) {
      setStatus("툴 루트는 이름 변경/삭제/복제를 지원하지 않습니다.");
      return;
    }

    try {
      if (action === "createFile") {
        const name = await showPrompt("새 파일 이름(또는 경로)을 입력하세요", "new-file.md");
        if (!name) return;
        const normalized = resolveInputRelativePath(name, context.parentPath);
        if (!normalized) return;
        const valid = await window.electronAPI.validateTarget({ basePath: context.basePath, source: context.source, tool: context.tool, relativePath: normalized });
        if (valid.exists) {
          setStatus("이미 같은 경로가 존재합니다.");
          return;
        }
        await window.electronAPI.createNode({ basePath: context.basePath, source: context.source, tool: context.tool, relativePath: normalized, nodeType: "file", content: "" });
        setStatus(`파일 생성: ${context.tool}/${normalized}`);
      }

      if (action === "createFolder") {
        const name = await showPrompt("새 폴더 이름(또는 경로)을 입력하세요", "new-folder");
        if (!name) return;
        const normalized = resolveInputRelativePath(name, context.parentPath);
        if (!normalized) return;
        const valid = await window.electronAPI.validateTarget({ basePath: context.basePath, source: context.source, tool: context.tool, relativePath: normalized });
        if (valid.exists) {
          setStatus("이미 같은 경로가 존재합니다.");
          return;
        }
        await window.electronAPI.createNode({ basePath: context.basePath, source: context.source, tool: context.tool, relativePath: normalized, nodeType: "folder" });
        setStatus(`폴더 생성: ${context.tool}/${normalized}`);
      }

      if (action === "rename") {
        if (!context.node) {
          setStatus("이름 변경할 항목을 먼저 선택하세요.");
          return;
        }
        const parentPath = dirname(context.node.relativePath);
        const currentName = basenameRel(context.node.relativePath);
        const parentLabel = parentPath || "(skills 루트)";
        const nextInput = await showPrompt(`새 이름을 입력하세요 (현재 위치: ${parentLabel})`, currentName);
        if (!nextInput) return;
        const trimmed = nextInput.trim();
        if (!trimmed) return;
        const normalized = trimmed.includes("/") || trimmed.includes("\\")
          ? normalizeRel(trimmed)
          : normalizeRel(joinPath(parentPath, trimmed));
        if (normalized === context.node.relativePath) return;
        await window.electronAPI.renameNode({
          basePath: context.basePath,
          source: context.source,
          tool: context.tool,
          fromRelativePath: context.node.relativePath,
          toRelativePath: normalized
        });
        setStatus(`이름 변경: ${context.node.relativePath} -> ${normalized}`);
      }

      if (action === "duplicate") {
        if (!context.node) {
          setStatus("복제할 항목을 먼저 선택하세요.");
          return;
        }
        const suggestion = context.node.type === "file" ? withFileSuffix(context.node.relativePath, "-copy") : `${context.node.relativePath}-copy`;
        const toPath = await showPrompt("복제 대상 경로를 입력하세요", suggestion);
        if (!toPath) return;
        const normalized = normalizeRel(toPath);
        await window.electronAPI.duplicateNode({
          basePath: context.basePath,
          source: context.source,
          tool: context.tool,
          fromRelativePath: context.node.relativePath,
          toRelativePath: normalized
        });
        setStatus(`복제 완료: ${context.node.relativePath} -> ${normalized}`);
      }

      if (action === "delete") {
        if (!context.node) {
          setStatus("삭제할 항목을 먼저 선택하세요.");
          return;
        }
        const count = context.node.type === "folder" ? collectFileDescendants(context.node).length : 1;
        const ask = context.node.type === "folder"
          ? `폴더 삭제: ${context.node.relativePath}\n하위 파일 ${count}개가 함께 삭제됩니다. 진행할까요?`
          : `파일 삭제: ${context.node.relativePath}\n진행할까요?`;
        if (!window.confirm(ask)) return;

        await window.electronAPI.deleteNode({
          basePath: context.basePath,
          source: context.source,
          tool: context.tool,
          relativePath: context.node.relativePath
        });

        if (editorTarget && editorTarget.source === context.source && editorTarget.tool === context.tool && editorTarget.relativePath === context.node.relativePath) {
          resetEditor();
        }

        setStatus(`삭제 완료: ${context.node.relativePath}`);
      }

      if (activeWorkspace && config) {
        await refreshAll(activeWorkspace.path, config.centralRepo);
      }
    } catch (error) {
      setStatus(`CRUD 실패: ${String(error)}`);
    }
  }

  function getActiveNode(side: TreeSide): TreeNode | null {
    const col = getCollections(side);
    const key = col.activeKey;
    if (!key) return null;
    return col.byKey.get(key) ?? null;
  }

  function getCheckedNodeForCrud(side: TreeSide): TreeNode | null {
    const col = getCollections(side);
    for (const key of Object.keys(col.checked)) {
      if (!col.checked[key]) continue;
      const node = col.byKey.get(key);
      if (node) return node;
    }
    return null;
  }

  function getCrudTargetNode(side: TreeSide): TreeNode | null {
    return getActiveNode(side) ?? getCheckedNodeForCrud(side);
  }

  function handleContextMenu(side: TreeSide, node: TreeNode, event: MouseEvent) {
    event.preventDefault();
    setContextMenu({ side, node, x: event.clientX, y: event.clientY });
  }

  async function startTransferWithSelections(mode: "toCentral" | "toWorkspace", selections: Selection[]) {
    if (!config || !activeWorkspace || blockUi || modalOpen) return;
    if (!(await confirmDiscardDirty("저장하지 않은 변경이 있습니다. 전송을 진행할까요?"))) return;
    if (!(await ensureCentralRepoReady())) return;
    setDetailTab("central");
    if (selections.length === 0) {
      setStatus("전송할 파일을 선택하세요.");
      return;
    }

    setIsBusy(true);
    setBusyMessage(mode === "toCentral" ? "중앙 저장 전 변경사항을 계산하는 중..." : "workspace 반영 전 변경사항을 계산하는 중...");
    try {
      const changed: Array<{ tool: ToolType; relativePath: string; diff: DiffData }> = [];
      let newFiles = 0;
      let unchanged = 0;
      let newTextJoined = "";

      for (const item of selections) {
        const diff = await window.electronAPI.compareSkill({
          workspacePath: activeWorkspace.path,
          centralRepoPath: config.centralRepo,
          tool: item.tool,
          relativePath: item.relativePath,
          mode: mode === "toCentral" ? "promote" : "import"
        });

        if (diff.hasChanges) {
          changed.push({ tool: item.tool, relativePath: item.relativePath, diff });
          if (!diff.oldText) newFiles += 1;
          if (mode === "toCentral") newTextJoined += `\n${diff.newText}`;
        } else {
          unchanged += 1;
        }
      }

      const warningRows = mode === "toCentral" ? await window.electronAPI.scanSensitive(newTextJoined) : [];
      setWarnings(warningRows);

      const previewData: TransferPreview = { mode, selections, existingChanged: changed, newFiles, unchanged };
      if (changed.length === 0) {
        setStatus("변경된 파일이 없습니다.");
        return;
      }
      setPreview(previewData);
    } catch (error) {
      setStatus(`전송 준비 실패: ${String(error)}`);
    } finally {
      setIsBusy(false);
      setBusyMessage("");
    }
  }

  async function startTransfer(mode: "toCentral" | "toWorkspace") {
    const side = mode === "toCentral" ? "workspace" : "central";
    const selections = getTransferSelections(side);
    await startTransferWithSelections(mode, selections);
  }

  async function executeTransfer() {
    if (!config || !activeWorkspace || !preview) return;

    setIsBusy(true);
    setBusyMessage(preview.mode === "toCentral" ? "중앙 저장 진행 중..." : "workspace 가져오기 진행 중...");
    try {
      if (preview.mode === "toCentral") {
        const result = await window.electronAPI.promoteSkills({
          workspacePath: activeWorkspace.path,
          centralRepoPath: config.centralRepo,
          selections: preview.selections
        });
        setStatus(`중앙 저장 완료: ${result.changedFiles.length}개 파일`);
      } else {
        const result = await window.electronAPI.importSkills({
          workspacePath: activeWorkspace.path,
          centralRepoPath: config.centralRepo,
          selections: preview.selections
        });
        setStatus(`workspace 반영 완료: ${result.changedFiles.length}개 파일`);
      }

      setPreview(null);
      setWarnings([]);
      await refreshAll(activeWorkspace.path, config.centralRepo);
    } catch (error) {
      setStatus(`전송 실패: ${String(error)}`);
    } finally {
      setIsBusy(false);
      setBusyMessage("");
    }
  }

  async function loadUpdates(silent = false) {
    if (!config || !activeWorkspace) return;
    if (!silent) setIsBusy(true);
    if (!silent) setBusyMessage("업데이트 후보를 조회하는 중...");

    try {
      const candidates = await window.electronAPI.findUpdateCandidates({ workspacePath: activeWorkspace.path, centralRepoPath: config.centralRepo });
      setUpdateCandidates(candidates);
      const picked: Record<string, boolean> = {};
      for (const item of candidates) picked[toSelectionKey(item.tool, item.relativePath)] = true;
      setSelectedUpdates(picked);
      if (!silent) setStatus(`업데이트 후보 ${candidates.length}개`);
    } catch (error) {
      if (!silent) setStatus(`업데이트 후보 조회 실패: ${String(error)}`);
    } finally {
      if (!silent) setIsBusy(false);
      if (!silent) setBusyMessage("");
    }
  }

  async function applySelectedUpdates() {
    if (!config || !activeWorkspace) return;
    const selections = updateCandidates
      .filter((item) => selectedUpdates[toSelectionKey(item.tool, item.relativePath)])
      .map((item) => ({ tool: item.tool, relativePath: item.relativePath }));

    if (selections.length === 0) {
      setStatus("적용할 업데이트를 선택하세요.");
      return;
    }

    setIsBusy(true);
    setBusyMessage("선택한 업데이트를 적용하는 중...");
    try {
      const result = await window.electronAPI.applyUpdates({ workspacePath: activeWorkspace.path, centralRepoPath: config.centralRepo, selections });
      setStatus(`업데이트 적용 완료: ${result.changedFiles.length}개 파일`);
      await refreshAll(activeWorkspace.path, config.centralRepo);
      await loadUpdates(true);
    } catch (error) {
      setStatus(`업데이트 적용 실패: ${String(error)}`);
    } finally {
      setIsBusy(false);
      setBusyMessage("");
    }
  }

  async function runSync(push: boolean) {
    if (!config) return;
    if (!syncCommitMessage.trim()) {
      setStatus("commit message를 입력하세요.");
      return;
    }

    setIsSyncing(true);
    setBusyMessage(push ? "Git commit + push 진행 중..." : "Git commit 진행 중...");
    try {
      const result = await window.electronAPI.syncCentralRepo({
        centralRepoPath: config.centralRepo,
        commitMessage: syncCommitMessage,
        push
      });
      setStatus(result.message);
      if (activeWorkspace) {
        await refreshAll(activeWorkspace.path, config.centralRepo);
      }
    } catch (error) {
      setStatus(`Git 동기화 실패: ${String(error)}`);
    } finally {
      setIsSyncing(false);
      setBusyMessage("");
    }
  }

  const workspaceSelectionLabel = getSelectionCountLabel("workspace");
  const centralSelectionLabel = getSelectionCountLabel("central");
  const workspaceTransferCount = getTransferSelections("workspace").length;
  const centralTransferCount = getTransferSelections("central").length;
  const activeWorkspaceNode = getCrudTargetNode("workspace");
  const activeCentralNode = getCrudTargetNode("central");
  const workspaceDiffMap = useMemo(() => buildDiffHintMap(overview?.items ?? [], "workspace"), [overview]);
  const centralDiffMap = useMemo(() => buildDiffHintMap(overview?.items ?? [], "central"), [overview]);
  const groupedUpdateCandidates = useMemo(() => groupUpdateCandidates(updateCandidates), [updateCandidates]);
  const mainStripStyle = stackedLayout
    ? undefined
    : ({ gridTemplateColumns: `${leftPaneWidth}px 8px minmax(380px, 1fr)` } as const);

  return (
    <div className="app-shell">
      <header className="top-head">
        <h1>Skill Bridge</h1>
        <div className="head-actions">
          <button onClick={() => void refreshAll()} disabled={blockUi || modalOpen} title="목록 새로고침">↺ 새로고침</button>
          <button onClick={() => void openSettingsPanel()} disabled={blockUi || modalOpen} title="관리자 설정 열기">⚙ 설정</button>
        </div>
      </header>

      <section className={`workspace-layout ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
        <aside className={`workspace-sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
          <button className="sidebar-toggle" onClick={() => setSidebarCollapsed((prev) => !prev)} disabled={blockUi || modalOpen} title={sidebarCollapsed ? "사이드바 펼치기" : "사이드바 접기"}>
            {sidebarCollapsed ? "▶" : "◀"}
          </button>
          {sidebarCollapsed ? (
            <div className="workspace-mini-list">
              {(config?.workspaces ?? []).map((item) => (
                <button
                  key={item.id}
                  className={`ws-tab mini ${config?.activeWorkspaceId === item.id ? "active" : ""}`}
                  onClick={() => void switchWorkspace(item.id)}
                  disabled={blockUi || modalOpen}
                  title={item.id === GLOBAL_WORKSPACE_ID ? "Global (Home)" : item.name}
                >
                  {workspaceShortLabel(item)}
                </button>
              ))}
              <div className="mini-groups-wrap">
                <button
                  className={`ws-tab mini mini-groups-btn ${miniGroupsOpen ? "active" : ""}`}
                  onClick={() => setMiniGroupsOpen((v) => !v)}
                  title="스킬 그룹"
                >
                  G
                  {selectionGroups.length > 0 && (
                    <span className="mini-groups-badge">{selectionGroups.length}</span>
                  )}
                </button>
                {miniGroupsOpen && (
                  <div className="mini-groups-panel">
                    <div className="mini-groups-panel-head">
                      <span>스킬 그룹</span>
                      <button className="mini-groups-close" onClick={() => setMiniGroupsOpen(false)}>×</button>
                    </div>
                    <div className="group-side-tabs">
                      <button
                        className={`group-side-tab ${groupSideTab === "workspace" ? "active" : ""}`}
                        onClick={() => setGroupSideTab("workspace")}
                      >
                        작업 폴더
                        {getSideGroups("workspace").length > 0 && (
                          <span className="group-tab-count">{getSideGroups("workspace").length}</span>
                        )}
                      </button>
                      <button
                        className={`group-side-tab ${groupSideTab === "central" ? "active" : ""}`}
                        onClick={() => setGroupSideTab("central")}
                      >
                        중앙 저장소
                        {getSideGroups("central").length > 0 && (
                          <span className="group-tab-count">{getSideGroups("central").length}</span>
                        )}
                      </button>
                    </div>
                    <button
                      className="group-add-btn"
                      onClick={() => void saveCurrentSelectionGroup(groupSideTab)}
                      disabled={blockUi || modalOpen}
                    >
                      + 새 그룹
                    </button>
                    {getActiveGroupIds(groupSideTab).length > 0 && (
                      <button className="group-clear-btn" onClick={() => clearGroupFilters(groupSideTab)}>
                        ✕ 전체 보기
                      </button>
                    )}
                    {getSideGroups(groupSideTab).length === 0 && (
                      <p className="group-empty-hint">트리에서 체크 후 「+ 새 그룹」을 누르세요.</p>
                    )}
                    <div className="group-card-list">
                      {getSideGroups(groupSideTab).map((group) => (
                        <div
                          key={group.id}
                          className={`group-card ${getActiveGroupIds(groupSideTab).includes(group.id) ? "active" : ""}`}
                        >
                          <button
                            className="group-card-name"
                            onClick={() => {
                              toggleGroupFilter(groupSideTab, group.id);
                            }}
                            disabled={blockUi || modalOpen}
                          >
                            <span className="group-card-title">{group.name}</span>
                            <span className="group-card-meta">{groupTargetSummary(group.targets)}</span>
                          </button>
                          <div className="group-card-actions">
                            <button
                              className="group-action-btn primary"
                              onClick={() => void runSavedGroup(groupSideTab, group.id)}
                              disabled={blockUi || modalOpen}
                              title={groupSideTab === "workspace" ? "중앙 저장소로 전송" : "작업 폴더로 가져오기"}
                            >
                              {groupSideTab === "workspace" ? "↑" : "↓"}
                            </button>
                            <button
                              className="group-action-btn danger"
                              onClick={() => deleteGroup(groupSideTab, group.id)}
                              disabled={blockUi || modalOpen}
                            >
                              ×
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <>
              <div className="meta-card">
                <span className="meta-label">중앙 저장소</span>
                <code>{config?.centralRepo ?? "-"}</code>
              </div>
              <div className="meta-card workspace-switcher">
                <span className="meta-label">workspace</span>
                <div className="workspace-list">
                  {(config?.workspaces ?? []).map((item) => (
                    <button
                      key={item.id}
                      className={`ws-tab ${config?.activeWorkspaceId === item.id ? "active" : ""}`}
                      onClick={() => void switchWorkspace(item.id)}
                      disabled={blockUi || modalOpen}
                    >
                      {item.id === GLOBAL_WORKSPACE_ID ? "Global (Home)" : item.name}
                    </button>
                  ))}
                </div>
                <div className="workspace-actions">
                  <button onClick={() => void addWorkspace()} disabled={blockUi || modalOpen}>추가</button>
                  <button onClick={() => void removeActiveWorkspace()} disabled={blockUi || modalOpen || !activeWorkspace}>삭제</button>
                </div>
              </div>
              <div className="meta-card skill-groups-card">
                <div className="skill-groups-head">
                  <span className="meta-label">스킬 그룹</span>
                  <button
                    className="group-add-btn"
                    onClick={() => void saveCurrentSelectionGroup(groupSideTab)}
                    disabled={blockUi || modalOpen}
                    title="현재 선택 항목으로 새 그룹 만들기"
                  >
                    + 새 그룹
                  </button>
                </div>
                <div className="group-side-tabs">
                  <button
                    className={`group-side-tab ${groupSideTab === "workspace" ? "active" : ""}`}
                    onClick={() => setGroupSideTab("workspace")}
                  >
                    작업 폴더
                    {getSideGroups("workspace").length > 0 && (
                      <span className="group-tab-count">{getSideGroups("workspace").length}</span>
                    )}
                  </button>
                  <button
                    className={`group-side-tab ${groupSideTab === "central" ? "active" : ""}`}
                    onClick={() => setGroupSideTab("central")}
                  >
                    중앙 저장소
                    {getSideGroups("central").length > 0 && (
                      <span className="group-tab-count">{getSideGroups("central").length}</span>
                    )}
                  </button>
                </div>
                {getSideGroups(groupSideTab).length === 0 && (
                  <p className="group-empty-hint">트리에서 폴더/파일을 체크한 뒤 「+ 새 그룹」을 눌러 그룹을 만드세요.</p>
                )}
                {getActiveGroupIds(groupSideTab).length > 0 && (
                  <button
                    className="group-clear-btn"
                    onClick={() => clearGroupFilters(groupSideTab)}
                    disabled={blockUi || modalOpen}
                  >
                    ✕ 전체 보기
                  </button>
                )}
                <div className="group-card-list">
                  {getSideGroups(groupSideTab).map((group) => (
                    <div
                      key={group.id}
                      className={`group-card ${getActiveGroupIds(groupSideTab).includes(group.id) ? "active" : ""}`}
                    >
                      <button
                        className="group-card-name"
                        onClick={() => {
                          toggleGroupFilter(groupSideTab, group.id);
                        }}
                        disabled={blockUi || modalOpen}
                        title="클릭하면 이 그룹 파일만 트리에 표시됩니다. 여러 그룹을 겹쳐 선택할 수 있습니다."
                      >
                        <span className="group-card-title">{group.name}</span>
                        <span className="group-card-meta">{groupTargetSummary(group.targets)}</span>
                      </button>
                      <div className="group-card-actions">
                        <button
                          className="group-action-btn primary"
                          onClick={() => void runSavedGroup(groupSideTab, group.id)}
                          disabled={blockUi || modalOpen}
                          title={groupSideTab === "workspace" ? "중앙 저장소로 전송" : "작업 폴더로 가져오기"}
                        >
                          {groupSideTab === "workspace" ? "↑ 올리기" : "↓ 가져오기"}
                        </button>
                        <button
                          className="group-action-btn danger"
                          onClick={() => deleteGroup(groupSideTab, group.id)}
                          disabled={blockUi || modalOpen}
                          title="그룹 삭제"
                        >
                          ×
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </aside>

        <div className="workspace-main">

          <section
            ref={mainStripRef}
            className={`main-strip ${modalOpen ? "disabled" : ""} mode-${treePaneMode}`}
            style={mainStripStyle}
          >
            <TreeSection
              title="작업 폴더"
              selectionLabel={workspaceSelectionLabel}
              side="workspace"
              roots={focusedWorkspaceTree}
              expanded={workspaceExpanded}
              checked={workspaceChecked}
              activeKey={workspaceActiveKey}
              multi={workspaceMulti}
              statuses={workspaceInfo?.statuses ?? []}
              fileDiffMap={workspaceDiffMap}
              toolFocus={workspaceToolFocus}
              onToolFocusChange={setWorkspaceToolFocus}
              activeNode={activeWorkspaceNode}
              filterQuery={workspaceFilter}
              onFilterChange={setWorkspaceFilter}
              filterMode={treeFilterMode.workspace}
              onFilterModeChange={(mode) => setTreeFilterModeForSide("workspace", mode)}
              groupOptions={getSideGroups("workspace").map((group) => ({ id: group.id, name: group.name }))}
              groupSelection={groupSearchSelection.workspace}
              onGroupSelectionChange={(groupId) => toggleGroupSearchForSide("workspace", groupId)}
              onExpandAll={expandAll}
              onCollapseAll={collapseAll}
              activeGroupFilterCount={getActiveGroupIds("workspace").length}
              activeGroupNames={getActiveGroupNames("workspace")}
              blockUi={blockUi}
              modalOpen={modalOpen}
              onCrud={runCrud}
              onSaveGroupFromNode={saveGroupFromNode}
              onSaveCurrentGroup={saveCurrentSelectionGroup}
              onOpenRootPath={() => {
                const targetPath = activeWorkspace?.path;
                if (!targetPath) return;
                void openPathInExplorer(targetPath, "작업 폴더");
              }}
              onToggleExpand={toggleExpand}
              onToggleCheck={toggleFolderCheck}
              onClickNode={onNodeClick}
              onContextMenu={handleContextMenu}
            />
            {!stackedLayout && (
              <div
                className={`pane-resizer ${isResizing ? "dragging" : ""}`}
                role="separator"
                aria-orientation="vertical"
                aria-label="좌우 영역 너비 조절"
                onMouseDown={() => setIsResizing(true)}
              />
            )}
            <section className="context-pane">
              <div className="tab-row">
                <button className={`tab-btn ${detailTab === "editor" ? "active" : ""}`} onClick={() => setDetailTab("editor")} title="텍스트 편집기">편집</button>
                <button className={`tab-btn ${detailTab === "central" ? "active" : ""}`} onClick={() => setDetailTab("central")} title="중앙 저장소">저장소</button>
                <button className={`tab-btn ${detailTab === "diff" ? "active" : ""}`} onClick={() => setDetailTab("diff")} title="파일 변경 비교">Diff</button>
                <button className={`tab-btn ${detailTab === "updates" ? "active" : ""}`} onClick={() => setDetailTab("updates")} title="업데이트 후보">업데이트</button>
                <button className={`tab-btn ${detailTab === "git" ? "active" : ""}`} onClick={() => setDetailTab("git")} title="Git 동기화">Git</button>
              </div>

              {detailTab === "central" && (
                <TreeSection
                  title="중앙 저장소"
                  selectionLabel={centralSelectionLabel}
                  side="central"
                  roots={focusedCentralTree}
                  expanded={centralExpanded}
                  checked={centralChecked}
                  activeKey={centralActiveKey}
                  multi={centralMulti}
                  statuses={toolOrder.map((tool) => ({
                    tool,
                    workspaceDir: "",
                    exists: centralTree.some((node) => node.tool === tool)
                  }))}
                  fileDiffMap={centralDiffMap}
                  toolFocus={centralToolFocus}
                  onToolFocusChange={setCentralToolFocus}
                  activeNode={activeCentralNode}
                  filterQuery={centralFilter}
                  onFilterChange={setCentralFilter}
                  filterMode={treeFilterMode.central}
                  onFilterModeChange={(mode) => setTreeFilterModeForSide("central", mode)}
                  groupOptions={getSideGroups("central").map((group) => ({ id: group.id, name: group.name }))}
                  groupSelection={groupSearchSelection.central}
                  onGroupSelectionChange={(groupId) => toggleGroupSearchForSide("central", groupId)}
                  onExpandAll={expandAll}
                  onCollapseAll={collapseAll}
                  activeGroupFilterCount={getActiveGroupIds("central").length}
                  activeGroupNames={getActiveGroupNames("central")}
                  transferActions={(
                    <div className="transfer-inline-actions">
                      <button
                        className={`transfer-inline-btn promote ${workspaceTransferCount > 0 ? "has-items" : ""}`}
                        onClick={() => void startTransfer("toCentral")}
                        disabled={blockUi || modalOpen || workspaceTransferCount === 0}
                        title="작업 폴더 선택 파일 → 중앙 저장소"
                      >
                        ↑ 올리기
                        {workspaceTransferCount > 0 && <span className="ti-badge">{workspaceTransferCount}</span>}
                      </button>
                      <button
                        className={`transfer-inline-btn import ${centralTransferCount > 0 ? "has-items" : ""}`}
                        onClick={() => void startTransfer("toWorkspace")}
                        disabled={blockUi || modalOpen || centralTransferCount === 0}
                        title="중앙 저장소 선택 파일 → 작업 폴더"
                      >
                        ↓ 가져오기
                        {centralTransferCount > 0 && <span className="ti-badge">{centralTransferCount}</span>}
                      </button>
                    </div>
                  )}
                  blockUi={blockUi}
                  modalOpen={modalOpen}
                  onCrud={runCrud}
                  onSaveGroupFromNode={saveGroupFromNode}
                  onSaveCurrentGroup={saveCurrentSelectionGroup}
                  onOpenRootPath={() => {
                    const targetPath = config?.centralRepo;
                    if (!targetPath) return;
                    void openPathInExplorer(targetPath, "중앙 저장소");
                  }}
                  onToggleExpand={toggleExpand}
                  onToggleCheck={toggleFolderCheck}
                  onClickNode={onNodeClick}
                  onContextMenu={handleContextMenu}
                />
              )}

              {detailTab === "editor" && (
                <div className="pane">
                  <div className="pane-head">
                    <div className="editor-file-info">
                      <span className="editor-file-label">
                        {editorTarget
                          ? `${editorTarget.source === "workspace" ? "작업 폴더" : "중앙 저장소"} / ${editorTarget.tool} / ${editorTarget.relativePath}`
                          : "파일을 선택하세요"}
                      </span>
                    </div>
                    <div className="editor-actions">
                      <div className="editor-mode-btns">
                        <button className={editorMode === "edit" ? "active-mini" : ""} onClick={() => setEditorMode("edit")} disabled={blockUi}>편집</button>
                        <button className={editorMode === "view" ? "active-mini" : ""} onClick={() => setEditorMode("view")} disabled={blockUi}>미리보기</button>
                      </div>
                      <span className={`dirty-badge ${editorDirty ? "on" : "off"}`}>{editorDirty ? "●" : "○"}</span>
                      <button className="icon-btn" onClick={cancelEditor} disabled={editorMode !== "edit" || !editorDirty || !editorEditable || blockUi} title="변경 취소">↩</button>
                      <button className="primary icon-btn" onClick={() => void saveEditor()} disabled={editorMode !== "edit" || !editorDirty || !editorEditable || blockUi} title="저장 (Ctrl+S)">저장</button>
                    </div>
                  </div>
                  {editorMode === "edit" ? (
                    <textarea
                      value={editorText}
                      onChange={(event) => setEditorText(event.target.value)}
                      className="editor"
                      spellCheck={false}
                      disabled={!editorTarget || !editorEditable || blockUi}
                      placeholder="파일을 선택하세요"
                    />
                  ) : (
                    <MarkdownView text={editorText || "파일을 선택하세요"} />
                  )}
                </div>
              )}

              {detailTab === "diff" && (
                <div className="pane">
                  <div className="pane-head">
                    <h2>Diff</h2>
                    {editorTarget && (
                      <span className="pane-sub">{editorTarget.tool}/{editorTarget.relativePath}</span>
                    )}
                  </div>
                  {!editorTarget && (
                    <div className="explain-box">
                      <p>작업 폴더에서 파일을 클릭하면 중앙 저장소와의 변경 내용을 여기서 확인할 수 있습니다.</p>
                    </div>
                  )}
                  {editorTarget && liveDiffLoading && (
                    <div className="explain-box"><p>비교 중...</p></div>
                  )}
                  {editorTarget && !liveDiffLoading && liveDiffText === null && (
                    <div className="explain-box">
                      <p>중앙 저장소와 동일하거나 중앙 저장소에 해당 파일이 없습니다.</p>
                    </div>
                  )}
                  {editorTarget && !liveDiffLoading && liveDiffText !== null && (
                    <DiffView diffText={liveDiffText} />
                  )}
                </div>
              )}

              {detailTab === "updates" && (
                <div className="pane">
                  <div className="pane-head">
                    <div className="panel-head-left">
                      <h2>업데이트 후보</h2>
                      <span style={{ fontSize: "0.85rem", color: "#64748b" }}>후보 {updateCandidates.length}개</span>
                    </div>
                    <div className="update-head-actions">
                      <button className="icon-btn" onClick={() => void loadUpdates()} disabled={blockUi} title="중앙 저장소 기준으로 비교">↺ 비교</button>
                      <button className="icon-btn" onClick={() => {
                        const allOn: Record<string, boolean> = {};
                        for (const item of updateCandidates) allOn[toSelectionKey(item.tool, item.relativePath)] = true;
                        setSelectedUpdates(allOn);
                      }} disabled={blockUi || updateCandidates.length === 0} title="모두 선택">전체 선택</button>
                      <button className="icon-btn" onClick={() => setSelectedUpdates({})} disabled={blockUi || updateCandidates.length === 0} title="모두 해제">해제</button>
                      <button className="primary icon-btn" onClick={() => void applySelectedUpdates()} disabled={blockUi || updateCandidates.length === 0} title="선택한 항목을 작업 폴더에 적용">적용</button>
                    </div>
                  </div>
                  <div className="explain-box">
                    <strong>업데이트 후보 기준</strong>
                    <p>
                      <b>중앙 저장소</b>와 <b>작업 폴더</b>에 같은 경로로 존재하는 파일 중, 내용이 다른 파일만 후보로 표시합니다.
                    </p>
                    <p>
                      <code>선택 적용</code>은 항상 <b>중앙 저장소 내용을 작업 폴더로 가져와 덮어쓰기</b> 합니다.
                    </p>
                    <p>
                      현재 후보: <b>{updateCandidates.length}개</b>
                    </p>
                  </div>
                  <div className="overview-grid">
                    <div>전체 비교: {overview?.totalCompared ?? 0}</div>
                    <div>내용 변경: {overview?.changedCount ?? 0}</div>
                    <div>작업 폴더만 있음: {overview?.onlyWorkspaceCount ?? 0}</div>
                    <div>중앙만 있음: {overview?.onlyCentralCount ?? 0}</div>
                  </div>
                  <div className="update-list">
                    {groupedUpdateCandidates.map((group) => (
                      <section key={`${group.tool}-${group.group}`} className="update-group">
                        <header>
                          <strong>{group.tool}</strong>
                          <span>{group.group}</span>
                          <b>{group.items.length}개</b>
                        </header>
                        {group.items.map((item) => {
                          const key = toSelectionKey(item.tool, item.relativePath);
                          return (
                            <label key={key} className="update-item">
                              <input
                                type="checkbox"
                                checked={Boolean(selectedUpdates[key])}
                                onChange={(event) => setSelectedUpdates((prev) => ({ ...prev, [key]: event.target.checked }))}
                              />
                              <span>{item.tool}/{item.relativePath}</span>
                            </label>
                          );
                        })}
                      </section>
                    ))}
                    {updateCandidates.length === 0 && <p>업데이트 후보가 없습니다.</p>}
                  </div>
                </div>
              )}

              {detailTab === "git" && (
                <div className="pane">
                  <div className="pane-head">
                    <h2>Git 동기화</h2>
                    <p>복사 작업과 분리된 일괄 동기화입니다.</p>
                  </div>
                  <input
                    value={syncCommitMessage}
                    onChange={(event) => setSyncCommitMessage(event.target.value)}
                    className="sync-input"
                    placeholder="commit message"
                  />
                  <div className="button-row">
                    <button className="primary" onClick={() => void runSync(false)} disabled={blockUi || !syncCommitMessage.trim()}>commit만</button>
                    <button className="primary secondary" onClick={() => void runSync(true)} disabled={blockUi || !syncCommitMessage.trim()}>commit + push</button>
                  </div>
                </div>
              )}
            </section>
          </section>
        </div>
      </section>

      <footer className="status-bar">{status}</footer>

      {promptModal && (
        <div className="modal-backdrop">
          <div className="modal prompt-modal">
            <p className="prompt-message">{promptModal.message}</p>
            <input
              className="prompt-input"
              autoFocus
              value={promptValue}
              onChange={(e) => setPromptValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const val = promptValue;
                  setPromptModal(null);
                  promptModal.resolve(val || null);
                } else if (e.key === "Escape") {
                  setPromptModal(null);
                  promptModal.resolve(null);
                }
              }}
            />
            <div className="modal-actions">
              <button onClick={() => { setPromptModal(null); promptModal.resolve(null); }}>취소</button>
              <button className="primary" onClick={() => {
                const val = promptValue;
                setPromptModal(null);
                promptModal.resolve(val || null);
              }}>확인</button>
            </div>
          </div>
        </div>
      )}
      {blockUi && (
        <div className="busy-popup" role="status" aria-live="polite">
          <span className="busy-dot" />
          <span>{busyMessage || "작업 진행 중..."}</span>
        </div>
      )}
      {settingsOpen && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal-card admin-modal" role="dialog" aria-modal="true" aria-label="관리자 설정">
            <div className="modal-head">
              <h2>관리자 설정</h2>
              <button onClick={() => setSettingsOpen(false)} disabled={blockUi || gitBusy}>닫기</button>
            </div>

            <div className="admin-grid">
              <section className="admin-section">
                <h3>기본 설정</h3>
                <label className="admin-field">
                  <span>중앙 저장소 경로</span>
                  <div className="admin-inline">
                    <input
                      value={settingsDraft.centralRepo}
                      onChange={(event) => setSettingsDraft((prev) => ({ ...prev, centralRepo: event.target.value }))}
                      placeholder="C:\\path\\to\\central-repo"
                    />
                    <button onClick={() => void pickCentralRepoInSettings()} disabled={blockUi || gitBusy}>찾기</button>
                  </div>
                </label>
                <label className="admin-field admin-check">
                  <input
                    type="checkbox"
                    checked={settingsDraft.autoPush}
                    onChange={(event) => setSettingsDraft((prev) => ({ ...prev, autoPush: event.target.checked }))}
                  />
                  <span>Auto Push 사용</span>
                </label>
                <label className="admin-field">
                  <span>기본 툴</span>
                  <select
                    value={settingsDraft.defaultTool}
                    onChange={(event) => setSettingsDraft((prev) => ({ ...prev, defaultTool: event.target.value as ToolType }))}
                  >
                    <option value="claude">claude</option>
                    <option value="codex">codex</option>
                    <option value="gemini">gemini</option>
                    <option value="cursor">cursor</option>
                    <option value="antigravity">antigravity</option>
                  </select>
                </label>
                <label className="admin-field">
                  <span>글자 크기 ({settingsDraft.fontSize}px)</span>
                  <div className="admin-inline">
                    <input
                      type="range"
                      min={11}
                      max={22}
                      step={1}
                      value={settingsDraft.fontSize}
                      onChange={(event) => {
                        const size = Number(event.target.value);
                        setSettingsDraft((prev) => ({ ...prev, fontSize: size }));
                        document.documentElement.style.setProperty("--app-font-size", `${size}px`);
                      }}
                      style={{ flex: 1 }}
                    />
                    <span style={{ minWidth: 36, textAlign: "right" }}>{settingsDraft.fontSize}px</span>
                  </div>
                </label>
                <div className="button-row">
                  <button onClick={() => void initializeCentralInSettings()} disabled={blockUi || gitBusy}>Git 초기화</button>
                  <button className="primary" onClick={() => void saveAdminSettings()} disabled={blockUi || gitBusy}>설정 저장</button>
                </div>
              </section>

              <section className="admin-section">
                <h3>Git 진단</h3>
                <div className="admin-diagnostics">
                  <div><strong>Git 저장소:</strong> {gitDiagnostics?.isGitRepo ? "예" : "아니오"}</div>
                  <div><strong>브랜치:</strong> {gitDiagnostics?.branch || "-"}</div>
                  <div><strong>Upstream:</strong> {gitDiagnostics?.upstream || "-"}</div>
                  <div><strong>변경 파일:</strong> {gitDiagnostics?.changedFiles.length ?? 0}개</div>
                  <div><strong>origin URL:</strong> {gitDiagnostics?.originUrl || "-"}</div>
                </div>
                <div className="button-row">
                  <button onClick={() => void refreshGitDiagnostics(settingsDraft.centralRepo.trim())} disabled={gitBusy}>Git 상태 새로고침</button>
                  <button onClick={() => void testOriginRemote()} disabled={gitBusy || !settingsDraft.centralRepo.trim()}>origin 연결 테스트</button>
                  <button onClick={() => void openOriginUrl()} disabled={!gitDiagnostics?.originUrl}>원격 URL 열기</button>
                </div>
                <div className="admin-remote-list">
                  {(gitDiagnostics?.remotes ?? []).map((remote) => (
                    <div key={remote.name} className="admin-remote-item">
                      <strong>{remote.name}</strong>
                      <span>fetch: {remote.fetchUrl || "-"}</span>
                      <span>push: {remote.pushUrl || "-"}</span>
                    </div>
                  ))}
                  {(gitDiagnostics?.remotes.length ?? 0) === 0 && <p>등록된 원격 저장소가 없습니다.</p>}
                </div>
              </section>

              <section className="admin-section admin-section-wide">
                <h3>외부 스킬 설치 (npx skills)</h3>
                <p className="admin-help">
                  GitHub 공개 저장소에서 스킬을 설치합니다. 지정한 경로에서 <code>npx skills add</code>를 실행하며, 해당 경로의 <code>.agents/skills/</code> 안에 스킬이 설치됩니다.
                </p>
                <div className="cli-form">
                  <div className="admin-field">
                    <span>설치 경로</span>
                    <div className="cli-path-row">
                      <select
                        value={skillsCliCustomPath ? "__custom__" : skillsCliTarget}
                        onChange={(event) => {
                          const v = event.target.value;
                          if (v === "__custom__") return;
                          setSkillsCliCustomPath("");
                          setSkillsCliTarget(v as "workspace" | "central");
                        }}
                      >
                        <option value="workspace">
                          작업 폴더{activeWorkspace ? ` — ${activeWorkspace.name}` : " (없음)"}
                        </option>
                        <option value="central">
                          중앙 저장소{config?.centralRepo ? ` — ${config.centralRepo}` : " (없음)"}
                        </option>
                        {(config?.workspaces ?? []).filter((w) => w.id !== GLOBAL_WORKSPACE_ID && w.id !== config?.activeWorkspaceId).map((w) => (
                          <option key={w.id} value={`__ws_${w.id}`} onClick={() => { setSkillsCliCustomPath(w.path); }}>
                            {w.name} — {w.path}
                          </option>
                        ))}
                        {skillsCliCustomPath && <option value="__custom__">직접 입력: {skillsCliCustomPath}</option>}
                      </select>
                      <button
                        className="cli-browse-btn"
                        onClick={async () => {
                          const dir = await window.electronAPI.chooseDirectory();
                          if (dir) setSkillsCliCustomPath(dir);
                        }}
                        disabled={skillsCliBusy}
                        title="폴더 선택"
                      >
                        폴더 선택
                      </button>
                    </div>
                    <span className="cli-path-display">
                      설치 위치: <code>{getSkillsCliCwd(skillsCliTarget) ?? "경로 없음"}</code>
                    </span>
                  </div>
                  <label className="admin-field">
                    <span>스킬 저장소 주소 <em className="field-hint">GitHub owner/repo 또는 전체 URL</em></span>
                    <input
                      value={skillsCliRepo}
                      onChange={(event) => setSkillsCliRepo(event.target.value)}
                      placeholder="langchain-ai/langchain-skills"
                      spellCheck={false}
                    />
                  </label>
                  <label className="admin-field">
                    <span>설치할 스킬 이름 <em className="field-hint">콤마 구분 · 전체 설치는 *</em></span>
                    <input
                      value={skillsCliSkillNames}
                      onChange={(event) => setSkillsCliSkillNames(event.target.value)}
                      placeholder="* (전체) 또는 nextjs, react"
                      spellCheck={false}
                    />
                  </label>
                  <div className="cli-preview">
                    <span className="cli-preview-label">실행될 명령어</span>
                    <code className="cli-preview-cmd">
                      {(() => {
                        const raw = skillsCliRepo.trim();
                        const repo = raw
                          ? raw.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "")
                          : "<저장소>";
                        const skillArgs = parseSkillsCliSkillInputs(skillsCliSkillNames)
                          .map((s) => `--skill '${s}'`)
                          .join(" ");
                        return `npx -y skills add ${repo}${skillArgs ? " " + skillArgs : ""} --yes`;
                      })()}
                    </code>
                  </div>
                  <div className="button-row">
                    <button
                      className="btn-primary"
                      onClick={() => void runSkillsCliAction("add")}
                      disabled={skillsCliBusy || !skillsCliRepo.trim() || !getSkillsCliCwd(skillsCliTarget)}
                    >
                      {skillsCliBusy ? "설치 중..." : "설치 (add)"}
                    </button>
                    <button onClick={() => void runSkillsCliAction("list")} disabled={skillsCliBusy || !getSkillsCliCwd(skillsCliTarget)}>목록 (list)</button>
                    <button onClick={() => void runSkillsCliAction("check")} disabled={skillsCliBusy || !getSkillsCliCwd(skillsCliTarget)}>검사 (check)</button>
                    <button onClick={() => void runSkillsCliAction("update")} disabled={skillsCliBusy || !getSkillsCliCwd(skillsCliTarget)}>업데이트 (update)</button>
                  </div>
                </div>
                {skillsCliOutput && (
                  <pre className="admin-cli-output">{skillsCliOutput}</pre>
                )}
              </section>
            </div>
          </div>
        </div>
      )}
      {preview && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal-card" role="dialog" aria-modal="true" aria-label="전송 Diff 확인">
            <div className="modal-head">
              <h2>{preview.mode === "toCentral" ? "중앙 저장 전 확인" : "workspace 반영 전 확인"}</h2>
              <button onClick={() => { setPreview(null); setWarnings([]); }} disabled={blockUi}>닫기</button>
            </div>
            <div className="modal-route">
              {preview.mode === "toCentral" ? "작업 폴더 → 중앙 저장소" : "중앙 저장소 → 작업 폴더"}
            </div>
            <div className="summary-grid">
              <div>총 선택: {preview.selections.length}개</div>
              <div>변경 파일: {preview.existingChanged.length}개</div>
              <div>새 파일: {preview.newFiles}개</div>
              <div>동일 파일: {preview.unchanged}개</div>
            </div>
            {warnings.length > 0 && (
              <div className="warning-box">
                <strong>민감 정보 경고</strong>
                <ul>
                  {warnings.map((w, idx) => (
                    <li key={`${w.rule}-${idx}`}>{w.rule}: {w.description}</li>
                  ))}
                </ul>
              </div>
            )}
              <div className="diff-list modal-diff">
                {preview.existingChanged.map((item) => (
                  <details key={toSelectionKey(item.tool, item.relativePath)}>
                    <summary>{item.tool}/{item.relativePath}</summary>
                    <DiffView diffText={item.diff.unifiedDiff} />
                  </details>
                ))}
              </div>
            <div className="button-row">
              <button onClick={() => { setPreview(null); setWarnings([]); }} disabled={blockUi}>취소</button>
              <button className="primary" onClick={() => void executeTransfer()} disabled={blockUi}>전송 진행</button>
            </div>
          </div>
        </div>
      )}
      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
          onClick={(event) => event.stopPropagation()}
        >
          <button onClick={() => { setContextMenu(null); void runCrud(contextMenu.side, "createFile", contextMenu.node); }}>새 파일</button>
          <button onClick={() => { setContextMenu(null); void runCrud(contextMenu.side, "createFolder", contextMenu.node); }}>새 폴더</button>
          <button onClick={() => { setContextMenu(null); void runCrud(contextMenu.side, "rename", contextMenu.node); }}>이름 변경</button>
          <button onClick={() => { setContextMenu(null); void runCrud(contextMenu.side, "duplicate", contextMenu.node); }}>복제</button>
          <button onClick={() => { setContextMenu(null); void runCrud(contextMenu.side, "delete", contextMenu.node); }}>삭제</button>
          <div className="context-sep" />
          <button onClick={() => { saveGroupFromNode(contextMenu.side, contextMenu.node); setContextMenu(null); }}>이 항목으로 그룹 저장</button>
          <button onClick={() => { saveCurrentSelectionGroup(contextMenu.side); setContextMenu(null); }}>현재 선택으로 그룹 저장</button>
          <div className="context-sep" />
          {contextMenu.side === "workspace" ? (
            <button
              onClick={() => {
                const picks = getContextTransferSelections(contextMenu.side, contextMenu.node);
                setContextMenu(null);
                void startTransferWithSelections("toCentral", picks);
              }}
            >
              중앙 저장소로 내보내기 ({getContextTransferSelections(contextMenu.side, contextMenu.node).length}개)
            </button>
          ) : (
            <button
              onClick={() => {
                const picks = getContextTransferSelections(contextMenu.side, contextMenu.node);
                setContextMenu(null);
                void startTransferWithSelections("toWorkspace", picks);
              }}
            >
              작업 폴더로 가져오기 ({getContextTransferSelections(contextMenu.side, contextMenu.node).length}개)
            </button>
          )}
        </div>
      )}
    </div>
  );
}

type DiffViewProps = {
  diffText: string;
};

function DiffView(props: DiffViewProps) {
  const lines = props.diffText
    .split(/\r?\n/)
    .filter((line) => line.startsWith("@@") || line.startsWith("+") || line.startsWith("-"))
    .filter((line) => !line.startsWith("+++ ") && !line.startsWith("--- "));

  if (lines.length === 0) {
    return <div className="diff-empty">실제 텍스트 변경 라인이 없습니다. (줄바꿈/메타데이터 차이 제외)</div>;
  }

  return (
    <pre className="diff-view">
      {lines.map((line, index) => {
        const cls = getDiffLineClass(line);
        return (
          <div key={`diff-${index}`} className={`diff-line ${cls}`}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

function MarkdownView({ text }: { text: string }) {
  const html = renderMarkdown(text);
  return (
    <div
      className="markdown-view"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderInline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

function renderMarkdown(src: string): string {
  const lines = src.split(/\r?\n/);
  const out: string[] = [];
  let inFence = false;
  let fenceBuffer: string[] = [];
  let inList = false;

  const flushList = () => {
    if (inList) { out.push("</ul>"); inList = false; }
  };

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (!inFence) {
        flushList();
        inFence = true;
        fenceBuffer = [];
      } else {
        inFence = false;
        out.push(`<pre class="md-code"><code>${escapeHtml(fenceBuffer.join("\n"))}</code></pre>`);
        fenceBuffer = [];
      }
      continue;
    }
    if (inFence) { fenceBuffer.push(line); continue; }

    if (/^#{1,6}\s/.test(line)) {
      flushList();
      const level = (line.match(/^(#+)/) ?? ["#"])[0].length;
      const content = line.replace(/^#+\s*/, "");
      out.push(`<h${level} class="md-h">${renderInline(content)}</h${level}>`);
      continue;
    }
    if (/^---+$/.test(line.trim())) { flushList(); out.push("<hr class='md-hr'>"); continue; }
    if (/^[-*]\s/.test(line)) {
      if (!inList) { out.push("<ul class='md-list'>"); inList = true; }
      out.push(`<li>${renderInline(line.replace(/^[-*]\s/, ""))}</li>`);
      continue;
    }
    flushList();
    if (line.trim() === "") { out.push("<br>"); continue; }
    out.push(`<p class="md-p">${renderInline(line)}</p>`);
  }
  flushList();
  if (inFence) out.push(`<pre class="md-code"><code>${escapeHtml(fenceBuffer.join("\n"))}</code></pre>`);
  return out.join("");
}

function getDiffLineClass(line: string): string {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++ ") || line.startsWith("--- ")) return "meta";
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  if (line.startsWith("Index:") || line.startsWith("===")) return "head";
  return "context";
}

type TreeSectionProps = {
  title: string;
  selectionLabel: string;
  side: TreeSide;
  roots: TreeNode[];
  expanded: Record<string, boolean>;
  checked: Record<string, boolean>;
  activeKey: string | null;
  multi: Record<string, boolean>;
  statuses?: ToolStatus[];
  fileDiffMap?: Record<string, string>;
  toolFocus?: ToolType | null;
  onToolFocusChange?: (tool: ToolType | null) => void;
  activeNode: TreeNode | null;
  filterQuery: string;
  onFilterChange: (value: string) => void;
  filterMode: "text" | "group";
  onFilterModeChange: (mode: "text" | "group") => void;
  groupOptions: Array<{ id: string; name: string }>;
  groupSelection: string[];
  onGroupSelectionChange: (groupId: string) => void;
  onExpandAll: (side: TreeSide) => void;
  onCollapseAll: (side: TreeSide) => void;
  activeGroupFilterCount: number;
  activeGroupNames: string[];
  transferActions?: ReactNode;
  blockUi: boolean;
  modalOpen: boolean;
  onCrud: (side: TreeSide, action: CrudAction, node?: TreeNode) => Promise<void>;
  onSaveGroupFromNode: (side: TreeSide, node: TreeNode) => Promise<void>;
  onSaveCurrentGroup: (side: TreeSide) => Promise<void>;
  onOpenRootPath: () => void;
  onToggleExpand: (side: TreeSide, key: string) => void;
  onToggleCheck: (side: TreeSide, key: string, value: boolean) => void;
  onClickNode: (side: TreeSide, node: TreeNode, event: MouseEvent<HTMLButtonElement>) => void;
  onContextMenu: (side: TreeSide, node: TreeNode, event: MouseEvent) => void;
};

function TreeSection(props: TreeSectionProps) {
  const { activeNode, blockUi, modalOpen, onCrud, side } = props;
  const visibleRoots = useMemo(() => {
    if (!props.toolFocus) return props.roots;
    if (props.roots.length !== 1) return props.roots;
    const [root] = props.roots;
    if (!root || root.type !== "folder") return props.roots;
    if (root.relativePath !== "") return props.roots;
    return root.children;
  }, [props.roots, props.toolFocus]);
  return (
    <article className="tree-panel">
      <div className="panel-head">
        <div className="panel-head-left">
          <h2>{props.title}</h2>
          <strong>{props.selectionLabel}</strong>
        </div>
        {props.transferActions}
      </div>
      {props.activeGroupFilterCount > 0 && (
        <div className="group-filter-badge">
          <strong>그룹 필터 {props.activeGroupFilterCount}개</strong>
          <div className="group-filter-name-list">
            {props.activeGroupNames.map((name) => (
              <span key={name} className="group-filter-name-chip">{name}</span>
            ))}
          </div>
        </div>
      )}
      {(props.statuses?.length ?? 0) > 0 && (
        <div className="tool-badges">
          <button
            className={`badge filter-btn ${props.toolFocus === null ? "active" : ""}`}
            onClick={() => props.onToolFocusChange?.(null)}
            disabled={blockUi || modalOpen}
          >
            전체
          </button>
          {props.statuses?.map((s) => (
            <button
              key={`${side}-${s.tool}`}
              className={`badge filter-btn ${s.exists ? `tool-${s.tool}` : "missing"} ${props.toolFocus === s.tool ? "active" : ""}`}
              onClick={() => props.onToolFocusChange?.(props.toolFocus === s.tool ? null : s.tool)}
              disabled={blockUi || modalOpen}
              title={s.exists ? `${s.tool}만 보기` : `${s.tool} 없음`}
            >
              {s.tool} {s.exists ? "있음" : "없음"}
            </button>
          ))}
        </div>
      )}
      <div className="tree-toolbar">
        <select
          className="tree-filter-mode"
          value={props.filterMode}
          onChange={(event) => props.onFilterModeChange(event.target.value as "text" | "group")}
          disabled={blockUi || modalOpen}
          title="검색 모드"
        >
          <option value="text">텍스트</option>
          <option value="group">그룹</option>
        </select>
        {props.filterMode === "text" ? (
          <input
            className="tree-search"
            placeholder="검색..."
            value={props.filterQuery}
            onChange={(event) => props.onFilterChange(event.target.value)}
          />
        ) : (
          <div className="tree-group-picker" title="그룹 선택으로 필터">
            {props.groupOptions.length === 0 ? (
              <span className="tree-group-empty">그룹 없음</span>
            ) : (
              props.groupOptions.map((group) => (
                <button
                  key={group.id}
                  type="button"
                  className={`tree-group-chip ${props.groupSelection.includes(group.id) ? "active" : ""}`}
                  onClick={() => props.onGroupSelectionChange(group.id)}
                  disabled={blockUi || modalOpen}
                >
                  {group.name}
                </button>
              ))
            )}
          </div>
        )}
        <button className="icon-btn" onClick={props.onOpenRootPath} disabled={blockUi || modalOpen} title="현재 패널의 루트 폴더 열기">폴더 열기</button>
        <button className="icon-btn" onClick={() => props.onExpandAll(side)} disabled={blockUi || modalOpen} title="전체 펼치기">펼치기</button>
        <button className="icon-btn" onClick={() => props.onCollapseAll(side)} disabled={blockUi || modalOpen} title="전체 접기">접기</button>
      </div>
      <CrudActionBar
        side={side}
        activeNode={activeNode}
        blockUi={blockUi}
        modalOpen={modalOpen}
        onCrud={onCrud}
        onSaveGroupFromNode={props.onSaveGroupFromNode}
        onSaveCurrentGroup={props.onSaveCurrentGroup}
      />
      <TreeView
        side={props.side}
        roots={visibleRoots}
        fileDiffMap={props.fileDiffMap ?? {}}
        expanded={props.expanded}
        checked={props.checked}
        activeKey={props.activeKey}
        multi={props.multi}
        onToggleExpand={props.onToggleExpand}
        onToggleCheck={props.onToggleCheck}
        onClickNode={props.onClickNode}
        onContextMenu={props.onContextMenu}
      />
    </article>
  );
}

type CrudActionBarProps = {
  side: TreeSide;
  activeNode: TreeNode | null;
  blockUi: boolean;
  modalOpen: boolean;
  onCrud: (side: TreeSide, action: CrudAction, node?: TreeNode) => Promise<void>;
  onSaveGroupFromNode: (side: TreeSide, node: TreeNode) => Promise<void>;
  onSaveCurrentGroup: (side: TreeSide) => Promise<void>;
};

function CrudActionBar(props: CrudActionBarProps) {
  const disabled = props.blockUi || props.modalOpen;
  const target = props.activeNode ?? undefined;
  return (
    <div className="crud-row">
      <button className="icon-btn" onClick={() => void props.onCrud(props.side, "createFile", target)} disabled={disabled} title="새 파일">+ 파일</button>
      <button className="icon-btn" onClick={() => void props.onCrud(props.side, "createFolder", target)} disabled={disabled} title="새 폴더">+ 폴더</button>
      <button
        className="icon-btn"
        onClick={() => void props.onSaveCurrentGroup(props.side)}
        disabled={disabled}
        title="체크/선택한 항목으로 그룹 저장"
      >
        + 그룹
      </button>
      <button className="icon-btn" onClick={() => void props.onCrud(props.side, "rename", target)} disabled={disabled || !target} title="이름 변경">수정</button>
      <button className="icon-btn" onClick={() => void props.onCrud(props.side, "duplicate", target)} disabled={disabled || !target} title="복제">복제</button>
      <button className="icon-btn" onClick={() => void props.onCrud(props.side, "delete", target)} disabled={disabled || !target} title="삭제">삭제</button>
    </div>
  );
}

function normalizeSkillsPath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

function isSkillsRelativePath(relativePath: string): boolean {
  const normalized = normalizeSkillsPath(relativePath).toLowerCase();
  return normalized === "skills" || normalized.startsWith("skills/");
}

function sanitizeSelectionGroups(
  groups: SelectionGroup[]
): { groups: SelectionGroup[]; removedTargets: number; removedGroups: number } {
  const sanitized: SelectionGroup[] = [];
  let removedTargets = 0;
  let removedGroups = 0;

  for (const group of groups) {
    const filteredTargets = (group.targets ?? []).filter((target) => {
      const keep = isSkillsRelativePath(target.relativePath);
      if (!keep) removedTargets += 1;
      return keep;
    });

    if (filteredTargets.length === 0) {
      removedGroups += 1;
      continue;
    }

    sanitized.push({ ...group, targets: filteredTargets });
  }

  return { groups: sanitized, removedTargets, removedGroups };
}

function normalizePathForCompare(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function normalizeSkillsRepoName(raw: string): string {
  const repo = raw.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").trim();
  return repo;
}

function resolveSkillsCliGroupSide(cwd: string, workspacePath: string | null, centralPath: string | null): TreeSide | null {
  const current = normalizePathForCompare(cwd);
  if (centralPath && current === normalizePathForCompare(centralPath)) return "central";
  if (workspacePath && current === normalizePathForCompare(workspacePath)) return "workspace";
  return null;
}

async function loadSkillFilesBySide(
  side: TreeSide,
  workspacePath: string | null,
  centralPath: string | null
): Promise<Skill[]> {
  if (side === "central") {
    if (!centralPath) return [];
    return await window.electronAPI.listCentralSkills(centralPath);
  }
  if (!workspacePath) return [];
  const inspected = await window.electronAPI.inspectWorkspace(workspacePath);
  return inspected.workspaceSkills;
}

function extractInstalledSkillFolderNames(output: string): string[] {
  const regex = /[\\/]\.agents[\\/]skills[\\/]([a-z0-9._-]+)/gi;
  const found = new Set<string>();
  let match: RegExpExecArray | null = regex.exec(output);
  while (match) {
    if (match[1]) found.add(match[1]);
    match = regex.exec(output);
  }
  return [...found];
}

function inferNewSkillFolderNames(before: Skill[], after: Skill[]): string[] {
  const beforeFolders = collectSkillFolderNames(before);
  const afterFolders = collectSkillFolderNames(after);
  return [...afterFolders].filter((name) => !beforeFolders.has(name));
}

function collectSkillFolderNames(items: Skill[]): Set<string> {
  const names = new Set<string>();
  for (const item of items) {
    const rel = item.relativePath.replace(/\\/g, "/");
    if (!rel.startsWith("skills/")) continue;
    const parts = rel.split("/");
    if (parts.length >= 2 && parts[1]) names.add(parts[1]);
  }
  return names;
}

function buildGroupTargetsFromNames(items: Skill[], folderNames: string[]): GroupTarget[] {
  const names = new Set(folderNames.map((name) => name.trim()).filter(Boolean));
  const targets: GroupTarget[] = [];
  for (const tool of toolOrder) {
    for (const name of names) {
      const prefix = `skills/${name}/`;
      const exists = items.some((item) => item.tool === tool && item.relativePath.replace(/\\/g, "/").startsWith(prefix));
      if (!exists) continue;
      targets.push({ kind: "folder", tool, relativePath: `skills/${name}` });
    }
  }
  return targets;
}

function uniqueGroupName(groups: SelectionGroup[], side: TreeSide, baseName: string): string {
  const used = new Set(groups.filter((group) => group.side === side).map((group) => group.name));
  if (!used.has(baseName)) return baseName;
  let index = 2;
  let candidate = `${baseName} (${index})`;
  while (used.has(candidate)) {
    index += 1;
    candidate = `${baseName} (${index})`;
  }
  return candidate;
}

type TreeViewProps = {
  side: TreeSide;
  roots: TreeNode[];
  fileDiffMap: Record<string, string>;
  expanded: Record<string, boolean>;
  checked: Record<string, boolean>;
  activeKey: string | null;
  multi: Record<string, boolean>;
  onToggleExpand: (side: TreeSide, key: string) => void;
  onToggleCheck: (side: TreeSide, key: string, value: boolean) => void;
  onClickNode: (side: TreeSide, node: TreeNode, event: MouseEvent<HTMLButtonElement>) => void;
  onContextMenu: (side: TreeSide, node: TreeNode, event: MouseEvent) => void;
};

function TreeView(props: TreeViewProps) {
  return (
    <ul className="tree-root">
      {props.roots.map((node) => (
        <TreeNodeItem
          key={node.key}
          side={props.side}
          node={node}
          fileDiffMap={props.fileDiffMap}
          depth={0}
          expanded={props.expanded}
          checked={props.checked}
          activeKey={props.activeKey}
          multi={props.multi}
          onToggleExpand={props.onToggleExpand}
          onToggleCheck={props.onToggleCheck}
          onClickNode={props.onClickNode}
          onContextMenu={props.onContextMenu}
        />
      ))}
    </ul>
  );
}

type TreeNodeItemProps = {
  side: TreeSide;
  node: TreeNode;
  fileDiffMap: Record<string, string>;
  depth: number;
  expanded: Record<string, boolean>;
  checked: Record<string, boolean>;
  activeKey: string | null;
  multi: Record<string, boolean>;
  onToggleExpand: (side: TreeSide, key: string) => void;
  onToggleCheck: (side: TreeSide, key: string, value: boolean) => void;
  onClickNode: (side: TreeSide, node: TreeNode, event: MouseEvent<HTMLButtonElement>) => void;
  onContextMenu: (side: TreeSide, node: TreeNode, event: MouseEvent) => void;
};

function TreeNodeItem(props: TreeNodeItemProps) {
  const { node, side, depth, expanded, checked, activeKey, multi } = props;
  const isExpanded = expanded[node.key] ?? true;
  const isActive = activeKey === node.key;
  const isMulti = Boolean(multi[node.key]);
  const fileKey = `${node.tool}:${node.relativePath}`;
  const diffHint = node.type === "file" ? props.fileDiffMap[fileKey] : undefined;
  const isFolder = node.type === "folder";
  const folderIcon = isExpanded ? "▾ " : "▸ ";
  const fileExt = node.name.split(".").pop()?.toLowerCase();
  const fileIcon = fileExt === "md" ? "M" : fileExt === "json" ? "J" : "·";

  return (
    <li>
      <div
        className={`tree-item ${isActive ? "active" : ""} ${isMulti ? "multi" : ""}`}
        style={{ paddingLeft: `${depth * 16}px` }}
        onContextMenu={(event) => props.onContextMenu(side, node, event)}
        onDoubleClick={() => { if (isFolder) props.onToggleExpand(side, node.key); }}
      >
        {isFolder ? (
          <input
            type="checkbox"
            checked={Boolean(checked[node.key])}
            onChange={(event) => props.onToggleCheck(side, node.key, event.target.checked)}
            className="folder-check"
            title="폴더 전체 전송 선택"
          />
        ) : (
          <span className="folder-check placeholder" />
        )}

        <span className="tree-node-icon" onClick={() => { if (isFolder) props.onToggleExpand(side, node.key); }}>
          {isFolder ? folderIcon : fileIcon}
        </span>

        <button
          className="tree-label"
          onClick={(event) => props.onClickNode(side, node, event)}
          onDoubleClick={(event) => {
            event.stopPropagation();
            if (isFolder) props.onToggleExpand(side, node.key);
          }}
          title={`${node.tool}/${node.relativePath}`}
        >
          {node.name}
        </button>
        {diffHint && <span className="file-diff-hint">{diffHint}</span>}
      </div>

      {node.children.length > 0 && isExpanded && (
        <ul>
          {node.children.map((child) => (
            <TreeNodeItem
              key={child.key}
              side={side}
              node={child}
              fileDiffMap={props.fileDiffMap}
              depth={depth + 1}
              expanded={expanded}
              checked={checked}
              activeKey={activeKey}
              multi={multi}
              onToggleExpand={props.onToggleExpand}
              onToggleCheck={props.onToggleCheck}
              onClickNode={props.onClickNode}
              onContextMenu={props.onContextMenu}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function toSelectionKey(tool: ToolType, relativePath: string) {
  return `${tool}:${relativePath}`;
}

function flattenKeys(nodes: TreeNode[]): string[] {
  const out: string[] = [];
  const walk = (list: TreeNode[]) => {
    for (const node of list) {
      out.push(node.key);
      if (node.children.length > 0) {
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return out;
}

function mapNodesByKey(nodes: TreeNode[]): Map<string, TreeNode> {
  const map = new Map<string, TreeNode>();
  const walk = (list: TreeNode[]) => {
    for (const node of list) {
      map.set(node.key, node);
      if (node.children.length > 0) {
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return map;
}

function collectFileDescendants(node: TreeNode): TreeNode[] {
  if (node.type === "file") return [node];
  const out: TreeNode[] = [];
  const walk = (entry: TreeNode) => {
    for (const child of entry.children) {
      if (child.type === "file") {
        out.push(child);
      } else {
        walk(child);
      }
    }
  };
  walk(node);
  return out;
}

function buildTree(side: TreeSide, skills: Skill[]): TreeNode[] {
  const roots = new Map<ToolType, TreeNode>();

  for (const tool of toolOrder) {
    roots.set(tool, {
      key: `${side}:${tool}`,
      side,
      name: tool,
      type: "folder",
      tool,
      relativePath: "",
      children: []
    });
  }

  for (const skill of skills) {
    const root = roots.get(skill.tool);
    if (!root) continue;

    const parts = normalizeRel(skill.relativePath).split("/").filter(Boolean);
    let cursor = root;
    let pathSoFar = "";

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      const isLast = index === parts.length - 1;
      pathSoFar = pathSoFar ? `${pathSoFar}/${part}` : part;

      let child = cursor.children.find((item) => item.name === part);
      if (!child) {
        child = {
          key: `${side}:${skill.tool}:${pathSoFar}`,
          side,
          name: part,
          type: isLast ? "file" : "folder",
          tool: skill.tool,
          relativePath: pathSoFar,
          children: []
        };
        cursor.children.push(child);
      }

      cursor = child;
    }
  }

  const sortTree = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) {
      sortTree(node.children);
    }
  };

  const list = [...roots.values()].filter((root) => root.children.length > 0);
  sortTree(list);
  return list;
}

function filterTree(nodes: TreeNode[], query: string): TreeNode[] {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return nodes;

  const walk = (list: TreeNode[]): TreeNode[] => {
    const out: TreeNode[] = [];
    for (const node of list) {
      const childFiltered = walk(node.children);
      const matched = `${node.name} ${node.relativePath}`.toLowerCase().includes(keyword);
      if (matched || childFiltered.length > 0) {
        out.push({ ...node, children: childFiltered });
      }
    }
    return out;
  };

  return walk(nodes);
}

function filterTreeByTool(nodes: TreeNode[], tool: ToolType | null): TreeNode[] {
  if (!tool) return nodes;
  return nodes.filter((node) => node.tool === tool);
}

function filterTreeByKeys(nodes: TreeNode[], allowedKeys: Set<string>): TreeNode[] {
  const walk = (list: TreeNode[]): TreeNode[] => {
    const out: TreeNode[] = [];
    for (const node of list) {
      if (allowedKeys.has(node.key)) {
        out.push(node);
        continue;
      }
      const filteredChildren = walk(node.children);
      if (filteredChildren.length > 0) {
        out.push({ ...node, children: filteredChildren });
      }
    }
    return out;
  };
  return walk(nodes);
}

function applyGroupFiltersToTree(
  side: TreeSide,
  tree: TreeNode[],
  activeGroupIds: string[],
  groups: SelectionGroup[]
): TreeNode[] {
  if (activeGroupIds.length === 0) return tree;
  const idSet = new Set(activeGroupIds);
  const selectedGroups = groups.filter((group) => group.side === side && idSet.has(group.id));
  if (selectedGroups.length === 0) return tree;

  const allowedKeys = new Set<string>();
  for (const group of selectedGroups) {
    for (const target of group.targets) {
      allowedKeys.add(`${side}:${target.tool}:${target.relativePath}`);
    }
  }
  return filterTreeByKeys(tree, allowedKeys);
}

function buildExpandedMap(nodes: TreeNode[], expanded: boolean): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  const walk = (list: TreeNode[]) => {
    for (const node of list) {
      if (node.type === "folder") out[node.key] = expanded;
      if (node.children.length > 0) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

function normalizeRel(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

function dirname(relativePath: string): string {
  const normalized = normalizeRel(relativePath);
  const index = normalized.lastIndexOf("/");
  if (index < 0) return "";
  return normalized.slice(0, index);
}

function basenameRel(relativePath: string): string {
  const normalized = normalizeRel(relativePath);
  const index = normalized.lastIndexOf("/");
  if (index < 0) return normalized;
  return normalized.slice(index + 1);
}

function joinPath(base: string, tail: string): string {
  if (!base) return tail;
  return `${base}/${tail}`;
}

function resolveInputRelativePath(input: string, parentPath: string): string {
  const raw = input.trim();
  if (!raw) return "";
  const normalizedInput = normalizeRel(raw);
  if (!normalizedInput) return "";
  const hasPathSeparator = raw.includes("/") || raw.includes("\\");
  if (hasPathSeparator || !parentPath) return normalizedInput;
  return normalizeRel(joinPath(parentPath, normalizedInput));
}

function withFileSuffix(relativePath: string, suffix: string): string {
  const normalized = normalizeRel(relativePath);
  const slash = normalized.lastIndexOf("/");
  const dir = slash >= 0 ? normalized.slice(0, slash + 1) : "";
  const file = slash >= 0 ? normalized.slice(slash + 1) : normalized;

  const dot = file.lastIndexOf(".");
  if (dot <= 0) return `${dir}${file}${suffix}`;
  return `${dir}${file.slice(0, dot)}${suffix}${file.slice(dot)}`;
}

function findFolderNode(byKey: Map<string, TreeNode>, tool: ToolType, relativePath: string): TreeNode | null {
  for (const node of byKey.values()) {
    if (node.type !== "folder") continue;
    if (node.tool !== tool) continue;
    if (node.relativePath !== relativePath) continue;
    return node;
  }
  return null;
}

function workspaceShortLabel(item: WorkspaceEntry): string {
  if (item.id === GLOBAL_WORKSPACE_ID) return "GH";
  const base = item.name.trim();
  if (!base) return "WS";
  const parts = base.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
  }
  const compact = base.replace(/[^a-zA-Z0-9]/g, "");
  if (compact.length >= 2) return compact.slice(0, 2).toUpperCase();
  return compact.toUpperCase() || "WS";
}

function groupTargetSummary(targets: GroupTarget[]): string {
  const folderCount = targets.filter((target) => target.kind === "folder").length;
  const fileCount = targets.length - folderCount;
  if (folderCount > 0 && fileCount > 0) return `폴더 ${folderCount}, 파일 ${fileCount}`;
  if (folderCount > 0) return `폴더 ${folderCount}`;
  return `파일 ${fileCount}`;
}

function buildDiffHintMap(items: DiffStatItem[], side: TreeSide): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of items) {
    if (item.status === "onlyWorkspace" && side !== "workspace") continue;
    if (item.status === "onlyCentral" && side !== "central") continue;
    const key = `${item.tool}:${item.relativePath}`;
    out[key] = formatDiffHint(item);
  }
  return out;
}

function formatDiffHint(item: DiffStatItem): string {
  if (item.status === "onlyWorkspace") return "W only";
  if (item.status === "onlyCentral") return "C only";
  const sizeSign = item.sizeDelta > 0 ? `+${item.sizeDelta}` : `${item.sizeDelta}`;
  return `L +${item.addedLines}/-${item.removedLines} | B ${sizeSign}`;
}

function groupUpdateCandidates(items: UpdateCandidate[]): Array<{ tool: ToolType; group: string; items: UpdateCandidate[] }> {
  const map = new Map<string, { tool: ToolType; group: string; items: UpdateCandidate[] }>();
  for (const item of items) {
    const group = inferSkillGroup(item.relativePath);
    const key = `${item.tool}:${group}`;
    const current = map.get(key) ?? { tool: item.tool, group, items: [] };
    current.items.push(item);
    map.set(key, current);
  }
  return [...map.values()].sort((a, b) => a.tool.localeCompare(b.tool) || a.group.localeCompare(b.group));
}

function inferSkillGroup(relativePath: string): string {
  const parts = relativePath.split("/").filter(Boolean);
  if (parts[0] === "skills" && parts[1]) return parts[1];
  if (parts.length >= 2) return parts[parts.length - 2];
  return "기타";
}

function toBrowsableRemoteUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed.replace(/\.git$/, "");
  }

  const sshMatch = trimmed.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    return `https://${sshMatch[1]}/${sshMatch[2].replace(/\.git$/, "")}`;
  }

  return trimmed;
}

