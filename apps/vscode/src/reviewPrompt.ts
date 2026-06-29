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
  const t = (english: string, korean: string): string => localize(language, english, korean);
  const review = buildTransferReviewMeta(plan, language);
  const selected = plan.items.filter((item) => selectedKeys.has(item.key));
  const selectedReview = selected.map((item) => ({ item, review: review.items[item.key] }));
  const riskCounts = countRisks(selectedReview.map((entry) => entry.review));
  const statusCounts = countStatuses(selected);
  const direction = plan.mode === "workspaceToCentral"
    ? t("Workspace -> Central", "작업공간 -> 중앙")
    : t("Central -> Workspace", "중앙 -> 작업공간");
  const sourceLabel = plan.mode === "workspaceToCentral" ? t("workspace", "작업공간") : t("central", "중앙");
  const targetLabel = plan.mode === "workspaceToCentral" ? t("central", "중앙") : t("workspace", "작업공간");
  const selectedChanged = selected.filter((item) => item.status !== "same");
  const predictedBaseItems = getStatsBaseItems(selected);
  const predictedCreate = predictedBaseItems.filter((item) => item.status === "added").length;
  const predictedOverwrite = predictedBaseItems.filter((item) => item.status === "modified" || item.status === "typeChanged").length;
  const predictedDelete = predictedBaseItems.filter((item) => item.status === "removed").length;
  const maxRows = 80;

  const lines: string[] = [
    language === "ko" ? "# Skill Bridge 전송 검토" : "# Skill Bridge Transfer Review",
    "",
    t(
      "You are reviewing a pending Skill Bridge transfer before the user manually applies it.",
      "사용자가 수동으로 반영하기 전에 대기 중인 Skill Bridge 전송을 검토합니다."
    ),
    t(
      "Do not execute changes, do not auto-merge, and do not suggest turning this into a skill runner or Git GUI.",
      "변경을 실행하지 말고, 자동 병합하지 말고, 이 도구를 스킬 실행기나 Git GUI로 바꾸자고 제안하지 마세요."
    ),
    t(
      "Give a practical recommendation: proceed, cancel, or inspect specific files first.",
      "실용적인 권고를 제시하세요: 진행, 취소, 또는 특정 파일을 먼저 검토."
    ),
    "",
    t("## Context", "## 맥락"),
    `- ${t("Direction", "방향")}: ${direction}`,
    `- ${t("Source side", "원본 위치")}: ${sourceLabel}`,
    `- ${t("Target side", "대상 위치")}: ${targetLabel}`,
    `- ${t("Group", "그룹")}: ${plan.groupContext ? `${plan.groupContext.name} (${plan.groupContext.side})` : t("none", "없음")}`,
    `- ${t("Repository context", "저장소 컨텍스트")}: ${plan.repoContext?.repo ?? t("none", "없음")}`,
    `- ${t("Selected rows", "선택 행")}: ${selected.length}`,
    `- ${t("Selected changed rows", "선택된 변경 행")}: ${selectedChanged.length}`,
    `- ${t("Generated at", "생성 시각")}: ${review.generatedAt}`,
    `- ${t("Absolute filesystem paths and full file contents are intentionally omitted.", "절대 경로와 전체 파일 내용은 의도적으로 제외했습니다.")}`,
    "",
    t("## Selected Summary", "## 선택 요약"),
    `- ${t("New on target", "대상에 새로 추가")}: ${statusCounts.added}`,
    `- ${t("Type conflicts", "타입 충돌")}: ${statusCounts.typeChanged}`,
    `- ${t("Modified target", "대상 수정")}: ${statusCounts.modified}`,
    `- ${t("Delete from target", "대상 삭제")}: ${statusCounts.removed}`,
    `- ${t("Overwrite/type-conflict rows", "덮어쓰기/타입 충돌 행")}: ${statusCounts.modified + statusCounts.typeChanged}`,
    `- ${t("Same/no-op rows", "동일/무동작 행")}: ${statusCounts.same}`,
    `- ${t("Predicted create/overwrite/delete", "예상 생성/덮어쓰기/삭제")}: ${predictedCreate}/${predictedOverwrite}/${predictedDelete}`,
    `- ${t("Risk counts", "위험 개수")}: ${t("high", "높음")} ${riskCounts.high}, ${t("medium", "중간")} ${riskCounts.medium}, ${t("low", "낮음")} ${riskCounts.low}`,
    "",
    t("## Review Checklist", "## 검토 체크리스트"),
    `- ${t("Is the transfer direction correct for the user's intent?", "전송 방향이 사용자 의도와 맞나요?")}`,
    `- ${t("Are any SKILL.md, system prompt, model, permission, or config files changed?", "SKILL.md, 시스템 프롬프트, 모델, 권한, 설정 파일 변경이 있나요?")}`,
    `- ${t("Are deletions or file/folder type conflicts intentional?", "삭제나 파일/폴더 타입 충돌이 의도된 건가요?")}`,
    `- ${t("Could this overwrite a newer target-side version the user still needs?", "사용자가 아직 필요한 더 최신 대상 버전을 덮어쓸 수 있나요?")}`,
    `- ${t("Is a manual diff inspection required before applying?", "반영 전에 수동 diff 확인이 필요한가요?")}`,
    "",
    t("## Selected Items", "## 선택 항목")
  ];

  if (selected.length === 0) {
    lines.push(`- ${t("No rows are selected.", "선택된 행이 없습니다.")}`);
  }

  for (const { item, review: itemReview } of selectedReview.slice(0, maxRows)) {
    lines.push(
      [
        `- ${item.tool}/${item.relativePath}`,
        `  - ${t("kind", "종류")}: ${item.entryKind}`,
        `  - ${t("status", "상태")}: ${statusLabel(item.status, language)} (${item.reason})`,
        `  - ${t("group", "그룹")}: ${item.groupName ?? t("none", "없음")} (${item.groupType})`,
        `  - ${t("source mtime/size", "원본 수정시각/크기")}: ${item.srcMtime ?? t("missing", "없음")} / ${formatBytesForPrompt(item.srcSize, language)}`,
        `  - ${t("target mtime/size", "대상 수정시각/크기")}: ${item.dstMtime ?? t("missing", "없음")} / ${formatBytesForPrompt(item.dstSize, language)}`,
        `  - ${t("risk", "위험")}: ${localize(language, itemReview.severity, itemReview.severity === "high" ? "높음" : itemReview.severity === "medium" ? "중간" : "낮음")}`,
        `  - ${t("tags", "태그")}: ${itemReview.tags.join(", ") || t("none", "없음")}`,
        `  - ${t("notes", "메모")}: ${itemReview.notes.join(" | ") || t("none", "없음")}`
      ].join("\n")
    );
  }

  if (selected.length > maxRows) {
    lines.push(`- ${localize(language, `${selected.length - maxRows} additional selected rows omitted from this prompt. Ask the user to narrow the selection if needed.`, `선택된 행 ${selected.length - maxRows}개는 이 프롬프트에서 생략했습니다. 필요하면 선택 범위를 좁히도록 안내하세요.`)}`);
  }

  lines.push(
    "",
    t("## Expected Answer", "## 기대 답변"),
    t("Return a short review with:", "짧은 검토 답변을 다음 형식으로 작성하세요:"),
    t("1. Overall recommendation: proceed / inspect first / cancel.", "1. 전체 권고: 진행 / 먼저 검토 / 취소."),
    t("2. Top risks in plain language.", "2. 핵심 위험을 쉬운 말로 설명."),
    t("3. Exact files the user should open in Diff before applying.", "3. 반영 전에 Diff로 열어야 할 정확한 파일."),
    t("4. Any realistic fix inside the Skill Bridge workflow, without auto-merging or executing changes.", "4. 자동 병합이나 실제 실행 없이, Skill Bridge 흐름 안에서 가능한 현실적인 대응.")
  );

  return lines.join("\n");
}

