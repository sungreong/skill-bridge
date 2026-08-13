import path from "node:path";
import { promises as fs } from "node:fs";
import * as vscode from "vscode";
import { getSkillRoot, getWritableSkillRoot, resolveOpenFolderTarget, resolveSkillPath } from "./skillPaths";
import { createFileUriFromAbsolutePath, isManagedSkillPath, isWithinPath, normalizeRel } from "./extensionSupport";
import type { SkillTreeNode, ToolType } from "./types";

type TranslationFn = (message: string, ...args: Array<string | number | boolean>) => string;
type TreeSide = "workspace" | "central";
type NodeCrudAction = "rename" | "delete" | "duplicate";
type ClipboardEntry = { kind: "file" | "folder"; tool: ToolType; relativePath: string };
type ClipboardState = { side: TreeSide | null; entries: ClipboardEntry[] };
type ProviderLike = {
  getSelected: () => SkillTreeNode | null | undefined;
  getAllSelections: () => Array<{ tool: ToolType; relativePath: string }>;
};

export function createNodeActionTools(args: {
  tr: TranslationFn;
  toUserError: (error: unknown) => string;
  handleError: (error: unknown) => Promise<void>;
  refresh: () => Promise<void>;
  exists: (targetPath: string) => Promise<boolean>;
  copyNode: (src: string, dst: string) => Promise<void>;
  compactPathForDisplay: (value: string) => string;
  buildSkillMdTemplate: (name: string) => string;
  createSkillFolder: (side: TreeSide, node?: SkillTreeNode) => Promise<void>;
  pickTool: () => Promise<ToolType | undefined>;
  showGroupActions: () => Promise<void>;
  createGroupFromSelection: (side: TreeSide, nodes?: SkillTreeNode[]) => Promise<void>;
  addSelectionToExistingGroup: (side: TreeSide, node?: SkillTreeNode) => Promise<void>;
  runAgentCopyWizard: (side: TreeSide, node?: SkillTreeNode) => Promise<void>;
  transferSelections: (
    side: TreeSide,
    selections: Array<{ tool: ToolType; relativePath: string }>,
    options?: { scopeHints?: Array<{ tool: ToolType; relativePath: string; kind: "file" | "folder" }> }
  ) => Promise<{ copied: number; deleted: number; unchanged: number; affectedGroupIds: string[] }>;
  buildTransferScopeHintsFromNodes: (nodes: SkillTreeNode[]) => Array<{ tool: ToolType; relativePath: string; kind: "file" | "folder" }>;
  mirrorGroupsByIds: (side: TreeSide, groupIds: string[]) => Promise<number>;
  selectPreferredGroupIds: (side: TreeSide, affectedGroupIds: string[], preferredGroupIds?: string[]) => string[];
  resolveGroupingNodes: (side: TreeSide, node?: SkillTreeNode) => SkillTreeNode[];
  buildGroupTargetsFromNodes: (nodes: SkillTreeNode[]) => Array<{ tool: ToolType; relativePath: string; kind: "file" | "folder" }>;
  resolveWorkspaceAgentToolFromNode: (node?: SkillTreeNode) => ToolType | undefined;
  getAutoSyncWorkspaceAgents: () => ToolType[];
  toggleWorkspaceAgentAutoSync: (tool: ToolType) => Promise<boolean>;
  formatAgentFolderLabel: (tool: ToolType) => string;
  syncWorkspaceAgentToCentralNow: (tool: ToolType) => Promise<{ summary: { syncedFolders: number; copied: number; deleted: number; mirroredGroups: number; centralFolders: number; centralFiles: number; skippedMissingSkillMd: number } }>;
  uniqueSelections: (selections: Array<{ tool: ToolType; relativePath: string }>) => Array<{ tool: ToolType; relativePath: string }>;
  workspaceProvider: ProviderLike & { getSelectionsFromNodes: (nodes: SkillTreeNode[]) => Array<{ tool: ToolType; relativePath: string }> };
  centralProvider: ProviderLike & { getSelectionsFromNodes: (nodes: SkillTreeNode[]) => Array<{ tool: ToolType; relativePath: string }> };
  state: {
    workspacePath: string;
    centralRepoPath: string;
    workspaceSelection: SkillTreeNode[];
    centralSelection: SkillTreeNode[];
    selectedGroupId: string | null;
    groups: Array<{ id: string; side: TreeSide; name: string }>;
    clipboard: ClipboardState;
  };
}): {
  createSkillItem: (side: TreeSide, kind: "file" | "folder", node?: SkillTreeNode) => Promise<void>;
  openFolderInOs: (side: TreeSide, node?: SkillTreeNode) => Promise<void>;
  runNodeCrud: (side: TreeSide, action: NodeCrudAction, node?: SkillTreeNode, selectedNodes?: SkillTreeNode[]) => Promise<void>;
  copyNodesToClipboard: (side: TreeSide, node?: SkillTreeNode) => void;
  copyNodePathToClipboard: (side: TreeSide, node?: SkillTreeNode) => Promise<void>;
  pasteNodesFromClipboard: (side: TreeSide, node?: SkillTreeNode) => Promise<void>;
  openSkillMarkdown: (side: TreeSide, node?: SkillTreeNode) => Promise<void>;
  showQuickSkillCrud: (side: TreeSide, node?: SkillTreeNode) => Promise<void>;
  showSmartActions: (side: TreeSide, node?: SkillTreeNode) => Promise<void>;
  getSkillFolderRelativePathFromNode: (node: SkillTreeNode | null | undefined) => string | null;
  makeFolderNode: (tool: ToolType, relativePath: string) => SkillTreeNode;
} {
  const providerFor = (side: TreeSide): typeof args.workspaceProvider | typeof args.centralProvider =>
    side === "workspace" ? args.workspaceProvider : args.centralProvider;

  const suggestDuplicateName = (name: string): string => {
    const dot = name.lastIndexOf(".");
    return dot <= 0 ? `${name}-copy` : `${name.slice(0, dot)}-copy${name.slice(dot)}`;
  };

  const resolvePasteFolder = (node: SkillTreeNode | null | undefined): string | null => {
    if (!node) return null;
    if (!node.relativePath) return "skills";
    if (!isManagedSkillPath(node.relativePath)) return null;
    if (node.kind === "folder") return normalizeRel(node.relativePath);
    const parent = normalizeRel(path.posix.dirname(node.relativePath));
    return parent || "skills";
  };

  const collapseCopyNodes = (nodes: SkillTreeNode[]): SkillTreeNode[] => {
    const sorted = [...nodes].sort((left, right) => left.relativePath.length - right.relativePath.length);
    const kept: SkillTreeNode[] = [];
    for (const node of sorted) {
      const relative = normalizeRel(node.relativePath);
      const covered = kept.some((parent) => {
        if (parent.tool !== node.tool || parent.kind !== "folder") return false;
        const parentRelative = normalizeRel(parent.relativePath);
        return relative === parentRelative || relative.startsWith(`${parentRelative}/`);
      });
      if (!covered) kept.push(node);
    }
    return kept;
  };

  const isEditableNode = (node: SkillTreeNode | null | undefined): node is SkillTreeNode & { kind: "file" | "folder" } =>
    !!node && (node.kind === "file" || node.kind === "folder");

  const resolveDeleteNodes = (
    side: TreeSide,
    node?: SkillTreeNode,
    selectedNodes?: SkillTreeNode[]
  ): SkillTreeNode[] => {
    const explicitSelection = (selectedNodes ?? []).filter(isEditableNode);
    const stateSelection = (side === "workspace" ? args.state.workspaceSelection : args.state.centralSelection).filter(isEditableNode);
    const targetNode = node ?? providerFor(side).getSelected();
    if (explicitSelection.length > 0) {
      if (!targetNode || explicitSelection.some((item) => item.key === targetNode.key)) return explicitSelection;
      return isEditableNode(targetNode) ? [targetNode] : explicitSelection;
    }
    if (!targetNode) return stateSelection;
    return stateSelection.some((item) => item.key === targetNode.key) ? stateSelection : [targetNode];
  };

  const getUniqueCopyRelativePath = async (
    sourceRoot: string,
    desiredRelativePath: string,
    kind: "file" | "folder"
  ): Promise<string> => {
    const normalized = normalizeRel(desiredRelativePath);
    if (!(await args.exists(path.join(sourceRoot, normalized)))) return normalized;
    const parsed = path.posix.parse(normalized);
    const stem = kind === "file" && parsed.ext ? parsed.name : path.posix.basename(normalized);
    const ext = kind === "file" ? parsed.ext : "";
    const dir = parsed.dir;
    let index = 1;
    while (index < 1000) {
      const suffix = index === 1 ? "-copy" : `-copy-${index}`;
      const candidateName = `${stem}${suffix}${ext}`;
      const candidate = normalizeRel(dir ? path.posix.join(dir, candidateName) : candidateName);
      if (!(await args.exists(path.join(sourceRoot, candidate)))) return candidate;
      index += 1;
    }
    throw new Error(args.tr("Could not generate a copy target name."));
  };

  const getSkillFolderRelativePathFromNode = (node: SkillTreeNode | null | undefined): string | null => {
    if (!node?.relativePath) return null;
    const normalized = normalizeRel(node.relativePath);
    const parts = normalized.split("/").filter(Boolean);
    if (parts[0] !== "skills" || !parts[1]) return null;
    return `skills/${parts[1]}`;
  };

  const makeFolderNode = (tool: ToolType, relativePath: string): SkillTreeNode => ({
    key: `${tool}:${relativePath}`,
    kind: "folder",
    tool,
    relativePath,
    label: path.posix.basename(relativePath),
    children: []
  });

  const isPathCopyableNode = (node: SkillTreeNode | null | undefined): node is SkillTreeNode & { kind: "file" | "folder" } => {
    if (!node || (node.kind !== "file" && node.kind !== "folder")) return false;
    const relativePath = normalizeRel(node.relativePath);
    if (!relativePath || !isManagedSkillPath(relativePath)) return false;
    return relativePath.toLowerCase() !== "skills";
  };

  const resolveActionNodes = (side: TreeSide, node?: SkillTreeNode): SkillTreeNode[] => {
    const provider = providerFor(side);
    const selectedNodes = side === "workspace" ? args.state.workspaceSelection : args.state.centralSelection;
    if (node) return selectedNodes.some((item) => item.key === node.key) ? selectedNodes : [node];
    const current = provider.getSelected();
    if (!current) return selectedNodes;
    return selectedNodes.some((item) => item.key === current.key) ? selectedNodes : [current];
  };

  const createSkillItem = async (side: TreeSide, kind: "file" | "folder", node?: SkillTreeNode): Promise<void> => {
    try {
      if (!args.state.workspacePath || !args.state.centralRepoPath) await args.refresh();
      const basePath = side === "workspace" ? args.state.workspacePath : args.state.centralRepoPath;
      const baseNode = node ?? providerFor(side).getSelected();
      const tool = baseNode?.tool ?? await args.pickTool();
      if (!tool) return;
      const canUseBaseNode = !!baseNode && (baseNode.kind === "file" || baseNode.kind === "folder") && isManagedSkillPath(baseNode.relativePath);
      const baseRelRaw = canUseBaseNode
        ? (baseNode.kind === "file" ? path.posix.dirname(baseNode.relativePath) : baseNode.relativePath)
        : "skills";
      const baseRel = normalizeRel(baseRelRaw) || "skills";
      const toolRoot = getWritableSkillRoot(basePath, tool, side);
      const name = await vscode.window.showInputBox({
        title: kind === "folder" ? args.tr("New Folder Name") : args.tr("New File Name"),
        prompt: kind === "folder" ? args.tr("Enter a folder name") : args.tr("Enter a file name"),
        value: kind === "file" ? "SKILL.md" : ""
      });
      if (!name?.trim()) return;
      const nextRel = normalizeRel(path.join(baseRel, name.trim()));
      if (!isManagedSkillPath(nextRel) || nextRel.includes("..")) {
        vscode.window.showWarningMessage(args.tr("Items can only be created under the skills folder."));
        return;
      }
      const target = path.join(toolRoot, nextRel);
      if (await args.exists(target)) {
        vscode.window.showWarningMessage(args.tr("An item with the same name already exists."));
        return;
      }
      await fs.mkdir(toolRoot, { recursive: true });
      if (kind === "folder") {
        await fs.mkdir(target, { recursive: true });
      } else {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, "", "utf8");
      }
      await args.refresh();
      vscode.window.showInformationMessage(args.tr("{0} created.", String(kind === "folder" ? "Folder" : "File")));
    } catch (error) {
      await args.handleError(error);
    }
  };

  const openFolderInOs = async (side: TreeSide, node?: SkillTreeNode): Promise<void> => {
    try {
      if (!args.state.workspacePath || !args.state.centralRepoPath) await args.refresh();
      const basePath = side === "workspace" ? args.state.workspacePath : args.state.centralRepoPath;
      const targetPath = resolveOpenFolderTarget(basePath, side, node);
      let folderPath = targetPath;
      if (!(await args.exists(targetPath))) {
        const createLabel = args.tr("Create Folder");
        const targetFolderPath = node?.kind === "file" ? path.dirname(targetPath) : targetPath;
        const picked = await vscode.window.showWarningMessage(
          args.tr("Folder does not exist: {0}", String(targetFolderPath)),
          createLabel,
          args.tr("Check Setup")
        );
        if (picked === args.tr("Check Setup")) {
          await vscode.commands.executeCommand("skillBridge.diagnoseEnvironment");
          return;
        }
        if (picked !== createLabel) return;
        await fs.mkdir(targetFolderPath, { recursive: true });
        folderPath = targetFolderPath;
      }
      const stat = await fs.stat(folderPath);
      folderPath = stat.isDirectory() ? folderPath : path.dirname(folderPath);
      await vscode.env.openExternal(createFileUriFromAbsolutePath(folderPath));
      const sideLabel = side === "workspace" ? args.tr("Workspace") : args.tr("Central");
      vscode.window.setStatusBarMessage(
        args.tr("Skill Bridge: Opened {0} folder {1}", String(sideLabel), String(args.compactPathForDisplay(folderPath))),
        2500
      );
    } catch (error) {
      await args.handleError(error);
    }
  };

  const runNodeCrud = async (side: TreeSide, action: NodeCrudAction, node?: SkillTreeNode, selectedNodes?: SkillTreeNode[]): Promise<void> => {
    try {
      if (!args.state.workspacePath || !args.state.centralRepoPath) await args.refresh();
      if (action === "delete") {
        const deleteNodes = collapseCopyNodes(resolveDeleteNodes(side, node, selectedNodes));
        if (deleteNodes.length === 0) {
          vscode.window.showWarningMessage(args.tr("Select a target file or folder first."));
          return;
        }
        const basePath = side === "workspace" ? args.state.workspacePath : args.state.centralRepoPath;
        const deleteTargets: Array<{ node: SkillTreeNode; absolutePath: string; relativePath: string }> = [];
        for (const deleteNode of deleteNodes) {
          const relativePath = normalizeRel(deleteNode.relativePath);
          if (!relativePath) {
            vscode.window.showWarningMessage(args.tr("The agent root ({0}) cannot be edited. Work inside the skills folder.", String(deleteNode.tool)));
            return;
          }
          if (!isManagedSkillPath(relativePath) || relativePath.split("/").includes("..")) {
            vscode.window.showWarningMessage(args.tr("Only items under the skills folder can be edited. (Current: {0}/{1})", String(deleteNode.tool), String(deleteNode.relativePath)));
            return;
          }
          if (relativePath.toLowerCase() === "skills") {
            vscode.window.showWarningMessage(args.tr("The skills root cannot be changed."));
            return;
          }
          const sourceRoot = getSkillRoot(basePath, deleteNode.tool, side);
          const sourceAbs = path.join(sourceRoot, relativePath);
          if (!isWithinPath(sourceRoot, sourceAbs)) {
            vscode.window.showWarningMessage(args.tr("Only paths under the skills folder are allowed."));
            return;
          }
          deleteTargets.push({ node: deleteNode, absolutePath: sourceAbs, relativePath });
        }

        const deleteLabel = args.tr("Delete");
        const preview = deleteTargets.slice(0, 6).map((target) => `${target.node.tool}/${target.relativePath}`).join("\n");
        const more = deleteTargets.length > 6 ? args.tr("\n...and {0} more", String(deleteTargets.length - 6)) : "";
        const ok = await vscode.window.showWarningMessage(
          deleteTargets.length === 1
            ? args.tr("Delete {0} \"{1}\"?", String(deleteTargets[0].node.kind), String(deleteTargets[0].relativePath))
            : args.tr("Delete {0} selected items?\n\n{1}{2}", String(deleteTargets.length), String(preview), String(more)),
          { modal: true },
          deleteLabel
        );
        if (ok !== deleteLabel) return;

        let deleted = 0;
        let skipped = 0;
        for (const target of deleteTargets) {
          if (!(await args.exists(target.absolutePath))) {
            skipped += 1;
            continue;
          }
          await fs.rm(target.absolutePath, { recursive: true, force: true });
          deleted += 1;
        }
        await args.refresh();
        if (deleteTargets.length === 1 && deleted === 1 && skipped === 0) {
          vscode.window.showInformationMessage(args.tr("Deleted."));
          return;
        }
        vscode.window.showInformationMessage(args.tr("Delete completed: deleted {0}, skipped {1}.", String(deleted), String(skipped)));
        return;
      }
      const targetNode = node ?? providerFor(side).getSelected();
      if (!targetNode) {
        vscode.window.showWarningMessage(args.tr("Select a target file or folder first."));
        return;
      }
      if (!targetNode.relativePath) {
        vscode.window.showWarningMessage(args.tr("The agent root ({0}) cannot be edited. Work inside the skills folder.", String(targetNode.tool)));
        return;
      }
      if (!isManagedSkillPath(targetNode.relativePath)) {
        vscode.window.showWarningMessage(args.tr("Only items under the skills folder can be edited. (Current: {0}/{1})", String(targetNode.tool), String(targetNode.relativePath)));
        return;
      }
      if (normalizeRel(targetNode.relativePath).toLowerCase() === "skills") {
        vscode.window.showWarningMessage(args.tr("The skills root cannot be changed."));
        return;
      }
      const basePath = side === "workspace" ? args.state.workspacePath : args.state.centralRepoPath;
      const sourceRoot = getSkillRoot(basePath, targetNode.tool, side);
      const sourceAbs = path.join(sourceRoot, targetNode.relativePath);
      if (!(await args.exists(sourceAbs))) {
        vscode.window.showWarningMessage(args.tr("Could not find the target path."));
        return;
      }
      const currentName = path.posix.basename(targetNode.relativePath);
      const parentRel = normalizeRel(path.posix.dirname(targetNode.relativePath));
      const defaultName = action === "duplicate" ? suggestDuplicateName(currentName) : currentName;
      const nextName = await vscode.window.showInputBox({
        title: action === "rename" ? args.tr("Rename") : args.tr("Duplicate Name"),
        prompt: action === "rename" ? args.tr("Enter a new name") : args.tr("Enter the duplicate name"),
        value: defaultName
      });
      if (!nextName?.trim()) return;
      const nextRel = normalizeRel(parentRel === "." ? nextName.trim() : path.posix.join(parentRel, nextName.trim()));
      if (!isManagedSkillPath(nextRel) || nextRel.includes("..")) {
        vscode.window.showWarningMessage(args.tr("Only paths under the skills folder are allowed."));
        return;
      }
      if (nextRel === targetNode.relativePath) return;
      const nextAbs = path.join(sourceRoot, nextRel);
      if (await args.exists(nextAbs)) {
        vscode.window.showWarningMessage(args.tr("An item with the same name already exists."));
        return;
      }
      if (action === "rename") {
        await fs.mkdir(path.dirname(nextAbs), { recursive: true });
        await fs.rename(sourceAbs, nextAbs);
        await args.refresh();
        vscode.window.showInformationMessage(args.tr("Renamed."));
        return;
      }
      await args.copyNode(sourceAbs, nextAbs);
      await args.refresh();
      vscode.window.showInformationMessage(args.tr("Duplicated."));
    } catch (error) {
      await args.handleError(error);
    }
  };

  const copyNodesToClipboard = (side: TreeSide, node?: SkillTreeNode): void => {
    const provider = providerFor(side);
    const selectedNodes = side === "workspace" ? args.state.workspaceSelection : args.state.centralSelection;
    const sourceNodes = node ? [node] : (selectedNodes.length > 0 ? selectedNodes : [provider.getSelected()].filter(Boolean) as SkillTreeNode[]);
    if (sourceNodes.length === 0) {
      vscode.window.showWarningMessage(args.tr("Select items to copy."));
      return;
    }
    const normalized = collapseCopyNodes(sourceNodes)
      .filter((item): item is SkillTreeNode & { kind: "file" | "folder" } => item.kind === "file" || item.kind === "folder")
      .filter((item) => item.relativePath && isManagedSkillPath(item.relativePath))
      .filter((item) => normalizeRel(item.relativePath).toLowerCase() !== "skills")
      .map((item) => ({ kind: item.kind, tool: item.tool, relativePath: item.relativePath }));
    if (normalized.length === 0) {
      vscode.window.showWarningMessage(args.tr("Only items under the skills folder can be copied."));
      return;
    }
    args.state.clipboard = { side, entries: normalized };
    vscode.window.setStatusBarMessage(args.tr("Skill Bridge: Copied {0} file/folder item(s).", String(normalized.length)), 1800);
  };

  const copyNodePathToClipboard = async (side: TreeSide, node?: SkillTreeNode): Promise<void> => {
    try {
      if (!args.state.workspacePath || !args.state.centralRepoPath) await args.refresh();
      const targetNode = node ?? providerFor(side).getSelected();
      if (!isPathCopyableNode(targetNode)) {
        vscode.window.showWarningMessage(args.tr("Only skill files and folders have paths to copy."));
        return;
      }
      const basePath = side === "workspace" ? args.state.workspacePath : args.state.centralRepoPath;
      const absolutePath = resolveSkillPath(basePath, targetNode.tool, targetNode.relativePath, side);
      if (!(await args.exists(absolutePath))) {
        vscode.window.showWarningMessage(args.tr("Could not find the target path."));
        return;
      }
      await vscode.env.clipboard.writeText(absolutePath);
      vscode.window.setStatusBarMessage(
        args.tr("Skill Bridge: Copied path {0}", String(args.compactPathForDisplay(absolutePath))),
        2200
      );
    } catch (error) {
      await args.handleError(error);
    }
  };

  const pasteNodesFromClipboard = async (side: TreeSide, node?: SkillTreeNode): Promise<void> => {
    try {
      if (!args.state.workspacePath || !args.state.centralRepoPath) await args.refresh();
      if (!args.state.clipboard.side || args.state.clipboard.entries.length === 0) {
        vscode.window.showWarningMessage(args.tr("Select items to copy (Ctrl+C) first."));
        return;
      }
      if (args.state.clipboard.side !== side) {
        vscode.window.showWarningMessage(args.tr("Pasting into the other panel is not supported. Use Save to Central or Bring to Workspace."));
        return;
      }
      const selected = node ?? providerFor(side).getSelected();
      const targetFolderRel = resolvePasteFolder(selected);
      let copied = 0;
      for (const entry of args.state.clipboard.entries) {
        const sourceRoot = getSkillRoot(side === "workspace" ? args.state.workspacePath : args.state.centralRepoPath, entry.tool, side);
        const sourceAbs = path.join(sourceRoot, entry.relativePath);
        if (!(await args.exists(sourceAbs))) continue;
        const baseName = path.posix.basename(entry.relativePath);
        const destinationParent = targetFolderRel ?? normalizeRel(path.posix.dirname(entry.relativePath));
        const destinationBaseRel = normalizeRel(destinationParent ? path.posix.join(destinationParent, baseName) : baseName);
        if (!isManagedSkillPath(destinationBaseRel) || destinationBaseRel.includes("..")) continue;
        if (entry.kind === "folder") {
          const sourceRel = normalizeRel(entry.relativePath);
          if (destinationBaseRel === sourceRel || destinationBaseRel.startsWith(`${sourceRel}/`)) continue;
        }
        const destinationRel = await getUniqueCopyRelativePath(sourceRoot, destinationBaseRel, entry.kind);
        await args.copyNode(sourceAbs, path.join(sourceRoot, destinationRel));
        copied += 1;
      }
      await args.refresh();
      if (copied === 0) {
        vscode.window.showWarningMessage(args.tr("There are no items that can be pasted."));
        return;
      }
      vscode.window.showInformationMessage(args.tr("Paste complete: {0} item(s)", String(copied)));
    } catch (error) {
      await args.handleError(error);
    }
  };

  const openSkillMarkdown = async (side: TreeSide, node?: SkillTreeNode): Promise<void> => {
    if (!args.state.workspacePath || !args.state.centralRepoPath) await args.refresh();
    const basePath = side === "workspace" ? args.state.workspacePath : args.state.centralRepoPath;
    const target = node ?? providerFor(side).getSelected();
    if (!target) {
      vscode.window.showWarningMessage(args.tr("Select a skill folder first."));
      return;
    }
    const skillRel = getSkillFolderRelativePathFromNode(target);
    if (!skillRel) {
      vscode.window.showWarningMessage(args.tr("This is only available in a skill folder (skills/<name>)."));
      return;
    }
    const fileRel = `${skillRel}/SKILL.md`;
    const fileAbs = resolveSkillPath(basePath, target.tool, fileRel, side);
    if (!(await args.exists(fileAbs))) {
      const createLabel = args.tr("Create");
      const create = await vscode.window.showInformationMessage(args.tr("SKILL.md does not exist. Create it now?"), createLabel);
      if (create !== createLabel) return;
      await fs.mkdir(path.dirname(fileAbs), { recursive: true });
      await fs.writeFile(fileAbs, "", "utf8");
      await args.refresh();
    }
    const doc = await vscode.workspace.openTextDocument(createFileUriFromAbsolutePath(fileAbs));
    await vscode.window.showTextDocument(doc, { preview: true });
  };

  const showQuickSkillCrud = async (side: TreeSide, node?: SkillTreeNode): Promise<void> => {
    try {
      if (!args.state.workspacePath || !args.state.centralRepoPath) await args.refresh();
      const target = node ?? providerFor(side).getSelected();
      const skillRel = getSkillFolderRelativePathFromNode(target);
      const skillNode = target && skillRel ? makeFolderNode(target.tool, skillRel) : undefined;
      const title = side === "workspace" ? args.tr("Workspace Skill Files") : args.tr("Central Skill Files");
      const actions: Array<{ label: string; value: string; description?: string }> = [
        { label: args.tr("Create New Skill"), value: "createSkill", description: args.tr("Create skills/<name> + SKILL.md") },
        { label: args.tr("Create New File"), value: "createFile", description: args.tr("Create a file at the current location") },
        { label: args.tr("Create New Folder"), value: "createFolder", description: args.tr("Create a folder at the current location") }
      ];
      if (skillNode) {
        actions.push(
          { label: args.tr("Open SKILL.md"), value: "openSkillMd", description: args.tr("Edit the skill description file") },
          { label: args.tr("Rename Skill"), value: "renameSkill", description: args.tr("Rename the skills/<name> folder") },
          { label: args.tr("Duplicate Skill"), value: "duplicateSkill", description: args.tr("Duplicate the whole skill folder") },
          { label: args.tr("Delete Skill"), value: "deleteSkill", description: args.tr("Delete the whole skill folder") }
        );
      }
      if (target) {
        actions.push(
          { label: args.tr("Open Selected Folder"), value: "openFolder" },
          ...(isPathCopyableNode(target)
            ? [
              { label: args.tr("Copy Selected Path"), value: "copyPath", description: `${target.tool}/${target.relativePath}` },
              { label: args.tr("Rename Selected Item"), value: "renameNode" },
              { label: args.tr("Duplicate Selected Item"), value: "duplicateNode" },
              { label: args.tr("Delete Selected Item"), value: "deleteNode" }
            ]
            : [])
        );
      }
      const pick = await vscode.window.showQuickPick(actions, { title, matchOnDescription: true });
      if (!pick) return;
      if (pick.value === "createSkill") return await args.createSkillFolder(side, target ?? undefined);
      if (pick.value === "createFile") return await createSkillItem(side, "file", target ?? undefined);
      if (pick.value === "createFolder") return await createSkillItem(side, "folder", target ?? undefined);
      if (pick.value === "openSkillMd") return await openSkillMarkdown(side, skillNode);
      if (pick.value === "openFolder") return await openFolderInOs(side, target ?? undefined);
      if (pick.value === "copyPath") return await copyNodePathToClipboard(side, target ?? undefined);
      if (pick.value === "renameSkill") return await runNodeCrud(side, "rename", skillNode);
      if (pick.value === "duplicateSkill") return await runNodeCrud(side, "duplicate", skillNode);
      if (pick.value === "deleteSkill") return await runNodeCrud(side, "delete", skillNode);
      if (pick.value === "renameNode") return await runNodeCrud(side, "rename", target ?? undefined);
      if (pick.value === "duplicateNode") return await runNodeCrud(side, "duplicate", target ?? undefined);
      if (pick.value === "deleteNode") await runNodeCrud(side, "delete", target ?? undefined);
    } catch (error) {
      await args.handleError(error);
    }
  };

  const showSmartActions = async (side: TreeSide, node?: SkillTreeNode): Promise<void> => {
    try {
      if (!args.state.workspacePath || !args.state.centralRepoPath) await args.refresh();
      const provider = providerFor(side);
      const scopedNodes = resolveActionNodes(side, node);
      const baseNode = scopedNodes[0] ?? provider.getSelected();
      const scopedSelections = provider.getSelectionsFromNodes(scopedNodes);
      const fallbackSelections = !node && scopedNodes.length === 0 && scopedSelections.length === 0 ? provider.getAllSelections() : [];
      const selections = args.uniqueSelections(scopedSelections.length > 0 ? scopedSelections : fallbackSelections);
      const isAllVisibleTransferScope = !node && scopedNodes.length === 0 && scopedSelections.length === 0 && fallbackSelections.length > 0;
      const skillRel = getSkillFolderRelativePathFromNode(baseNode);
      const skillNode = baseNode && skillRel ? makeFolderNode(baseNode.tool, skillRel) : undefined;
      const selectedGroup = args.state.selectedGroupId
        ? args.state.groups.find((group) => group.id === args.state.selectedGroupId && group.side === side)
        : undefined;
      const groupedNodes = baseNode ? args.resolveGroupingNodes(side, baseNode) : scopedNodes;
      const canCreateGroupFromTarget = args.buildGroupTargetsFromNodes(groupedNodes).length > 0;
      const canTransfer = selections.length > 0;
      const scopedAgentTool = side === "workspace" ? args.resolveWorkspaceAgentToolFromNode(baseNode) : undefined;
      const isScopedAgentAutoSyncEnabled = scopedAgentTool ? args.getAutoSyncWorkspaceAgents().includes(scopedAgentTool) : false;
      const actions: Array<{ label: string; value: string; description?: string }> = [
        ...(canTransfer ? [{
          label: isAllVisibleTransferScope
            ? args.tr("Review All Visible Skills Before Applying")
            : side === "workspace" ? args.tr("Save This to Central") : args.tr("Bring This to Workspace"),
          value: "transfer",
          description: isAllVisibleTransferScope
            ? args.tr("{0} visible file target(s); confirmation required", String(selections.length))
            : args.tr("{0} file target(s) from the clicked item", String(selections.length))
        }] : []),
        ...(canCreateGroupFromTarget ? [{
          label: args.tr("Create Group from This"),
          value: "createGroup",
          description: args.tr("Create a new skill group from the clicked item or current scoped selection")
        }] : []),
        ...(canCreateGroupFromTarget ? [{
          label: args.tr("Add This to Existing Group"),
          value: "addToGroup",
          description: args.tr("Add the clicked skill to one or more existing groups")
        }] : []),
        ...(skillNode ? [{
          label: args.tr("Open SKILL.md"),
          value: "openSkillMd",
          description: `${skillNode.tool}/${skillNode.relativePath}`
        }] : []),
        {
          label: baseNode ? args.tr("Open Selected Location") : args.tr("Open {0} Folder", String(side === "workspace" ? "Workspace" : "Central")),
          value: "openFolder",
          description: baseNode ? `${baseNode.tool}/${baseNode.relativePath || "."}` : args.tr("Open the root folder in the OS file explorer")
        },
        ...(isPathCopyableNode(baseNode) ? [{
          label: args.tr("Copy Selected Path"),
          value: "copyPath",
          description: `${baseNode.tool}/${baseNode.relativePath}`
        }] : []),
        ...(isPathCopyableNode(baseNode) ? [{
          label: side === "workspace" ? args.tr("Copy This to Another Workspace Agent") : args.tr("Copy This to Another Central Agent"),
          value: "copyAgent",
          description: args.tr("Copy the clicked skill or folder to another agent on this side")
        }] : []),
        ...(side === "workspace" && scopedAgentTool ? [{
          label: isScopedAgentAutoSyncEnabled
            ? args.tr("Turn Off Auto Save to Central for {0}", String(args.formatAgentFolderLabel(scopedAgentTool)))
            : args.tr("Turn On Auto Save to Central for {0}", String(args.formatAgentFolderLabel(scopedAgentTool))),
          value: "toggleAutoSync",
          description: isScopedAgentAutoSyncEnabled
            ? args.tr("Stop saving this workspace agent's changes to Central automatically")
            : args.tr("Start saving this workspace agent's changes to Central automatically")
        }] : []),
        ...(side === "workspace" && scopedAgentTool ? [{
          label: args.tr("Save {0} to Central Now", String(args.formatAgentFolderLabel(scopedAgentTool))),
          value: "syncAgentNow",
          description: args.tr("Copy this agent's skill folders now and mirror only related groups")
        }] : []),
        {
          label: args.tr("Open Skill File Tools"),
          value: "crud",
          description: args.tr("Create, rename, duplicate, or delete")
        }
      ];
      if (selectedGroup) {
        actions.push({
          label: args.tr("Open Selected Group Actions ({0})", String(selectedGroup.name)),
          value: "groupActions",
          description: args.tr("Apply, rename, add, replace, or remove group items")
        });
      }
      actions.push(
        { label: args.tr("Choose Visible Agents"), value: "switchTab" },
        { label: args.tr("Refresh"), value: "refresh" }
      );
      const pick = await vscode.window.showQuickPick(actions, {
        title: side === "workspace" ? args.tr("Workspace Smart Actions") : args.tr("Central Smart Actions"),
        matchOnDescription: true
      });
      if (!pick) return;
      if (pick.value === "transfer") {
        if (selections.length === 0) {
          vscode.window.showWarningMessage(args.tr("Could not find files to apply."));
          return;
        }
        if (isAllVisibleTransferScope) {
          const reviewLabel = args.tr("Review All Visible");
          const confirm = await vscode.window.showWarningMessage(
            args.tr("No item is selected. Review all {0} visible file target(s) before applying?", String(selections.length)),
            { modal: true },
            reviewLabel
          );
          if (confirm !== reviewLabel) return;
        }
        const result = await args.transferSelections(side, selections, {
          scopeHints: args.buildTransferScopeHintsFromNodes(scopedNodes)
        });
        const mirroredGroups = await args.mirrorGroupsByIds(
          side,
          args.selectPreferredGroupIds(side, result.affectedGroupIds, selectedGroup ? [selectedGroup.id] : undefined)
        );
        await args.refresh();
        vscode.window.showInformationMessage(args.tr("{0} complete: copied {1}, deleted {2}, unchanged {3}{4}", String(side === "workspace" ? "Save to Central" : "Bring to Workspace"), String(result.copied), String(result.deleted), String(result.unchanged), String(mirroredGroups > 0 ? ` · applied groups ${mirroredGroups}` : "")));
        return;
      }
      if (pick.value === "createGroup") return await args.createGroupFromSelection(side, groupedNodes);
      if (pick.value === "addToGroup") return await args.addSelectionToExistingGroup(side, baseNode);
      if (pick.value === "copyAgent") return await args.runAgentCopyWizard(side, baseNode);
      if (pick.value === "copyPath") return await copyNodePathToClipboard(side, baseNode);
      if (pick.value === "toggleAutoSync" && scopedAgentTool) {
        const enabled = await args.toggleWorkspaceAgentAutoSync(scopedAgentTool);
        vscode.window.showInformationMessage(enabled
          ? args.tr("Auto save to Central turned on for {0}.", String(args.formatAgentFolderLabel(scopedAgentTool)))
          : args.tr("Auto save to Central turned off for {0}.", String(args.formatAgentFolderLabel(scopedAgentTool))));
        return;
      }
      if (pick.value === "syncAgentNow" && scopedAgentTool) {
        const { summary } = await args.syncWorkspaceAgentToCentralNow(scopedAgentTool);
        const skippedSuffix = summary.skippedMissingSkillMd > 0
          ? args.tr(" · skipped missing SKILL.md {0}", String(summary.skippedMissingSkillMd))
          : "";
        const message = args.tr("Workspace agent saved to Central: {0} · folders {1} · copied {2} · deleted {3} · groups {4} · central {5} folder(s), {6} file(s){7}", String(scopedAgentTool), String(summary.syncedFolders), String(summary.copied), String(summary.deleted), String(summary.mirroredGroups), String(summary.centralFolders), String(summary.centralFiles), String(skippedSuffix));
        if (summary.skippedMissingSkillMd > 0 && summary.copied === 0 && summary.centralFiles === 0) {
          vscode.window.showWarningMessage(message);
        } else {
          vscode.window.showInformationMessage(message);
        }
        return;
      }
      if (pick.value === "crud") return await showQuickSkillCrud(side, baseNode);
      if (pick.value === "openFolder") return await openFolderInOs(side, baseNode);
      if (pick.value === "openSkillMd") return await openSkillMarkdown(side, skillNode);
      if (pick.value === "groupActions") return await args.showGroupActions();
      if (pick.value === "switchTab") return await vscode.commands.executeCommand("skillBridge.switchTab");
      await args.refresh();
    } catch (error) {
      await args.handleError(error);
    }
  };

  return {
    createSkillItem,
    openFolderInOs,
    runNodeCrud,
    copyNodesToClipboard,
    copyNodePathToClipboard,
    pasteNodesFromClipboard,
    openSkillMarkdown,
    showQuickSkillCrud,
    showSmartActions,
    getSkillFolderRelativePathFromNode,
    makeFolderNode
  };
}
