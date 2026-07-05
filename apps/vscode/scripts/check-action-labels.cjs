const fs = require("node:fs");
const path = require("node:path");

const root = process.cwd();
const actionKeyPattern = /^(command|submenu|view)\./;
const hangulPattern = /[가-힣]/;
const mixedActionTerms = /\b(Overview|Workspace|Quick Tools)\b/;
const files = ["package.nls.json", "package.nls.ko.json"];

const failures = [];

for (const fileName of files) {
  const filePath = path.join(root, fileName);
  const labels = JSON.parse(fs.readFileSync(filePath, "utf8"));
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
}

for (const [fileName, keys] of [
  ["package.nls.json", ["config.visibleQuickTools.description", "config.autoSyncWorkspaceAgents.description"]],
  ["package.nls.ko.json", ["config.visibleQuickTools.description", "config.autoSyncWorkspaceAgents.description"]]
]) {
  const labels = JSON.parse(fs.readFileSync(path.join(root, fileName), "utf8"));
  for (const key of keys) {
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
