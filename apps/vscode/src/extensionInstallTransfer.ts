import { promises as fs } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { copyNode } from "./extensionSupport";
import {
  buildGroupTargetsFromNames,
  collectSkillFolderSyncTargets,
  extractInstalledSkillFolderNames,
  getUniqueTargetTools,
  inferNewSkillFolderNames
} from "./installGrouping";
import { getWritableSkillRoot } from "./skillPaths";
import { parseNpxSkillsAddCommand } from "./npxSkillsCommand";
import { ALL_AGENTS, type SelectionGroup, type SkillFile, type SkillSelection, type SkillTreeNode, type ToolType, type TransferPlan, type TransferPlanItem } from "./types";

type TreeSide = "workspace" | "central";
type TranslationFn = (message: string, ...args: Array<string | number | boolean>) => string;
type TransferScopeHint = { tool: ToolType; relativePath: string; kind: "file" | "folder" };
type TransferPlanOptions = Pick<TransferPlan, "groupContext" | "repoContext" | "scopeContext"> & { scopeHints?: TransferScopeHint[] };
export type NpxInstallPreset = {
  repoUrl: string;
  skills: string[];
  cwd?: string;
  tool?: ToolType;
  tools?: ToolType[];
  skipCommandConfirm?: boolean;
  skipPostInstallSyncPrompt?: boolean;
};

