const fs = require("node:fs");
const path = require("node:path");

const root = process.cwd();
const sourceRoot = path.join(root, "src");
const l10nRoot = path.join(root, "l10n");
const failures = [];
const hangulPattern = /[가-힣]/;

const manifest = readJson(path.join(root, "package.json"));
const englishBundle = readJson(path.join(l10nRoot, "bundle.l10n.json"));
const koreanBundle = readJson(path.join(l10nRoot, "bundle.l10n.ko.json"));
const englishManifestLabels = readJson(path.join(root, "package.nls.json"));
const koreanManifestLabels = readJson(path.join(root, "package.nls.ko.json"));

if (manifest.l10n !== "./l10n") {
  failures.push(`package.json: l10n must be "./l10n", received ${JSON.stringify(manifest.l10n)}`);
}

const localeFiles = fs.readdirSync(l10nRoot)
  .filter((name) => name.startsWith("bundle.l10n") && name.endsWith(".json"))
  .sort();
const supportedLocaleFiles = ["bundle.l10n.json", "bundle.l10n.ko.json"];
if (JSON.stringify(localeFiles) !== JSON.stringify(supportedLocaleFiles)) {
  failures.push(`l10n: only English and Korean bundles are supported; found ${localeFiles.join(", ")}`);
}

compareKeySets("runtime bundles", englishBundle, koreanBundle);
compareKeySets("manifest localization files", englishManifestLabels, koreanManifestLabels);
for (const [message, value] of Object.entries(englishBundle)) {
  if (message !== value) failures.push(`bundle.l10n.json: source entry must map to itself: ${JSON.stringify(message)}`);
  if (hangulPattern.test(message)) failures.push(`bundle.l10n.json: English source key contains Korean text: ${JSON.stringify(message)}`);
}

const sourceMessages = new Set();
for (const sourcePath of listFiles(sourceRoot, ".ts")) {
  const text = fs.readFileSync(sourcePath, "utf8");
  const relativePath = path.relative(root, sourcePath);
  if (hangulPattern.test(text)) {
    failures.push(`${relativePath}: runtime source must not contain Korean UI literals`);
  }
  collectLiteralCallMessages(text, sourceMessages, relativePath);
  if (path.basename(sourcePath) === "addMoveWizardView.ts") {
    collectAddMoveCopyMessages(text, sourceMessages);
  }
}

for (const message of [...sourceMessages].sort()) {
  if (englishBundle[message] !== message) {
    failures.push(`bundle.l10n.json: missing source message ${JSON.stringify(message)}`);
  }
  if (typeof koreanBundle[message] !== "string" || koreanBundle[message].length === 0) {
    failures.push(`bundle.l10n.ko.json: missing Korean translation for ${JSON.stringify(message)}`);
  }
}
for (const message of Object.keys(englishBundle)) {
  if (!sourceMessages.has(message)) {
    failures.push(`bundle.l10n.json: unused runtime message ${JSON.stringify(message)}`);
  }
}

for (const [message, translation] of Object.entries(koreanBundle)) {
  const sourcePlaceholders = placeholders(message);
  const translatedPlaceholders = placeholders(translation);
  if (JSON.stringify(sourcePlaceholders) !== JSON.stringify(translatedPlaceholders)) {
    failures.push(`bundle.l10n.ko.json: placeholder mismatch for ${JSON.stringify(message)} (${sourcePlaceholders.join(", ")} != ${translatedPlaceholders.join(", ")})`);
  }
}

const manifestText = JSON.stringify(manifest);
for (const legacyToken of [
  "skillBridge.language",
  "skillBridge.toggleLanguage",
  "skillBridge.menu.en.",
  "skillBridge.menu.ko.",
  "skillBridge.isKoreanUi"
]) {
  if (manifestText.includes(legacyToken)) {
    failures.push(`package.json: legacy custom-language token remains: ${legacyToken}`);
  }
}

const vscodeIgnore = fs.readFileSync(path.join(root, ".vscodeignore"), "utf8");
if (!vscodeIgnore.split(/\r?\n/).includes("!l10n/**")) {
  failures.push(".vscodeignore: !l10n/** is required so runtime bundles are packaged");
}

if (failures.length > 0) {
  console.error("Skill Bridge localization check failed.");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Skill Bridge localization check passed (${sourceMessages.size} runtime messages, English/Korean only).`);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function listFiles(directory, extension) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(entryPath, extension));
    if (entry.isFile() && entry.name.endsWith(extension)) files.push(entryPath);
  }
  return files;
}

function compareKeySets(label, left, right) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (JSON.stringify(leftKeys) === JSON.stringify(rightKeys)) return;
  const leftOnly = leftKeys.filter((key) => !(key in right));
  const rightOnly = rightKeys.filter((key) => !(key in left));
  failures.push(`${label}: key sets differ (English only: ${leftOnly.join(", ") || "none"}; Korean only: ${rightOnly.join(", ") || "none"})`);
}

function collectLiteralCallMessages(text, messages, relativePath) {
  const callPattern = /\b(?:tr|localize|t)\(\s*"((?:\\.|[^"\\])*)"/g;
  let match = callPattern.exec(text);
  while (match) {
    try {
      messages.add(JSON.parse(`"${match[1]}"`));
    } catch {
      failures.push(`${relativePath}: could not parse localization source string ${JSON.stringify(match[1])}`);
    }
    match = callPattern.exec(text);
  }
}

function collectAddMoveCopyMessages(text, messages) {
  const start = text.indexOf("const copy = {");
  const end = text.indexOf("${renderWebviewL10nRuntime()}", start);
  if (start < 0 || end < 0) {
    failures.push("src/addMoveWizardView.ts: could not locate the webview copy catalog");
    return;
  }
  const copyBlock = text.slice(start, end);
  const valuePattern = /(?:\w+\s*:\s*|\[\s*|,\s*)"((?:\\.|[^"\\])*)"/g;
  let match = valuePattern.exec(copyBlock);
  while (match) {
    messages.add(JSON.parse(`"${match[1]}"`));
    match = valuePattern.exec(copyBlock);
  }
}

function placeholders(value) {
  return [...String(value).matchAll(/\{(\d+)\}/g)].map((match) => Number(match[1])).sort((a, b) => a - b);
}
