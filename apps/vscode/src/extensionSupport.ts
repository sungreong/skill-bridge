import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import { ALL_AGENTS, type GroupTarget, type InstructionFile, type ProjectPreset, type SelectionGroup, type SkillAssetTreeMeta, type SkillAssetWarning, type SkillFile, type SkillSelection, type SkillTreeFilterMode, type SkillTreeNode, type ToolType } from "./types";
import { formatHostPathIssue, resolveHostPath } from "./centralPath";
import { INSTRUCTION_ROOT, INSTRUCTION_RULE_DIRS, NESTED_INSTRUCTION_FILES, resolveSkillPath, ROOT_INSTRUCTION_FILES } from "./skillPaths";
import {
  GROUP_MARKDOWN_FILE,
  GROUP_STORE_FILE,
  LEGACY_GROUP_STORE_FILE,
  SKILL_BRIDGE_STATE_DIR
} from "./storagePaths";
import type { UiLanguage } from "./uiLanguage";
import { SkillTreeProvider } from "./views/skillTreeProvider";

export type SourceTab = "all" | ToolType[];

export function collectSkillFolderNamesForTool(items: SkillFile[], tool: ToolType): string[] {
  const names = new Set<string>();
  for (const item of items) {
    if (item.tool !== tool) continue;
    const skillFolderRel = getSkillFolderRelativePath(item.relativePath);
    if (skillFolderRel) names.add(skillFolderRel);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

export function uniqueSelections(items: SkillSelection[]): SkillSelection[] {
  const map = new Map<string, SkillSelection>();
  for (const item of items) {
    map.set(`${item.tool}:${item.relativePath}`, item);
  }
  return [...map.values()];
}

export function buildGroupTargetsFromNodes(nodes: SkillTreeNode[]): GroupTarget[] {
  const out: GroupTarget[] = [];
  const visit = (node: SkillTreeNode): void => {
    const skillFolderRel = getSkillFolderRelativePath(node.relativePath);
    if (skillFolderRel) {
      out.push({
        kind: "folder",
        tool: node.tool,
        relativePath: skillFolderRel
      });
      return;
    }
    for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return dedupeGroupTargets(out);
}

export function buildTransferScopeHintsFromNodes(nodes: SkillTreeNode[]): Array<{ tool: ToolType; relativePath: string; kind: "file" | "folder" }> {
  const hints = new Map<string, { tool: ToolType; relativePath: string; kind: "file" | "folder" }>();
  for (const node of nodes) {
    if (!node.relativePath || !isManagedSkillPath(node.relativePath)) continue;
    const key = `${node.tool}:${node.relativePath}`;
    const next = {
      tool: node.tool,
      relativePath: node.relativePath,
      kind: node.kind === "folder" ? "folder" as const : "file" as const
    };
    const prev = hints.get(key);
    if (!prev || next.kind === "folder") {
      hints.set(key, next);
    }
  }
  return [...hints.values()];
}

export function dedupeGroupTargets(targets: GroupTarget[]): GroupTarget[] {
  const unique = new Map<string, GroupTarget>();
  for (const target of targets) {
    const skillFolderRel = getSkillFolderRelativePath(target.relativePath);
    if (!skillFolderRel) continue;
    unique.set(`${target.tool}:${skillFolderRel}`, {
      kind: "folder",
      tool: target.tool,
      relativePath: skillFolderRel
    });
  }
  return [...unique.values()].sort((a, b) => a.tool.localeCompare(b.tool) || a.relativePath.localeCompare(b.relativePath));
}

export function targetsToSelections(files: SkillFile[], targets: GroupTarget[]): SkillSelection[] {
  const selections = new Map<string, SkillSelection>();
  for (const target of targets) {
    if (!isManagedSkillPath(target.relativePath)) continue;
    if (target.kind === "file") {
      selections.set(`${target.tool}:${target.relativePath}`, { tool: target.tool, relativePath: target.relativePath });
      continue;
    }
    const prefix = target.relativePath;
    for (const file of files) {
      if (file.tool !== target.tool) continue;
      if (file.relativePath === prefix || file.relativePath.startsWith(`${prefix}/`)) {
        selections.set(`${file.tool}:${file.relativePath}`, { tool: file.tool, relativePath: file.relativePath });
      }
    }
  }
  return [...selections.values()];
}

export function pruneGroupsByCurrentSkills(
  groups: SelectionGroup[],
  workspaceSkills: SkillFile[],
  centralSkills: SkillFile[]
): { groups: SelectionGroup[]; removedGroups: number } {
  const next: SelectionGroup[] = [];
  let removedGroups = 0;

  for (const group of groups) {
    const files = group.side === "workspace" ? workspaceSkills : centralSkills;
    const valid = group.targets.every((target) => targetExistsInFiles(target, files));
    if (!valid) {
      removedGroups += 1;
      continue;
    }
    next.push(group);
  }

  return { groups: next, removedGroups };
}

export function targetExistsInFiles(target: GroupTarget, files: SkillFile[]): boolean {
  if (!isManagedSkillPath(target.relativePath)) return false;
  if (target.kind === "file") {
    return files.some((file) => file.tool === target.tool && file.relativePath === target.relativePath);
  }

  const prefix = target.relativePath;
  return files.some((file) => {
    if (file.tool !== target.tool) return false;
    return file.relativePath === prefix || file.relativePath.startsWith(`${prefix}/`);
  });
}

export function normalizeRel(value: string | undefined | null): string {
  if (!value) return "";
  return value.replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

export function getSkillFolderRelativePath(value: string): string | null {
  const normalized = normalizeRel(value);
  const parts = normalized.split("/").filter(Boolean);
  const skillsIndex = parts.indexOf("skills");
  if (skillsIndex < 0) return null;
  const skillName = parts[skillsIndex + 1];
  if (!skillName) return null;
  return `skills/${skillName}`;
}

export function isSkillMdRelativePath(value: string): boolean {
  const normalized = normalizeRel(value);
  return /(^|\/)SKILL\.md$/i.test(normalized);
}

export function isEditableSkillTextPath(relativePath: string): boolean {
  const ext = path.extname(relativePath).toLowerCase();
  if (!ext) return true;
  return new Set([
    ".md", ".txt", ".json", ".yaml", ".yml", ".js", ".ts", ".tsx", ".jsx", ".sh", ".ps1", ".toml", ".ini", ".cfg", ".env"
  ]).has(ext);
}

export function hasSensitiveLikeText(text: string): boolean {
  const rules = [
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
    /https?:\/\/[^\s]+/i,
    /\b\d{8,}\b/,
    /\b(?:\d[ -]*?){13,19}\b/,
    /\b\d{6}-?[1-4]\d{6}\b/,
    /\b[a-z0-9-]+\.(?:internal|corp|local)\b/i
  ];
  return rules.some((rule) => rule.test(text));
}

export function findBrokenMarkdownLinkWarnings(
  text: string,
  fileRelativePath: string,
  rootRelativePath: string,
  knownFiles: Set<string>
): SkillAssetWarning[] {
  const warnings: SkillAssetWarning[] = [];
  const parent = path.posix.dirname(fileRelativePath);
  const regex = /\[[^\]]+\]\(([^)]+)\)/g;
  let match = regex.exec(text);
  while (match) {
    const rawTarget = (match[1] ?? "").trim().replace(/^['"]|['"]$/g, "");
    const target = rawTarget.split("#")[0]?.trim() ?? "";
    if (target && !/^(https?:|mailto:|#|data:)/i.test(target) && !target.includes("://")) {
      const normalizedTarget = normalizeRel(path.posix.normalize(path.posix.join(parent, target)));
      if (normalizedTarget.startsWith(`${rootRelativePath}/`) && !knownFiles.has(normalizedTarget.toLowerCase())) {
        warnings.push({
          code: "broken-reference",
          severity: "warning",
          message: `Relative link target is not inside the skill folder: ${target}`,
          relativePath: fileRelativePath
        });
      }
    }
    match = regex.exec(text);
  }
  return warnings;
}

export function dedupeTreeWarnings(warnings: SkillAssetWarning[]): SkillAssetWarning[] {
  const unique = new Map<string, SkillAssetWarning>();
  for (const warning of warnings) {
    unique.set(`${warning.code}:${warning.relativePath ?? ""}:${warning.message}`, warning);
  }
  return [...unique.values()];
}

export function getSkillInnerRelativePath(relativePath: string): string {
  const normalized = normalizeRel(relativePath);
  const folder = getSkillFolderRelativePath(normalized);
  if (!folder) return normalized;
  return normalized.slice(folder.length).replace(/^\/+/, "");
}

export function enforceSkillMdInventory(files: SkillFile[]): {
  validFiles: SkillFile[];
  missingFolders: Array<{ tool: ToolType; relativePath: string }>;
} {
  const folderSet = new Set<string>();
  const skillMdSet = new Set<string>();
  for (const file of files) {
    const skillFolderRel = getSkillFolderRelativePath(file.relativePath);
    if (!skillFolderRel) continue;
    const key = `${file.tool}:${skillFolderRel}`;
    folderSet.add(key);
    if (isSkillMdRelativePath(file.relativePath)) {
      skillMdSet.add(key);
    }
  }
  const validFiles = files.filter((file) => {
    const skillFolderRel = getSkillFolderRelativePath(file.relativePath);
    if (!skillFolderRel) return false;
    return skillMdSet.has(`${file.tool}:${skillFolderRel}`);
  });
  const missingFolders = [...folderSet]
    .filter((key) => !skillMdSet.has(key))
    .map((key) => {
      const sep = key.indexOf(":");
      const tool = key.slice(0, sep);
      const relativePath = key.slice(sep + 1);
      return { tool: tool as ToolType, relativePath };
    })
    .sort((a, b) => a.tool.localeCompare(b.tool) || a.relativePath.localeCompare(b.relativePath));
  return { validFiles, missingFolders };
}

export function isWithinPath(basePath: string, target: string): boolean {
  const base = normalizePathForContainment(basePath);
  const resolved = normalizePathForContainment(target);
  const relative = path.relative(base, resolved);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function isManagedSkillPath(value: string): boolean {
  const normalized = normalizeRel(value).toLowerCase();
  return normalized === "skills" || normalized.startsWith("skills/");
}

export function hasParentPathSegment(value: string): boolean {
  return normalizeRel(value).split("/").includes("..");
}

export function normalizePathForContainment(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function getNpxExecFileCandidates(): string[] {
  return process.platform === "win32" ? [] : ["npx"];
}

export function formatCommandForDisplay(command: string, args: string[]): string {
  return [command, ...args].map(quoteCommandArg).join(" ");
}

export function quoteCommandArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

export function containsWorkspaceSpecificPath(text: string): boolean {
  return /(?:[A-Za-z]:[\\/][^ \n\r\t]+|\/(?:Users|home|Volumes)\/[^ \n\r\t]+)/.test(text);
}

export function isToolType(value: string): value is ToolType {
  return (ALL_AGENTS as string[]).includes(value);
}

export function unwrapSkillNode(input: unknown): SkillTreeNode | undefined {
  if (!input || typeof input !== "object") return undefined;
  const direct = input as Partial<SkillTreeNode>;
  if (isSkillTreeNodeShape(direct)) return direct as SkillTreeNode;

  const wrapped = input as { node?: unknown };
  if (wrapped.node && typeof wrapped.node === "object" && isSkillTreeNodeShape(wrapped.node as Partial<SkillTreeNode>)) {
    return wrapped.node as SkillTreeNode;
  }
  return undefined;
}

export function isSkillTreeNodeShape(node: Partial<SkillTreeNode>): boolean {
  return typeof node.kind === "string"
    && typeof node.tool === "string"
    && typeof node.relativePath === "string"
    && typeof node.label === "string";
}

export function filterActionSelectionNodes(nodes: SkillTreeNode[]): SkillTreeNode[] {
  return nodes.filter((node) =>
    node.kind !== "toolSection"
    && node.kind !== "toolCommand"
    && node.kind !== "presetRoot"
    && node.kind !== "preset"
    && node.kind !== "groupRoot"
    && node.kind !== "groupTool"
    && node.kind !== "group"
  );
}

export async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function readDirEntriesOrEmpty(dirPath: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (isSkippableFileSystemError(error)) return [];
    throw error;
  }
}

export function isSkippableFileSystemError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = String((error as { code?: unknown }).code ?? "");
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP" || code === "EPERM" || code === "EACCES";
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  if (items.length === 1) return [await mapper(items[0] as T, 0)];

  const cappedLimit = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index] as T, index);
    }
  };

  await Promise.all(Array.from({ length: cappedLimit }, () => worker()));
  return results;
}

export async function copyNode(from: string, to: string): Promise<void> {
  const stat = await fs.stat(from);
  if (stat.isDirectory()) {
    await fs.mkdir(to, { recursive: true });
    const entries = await fs.readdir(from, { withFileTypes: true });
    await mapWithConcurrency(entries, 12, async (entry) => {
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      const childStat = await fs.stat(src).catch(() => null);
      if (!childStat) return;
      if (childStat.isDirectory()) {
        await copyNode(src, dst);
      } else if (childStat.isFile()) {
        await fs.copyFile(src, dst);
      }
    });
    return;
  }
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.copyFile(from, to);
}

export function toUserError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function createFileUriFromAbsolutePath(absolutePath: string): vscode.Uri {
  const resolved = resolveHostPath(absolutePath);
  if (!resolved.ok) {
    throw new Error(formatHostPathIssue(resolved.issue, absolutePath));
  }
  return vscode.Uri.file(resolved.absolutePath);
}

export async function openNodeIfFile(basePath: string, node: SkillTreeNode, mode: "workspace" | "central"): Promise<void> {
  if (node.kind !== "file" && node.kind !== "instructionFile") return;
  if (!basePath) return;
  try {
    const absolutePath = node.kind === "instructionFile"
      ? node.absolutePath
      : resolveSkillPath(basePath, node.tool, node.relativePath, mode);
    if (!absolutePath) return;
    const uri = createFileUriFromAbsolutePath(absolutePath);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true });
  } catch {
    // ignore open errors; selection must still work
  }
}

