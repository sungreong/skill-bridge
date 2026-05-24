import type { TransferPlan, TransferPlanItem, TransferStatus } from "./types";

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

export function buildTransferReviewMeta(plan: TransferPlan): TransferReviewMeta {
  const skillFoldersWithManifest = new Set<string>();
  for (const item of plan.items) {
    if (isSkillManifestPath(item.relativePath)) {
      const folder = getSkillFolderRelativePath(item.relativePath);
      if (folder) skillFoldersWithManifest.add(`${item.tool}:${folder}`);
    }
  }

  const items: Record<string, TransferReviewItem> = {};
  for (const item of plan.items) {
    items[item.key] = analyzeTransferItem(item, skillFoldersWithManifest);
  }

  return {
    generatedAt: new Date().toISOString(),
    items
  };
}

export function buildAgentReviewPrompt(plan: TransferPlan, selectedKeys: Set<string>): string {
  const review = buildTransferReviewMeta(plan);
  const selected = plan.items.filter((item) => selectedKeys.has(item.key));
  const selectedReview = selected.map((item) => ({ item, review: review.items[item.key] }));
  const riskCounts = countRisks(selectedReview.map((entry) => entry.review));
  const statusCounts = countStatuses(selected);
  const direction = plan.mode === "workspaceToCentral"
    ? "Workspace -> Central"
    : "Central -> Workspace";
  const sourceLabel = plan.mode === "workspaceToCentral" ? "workspace" : "central";
  const targetLabel = plan.mode === "workspaceToCentral" ? "central" : "workspace";
  const selectedChanged = selected.filter((item) => item.status !== "same");
  const predictedBaseItems = getStatsBaseItems(selected);
  const predictedCreate = predictedBaseItems.filter((item) => item.status === "added").length;
  const predictedOverwrite = predictedBaseItems.filter((item) => item.status === "modified" || item.status === "typeChanged").length;
  const predictedDelete = predictedBaseItems.filter((item) => item.status === "removed").length;
  const maxRows = 80;

  const lines: string[] = [
    "# Skill Bridge Transfer Review",
    "",
    "You are reviewing a pending Skill Bridge transfer before the user manually applies it.",
    "Do not execute changes, do not auto-merge, and do not suggest turning this into a skill runner or Git GUI.",
    "Give a practical recommendation: proceed, cancel, or inspect specific files first.",
    "",
    "## Context",
    `- Direction: ${direction}`,
    `- Source side: ${sourceLabel}`,
    `- Target side: ${targetLabel}`,
    `- Group: ${plan.groupContext ? `${plan.groupContext.name} (${plan.groupContext.side})` : "none"}`,
    `- Repository context: ${plan.repoContext?.repo ?? "none"}`,
    `- Selected rows: ${selected.length}`,
    `- Selected changed rows: ${selectedChanged.length}`,
    `- Generated at: ${review.generatedAt}`,
    "- Absolute filesystem paths and full file contents are intentionally omitted.",
    "",
    "## Selected Summary",
    `- New on target: ${statusCounts.added}`,
    `- Type conflicts: ${statusCounts.typeChanged}`,
    `- Modified target: ${statusCounts.modified}`,
    `- Delete from target: ${statusCounts.removed}`,
    `- Overwrite/type-conflict rows: ${statusCounts.modified + statusCounts.typeChanged}`,
    `- Same/no-op rows: ${statusCounts.same}`,
    `- Predicted create/overwrite/delete: ${predictedCreate}/${predictedOverwrite}/${predictedDelete}`,
    `- Risk counts: high ${riskCounts.high}, medium ${riskCounts.medium}, low ${riskCounts.low}`,
    "",
    "## Review Checklist",
    "- Is the transfer direction correct for the user's intent?",
    "- Are any SKILL.md, system prompt, model, permission, or config files changed?",
    "- Are deletions or file/folder type conflicts intentional?",
    "- Could this overwrite a newer target-side version the user still needs?",
    "- Is a manual diff inspection required before applying?",
    "",
    "## Selected Items"
  ];

  if (selected.length === 0) {
    lines.push("- No rows are selected.");
  }

  for (const { item, review: itemReview } of selectedReview.slice(0, maxRows)) {
    lines.push(
      [
        `- ${item.tool}/${item.relativePath}`,
        `  - kind: ${item.entryKind}`,
        `  - status: ${item.status} (${item.reason})`,
        `  - group: ${item.groupName ?? "none"} (${item.groupType})`,
        `  - source mtime/size: ${item.srcMtime ?? "missing"} / ${formatBytesForPrompt(item.srcSize)}`,
        `  - target mtime/size: ${item.dstMtime ?? "missing"} / ${formatBytesForPrompt(item.dstSize)}`,
        `  - risk: ${itemReview.severity}`,
        `  - tags: ${itemReview.tags.join(", ") || "none"}`,
        `  - notes: ${itemReview.notes.join(" | ") || "none"}`
      ].join("\n")
    );
  }

  if (selected.length > maxRows) {
    lines.push(`- ${selected.length - maxRows} additional selected rows omitted from this prompt. Ask the user to narrow the selection if needed.`);
  }

  lines.push(
    "",
    "## Expected Answer",
    "Return a short Korean review with:",
    "1. Overall recommendation: proceed / inspect first / cancel.",
    "2. Top risks in plain language.",
    "3. Exact files the user should open in Diff before applying.",
    "4. Any realistic fix inside the Skill Bridge workflow, without auto-merging or executing changes."
  );

  return lines.join("\n");
}

