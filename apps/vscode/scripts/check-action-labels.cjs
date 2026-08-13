const fs = require("node:fs");
const path = require("node:path");

const root = process.cwd();
const actionKeyPattern = /^(command|submenu|view)\./;
const hangulPattern = /[가-힣]/;
const mixedActionTerms = /\b(Overview|Workspace|Quick Tools)\b/;
const englishFiles = ["package.nls.json"];
const koreanFiles = ["package.nls.ko.json"];
const configActionKeys = ["config.visibleQuickTools.description", "config.autoSyncWorkspaceAgents.description"];

const failures = [];

for (const fileName of englishFiles) {
  const filePath = path.join(root, fileName);
  const labels = JSON.parse(fs.readFileSync(filePath, "utf8"));
  for (const [key, value] of Object.entries(labels)) {
    if (!actionKeyPattern.test(key)) continue;
    if (key === "viewContainer.title") continue;
    if (typeof value !== "string") continue;
    if (hangulPattern.test(value)) {
      failures.push(`${fileName}: ${key} should be English but contains Korean text: ${value}`);
    }
  }
  for (const key of configActionKeys) {
    const value = labels[key];
    if (typeof value !== "string") {
      failures.push(`${fileName}: ${key} is missing or not a string`);
      continue;
    }
    if (hangulPattern.test(value)) {
      failures.push(`${fileName}: ${key} should be English but contains Korean text: ${value}`);
    }
  }
}

for (const fileName of koreanFiles) {
  const labels = JSON.parse(fs.readFileSync(path.join(root, fileName), "utf8"));
  for (const [key, value] of Object.entries(labels)) {
    if (!actionKeyPattern.test(key)) continue;
    if (key === "viewContainer.title") continue;
    if (typeof value !== "string") continue;
    if (!hangulPattern.test(value)) {
      failures.push(`${fileName}: ${key} has no Korean label: ${value}`);
    }
    if (mixedActionTerms.test(value)) {
      failures.push(`${fileName}: ${key} contains mixed UI term: ${value}`);
    }
  }
  for (const key of configActionKeys) {
    const value = labels[key];
    if (typeof value !== "string") {
      failures.push(`${fileName}: ${key} is missing or not a string`);
      continue;
    }
    if (!hangulPattern.test(value)) {
      failures.push(`${fileName}: ${key} has no Korean label: ${value}`);
    }
    if (mixedActionTerms.test(value)) {
      failures.push(`${fileName}: ${key} contains mixed UI term: ${value}`);
    }
  }
}

const catalogLabels = extractCommonToolLabels(path.join(root, "src", "views", "commonToolCatalog.ts"));
const englishLabels = JSON.parse(fs.readFileSync(path.join(root, "package.nls.json"), "utf8"));
const koreanLabels = JSON.parse(fs.readFileSync(path.join(root, "package.nls.ko.json"), "utf8"));
const koreanRuntimeLabels = JSON.parse(fs.readFileSync(path.join(root, "l10n", "bundle.l10n.ko.json"), "utf8"));
for (const [command, label] of catalogLabels.entries()) {
  const key = command.replace(/^skillBridge\./, "command.");
  if (englishLabels[key] !== label) {
    failures.push(`package.nls.json: ${key} does not match Quick Tools English label: ${englishLabels[key]} !== ${label}`);
  }
  if (koreanLabels[key] !== koreanRuntimeLabels[label]) {
    failures.push(`package.nls.ko.json: ${key} does not match Quick Tools Korean runtime label: ${koreanLabels[key]} !== ${koreanRuntimeLabels[label]}`);
  }
}

const srcRoot = path.join(root, "src");
for (const sourcePath of listFiles(srcRoot, ".ts")) {
  const rel = path.relative(root, sourcePath);
  const text = fs.readFileSync(sourcePath, "utf8");
  const stringRegex = /(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  let match = stringRegex.exec(text);
  while (match) {
    const value = match[2];
    if (value.includes("\n")) {
      match = stringRegex.exec(text);
      continue;
    }
    if (value.includes("tr(") || value.includes("isKo ?")) {
      match = stringRegex.exec(text);
      continue;
    }
    if (hangulPattern.test(value) && mixedActionTerms.test(value)) {
      const line = text.slice(0, match.index).split(/\r?\n/).length;
      failures.push(`${rel}:${line} contains mixed Korean UI text: ${value}`);
    }
    match = stringRegex.exec(text);
  }
}

if (failures.length > 0) {
  console.error("Skill Bridge action label consistency check failed");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Skill Bridge action label consistency check passed.");

function listFiles(dirPath, extension) {
  const results = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFiles(entryPath, extension));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(extension)) {
      results.push(entryPath);
    }
  }
  return results;
}

function extractCommonToolLabels(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const labels = new Map();
  const blockRegex = /\{\s*kind:\s*"command"[\s\S]*?\n\s*\}/g;
  let blockMatch = blockRegex.exec(text);
  while (blockMatch) {
    const block = blockMatch[0];
    const command = /command:\s*"([^"]+)"/.exec(block)?.[1];
    const labelMatch = /label:\s*localize\(\s*"((?:\\"|[^"])*)"\)/.exec(block);
    if (command && labelMatch) {
      labels.set(command, unescapeTsString(labelMatch[1]));
    }
    blockMatch = blockRegex.exec(text);
  }
  return labels;
}

function unescapeTsString(value) {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}
