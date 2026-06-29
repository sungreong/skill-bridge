const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_DIR = ".benchmarks";
const REQUIRED_OS = ["ubuntu-latest", "macos-latest", "windows-latest"];
const REQUIRED_NODE = ["20", "24"];
const REQUIRED_SYMLINK_OS = ["ubuntu-latest", "macos-latest"];

function readStringArg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function collectJsonFiles(inputDir) {
  if (!(await pathExists(inputDir))) return [];
  const entries = await fs.readdir(inputDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(inputDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectJsonFiles(entryPath));
      continue;
    }
    if (entry.isFile() && /^smoke-file-ops-.+\.json$/i.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function parseArtifactName(filePath) {
  const name = path.basename(filePath);
  const symlinkMatch = /^smoke-file-ops-symlink-(.+)-node(\d+)\.json$/i.exec(name);
  if (symlinkMatch) return { kind: "symlink", os: symlinkMatch[1], nodeMajor: symlinkMatch[2] };
  const baseMatch = /^smoke-file-ops-(.+)-node(\d+)\.json$/i.exec(name);
  if (baseMatch) return { kind: "base", os: baseMatch[1], nodeMajor: baseMatch[2] };
  return { kind: "unknown", os: "unknown", nodeMajor: "unknown" };
}

async function readSmoke(filePath) {
  const raw = (await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, "");
  const parsed = JSON.parse(raw);
  const inferred = parseArtifactName(filePath);
  return {
    filePath,
    kind: inferred.kind,
    os: inferred.os,
    nodeMajor: inferred.nodeMajor,
    platform: typeof parsed.platform === "string" ? parsed.platform : "",
    node: typeof parsed.node === "string" ? parsed.node : "",
    ok: parsed.ok === true,
    requireSymlinkCheck: parsed.requireSymlinkCheck === true,
    vscodeFileCount: Number(parsed.vscodeFileCount),
    unicodeVscodeFileCount: Number(parsed.unicodeVscodeFileCount),
    coreFileCount: Number(parsed.coreFileCount),
    unicodeCoreFileCount: Number(parsed.unicodeCoreFileCount),
    scopeEntryCount: Number(parsed.scopeEntryCount),
    unicodeScopeEntryCount: Number(parsed.unicodeScopeEntryCount),
    copiedFileCount: Number(parsed.copiedFileCount),
    copiedUnicodeFileCount: Number(parsed.copiedUnicodeFileCount),
    symlinkEscapeChecked: parsed.symlinkEscapeChecked === true,
    vscodeSymlinkEscapeChecked: parsed.vscodeSymlinkEscapeChecked === true,
    pathTraversalRejected: parsed.pathTraversalRejected === true,
    message: typeof parsed.message === "string" ? parsed.message : ""
  };
}

function buildMatrixFailures(smokes) {
  const basePresent = new Set(smokes.filter((item) => item.kind === "base").map((item) => `${item.os}:node${item.nodeMajor}`));
  const symlinkPresent = new Set(smokes.filter((item) => item.kind === "symlink").map((item) => `${item.os}:node${item.nodeMajor}`));
  const missing = [];
  for (const osName of REQUIRED_OS) {
    for (const nodeMajor of REQUIRED_NODE) {
      const key = `${osName}:node${nodeMajor}`;
      if (!basePresent.has(key)) missing.push(`base:${key}`);
    }
  }
  for (const osName of REQUIRED_SYMLINK_OS) {
    for (const nodeMajor of REQUIRED_NODE) {
      const key = `${osName}:node${nodeMajor}`;
      if (!symlinkPresent.has(key)) missing.push(`symlink:${key}`);
    }
  }
  return missing;
}

function buildArtifactFailures(smokes) {
  const failures = [];
  const counts = new Map();
  for (const smoke of smokes) {
    const key = `${smoke.kind}:${smoke.os}:node${smoke.nodeMajor}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (smoke.kind === "unknown") failures.push(`${key}: unknown smoke artifact name`);
    if (!smoke.ok) failures.push(`${key}: ok flag is not true${smoke.message ? ` (${smoke.message})` : ""}`);
    if (smoke.vscodeFileCount !== 3) failures.push(`${key}: vscodeFileCount ${smoke.vscodeFileCount}`);
    if (smoke.unicodeVscodeFileCount !== 3) failures.push(`${key}: unicodeVscodeFileCount ${smoke.unicodeVscodeFileCount}`);
    if (smoke.coreFileCount !== 3) failures.push(`${key}: coreFileCount ${smoke.coreFileCount}`);
    if (smoke.unicodeCoreFileCount !== 3) failures.push(`${key}: unicodeCoreFileCount ${smoke.unicodeCoreFileCount}`);
    if (smoke.scopeEntryCount !== 6) failures.push(`${key}: scopeEntryCount ${smoke.scopeEntryCount}`);
    if (smoke.unicodeScopeEntryCount !== 6) failures.push(`${key}: unicodeScopeEntryCount ${smoke.unicodeScopeEntryCount}`);
    if (smoke.copiedFileCount !== 3) failures.push(`${key}: copiedFileCount ${smoke.copiedFileCount}`);
    if (smoke.copiedUnicodeFileCount !== 3) failures.push(`${key}: copiedUnicodeFileCount ${smoke.copiedUnicodeFileCount}`);
    if (!smoke.pathTraversalRejected) failures.push(`${key}: path traversal was not rejected`);
    if (smoke.kind === "symlink") {
      if (!smoke.requireSymlinkCheck) failures.push(`${key}: requireSymlinkCheck is not true`);
      if (!smoke.symlinkEscapeChecked) failures.push(`${key}: core symlink escape check did not run`);
      if (!smoke.vscodeSymlinkEscapeChecked) failures.push(`${key}: vscode symlink escape check did not run`);
    }
  }
  for (const [key, count] of counts.entries()) {
    if (count > 1) failures.push(`${key}: duplicate artifact count ${count}`);
  }
  return failures;
}

function formatMarkdown(smokes, missingMatrix, artifactFailures) {
  const lines = [
    "## Skill Bridge File Operations Smoke Artifact Comparison",
    "",
    `- Artifacts: ${smokes.length}`,
    `- Matrix gaps: ${missingMatrix.length === 0 ? "none" : missingMatrix.join(", ")}`,
    `- Artifact failures: ${artifactFailures.length === 0 ? "none" : artifactFailures.length}`,
    "",
    "| Kind | OS | Node | Platform | Runtime | Traversal rejected | Symlink checked |",
    "| --- | --- | ---: | --- | --- | --- | --- |"
  ];
  for (const smoke of smokes) {
    lines.push(`| ${smoke.kind} | ${smoke.os} | ${smoke.nodeMajor} | ${smoke.platform} | ${smoke.node} | ${smoke.pathTraversalRejected ? "yes" : "no"} | ${smoke.symlinkEscapeChecked && smoke.vscodeSymlinkEscapeChecked ? "yes" : "no"} |`);
  }
  if (artifactFailures.length > 0) {
    lines.push("", "### Artifact Failures", "");
    for (const failure of artifactFailures) lines.push(`- ${failure}`);
  }
  return `${lines.join("\n")}\n`;
}

async function writeSummaryIfRequested(markdown, summaryPath) {
  if (!summaryPath) return;
  await fs.mkdir(path.dirname(path.resolve(summaryPath)), { recursive: true });
  await fs.writeFile(summaryPath, markdown, "utf8");
}

async function run() {
  const inputDir = readStringArg("--dir", DEFAULT_DIR);
  const summaryPath = readStringArg("--summary");
  const requireMatrix = hasFlag("--require-matrix");
  const files = await collectJsonFiles(inputDir);
  const smokes = [];
  for (const filePath of files) smokes.push(await readSmoke(filePath));
  smokes.sort((left, right) => left.kind.localeCompare(right.kind) || left.os.localeCompare(right.os) || left.nodeMajor.localeCompare(right.nodeMajor));

  const missingMatrix = buildMatrixFailures(smokes);
  const artifactFailures = buildArtifactFailures(smokes);
  const markdown = formatMarkdown(smokes, missingMatrix, artifactFailures);
  await writeSummaryIfRequested(markdown, summaryPath);
  console.log(markdown);

  if (smokes.length === 0 || artifactFailures.length > 0 || (requireMatrix && missingMatrix.length > 0)) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[compare-smoke-file-ops-artifacts] ${message}`);
  process.exitCode = 1;
});
