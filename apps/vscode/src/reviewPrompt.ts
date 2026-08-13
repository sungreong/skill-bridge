import type { TransferPlan, TransferPlanItem, TransferStatus } from "./types";
import { localize, type UiLanguage } from "./uiLanguage";

type ReviewSeverity = "low" | "medium" | "high";

export interface TransferReviewItem {
  key: string;
  severity: ReviewSeverity;
  tags: string[];
  notes: string[];
  checklist: string[];
}

export interface TransferReviewMeta {
  generatedAt: string;
  items: Record<string, TransferReviewItem>;
}

type RiskDraft = {
  severity: ReviewSeverity;
  tags: string[];
  notes: string[];
};

type RiskCounts = Record<ReviewSeverity, number>;

const severityRank: Record<ReviewSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2
};

export function buildTransferReviewMeta(plan: TransferPlan, language: UiLanguage = "en"): TransferReviewMeta {
  const skillFoldersWithManifest = new Set<string>();
  for (const item of plan.items) {
    if (isSkillManifestPath(item.relativePath)) {
      const folder = getSkillFolderRelativePath(item.relativePath);
      if (folder) skillFoldersWithManifest.add(`${item.tool}:${folder}`);
    }
  }

  const items: Record<string, TransferReviewItem> = {};
  for (const item of plan.items) {
    items[item.key] = analyzeTransferItem(item, skillFoldersWithManifest, language);
  }

  return {
    generatedAt: new Date().toISOString(),
    items
  };
}

export function buildAgentReviewPrompt(plan: TransferPlan, selectedKeys: Set<string>, language: UiLanguage = "en"): string {
  const t = localize;
  const review = buildTransferReviewMeta(plan, language);
  const selected = plan.items.filter((item) => selectedKeys.has(item.key));
  const selectedReview = selected.map((item) => ({ item, review: review.items[item.key] }));
  const riskCounts = countRisks(selectedReview.map((entry) => entry.review));
  const statusCounts = countStatuses(selected);
  const direction = plan.mode === "workspaceToCentral"
    ? t("Workspace -> Central")
    : t("Central -> Workspace");
  const sourceLabel = plan.mode === "workspaceToCentral" ? t("workspace") : t("central");
  const targetLabel = plan.mode === "workspaceToCentral" ? t("central") : t("workspace");
  const selectedChanged = selected.filter((item) => item.status !== "same");
  const predictedBaseItems = getStatsBaseItems(selected);
  const predictedCreate = predictedBaseItems.filter((item) => item.status === "added").length;
  const predictedOverwrite = predictedBaseItems.filter((item) => item.status === "modified" || item.status === "typeChanged").length;
  const predictedDelete = predictedBaseItems.filter((item) => item.status === "removed").length;
  const maxRows = 80;

  const lines: string[] = [
    localize("# Skill Bridge Apply Review"),
    "",
    t("You are reviewing pending Skill Bridge changes before the user manually applies them."),
    t("Do not execute changes, do not auto-merge, and do not suggest turning this into a skill runner or Git GUI."),
    t("Give a practical recommendation: proceed, cancel, or inspect specific files first."),
    "",
    t("## Context"),
    `- ${t("Direction")}: ${direction}`,
    `- ${t("Source side")}: ${sourceLabel}`,
    `- ${t("Target side")}: ${targetLabel}`,
    `- ${t("Group")}: ${plan.groupContext ? `${plan.groupContext.name} (${plan.groupContext.side})` : t("none")}`,
    `- ${t("Repository context")}: ${plan.repoContext?.repo ?? t("none")}`,
    `- ${t("Selected rows")}: ${selected.length}`,
    `- ${t("Selected changed rows")}: ${selectedChanged.length}`,
    `- ${t("Generated at")}: ${review.generatedAt}`,
    `- ${t("Absolute filesystem paths and full file contents are intentionally omitted.")}`,
    "",
    t("## Selected Summary"),
    `- ${t("New on target")}: ${statusCounts.added}`,
    `- ${t("Type conflicts")}: ${statusCounts.typeChanged}`,
    `- ${t("Modified target")}: ${statusCounts.modified}`,
    `- ${t("Delete from target")}: ${statusCounts.removed}`,
    `- ${t("Overwrite/type-conflict rows")}: ${statusCounts.modified + statusCounts.typeChanged}`,
    `- ${t("Same/no-op rows")}: ${statusCounts.same}`,
    `- ${t("Predicted create/overwrite/delete")}: ${predictedCreate}/${predictedOverwrite}/${predictedDelete}`,
    `- ${t("Risk counts")}: ${t("high")} ${riskCounts.high}, ${t("medium")} ${riskCounts.medium}, ${t("low")} ${riskCounts.low}`,
    "",
    t("## Review Checklist"),
    `- ${t("Is the apply direction correct for the user's intent?")}`,
    `- ${t("Are any SKILL.md, system prompt, model, permission, or config files changed?")}`,
    `- ${t("Are deletions or file/folder type conflicts intentional?")}`,
    `- ${t("Could this overwrite a newer target-side version the user still needs?")}`,
    `- ${t("Is a manual diff inspection required before applying?")}`,
    "",
    t("## Selected Items")
  ];

  if (selected.length === 0) {
    lines.push(`- ${t("No rows are selected.")}`);
  }

  for (const { item, review: itemReview } of selectedReview.slice(0, maxRows)) {
    lines.push(
      [
        `- ${item.tool}/${item.relativePath}`,
        `  - ${t("kind")}: ${item.entryKind}`,
        `  - ${t("status")}: ${statusLabel(item.status, language)} (${item.reason})`,
        `  - ${t("group")}: ${item.groupName ?? t("none")} (${item.groupType})`,
        `  - ${t("source mtime/size")}: ${item.srcMtime ?? t("missing")} / ${formatBytesForPrompt(item.srcSize, language)}`,
        `  - ${t("target mtime/size")}: ${item.dstMtime ?? t("missing")} / ${formatBytesForPrompt(item.dstSize, language)}`,
        `  - ${t("risk")}: ${reviewSeverityLabel(itemReview.severity)}`,
        `  - ${t("tags")}: ${itemReview.tags.join(", ") || t("none")}`,
        `  - ${t("notes")}: ${itemReview.notes.join(" | ") || t("none")}`
      ].join("\n")
    );
  }

  if (selected.length > maxRows) {
    lines.push(`- ${localize("{0} additional selected rows omitted from this prompt. Ask the user to narrow the selection if needed.", String(selected.length - maxRows))}`);
  }

  lines.push(
    "",
    t("## Expected Answer"),
    t("Return a short review with:"),
    t("1. Overall recommendation: proceed / inspect first / cancel."),
    t("2. Top risks in plain language."),
    t("3. Exact files the user should open in Diff before applying."),
    t("4. Any realistic fix inside the Skill Bridge workflow, without auto-merging or executing changes.")
  );

  return lines.join("\n");
}

