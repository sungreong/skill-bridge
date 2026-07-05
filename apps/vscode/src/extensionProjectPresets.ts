import * as vscode from "vscode";
import type { GroupTarget, ProjectPreset, ProjectPresetsFile, SelectionGroup, SkillFile, SkillSelection, SkillTreeNode, ToolType } from "./types";
import type { WizardAssetPick } from "./extensionAddMoveWizard";

type TreeSide = "workspace" | "central";
type TranslationFn = (english: string, korean: string) => string;
type TransferResult = { copied: number; deleted: number; unchanged: number; failed?: number };

export function createProjectPresetTools(args: {
  tr: TranslationFn;
  toUserError: (error: unknown) => string;
  handleError: (error: unknown) => Promise<void>;
  state: {
    workspacePath: string;
    centralRepoPath: string;
    workspaceSkills: SkillFile[];
    centralSkills: SkillFile[];
    centralProjectPresets: ProjectPreset[];
    groups: SelectionGroup[];
    workspaceSelection: SkillTreeNode[];
  };
  refresh: () => Promise<void>;
  loadProjectPresets: (centralRepoPath: string) => Promise<{ file: ProjectPresetsFile; migratedFromLegacy: boolean }>;
  saveProjectPresets: (centralRepoPath: string, file: ProjectPresetsFile) => Promise<void>;
  getWizardAssetPicks: (side: TreeSide) => WizardAssetPick[];
  statusLabelForWizard: (status: WizardAssetPick["status"]) => string;
  targetExistsInFiles: (target: GroupTarget, files: SkillFile[]) => boolean;
  targetsToSelections: (files: SkillFile[], targets: GroupTarget[]) => SkillSelection[];
  transferSelections: (side: TreeSide, selections: SkillSelection[], options?: { scopeHints?: GroupTarget[]; repoContext?: { repo: string } }) => Promise<TransferResult>;
  dedupeGroupTargets: (targets: GroupTarget[]) => GroupTarget[];
  slugifyProjectPresetId: (value: string) => string;
  buildGroupTargetsFromNodes: (nodes: SkillTreeNode[]) => GroupTarget[];
  getSkillFolderRelativePath: (relativePath: string) => string | null;
  resolveGroup: (node?: unknown) => SelectionGroup | undefined;
  upsertPresetWorkspaceGroup: (presetName: string, presetId: string, targets: GroupTarget[]) => Promise<void>;
}): {
  applyProjectPreset: (node?: unknown) => Promise<void>;
  createProjectPresetFromCentral: () => Promise<void>;
  createProjectPresetFromWorkspace: (node?: SkillTreeNode) => Promise<void>;
  createProjectPresetFromWorkspaceGroup: (node?: unknown) => Promise<void>;
  renameProjectPreset: (node?: unknown) => Promise<void>;
  editProjectPresetDescription: (node?: unknown) => Promise<void>;
  deleteProjectPreset: (node?: unknown) => Promise<void>;
  resolveProjectPreset: (node?: unknown) => ProjectPreset | undefined;
} {
  const resolveProjectPreset = (node?: unknown): ProjectPreset | undefined => {
    const targetId = extractPresetId(node);
    if (targetId) return args.state.centralProjectPresets.find((preset) => preset.id === targetId);
    return undefined;
  };

  const applyProjectPreset = async (node?: unknown): Promise<void> => {
    await runPresetAction(async () => {
      const preset = resolveProjectPreset(node) ?? await pickProjectPreset(args.state.centralProjectPresets);
      if (!preset) return;
      const availableTargets = preset.targets.filter((target) => args.targetExistsInFiles(target, args.state.centralSkills));
      if (availableTargets.length === 0) {
        vscode.window.showWarningMessage(args.tr("This project preset has no available Central skills.", "이 프로젝트 프리셋에는 사용 가능한 Central 스킬이 없습니다."));
        return;
      }
      if (availableTargets.length < preset.targets.length) {
        vscode.window.showWarningMessage(args.tr(
          `Skipping ${preset.targets.length - availableTargets.length} missing preset target(s).`,
          `프리셋 대상 중 누락된 ${preset.targets.length - availableTargets.length}개는 건너뜁니다.`
        ));
      }
      const selections = args.targetsToSelections(args.state.centralSkills, availableTargets);
      const result = await args.transferSelections("central", selections, {
        scopeHints: availableTargets,
        repoContext: { repo: preset.name }
      });
      if (isEmptyTransfer(result)) return;
      await args.upsertPresetWorkspaceGroup(preset.name, preset.id, availableTargets);
      await touchPreset(preset.id, (current) => ({ ...current, lastAppliedAt: new Date().toISOString() }));
      await args.refresh();
      vscode.window.showInformationMessage(args.tr(
        `Project preset applied: ${preset.name}`,
        `프로젝트 프리셋 적용 완료: ${preset.name}`
      ));
    });
  };

  const createProjectPresetFromCentral = async (): Promise<void> => {
    await runPresetAction(async () => {
      if (!args.state.workspacePath || !args.state.centralRepoPath) await args.refresh();
      const centralAssets = args.getWizardAssetPicks("central").filter((asset) => asset.status !== "missingSkillMd");
      if (centralAssets.length === 0) {
        vscode.window.showWarningMessage(args.tr("There are no Central skills to save as a project preset.", "프로젝트 프리셋으로 저장할 Central 스킬이 없습니다."));
        return;
      }
      const selected = await vscode.window.showQuickPick(
        centralAssets.map((asset) => ({
          label: `${asset.tool}/${asset.skillName}`,
          description: args.statusLabelForWizard(asset.status),
          detail: `${asset.rootRelativePath} · ${args.tr("files", "파일")} ${asset.fileCount} · ${args.tr("warnings", "경고")} ${asset.warnings.length}`,
          value: asset
        })),
        {
          title: args.tr("Choose Central Skills for the Project Preset", "프로젝트 프리셋에 넣을 Central 스킬 선택"),
          canPickMany: true,
          matchOnDescription: true,
          matchOnDetail: true
        }
      );
      if (!selected || selected.length === 0) return;
      await promptAndSavePreset(selected.map((pick) => ({
        kind: "folder",
        tool: pick.value.tool,
        relativePath: pick.value.rootRelativePath
      })));
    });
  };

  const createProjectPresetFromWorkspace = async (node?: SkillTreeNode): Promise<void> => {
    await runPresetAction(async () => {
      const targets = node
        ? workspaceTargetsFromNode(node)
        : workspaceTargetsFromCurrentSelection();
      await exportWorkspaceTargets(targets);
    });
  };

  const createProjectPresetFromWorkspaceGroup = async (node?: unknown): Promise<void> => {
    await runPresetAction(async () => {
      const group = args.resolveGroup(node);
      if (!group || group.side !== "workspace") {
        vscode.window.showWarningMessage(args.tr("Choose a Workspace group first.", "먼저 작업공간 그룹을 선택하세요."));
        return;
      }
      await exportWorkspaceTargets(group.targets, group.name, group.description ?? "");
    });
  };

  const renameProjectPreset = async (node?: unknown): Promise<void> => {
    await editPresetNameOrDescription(node, "name");
  };

  const editProjectPresetDescription = async (node?: unknown): Promise<void> => {
    await editPresetNameOrDescription(node, "description");
  };

  const deleteProjectPreset = async (node?: unknown): Promise<void> => {
    await runPresetAction(async () => {
      const preset = resolveProjectPreset(node) ?? await pickProjectPreset(args.state.centralProjectPresets);
      if (!preset) return;
      const ok = await vscode.window.showWarningMessage(
        args.tr(`Delete project preset "${preset.name}"? Skill files will not be deleted.`, `프로젝트 프리셋 "${preset.name}"을 삭제할까요? 스킬 파일은 삭제하지 않습니다.`),
        { modal: true },
        args.tr("Delete preset", "프리셋 삭제")
      );
      if (ok !== args.tr("Delete preset", "프리셋 삭제")) return;
      await savePresetFile((file) => ({
        ...file,
        updatedAt: new Date().toISOString(),
        presets: file.presets.filter((item) => item.id !== preset.id)
      }));
      await args.refresh();
    });
  };

  const editPresetNameOrDescription = async (node: unknown, field: "name" | "description"): Promise<void> => {
    await runPresetAction(async () => {
      const preset = resolveProjectPreset(node) ?? await pickProjectPreset(args.state.centralProjectPresets);
      if (!preset) return;
      const value = await vscode.window.showInputBox({
        title: field === "name" ? args.tr("Rename Project Preset", "프로젝트 프리셋 이름 변경") : args.tr("Edit Project Preset Description", "프로젝트 프리셋 설명 편집"),
        value: field === "name" ? preset.name : preset.description,
        validateInput: (input) => field === "name" && !input.trim() ? args.tr("Enter a preset name.", "프리셋 이름을 입력하세요.") : null,
        ignoreFocusOut: true
      });
      if (value === undefined) return;
      const nextName = field === "name" ? value.trim() : preset.name;
      const nextId = field === "name" ? args.slugifyProjectPresetId(nextName) : preset.id;
      if (field === "name" && nextId !== preset.id && args.state.centralProjectPresets.some((item) => item.id === nextId)) {
        vscode.window.showWarningMessage(args.tr("A project preset with this name already exists.", "이미 같은 이름의 프로젝트 프리셋이 있습니다."));
        return;
      }
      await touchPreset(preset.id, (current) => ({
        ...current,
        id: nextId,
        name: nextName,
        description: field === "description" ? value.trim() : current.description
      }));
      await args.refresh();
    });
  };

  const exportWorkspaceTargets = async (targets: GroupTarget[], defaultName?: string, defaultDescription?: string): Promise<void> => {
    const normalizedTargets = normalizeTargets(targets);
    if (normalizedTargets.length === 0) {
      vscode.window.showWarningMessage(args.tr("No valid Workspace skill folders were found for this project preset.", "프로젝트 프리셋으로 만들 수 있는 작업공간 스킬 폴더를 찾지 못했습니다."));
      return;
    }
    const workspaceStatuses = workspaceStatusByTarget();
    const missingSkillMdTargets = normalizedTargets.filter((target) => workspaceStatuses.get(targetKey(target)) === "missingSkillMd");
    if (missingSkillMdTargets.length > 0) {
      vscode.window.showWarningMessage(args.tr(
        `Skipped ${missingSkillMdTargets.length} folder(s) without SKILL.md.`,
        `SKILL.md가 없는 폴더 ${missingSkillMdTargets.length}개는 프리셋 후보에서 제외했습니다.`
      ));
    }
    const eligibleTargets = normalizedTargets.filter((target) => workspaceStatuses.get(targetKey(target)) !== "missingSkillMd");
    if (eligibleTargets.length === 0) {
      vscode.window.showWarningMessage(args.tr("No valid Workspace skill folders were found for this project preset.", "프로젝트 프리셋으로 만들 수 있는 작업공간 스킬 폴더를 찾지 못했습니다."));
      return;
    }
    const missingOrChangedTargets = eligibleTargets.filter((target) => {
      const status = workspaceStatuses.get(targetKey(target));
      return !args.targetExistsInFiles(target, args.state.centralSkills) || status === "new" || status === "changed" || status === "risk";
    });
    if (missingOrChangedTargets.length > 0) {
      const selections = args.targetsToSelections(args.state.workspaceSkills, missingOrChangedTargets);
      const result = await args.transferSelections("workspace", selections, {
        scopeHints: missingOrChangedTargets,
        repoContext: { repo: defaultName ?? args.tr("Workspace project preset", "작업공간 프로젝트 프리셋") }
      });
      if (isEmptyTransfer(result)) return;
      await args.refresh();
    }
    const availableTargets = eligibleTargets.filter((target) => args.targetExistsInFiles(target, args.state.centralSkills));
    if (availableTargets.length === 0) {
      vscode.window.showWarningMessage(args.tr("No selected skills are available in Central after review.", "전송 검토 후 중앙에서 사용할 수 있는 선택 스킬이 없습니다."));
      return;
    }
    if (availableTargets.length < eligibleTargets.length) {
      const ok = await vscode.window.showWarningMessage(
        args.tr(
          `Save only ${availableTargets.length}/${eligibleTargets.length} skills that exist in Central?`,
          `중앙에 있는 ${availableTargets.length}/${eligibleTargets.length}개 스킬만 저장할까요?`
        ),
        { modal: true },
        args.tr("Save available skills", "있는 스킬만 저장")
      );
      if (ok !== args.tr("Save available skills", "있는 스킬만 저장")) return;
    }
    await promptAndSavePreset(availableTargets, defaultName, defaultDescription);
  };

  const promptAndSavePreset = async (targets: GroupTarget[], defaultName = "", defaultDescription = ""): Promise<ProjectPreset | null> => {
    const name = await vscode.window.showInputBox({
      title: args.tr("Project Preset Name", "프로젝트 프리셋 이름"),
      value: defaultName,
      prompt: args.tr("Example: personal-default, frontend-project, langgraph-project", "예: personal-default, frontend-project, langgraph-project"),
      validateInput: (value) => value.trim() ? null : args.tr("Enter a preset name.", "프리셋 이름을 입력하세요."),
      ignoreFocusOut: true
    });
    if (!name?.trim()) return null;
    const description = await vscode.window.showInputBox({
      title: args.tr("Project Preset Description", "프로젝트 프리셋 설명"),
      value: defaultDescription,
      prompt: args.tr("Optional. Describe which projects this preset is useful for.", "선택 사항입니다. 어떤 프로젝트에 쓰는 프리셋인지 적어두세요."),
      ignoreFocusOut: true
    });
    const id = args.slugifyProjectPresetId(name.trim());
    const previous = args.state.centralProjectPresets.find((item) => item.id === id);
    if (previous) {
      const ok = await vscode.window.showWarningMessage(
        args.tr(`Replace existing project preset "${previous.name}"?`, `기존 프로젝트 프리셋 "${previous.name}"을 바꿀까요?`),
        { modal: true },
        args.tr("Replace preset", "프리셋 바꾸기")
      );
      if (ok !== args.tr("Replace preset", "프리셋 바꾸기")) return null;
    }
    const now = new Date().toISOString();
    const preset: ProjectPreset = {
      id,
      name: name.trim(),
      description: description?.trim() ?? "",
      targets: args.dedupeGroupTargets(targets),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      lastAppliedAt: previous?.lastAppliedAt
    };
    await savePresetFile((file) => ({
      ...file,
      updatedAt: now,
      presets: [...file.presets.filter((item) => item.id !== id), preset].sort((a, b) => a.name.localeCompare(b.name))
    }));
    await args.refresh();
    vscode.window.showInformationMessage(args.tr(`Project preset saved: ${preset.name}`, `프로젝트 프리셋 저장 완료: ${preset.name}`));
    return preset;
  };

  const touchPreset = async (presetId: string, update: (preset: ProjectPreset) => ProjectPreset): Promise<void> => {
    const now = new Date().toISOString();
    await savePresetFile((file) => ({
      ...file,
      updatedAt: now,
      presets: file.presets.map((preset) => preset.id === presetId ? { ...update(preset), updatedAt: now } : preset)
    }));
  };

  const savePresetFile = async (update: (file: ProjectPresetsFile) => ProjectPresetsFile): Promise<void> => {
    const loaded = await args.loadProjectPresets(args.state.centralRepoPath);
    await args.saveProjectPresets(args.state.centralRepoPath, update(loaded.file));
  };

  const normalizeTargets = (targets: GroupTarget[]): GroupTarget[] =>
    args.dedupeGroupTargets(targets
      .map((target): GroupTarget | null => {
        const folder = args.getSkillFolderRelativePath(target.relativePath);
        return folder ? { kind: "folder", tool: target.tool, relativePath: folder } : null;
      })
      .filter((target): target is GroupTarget => target !== null));

  const workspaceTargetsFromNode = (node: SkillTreeNode): GroupTarget[] => {
    const nodeTargets = normalizeTargets(args.buildGroupTargetsFromNodes([node]));
    const shouldUseWholeWorkspace = node.side === "workspace"
      && (node.relativePath === "" || node.relativePath === "skills" || node.kind === "toolCommand" || node.kind === "toolSection");
    return nodeTargets.length > 0 || !shouldUseWholeWorkspace ? nodeTargets : targetsFromSkillFiles(args.state.workspaceSkills);
  };

  const workspaceTargetsFromCurrentSelection = (): GroupTarget[] => {
    if (args.state.workspaceSelection.length === 0) return targetsFromSkillFiles(args.state.workspaceSkills);
    const selectedTargets = normalizeTargets(args.buildGroupTargetsFromNodes(args.state.workspaceSelection));
    return selectedTargets.length > 0 ? selectedTargets : targetsFromSkillFiles(args.state.workspaceSkills);
  };

  const workspaceStatusByTarget = (): Map<string, WizardAssetPick["status"]> => {
    const statuses = new Map<string, WizardAssetPick["status"]>();
    for (const asset of args.getWizardAssetPicks("workspace")) {
      statuses.set(targetKey({ kind: "folder", tool: asset.tool, relativePath: asset.rootRelativePath }), asset.status);
    }
    return statuses;
  };

  const targetsFromSkillFiles = (files: SkillFile[]): GroupTarget[] =>
    normalizeTargets(files.map((file) => ({ kind: "folder", tool: file.tool, relativePath: file.relativePath })));

  const pickProjectPreset = async (presets: ProjectPreset[]): Promise<ProjectPreset | undefined> => {
    const pick = await vscode.window.showQuickPick(
      presets.map((preset) => ({
        label: preset.name,
        description: args.tr(`${preset.targets.length} skills`, `스킬 ${preset.targets.length}개`),
        detail: preset.description,
        preset
      })),
      { title: args.tr("Choose Project Preset", "프로젝트 프리셋 선택"), matchOnDescription: true, matchOnDetail: true }
    );
    return pick?.preset;
  };

  const runPresetAction = async (action: () => Promise<void>): Promise<void> => {
    try {
      if (!args.state.workspacePath || !args.state.centralRepoPath) await args.refresh();
      await action();
    } catch (error) {
      await args.handleError(error);
    }
  };

  return {
    applyProjectPreset,
    createProjectPresetFromCentral,
    createProjectPresetFromWorkspace,
    createProjectPresetFromWorkspaceGroup,
    renameProjectPreset,
    editProjectPresetDescription,
    deleteProjectPreset,
    resolveProjectPreset
  };
}

function extractPresetId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.presetId === "string" && record.presetId.trim()) return record.presetId;
  if (typeof record.id === "string" && record.kind === "preset" && record.id.trim()) return record.id;
  if (record.node && typeof record.node === "object") return extractPresetId(record.node);
  return null;
}

function isEmptyTransfer(result: TransferResult): boolean {
  return result.copied + result.deleted + result.unchanged + (result.failed ?? 0) === 0;
}

function targetKey(target: GroupTarget): string {
  return `${target.tool}:${target.relativePath}`;
}
