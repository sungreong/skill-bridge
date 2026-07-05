type TranslationFn = (english: string, korean: string) => string;
type TreeSide = "workspace" | "central";
type SourceKind = "manual" | "npx" | "mixed";
type SyncStatus = "same" | "workspaceOnly" | "centralOnly" | "different";
type HealthStatus = "ready" | "needsDescription" | "brokenTargets";

export function sideLabel(side: TreeSide, t: TranslationFn): string {
  return side === "workspace" ? t("Workspace", "Workspace") : t("Central", "Central");
}

export function sourceLabel(source: SourceKind, t: TranslationFn): string {
  if (source === "npx") return t("npx", "npx");
  if (source === "mixed") return t("mixed", "혼합");
  return t("manual", "수동");
}

export function sourceDetail(meta: { source?: SourceKind; repoKey?: string; repoUrl?: string } | undefined, t: TranslationFn): string {
  if (meta?.repoUrl?.trim()) return meta.repoUrl.trim();
  if (meta?.repoKey?.trim()) return meta.repoKey.trim();
  if (meta?.source === "mixed") return t("npx/manual mixed group", "npx와 수동 변경이 섞인 그룹");
  return "";
}

export function syncLabel(status: SyncStatus, t: TranslationFn): string {
  if (status === "same") return t("same", "같음");
  if (status === "different") return t("different", "다름");
  if (status === "workspaceOnly") return t("workspace only", "작업공간만");
  return t("central only", "중앙만");
}

export function healthLabel(health: HealthStatus, brokenTargetCount: number, t: TranslationFn): string {
  if (health === "brokenTargets") return t(`broken ${brokenTargetCount}`, `깨진 대상 ${brokenTargetCount}`);
  if (health === "needsDescription") return t("needs description", "설명 필요");
  return t("ready", "정상");
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
