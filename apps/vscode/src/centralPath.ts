import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_CENTRAL_REPO_PATH_SETTING = "${userHome}/skill-bridge-repo";

export type CentralPathIssueCode =
  | "empty"
  | "nonAbsolute"
  | "nonFileUri"
  | "hostMismatch"
  | "contaminatedAbsolutePrefix";

export type HostPathIssueCode = Exclude<CentralPathIssueCode, "empty" | "nonFileUri">;

export type ResolvedCentralRepoPath =
  | { ok: true; absolutePath: string; source: "default" | "configured"; rawValue: string }
  | { ok: false; issue: CentralPathIssueCode; rawValue: string; fallbackPath: string };

export type ResolvedHostPath =
  | { ok: true; absolutePath: string }
  | { ok: false; issue: HostPathIssueCode; rawValue: string };

const WINDOWS_DRIVE_ABSOLUTE_RE = /[A-Za-z]:[\\/]/g;
const URI_SCHEME_RE = /^([A-Za-z][A-Za-z0-9+.-]*):/;

export function expandConfiguredPath(raw: string, workspacePath: string): string {
  const home = os.homedir();
  return raw
    .replace(/\$\{userHome\}/g, home)
    .replace(/\$\{workspaceFolder\}/g, workspacePath)
    .replace(/\$\{workspaceRoot\}/g, workspacePath)
    .replace(/\$\{env:([^}]+)\}/g, (_match, name: string) => process.env[name] ?? "");
}

export function getDefaultCentralRepoPath(workspacePath: string): string {
  return resolveDefaultCentralRepoPath(workspacePath);
}

export function resolveCentralRepoPath(rawValue: string, workspacePath: string, source: "default" | "configured"): ResolvedCentralRepoPath {
  const fallbackPath = resolveDefaultCentralRepoPath(workspacePath);
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return { ok: false, issue: "empty", rawValue, fallbackPath };
  }

  const expanded = expandConfiguredPath(trimmed, workspacePath).trim();
  if (!expanded) {
    return { ok: false, issue: "empty", rawValue, fallbackPath };
  }

  const uriResolution = resolveUriCandidate(expanded);
  if (uriResolution.kind === "nonFileUri") {
    return { ok: false, issue: "nonFileUri", rawValue: trimmed, fallbackPath };
  }

  const candidate = uriResolution.kind === "fileUri" ? uriResolution.fsPath : expanded;
  if (hasContaminatedAbsolutePrefix(candidate)) {
    return { ok: false, issue: "contaminatedAbsolutePrefix", rawValue: trimmed, fallbackPath };
  }

  const absolutePath = resolveHostAbsolutePath(candidate);
  if (!absolutePath.ok) {
    return { ok: false, issue: absolutePath.issue, rawValue: trimmed, fallbackPath };
  }

  return {
    ok: true,
    absolutePath: absolutePath.absolutePath,
    source,
    rawValue: trimmed
  };
}

export function resolveHostPath(rawValue: string): ResolvedHostPath {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return { ok: false, issue: "nonAbsolute", rawValue };
  }
  if (hasContaminatedAbsolutePrefix(trimmed)) {
    return { ok: false, issue: "contaminatedAbsolutePrefix", rawValue };
  }
  return resolveHostAbsolutePath(trimmed);
}

export function compactPathForDisplay(value: string): string {
  const resolved = resolveHostPath(value);
  if (!resolved.ok) return value;
  const home = path.resolve(os.homedir());
  const normalizedValue = resolved.absolutePath;
  const normalizedHome = path.resolve(home);
  if (normalizedValue === normalizedHome) return "~";
  if (normalizedValue.startsWith(normalizedHome + path.sep)) {
    return `~${path.sep}${normalizedValue.slice(normalizedHome.length + 1)}`;
  }
  return value;
}