function analyzeTransferItem(item: TransferPlanItem, skillFoldersWithManifest: Set<string>): TransferReviewItem {
  const draft: RiskDraft = { severity: "low", tags: [], notes: [] };
  const skillFolder = getSkillFolderRelativePath(item.relativePath);
  const folderKey = skillFolder ? `${item.tool}:${skillFolder}` : null;

  if (item.status === "removed") {
    addRisk(draft, "high", "삭제 예정", "대상 쪽 파일 또는 폴더가 삭제될 수 있습니다.");
  }
  if (item.status === "typeChanged") {
    addRisk(draft, "high", "타입 충돌", "파일과 폴더 타입이 달라 덮어쓰기 전 확인이 필요합니다.");
  }
  if (item.status === "modified" && isSkillManifestPath(item.relativePath)) {
    addRisk(draft, "high", "SKILL.md 변경", "스킬의 핵심 설명과 사용 조건이 바뀝니다.");
  }
  if ((item.status === "modified" || item.status === "typeChanged") && isTargetNewerThanSource(item)) {
    addRisk(draft, "high", "대상 쪽이 더 최신", "덮어쓰기 대상 파일의 수정 시각이 소스보다 최신입니다.");
  }
  if (item.status === "added" && isSkillManifestPath(item.relativePath)) {
    addRisk(draft, "medium", "새 스킬 매니페스트", "새 스킬이 대상 쪽에 추가됩니다.");
  }
  if (item.status === "modified" && isBehaviorPath(item.relativePath)) {
    addRisk(draft, "medium", "행동 지침 변경", "에이전트 응답 방식이나 작업 절차가 달라질 수 있습니다.");
  }
  if (item.status !== "same" && isConfigPath(item.relativePath)) {
    addRisk(draft, "medium", "설정 파일", "모델, 옵션, 권한 또는 도구 설정 변경 가능성이 있습니다.");
  }
  if (item.entryKind === "folder" && item.status !== "same") {
    addRisk(draft, "medium", "폴더 단위 전송", "하위 항목 여러 개가 한 번에 반영될 수 있습니다.");
  }
  if (item.status !== "same" && !isSameSizeOrSmall(item.srcSize, item.dstSize)) {
    addRisk(draft, "medium", "큰 크기 변화", "파일 크기 차이가 커서 의도한 변경인지 확인이 좋습니다.");
  }
  if (folderKey && !skillFoldersWithManifest.has(folderKey) && item.entryKind === "folder") {
    addRisk(draft, "high", "전송 범위 SKILL.md 없음", "현재 전송 계획에는 이 스킬 폴더의 SKILL.md 행이 보이지 않습니다.");
  }
  if (draft.tags.length === 0) {
    addRisk(draft, "low", statusLabel(item.status), "일반 변경입니다. 필요하면 Diff로 확인하세요.");
  }

  return {
    key: item.key,
    severity: draft.severity,
    tags: uniqueStrings(draft.tags),
    notes: uniqueStrings(draft.notes),
    checklist: buildItemChecklist(item, draft)
  };
}

function buildItemChecklist(item: TransferPlanItem, draft: RiskDraft): string[] {
  const checks = ["전송 방향 확인", "Diff 확인"];
  if (draft.severity === "high") checks.push("적용 전 수동 검토");
  if (item.status === "removed") checks.push("삭제 의도 확인");
  if (item.status === "typeChanged") checks.push("타입 충돌 확인");
  if (isSkillManifestPath(item.relativePath)) checks.push("SKILL.md 설명/트리거 확인");
  if (isConfigPath(item.relativePath)) checks.push("모델/권한/설정 확인");
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

function statusLabel(status: TransferStatus): string {
  if (status === "added") return "신규";
  if (status === "removed") return "삭제";
  if (status === "modified") return "수정";
  if (status === "typeChanged") return "타입 충돌";
  return "동일";
}

function formatBytesForPrompt(value: number | null): string {
  if (value === null) return "missing";
  return `${value} bytes`;
}

function normalizeRel(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

function uniqueStrings(items: string[]): string[] {
  return [...new Set(items)];
}
