const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const REQUIRED_OS = ["ubuntu-latest", "macos-latest", "windows-latest"];
const REQUIRED_NODE = ["20", "24"];
const SYMLINK_OS = ["ubuntu-latest", "macos-latest"];

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
});

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

async function writeStoredZip(filePath, entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.text, "utf8");
    const checksum = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt32LE(0, 10);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt32LE(0, 12);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);
    offset += localHeader.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const centralDirectoryOffset = offset;
  const centralDirectorySize = centralDirectory.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectorySize, 12);
  end.writeUInt32LE(centralDirectoryOffset, 16);
  end.writeUInt16LE(0, 20);

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Buffer.concat([...localParts, centralDirectory, end]));
}

function platformFor(osName) {
  if (osName.startsWith("windows")) return "win32";
  if (osName.startsWith("macos")) return "darwin";
  return "linux";
}

function benchmarkArtifact(osName, nodeMajor, preset) {
  const minSpeedupRequirements = {
    "core.copyDirectory": 1.1,
    "vscode.collectFiles": 1.1,
    "core.collectFiles": 1.1,
    "vscode.applyTransferQueueCore": 1.2,
    "vscode.transferPlanCore": 1.2
  };
  const speedupOperations = [
    ["core.copyDirectory", "control.serialCopyDirectory"],
    ["vscode.collectFiles", "control.serialCollectFiles"],
    ["core.collectFiles", "control.serialCollectFiles"],
    ["vscode.applyTransferQueueCore", "control.serialApplyTransferQueue"],
    ["vscode.transferPlanCore", "control.serialTransferPlan"]
  ];
  return {
    ok: true,
    os: osName,
    nodeMajor,
    options: { preset },
    platform: platformFor(osName),
    node: `v${nodeMajor}.0.0`,
    results: [
      {
        name: "core.copyDirectory",
        rounds: 1,
        minMs: 1,
        maxMs: 1,
        avgMs: 1,
        medianMs: 1,
        lastDetail: { copiedFiles: 9 }
      }
    ],
    minSpeedupRequirements,
    controlSpeedups: speedupOperations.map(([operation, control]) => ({
      operation,
      control,
      medianSpeedup: 2,
      avgSpeedup: 2
    })),
    correctnessFailures: [],
    speedupFailures: [],
    medianRegressions: []
  };
}

function smokeArtifact(kind, osName, nodeMajor) {
  const requiresSymlink = kind === "symlink";
  return {
    ok: true,
    platform: platformFor(osName),
    node: `v${nodeMajor}.0.0`,
    requireSymlinkCheck: requiresSymlink,
    vscodeFileCount: 3,
    unicodeVscodeFileCount: 3,
    coreFileCount: 3,
    unicodeCoreFileCount: 3,
    scopeEntryCount: 6,
    unicodeScopeEntryCount: 6,
    copiedFileCount: 3,
    copiedUnicodeFileCount: 3,
    symlinkEscapeChecked: requiresSymlink,
    vscodeSymlinkEscapeChecked: requiresSymlink,
    pathTraversalRejected: true
  };
}

async function writeBenchmarkMatrix(root, prefix, preset) {
  for (const osName of REQUIRED_OS) {
    for (const nodeMajor of REQUIRED_NODE) {
      await writeJson(
        path.join(root, `${prefix}-${osName}-node${nodeMajor}.json`),
        benchmarkArtifact(osName, nodeMajor, preset)
      );
    }
  }
}

async function writeSmokeMatrix(root) {
  for (const osName of REQUIRED_OS) {
    for (const nodeMajor of REQUIRED_NODE) {
      await writeJson(
        path.join(root, `smoke-file-ops-${osName}-node${nodeMajor}.json`),
        smokeArtifact("base", osName, nodeMajor)
      );
    }
  }
  for (const osName of SYMLINK_OS) {
    for (const nodeMajor of REQUIRED_NODE) {
      await writeJson(
        path.join(root, `smoke-file-ops-symlink-${osName}-node${nodeMajor}.json`),
        smokeArtifact("symlink", osName, nodeMajor)
      );
    }
  }
}

async function writeVsixMatrix(root) {
  const entries = [
    {
      name: "extension/dist/vendor/core.js",
      text: 'const core = require("./core-runtime/index.js");\nmodule.exports = core;\n'
    },
    {
      name: "extension/dist/vendor/core-runtime/index.js",
      text: 'exports.collectFiles = async () => [];\n'
    },
    {
      name: "extension/dist/vendor/core-runtime/shared.js",
      text: 'exports.copyDirectory = async () => undefined;\n'
    },
    {
      name: "extension/dist/extension.js",
      text: 'const core = require("./vendor/core");\nexports.activate = async () => core.collectFiles;\n'
    }
  ];
  for (const osName of REQUIRED_OS) {
    for (const nodeMajor of REQUIRED_NODE) {
      await writeStoredZip(
        path.join(root, `skill-bridge-vscode-${osName}-node${nodeMajor}`, "skill-bridge-vscode-0.2.13.vsix"),
        entries
      );
    }
  }
}

async function assertFileIncludes(filePath, snippet) {
  const text = await fs.readFile(filePath, "utf8");
  if (!text.includes(snippet)) {
    throw new Error(`${path.basename(filePath)} missing expected snippet: ${snippet}`);
  }
}

async function run() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skill-bridge-verify-artifacts-"));
  try {
    const benchmarkDir = path.join(tmp, "benchmark");
    const loadingDir = path.join(tmp, "loading");
    const transferDir = path.join(tmp, "transfer");
    const smokeDir = path.join(tmp, "smoke");
    const vsixDir = path.join(tmp, "vsix");
    const outDir = path.join(tmp, "out");

    await writeBenchmarkMatrix(benchmarkDir, "file-ops", "smoke");
    await writeBenchmarkMatrix(loadingDir, "loading-file-ops", "loading");
    await writeBenchmarkMatrix(transferDir, "transfer-file-ops", "transfer");
    await writeSmokeMatrix(smokeDir);
    await writeVsixMatrix(vsixDir);

    const result = spawnSync(process.execPath, [
      "scripts/verify-performance-artifacts.cjs",
      "--benchmark-dir",
      benchmarkDir,
      "--loading-dir",
      loadingDir,
      "--transfer-dir",
      transferDir,
      "--smoke-dir",
      smokeDir,
      "--vsix-dir",
      vsixDir,
      "--out-dir",
      outDir
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      shell: false,
      windowsHide: process.platform === "win32"
    });

    if (result.status !== 0) {
      throw new Error(`artifact verifier failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    }

    await assertFileIncludes(path.join(outDir, "file-ops-artifacts.md"), "- Matrix gaps: none");
    await assertFileIncludes(path.join(outDir, "loading-file-ops-artifacts.md"), "- Matrix gaps: none");
    await assertFileIncludes(path.join(outDir, "transfer-file-ops-artifacts.md"), "- Matrix gaps: none");
    await assertFileIncludes(path.join(outDir, "smoke-file-ops-artifacts.md"), "- Matrix gaps: none");
    await assertFileIncludes(path.join(outDir, "vsix-artifacts.md"), "- Matrix gaps: none");
    await assertFileIncludes(path.join(outDir, "performance-status.md"), "| Remote macOS/Linux/Windows execution evidence | verified |");

    console.log("[verify-performance-artifacts] OK. Unified artifact verifier accepts a complete synthetic CI matrix.");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[verify-performance-artifacts] ${message}`);
  process.exitCode = 1;
});
