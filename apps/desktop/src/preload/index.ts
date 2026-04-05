import { contextBridge, ipcRenderer } from "electron";

type ToolType = "claude" | "codex" | "gemini" | "cursor" | "antigravity";
type SkillSource = "workspace" | "central";

type Selection = { tool: ToolType; relativePath: string };

const api = {
  chooseDirectory: (): Promise<string | null> => ipcRenderer.invoke("dialog:chooseDirectory"),
  loadConfig: () => ipcRenderer.invoke("config:load"),
  saveConfig: (payload: unknown) => ipcRenderer.invoke("config:save", payload),
  inspectWorkspace: (workspacePath: string) => ipcRenderer.invoke("workspace:inspect", workspacePath),
  loadWorkspaceGroups: (workspacePath: string) => ipcRenderer.invoke("workspace:loadGroups", workspacePath),
  saveWorkspaceGroups: (payload: { workspacePath: string; data: unknown }) => ipcRenderer.invoke("workspace:saveGroups", payload),
  listCentralSkills: (centralRepoPath: string) => ipcRenderer.invoke("central:list", centralRepoPath),
  checkCentralRepo: (centralRepoPath: string) => ipcRenderer.invoke("central:check", centralRepoPath),
  initializeCentralRepo: (centralRepoPath: string) => ipcRenderer.invoke("central:init", centralRepoPath),
  compareSkill: (payload: { workspacePath: string; centralRepoPath: string; tool: ToolType; relativePath: string; mode: "promote" | "import" }) => ipcRenderer.invoke("diff:compare", payload),
  scanSensitive: (text: string) => ipcRenderer.invoke("sensitive:scan", text),
  promoteSkills: (payload: { workspacePath: string; centralRepoPath: string; selections: Selection[] }) => ipcRenderer.invoke("skills:promote", payload),
  importSkills: (payload: { workspacePath: string; centralRepoPath: string; selections: Selection[] }) => ipcRenderer.invoke("skills:import", payload),
  findUpdateCandidates: (payload: { workspacePath: string; centralRepoPath: string }) => ipcRenderer.invoke("skills:updateCandidates", payload),
  getOverview: (payload: { workspacePath: string; centralRepoPath: string }) => ipcRenderer.invoke("skills:overview", payload),
  applyUpdates: (payload: { workspacePath: string; centralRepoPath: string; selections: Selection[] }) => ipcRenderer.invoke("skills:applyUpdates", payload),
  syncCentralRepo: (payload: { centralRepoPath: string; commitMessage: string; push?: boolean }) => ipcRenderer.invoke("git:syncCentral", payload),
  getGitDiagnostics: (centralRepoPath: string) => ipcRenderer.invoke("git:diagnostics", centralRepoPath),
  testGitRemote: (payload: { centralRepoPath: string; remote?: string }) => ipcRenderer.invoke("git:testRemote", payload),
  openExternal: (url: string) => ipcRenderer.invoke("shell:openExternal", url),
  openPath: (targetPath: string) => ipcRenderer.invoke("shell:openPath", targetPath),
  runSkillsCli: (payload: { cwd: string; action: "add" | "check" | "update" | "list" | "find"; repo?: string; skills?: string[]; query?: string; yes?: boolean }) => ipcRenderer.invoke("skills:runCli", payload),
  isEditableFile: (relativePath: string) => ipcRenderer.invoke("file:isEditable", relativePath),
  readText: (payload: { basePath: string; source: SkillSource; tool: ToolType; relativePath: string }) => ipcRenderer.invoke("file:readText", payload),
  writeText: (payload: { basePath: string; source: SkillSource; tool: ToolType; relativePath: string; content: string }) => ipcRenderer.invoke("file:writeText", payload),
  createNode: (payload: { basePath: string; source: SkillSource; tool: ToolType; relativePath: string; nodeType: "file" | "folder"; content?: string }) => ipcRenderer.invoke("file:create", payload),
  renameNode: (payload: { basePath: string; source: SkillSource; tool: ToolType; fromRelativePath: string; toRelativePath: string }) => ipcRenderer.invoke("file:rename", payload),
  deleteNode: (payload: { basePath: string; source: SkillSource; tool: ToolType; relativePath: string }) => ipcRenderer.invoke("file:delete", payload),
  duplicateNode: (payload: { basePath: string; source: SkillSource; tool: ToolType; fromRelativePath: string; toRelativePath: string }) => ipcRenderer.invoke("file:duplicate", payload),
  existsNode: (payload: { basePath: string; source: SkillSource; tool: ToolType; relativePath: string }) => ipcRenderer.invoke("file:exists", payload),
  validateTarget: (payload: { basePath: string; source: SkillSource; tool: ToolType; relativePath: string }) => ipcRenderer.invoke("file:validateTarget", payload)
};

contextBridge.exposeInMainWorld("electronAPI", api);