export function applyTabFilter(
  state: {
    activeTab: SourceTab;
    workspaceSkills: SkillFile[];
    centralSkills: SkillFile[];
    workspaceInstructions: InstructionFile[];
    centralInstructions: InstructionFile[];
    workspaceMissingSkillFolders: Array<{ tool: ToolType; relativePath: string }>;
    centralMissingSkillFolders: Array<{ tool: ToolType; relativePath: string }>;
    workspaceAssetMeta: Map<string, SkillAssetTreeMeta>;
    centralAssetMeta: Map<string, SkillAssetTreeMeta>;
    treeFilter: SkillTreeFilterMode;
    groups: SelectionGroup[];
    centralProjectPresets: ProjectPreset[];
    selectedGroupId: string | null;
  },
  workspaceProvider: SkillTreeProvider,
  centralProvider: SkillTreeProvider
): void {
  workspaceProvider.updateState({
    activeTab: state.activeTab,
    assetMeta: state.workspaceAssetMeta,
    filterMode: state.treeFilter,
    groups: state.groups,
    instructions: state.workspaceInstructions,
    missingSkillFolders: state.workspaceMissingSkillFolders,
    projectPresets: [],
    selectedGroupId: state.selectedGroupId,
    skills: state.workspaceSkills
  });
  centralProvider.updateState({
    activeTab: state.activeTab,
    assetMeta: state.centralAssetMeta,
    filterMode: state.treeFilter,
    groups: state.groups,
    instructions: state.centralInstructions,
    missingSkillFolders: state.centralMissingSkillFolders,
    projectPresets: state.centralProjectPresets,
    selectedGroupId: state.selectedGroupId,
    skills: state.centralSkills
  });
}

