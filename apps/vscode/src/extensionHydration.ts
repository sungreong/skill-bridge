import { promises as fs } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import type {
  GroupTarget,
  ProjectPreset,
  SelectionGroup,
  SkillFile,
  ToolType
} from "./types";
import type { WizardAssetPick } from "./extensionAddMoveWizard";
import { loadProjectPresets, saveProjectPresets } from "./extensionStorage";

type TreeSide = "workspace" | "central";
type TranslationFn = (english: string, korean: string) => string;

type HydrationDeps = {
  tr: TranslationFn;
  toUserError: (error: unknown) => string;
  handleError: (error: unknown) => Promise<void>;
  workspacePath: () => string;
  centralRepoPath: () => string;
  agents: () => ToolType[];
  centralSkills: () => SkillFile[];
  refresh: () => Promise<void>;
  getWizardAssetPicks: (side: TreeSide) => WizardAssetPick[];
  statusLabelForWizard: (status: WizardAssetPick["status"]) => string;
  getWritableSkillRoot: (basePath: string, tool: ToolType, mode: TreeSide) => string;
  getSkillRoot: (basePath: string, tool: ToolType, mode: TreeSide) => string;
  exists: (targetPath: string) => Promise<boolean>;
  copyNode: (sourcePath: string, destinationPath: string) => Promise<void>;
  targetExistsInFiles: (target: GroupTarget, files: SkillFile[]) => boolean;
  targetsToSelections: (files: SkillFile[], targets: GroupTarget[]) => Array<{ tool: ToolType; relativePath: string }>;
  transferSelections: (
    side: TreeSide,
    selections: Array<{ tool: ToolType; relativePath: string }>,
    options?: { scopeHints?: GroupTarget[]; repoContext?: { repo: string } }
  ) => Promise<{ copied: number; deleted: number; unchanged: number }>;
  dedupeGroupTargets: (targets: GroupTarget[]) => GroupTarget[];
  slugifyPackId: (value: string) => string;
  bundledSkillManagerRelativePath: string;
  extensionPath: string;
  upsertHydratedWorkspaceGroup: (packName: string, packId: string, targets: GroupTarget[]) => Promise<void>;
};

