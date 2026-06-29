const fs = require("fs");
const path = require("path");

const WARN_LINES = 900;
const MAX_LINES = 1000;
const ROOT = process.cwd();
const TARGET_DIRS = ["apps", "packages", "scripts"];
const ALLOWED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".cjs", ".mjs"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);
const LEGACY_ALLOWLIST = new Set();

function walk(dir, rows = []) {
  if (!fs.existsSync(dir)) return rows;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, rows);
      continue;
    }
    if (!ALLOWED_EXTENSIONS.has(path.extname(entry.name))) continue;
    const relative = path.relative(ROOT, full);
    const lineCount = fs.readFileSync(full, "utf8").split(/\r?\n/).length;
    rows.push({ relative, lineCount });
  }
  return rows;
}

const rows = TARGET_DIRS.flatMap((dir) => walk(path.join(ROOT, dir)));
const hardFailures = rows.filter((row) => row.lineCount > MAX_LINES && !LEGACY_ALLOWLIST.has(path.normalize(row.relative)));
const legacyWarnings = rows.filter((row) => row.lineCount > MAX_LINES && LEGACY_ALLOWLIST.has(path.normalize(row.relative)));
const nearLimitWarnings = rows.filter(
  (row) => row.lineCount >= WARN_LINES && row.lineCount <= MAX_LINES
);

if (legacyWarnings.length > 0) {
  console.log("[max-lines] Legacy allowlist:");
  for (const row of legacyWarnings.sort((a, b) => b.lineCount - a.lineCount)) {
    console.log(`  ${row.lineCount}  ${row.relative}`);
  }
}

if (nearLimitWarnings.length > 0) {
  console.log(`[max-lines] Warning: files at or above ${WARN_LINES} lines should be split soon:`);
  for (const row of nearLimitWarnings.sort((a, b) => b.lineCount - a.lineCount)) {
    console.log(`  ${row.lineCount}  ${row.relative}`);
  }
}

if (hardFailures.length > 0) {
  console.error(`[max-lines] Files over ${MAX_LINES} lines must be split into smaller modules:`);
  for (const row of hardFailures.sort((a, b) => b.lineCount - a.lineCount)) {
    console.error(`  ${row.lineCount}  ${row.relative}`);
  }
  process.exit(1);
}

console.log(`[max-lines] OK. No new files exceed ${MAX_LINES} lines.`);