export function tabLabel(tab: SourceTab): string {
  if (tab === "all") return "all";
  const labels = tab.map((tool) => tool === "agents" ? ".agents" : `.${tool}`);
  if (labels.length === 1) return labels[0] ?? "all";
  return labels.join(", ");
}

export function sourceTabIncludes(tab: SourceTab, tool: ToolType): boolean {
  return tab === "all" || tab.includes(tool);
}

export function normalizeSourceTab(input: readonly string[] | undefined, agents: readonly ToolType[]): SourceTab {
  const allowed = new Set<ToolType>(agents);
  const selected = [...new Set((input ?? []).filter((item): item is ToolType => allowed.has(item as ToolType)))];
  if (selected.length === 0 || selected.length >= agents.length) return "all";
  return selected.sort((a, b) => agents.indexOf(a) - agents.indexOf(b));
}

export function sourceTabToVisibleAgents(tab: SourceTab, agents: readonly ToolType[]): ToolType[] {
  return tab === "all" ? [...agents] : tab.filter((tool) => agents.includes(tool));
}

export function createWatchers(workspacePath: string, centralPath: string): vscode.FileSystemWatcher[] {
  const patterns = [
    new vscode.RelativePattern(workspacePath, ".*/skills/**"),
    new vscode.RelativePattern(workspacePath, "*/skills/**"),
    new vscode.RelativePattern(centralPath, ".*/skills/**"),
    new vscode.RelativePattern(centralPath, "*/skills/**"),
    ...[...ROOT_INSTRUCTION_FILES, ...NESTED_INSTRUCTION_FILES].map((item) => new vscode.RelativePattern(workspacePath, item)),
    ...INSTRUCTION_RULE_DIRS.map((item) => new vscode.RelativePattern(workspacePath, `${item.dir}/**`)),
    new vscode.RelativePattern(centralPath, `${INSTRUCTION_ROOT}/**`),
    new vscode.RelativePattern(workspacePath, `${SKILL_BRIDGE_STATE_DIR}/${GROUP_STORE_FILE}`),
    new vscode.RelativePattern(centralPath, `${SKILL_BRIDGE_STATE_DIR}/${GROUP_STORE_FILE}`),
    new vscode.RelativePattern(workspacePath, `${SKILL_BRIDGE_STATE_DIR}/${GROUP_MARKDOWN_FILE}`),
    new vscode.RelativePattern(centralPath, `${SKILL_BRIDGE_STATE_DIR}/${GROUP_MARKDOWN_FILE}`),
    new vscode.RelativePattern(workspacePath, LEGACY_GROUP_STORE_FILE),
    new vscode.RelativePattern(centralPath, LEGACY_GROUP_STORE_FILE),
    new vscode.RelativePattern(workspacePath, GROUP_MARKDOWN_FILE),
    new vscode.RelativePattern(centralPath, GROUP_MARKDOWN_FILE)
  ];
  return patterns.map((pattern) => vscode.workspace.createFileSystemWatcher(pattern));
}

