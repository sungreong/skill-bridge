import { existsSync, promises as fs } from "node:fs";
import * as vscode from "vscode";
import { resolveSkillPath } from "./skillPaths";
import {
  createFileUriFromAbsolutePath,
  containsWorkspaceSpecificPath,
  dedupeTreeWarnings,
  findBrokenMarkdownLinkWarnings,
  getSkillFolderRelativePath,
  getSkillInnerRelativePath,
  hasSensitiveLikeText,
  isEditableSkillTextPath,
  isSkillMdRelativePath,
  isToolType,
  mapWithConcurrency,
  normalizeRel
} from "./extensionSupport";
import type { SkillAssetTreeMeta, SkillAssetWarning, SkillFile, ToolType } from "./types";

type TranslationFn = (message: string, ...args: Array<string | number | boolean>) => string;
type TreeSide = "workspace" | "central";
type BuildTreeAssetMetaInput = {
  workspacePath: string;
  centralRepoPath: string;
  workspaceSkills: SkillFile[];
  centralSkills: SkillFile[];
  workspaceMissingSkillFolders: Array<{ tool: ToolType; relativePath: string }>;
  centralMissingSkillFolders: Array<{ tool: ToolType; relativePath: string }>;
};
type DiagnosticCounts = { total: number; errors: number; warnings: number; infos: number };

type CreateDiagnosticsArgs = {
  tr: TranslationFn;
  state: {
    workspacePath: string;
    workspaceSkills: SkillFile[];
    workspaceAssetMeta: Map<string, SkillAssetTreeMeta>;
  };
  skillDiagnostics: vscode.DiagnosticCollection;
  isSameFileContent: (src: string, dst: string, srcSize: number, dstSize: number) => Promise<boolean>;
};