export function createInstallTransferTools(args: {
  tr: TranslationFn;
  toUserError: (error: unknown) => string;
  handleError: (error: unknown) => Promise<void>;
  refresh: () => Promise<void>;
  output: vscode.OutputChannel;
  state: {
    workspacePath: string;
    centralRepoPath: string;
    agents: ToolType[];
    groups: SelectionGroup[];
    workspaceSelection: SkillTreeNode[];
    centralSelection: SkillTreeNode[];
    workspaceSkills: SkillFile[];
    centralSkills: SkillFile[];
  };
  workspaceProvider: {
    getSelected: () => SkillTreeNode | null | undefined;
    getAllSelections: () => SkillSelection[];
  };
  centralProvider: {
    getSelected: () => SkillTreeNode | null | undefined;
    getAllSelections: () => SkillSelection[];
  };
  exists: (targetPath: string) => Promise<boolean>;
  parseSkillInputs: (value: string) => string[];
  formatCommandForDisplay: (command: string, args: string[]) => string;
  loadSkillFilesBySide: (side: TreeSide, workspacePath: string, centralRepoPath: string, agents: ToolType[]) => Promise<SkillFile[]>;
  runSkillsAdd: (cwd: string, repo: string, skills: string[], tools?: ToolType[]) => Promise<{ ok: boolean; command: string; stdout: string; stderr: string }>;
  resolveSelectedAgentToolForSide: (side: TreeSide, node?: SkillTreeNode) => ToolType | undefined;
  formatAgentFolderLabel: (tool: ToolType) => string;
  getAutoSyncWorkspaceAgents: () => ToolType[];
  syncWorkspaceAgentFoldersToCentral: (
    targets: Array<{ tool: ToolType; skillFolderRel: string }>,
    reason: "manual" | "auto"
  ) => Promise<{ syncedFolders: number; copied: number; deleted: number; mirroredGroups: number; unchanged: number; centralFolders: number; centralFiles: number; skippedMissingSkillMd: number }>;
  normalizeRepoName: (raw: string) => string;
  persistGroups: (next: SelectionGroup[], selectedGroupId: string | null) => Promise<void>;
  targetsToSelections: (files: SkillFile[], targets: SelectionGroup["targets"]) => SkillSelection[];
  buildTransferPlan: (side: TreeSide, selections: SkillSelection[], options?: TransferPlanOptions) => Promise<TransferPlan>;
  openTransferManagerTab: (
    plan: TransferPlan,
    rebuildPlan: () => Promise<TransferPlan>,
    expandPlan?: () => Promise<TransferPlan>
  ) => Promise<TransferPlan | null>;
  applyTransferPlan: (
    items: TransferPlanItem[],
    sourceProjectPath: string | null
  ) => Promise<{ copied: number; deleted: number; unchanged: number; failed: number }>;
  collectScopeHintsFromPlanItems: (items: TransferPlanItem[]) => TransferScopeHint[];
  collapseLibraryTargets: (targets: TransferScopeHint[]) => TransferScopeHint[];
  collectAffectedGroupIdsForScopeHints: (side: TreeSide, scopeHints: TransferScopeHint[]) => string[];
  mirrorGroupToOtherSide: (group: SelectionGroup, options?: { requireExistingTargets?: boolean }) => Promise<boolean>;
  getSkillFolderRelativePath: (relativePath: string) => string | null;
  normalizeRel: (value: string | undefined | null) => string;
}): {
  installSkills: (node?: SkillTreeNode) => Promise<void>;
  installSkillsForSide: (side: TreeSide) => Promise<void>;
  installSkillsCommandForSide: (side: TreeSide) => Promise<void>;
  installNpxRepoForSide: (side: TreeSide, preset: NpxInstallPreset) => Promise<boolean>;
  resolveInstallSide: (node?: SkillTreeNode) => Promise<TreeSide | undefined>;
  transferSelections: (
    side: TreeSide,
    selections: SkillSelection[],
    options?: TransferPlanOptions
  ) => Promise<{ copied: number; deleted: number; unchanged: number; failed: number; appliedScopeHints: TransferScopeHint[]; affectedGroupIds: string[] }>;
  resolveCommandNodes: (side: TreeSide, node?: SkillTreeNode) => SkillTreeNode[];
  pickEmptyTransferScope: (side: TreeSide) => Promise<"all" | "cancel">;
  buildTransferScopeContext: (input: {
    side: TreeSide;
    nodes: SkillTreeNode[];
    hints: TransferScopeHint[] | undefined;
    selectedGroup: SelectionGroup | undefined;
    isWholeTreeScope: boolean;
  }) => TransferPlan["scopeContext"];
  formatTransferScopeLabel: (hints: TransferScopeHint[]) => string;
  getAllSelectionsForSide: (side: TreeSide) => SkillSelection[];
} {
  const getAllSelectionsForSide = (side: TreeSide): SkillSelection[] =>
    side === "workspace" ? args.workspaceProvider.getAllSelections() : args.centralProvider.getAllSelections();

  const resolveInstallSide = async (node?: SkillTreeNode): Promise<TreeSide | undefined> => {
    if (node) {
      const workspaceSelected = args.state.workspaceSelection.some((item) => item.key === node.key)
        || args.workspaceProvider.getSelected()?.key === node.key;
      if (workspaceSelected) return "workspace";
      const centralSelected = args.state.centralSelection.some((item) => item.key === node.key)
        || args.centralProvider.getSelected()?.key === node.key;
      if (centralSelected) return "central";
    }
    if (args.state.workspaceSelection.length > 0 && args.state.centralSelection.length === 0) return "workspace";
    if (args.state.centralSelection.length > 0 && args.state.workspaceSelection.length === 0) return "central";
    const pick = await vscode.window.showQuickPick(
      [
        { label: args.tr("Workspace"), value: "workspace" as TreeSide },
        { label: args.tr("Central"), value: "central" as TreeSide }
      ],
      { title: args.tr("Select Where to Run npx skills add") }
    );
    return pick?.value;
  };

  const transferSelections = async (
    side: TreeSide,
    selections: SkillSelection[],
    options?: TransferPlanOptions
  ): Promise<{ copied: number; deleted: number; unchanged: number; failed: number; appliedScopeHints: TransferScopeHint[]; affectedGroupIds: string[] }> => {
    const plan = await args.buildTransferPlan(side, selections, options);
    if (plan.items.length === 0) return { copied: 0, deleted: 0, unchanged: 0, failed: 0, appliedScopeHints: [], affectedGroupIds: [] };
    const resolved = await args.openTransferManagerTab(
      plan,
      async () => await args.buildTransferPlan(side, selections, options),
      plan.scopeContext?.expandable
        ? async () => await args.buildTransferPlan(side, getAllSelectionsForSide(side), {
            scopeContext: {
              type: "all",
              label: side === "workspace" ? args.tr("All Workspace") : args.tr("All Central"),
              count: 0,
              expandable: false
            }
          })
        : undefined
    );
    if (!resolved) return { copied: 0, deleted: 0, unchanged: 0, failed: 0, appliedScopeHints: [], affectedGroupIds: [] };
    const appliedScopeHints = args.collectScopeHintsFromPlanItems(resolved.items);
    const requestedScopeHints = options?.scopeHints ? args.collapseLibraryTargets(options.scopeHints) : [];
    const affectedGroupIds = appliedScopeHints.length > 0
      ? args.collectAffectedGroupIdsForScopeHints(side, appliedScopeHints)
      : requestedScopeHints.length > 0
        ? args.collectAffectedGroupIdsForScopeHints(side, requestedScopeHints)
        : [];
    const result = await args.applyTransferPlan(resolved.items, side === "workspace" ? args.state.workspacePath : null);
    if (result.failed > 0) {
      vscode.window.showWarningMessage(args.tr("Apply result: copied {0}, deleted {1}, unchanged {2}, failed {3}", String(result.copied), String(result.deleted), String(result.unchanged), String(result.failed)));
    }
    return { ...result, appliedScopeHints, affectedGroupIds };
  };

  const resolveCommandNodes = (side: TreeSide, node?: SkillTreeNode): SkillTreeNode[] => {
    const selection = side === "workspace" ? args.state.workspaceSelection : args.state.centralSelection;
    const provider = side === "workspace" ? args.workspaceProvider : args.centralProvider;
    const current = provider.getSelected();
    if (!node) {
      if (!current) return selection;
      return selection.some((item) => item.key === current.key) ? selection : [current];
    }
    return selection.some((item) => item.key === node.key) ? selection : [node];
  };

  const pickEmptyTransferScope = async (side: TreeSide): Promise<"all" | "cancel"> => {
    const direction = side === "workspace" ? args.tr("Save to Central") : args.tr("Bring to Workspace");
    const pick = await vscode.window.showQuickPick(
      [
        {
          label: args.tr("Review All Visible Skills Before Applying"),
          description: direction,
          detail: args.tr("Only when nothing is selected, this opens all visible skills in the review screen."),
          value: "all" as const
        },
        {
          label: args.tr("Cancel"),
          description: args.tr("Select a skill or folder in the tree first"),
          detail: args.tr("To apply specific items, right-click or select them in the tree and run this again."),
          value: "cancel" as const
        }
      ],
      {
        title: args.tr("Select Apply Scope"),
        matchOnDescription: true,
        matchOnDetail: true
      }
    );
    return pick?.value ?? "cancel";
  };

  const pickNpxTargetAgents = async (side: TreeSide): Promise<ToolType[] | undefined> => {
    const picked = await vscode.window.showQuickPick(
      args.state.agents.map((tool) => ({
        label: args.formatAgentFolderLabel(tool),
        description: side === "workspace"
          ? args.tr("Save installed skills in this workspace agent folder.")
          : args.tr("Save installed skills in this Central agent folder."),
        value: tool
      })),
      {
        canPickMany: true,
        title: args.tr("Choose target agent for npx skills"),
        placeHolder: args.tr("Pick one or more places where the installed skill folders should be saved.")
      }
    );
    return picked && picked.length > 0 ? picked.map((item) => item.value) : undefined;
  };

  const formatTransferScopeLabel = (hints: TransferScopeHint[]): string => {
    const preview = hints.slice(0, 3).map((hint) => {
      const rel = args.normalizeRel(hint.relativePath);
      const skillFolder = args.getSkillFolderRelativePath(rel);
      return `${hint.tool}/${skillFolder ?? rel}`;
    });
    const label = preview.join(", ");
    return hints.length > preview.length
      ? args.tr("{0} and {1} more", String(label), String(hints.length - preview.length))
      : label;
  };

  const buildTransferScopeContext = (input: {
    side: TreeSide;
    nodes: SkillTreeNode[];
    hints: TransferScopeHint[] | undefined;
    selectedGroup: SelectionGroup | undefined;
    isWholeTreeScope: boolean;
  }): TransferPlan["scopeContext"] => {
    if (input.selectedGroup) {
      return { type: "group", label: args.tr("Group: {0}", String(input.selectedGroup.name)), count: input.selectedGroup.targets.length, expandable: false };
    }
    if (input.hints && input.hints.length > 0) {
      return { type: "selection", label: formatTransferScopeLabel(input.hints), count: input.hints.length, expandable: false };
    }
    if (input.isWholeTreeScope || input.nodes.some((node) => node.relativePath === "")) {
      return { type: "all", label: input.side === "workspace" ? args.tr("All Workspace") : args.tr("All Central"), count: 0, expandable: false };
    }
    if (input.nodes.length > 0) {
      return { type: "selection", label: input.nodes.map((node) => `${node.tool}/${node.label}`).join(", "), count: input.nodes.length, expandable: false };
    }
    return undefined;
  };

  const runInstallSkills = async (side: TreeSide, node?: SkillTreeNode, preset?: NpxInstallPreset): Promise<boolean> => {
      const selectedFromContext = args.resolveSelectedAgentToolForSide(side, node);
      const selectedTools = preset?.tools?.length
        ? preset.tools
        : preset?.tool
          ? [preset.tool]
          : selectedFromContext
            ? [selectedFromContext]
            : await pickNpxTargetAgents(side);
      if (!selectedTools || selectedTools.length === 0) return false;
      const primaryTool = selectedTools[0] as ToolType;
      const repoInput = preset?.repoUrl ?? await vscode.window.showInputBox({
        title: side === "workspace" ? "Workspace: npx skills add" : "Central: npx skills add",
        prompt: args.tr("Enter the skill repository URL to install"),
        value: "https://github.com/vercel-labs/skills",
        ignoreFocusOut: true
      });
      const repo = repoInput?.trim();
      if (!repo) return false;
      const skillsInput = preset ? preset.skills.join(", ") : await vscode.window.showInputBox({
        title: args.tr("Skill Names to Install"),
        prompt: args.tr("Enter names separated by commas. Leave empty for all (*)."),
        value: "*",
        ignoreFocusOut: true
      });
      if (skillsInput === undefined) return false;
      const skills = preset ? preset.skills : args.parseSkillInputs(skillsInput);
      const sideBasePath = side === "workspace" ? args.state.workspacePath : args.state.centralRepoPath;
      const defaultCwd = sideBasePath;
      const cwdInput = preset?.cwd ?? defaultCwd;
      if (cwdInput === undefined) return false;
      const cwd = cwdInput.trim() || defaultCwd;
      if (!(await args.exists(cwd))) {
        vscode.window.showErrorMessage(args.tr("Working directory not found: {0}", String(cwd)));
        return false;
      }
      const stat = await fs.stat(cwd).catch(() => null);
      if (!stat?.isDirectory()) {
        vscode.window.showErrorMessage(args.tr("Enter a directory path: {0}", String(cwd)));
        return false;
      }
      const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), `skill-bridge-npx-${side}-`));
      const commandCwd = stagingDir;
      const targetSkillRoots = selectedTools.map((tool) => ({
        tool,
        skillRoot: path.join(getWritableSkillRoot(sideBasePath, tool, side), "skills")
      }));
      const commandArgs = buildSkillsAddCommandArgs(repo, skills, selectedTools);
      const runLabel = args.tr("Run Command");
      if (!preset?.skipCommandConfirm) {
        const targetAgentLabel = selectedTools.map((tool) => args.formatAgentFolderLabel(tool)).join(", ");
        const saveLocations = targetSkillRoots.map((item) => `${args.formatAgentFolderLabel(item.tool)}: ${item.skillRoot}`).join("\n");
        const confirm = await vscode.window.showWarningMessage(
          args.tr("Run this command?\n\nTarget agents: {0}\nSave locations:\n{1}\nWorking directory: {2}\nCommand: {3}", String(targetAgentLabel), String(saveLocations), String(commandCwd), String(args.formatCommandForDisplay("npx", commandArgs))),
          { modal: true },
          runLabel
        );
        if (confirm !== runLabel) {
          if (stagingDir) await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
          return false;
        }
      }

      const beforeFiles = await args.loadSkillFilesBySide(side, args.state.workspacePath, args.state.centralRepoPath, args.state.agents);
      const result = await args.runSkillsAdd(commandCwd, repo, skills, selectedTools);
      const text = [result.command, result.stdout, result.stderr].filter(Boolean).join("\n");
      args.output.appendLine(`[skills:add] side=${side} targets=${selectedTools.join(",")} cwd=${commandCwd}`);
      args.output.appendLine(text || "(no output)");
      args.output.show(true);
      if (!result.ok) {
        if (stagingDir) await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
        vscode.window.showErrorMessage(args.tr("npx skills add failed. Check the Output panel."));
        return false;
      }

      const stagedNames = await listStagedSkillNames(stagingDir, primaryTool);
      const installedNames = extractInstalledSkillFolderNames(`${result.stdout}\n${result.stderr}`);
      const presetNames = preset?.skills.filter((skill) => skill !== "*") ?? [];
      const targetNames = stagedNames.length > 0 ? stagedNames : installedNames.length > 0 ? installedNames : presetNames;
      const copiedTools: ToolType[] = [];
      for (const target of targetSkillRoots) {
        const copied = await copyStagedSkillsToTarget(stagingDir, target.skillRoot, targetNames, target.tool, !preset?.skipCommandConfirm, args.tr);
        if (!copied) {
          await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
          return false;
        }
        copiedTools.push(target.tool);
      }
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      await args.refresh();
      const afterFiles = await args.loadSkillFilesBySide(side, args.state.workspacePath, args.state.centralRepoPath, args.state.agents);
      const fallbackNames = inferNewSkillFolderNames(beforeFiles, afterFiles);
      const groupNames = targetNames.length > 0 ? targetNames : fallbackNames;
      const selectedToolSet = new Set<ToolType>(copiedTools);
      const rawTargets = buildGroupTargetsFromNames(afterFiles, groupNames).filter((target) => selectedToolSet.has(target.tool));
      const availableTools = getUniqueTargetTools(rawTargets);

      let groupingTool: ToolType | undefined = copiedTools.length === 1 ? copiedTools[0] : undefined;
      if (!groupingTool && availableTools.length === 1) groupingTool = availableTools[0];
      if (!groupingTool && selectedTools.length === 1 && availableTools.length > 1) {
        const picked = await vscode.window.showQuickPick(
          availableTools.map((tool) => ({
            label: args.formatAgentFolderLabel(tool),
            description: args.tr("Track this install as a group for this agent only."),
            value: tool
          })),
          {
            title: args.tr("Choose the agent for this installed skill group"),
            placeHolder: args.tr("A single npx install matched more than one agent. Pick the agent group to update.")
          }
        );
        groupingTool = picked?.value;
      }
      const targets = groupingTool ? rawTargets.filter((target) => target.tool === groupingTool) : rawTargets;
      if (targets.length === 0) {
        vscode.window.showWarningMessage(args.tr("Install completed, but no new skill folders were found to register as a group."));
        return false;
      }

      const repoKey = args.normalizeRepoName(repo);
      const now = new Date().toISOString();
      const generatedDescription = args.tr("Installed from {0}", String(repo));
      const existing = args.state.groups.find((group) =>
        group.side === side
        && group.meta?.repoKey === repoKey
        && (groupingTool ? (group.meta?.tool === groupingTool || group.targets[0]?.tool === groupingTool) : true)
      );

      let sourceGroup: SelectionGroup;
      if (existing) {
        const nextGroups = args.state.groups.map((group) => group.id !== existing.id ? group : {
          ...group,
          name: repoKey || group.name,
          description: group.description?.trim() ? group.description : generatedDescription,
          targets,
          meta: {
            ...group.meta,
            source: "npx" as const,
            tool: groupingTool ?? group.meta?.tool,
            repoKey,
            repoUrl: repo,
            lastInstalledAt: now,
            installCwd: cwd,
            installSkills: skills
          }
        });
        await args.persistGroups(nextGroups, existing.id);
        sourceGroup = nextGroups.find((group) => group.id === existing.id) ?? existing;
        vscode.window.showInformationMessage(args.tr("Install and group update complete: {0} ({1} skill(s))", String(repoKey), String(targets.length)));
      } else {
        const groupId = `${side}-${Date.now()}`;
        sourceGroup = {
          id: groupId,
          name: repoKey || "skills-installed",
          description: generatedDescription,
          side,
          targets,
          meta: {
            source: "npx",
            tool: groupingTool,
            repoKey,
            repoUrl: repo,
            lastInstalledAt: now,
            installCwd: cwd,
            installSkills: skills
          }
        };
        await args.persistGroups([...args.state.groups, sourceGroup], groupId);
        vscode.window.showInformationMessage(args.tr("Install and group creation complete: {0} ({1} skill(s))", String(sourceGroup.name), String(targets.length)));
      }
      if (preset?.skipPostInstallSyncPrompt) return true;

      if (side === "workspace") {
        const autoSyncAgents = new Set(args.getAutoSyncWorkspaceAgents());
        const syncFolders = collectSkillFolderSyncTargets(sourceGroup.targets, groupingTool);
        const shouldAutoSync = syncFolders.length > 0 && syncFolders.every((entry) => autoSyncAgents.has(entry.tool));
        if (shouldAutoSync) {
          const summary = await args.syncWorkspaceAgentFoldersToCentral(syncFolders, "manual");
          const syncedToolLabel = groupingTool ? args.formatAgentFolderLabel(groupingTool) : args.tr("workspace agent");
          const skippedSuffix = summary.skippedMissingSkillMd > 0
            ? args.tr(" · skipped missing SKILL.md {0}", String(summary.skippedMissingSkillMd))
            : "";
          vscode.window.showInformationMessage(args.tr("Install, group, and auto save complete: {0} · folders {1} · copied {2} · deleted {3} · groups {4} · central {5} folder(s), {6} file(s){7}", String(syncedToolLabel), String(summary.syncedFolders), String(summary.copied), String(summary.deleted), String(summary.mirroredGroups), String(summary.centralFolders), String(summary.centralFiles), String(skippedSuffix)));
          return true;
        }
      }

      const copyLabel = side === "workspace" ? args.tr("Save to Central") : args.tr("Bring to Workspace");
      const shouldSync = await vscode.window.showInformationMessage(
        side === "workspace"
          ? args.tr("Save installed skills to the central library?")
          : args.tr("Copy installed skills to the workspace?"),
        copyLabel
      );
      if (shouldSync === copyLabel) {
        const selections = args.targetsToSelections(afterFiles, sourceGroup.targets);
        const transferResult = await transferSelections(side, selections, {
          groupContext: { id: sourceGroup.id, name: sourceGroup.name, side: sourceGroup.side },
          repoContext: { repo },
          scopeHints: sourceGroup.targets.map((target) => ({ ...target }))
        });
        const mirroredGroup = await args.mirrorGroupToOtherSide(sourceGroup, { requireExistingTargets: true });
        if (transferResult.copied + transferResult.deleted > 0 || mirroredGroup) {
          await args.refresh();
          vscode.window.showInformationMessage(args.tr("Installed skills applied: copied {0}, deleted {1}, unchanged {2}{3}", String(transferResult.copied), String(transferResult.deleted), String(transferResult.unchanged), String(mirroredGroup ? " · group applied" : "")));
        }
      }
      return true;
  };

  const installSkills = async (node?: SkillTreeNode): Promise<void> => {
    try {
      if (!args.state.workspacePath || !args.state.centralRepoPath) await args.refresh();
      const side = await resolveInstallSide(node);
      if (!side) return;
      await runInstallSkills(side, node);
    } catch (error) {
      await args.handleError(error);
    }
  };

  const installSkillsForSide = async (side: TreeSide): Promise<void> => {
    try {
      if (!args.state.workspacePath || !args.state.centralRepoPath) await args.refresh();
      await runInstallSkills(side);
    } catch (error) {
      await args.handleError(error);
    }
  };

  const installSkillsCommandForSide = async (side: TreeSide): Promise<void> => {
    try {
      if (!args.state.workspacePath || !args.state.centralRepoPath) await args.refresh();
      const command = await vscode.window.showInputBox({
        title: side === "workspace"
          ? args.tr("Workspace: Install from npx command")
          : args.tr("Central: Install from npx command"),
        prompt: args.tr("Paste a complete npx skills add command. The repository and --skill values will be imported safely."),
        value: "npx skills add https://github.com/vercel-labs/agent-browser --skill agent-browser",
        ignoreFocusOut: true
      });
      if (command === undefined) return;
      const parsed = parseNpxSkillsAddCommand(command);
      if (!parsed) {
        vscode.window.showErrorMessage(args.tr("Could not read that command. Use: npx skills add <repo> --skill <skill-name>"));
        return;
      }
      await runInstallSkills(side, undefined, {
        repoUrl: parsed.repoUrl,
        skills: parsed.skills
      });
    } catch (error) {
      await args.handleError(error);
    }
  };

  const installNpxRepoForSide = async (side: TreeSide, preset: NpxInstallPreset): Promise<boolean> => {
    try {
      if (!args.state.workspacePath || !args.state.centralRepoPath) await args.refresh();
      return await runInstallSkills(side, undefined, preset);
    } catch (error) {
      await args.handleError(error);
      return false;
    }
  };

  return {
    installSkills,
    installSkillsForSide,
    installSkillsCommandForSide,
    installNpxRepoForSide,
    resolveInstallSide,
    transferSelections,
    resolveCommandNodes,
    pickEmptyTransferScope,
    buildTransferScopeContext,
    formatTransferScopeLabel,
    getAllSelectionsForSide
  };
}

