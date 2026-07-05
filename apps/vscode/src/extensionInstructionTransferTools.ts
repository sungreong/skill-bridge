import { promises as fs } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import { createFileUriFromAbsolutePath } from "./extensionSupport";
import type { GroupTarget, SelectionGroup, SkillFile, SkillTreeNode, ToolType } from "./types";
import type { TransferScopeHint } from "./extensionTransferManager";

type TreeSide = "workspace" | "central";
type InstructionTransferTarget = { relativePath: string; profileId?: string; sourcePath?: string };

export function createExtensionInstructionTransferTools(args: {
  tr: (english: string, korean: string) => string;
  toUserError: (error: unknown) => string;
  handleError: (error: unknown) => Promise<void>;
  output: vscode.OutputChannel;
  state: {
    workspacePath: string;
    centralRepoPath: string;
    selectedGroupId: string | null;
    groups: SelectionGroup[];
    workspaceSkills: SkillFile[];
    centralSkills: SkillFile[];
    workspaceInstructions: Array<{ relativePath: string; profileId?: string; absolutePath: string }>;
  };
  refresh: () => Promise<unknown>;
  unwrapSkillNode: (node?: SkillTreeNode) => SkillTreeNode | undefined;
  resolveCommandNodes: (side: TreeSide, node?: SkillTreeNode) => SkillTreeNode[];
  buildTransferScopeHintsFromNodes: (nodes: SkillTreeNode[]) => TransferScopeHint[];
  uniqueSelections: (selections: Array<{ tool: ToolType; relativePath: string }>) => Array<{ tool: ToolType; relativePath: string }>;
  targetsToSelections: (files: SkillFile[], targets: GroupTarget[]) => Array<{ tool: ToolType; relativePath: string }>;
  buildTransferScopeContext: (args: {
    side: TreeSide;
    nodes: SkillTreeNode[];
    hints?: TransferScopeHint[];
    selectedGroup?: SelectionGroup;
    isWholeTreeScope: boolean;
  }) => { type: "all" | "group" | "selection"; label: string; count: number; expandable: boolean } | undefined;
  transferSelections: (
    side: TreeSide,
    selections: Array<{ tool: ToolType; relativePath: string }>,
    options?: {
      groupContext?: { id: string; name: string; side: TreeSide };
      scopeContext?: { type: "all" | "group" | "selection"; label: string; count: number; expandable: boolean };
      scopeHints?: TransferScopeHint[];
    }
  ) => Promise<{ copied: number; deleted: number; unchanged: number; failed: number; appliedScopeHints: TransferScopeHint[]; affectedGroupIds: string[] }>;
  mirrorGroupsForTransferResult: (sourceSide: TreeSide, result: { affectedGroupIds: string[] }, preferredGroupIds?: string[]) => Promise<number>;
  workspaceProvider: {
    getSelectionsFromNodes: (nodes: SkillTreeNode[]) => Array<{ tool: ToolType; relativePath: string }>;
    getAllSelections: () => Array<{ tool: ToolType; relativePath: string }>;
  };
  centralProvider: {
    getSelectionsFromNodes: (nodes: SkillTreeNode[]) => Array<{ tool: ToolType; relativePath: string }>;
    getAllSelections: () => Array<{ tool: ToolType; relativePath: string }>;
  };
  pickEmptyTransferScope: (side: TreeSide) => Promise<"all" | "cancel">;
  suggestInstructionProfile: (workspacePath: string) => string;
  normalizeInstructionRelativePath: (relativePath: string) => string;
  sanitizeInstructionProfileName: (profileId: string) => string;
  isManagedInstructionPath: (relativePath: string) => boolean;
  resolveWorkspaceInstructionPath: (workspacePath: string, relativePath: string) => string;
  resolveCentralInstructionPath: (centralRepoPath: string, profileId: string, relativePath: string) => string;
  exists: (path: string) => Promise<boolean>;
}): {
  promoteSelected: (node?: SkillTreeNode) => Promise<void>;
  importSelected: (node?: SkillTreeNode) => Promise<void>;
  getInstructionTransferTargets: (side: TreeSide, nodes: SkillTreeNode[]) => InstructionTransferTarget[];
  transferInstructions: (sourceSide: TreeSide, targets: InstructionTransferTarget[]) => Promise<{ copied: number; unchanged: number; skipped: number; failed: number }>;
  summarizeInstructionProfiles: (targets: InstructionTransferTarget[]) => string;
  openInstructionDiff: (sourceSide: TreeSide, relativePath: string, sourcePath: string, targetPath: string) => Promise<void>;
  isSameFileContent: (src: string, dst: string, srcSize: number, dstSize: number) => Promise<boolean>;
} {
  const getInstructionTransferTargets = (side: TreeSide, nodes: SkillTreeNode[]): InstructionTransferTarget[] => {
    const sourceInstructions = side === "workspace" ? args.state.workspaceInstructions : [];
    const targets = new Map<string, InstructionTransferTarget>();
    const addInstructionTarget = (target: InstructionTransferTarget): void => {
      const normalized = args.normalizeInstructionRelativePath(target.relativePath);
      if (!args.isManagedInstructionPath(normalized)) return;
      const profileId = target.profileId ? args.sanitizeInstructionProfileName(target.profileId) : undefined;
      const key = `${profileId ?? ""}:${normalized}:${target.sourcePath ?? ""}`;
      targets.set(key, { ...target, relativePath: normalized, profileId });
    };
    const addInstructionNodePaths = (node: SkillTreeNode): void => {
      if (node.kind === "instructionFile" && args.isManagedInstructionPath(node.relativePath)) {
        addInstructionTarget({
          relativePath: node.relativePath,
          profileId: node.instructionProfile,
          sourcePath: node.absolutePath
        });
        return;
      }
      for (const child of node.children) addInstructionNodePaths(child);
    };
    for (const node of nodes) {
      if (node.kind === "instructionRoot") {
        for (const item of sourceInstructions) {
          addInstructionTarget({
            relativePath: item.relativePath,
            profileId: item.profileId,
            sourcePath: item.absolutePath
          });
        }
        continue;
      }
      if (node.kind === "instructionFolder" || node.kind === "instructionFile") {
        addInstructionNodePaths(node);
      }
    }
    return [...targets.values()].sort((a, b) =>
      (a.profileId ?? "").localeCompare(b.profileId ?? "") || a.relativePath.localeCompare(b.relativePath)
    );
  };

  const openInstructionDiff = async (
    sourceSide: TreeSide,
    relativePath: string,
    sourcePath: string,
    targetPath: string
  ): Promise<void> => {
    const title = sourceSide === "workspace"
      ? `Instruction Diff: Central <- Workspace · ${relativePath}`
      : `Instruction Diff: Workspace <- Central · ${relativePath}`;
    await vscode.commands.executeCommand("vscode.diff", createFileUriFromAbsolutePath(targetPath), createFileUriFromAbsolutePath(sourcePath), title, {
      preview: true,
      preserveFocus: false
    });
  };

  const transferInstructions = async (
    sourceSide: TreeSide,
    targets: InstructionTransferTarget[]
  ): Promise<{ copied: number; unchanged: number; skipped: number; failed: number }> => {
    const workspaceProfileId = args.suggestInstructionProfile(args.state.workspacePath);
    let copied = 0;
    let unchanged = 0;
    let skipped = 0;
    let failed = 0;

    for (const target of targets) {
      const relativePath = args.normalizeInstructionRelativePath(target.relativePath);
      const sourceProfileId = target.profileId ?? workspaceProfileId;
      try {
        const sourcePath = sourceSide === "workspace"
          ? args.resolveWorkspaceInstructionPath(args.state.workspacePath, relativePath)
          : target.sourcePath ?? args.resolveCentralInstructionPath(args.state.centralRepoPath, sourceProfileId, relativePath);
        const targetPath = sourceSide === "workspace"
          ? args.resolveCentralInstructionPath(args.state.centralRepoPath, workspaceProfileId, relativePath)
          : args.resolveWorkspaceInstructionPath(args.state.workspacePath, relativePath);

        if (!(await args.exists(sourcePath))) {
          failed += 1;
          args.output.appendLine(`[InstructionTransfer] source missing: ${sourcePath}`);
          continue;
        }

        if (await args.exists(targetPath)) {
          const [sourceBuffer, targetBuffer] = await Promise.all([fs.readFile(sourcePath), fs.readFile(targetPath)]);
          if (sourceBuffer.equals(targetBuffer)) {
            unchanged += 1;
            continue;
          }

          await openInstructionDiff(sourceSide, relativePath, sourcePath, targetPath);
          const applyLabel = "Apply";
          const skipLabel = "Skip";
          const ok = await vscode.window.showWarningMessage(
            `Overwrite instruction "${relativePath}" on the ${sourceSide === "workspace" ? "Central" : "Workspace"} side?`,
            { modal: true },
            applyLabel,
            skipLabel
          );
          if (ok !== applyLabel) {
            skipped += 1;
            continue;
          }
        }

        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.copyFile(sourcePath, targetPath);
        copied += 1;
      } catch (error) {
        failed += 1;
        args.output.appendLine(`[InstructionTransfer] failed ${relativePath}: ${args.toUserError(error)}`);
      }
    }

    return { copied, unchanged, skipped, failed };
  };

  const summarizeInstructionProfiles = (targets: InstructionTransferTarget[]): string => {
    const profiles = [...new Set(targets.map((target) => target.profileId).filter((profile): profile is string => !!profile))]
      .sort((a, b) => a.localeCompare(b));
    if (profiles.length === 0) return "instructions";
    if (profiles.length === 1) return `instructions/${profiles[0]}`;
    const preview = profiles.slice(0, 3).join(", ");
    return profiles.length > 3
      ? `instructions/${preview} and ${profiles.length - 3} more profiles`
      : `instructions/${preview}`;
  };

  const promoteSelected = async (node?: SkillTreeNode): Promise<void> => {
    try {
      if (!args.state.workspacePath || !args.state.centralRepoPath) await args.refresh();

      const commandNode = args.unwrapSkillNode(node);
      const commandNodes = args.resolveCommandNodes("workspace", commandNode);
      const instructionPaths = getInstructionTransferTargets("workspace", commandNodes);
      const selected = args.workspaceProvider.getSelectionsFromNodes(commandNodes);
      if (instructionPaths.length > 0 && selected.length === 0) {
        const result = await transferInstructions("workspace", instructionPaths);
        await args.refresh();
        const profileId = args.suggestInstructionProfile(args.state.workspacePath);
        vscode.window.showInformationMessage(args.tr(
          `Instructions sent to Central: instructions/${profileId} · copied ${result.copied} · unchanged ${result.unchanged} · skipped ${result.skipped} · failed ${result.failed}`,
          `instruction Central 반영: instructions/${profileId} · 복사 파일 ${result.copied}개 / 변경없음 파일 ${result.unchanged}개 / 건너뜀 파일 ${result.skipped}개 / 실패 파일 ${result.failed}개`
        ));
        return;
      }

      const commandScopeHints = args.buildTransferScopeHintsFromNodes(commandNodes);
      let selections = args.uniqueSelections(selected);
      let isWholeTreeScope = false;
      const selectedGroup = commandScopeHints.length === 0 && args.state.selectedGroupId
        ? args.state.groups.find((group) => group.id === args.state.selectedGroupId && group.side === "workspace")
        : undefined;
      if (selections.length === 0 && commandNodes.length === 0 && selectedGroup) {
        selections = args.uniqueSelections(args.targetsToSelections(args.state.workspaceSkills, selectedGroup.targets));
      }
      if (selections.length === 0 && commandNodes.length === 0 && !selectedGroup) {
        const pick = await args.pickEmptyTransferScope("workspace");
        if (pick !== "all") return;
        selections = args.uniqueSelections(args.workspaceProvider.getAllSelections());
        isWholeTreeScope = true;
      }
      if (selections.length === 0) {
        vscode.window.showWarningMessage(args.tr("No recognized skills files were found in Workspace.", "작업공간에서 인식된 스킬 파일이 없습니다."));
        return;
      }

      const scopeHints = selectedGroup
        ? selectedGroup.targets.map((target) => ({ ...target }))
        : commandScopeHints.length > 0
          ? commandScopeHints
          : undefined;
      const result = await args.transferSelections("workspace", selections, {
        groupContext: selectedGroup ? { id: selectedGroup.id, name: selectedGroup.name, side: selectedGroup.side } : undefined,
        scopeContext: args.buildTransferScopeContext({
          side: "workspace",
          nodes: commandNodes,
          hints: scopeHints,
          selectedGroup,
          isWholeTreeScope
        }),
        scopeHints
      });
      const mirroredGroups = await args.mirrorGroupsForTransferResult("workspace", result, selectedGroup ? [selectedGroup.id] : undefined);
      await args.refresh();
      if (result.copied + result.deleted === 0) {
        vscode.window.showInformationMessage(args.tr(`No Central file changes to copy${mirroredGroups > 0 ? " · group synced" : ""}`, `중앙 저장소 파일 변경 없음${mirroredGroups > 0 ? " · 그룹 동기화됨" : ""}`));
        return;
      }
      vscode.window.showInformationMessage(args.tr(
        `Central updated: copied ${result.copied} · deleted ${result.deleted} · unchanged ${result.unchanged}${mirroredGroups > 0 ? " · group synced" : ""}`,
        `중앙 저장소 반영: 복사 행 ${result.copied}개 / 삭제 행 ${result.deleted}개 / 변경없음 행 ${result.unchanged}개${mirroredGroups > 0 ? " · 그룹 동기화됨" : ""}`
      ));
    } catch (error) {
      await args.handleError(error);
    }
  };

  const importSelected = async (node?: SkillTreeNode): Promise<void> => {
    try {
      if (!args.state.workspacePath || !args.state.centralRepoPath) await args.refresh();

      const commandNode = args.unwrapSkillNode(node);
      const commandNodes = args.resolveCommandNodes("central", commandNode);
      const instructionPaths = getInstructionTransferTargets("central", commandNodes);
      const selected = args.centralProvider.getSelectionsFromNodes(commandNodes);
      if (instructionPaths.length > 0 && selected.length === 0) {
        const result = await transferInstructions("central", instructionPaths);
        await args.refresh();
        const profileLabel = summarizeInstructionProfiles(instructionPaths);
        vscode.window.showInformationMessage(args.tr(
          `Instructions sent to Workspace: Central ${profileLabel} to workspace · copied ${result.copied} · unchanged ${result.unchanged} · skipped ${result.skipped} · failed ${result.failed}`,
          `instruction Workspace 반영: Central ${profileLabel} → workspace · 복사 파일 ${result.copied}개 / 변경없음 파일 ${result.unchanged}개 / 건너뜀 파일 ${result.skipped}개 / 실패 파일 ${result.failed}개`
        ));
        return;
      }

      const commandScopeHints = args.buildTransferScopeHintsFromNodes(commandNodes);
      let selections = args.uniqueSelections(selected);
      let isWholeTreeScope = false;
      const selectedGroup = commandScopeHints.length === 0 && args.state.selectedGroupId
        ? args.state.groups.find((group) => group.id === args.state.selectedGroupId && group.side === "central")
        : undefined;
      if (selections.length === 0 && commandNodes.length === 0 && selectedGroup) {
        selections = args.uniqueSelections(args.targetsToSelections(args.state.centralSkills, selectedGroup.targets));
      }
      if (selections.length === 0 && commandNodes.length === 0 && !selectedGroup) {
        const pick = await args.pickEmptyTransferScope("central");
        if (pick !== "all") return;
        selections = args.uniqueSelections(args.centralProvider.getAllSelections());
        isWholeTreeScope = true;
      }
      if (selections.length === 0) {
        vscode.window.showWarningMessage(args.tr("No recognized skills files were found in Central.", "중앙 저장소에서 인식된 스킬 파일이 없습니다."));
        return;
      }

      const scopeHints = selectedGroup
        ? selectedGroup.targets.map((target) => ({ ...target }))
        : commandScopeHints.length > 0
          ? commandScopeHints
          : undefined;
      const result = await args.transferSelections("central", selections, {
        groupContext: selectedGroup ? { id: selectedGroup.id, name: selectedGroup.name, side: selectedGroup.side } : undefined,
        scopeContext: args.buildTransferScopeContext({
          side: "central",
          nodes: commandNodes,
          hints: scopeHints,
          selectedGroup,
          isWholeTreeScope
        }),
        scopeHints
      });
      const mirroredGroups = await args.mirrorGroupsForTransferResult("central", result, selectedGroup ? [selectedGroup.id] : undefined);
      await args.refresh();
      if (result.copied + result.deleted === 0) {
        vscode.window.showInformationMessage(args.tr(`No Workspace file changes to copy${mirroredGroups > 0 ? " · group synced" : ""}`, `작업 폴더 파일 변경 없음${mirroredGroups > 0 ? " · 그룹 동기화됨" : ""}`));
        return;
      }
      vscode.window.showInformationMessage(args.tr(
        `Workspace updated: copied ${result.copied} · deleted ${result.deleted} · unchanged ${result.unchanged}${mirroredGroups > 0 ? " · group synced" : ""}`,
        `작업공간 반영: 복사 행 ${result.copied}개 / 삭제 행 ${result.deleted}개 / 변경없음 행 ${result.unchanged}개${mirroredGroups > 0 ? " · 그룹 동기화됨" : ""}`
      ));
    } catch (error) {
      await args.handleError(error);
    }
  };

  const isSameFileContent = async (src: string, dst: string, srcSize: number, dstSize: number): Promise<boolean> => {
    if (srcSize !== dstSize) return false;
    const [srcBuffer, dstBuffer] = await Promise.all([fs.readFile(src), fs.readFile(dst)]);
    return srcBuffer.equals(dstBuffer);
  };

  return {
    promoteSelected,
    importSelected,
    getInstructionTransferTargets,
    transferInstructions,
    summarizeInstructionProfiles,
    openInstructionDiff,
    isSameFileContent
  };
}
