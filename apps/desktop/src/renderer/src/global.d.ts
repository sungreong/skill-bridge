export {};

type ToolType = "claude" | "codex" | "gemini" | "cursor" | "antigravity";
type SkillSource = "workspace" | "central";
type Selection = { tool: ToolType; relativePath: string };

declare global {
  interface Window {
    electronAPI: {
      chooseDirectory: () => Promise<string | null>;
      loadConfig: () => Promise<{ centralRepo: string; autoPush: boolean; defaultTool: ToolType; fontSize: number; workspaces: Array<{ id: string; name: string; path: string }>; activeWorkspaceId: string | null }>;
      saveConfig: (payload: Partial<{ centralRepo: string; autoPush: boolean; defaultTool: ToolType; fontSize: number; workspaces: Array<{ id: string; name: string; path: string }>; activeWorkspaceId: string | null }>) => Promise<{ centralRepo: string; autoPush: boolean; defaultTool: ToolType; fontSize: number; workspaces: Array<{ id: string; name: string; path: string }>; activeWorkspaceId: string | null }>;
      inspectWorkspace: (workspacePath: string) => Promise<{ workspacePath: string; statuses: Array<{ tool: ToolType; workspaceDir: string; exists: boolean }>; workspaceSkills: Array<{ tool: ToolType; relativePath: string; absolutePath: string }> }>;
      loadWorkspaceGroups: (workspacePath: string) => Promise<{ version: number; groups: Array<{ id: string; name: string; side: "workspace" | "central"; targets: Array<{ kind: "file" | "folder"; tool: ToolType; relativePath: string }> }> }>;
      saveWorkspaceGroups: (payload: { workspacePath: string; data: { version: number; groups: Array<{ id: string; name: string; side: "workspace" | "central"; targets: Array<{ kind: "file" | "folder"; tool: ToolType; relativePath: string }> }> } }) => Promise<void>;
      listCentralSkills: (centralRepoPath: string) => Promise<Array<{ tool: ToolType; relativePath: string; absolutePath: string }>>;
      checkCentralRepo: (centralRepoPath: string) => Promise<{ exists: boolean; isGitRepo: boolean }>;
      initializeCentralRepo: (centralRepoPath: string) => Promise<void>;
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
