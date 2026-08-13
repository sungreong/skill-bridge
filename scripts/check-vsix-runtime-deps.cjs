const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");

function readStringArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
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
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileName = buffer.toString("utf8", offset + 46, offset + 46 + fileNameLength);
    entries.set(fileName.replace(/\\/g, "/"), {
      compressionMethod,
      compressedSize,
      uncompressedSize,
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

async function defaultVsixPath(repoRoot) {
  const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "apps", "vscode", "package.json"), "utf8"));
  return path.join(repoRoot, "apps", "vscode", `skill-bridge-vscode-${packageJson.version}.vsix`);
}

async function run() {
  const repoRoot = path.resolve(__dirname, "..");
  const vsixPath = path.resolve(readStringArg("--vsix", await defaultVsixPath(repoRoot)));
  if (!await pathExists(vsixPath)) {
    throw new Error(`VSIX file does not exist: ${vsixPath}`);
  }

  const buffer = await fs.readFile(vsixPath);
  const entries = readZipEntries(buffer);
  const requiredEntries = [
    "extension/CHANGELOG.md",
    "extension/dist/vendor/core.js",
    "extension/dist/vendor/core-runtime/index.js",
    "extension/dist/vendor/core-runtime/shared.js",
    "extension/dist/vendor/core-runtime/node_modules/diff/package.json",
    "extension/dist/vendor/core-runtime/node_modules/diff/libcjs/index.js",
    "extension/dist/extension.js"
  ];
  const failures = requiredEntries
    .filter((entryName) => !entries.has(entryName))
    .map((entryName) => `missing VSIX entry: ${entryName}`);
  for (const entryName of entries.keys()) {
    if (isForbiddenRuntimeEntry(entryName)) {
      failures.push(`forbidden VSIX runtime entry: ${entryName}`);
    }
  }

  const bridgeEntry = entries.get("extension/dist/vendor/core.js");
  if (bridgeEntry) {
    const bridgeText = readZipEntryText(buffer, bridgeEntry);
    if (!bridgeText.includes('require("./core-runtime/index.js")')) {
      failures.push("extension/dist/vendor/core.js must require ./core-runtime/index.js");
    }
  }

  const extensionEntry = entries.get("extension/dist/extension.js");
  if (extensionEntry) {
    const extensionText = readZipEntryText(buffer, extensionEntry);
    if (!extensionText.includes('require("./vendor/core")')) {
      failures.push("extension/dist/extension.js must load ./vendor/core");
    }
  }

  if (failures.length > 0) {
    console.error("[vsix-runtime-deps] VSIX runtime dependency check failed:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log(`[vsix-runtime-deps] OK. ${path.relative(repoRoot, vsixPath)} contains the dist-local core runtime and diff package.`);
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[vsix-runtime-deps] ${message}`);
  process.exitCode = 1;
});