type StagedSkillFolder = {
  name: string;
  sourcePath: string;
};

async function listStagedSkillNames(stagingDir: string, preferredTool: ToolType): Promise<string[]> {
  const folders = await collectStagedSkillFolders(stagingDir, preferredTool);
  return folders.map((folder) => folder.name);
}

async function copyStagedSkillsToTarget(
  stagingDir: string,
  targetSkillRoot: string,
  targetNames: string[],
  preferredTool: ToolType,
  confirmOverwrite: boolean,
  tr: TranslationFn
): Promise<boolean> {
  const stagedFolders = await collectStagedSkillFolders(stagingDir, preferredTool);
  const stagedByName = new Map(stagedFolders.map((folder) => [folder.name, folder.sourcePath]));
  const names = targetNames.length > 0 ? targetNames : stagedFolders.map((folder) => folder.name);
  const existing: string[] = [];
  const copyPairs: Array<{ source: string; target: string }> = [];
  for (const name of names) {
    const source = stagedByName.get(name);
    if (!source) continue;
    const target = path.join(targetSkillRoot, name);
    if (await existsPath(target)) existing.push(name);
    copyPairs.push({ source, target });
  }
  if (copyPairs.length === 0) {
    vscode.window.showWarningMessage(tr("Install completed, but no staged skill folders were found."));
    return false;
  }
  if (existing.length > 0 && confirmOverwrite) {
    const ok = await vscode.window.showWarningMessage(
      tr("Replace {0} existing skill folder(s) in the selected agent?\n\n{1}", String(existing.length), String(existing.slice(0, 8).join(", "))),
      { modal: true },
      tr("Replace")
    );
    if (ok !== tr("Replace")) return false;
  }
  await fs.mkdir(targetSkillRoot, { recursive: true });
  for (const pair of copyPairs) {
    await fs.rm(pair.target, { recursive: true, force: true });
    await copyNode(pair.source, pair.target);
  }
  return true;
}