export function formatCentralPathIssue(result: Extract<ResolvedCentralRepoPath, { ok: false }>): string {
  const reason = issueReason(result.issue);
  const rawDisplay = result.rawValue.trim() || "(empty)";
  return `${reason} Configured value: ${rawDisplay}. Suggested fallback: ${result.fallbackPath}.`;
}

export function formatHostPathIssue(issue: HostPathIssueCode, rawValue: string): string {
  const reason = issueReason(issue);
  const rawDisplay = rawValue.trim() || "(empty)";
  return `${reason} Path: ${rawDisplay}.`;
}

function resolveDefaultCentralRepoPath(workspacePath: string): string {
  const expanded = expandConfiguredPath(DEFAULT_CENTRAL_REPO_PATH_SETTING, workspacePath);
  const resolved = resolveHostAbsolutePath(expanded);
  if (resolved.ok) return resolved.absolutePath;
  return path.resolve(os.homedir(), "skill-bridge-repo");
}

function resolveUriCandidate(value: string): { kind: "plain" } | { kind: "fileUri"; fsPath: string } | { kind: "nonFileUri" } {
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    return { kind: "plain" };
  }
  const schemeMatch = value.match(URI_SCHEME_RE);
  if (!schemeMatch) {
    return { kind: "plain" };
  }
  if (schemeMatch[1].toLowerCase() !== "file") {
    return { kind: "nonFileUri" };
  }
  try {
    return { kind: "fileUri", fsPath: fileURLToPath(new URL(value)) };
  } catch {
    return { kind: "nonFileUri" };
  }
}

function resolveHostAbsolutePath(value: string): ResolvedHostPath {
  const normalized = value.trim();
  if (!normalized) {
    return { ok: false, issue: "nonAbsolute", rawValue: value };
  }

  if (process.platform === "win32") {
    if (looksLikePosixHomePath(normalized)) {
      return { ok: false, issue: "hostMismatch", rawValue: value };
    }
    if (!path.win32.isAbsolute(normalized)) {
      return {
        ok: false,
        issue: path.posix.isAbsolute(normalized) ? "hostMismatch" : "nonAbsolute",
        rawValue: value
      };
    }
  } else {
    if (looksLikeWrappedWindowsDrivePath(normalized) || path.win32.isAbsolute(normalized)) {
      return { ok: false, issue: "hostMismatch", rawValue: value };
    }
    if (!path.posix.isAbsolute(normalized)) {
      return { ok: false, issue: "nonAbsolute", rawValue: value };
    }
  }

  const absolutePath = path.resolve(normalized);
  if (hasContaminatedAbsolutePrefix(absolutePath)) {
    return { ok: false, issue: "contaminatedAbsolutePrefix", rawValue: value };
  }

  return { ok: true, absolutePath };
}

function looksLikePosixHomePath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  return normalized.startsWith("/home/") || normalized.startsWith("/Users/") || normalized.startsWith("/Volumes/");
}

function looksLikeWrappedWindowsDrivePath(value: string): boolean {
  return /^\/[A-Za-z]:[\\/]/.test(value);
}

function hasContaminatedAbsolutePrefix(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  if (normalized.toLowerCase().indexOf("file://") > 0) return true;
  for (const match of normalized.matchAll(WINDOWS_DRIVE_ABSOLUTE_RE)) {
    const index = match.index ?? 0;
    if (index === 0) continue;
    if (index === 1 && normalized.startsWith("/")) continue;
    return true;
  }
  return false;
}

function issueReason(issue: CentralPathIssueCode): string {
  switch (issue) {
    case "empty":
      return "Central library path is empty.";
    case "nonAbsolute":
      return "Central library path must be an absolute path on the current host.";
    case "nonFileUri":
      return "Central library path must be a local file path or file:// URI.";
    case "hostMismatch":
      return "Central library path points to a different host format and cannot be used in this session.";
    case "contaminatedAbsolutePrefix":
      return "Central library path contains another absolute path inside it and looks corrupted.";
  }
}