export function createHydrationTools(deps: HydrationDeps): {
  hydrateCurrentProject: () => Promise<void>;
  downloadCentralSkillToWorkspace: () => Promise<void>;
  downloadSkillManagerSkillToWorkspace: () => Promise<void>;
  createCentralPack: () => Promise<void>;
} {
  const pickManualHydrationTargets = async (
    centralAssets: WizardAssetPick[]
  ): Promise<{ name: string; id: string; targets: GroupTarget[]; description: string } | undefined> => {
    const assetPicks = await vscode.window.showQuickPick(
      centralAssets.map((asset) => ({
        label: `${asset.tool}/${asset.skillName}`,
        description: deps.statusLabelForWizard(asset.status),
        detail: `${asset.rootRelativePath} · ${deps.tr("files", "파일")} ${asset.fileCount} · ${deps.tr("warnings", "경고")} ${asset.warnings.length}`,
        value: asset
      })),
      {
        title: deps.tr("Choose Central Skills for This Project", "현재 프로젝트에 가져올 중앙 스킬 선택"),
        canPickMany: true,
        matchOnDescription: true,
        matchOnDetail: true
      }
    );
    if (!assetPicks || assetPicks.length === 0) return undefined;
    const targets = deps.dedupeGroupTargets(assetPicks.map((pick) => ({
      kind: "folder",
      tool: pick.value.tool,
      relativePath: pick.value.rootRelativePath
    })));
    const defaultName = targets.length === 1
      ? targets[0].relativePath.split("/")[1] ?? "manual"
      : `manual-${new Date().toISOString().slice(0, 10)}`;
    return {
      name: `Manual: ${defaultName}`,
      id: `manual-${Date.now()}`,
      targets,
      description: deps.tr("Manually selected Central skills", "직접 선택한 중앙 스킬")
    };
  };

  const hydrateCurrentProject = async (): Promise<void> => {
    try {
      if (!deps.workspacePath() || !deps.centralRepoPath()) await deps.refresh();
      const presetsFile = (await loadProjectPresets(deps.centralRepoPath())).file;
      const centralAssets = deps.getWizardAssetPicks("central").filter((asset) => asset.status !== "missingSkillMd");
      if (presetsFile.presets.length === 0 && centralAssets.length === 0) {
        vscode.window.showWarningMessage(deps.tr("There are no skills to bring from the Central Skill Home.", "중앙 스킬 홈에 가져올 스킬이 없습니다."));
        return;
      }

      type HydratePick =
        | { actionKind: "preset"; label: string; description: string; detail: string; preset: ProjectPreset }
        | { actionKind: "manual"; label: string; description: string; detail: string };

      const picks: HydratePick[] = [
        ...presetsFile.presets.map((preset) => ({
          actionKind: "preset" as const,
          label: `$(package) ${preset.name}`,
          description: deps.tr(`${preset.targets.length} skills`, `스킬 ${preset.targets.length}개`),
          detail: preset.description || deps.tr("Project preset", "프로젝트 프리셋"),
          preset
        })),
        {
          actionKind: "manual" as const,
          label: deps.tr("$(list-selection) Select Central Skills Manually", "$(list-selection) 중앙 스킬 직접 선택"),
          description: deps.tr(`Choose from ${centralAssets.length} skills`, `스킬 ${centralAssets.length}개 중 선택`),
          detail: deps.tr("Choose only the skills this project needs and review them before applying.", "현재 프로젝트에 필요한 스킬만 골라 반영 전 검토 화면에서 확인합니다.")
        }
      ];

      const choice = await vscode.window.showQuickPick(picks, {
        title: deps.tr("Apply Project Preset", "프로젝트 프리셋 적용"),
        placeHolder: deps.tr("Choose a project preset or individual Central skills to add to this workspace.", "이 workspace에 적용할 프로젝트 프리셋 또는 중앙 스킬을 선택하세요."),
        matchOnDescription: true,
        matchOnDetail: true
      });
      if (!choice) return;

      const selected = choice.actionKind === "preset"
        ? {
            name: choice.preset.name,
            id: choice.preset.id,
            targets: deps.dedupeGroupTargets(choice.preset.targets),
            description: choice.preset.description
          }
        : await pickManualHydrationTargets(centralAssets);
      if (!selected || selected.targets.length === 0) return;

      const availableTargets = selected.targets.filter((target) => deps.targetExistsInFiles(target, deps.centralSkills()));
      const missingCount = selected.targets.length - availableTargets.length;
      if (availableTargets.length === 0) {
        vscode.window.showWarningMessage(deps.tr("The selected preset or skills are not in the current Central Skill Home.", "선택한 프리셋/스킬이 현재 중앙 스킬 홈에 없습니다."));
        return;
      }
      if (missingCount > 0) {
        vscode.window.showWarningMessage(deps.tr(`Skipping ${missingCount} skills that are not in Central.`, `중앙에 없는 스킬 ${missingCount}개는 건너뜁니다.`));
      }

      const selections = deps.targetsToSelections(deps.centralSkills(), availableTargets);
      if (selections.length === 0) {
        vscode.window.showWarningMessage(deps.tr("No files were found to bring in.", "가져올 파일을 찾지 못했습니다."));
        return;
      }

      const result = await deps.transferSelections("central", selections, {
        scopeHints: availableTargets,
        repoContext: { repo: selected.name }
      });
      await deps.upsertHydratedWorkspaceGroup(selected.name, selected.id, availableTargets);
      await deps.refresh();
      vscode.window.showInformationMessage(
        deps.tr(
          `Added skills to workspace: copied ${result.copied} · deleted ${result.deleted} · unchanged ${result.unchanged}`,
          `프로젝트 프리셋 적용 완료: 복사 행 ${result.copied}개 / 삭제 행 ${result.deleted}개 / 변경없음 행 ${result.unchanged}개`
        )
      );
    } catch (error) {
      await deps.handleError(error);
    }
  };

  const downloadCentralSkillToWorkspace = async (): Promise<void> => {
    try {
      if (!deps.workspacePath() || !deps.centralRepoPath()) await deps.refresh();
      const centralAssets = deps.getWizardAssetPicks("central").filter((asset) => asset.status !== "missingSkillMd");
      if (centralAssets.length === 0) {
        vscode.window.showWarningMessage(deps.tr("There are no Central skills to bring to Workspace.", "작업공간으로 가져올 중앙 스킬이 없습니다."));
        return;
      }

      const sourcePick = await vscode.window.showQuickPick(
        centralAssets.map((asset) => ({
          label: `${asset.tool}/${asset.skillName}`,
          description: deps.statusLabelForWizard(asset.status),
          detail: `${asset.rootRelativePath} · ${deps.tr("files", "파일")} ${asset.fileCount} · ${deps.tr("warnings", "경고")} ${asset.warnings.length}${asset.updatedAt ? ` · ${asset.updatedAt}` : ""}`,
          value: asset
        })),
        {
          title: deps.tr("Search Central Skills to Bring", "가져올 중앙 스킬 검색"),
          placeHolder: deps.tr("Search by skill name, agent, or path.", "스킬 이름, 에이전트, 경로로 검색하세요."),
          matchOnDescription: true,
          matchOnDetail: true
        }
      );
      if (!sourcePick) return;

      const agents = deps.agents();
      const targetPick = await vscode.window.showQuickPick(
        [
          {
            label: deps.tr("All Agents", "모든 에이전트"),
            description: deps.tr("Install into every configured workspace agent folder", "설정된 모든 작업공간 에이전트 폴더에 설치"),
            detail: agents.map((agent) => agent === "agents" ? ".agents" : `.${agent}`).join(", "),
            value: "all" as const
          },
          ...agents.map((agent) => ({
            label: agent === "agents" ? ".agents" : `.${agent}`,
            description: deps.tr("Workspace target agent folder", "작업공간 대상 에이전트 폴더"),
            detail: path.join(deps.workspacePath(), deps.getWritableSkillRoot("", agent, "workspace")),
            value: agent
          }))
        ],
        {
          title: deps.tr("Choose Target Agent Folder", "대상 에이전트 폴더 선택"),
          placeHolder: deps.tr("Choose the workspace agent folder to receive this skill.", "이 스킬을 받을 작업공간 에이전트 폴더를 선택하세요."),
          matchOnDescription: true,
          matchOnDetail: true
        }
      );
      if (!targetPick) return;

      const sourceRoot = deps.getSkillRoot(deps.centralRepoPath(), sourcePick.value.tool, "central");
      const sourceAbs = path.join(sourceRoot, sourcePick.value.rootRelativePath);
      if (!(await deps.exists(path.join(sourceAbs, "SKILL.md")))) {
        vscode.window.showErrorMessage(deps.tr(`Central skill is missing SKILL.md: ${sourcePick.value.tool}/${sourcePick.value.rootRelativePath}`, `중앙 스킬에 SKILL.md가 없습니다: ${sourcePick.value.tool}/${sourcePick.value.rootRelativePath}`));
        return;
      }

      const targetTools = targetPick.value === "all" ? agents : [targetPick.value];
      const targetInfos = await Promise.all(targetTools.map(async (tool) => {
        const targetRoot = deps.getWritableSkillRoot(deps.workspacePath(), tool, "workspace");
        const targetAbs = path.join(targetRoot, sourcePick.value.rootRelativePath);
        return {
          tool,
          targetAbs,
          targetExists: await deps.exists(targetAbs)
        };
      }));
      const existingTargets = targetInfos.filter((info) => info.targetExists);
      if (existingTargets.length > 0) {
        const ok = await vscode.window.showWarningMessage(
          deps.tr(
            `${existingTargets.length} target(s) already contain ${sourcePick.value.rootRelativePath}. Update them with Central ${sourcePick.value.tool}/${sourcePick.value.rootRelativePath}?`,
            `${existingTargets.length}개 대상에 ${sourcePick.value.rootRelativePath}이(가) 이미 있습니다. Central의 ${sourcePick.value.tool}/${sourcePick.value.rootRelativePath} 내용으로 업데이트할까요?`
          ),
          { modal: true },
          deps.tr("Update", "업데이트")
        );
        if (ok !== deps.tr("Update", "업데이트")) return;
        await Promise.all(existingTargets.map((info) => fs.rm(info.targetAbs, { recursive: true, force: true })));
      }

      for (const info of targetInfos) {
        await fs.mkdir(path.dirname(info.targetAbs), { recursive: true });
        await deps.copyNode(sourceAbs, info.targetAbs);
      }
      const targets: GroupTarget[] = targetInfos.map((info) => ({
        kind: "folder",
        tool: info.tool,
        relativePath: sourcePick.value.rootRelativePath
      }));
      await deps.upsertHydratedWorkspaceGroup(
        `Bring: ${sourcePick.value.skillName}`,
        `download-${targetPick.value}-${sourcePick.value.skillName}`,
        targets
      );
      await deps.refresh();
      const targetLabel = targetPick.value === "all" ? deps.tr(`all agents (${targetInfos.length})`, `모든 agent (${targetInfos.length}개)`) : targetPick.value;
      vscode.window.showInformationMessage(
        deps.tr(
          `Installed: Central ${sourcePick.value.tool}/${sourcePick.value.skillName} to Workspace ${targetLabel}`,
          `설치 완료: 중앙 ${sourcePick.value.tool}/${sourcePick.value.skillName} → 작업공간 ${targetLabel}`
        )
      );
    } catch (error) {
      await deps.handleError(error);
    }
  };

  const downloadSkillManagerSkillToWorkspace = async (): Promise<void> => {
    try {
      if (!deps.workspacePath() || !deps.centralRepoPath()) await deps.refresh();
      const sourceAbs = path.join(deps.extensionPath, "resources", "bundled-skills", ...deps.bundledSkillManagerRelativePath.split("/"));
      if (!(await deps.exists(path.join(sourceAbs, "SKILL.md")))) {
        vscode.window.showErrorMessage(deps.tr(`Bundled skill-manager skill was not found: ${sourceAbs}`, `번들된 skill-manager 스킬을 찾을 수 없습니다: ${sourceAbs}`));
        return;
      }

      const agents = deps.agents();
      const targetPick = await vscode.window.showQuickPick(
        [
          {
            label: deps.tr("All Agents", "모든 에이전트"),
            description: deps.tr("Install into every configured workspace agent folder", "설정된 모든 작업공간 에이전트 폴더에 설치"),
            detail: agents.map((agent) => agent === "agents" ? ".agents" : `.${agent}`).join(", "),
            value: "all" as const
          },
          ...agents.map((agent) => ({
            label: agent === "agents" ? ".agents" : `.${agent}`,
            description: deps.tr("Workspace target agent folder", "작업공간 대상 에이전트 폴더"),
            detail: path.join(deps.workspacePath(), deps.getWritableSkillRoot("", agent, "workspace")),
            value: agent
          }))
        ],
        {
          title: deps.tr("Install Skill Manager Helper", "Skill Manager 도우미 설치"),
          placeHolder: deps.tr("Choose the workspace agent folder that will receive the skill-manager skill.", "skill-manager 스킬을 받을 작업공간 에이전트 폴더를 선택하세요."),
          matchOnDescription: true,
          matchOnDetail: true
        }
      );
      if (!targetPick) return;

      const targetTools = targetPick.value === "all" ? agents : [targetPick.value];
      const targetInfos = await Promise.all(targetTools.map(async (tool) => {
        const targetRoot = deps.getWritableSkillRoot(deps.workspacePath(), tool, "workspace");
        const targetAbs = path.join(targetRoot, ...deps.bundledSkillManagerRelativePath.split("/"));
        return {
          tool,
          targetAbs,
          targetExists: await deps.exists(targetAbs)
        };
      }));
      const existingTargets = targetInfos.filter((info) => info.targetExists);
      if (existingTargets.length > 0) {
        const ok = await vscode.window.showWarningMessage(
          deps.tr(
            `${existingTargets.length} target(s) already contain ${deps.bundledSkillManagerRelativePath}. Update them with the bundled skill-manager content?`,
            `${existingTargets.length}개 대상에 ${deps.bundledSkillManagerRelativePath}이(가) 이미 있습니다. 번들된 skill-manager 내용으로 업데이트할까요?`
          ),
          { modal: true },
          deps.tr("Update", "업데이트")
        );
        if (ok !== deps.tr("Update", "업데이트")) return;
        await Promise.all(existingTargets.map((info) => fs.rm(info.targetAbs, { recursive: true, force: true })));
      }

      for (const info of targetInfos) {
        await fs.mkdir(path.dirname(info.targetAbs), { recursive: true });
        await deps.copyNode(sourceAbs, info.targetAbs);
      }
      await deps.upsertHydratedWorkspaceGroup(
        "Install: skill-manager",
        `download-${targetPick.value}-skill-manager`,
        targetInfos.map((info) => ({
          kind: "folder",
          tool: info.tool,
          relativePath: deps.bundledSkillManagerRelativePath
        }))
      );
      await deps.refresh();
      const targetLabel = targetPick.value === "all" ? deps.tr(`all agents (${targetInfos.length})`, `모든 agent (${targetInfos.length}개)`) : targetPick.value;
      vscode.window.showInformationMessage(
        deps.tr(
          `Installed: bundled skill-manager to Workspace ${targetLabel}`,
          `설치 완료: 번들 skill-manager → 작업공간 ${targetLabel}`
        )
      );
    } catch (error) {
      await deps.handleError(error);
    }
  };

  const createCentralPack = async (): Promise<void> => {
    try {
      if (!deps.workspacePath() || !deps.centralRepoPath()) await deps.refresh();
      const centralAssets = deps.getWizardAssetPicks("central").filter((asset) => asset.status !== "missingSkillMd");
      if (centralAssets.length === 0) {
        vscode.window.showWarningMessage(deps.tr("There are no Central skills to save as a project preset.", "프로젝트 프리셋으로 저장할 중앙 스킬이 없습니다."));
        return;
      }
      const selected = await vscode.window.showQuickPick(
        centralAssets.map((asset) => ({
          label: `${asset.tool}/${asset.skillName}`,
          description: deps.statusLabelForWizard(asset.status),
          detail: `${asset.rootRelativePath} · ${deps.tr("files", "파일")} ${asset.fileCount} · ${deps.tr("warnings", "경고")} ${asset.warnings.length}`,
          value: asset
        })),
        {
          title: deps.tr("Choose Central Skills for the Project Preset", "프로젝트 프리셋에 넣을 중앙 스킬 선택"),
          canPickMany: true,
          matchOnDescription: true,
          matchOnDetail: true
        }
      );
      if (!selected || selected.length === 0) return;

      const name = await vscode.window.showInputBox({
        title: deps.tr("Project Preset Name", "프로젝트 프리셋 이름"),
        prompt: deps.tr("Example: personal-default, frontend-project, langgraph-project", "예: personal-default, frontend-project, langgraph-project"),
        validateInput: (value) => value.trim() ? null : deps.tr("Enter a preset name.", "프리셋 이름을 입력하세요."),
        ignoreFocusOut: true
      });
      if (!name?.trim()) return;
      const description = await vscode.window.showInputBox({
        title: deps.tr("Project Preset Description", "프로젝트 프리셋 설명"),
        prompt: deps.tr("Optional. Describe which projects this preset is useful for so it is easier to find later.", "선택 사항입니다. 어떤 프로젝트에 쓰는 프리셋인지 적어두면 나중에 찾기 쉽습니다."),
        ignoreFocusOut: true
      });

      const targets = deps.dedupeGroupTargets(selected.map((pick) => ({
        kind: "folder",
        tool: pick.value.tool,
        relativePath: pick.value.rootRelativePath
      })));
      const presetsFile = (await loadProjectPresets(deps.centralRepoPath())).file;
      const now = new Date().toISOString();
      const id = deps.slugifyPackId(name.trim());
      const previous = presetsFile.presets.find((item) => item.id === id);
      if (previous) {
        const ok = await vscode.window.showWarningMessage(
          deps.tr(`A project preset with this name already exists: ${previous.name}. Replace it with this selection?`, `이미 같은 이름의 프로젝트 프리셋이 있습니다: ${previous.name}. 새 선택으로 바꿀까요?`),
          { modal: true },
          deps.tr("Replace", "바꾸기")
        );
        if (ok !== deps.tr("Replace", "바꾸기")) return;
      }
      const preset: ProjectPreset = {
        id,
        name: name.trim(),
        description: description?.trim() ?? "",
        targets,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now
      };
      presetsFile.presets = [...presetsFile.presets.filter((item) => item.id !== id), preset]
        .sort((a, b) => a.name.localeCompare(b.name));
      presetsFile.updatedAt = now;
      await saveProjectPresets(deps.centralRepoPath(), presetsFile);
      vscode.window.showInformationMessage(deps.tr(`Project preset saved: ${preset.name} (${preset.targets.length} skills)`, `프로젝트 프리셋 저장 완료: ${preset.name} (스킬 ${preset.targets.length}개)`));
    } catch (error) {
      await deps.handleError(error);
    }
  };

  return {
    hydrateCurrentProject,
    downloadCentralSkillToWorkspace,
    downloadSkillManagerSkillToWorkspace,
    createCentralPack
  };
}
