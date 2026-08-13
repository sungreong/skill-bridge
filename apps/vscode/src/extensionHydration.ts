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
type TranslationFn = (message: string, ...args: Array<string | number | boolean>) => string;

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
        detail: `${asset.rootRelativePath} · ${deps.tr("files")} ${asset.fileCount} · ${deps.tr("warnings")} ${asset.warnings.length}`,
        value: asset
      })),
      {
        title: deps.tr("Choose Central Skills for This Project"),
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
      description: deps.tr("Manually selected Central skills")
    };
  };

  const hydrateCurrentProject = async (): Promise<void> => {
    try {
      if (!deps.workspacePath() || !deps.centralRepoPath()) await deps.refresh();
      const presetsFile = (await loadProjectPresets(deps.centralRepoPath())).file;
      const centralAssets = deps.getWizardAssetPicks("central").filter((asset) => asset.status !== "missingSkillMd");
      if (presetsFile.presets.length === 0 && centralAssets.length === 0) {
        vscode.window.showWarningMessage(deps.tr("There are no skills to bring from the Central Skill Home."));
        return;
      }

      type HydratePick =
        | { actionKind: "preset"; label: string; description: string; detail: string; preset: ProjectPreset }
        | { actionKind: "manual"; label: string; description: string; detail: string };

      const picks: HydratePick[] = [
        ...presetsFile.presets.map((preset) => ({
          actionKind: "preset" as const,
          label: `$(package) ${preset.name}`,
          description: deps.tr("{0} skills", String(preset.targets.length)),
          detail: preset.description || deps.tr("Project preset"),
          preset
        })),
        {
          actionKind: "manual" as const,
          label: deps.tr("$(list-selection) Select Central Skills Manually"),
          description: deps.tr("Choose from {0} skills", String(centralAssets.length)),
          detail: deps.tr("Choose only the skills this project needs and review them before applying.")
        }
      ];

      const choice = await vscode.window.showQuickPick(picks, {
        title: deps.tr("Apply Project Preset"),
        placeHolder: deps.tr("Choose a project preset or individual Central skills to add to this workspace."),
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
        vscode.window.showWarningMessage(deps.tr("The selected preset or skills are not in the current Central Skill Home."));
        return;
      }
      if (missingCount > 0) {
        vscode.window.showWarningMessage(deps.tr("Skipping {0} skills that are not in Central.", String(missingCount)));
      }

      const selections = deps.targetsToSelections(deps.centralSkills(), availableTargets);
      if (selections.length === 0) {
        vscode.window.showWarningMessage(deps.tr("No files were found to bring in."));
        return;
      }

      const result = await deps.transferSelections("central", selections, {
        scopeHints: availableTargets,
        repoContext: { repo: selected.name }
      });
      await deps.upsertHydratedWorkspaceGroup(selected.name, selected.id, availableTargets);
      await deps.refresh();
      vscode.window.showInformationMessage(
        deps.tr("Added skills to workspace: copied {0} · deleted {1} · unchanged {2}", String(result.copied), String(result.deleted), String(result.unchanged))
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
        vscode.window.showWarningMessage(deps.tr("There are no Central skills to bring to Workspace."));
        return;
      }

      const sourcePick = await vscode.window.showQuickPick(
        centralAssets.map((asset) => ({
          label: `${asset.tool}/${asset.skillName}`,
          description: deps.statusLabelForWizard(asset.status),
          detail: `${asset.rootRelativePath} · ${deps.tr("files")} ${asset.fileCount} · ${deps.tr("warnings")} ${asset.warnings.length}${asset.updatedAt ? ` · ${asset.updatedAt}` : ""}`,
          value: asset
        })),
        {
          title: deps.tr("Search Central Skills to Bring"),
          placeHolder: deps.tr("Search by skill name, agent, or path."),
          matchOnDescription: true,
          matchOnDetail: true
        }
      );
      if (!sourcePick) return;

      const agents = deps.agents();
      const targetPick = await vscode.window.showQuickPick(
        [
          {
            label: deps.tr("All Agents"),
            description: deps.tr("Install into every configured workspace agent folder"),
            detail: agents.map((agent) => agent === "agents" ? ".agents" : `.${agent}`).join(", "),
            value: "all" as const
          },
          ...agents.map((agent) => ({
            label: agent === "agents" ? ".agents" : `.${agent}`,
            description: deps.tr("Workspace target agent folder"),
            detail: path.join(deps.workspacePath(), deps.getWritableSkillRoot("", agent, "workspace")),
            value: agent
          }))
        ],
        {
          title: deps.tr("Choose Target Agent Folder"),
          placeHolder: deps.tr("Choose the workspace agent folder to receive this skill."),
          matchOnDescription: true,
          matchOnDetail: true
        }
      );
      if (!targetPick) return;

      const sourceRoot = deps.getSkillRoot(deps.centralRepoPath(), sourcePick.value.tool, "central");
      const sourceAbs = path.join(sourceRoot, sourcePick.value.rootRelativePath);
      if (!(await deps.exists(path.join(sourceAbs, "SKILL.md")))) {
        vscode.window.showErrorMessage(deps.tr("Central skill is missing SKILL.md: {0}/{1}", String(sourcePick.value.tool), String(sourcePick.value.rootRelativePath)));
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
          deps.tr("{0} target(s) already contain {1}. Update them with Central {2}/{3}?", String(existingTargets.length), String(sourcePick.value.rootRelativePath), String(sourcePick.value.tool), String(sourcePick.value.rootRelativePath)),
          { modal: true },
          deps.tr("Update")
        );
        if (ok !== deps.tr("Update")) return;
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
      const targetLabel = targetPick.value === "all" ? deps.tr("all agents ({0})", String(targetInfos.length)) : targetPick.value;
      vscode.window.showInformationMessage(
        deps.tr("Installed: Central {0}/{1} to Workspace {2}", String(sourcePick.value.tool), String(sourcePick.value.skillName), String(targetLabel))
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
        vscode.window.showErrorMessage(deps.tr("Bundled skill-manager skill was not found: {0}", String(sourceAbs)));
        return;
      }

      const agents = deps.agents();
      const targetPick = await vscode.window.showQuickPick(
        [
          {
            label: deps.tr("All Agents"),
            description: deps.tr("Install into every configured workspace agent folder"),
            detail: agents.map((agent) => agent === "agents" ? ".agents" : `.${agent}`).join(", "),
            value: "all" as const
          },
          ...agents.map((agent) => ({
            label: agent === "agents" ? ".agents" : `.${agent}`,
            description: deps.tr("Workspace target agent folder"),
            detail: path.join(deps.workspacePath(), deps.getWritableSkillRoot("", agent, "workspace")),
            value: agent
          }))
        ],
        {
          title: deps.tr("Install Skill Manager Helper"),
          placeHolder: deps.tr("Choose the workspace agent folder that will receive the skill-manager skill."),
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
          deps.tr("{0} target(s) already contain {1}. Update them with the bundled skill-manager content?", String(existingTargets.length), String(deps.bundledSkillManagerRelativePath)),
          { modal: true },
          deps.tr("Update")
        );
        if (ok !== deps.tr("Update")) return;
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
      const targetLabel = targetPick.value === "all" ? deps.tr("all agents ({0})", String(targetInfos.length)) : targetPick.value;
      vscode.window.showInformationMessage(
        deps.tr("Installed: bundled skill-manager to Workspace {0}", String(targetLabel))
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
        vscode.window.showWarningMessage(deps.tr("There are no Central skills to save as a project preset."));
        return;
      }
      const selected = await vscode.window.showQuickPick(
        centralAssets.map((asset) => ({
          label: `${asset.tool}/${asset.skillName}`,
          description: deps.statusLabelForWizard(asset.status),
          detail: `${asset.rootRelativePath} · ${deps.tr("files")} ${asset.fileCount} · ${deps.tr("warnings")} ${asset.warnings.length}`,
          value: asset
        })),
        {
          title: deps.tr("Choose Central Skills for the Project Preset"),
          canPickMany: true,
          matchOnDescription: true,
          matchOnDetail: true
        }
      );
      if (!selected || selected.length === 0) return;

      const name = await vscode.window.showInputBox({
        title: deps.tr("Project Preset Name"),
        prompt: deps.tr("Example: personal-default, frontend-project, langgraph-project"),
        validateInput: (value) => value.trim() ? null : deps.tr("Enter a preset name."),
        ignoreFocusOut: true
      });
      if (!name?.trim()) return;
      const description = await vscode.window.showInputBox({
        title: deps.tr("Project Preset Description"),
        prompt: deps.tr("Optional. Describe which projects this preset is useful for so it is easier to find later."),
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
          deps.tr("A project preset with this name already exists: {0}. Replace it with this selection?", String(previous.name)),
          { modal: true },
          deps.tr("Replace")
        );
        if (ok !== deps.tr("Replace")) return;
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
      vscode.window.showInformationMessage(deps.tr("Project preset saved: {0} ({1} skills)", String(preset.name), String(preset.targets.length)));
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