export function applyGroupHighlight(
  state: { workspaceSkills: SkillFile[]; centralSkills: SkillFile[] },
  group: SelectionGroup,
  workspaceProvider: SkillTreeProvider,
  centralProvider: SkillTreeProvider
): void {
  const highlight = buildHighlightSet(
    group.side === "workspace" ? state.workspaceSkills : state.centralSkills,
    group
  );
  if (group.side === "workspace") {
    workspaceProvider.setHighlight(highlight);
    centralProvider.setHighlight(new Set());
  } else {
    centralProvider.setHighlight(highlight);
    workspaceProvider.setHighlight(new Set());
  }
}

export function buildHighlightSet(files: SkillFile[], group: SelectionGroup): Set<string> {
  const highlight = new Set<string>();
  const selections = targetsToSelections(files, group.targets);
  const addPath = (tool: ToolType, rel: string): void => {
    if (!rel) return;
    highlight.add(`${tool}:${rel}`);
    const parts = rel.split("/");
    let cursor = "";
    for (let i = 0; i < parts.length - 1; i += 1) {
      cursor = cursor ? `${cursor}/${parts[i]}` : parts[i];
      highlight.add(`${tool}:${cursor}`);
    }
  };
  for (const target of group.targets) {
    if (!isManagedSkillPath(target.relativePath)) continue;
    highlight.add(`${target.tool}:${target.relativePath}`);
  }
  for (const item of selections) {
    addPath(item.tool, item.relativePath);
  }
  return highlight;
}

export function countGroups(groups: SelectionGroup[]): { workspace: number; central: number } {
  let workspace = 0;
  let central = 0;
  for (const group of groups) {
    if (group.side === "workspace") workspace += 1;
    else central += 1;
  }
  return { workspace, central };
}

export function filterGroupsByTab(groups: SelectionGroup[], tab: SourceTab): SelectionGroup[] {
  if (tab === "all") return groups;
  return groups.filter((group) => group.targets.some((target) => sourceTabIncludes(tab, target.tool)));
}
