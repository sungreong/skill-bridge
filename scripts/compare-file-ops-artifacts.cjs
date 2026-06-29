const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_DIR = ".benchmarks";
const REQUIRED_OS = ["ubuntu-latest", "macos-latest", "windows-latest"];
const REQUIRED_NODE = ["20", "24"];
const REQUIRED_SPEEDUP_REQUIREMENTS = {
  "core.copyDirectory": 1.1,
  "vscode.collectFiles": 1.1,
  "core.collectFiles": 1.1,
  "vscode.applyTransferQueueCore": 1.2,
  "vscode.transferPlanCore": 1.2
};

function readStringArg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function collectJsonFiles(inputDir, prefix) {
  if (!(await pathExists(inputDir))) return [];
  const entries = await fs.readdir(inputDir, { withFileTypes: true });
  const files = [];
  const artifactPattern = new RegExp(`^${escapeRegExp(prefix)}-.+\\.json$`, "i");
  for (const entry of entries) {
    const entryPath = path.join(inputDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectJsonFiles(entryPath, prefix));
      continue;
    }
    if (entry.isFile() && artifactPattern.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function parseArtifactName(filePath, prefix) {
  const name = path.basename(filePath);
  const match = new RegExp(`^${escapeRegExp(prefix)}-(.+)-node(\\d+)\\.json$`, "i").exec(name);
  if (!match) return { os: "unknown", node: "unknown" };
  return { os: match[1], node: match[2] };
}

async function readBenchmark(filePath, prefix) {
  const raw = (await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, "");
  const parsed = JSON.parse(raw);
  const inferred = parseArtifactName(filePath, prefix);
  return {
    filePath,
    os: typeof parsed.os === "string" ? parsed.os : inferred.os,
    nodeMajor: typeof parsed.nodeMajor === "string" ? parsed.nodeMajor : inferred.node,
    preset: typeof parsed.options?.preset === "string" ? parsed.options.preset : "",
    platform: typeof parsed.platform === "string" ? parsed.platform : "",
    node: typeof parsed.node === "string" ? parsed.node : "",
    ok: parsed.ok === true,
    results: Array.isArray(parsed.results) ? parsed.results : [],
    controlSpeedups: Array.isArray(parsed.controlSpeedups) ? parsed.controlSpeedups : [],
    minSpeedupRequirements: parsed.minSpeedupRequirements && typeof parsed.minSpeedupRequirements === "object"
      ? parsed.minSpeedupRequirements
      : {},
    correctnessFailures: Array.isArray(parsed.correctnessFailures) ? parsed.correctnessFailures : [],
    speedupFailures: Array.isArray(parsed.speedupFailures) ? parsed.speedupFailures : [],
    medianRegressions: Array.isArray(parsed.medianRegressions) ? parsed.medianRegressions : []
  };
}

function buildMatrixFailures(benchmarks) {
  const present = new Set(benchmarks.map((item) => `${item.os}:node${item.nodeMajor}`));
  const missing = [];
  for (const osName of REQUIRED_OS) {
    for (const nodeMajor of REQUIRED_NODE) {
      const key = `${osName}:node${nodeMajor}`;
      if (!present.has(key)) missing.push(key);
    }
  }
  return missing;
}

function collectOperations(benchmarks) {
  const names = new Set();
  for (const benchmark of benchmarks) {
    for (const result of benchmark.results) {
      if (typeof result?.name === "string") names.add(result.name);
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

function buildArtifactFailures(benchmarks, requiredPreset) {
  const failures = [];
  const matrixCounts = new Map();
  for (const benchmark of benchmarks) {
    const matrixKey = `${benchmark.os}:node${benchmark.nodeMajor}`;
    matrixCounts.set(matrixKey, (matrixCounts.get(matrixKey) ?? 0) + 1);
    if (!benchmark.ok) {
      failures.push(`${matrixKey}: ok flag is not true`);
    }
    if (benchmark.results.length === 0) {
      failures.push(`${matrixKey}: no benchmark results`);
    }
    if (requiredPreset && benchmark.preset !== requiredPreset) {
      failures.push(`${matrixKey}: preset is ${benchmark.preset || "missing"}, expected ${requiredPreset}`);
    }
    if (benchmark.correctnessFailures.length > 0) {
      failures.push(`${matrixKey}: ${benchmark.correctnessFailures.length} correctness failure(s)`);
    }
    if (benchmark.speedupFailures.length > 0) {
      failures.push(`${matrixKey}: ${benchmark.speedupFailures.length} speedup failure(s)`);
    }
    if (benchmark.medianRegressions.length > 0) {
      failures.push(`${matrixKey}: ${benchmark.medianRegressions.length} median regression(s)`);
    }
    for (const [operation, minimumSpeedup] of Object.entries(REQUIRED_SPEEDUP_REQUIREMENTS)) {
      const configured = benchmark.minSpeedupRequirements?.[operation];
      if (configured !== minimumSpeedup) {
        failures.push(`${matrixKey}: missing required speedup gate ${operation}=${minimumSpeedup}`);
        continue;
      }
      const speedup = benchmark.controlSpeedups.find((item) => item?.operation === operation);
      if (!speedup) {
        failures.push(`${matrixKey}: missing speedup result for ${operation}`);
        continue;
      }
      if (typeof speedup.medianSpeedup !== "number" || speedup.medianSpeedup < minimumSpeedup) {
        failures.push(`${matrixKey}: ${operation} median speedup ${speedup.medianSpeedup ?? "missing"}x below ${minimumSpeedup}x`);
      }
    }
  }
  for (const [matrixKey, count] of matrixCounts.entries()) {
    if (count > 1) {
      failures.push(`${matrixKey}: duplicate artifact count ${count}`);
    }
  }
  return failures;
}

function getResult(benchmark, operation) {
  return benchmark.results.find((result) => result?.name === operation) ?? null;
}

function formatMarkdown(benchmarks, missingMatrix, artifactFailures) {
  const lines = [
    "## Skill Bridge File Operations Artifact Comparison",
    "",
    `- Artifacts: ${benchmarks.length}`,
    `- Matrix gaps: ${missingMatrix.length === 0 ? "none" : missingMatrix.join(", ")}`,
    `- Artifact failures: ${artifactFailures.length === 0 ? "none" : artifactFailures.length}`,
    `- Required speedup gates: ${Object.entries(REQUIRED_SPEEDUP_REQUIREMENTS).map(([operation, ratio]) => `${operation}>=${ratio}x`).join(", ")}`,
    "",
    "| OS | Node | Preset | Platform | Runtime |",
    "| --- | ---: | --- | --- | --- |"
  ];
  for (const benchmark of benchmarks) {
    lines.push(`| ${benchmark.os} | ${benchmark.nodeMajor} | ${benchmark.preset || ""} | ${benchmark.platform} | ${benchmark.node} |`);
  }
  if (artifactFailures.length > 0) {
    lines.push(
      "",
      "### Artifact Failures",
      "",
      "If this was run against a broad local `.benchmarks` folder, move or download the current CI artifacts into an isolated directory such as `.benchmarks/artifacts` before comparing. Mixed or stale benchmark JSON files are intentionally reported as failures.",
      ""
    );
    for (const failure of artifactFailures) {
      lines.push(`- ${failure}`);
    }
  }

  const speedupOperations = new Set();
  for (const benchmark of benchmarks) {
    for (const speedup of benchmark.controlSpeedups) {
      if (typeof speedup?.operation === "string") speedupOperations.add(speedup.operation);
    }
  }
  for (const operation of [...speedupOperations].sort((left, right) => left.localeCompare(right))) {
    lines.push(
      "",
      `### ${operation} Speedup`,
      "",
      "| OS | Node | Control | Median speedup | Avg speedup |",
      "| --- | ---: | --- | ---: | ---: |"
    );
    for (const benchmark of benchmarks) {
      const speedup = benchmark.controlSpeedups.find((item) => item?.operation === operation);
      if (!speedup) {
        lines.push(`| ${benchmark.os} | ${benchmark.nodeMajor} |  |  |  |`);
        continue;
      }
      lines.push(`| ${benchmark.os} | ${benchmark.nodeMajor} | ${speedup.control ?? ""} | ${speedup.medianSpeedup ?? ""}x | ${speedup.avgSpeedup ?? ""}x |`);
    }
  }

  const operations = collectOperations(benchmarks);
  for (const operation of operations) {
    lines.push(
      "",
      `### ${operation}`,
      "",
      "| OS | Node | Median ms | Avg ms | Last detail |",
      "| --- | ---: | ---: | ---: | --- |"
    );
    for (const benchmark of benchmarks) {
      const result = getResult(benchmark, operation);
      if (!result) {
        lines.push(`| ${benchmark.os} | ${benchmark.nodeMajor} |  |  | missing |`);
        continue;
      }
      lines.push(`| ${benchmark.os} | ${benchmark.nodeMajor} | ${result.medianMs ?? ""} | ${result.avgMs ?? ""} | ${JSON.stringify(result.lastDetail ?? null)} |`);
    }
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
  const prefix = readStringArg("--prefix", "file-ops");
  const summaryPath = readStringArg("--summary");
  const requiredPreset = readStringArg("--require-preset");
  const requireMatrix = hasFlag("--require-matrix");
  const files = await collectJsonFiles(inputDir, prefix);
  const benchmarks = [];
  for (const filePath of files) {
    benchmarks.push(await readBenchmark(filePath, prefix));
  }
  benchmarks.sort((left, right) => left.os.localeCompare(right.os) || left.nodeMajor.localeCompare(right.nodeMajor));

  const missingMatrix = buildMatrixFailures(benchmarks);
  const artifactFailures = buildArtifactFailures(benchmarks, requiredPreset);
  const markdown = formatMarkdown(benchmarks, missingMatrix, artifactFailures);
  await writeSummaryIfRequested(markdown, summaryPath);
  console.log(markdown);

  if (benchmarks.length === 0 || artifactFailures.length > 0 || (requireMatrix && missingMatrix.length > 0)) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[compare-file-ops-artifacts] ${message}`);
  process.exitCode = 1;
});