function analyzeTransferItem(item: TransferPlanItem, skillFoldersWithManifest: Set<string>, language: UiLanguage): TransferReviewItem {
  const draft: RiskDraft = { severity: "low", tags: [], notes: [] };
  const skillFolder = getSkillFolderRelativePath(item.relativePath);
  const folderKey = skillFolder ? `${item.tool}:${skillFolder}` : null;

  if (item.status === "removed") {
    addRisk(draft, "high", localize(language, "Delete planned", "삭제 예정"), localize(language, "A file or folder on the target side may be deleted.", "대상 쪽 파일 또는 폴더가 삭제될 수 있습니다."));
  }
  if (item.status === "typeChanged") {
    addRisk(draft, "high", localize(language, "Type conflict", "타입 충돌"), localize(language, "The file/folder types differ, so review is required before overwrite.", "파일과 폴더 타입이 달라 덮어쓰기 전 확인이 필요합니다."));
  }
  if (item.status === "modified" && isSkillManifestPath(item.relativePath)) {
    addRisk(draft, "high", localize(language, "SKILL.md changed", "SKILL.md 변경"), localize(language, "The skill's core description or usage conditions change.", "스킬의 핵심 설명과 사용 조건이 바뀝니다."));
  }
  if ((item.status === "modified" || item.status === "typeChanged") && isTargetNewerThanSource(item)) {
    addRisk(draft, "high", localize(language, "Target is newer", "대상 쪽이 더 최신"), localize(language, "The target file's modified time is newer than the source.", "덮어쓰기 대상 파일의 수정 시각이 소스보다 최신입니다."));
  }
  if (item.status === "added" && isSkillManifestPath(item.relativePath)) {
    addRisk(draft, "medium", localize(language, "New skill manifest", "새 스킬 매니페스트"), localize(language, "A new skill will be added to the target side.", "새 스킬이 대상 쪽에 추가됩니다."));
  }
  if (item.status === "modified" && isBehaviorPath(item.relativePath)) {
    addRisk(draft, "medium", localize(language, "Behavior instructions changed", "행동 지침 변경"), localize(language, "The agent's response style or workflow may change.", "에이전트 응답 방식이나 작업 절차가 달라질 수 있습니다."));
  }
  if (item.status !== "same" && isConfigPath(item.relativePath)) {
    addRisk(draft, "medium", localize(language, "Config file", "설정 파일"), localize(language, "Model, option, permission, or tool settings may change.", "모델, 옵션, 권한 또는 도구 설정 변경 가능성이 있습니다."));
  }
  if (item.entryKind === "folder" && item.status !== "same") {
    addRisk(draft, "medium", localize(language, "Folder-level transfer", "폴더 단위 전송"), localize(language, "Several nested items may be applied at once.", "하위 항목 여러 개가 한 번에 반영될 수 있습니다."));
  }
  if (item.status !== "same" && !isSameSizeOrSmall(item.srcSize, item.dstSize)) {
    addRisk(draft, "medium", localize(language, "Large size change", "큰 크기 변화"), localize(language, "The file size difference is large, so confirm it is intentional.", "파일 크기 차이가 커서 의도한 변경인지 확인이 좋습니다."));
  }
  if (folderKey && !skillFoldersWithManifest.has(folderKey) && item.entryKind === "folder") {
    addRisk(draft, "high", localize(language, "SKILL.md missing from transfer scope", "전송 범위 SKILL.md 없음"), localize(language, "This transfer plan does not include a SKILL.md row for the skill folder.", "현재 전송 계획에는 이 스킬 폴더의 SKILL.md 행이 보이지 않습니다."));
  }
  if (draft.tags.length === 0) {
    addRisk(
      draft,
      "low",
      statusLabel(item.status, language),
      localize(language, "General change. Open Diff if needed.", "일반 변경입니다. 필요하면 Diff로 확인하세요.")
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
    localize(language, "Check transfer direction", "전송 방향 확인"),
    localize(language, "Review Diff", "Diff 확인")
  ];
  if (draft.severity === "high") checks.push(localize(language, "Manual review before apply", "적용 전 수동 검토"));
  if (item.status === "removed") checks.push(localize(language, "Confirm delete intent", "삭제 의도 확인"));
  if (item.status === "typeChanged") checks.push(localize(language, "Confirm type conflict", "타입 충돌 확인"));
  if (isSkillManifestPath(item.relativePath)) checks.push(localize(language, "Check SKILL.md description/trigger", "SKILL.md 설명/트리거 확인"));
  if (isConfigPath(item.relativePath)) checks.push(localize(language, "Check model/permission/config", "모델/권한/설정 확인"));
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
  if (status === "added") return localize(language, "New", "신규");
  if (status === "removed") return localize(language, "Delete", "삭제");
  if (status === "modified") return localize(language, "Modified", "수정");
  if (status === "typeChanged") return localize(language, "Type conflict", "타입 충돌");
  return localize(language, "Same", "동일");
}

function formatBytesForPrompt(value: number | null, language: UiLanguage): string {
  if (value === null) return localize(language, "missing", "없음");
  return localize(language, `${value} bytes`, `${value}바이트`);
}

function normalizeRel(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

function uniqueStrings(items: string[]): string[] {
  return [...new Set(items)];
}
