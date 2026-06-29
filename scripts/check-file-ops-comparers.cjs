const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const REQUIRED_OS = ["ubuntu-latest", "macos-latest", "windows-latest"];
const REQUIRED_NODE = ["20", "24"];
const SYMLINK_OS = ["ubuntu-latest", "macos-latest"];

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runNodeScript(label, args, expectSuccess) {
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: false,
    windowsHide: process.platform === "win32"
  });
  const succeeded = result.status === 0;
  if (succeeded !== expectSuccess) {
    const expectation = expectSuccess ? "succeed" : "fail";
    throw new Error(`${label} was expected to ${expectation}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
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
    platform: osName.startsWith("windows") ? "win32" : osName.startsWith("macos") ? "darwin" : "linux",
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

function benchmarkArtifactWithoutTransferPlanGate(osName, nodeMajor, preset) {
  const artifact = benchmarkArtifact(osName, nodeMajor, preset);
  delete artifact.minSpeedupRequirements["vscode.transferPlanCore"];
  artifact.controlSpeedups = artifact.controlSpeedups.filter((item) => item.operation !== "vscode.transferPlanCore");
  return artifact;
}

function smokeArtifact(kind, osName, nodeMajor) {
  const requiresSymlink = kind === "symlink";
  return {
    ok: true,
    platform: osName.startsWith("windows") ? "win32" : osName.startsWith("macos") ? "darwin" : "linux",
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

async function writeFullBenchmarkMatrix(root) {
  for (const osName of REQUIRED_OS) {
    for (const nodeMajor of REQUIRED_NODE) {
      await writeJson(
        path.join(root, `file-ops-${osName}-node${nodeMajor}.json`),
        benchmarkArtifact(osName, nodeMajor, "smoke")
      );
    }
  }
}

async function writeFullLoadingBenchmarkMatrix(root) {
  for (const osName of REQUIRED_OS) {
    for (const nodeMajor of REQUIRED_NODE) {
      await writeJson(
        path.join(root, `loading-file-ops-${osName}-node${nodeMajor}.json`),
        benchmarkArtifact(osName, nodeMajor, "loading")
      );
    }
  }
}

async function writeFullTransferBenchmarkMatrix(root) {
  for (const osName of REQUIRED_OS) {
    for (const nodeMajor of REQUIRED_NODE) {
      await writeJson(
        path.join(root, `transfer-file-ops-${osName}-node${nodeMajor}.json`),
        benchmarkArtifact(osName, nodeMajor, "transfer")
      );
    }
  }
}

async function writeFullSmokeMatrix(root) {
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

async function run() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skill-bridge-comparers-"));
  try {
    const benchmarkFull = path.join(tmp, "benchmark-full");
    const benchmarkMissing = path.join(tmp, "benchmark-missing");
    const loadingBenchmarkFull = path.join(tmp, "loading-benchmark-full");
    const loadingBenchmarkMissing = path.join(tmp, "loading-benchmark-missing");
    const transferBenchmarkFull = path.join(tmp, "transfer-benchmark-full");
    const transferBenchmarkMissing = path.join(tmp, "transfer-benchmark-missing");
    const smokeFull = path.join(tmp, "smoke-full");
    const smokeMissing = path.join(tmp, "smoke-missing");
    const benchmarkMissingGate = path.join(tmp, "benchmark-missing-gate");

    await writeFullBenchmarkMatrix(benchmarkFull);
    await writeJson(path.join(benchmarkMissing, "file-ops-ubuntu-latest-node20.json"), benchmarkArtifact("ubuntu-latest", "20", "smoke"));
    await writeFullBenchmarkMatrix(benchmarkMissingGate);
    await writeJson(
      path.join(benchmarkMissingGate, "file-ops-ubuntu-latest-node20.json"),
      benchmarkArtifactWithoutTransferPlanGate("ubuntu-latest", "20", "smoke")
    );
    await writeFullLoadingBenchmarkMatrix(loadingBenchmarkFull);
    await writeJson(path.join(loadingBenchmarkMissing, "loading-file-ops-ubuntu-latest-node20.json"), benchmarkArtifact("ubuntu-latest", "20", "loading"));
    await writeFullTransferBenchmarkMatrix(transferBenchmarkFull);
    await writeJson(path.join(transferBenchmarkMissing, "transfer-file-ops-ubuntu-latest-node20.json"), benchmarkArtifact("ubuntu-latest", "20", "transfer"));
    await writeFullSmokeMatrix(smokeFull);
    await writeJson(path.join(smokeMissing, "smoke-file-ops-ubuntu-latest-node20.json"), smokeArtifact("base", "ubuntu-latest", "20"));

    runNodeScript("benchmark comparer full matrix", ["scripts/compare-file-ops-artifacts.cjs", "--dir", benchmarkFull, "--require-matrix", "--require-preset", "smoke"], true);
    runNodeScript("benchmark comparer missing matrix", ["scripts/compare-file-ops-artifacts.cjs", "--dir", benchmarkMissing, "--require-matrix", "--require-preset", "smoke"], false);
    runNodeScript("benchmark comparer missing transfer-plan gate", ["scripts/compare-file-ops-artifacts.cjs", "--dir", benchmarkMissingGate, "--require-matrix", "--require-preset", "smoke"], false);
    runNodeScript("benchmark comparer wrong preset", ["scripts/compare-file-ops-artifacts.cjs", "--dir", benchmarkFull, "--require-preset", "loading"], false);
    runNodeScript("loading benchmark comparer full matrix", ["scripts/compare-file-ops-artifacts.cjs", "--dir", loadingBenchmarkFull, "--prefix", "loading-file-ops", "--require-matrix", "--require-preset", "loading"], true);
    runNodeScript("loading benchmark comparer missing matrix", ["scripts/compare-file-ops-artifacts.cjs", "--dir", loadingBenchmarkMissing, "--prefix", "loading-file-ops", "--require-matrix", "--require-preset", "loading"], false);
    runNodeScript("loading benchmark comparer wrong preset", ["scripts/compare-file-ops-artifacts.cjs", "--dir", loadingBenchmarkFull, "--prefix", "loading-file-ops", "--require-preset", "smoke"], false);
    runNodeScript("transfer benchmark comparer full matrix", ["scripts/compare-file-ops-artifacts.cjs", "--dir", transferBenchmarkFull, "--prefix", "transfer-file-ops", "--require-matrix", "--require-preset", "transfer"], true);
    runNodeScript("transfer benchmark comparer missing matrix", ["scripts/compare-file-ops-artifacts.cjs", "--dir", transferBenchmarkMissing, "--prefix", "transfer-file-ops", "--require-matrix", "--require-preset", "transfer"], false);
    runNodeScript("transfer benchmark comparer wrong preset", ["scripts/compare-file-ops-artifacts.cjs", "--dir", transferBenchmarkFull, "--prefix", "transfer-file-ops", "--require-preset", "loading"], false);
    runNodeScript("smoke comparer full matrix", ["scripts/compare-smoke-file-ops-artifacts.cjs", "--dir", smokeFull, "--require-matrix"], true);
    runNodeScript("smoke comparer missing matrix", ["scripts/compare-smoke-file-ops-artifacts.cjs", "--dir", smokeMissing, "--require-matrix"], false);

    console.log("[file-ops-comparers] OK. Artifact comparers pass full matrices and fail incomplete matrices or missing required speedup gates.");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[file-ops-comparers] ${message}`);
  process.exitCode = 1;
});