function analyzeTransferItem(item: TransferPlanItem, skillFoldersWithManifest: Set<string>, language: UiLanguage): TransferReviewItem {
  const draft: RiskDraft = { severity: "low", tags: [], notes: [] };
  const skillFolder = getSkillFolderRelativePath(item.relativePath);
  const folderKey = skillFolder ? `${item.tool}:${skillFolder}` : null;

  if (item.status === "removed") {
    addRisk(draft, "high", localize("Delete planned"), localize("A file or folder on the target side may be deleted."));
  }
  if (item.status === "typeChanged") {
    addRisk(draft, "high", localize("Type conflict"), localize("The file/folder types differ, so review is required before overwrite."));
  }
  if (item.status === "modified" && isSkillManifestPath(item.relativePath)) {
    addRisk(draft, "high", localize("SKILL.md changed"), localize("The skill's core description or usage conditions change."));
  }
  if ((item.status === "modified" || item.status === "typeChanged") && isTargetNewerThanSource(item)) {
    addRisk(draft, "high", localize("Target is newer"), localize("The target file's modified time is newer than the source."));
  }
  if (item.status === "added" && isSkillManifestPath(item.relativePath)) {
    addRisk(draft, "medium", localize("New skill manifest"), localize("A new skill will be added to the target side."));
  }
  if (item.status === "modified" && isBehaviorPath(item.relativePath)) {
    addRisk(draft, "medium", localize("Behavior instructions changed"), localize("The agent's response style or workflow may change."));
  }
  if (item.status !== "same" && isConfigPath(item.relativePath)) {
    addRisk(draft, "medium", localize("Config file"), localize("Model, option, permission, or tool settings may change."));
  }
  if (item.entryKind === "folder" && item.status !== "same") {
    addRisk(draft, "medium", localize("Folder-level apply"), localize("Several nested items may be applied at once."));
  }
  if (item.status !== "same" && !isSameSizeOrSmall(item.srcSize, item.dstSize)) {
    addRisk(draft, "medium", localize("Large size change"), localize("The file size difference is large, so confirm it is intentional."));
  }
  if (folderKey && !skillFoldersWithManifest.has(folderKey) && item.entryKind === "folder") {
    addRisk(draft, "high", localize("SKILL.md missing from apply scope"), localize("This apply plan does not include a SKILL.md row for the skill folder."));
  }
  if (draft.tags.length === 0) {
    addRisk(
      draft,
      "low",
      statusLabel(item.status, language),
      localize("General change. Open Diff if needed.")
    );
  }

  return {
    key: item.key,
    severity: draft.severity,
    tags: uniqueStrings(draft.tags),
    notes: uniqueStrings(draft.notes),
    checklist: buildItemChecklist(item, draft, language)
  };
}

