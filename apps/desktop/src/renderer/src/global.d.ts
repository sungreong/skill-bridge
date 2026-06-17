export {};

type ToolType = "claude" | "codex" | "gemini" | "cursor" | "antigravity" | "agents";
type SkillSource = "workspace" | "central";
type InstructionSource = "workspace" | "central";
type Selection = { tool: ToolType; relativePath: string };
type SkillAssetWarning = {
  code: string;
  severity: "info" | "warning" | "danger";
  message: string;
  relativePath?: string;
};
type SkillAsset = {
  source: SkillSource;
  tool: ToolType;
  skillName: string;
  rootRelativePath: string;
  hasManifest: boolean;
  fileCount: number;
  totalBytes: number;
  updatedAt: string | null;
  files: Array<{ tool: ToolType; relativePath: string; absolutePath: string }>;
  warnings: SkillAssetWarning[];
};
type InstructionFile = {
  source: InstructionSource;
  profileId: string;
  relativePath: string;
  absolutePath: string;
  totalBytes: number;
  updatedAt: string | null;
  warnings: SkillAssetWarning[];
};

declare global {
  interface Window {
    electronAPI: {
      chooseDirectory: () => Promise<string | null>;
      loadConfig: () => Promise<{ centralRepo: string; autoPush: boolean; defaultTool: ToolType; fontSize: number; treeFontScale: number; workspaces: Array<{ id: string; name: string; path: string; autoRefreshSeconds: number }>; activeWorkspaceId: string | null }>;
      saveConfig: (payload: Partial<{ centralRepo: string; autoPush: boolean; defaultTool: ToolType; fontSize: number; treeFontScale: number; workspaces: Array<{ id: string; name: string; path: string; autoRefreshSeconds: number }>; activeWorkspaceId: string | null }>) => Promise<{ centralRepo: string; autoPush: boolean; defaultTool: ToolType; fontSize: number; treeFontScale: number; workspaces: Array<{ id: string; name: string; path: string; autoRefreshSeconds: number }>; activeWorkspaceId: string | null }>;
      inspectWorkspace: (workspacePath: string) => Promise<{
        workspacePath: string;
        statuses: Array<{ tool: ToolType; workspaceDir: string; exists: boolean }>;
        workspaceSkills: Array<{ tool: ToolType; relativePath: string; absolutePath: string }>;
        invalidSkillFolders?: Array<{ tool: ToolType; relativePath: string }>;
      }>;
      listWorkspaceSkillAssets: (workspacePath: string) => Promise<SkillAsset[]>;
      loadWorkspaceGroups: (workspacePath: string) => Promise<{ version: number; groups: Array<{ id: string; name: string; side: "workspace" | "central"; targets: Array<{ kind: "file" | "folder"; tool: ToolType; relativePath: string }> }> }>;
      saveWorkspaceGroups: (payload: { workspacePath: string; data: { version: number; groups: Array<{ id: string; name: string; side: "workspace" | "central"; targets: Array<{ kind: "file" | "folder"; tool: ToolType; relativePath: string }> }> } }) => Promise<void>;
      listCentralSkills: (centralRepoPath: string) => Promise<Array<{ tool: ToolType; relativePath: string; absolutePath: string }>>;
      listCentralSkillAssets: (centralRepoPath: string) => Promise<SkillAsset[]>;
      checkCentralRepo: (centralRepoPath: string) => Promise<{ exists: boolean; isGitRepo: boolean }>;
      initializeCentralRepo: (centralRepoPath: string) => Promise<void>;
      buildSkillAssetInventory: (payload: { workspacePath: string; centralRepoPath: string }) => Promise<{ workspace: SkillAsset[]; central: SkillAsset[] }>;
      buildInstructionInventory: (payload: { workspacePath: string; centralRepoPath: string; profileId: string }) => Promise<{ profileId: string; workspace: InstructionFile[]; central: InstructionFile[]; supportedTargets: string[] }>;
      compareInstruction: (payload: { workspacePath: string; centralRepoPath: string; profileId: string; relativePath: string; mode: "promote" | "import" }) => Promise<{ hasChanges: boolean; oldText: string; newText: string; unifiedDiff: string }>;
      promoteInstructions: (payload: { workspacePath: string; centralRepoPath: string; profileId: string; selections: string[] }) => Promise<{ changedFiles: string[] }>;
      importInstructions: (payload: { workspacePath: string; centralRepoPath: string; profileId: string; selections: string[] }) => Promise<{ changedFiles: string[] }>;
      findInstructionUpdateCandidates: (payload: { workspacePath: string; centralRepoPath: string; profileId: string }) => Promise<Array<{ relativePath: string; diff: { hasChanges: boolean; oldText: string; newText: string; unifiedDiff: string } }>>;
      compareSkill: (payload: { workspacePath: string; centralRepoPath: string; tool: ToolType; relativePath: string; mode: "promote" | "import" }) => Promise<{ hasChanges: boolean; oldText: string; newText: string; unifiedDiff: string }>;
      scanSensitive: (text: string) => Promise<Array<{ rule: string; description: string }>>;
      promoteSkills: (payload: { workspacePath: string; centralRepoPath: string; selections: Selection[] }) => Promise<{ changedFiles: string[]; commitHash?: string }>;
      importSkills: (payload: { workspacePath: string; centralRepoPath: string; selections: Selection[] }) => Promise<{ changedFiles: string[] }>;
      findUpdateCandidates: (payload: { workspacePath: string; centralRepoPath: string }) => Promise<Array<{ tool: ToolType; relativePath: string; diff: { hasChanges: boolean; oldText: string; newText: string; unifiedDiff: string } }>>;
      getOverview: (payload: { workspacePath: string; centralRepoPath: string }) => Promise<{
        totalCompared: number;
        changedCount: number;
        onlyWorkspaceCount: number;
        onlyCentralCount: number;
        sameCount: number;
        items: Array<{
          tool: ToolType;
          relativePath: string;
          status: "changed" | "onlyWorkspace" | "onlyCentral";
          workspaceBytes: number;
          centralBytes: number;
          sizeDelta: number;
          addedLines: number;
          removedLines: number;
          lineDelta: number;
        }>;
      }>;
      applyUpdates: (payload: { workspacePath: string; centralRepoPath: string; selections: Selection[] }) => Promise<{ changedFiles: string[] }>;
      syncCentralRepo: (payload: { centralRepoPath: string; commitMessage: string; push?: boolean }) => Promise<{ changedFiles: string[]; commitHash?: string; pushed: boolean; message: string }>;
      getGitDiagnostics: (centralRepoPath: string) => Promise<{
        isGitRepo: boolean;
        branch: string;
        upstream: string | null;
        changedFiles: string[];
        remotes: Array<{ name: string; fetchUrl: string; pushUrl: string }>;
        originUrl: string | null;
      }>;
      testGitRemote: (payload: { centralRepoPath: string; remote?: string }) => Promise<{ ok: boolean; remote: string; url: string | null; message: string }>;
      openExternal: (url: string) => Promise<void>;
      openPath: (targetPath: string) => Promise<string>;
      runSkillsCli: (payload: { cwd: string; action: "add" | "check" | "update" | "list" | "find"; repo?: string; skills?: string[]; query?: string; yes?: boolean }) => Promise<{ ok: boolean; command: string; stdout: string; stderr: string }>;
      isEditableFile: (relativePath: string) => Promise<boolean>;
      readText: (payload: { basePath: string; source: SkillSource; tool: ToolType; relativePath: string }) => Promise<string>;
      writeText: (payload: { basePath: string; source: SkillSource; tool: ToolType; relativePath: string; content: string }) => Promise<void>;
      createNode: (payload: { basePath: string; source: SkillSource; tool: ToolType; relativePath: string; nodeType: "file" | "folder"; content?: string }) => Promise<void>;
      renameNode: (payload: { basePath: string; source: SkillSource; tool: ToolType; fromRelativePath: string; toRelativePath: string }) => Promise<void>;
      deleteNode: (payload: { basePath: string; source: SkillSource; tool: ToolType; relativePath: string }) => Promise<void>;
      duplicateNode: (payload: { basePath: string; source: SkillSource; tool: ToolType; fromRelativePath: string; toRelativePath: string }) => Promise<void>;
      existsNode: (payload: { basePath: string; source: SkillSource; tool: ToolType; relativePath: string }) => Promise<boolean>;
      validateTarget: (payload: { basePath: string; source: SkillSource; tool: ToolType; relativePath: string }) => Promise<{ exists: boolean; parentExists: boolean; absolutePath: string }>;
    };
  }
}