export function createDiagnosticsTools(args: CreateDiagnosticsArgs): {
  buildTreeAssetMeta: (input: BuildTreeAssetMetaInput) => Promise<{ workspace: Map<string, SkillAssetTreeMeta>; central: Map<string, SkillAssetTreeMeta> }>;
  updateSkillDiagnostics: () => DiagnosticCounts;
} {
  type Draft = {
    tool: ToolType;
    rootRelativePath: string;
    hasManifest: boolean;
    fileCount: number;
    totalBytes: number;
    updatedAt: string | null;
    files: SkillFile[];
    warnings: SkillAssetWarning[];
    missing: boolean;
  };

  const buildKnownSkillFileSets = (files: SkillFile[]): Map<string, Set<string>> => {
    const byFolder = new Map<string, Set<string>>();
    for (const file of files) {
      const folder = getSkillFolderRelativePath(file.relativePath);
      if (!folder) continue;
      const key = `${file.tool}:${folder}`;
      const bucket = byFolder.get(key) ?? new Set<string>();
      bucket.add(normalizeRel(file.relativePath).toLowerCase());
      byFolder.set(key, bucket);
    }
    return byFolder;
  };

  const inspectSkillFileForTreeWarnings = async (
    file: SkillFile,
    rootRelativePath: string,
    knownFiles: Set<string>
  ): Promise<SkillAssetWarning[]> => {
    const warnings: SkillAssetWarning[] = [];
    const relativePath = normalizeRel(file.relativePath);
    if (/\.(ps1|bat|cmd|sh|bash|zsh|fish|js|mjs|cjs|ts|tsx|py|rb|pl)$/i.test(relativePath)) {
      warnings.push({
        code: "script-file",
        severity: "warning",
        message: args.tr("Contains an executable script."),
        relativePath
      });
    }
    if (!isEditableSkillTextPath(relativePath)) return warnings;
    const text = await fs.readFile(file.absolutePath, "utf8").catch(() => "");
    if (!text) return warnings;
    if (hasSensitiveLikeText(text)) {
      warnings.push({
        code: "sensitive-content",
        severity: "danger",
        message: args.tr("Contains possible sensitive information."),
        relativePath
      });
    }
    if (containsWorkspaceSpecificPath(text)) {
      warnings.push({
        code: "workspace-specific-path",
        severity: "warning",
        message: args.tr("Contains text that looks like a local absolute path."),
        relativePath
      });
    }
    if (/\.md$/i.test(relativePath)) {
      warnings.push(...findBrokenMarkdownLinkWarnings(text, relativePath, rootRelativePath, knownFiles));
    }
    return warnings;
  };

  const assetDraftChanged = async (left: { files: SkillFile[] }, right: { files: SkillFile[] }): Promise<boolean> => {
    const leftByInner = new Map(left.files.map((file) => [getSkillInnerRelativePath(file.relativePath), file] as const));
    const rightByInner = new Map(right.files.map((file) => [getSkillInnerRelativePath(file.relativePath), file] as const));
    const allInner = new Set<string>([...leftByInner.keys(), ...rightByInner.keys()]);
    const comparisons = await mapWithConcurrency([...allInner], 16, async (inner) => {
      const leftFile = leftByInner.get(inner);
      const rightFile = rightByInner.get(inner);
      if (!leftFile || !rightFile) return true;
      const [leftStat, rightStat] = await Promise.all([
        fs.stat(leftFile.absolutePath).catch(() => null),
        fs.stat(rightFile.absolutePath).catch(() => null)
      ]);
      if (!leftStat?.isFile() || !rightStat?.isFile()) return true;
      return !(await args.isSameFileContent(leftFile.absolutePath, rightFile.absolutePath, leftStat.size, rightStat.size));
    });
    return comparisons.some(Boolean);
  };

  const addTreeDuplicateWarnings = (drafts: Array<{ rootRelativePath: string; tool: ToolType; warnings: SkillAssetWarning[] }>): void => {
    const byName = new Map<string, Array<{ rootRelativePath: string; tool: ToolType; warnings: SkillAssetWarning[] }>>();
    for (const draft of drafts) {
      const name = draft.rootRelativePath.split("/")[1]?.toLowerCase();
      if (!name) continue;
      const bucket = byName.get(name) ?? [];
      bucket.push(draft);
      byName.set(name, bucket);
    }
    for (const bucket of byName.values()) {
      const tools = [...new Set(bucket.map((draft) => draft.tool))];
      if (tools.length < 2) continue;
      for (const draft of bucket) {
        draft.warnings.push({
          code: "duplicate-name",
          severity: "info",
          message: args.tr("Multiple agents contain a skill with the same name: {0}", String(tools.join(", "))),
          relativePath: draft.rootRelativePath
        });
      }
    }
  };

  const buildDrafts = async (
    side: TreeSide,
    files: SkillFile[],
    missingFolders: Array<{ tool: ToolType; relativePath: string }>
  ): Promise<Map<string, Draft>> => {
    const drafts = new Map<string, Draft>();
    const ensure = (tool: ToolType, rootRelativePath: string): Draft => {
      const key = `${tool}:${rootRelativePath}`;
      const existing = drafts.get(key);
      if (existing) return existing;
      const draft: Draft = {
        tool,
        rootRelativePath,
        hasManifest: false,
        fileCount: 0,
        totalBytes: 0,
        updatedAt: null,
        files: [],
        warnings: [],
        missing: false
      };
      drafts.set(key, draft);
      return draft;
    };

    for (const file of files) {
      const folder = getSkillFolderRelativePath(file.relativePath);
      if (!folder) continue;
      const draft = ensure(file.tool, folder);
      draft.files.push(file);
      draft.fileCount += 1;
      if (isSkillMdRelativePath(file.relativePath)) draft.hasManifest = true;
    }

    const knownFilesByFolder = buildKnownSkillFileSets(files);
    const inspectedFiles = files
      .map((file) => {
        const folder = getSkillFolderRelativePath(file.relativePath);
        return folder ? { file, folder } : null;
      })
      .filter((item): item is { file: SkillFile; folder: string } => item !== null);
    const fileDetails = await mapWithConcurrency(inspectedFiles, 24, async ({ file, folder }) => {
      const [stat, warnings] = await Promise.all([
        fs.stat(file.absolutePath).catch(() => null),
        inspectSkillFileForTreeWarnings(file, folder, knownFilesByFolder.get(`${file.tool}:${folder}`) ?? new Set<string>())
      ]);
      return { file, folder, stat, warnings };
    });

    for (const detail of fileDetails) {
      const draft = drafts.get(`${detail.file.tool}:${detail.folder}`);
      if (!draft) continue;
      if (detail.stat?.isFile()) {
        draft.totalBytes += detail.stat.size;
        if (!draft.updatedAt || detail.stat.mtimeMs > Date.parse(draft.updatedAt)) {
          draft.updatedAt = detail.stat.mtime.toISOString();
        }
      }
      draft.warnings.push(...detail.warnings);
    }

    for (const missing of missingFolders) {
      const folder = normalizeRel(missing.relativePath);
      const draft = ensure(missing.tool, folder);
      draft.missing = true;
      draft.hasManifest = false;
      draft.warnings.push({
        code: "missing-skill-md",
        severity: "danger",
        message: args.tr("SKILL.md is missing, so this may be excluded when applying changes."),
        relativePath: folder
      });
    }

    addTreeDuplicateWarnings([...drafts.values()]);
    void side;
    return drafts;
  };

  const buildTreeAssetMeta = async (
    input: BuildTreeAssetMetaInput
  ): Promise<{ workspace: Map<string, SkillAssetTreeMeta>; central: Map<string, SkillAssetTreeMeta> }> => {
    const [workspaceDrafts, centralDrafts] = await Promise.all([
      buildDrafts("workspace", input.workspaceSkills, input.workspaceMissingSkillFolders),
      buildDrafts("central", input.centralSkills, input.centralMissingSkillFolders)
    ]);
    const recentCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const resolveStatus = async (draft: Draft, counterpart: Draft | undefined): Promise<SkillAssetTreeMeta> => {
      if (counterpart?.updatedAt && draft.updatedAt && Date.parse(counterpart.updatedAt) > Date.parse(draft.updatedAt)) {
        draft.warnings.push({
          code: "target-newer",
          severity: "warning",
          message: args.tr("The skill on the other side is newer. Review the diff before overwriting."),
          relativePath: draft.rootRelativePath
        });
      }
      const warnings = dedupeTreeWarnings(draft.warnings);
      const hasRisk = warnings.some((warning) => warning.severity !== "info");
      if (draft.missing || !draft.hasManifest) {
        return { status: "missingSkillMd", warnings, fileCount: draft.fileCount, updatedAt: draft.updatedAt };
      }
      if (hasRisk) return { status: "risk", warnings, fileCount: draft.fileCount, updatedAt: draft.updatedAt };
      if (!counterpart || counterpart.missing) return { status: "new", warnings, fileCount: draft.fileCount, updatedAt: draft.updatedAt };
      if (await assetDraftChanged(draft, counterpart)) return { status: "changed", warnings, fileCount: draft.fileCount, updatedAt: draft.updatedAt };
      if (draft.updatedAt && Date.parse(draft.updatedAt) >= recentCutoff) return { status: "recent", warnings, fileCount: draft.fileCount, updatedAt: draft.updatedAt };
      return { status: "same", warnings, fileCount: draft.fileCount, updatedAt: draft.updatedAt };
    };

    const workspace = new Map<string, SkillAssetTreeMeta>();
    const central = new Map<string, SkillAssetTreeMeta>();
    const workspaceStatuses = await mapWithConcurrency([...workspaceDrafts.entries()], 16, async ([key, draft]) => ({ key, meta: await resolveStatus(draft, centralDrafts.get(key)) }));
    const centralStatuses = await mapWithConcurrency([...centralDrafts.entries()], 16, async ([key, draft]) => ({ key, meta: await resolveStatus(draft, workspaceDrafts.get(key)) }));
    for (const item of workspaceStatuses) workspace.set(item.key, item.meta);
    for (const item of centralStatuses) central.set(item.key, item.meta);
    void input.workspacePath;
    void input.centralRepoPath;
    return { workspace, central };
  };

  const splitAssetMetaKey = (key: string): { tool: ToolType; rootRelativePath: string } | null => {
    const sep = key.indexOf(":");
    if (sep <= 0) return null;
    const toolRaw = key.slice(0, sep);
    const rootRelativePath = normalizeRel(key.slice(sep + 1));
    if (!isToolType(toolRaw) || !rootRelativePath) return null;
    return { tool: toolRaw, rootRelativePath };
  };

  const diagnosticSeverityForSkillWarning = (warning: SkillAssetWarning): vscode.DiagnosticSeverity | null => {
    if (warning.code === "target-newer" || warning.code === "duplicate-name") return null;
    if (warning.code === "sensitive-content" || warning.severity === "danger") return vscode.DiagnosticSeverity.Error;
    if (warning.severity === "warning") return vscode.DiagnosticSeverity.Warning;
    return vscode.DiagnosticSeverity.Information;
  };

  const resolveWorkspaceDiagnosticTarget = (
    tool: ToolType,
    rootRelativePath: string,
    warning: SkillAssetWarning,
    files: SkillFile[]
  ): string | null => {
    const candidates = [
      warning.relativePath ? normalizeRel(warning.relativePath) : "",
      `${rootRelativePath}/SKILL.md`,
      files[0]?.relativePath ?? "",
      rootRelativePath
    ].filter(Boolean);
    for (const relativePath of candidates) {
      try {
        const absolutePath = resolveSkillPath(args.state.workspacePath, tool, relativePath, "workspace");
        if (existsSync(absolutePath)) return absolutePath;
      } catch {
        // Try next candidate.
      }
    }
    return null;
  };

  const updateSkillDiagnostics = (): DiagnosticCounts => {
    args.skillDiagnostics.clear();
    const counts: DiagnosticCounts = { total: 0, errors: 0, warnings: 0, infos: 0 };
    const byUri = new Map<string, vscode.Diagnostic[]>();
    const filesByFolder = new Map<string, SkillFile[]>();

    for (const file of args.state.workspaceSkills) {
      const folder = getSkillFolderRelativePath(file.relativePath);
      if (!folder) continue;
      const key = `${file.tool}:${folder}`;
      const bucket = filesByFolder.get(key) ?? [];
      bucket.push(file);
      filesByFolder.set(key, bucket);
    }

    const addDiagnostic = (absolutePath: string, warning: SkillAssetWarning): void => {
      const severity = diagnosticSeverityForSkillWarning(warning);
      if (severity === null) return;
      const diagnostic = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), `[Skill Bridge] ${warning.message}`, severity);
      diagnostic.source = "Skill Bridge";
      diagnostic.code = warning.code;
      const bucket = byUri.get(absolutePath) ?? [];
      bucket.push(diagnostic);
      byUri.set(absolutePath, bucket);
      counts.total += 1;
      if (severity === vscode.DiagnosticSeverity.Error) counts.errors += 1;
      else if (severity === vscode.DiagnosticSeverity.Warning) counts.warnings += 1;
      else counts.infos += 1;
    };

    for (const [key, meta] of args.state.workspaceAssetMeta.entries()) {
      const parsed = splitAssetMetaKey(key);
      if (!parsed) continue;
      const files = filesByFolder.get(key) ?? [];
      for (const warning of meta.warnings) {
        const target = resolveWorkspaceDiagnosticTarget(parsed.tool, parsed.rootRelativePath, warning, files);
        if (target) addDiagnostic(target, warning);
      }
    }

    for (const [absolutePath, diagnostics] of byUri.entries()) {
      try {
        args.skillDiagnostics.set(createFileUriFromAbsolutePath(absolutePath), diagnostics);
      } catch {
        continue;
      }
    }
    return counts;
  };

  return {
    buildTreeAssetMeta,
    updateSkillDiagnostics
  };
}