function buildItemChecklist(item: TransferPlanItem, draft: RiskDraft, language: UiLanguage): string[] {
  const checks = [
    localize("Check apply direction"),
    localize("Review Diff")
  ];
  if (draft.severity === "high") checks.push(localize("Manual review before apply"));
  if (item.status === "removed") checks.push(localize("Confirm delete intent"));
  if (item.status === "typeChanged") checks.push(localize("Confirm type conflict"));
  if (isSkillManifestPath(item.relativePath)) checks.push(localize("Check SKILL.md description/trigger"));
  if (isConfigPath(item.relativePath)) checks.push(localize("Check model/permission/config"));
  return uniqueStrings(checks);
}

function addRisk(draft: RiskDraft, severity: ReviewSeverity, tag: string, note: string): void {
  if (severityRank[severity] > severityRank[draft.severity]) {
    draft.severity = severity;
  }
  draft.tags.push(tag);
  draft.notes.push(note);
}

function countRisks(items: Array<TransferReviewItem | undefined>): RiskCounts {
  const counts: RiskCounts = { low: 0, medium: 0, high: 0 };
  for (const item of items) {
    if (!item) continue;
    counts[item.severity] += 1;
  }
  return counts;
}

function countStatuses(items: TransferPlanItem[]): Record<TransferStatus, number> {
  const counts: Record<TransferStatus, number> = {
    added: 0,
    removed: 0,
    modified: 0,
    same: 0,
    typeChanged: 0
  };
  for (const item of items) {
    counts[item.status] += 1;
  }
  return counts;
}

function getStatsBaseItems(items: TransferPlanItem[]): TransferPlanItem[] {
  const files = items.filter((item) => item.entryKind === "file");
  return files.length > 0 ? files : items;
}

function getSkillFolderRelativePath(relativePath: string): string | null {
  const normalized = normalizeRel(relativePath);
  const parts = normalized.split("/").filter(Boolean);
  const skillsIndex = parts.indexOf("skills");
  const skillName = skillsIndex >= 0 ? parts[skillsIndex + 1] : undefined;
  if (!skillName) return null;
  return `skills/${skillName}`;
}

function isSkillManifestPath(relativePath: string): boolean {
  return /(^|\/)SKILL\.md$/i.test(normalizeRel(relativePath));
}

function isBehaviorPath(relativePath: string): boolean {
  const normalized = normalizeRel(relativePath).toLowerCase();
  return normalized.includes("prompt")
    || normalized.includes("system")
    || normalized.includes("instruction")
    || normalized.includes("rules")
    || normalized.includes("agent");
}

function isConfigPath(relativePath: string): boolean {
  const normalized = normalizeRel(relativePath).toLowerCase();
  return /\.(json|ya?ml|toml|ini|cfg|env)$/.test(normalized);
}

function isSameSizeOrSmall(srcSize: number | null, dstSize: number | null): boolean {
  if (srcSize === null || dstSize === null) return true;
  return Math.abs(srcSize - dstSize) <= 50_000;
}

function isTargetNewerThanSource(item: TransferPlanItem): boolean {
  if (!item.srcMtime || !item.dstMtime) return false;
  const sourceTime = Date.parse(item.srcMtime);
  const targetTime = Date.parse(item.dstMtime);
  if (!Number.isFinite(sourceTime) || !Number.isFinite(targetTime)) return false;
  return targetTime > sourceTime;
}

function statusLabel(status: TransferStatus, language: UiLanguage): string {
  if (status === "added") return localize("New");
  if (status === "removed") return localize("Delete");
  if (status === "modified") return localize("Modified");
  if (status === "typeChanged") return localize("Type conflict");
  return localize("Same");
}

function reviewSeverityLabel(severity: ReviewSeverity): string {
  if (severity === "high") return localize("High");
  if (severity === "medium") return localize("Medium");
  return localize("Low");
}

function formatBytesForPrompt(value: number | null, language: UiLanguage): string {
  if (value === null) return localize("missing");
  return localize("{0} bytes", String(value));
}

function normalizeRel(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

function uniqueStrings(items: string[]): string[] {
  return [...new Set(items)];
}
