const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");

const DEFAULT_DIR = ".benchmarks/vsix-artifacts";
const REQUIRED_OS = ["ubuntu-latest", "macos-latest", "windows-latest"];
const REQUIRED_NODE = ["20", "24"];

function readStringArg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
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

async function collectVsixFiles(inputDir) {
  if (!await pathExists(inputDir)) return [];
  const entries = await fs.readdir(inputDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(inputDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectVsixFiles(entryPath));
      continue;
    }
    if (entry.isFile() && /\.vsix$/i.test(entry.name)) files.push(entryPath);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function parseArtifactIdentity(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  const match = /skill-bridge-vscode-(.+)-node(\d+)/i.exec(normalized);
  if (!match) return { os: "unknown", nodeMajor: "unknown" };
  return { os: match[1], nodeMajor: match[2] };
}

function findEndOfCentralDirectory(buffer) {
  const signature = 0x06054b50;
  const minimumSize = 22;
  for (let offset = buffer.length - minimumSize; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) return offset;
  }
  throw new Error("Could not find ZIP end of central directory.");
}

function readZipEntries(buffer) {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = new Map();
  let offset = centralDirectoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`Invalid ZIP central directory header at ${offset}.`);
    }
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileName = buffer.toString("utf8", offset + 46, offset + 46 + fileNameLength);
    entries.set(fileName.replace(/\\/g, "/"), {
      compressionMethod,
      compressedSize,
      localHeaderOffset
    });
    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function readZipEntryText(buffer, entry) {
  const offset = entry.localHeaderOffset;
  if (buffer.readUInt32LE(offset) !== 0x04034b50) {
    throw new Error(`Invalid ZIP local file header at ${offset}.`);
  }
  const fileNameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + fileNameLength + extraLength;
  const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.compressionMethod === 0) return compressed.toString("utf8");
  if (entry.compressionMethod === 8) return zlib.inflateRawSync(compressed).toString("utf8");
  throw new Error(`Unsupported ZIP compression method: ${entry.compressionMethod}.`);
}

function isForbiddenRuntimeEntry(entryName) {
  if (!entryName.startsWith("extension/dist/")) return false;
  if (entryName.endsWith(".map")) return true;
  if (entryName === "extension/dist/skillPaths.js") return true;
  if (entryName === "extension/dist/skillScanner.js") return true;
  if (entryName.includes("/node_modules/diff/dist/")) return true;
  if (entryName.includes("/node_modules/diff/libesm/")) return true;
  if (entryName.startsWith("extension/dist/vendor/core-runtime/node_modules/diff/") && entryName.endsWith(".md")) return true;
  return false;
}

async function inspectVsix(filePath) {
  const identity = parseArtifactIdentity(filePath);
  const failures = [];
  let entryCount = 0;
  try {
    const buffer = await fs.readFile(filePath);
    const entries = readZipEntries(buffer);
    entryCount = entries.size;
    const requiredEntries = [
      "extension/dist/vendor/core.js",
      "extension/dist/vendor/core-runtime/index.js",
      "extension/dist/vendor/core-runtime/shared.js",
      "extension/dist/extension.js"
    ];
    for (const entryName of requiredEntries) {
      if (!entries.has(entryName)) failures.push(`missing ${entryName}`);
    }
    for (const entryName of entries.keys()) {
      if (isForbiddenRuntimeEntry(entryName)) failures.push(`forbidden ${entryName}`);
    }
    const bridgeEntry = entries.get("extension/dist/vendor/core.js");
    if (bridgeEntry) {
      const bridgeText = readZipEntryText(buffer, bridgeEntry);
      if (!bridgeText.includes('require("./core-runtime/index.js")')) {
        failures.push("core bridge does not require ./core-runtime/index.js");
      }
    }
    const extensionEntry = entries.get("extension/dist/extension.js");
    if (extensionEntry) {
      const extensionText = readZipEntryText(buffer, extensionEntry);
      if (!extensionText.includes('require("./vendor/core")')) {
        failures.push("extension bundle does not require ./vendor/core");
      }
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  return { filePath, ...identity, entryCount, ok: failures.length === 0, failures };
}

function buildMatrixFailures(items) {
  const present = new Set(items.map((item) => `${item.os}:node${item.nodeMajor}`));
  const missing = [];
  for (const osName of REQUIRED_OS) {
    for (const nodeMajor of REQUIRED_NODE) {
      const key = `${osName}:node${nodeMajor}`;
      if (!present.has(key)) missing.push(key);
    }
  }
  return missing;
}

function buildArtifactFailures(items) {
  const failures = [];
  const counts = new Map();
  for (const item of items) {
    const key = `${item.os}:node${item.nodeMajor}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (item.os === "unknown" || item.nodeMajor === "unknown") failures.push(`${key}: unknown artifact identity`);
    for (const failure of item.failures) failures.push(`${key}: ${failure}`);
  }
  for (const [key, count] of counts.entries()) {
    if (count > 1) failures.push(`${key}: duplicate VSIX artifact count ${count}`);
  }
  return failures;
}

function formatMarkdown(items, matrixFailures, artifactFailures) {
  const lines = [
    "## Skill Bridge VSIX Artifact Comparison",
    "",
    `- Artifacts: ${items.length}`,
    `- Matrix gaps: ${matrixFailures.length === 0 ? "none" : matrixFailures.join(", ")}`,
    `- Artifact failures: ${artifactFailures.length === 0 ? "none" : artifactFailures.length}`,
    "",
    "| OS | Node | Entries | Runtime included |",
    "| --- | ---: | ---: | --- |"
  ];
  for (const item of items) {
    lines.push(`| ${item.os} | ${item.nodeMajor} | ${item.entryCount} | ${item.ok ? "yes" : "no"} |`);
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
  const files = await collectVsixFiles(inputDir);
  const items = [];
  for (const filePath of files) items.push(await inspectVsix(filePath));
  items.sort((left, right) => left.os.localeCompare(right.os) || left.nodeMajor.localeCompare(right.nodeMajor));

  const matrixFailures = buildMatrixFailures(items);
  const artifactFailures = buildArtifactFailures(items);
  const markdown = formatMarkdown(items, matrixFailures, artifactFailures);
  await writeSummaryIfRequested(markdown, summaryPath);
  console.log(markdown);

  if (items.length === 0 || artifactFailures.length > 0 || (requireMatrix && matrixFailures.length > 0)) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[compare-vsix-artifacts] ${message}`);
  process.exitCode = 1;
});