async function collectStagedSkillFolders(stagingDir: string, preferredTool: ToolType): Promise<StagedSkillFolder[]> {
  const folders = new Map<string, StagedSkillFolder>();
  for (const relativeRoot of getStagedSkillRootCandidates(preferredTool)) {
    const skillRoot = path.join(stagingDir, ...relativeRoot.split("/"));
    const entries = await fs.readdir(skillRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (folders.has(entry.name)) continue;
      const sourcePath = path.join(skillRoot, entry.name);
      const stat = await fs.stat(sourcePath).catch(() => null);
      if (!stat?.isDirectory()) continue;
      if (!(await existsPath(path.join(sourcePath, "SKILL.md")))) continue;
      folders.set(entry.name, { name: entry.name, sourcePath });
    }
  }
  return [...folders.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function getStagedSkillRootCandidates(preferredTool: ToolType): string[] {
  const tools = [preferredTool, ...ALL_AGENTS.filter((tool) => tool !== preferredTool)];
  const roots = tools.flatMap((tool) => {
    const dotted = tool === "agents" ? ".agents" : `.${tool}`;
    return [`${dotted}/skills`, `${tool}/skills`];
  });
  return [...new Set([...roots, "skills"])];
}

function buildSkillsAddCommandArgs(repo: string, skills: string[], tools: ToolType[]): string[] {
  const skillArgs = skills.flatMap((skill) => ["--skill", skill]);
  const cliAgents = [...new Set(tools.map(toSkillsCliAgentName))];
  const agentArgs = cliAgents.length > 0 ? ["--agent", ...cliAgents] : [];
  return ["-y", "skills", "add", repo, ...skillArgs, ...agentArgs, "--copy", "--yes"];
}

function toSkillsCliAgentName(tool: ToolType): string {
  if (tool === "claude") return "claude-code";
  if (tool === "gemini") return "gemini-cli";
  if (tool === "agents") return "*";
  return tool;
}

async function existsPath(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
