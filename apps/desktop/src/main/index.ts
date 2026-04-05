import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import path from "node:path";
import {
  applyUpdates,
  checkCentralRepo,
  compareSkill,
  compareWorkspaceCentralOverview,
  createSkillNode,
  deleteSkillNode,
  duplicateSkillNode,
  existsSkillNode,
  findUpdateCandidates,
  getGitDiagnostics,
  importSkills,
  initializeCentralRepo,
  inspectWorkspace,
  isEditableTextFile,
  listCentralSkills,
  loadWorkspaceGroupFile,
  loadConfig,
  promoteSkills,
  readSkillText,
  renameSkillNode,
  runSkillsCli,
  saveConfig,
  saveWorkspaceGroupFile,
  scanSensitiveContent,
  syncCentralRepo,
  testGitRemote,
  validateSkillTarget,
  writeSkillText
} from "@skill-bridge/core";

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  const iconPath = path.join(app.getAppPath(), "apps", "desktop", "assets", "icon.ico");
  mainWindow = new BrowserWindow({
    width: 1450,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (!app.isPackaged) {
    const rendererUrl = process.env.SKILL_BRIDGE_RENDERER_URL ?? "http://127.0.0.1:5173";
    void mainWindow.loadURL(rendererUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../../dist-renderer/index.html"));
  }
}

ipcMain.handle("dialog:chooseDirectory", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle("config:load", async () => loadConfig());
ipcMain.handle("config:save", async (_event, payload) => saveConfig(payload));
ipcMain.handle("workspace:inspect", async (_event, workspacePath: string) => inspectWorkspace(workspacePath));
ipcMain.handle("workspace:loadGroups", async (_event, workspacePath: string) => loadWorkspaceGroupFile(workspacePath));
ipcMain.handle("workspace:saveGroups", async (_event, payload: { workspacePath: string; data: unknown }) => saveWorkspaceGroupFile(payload.workspacePath, payload.data as never));
ipcMain.handle("central:list", async (_event, centralRepoPath: string) => listCentralSkills(centralRepoPath));
ipcMain.handle("central:check", async (_event, centralRepoPath: string) => checkCentralRepo(centralRepoPath));
ipcMain.handle("central:init", async (_event, centralRepoPath: string) => initializeCentralRepo(centralRepoPath));
ipcMain.handle("diff:compare", async (_event, payload) => compareSkill(payload.workspacePath, payload.centralRepoPath, payload.tool, payload.relativePath, payload.mode));
ipcMain.handle("sensitive:scan", async (_event, text: string) => scanSensitiveContent(text));
ipcMain.handle("skills:promote", async (_event, payload) => promoteSkills(payload));
ipcMain.handle("skills:import", async (_event, payload) => importSkills(payload));
ipcMain.handle("skills:updateCandidates", async (_event, payload) => findUpdateCandidates(payload.workspacePath, payload.centralRepoPath));
ipcMain.handle("skills:overview", async (_event, payload) => compareWorkspaceCentralOverview(payload.workspacePath, payload.centralRepoPath));
ipcMain.handle("skills:applyUpdates", async (_event, payload) => applyUpdates(payload.workspacePath, payload.centralRepoPath, payload.selections));
ipcMain.handle("git:syncCentral", async (_event, payload) => syncCentralRepo(payload));
ipcMain.handle("git:diagnostics", async (_event, centralRepoPath: string) => getGitDiagnostics(centralRepoPath));
ipcMain.handle("git:testRemote", async (_event, payload: { centralRepoPath: string; remote?: string }) => testGitRemote(payload.centralRepoPath, payload.remote));
ipcMain.handle("shell:openExternal", async (_event, url: string) => shell.openExternal(url));
ipcMain.handle("shell:openPath", async (_event, targetPath: string) => shell.openPath(targetPath));
ipcMain.handle("skills:runCli", async (_event, payload) => runSkillsCli(payload));
ipcMain.handle("file:isEditable", async (_event, relativePath: string) => isEditableTextFile(relativePath));
ipcMain.handle("file:readText", async (_event, payload) => readSkillText(payload.basePath, payload.source, payload.tool, payload.relativePath));
ipcMain.handle("file:writeText", async (_event, payload) => writeSkillText(payload.basePath, payload.source, payload.tool, payload.relativePath, payload.content));
ipcMain.handle("file:create", async (_event, payload) => createSkillNode(payload.basePath, payload.source, payload.tool, payload.relativePath, payload.nodeType, payload.content));
ipcMain.handle("file:rename", async (_event, payload) => renameSkillNode(payload.basePath, payload.source, payload.tool, payload.fromRelativePath, payload.toRelativePath));
ipcMain.handle("file:delete", async (_event, payload) => deleteSkillNode(payload.basePath, payload.source, payload.tool, payload.relativePath));
ipcMain.handle("file:duplicate", async (_event, payload) => duplicateSkillNode(payload.basePath, payload.source, payload.tool, payload.fromRelativePath, payload.toRelativePath));
ipcMain.handle("file:exists", async (_event, payload) => existsSkillNode(payload.basePath, payload.source, payload.tool, payload.relativePath));
ipcMain.handle("file:validateTarget", async (_event, payload) => validateSkillTarget(payload.basePath, payload.source, payload.tool, payload.relativePath));

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
