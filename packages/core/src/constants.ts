import type { ToolType } from "./types";

export const GLOBAL_WORKSPACE_ID = "ws-global-default";
export const GLOBAL_WORKSPACE_NAME = "Global (Home)";

export const TOOL_PATHS: Record<ToolType, { workspace: string; central: string }> = {
  claude: { workspace: ".claude", central: "claude" },
  codex: { workspace: ".codex", central: "codex" },
  gemini: { workspace: ".gemini", central: "gemini" },
  cursor: { workspace: ".cursor", central: "cursor" },
  antigravity: { workspace: ".antigravity", central: "antigravity" },
  agents: { workspace: ".agents", central: "agents" }
};

export const INSTRUCTION_ROOT = "instructions";

export const ROOT_INSTRUCTION_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "CODEX.md",
  "GEMINI.md",
  "CURSOR.md",
  "WINDSURF.md",
  "QWEN.md",
  "AIDER.md",
  "ROO.md",
  "JUNIE.md",
  ".cursorrules",
  ".windsurfrules",
  ".clinerules"
];

export const NESTED_INSTRUCTION_FILES = [
  ".github/copilot-instructions.md"
];

export const INSTRUCTION_RULE_DIRS = [
  { dir: ".cursor/rules", extensions: new Set([".mdc", ".md"]) },
  { dir: ".windsurf/rules", extensions: new Set([".md"]) }
];

export const SUPPORTED_INSTRUCTION_TARGETS = [
  ...ROOT_INSTRUCTION_FILES,
  ...NESTED_INSTRUCTION_FILES,
  ".cursor/rules/*.mdc",
  ".cursor/rules/*.md",
  ".windsurf/rules/*.md"
];

export const EDITABLE_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".yaml", ".yml", ".js", ".ts", ".tsx", ".jsx", ".sh", ".ps1", ".toml", ".ini", ".cfg", ".env"
]);

export const GLOBAL_IGNORED_DIR_NAMES = new Set([
  "backups",
  "backup",
  "cache",
  ".cache",
  "debug",
  "logs",
  "log",
  "tmp",
  "temp",
  ".tmp",
  ".temp",
  "sessions",
  "session",
  "history",
  "node_modules",
  ".git",
  "dist",
  "build"
]);

export const SENSITIVE_RULES: Array<{ rule: string; description: string; regex: RegExp }> = [
  { rule: "email", description: "이메일 패턴", regex: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi },
  { rule: "url", description: "URL 패턴", regex: /https?:\/\/[^\s]+/gi },
  { rule: "long-number", description: "긴 숫자열(8자리 이상)", regex: /\b\d{8,}\b/g },
  { rule: "card-like", description: "카드번호 유사 패턴", regex: /\b(?:\d[ -]*?){13,19}\b/g },
  { rule: "rrn-like", description: "주민번호 유사 패턴", regex: /\b\d{6}-?[1-4]\d{6}\b/g },
  { rule: "internal-domain", description: "내부 도메인 문자열", regex: /\b[a-z0-9-]+\.(?:internal|corp|local)\b/gi }
];

export const SKILLS_ONLY_ERROR = "skills 폴더 하위만 관리할 수 있습니다.";
