import path from "node:path";
import { promises as fs } from "node:fs";
import * as vscode from "vscode";
import { getSkillRoot, getWritableSkillRoot, resolveOpenFolderTarget, resolveSkillPath } from "./skillPaths";
import { createFileUriFromAbsolutePath, isManagedSkillPath, isWithinPath, normalizeRel } from "./extensionSupport";
import type { SkillTreeNode, ToolType } from "./types";

type TranslationFn = (english: string, korean: string) => string;
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
    throw new Error(args.tr("Could not generate a copy target name.", "복사 대상 이름을 생성하지 못했습니다."));
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
        title: kind === "folder" ? args.tr("New Folder Name", "새 폴더 이름") : args.tr("New File Name", "새 파일 이름"),
        prompt: kind === "folder" ? args.tr("Enter a folder name", "폴더 이름을 입력하세요") : args.tr("Enter a file name", "파일 이름을 입력하세요"),
        value: kind === "file" ? "SKILL.md" : ""
      });
      if (!name?.trim()) return;
      const nextRel = normalizeRel(path.join(baseRel, name.trim()));
      if (!isManagedSkillPath(nextRel) || nextRel.includes("..")) {
        vscode.window.showWarningMessage(args.tr("Items can only be created under the skills folder.", "skills 폴더 하위만 생성할 수 있습니다."));
        return;
      }
      const target = path.join(toolRoot, nextRel);
      if (await args.exists(target)) {
        vscode.window.showWarningMessage(args.tr("An item with the same name already exists.", "이미 같은 이름이 있습니다."));
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
      vscode.window.showInformationMessage(args.tr(`${kind === "folder" ? "Folder" : "File"} created.`, `${kind === "folder" ? "폴더" : "파일"} 생성 완료`));
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
        const createLabel = args.tr("Create Folder", "폴더 만들기");
        const targetFolderPath = node?.kind === "file" ? path.dirname(targetPath) : targetPath;
        const picked = await vscode.window.showWarningMessage(
          args.tr(
            `Folder does not exist: ${targetFolderPath}`,
            `열 폴더가 없습니다: ${targetFolderPath}`
          ),
          createLabel,
          args.tr("Check Setup", "설정 점검")
        );
        if (picked === args.tr("Check Setup", "설정 점검")) {
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
      const sideLabel = side === "workspace" ? args.tr("Workspace", "작업공간") : args.tr("Central", "중앙");
      vscode.window.setStatusBarMessage(
        args.tr(`Skill Bridge: Opened ${sideLabel} folder ${args.compactPathForDisplay(folderPath)}`, `Skill Bridge: ${sideLabel} 폴더 열기 ${args.compactPathForDisplay(folderPath)}`),
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
          vscode.window.showWarningMessage(args.tr("Select a target file or folder first.", "먼저 대상 파일 또는 폴더를 선택하세요."));
          return;
        }
        const basePath = side === "workspace" ? args.state.workspacePath : args.state.centralRepoPath;
        const deleteTargets: Array<{ node: SkillTreeNode; absolutePath: string; relativePath: string }> = [];
        for (const deleteNode of deleteNodes) {
          const relativePath = normalizeRel(deleteNode.relativePath);
          if (!relativePath) {
            vscode.window.showWarningMessage(args.tr(`The agent root (${deleteNode.tool}) cannot be edited. Work inside the skills folder.`, `에이전트 루트(${deleteNode.tool})는 수정할 수 없습니다. skills 하위 항목에서 작업해주세요.`));
            return;
          }
          if (!isManagedSkillPath(relativePath) || relativePath.split("/").includes("..")) {
            vscode.window.showWarningMessage(args.tr(`Only items under the skills folder can be edited. (Current: ${deleteNode.tool}/${deleteNode.relativePath})`, `skills 폴더 하위 항목만 수정할 수 있습니다. (현재: ${deleteNode.tool}/${deleteNode.relativePath})`));
            return;
          }
          if (relativePath.toLowerCase() === "skills") {
            vscode.window.showWarningMessage(args.tr("The skills root cannot be changed.", "skills 루트는 변경할 수 없습니다."));
            return;
          }
          const sourceRoot = getSkillRoot(basePath, deleteNode.tool, side);
          const sourceAbs = path.join(sourceRoot, relativePath);
          if (!isWithinPath(sourceRoot, sourceAbs)) {
            vscode.window.showWarningMessage(args.tr("Only paths under the skills folder are allowed.", "skills 폴더 하위만 허용됩니다."));
            return;
          }
          deleteTargets.push({ node: deleteNode, absolutePath: sourceAbs, relativePath });
        }

        const deleteLabel = args.tr("Delete", "삭제");
        const preview = deleteTargets.slice(0, 6).map((target) => `${target.node.tool}/${target.relativePath}`).join("\n");
        const more = deleteTargets.length > 6 ? args.tr(`\n...and ${deleteTargets.length - 6} more`, `\n...외 ${deleteTargets.length - 6}개`) : "";
        const ok = await vscode.window.showWarningMessage(
          deleteTargets.length === 1
            ? args.tr(`Delete ${deleteTargets[0].node.kind} "${deleteTargets[0].relativePath}"?`, `${deleteTargets[0].node.kind === "folder" ? "폴더" : "파일"} "${deleteTargets[0].relativePath}"을(를) 삭제할까요?`)
            : args.tr(`Delete ${deleteTargets.length} selected items?\n\n${preview}${more}`, `선택한 항목 ${deleteTargets.length}개를 삭제할까요?\n\n${preview}${more}`),
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
          vscode.window.showInformationMessage(args.tr("Deleted.", "삭제 완료"));
          return;
        }
        vscode.window.showInformationMessage(args.tr(`Delete completed: deleted ${deleted}, skipped ${skipped}.`, `삭제 완료: 삭제 ${deleted}개, 건너뜀 ${skipped}개.`));
        return;
      }
      const targetNode = node ?? providerFor(side).getSelected();
      if (!targetNode) {
        vscode.window.showWarningMessage(args.tr("Select a target file or folder first.", "먼저 대상 파일 또는 폴더를 선택하세요."));
        return;
      }
      if (!targetNode.relativePath) {
        vscode.window.showWarningMessage(args.tr(`The agent root (${targetNode.tool}) cannot be edited. Work inside the skills folder.`, `에이전트 루트(${targetNode.tool})는 수정할 수 없습니다. skills 하위 항목에서 작업해주세요.`));
        return;
      }
      if (!isManagedSkillPath(targetNode.relativePath)) {
        vscode.window.showWarningMessage(args.tr(`Only items under the skills folder can be edited. (Current: ${targetNode.tool}/${targetNode.relativePath})`, `skills 폴더 하위 항목만 수정할 수 있습니다. (현재: ${targetNode.tool}/${targetNode.relativePath})`));
        return;
      }
      if (normalizeRel(targetNode.relativePath).toLowerCase() === "skills") {
        vscode.window.showWarningMessage(args.tr("The skills root cannot be changed.", "skills 루트는 변경할 수 없습니다."));
        return;
      }
      const basePath = side === "workspace" ? args.state.workspacePath : args.state.centralRepoPath;
      const sourceRoot = getSkillRoot(basePath, targetNode.tool, side);
      const sourceAbs = path.join(sourceRoot, targetNode.relativePath);
      if (!(await args.exists(sourceAbs))) {
        vscode.window.showWarningMessage(args.tr("Could not find the target path.", "대상 경로를 찾을 수 없습니다."));
        return;
      }
      const currentName = path.posix.basename(targetNode.relativePath);
      const parentRel = normalizeRel(path.posix.dirname(targetNode.relativePath));
      const defaultName = action === "duplicate" ? suggestDuplicateName(currentName) : currentName;
      const nextName = await vscode.window.showInputBox({
        title: action === "rename" ? args.tr("Rename", "이름 변경") : args.tr("Duplicate Name", "복제 이름"),
        prompt: action === "rename" ? args.tr("Enter a new name", "새 이름을 입력하세요") : args.tr("Enter the duplicate name", "복제 대상 이름을 입력하세요"),
        value: defaultName
      });
      if (!nextName?.trim()) return;
      const nextRel = normalizeRel(parentRel === "." ? nextName.trim() : path.posix.join(parentRel, nextName.trim()));
      if (!isManagedSkillPath(nextRel) || nextRel.includes("..")) {
        vscode.window.showWarningMessage(args.tr("Only paths under the skills folder are allowed.", "skills 폴더 하위만 허용됩니다."));
        return;
      }
      if (nextRel === targetNode.relativePath) return;
      const nextAbs = path.join(sourceRoot, nextRel);
      if (await args.exists(nextAbs)) {
        vscode.window.showWarningMessage(args.tr("An item with the same name already exists.", "이미 같은 이름이 있습니다."));
        return;
      }
      if (action === "rename") {
        await fs.mkdir(path.dirname(nextAbs), { recursive: true });
        await fs.rename(sourceAbs, nextAbs);
        await args.refresh();
        vscode.window.showInformationMessage(args.tr("Renamed.", "이름 변경 완료"));
        return;
      }
      await args.copyNode(sourceAbs, nextAbs);
      await args.refresh();
      vscode.window.showInformationMessage(args.tr("Duplicated.", "복제 완료"));
    } catch (error) {
      await args.handleError(error);
    }
  };

  const copyNodesToClipboard = (side: TreeSide, node?: SkillTreeNode): void => {
    const provider = providerFor(side);
    const selectedNodes = side === "workspace" ? args.state.workspaceSelection : args.state.centralSelection;
    const sourceNodes = node ? [node] : (selectedNodes.length > 0 ? selectedNodes : [provider.getSelected()].filter(Boolean) as SkillTreeNode[]);
    if (sourceNodes.length === 0) {
      vscode.window.showWarningMessage(args.tr("Select items to copy.", "복사할 항목을 선택하세요."));
      return;
    }
    const normalized = collapseCopyNodes(sourceNodes)
      .filter((item): item is SkillTreeNode & { kind: "file" | "folder" } => item.kind === "file" || item.kind === "folder")
      .filter((item) => item.relativePath && isManagedSkillPath(item.relativePath))
      .filter((item) => normalizeRel(item.relativePath).toLowerCase() !== "skills")
      .map((item) => ({ kind: item.kind, tool: item.tool, relativePath: item.relativePath }));
    if (normalized.length === 0) {
      vscode.window.showWarningMessage(args.tr("Only items under the skills folder can be copied.", "skills 폴더 하위 항목만 복사할 수 있습니다."));
      return;
    }
    args.state.clipboard = { side, entries: normalized };
    vscode.window.setStatusBarMessage(args.tr(`Skill Bridge: Copied ${normalized.length} file/folder item(s).`, `Skill Bridge: 파일/폴더 항목 ${normalized.length}개를 복사했습니다.`), 1800);
  };

  const copyNodePathToClipboard = async (side: TreeSide, node?: SkillTreeNode): Promise<void> => {
    try {
      if (!args.state.workspacePath || !args.state.centralRepoPath) await args.refresh();
      const targetNode = node ?? providerFor(side).getSelected();
      if (!isPathCopyableNode(targetNode)) {
        vscode.window.showWarningMessage(args.tr("Only skill files and folders have paths to copy.", "스킬 파일/폴더만 복사할 경로가 있습니다."));
        return;
      }
      const basePath = side === "workspace" ? args.state.workspacePath : args.state.centralRepoPath;
      const absolutePath = resolveSkillPath(basePath, targetNode.tool, targetNode.relativePath, side);
      if (!(await args.exists(absolutePath))) {
        vscode.window.showWarningMessage(args.tr("Could not find the target path.", "대상 경로를 찾을 수 없습니다."));
        return;
      }
      await vscode.env.clipboard.writeText(absolutePath);
      vscode.window.setStatusBarMessage(
        args.tr(`Skill Bridge: Copied path ${args.compactPathForDisplay(absolutePath)}`, `Skill Bridge: 경로 복사 ${args.compactPathForDisplay(absolutePath)}`),
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
        vscode.window.showWarningMessage(args.tr("Select items to copy (Ctrl+C) first.", "먼저 복사(Ctrl+C)할 항목을 선택하세요."));
        return;
      }
      if (args.state.clipboard.side !== side) {
        vscode.window.showWarningMessage(args.tr("Pasting into the other panel is not supported. Use Send to Central or Bring to Workspace.", "다른 패널로 붙여넣기는 지원하지 않습니다. 중앙으로 보내기/작업공간으로 가져오기를 사용하세요."));
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
        vscode.window.showWarningMessage(args.tr("There are no items that can be pasted.", "붙여넣을 수 있는 항목이 없습니다."));
        return;
      }
      vscode.window.showInformationMessage(args.tr(`Paste complete: ${copied} item(s)`, `붙여넣기 완료: 항목 ${copied}개`));
    } catch (error) {
      await args.handleError(error);
    }
  };

  const openSkillMarkdown = async (side: TreeSide, node?: SkillTreeNode): Promise<void> => {
    if (!args.state.workspacePath || !args.state.centralRepoPath) await args.refresh();
    const basePath = side === "workspace" ? args.state.workspacePath : args.state.centralRepoPath;
    const target = node ?? providerFor(side).getSelected();
    if (!target) {
      vscode.window.showWarningMessage(args.tr("Select a skill folder first.", "먼저 스킬 폴더를 선택하세요."));
      return;
    }
    const skillRel = getSkillFolderRelativePathFromNode(target);
    if (!skillRel) {
      vscode.window.showWarningMessage(args.tr("This is only available in a skill folder (skills/<name>).", "스킬 폴더(skills/<name>)에서만 사용할 수 있습니다."));
      return;
    }
    const fileRel = `${skillRel}/SKILL.md`;
    const fileAbs = resolveSkillPath(basePath, target.tool, fileRel, side);
    if (!(await args.exists(fileAbs))) {
      const createLabel = args.tr("Create", "만들기");
      const create = await vscode.window.showInformationMessage(args.tr("SKILL.md does not exist. Create it now?", "SKILL.md가 없습니다. 새로 만들까요?"), createLabel);
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
      const title = side === "workspace" ? args.tr("Workspace Skill Files", "작업공간 스킬 파일 만들기/수정") : args.tr("Central Skill Files", "중앙 스킬 파일 만들기/수정");
      const actions: Array<{ label: string; value: string; description?: string }> = [
        { label: args.tr("Create New Skill", "새 스킬 생성"), value: "createSkill", description: args.tr("Create skills/<name> + SKILL.md", "skills/<name> + SKILL.md 생성") },
        { label: args.tr("Create New File", "새 파일 생성"), value: "createFile", description: args.tr("Create a file at the current location", "현재 위치에 파일 생성") },
        { label: args.tr("Create New Folder", "새 폴더 생성"), value: "createFolder", description: args.tr("Create a folder at the current location", "현재 위치에 폴더 생성") }
      ];
      if (skillNode) {
        actions.push(
          { label: args.tr("Open SKILL.md", "SKILL.md 열기"), value: "openSkillMd", description: args.tr("Edit the skill description file", "스킬 설명 파일 편집") },
          { label: args.tr("Rename Skill", "스킬 이름 변경"), value: "renameSkill", description: args.tr("Rename the skills/<name> folder", "skills/<name> 폴더 이름 변경") },
          { label: args.tr("Duplicate Skill", "스킬 복제"), value: "duplicateSkill", description: args.tr("Duplicate the whole skill folder", "스킬 폴더 전체 복제") },
          { label: args.tr("Delete Skill", "스킬 삭제"), value: "deleteSkill", description: args.tr("Delete the whole skill folder", "스킬 폴더 전체 삭제") }
        );
      }
      if (target) {
        actions.push(
          { label: args.tr("Open Selected Folder", "선택 항목 폴더 열기"), value: "openFolder" },
          ...(isPathCopyableNode(target)
            ? [
              { label: args.tr("Copy Selected Path", "선택 항목 경로 복사"), value: "copyPath", description: `${target.tool}/${target.relativePath}` },
              { label: args.tr("Rename Selected Item", "선택 항목 이름 변경"), value: "renameNode" },
              { label: args.tr("Duplicate Selected Item", "선택 항목 복제"), value: "duplicateNode" },
              { label: args.tr("Delete Selected Item", "선택 항목 삭제"), value: "deleteNode" }
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
      const selectedNodes = side === "workspace" ? args.state.workspaceSelection : args.state.centralSelection;
      const baseNode = node ?? provider.getSelected() ?? selectedNodes[0];
      const scopedNodes = node ? [node] : selectedNodes;
      const scopedSelections = provider.getSelectionsFromNodes(scopedNodes);
      const fallbackSelections = !node && scopedSelections.length === 0 ? provider.getAllSelections() : [];
      const selections = args.uniqueSelections(scopedSelections.length > 0 ? scopedSelections : fallbackSelections);
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
          label: side === "workspace" ? args.tr("Send This to Central", "이 항목 중앙으로 보내기") : args.tr("Bring This to Workspace", "이 항목 작업공간으로 가져오기"),
          value: "transfer",
          description: args.tr(`${selections.length} file target(s) from the clicked item`, `클릭한 항목 기준 파일 대상 ${selections.length}개`)
        }] : []),
        ...(canCreateGroupFromTarget ? [{
          label: args.tr("Create Group from This", "이 항목으로 그룹 만들기"),
          value: "createGroup",
          description: args.tr("Create a new skill group from the clicked item or current scoped selection", "클릭한 항목 또는 현재 범위 선택으로 새 스킬 그룹 생성")
        }] : []),
        ...(canCreateGroupFromTarget ? [{
          label: args.tr("Add This to Existing Group", "이 항목을 기존 그룹에 추가"),
          value: "addToGroup",
          description: args.tr("Add the clicked skill to one or more existing groups", "클릭한 스킬을 하나 이상의 기존 그룹에 추가")
        }] : []),
        ...(skillNode ? [{
          label: args.tr("Open SKILL.md", "SKILL.md 열기"),
          value: "openSkillMd",
          description: `${skillNode.tool}/${skillNode.relativePath}`
        }] : []),
        {
          label: baseNode ? args.tr("Open Selected Location", "선택 위치 폴더 열기") : args.tr(`Open ${side === "workspace" ? "Workspace" : "Central"} Folder`, `${side === "workspace" ? "작업공간" : "중앙"} 폴더 열기`),
          value: "openFolder",
          description: baseNode ? `${baseNode.tool}/${baseNode.relativePath || "."}` : args.tr("Open the root folder in the OS file explorer", "루트 폴더를 OS 탐색기로 열기")
        },
        ...(isPathCopyableNode(baseNode) ? [{
          label: args.tr("Copy Selected Path", "선택 항목 경로 복사"),
          value: "copyPath",
          description: `${baseNode.tool}/${baseNode.relativePath}`
        }] : []),
        ...(isPathCopyableNode(baseNode) ? [{
          label: side === "workspace" ? args.tr("Copy This to Another Workspace Agent", "이 항목을 다른 작업공간 에이전트로 복사") : args.tr("Copy This to Another Central Agent", "이 항목을 다른 중앙 에이전트로 복사"),
          value: "copyAgent",
          description: args.tr("Copy the clicked skill or folder between configured agents on this side", "이 side의 설정된 다른 에이전트로 클릭한 스킬/폴더 복사")
        }] : []),
        ...(side === "workspace" && scopedAgentTool ? [{
          label: isScopedAgentAutoSyncEnabled
            ? args.tr(`Turn Off Auto Sync for ${args.formatAgentFolderLabel(scopedAgentTool)}`, `${args.formatAgentFolderLabel(scopedAgentTool)} 자동 sync 끄기`)
            : args.tr(`Turn On Auto Sync for ${args.formatAgentFolderLabel(scopedAgentTool)}`, `${args.formatAgentFolderLabel(scopedAgentTool)} 자동 sync 켜기`),
          value: "toggleAutoSync",
          description: isScopedAgentAutoSyncEnabled
            ? args.tr("Stop watching this workspace agent for automatic Central updates", "이 작업공간 에이전트의 자동 중앙 반영 감시를 끕니다")
            : args.tr("Start watching this workspace agent for automatic Central updates", "이 작업공간 에이전트의 자동 중앙 반영 감시를 켭니다")
        }] : []),
        ...(side === "workspace" && scopedAgentTool ? [{
          label: args.tr(`Sync ${args.formatAgentFolderLabel(scopedAgentTool)} to Central Now`, `${args.formatAgentFolderLabel(scopedAgentTool)}를 지금 중앙으로 sync`),
          value: "syncAgentNow",
          description: args.tr("Copy changed skill folders now and mirror only related groups", "변경된 스킬 폴더를 지금 복사하고 관련 그룹만 미러링합니다")
        }] : []),
        {
          label: args.tr("Open Skill File Tools", "스킬 파일 만들기/수정 열기"),
          value: "crud",
          description: args.tr("Create, rename, duplicate, or delete", "생성/이름변경/복제/삭제")
        }
      ];
      if (selectedGroup) {
        actions.push({
          label: args.tr(`Open Selected Group Actions (${selectedGroup.name})`, `선택 그룹 작업 열기 (${selectedGroup.name})`),
          value: "groupActions",
          description: args.tr("Run, rename, add, replace, or remove items", "실행/이름변경/항목 추가·교체·제거")
        });
      }
      actions.push(
        { label: args.tr("Switch Source Tab", "소스 탭 전환"), value: "switchTab" },
        { label: args.tr("Refresh", "새로고침"), value: "refresh" }
      );
      const pick = await vscode.window.showQuickPick(actions, {
        title: side === "workspace" ? args.tr("Workspace Smart Actions", "작업공간 스마트 액션") : args.tr("Central Smart Actions", "중앙 스마트 액션"),
        matchOnDescription: true
      });
      if (!pick) return;
      if (pick.value === "transfer") {
        if (selections.length === 0) {
          vscode.window.showWarningMessage(args.tr("Could not find files to transfer.", "전송할 파일을 찾지 못했습니다."));
          return;
        }
        const result = await args.transferSelections(side, selections, {
          scopeHints: args.buildTransferScopeHintsFromNodes(scopedNodes)
        });
        const mirroredGroups = await args.mirrorGroupsByIds(
          side,
          args.selectPreferredGroupIds(side, result.affectedGroupIds, selectedGroup ? [selectedGroup.id] : undefined)
        );
        await args.refresh();
        vscode.window.showInformationMessage(args.tr(
          `${side === "workspace" ? "Send to Central" : "Bring to Workspace"} complete: copied ${result.copied}, deleted ${result.deleted}, unchanged ${result.unchanged}${mirroredGroups > 0 ? ` · synced groups ${mirroredGroups}` : ""}`,
          `${side === "workspace" ? "중앙으로 보내기" : "작업공간으로 가져오기"} 완료: 복사 행 ${result.copied}개 / 삭제 행 ${result.deleted}개 / 변경없음 행 ${result.unchanged}개${mirroredGroups > 0 ? ` · 그룹 동기화 ${mirroredGroups}개` : ""}`
        ));
        return;
      }
      if (pick.value === "createGroup") return await args.createGroupFromSelection(side, groupedNodes);
      if (pick.value === "addToGroup") return await args.addSelectionToExistingGroup(side, baseNode);
      if (pick.value === "copyAgent") return await args.runAgentCopyWizard(side, baseNode);
      if (pick.value === "copyPath") return await copyNodePathToClipboard(side, baseNode);
      if (pick.value === "toggleAutoSync" && scopedAgentTool) {
        const enabled = await args.toggleWorkspaceAgentAutoSync(scopedAgentTool);
        vscode.window.showInformationMessage(enabled
          ? args.tr(`Workspace auto sync turned on for ${args.formatAgentFolderLabel(scopedAgentTool)}.`, `${args.formatAgentFolderLabel(scopedAgentTool)} 자동 sync를 켰습니다.`)
          : args.tr(`Workspace auto sync turned off for ${args.formatAgentFolderLabel(scopedAgentTool)}.`, `${args.formatAgentFolderLabel(scopedAgentTool)} 자동 sync를 껐습니다.`));
        return;
      }
      if (pick.value === "syncAgentNow" && scopedAgentTool) {
        const { summary } = await args.syncWorkspaceAgentToCentralNow(scopedAgentTool);
        const skippedSuffix = summary.skippedMissingSkillMd > 0
          ? args.tr(` · skipped missing SKILL.md ${summary.skippedMissingSkillMd}`, ` · SKILL.md 없음 제외 ${summary.skippedMissingSkillMd}개`)
          : "";
        const message = args.tr(
          `Workspace agent sync complete: ${scopedAgentTool} · folders ${summary.syncedFolders} · copied ${summary.copied} · deleted ${summary.deleted} · groups ${summary.mirroredGroups} · central ${summary.centralFolders} folder(s), ${summary.centralFiles} file(s)${skippedSuffix}`,
          `작업공간 에이전트 sync 완료: ${scopedAgentTool} · 폴더 ${summary.syncedFolders}개 · 복사 ${summary.copied}개 · 삭제 ${summary.deleted}개 · 그룹 ${summary.mirroredGroups}개 · 중앙 확인 폴더 ${summary.centralFolders}개, 파일 ${summary.centralFiles}개${skippedSuffix}`
        );
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
