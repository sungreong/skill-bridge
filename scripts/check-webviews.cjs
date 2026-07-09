#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const root = process.cwd();

const webviewFiles = [
  "apps/vscode/src/addMoveWizardView.ts",
  "apps/vscode/src/comparedTransferExplorerView.ts",
  "apps/vscode/src/libraryManagerView.ts",
  "apps/vscode/src/transferManagerView.ts",
  "apps/vscode/src/groupOverviewRender.ts",
  "apps/vscode/src/npxSkillLibraryView.ts",
  "apps/vscode/src/projectPresetOverviewView.ts",
  "apps/vscode/src/transferDiffViews.ts",
  "apps/vscode/src/groupMetadata.ts"
];

const interactiveFiles = new Set([
  "apps/vscode/src/addMoveWizardView.ts",
  "apps/vscode/src/comparedTransferExplorerView.ts",
  "apps/vscode/src/libraryManagerView.ts",
  "apps/vscode/src/transferManagerView.ts",
  "apps/vscode/src/groupOverviewRender.ts",
  "apps/vscode/src/npxSkillLibraryView.ts",
  "apps/vscode/src/projectPresetOverviewView.ts"
]);

const failures = [];

for (const relativePath of webviewFiles) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) {
    failures.push(`${relativePath}: file is missing`);
    continue;
  }

  const source = fs.readFileSync(absolutePath, "utf8");
  requireContains(relativePath, source, "Content-Security-Policy", "CSP meta tag");
  requireContains(relativePath, source, "default-src 'none'", "locked down default-src");
  requireContains(relativePath, source, "createWebviewNonce", "shared nonce helper");
  requireContains(relativePath, source, "renderWebviewCommonStyles", "shared webview styles");
  requireContains(relativePath, source, "sb-root", "common root class");

  if (interactiveFiles.has(relativePath)) {
    requireContains(relativePath, source, "sb-status-bar", "common status bar class");
  }
}

if (failures.length > 0) {
  console.error("Webview standard check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Webview standard check passed (${webviewFiles.length} files).`);

function requireContains(relativePath, source, needle, label) {
  if (!source.includes(needle)) failures.push(`${relativePath}: missing ${label} (${needle})`);
}
