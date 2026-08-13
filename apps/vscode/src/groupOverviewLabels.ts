type TranslationFn = (message: string, ...args: Array<string | number | boolean>) => string;
type TreeSide = "workspace" | "central";
type SourceKind = "manual" | "npx" | "mixed";
type SyncStatus = "same" | "workspaceOnly" | "centralOnly" | "different";
type HealthStatus = "ready" | "needsDescription" | "brokenTargets";

export function sideLabel(side: TreeSide, t: TranslationFn): string {
  return side === "workspace" ? t("Workspace") : t("Central");
}

export function sourceLabel(source: SourceKind, t: TranslationFn): string {
  if (source === "npx") return t("npx");
  if (source === "mixed") return t("mixed");
  return t("manual");
}

export function sourceDetail(meta: { source?: SourceKind; repoKey?: string; repoUrl?: string } | undefined, t: TranslationFn): string {
  if (meta?.repoUrl?.trim()) return meta.repoUrl.trim();
  if (meta?.repoKey?.trim()) return meta.repoKey.trim();
  if (meta?.source === "mixed") return t("npx/manual mixed group");
  return "";
}

export function syncLabel(status: SyncStatus, t: TranslationFn): string {
  if (status === "same") return t("same");
  if (status === "different") return t("different");
  if (status === "workspaceOnly") return t("workspace only");
  return t("central only");
}

export function healthLabel(health: HealthStatus, brokenTargetCount: number, t: TranslationFn): string {
  if (health === "brokenTargets") return t("broken {0}", brokenTargetCount);
  if (health === "needsDescription") return t("needs description");
  return t("ready");
}

export function renderBadge(label: string, className: string): string {
  return `<span class="badge ${escAttr(className)}">${esc(label)}</span>`;
}

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escAttr(value: string): string {
  return esc(value).replace(/'/g, "&#39;");
}
