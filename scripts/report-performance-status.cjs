const fs = require("node:fs/promises");
const path = require("node:path");

function readStringArg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

async function readText(filePath) {
  return fs.readFile(filePath, "utf8");
}

async function readJsonIfExists(filePath) {
  if (!await pathExists(filePath)) return null;
  return JSON.parse(await readText(filePath));
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function hasAll(text, snippets) {
  return snippets.every((snippet) => text.includes(snippet));
}

async function readSummaryStatus(filePath, requiredSnippets) {
  if (!await pathExists(filePath)) {
    return { exists: false, valid: false };
  }
  const text = await readText(filePath);
  return {
    exists: true,
    valid: hasAll(text, requiredSnippets)
  };
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function formatNumber(value) {
  return isFiniteNumber(value) ? value.toFixed(2).replace(/\.?0+$/, "") : "";
}

function readControlSpeedups(report) {
  if (!report || typeof report !== "object" || !Array.isArray(report.controlSpeedups)) return [];
  const minSpeedupRequirements = report.minSpeedupRequirements && typeof report.minSpeedupRequirements === "object"
    ? report.minSpeedupRequirements
    : {};
  return report.controlSpeedups
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      operation: typeof item.operation === "string" ? item.operation : "",
      control: typeof item.control === "string" ? item.control : "",
      medianSpeedup: isFiniteNumber(item.medianSpeedup) ? item.medianSpeedup : null,
      avgSpeedup: isFiniteNumber(item.avgSpeedup) ? item.avgSpeedup : null,
      requiredSpeedup: isFiniteNumber(minSpeedupRequirements[item.operation]) ? minSpeedupRequirements[item.operation] : null
    }))
    .filter((item) => item.operation && item.control && item.medianSpeedup !== null);
}

function speedupStatus(speedup) {
  if (!isFiniteNumber(speedup.requiredSpeedup)) return "observe";
  return speedup.medianSpeedup >= speedup.requiredSpeedup ? "pass" : "fail";
}

function formatRelativePath(root, filePath) {
  return path.relative(root, path.resolve(filePath)).split(path.sep).join("/");
}

function appendSpeedupSection(lines, title, root, sourcePath, speedups) {
  if (speedups.length === 0) return;
  lines.push(
    "",
    `## ${title}`,
    "",
    `Source: \`${formatRelativePath(root, sourcePath)}\``,
    "",
    "| Operation | Control | Median speedup | Avg speedup | Gate | Status |",
    "| --- | --- | ---: | ---: | ---: | --- |"
  );
  for (const speedup of speedups) {
    const gate = isFiniteNumber(speedup.requiredSpeedup) ? `${formatNumber(speedup.requiredSpeedup)}x` : "";
    lines.push(`| ${speedup.operation} | ${speedup.control} | ${formatNumber(speedup.medianSpeedup)}x | ${formatNumber(speedup.avgSpeedup)}x | ${gate} | ${speedupStatus(speedup)} |`);
  }
}

function appendExternalEvidenceChecklist(lines) {
  const osNames = ["ubuntu-latest", "macos-latest", "windows-latest"];
  const nodeMajors = ["20", "24"];
  lines.push(
    "",
    "## External CI Evidence Checklist",
    "",
    "Completion requires a GitHub Actions run whose comparison job uploads `file-ops-comparison` with these summaries:",
    "",
    "- `.benchmarks/file-ops-artifacts.md`",
    "- `.benchmarks/loading-file-ops-artifacts.md`",
    "- `.benchmarks/transfer-file-ops-artifacts.md`",
    "- `.benchmarks/smoke-file-ops-artifacts.md`",
    "- `.benchmarks/vsix-artifacts.md`",
    "- `.benchmarks/performance-status.md`",
    "",
    "The matrix must include these benchmark artifacts:",
    "",
    "| OS | Node | Smoke benchmark | Loading benchmark | Transfer benchmark | Smoke compatibility | Symlink compatibility | VSIX package |",
    "| --- | ---: | --- | --- | --- | --- | --- | --- |"
  );
  for (const osName of osNames) {
    for (const nodeMajor of nodeMajors) {
      const symlink = osName === "windows-latest"
        ? "optional on Windows"
        : `smoke-file-ops-symlink-${osName}-node${nodeMajor}`;
      lines.push(`| ${osName} | ${nodeMajor} | file-ops-${osName}-node${nodeMajor} | loading-file-ops-${osName}-node${nodeMajor} | transfer-file-ops-${osName}-node${nodeMajor} | smoke-file-ops-${osName}-node${nodeMajor} | ${symlink} | skill-bridge-vscode-${osName}-node${nodeMajor} |`);
    }
  }
}

function appendArchitectureReadout(lines) {
  lines.push(
    "",
    "## Architecture Readout",
    "",
    "| Area | Observation | Current decision |",
    "| --- | --- | --- |",
    "| Transfer model | Similar file-transfer tools separate plan, queue, apply, and report instead of copying from tree clicks directly. | Skill Bridge keeps reviewable transfer plans, bounded apply queues, and generated timing/status reports. |",
    "| Shared file operations | Copying and scanning skill assets are common capabilities across promote, import, group transfer, tree loading, and benchmarks. | Core `collectFiles` and `copyDirectory` are the shared baseline; VS Code scanning delegates to core `collectFiles` with a containment root instead of carrying a separate walker. |",
    "| Extension-host loading | Startup and tree refresh work can block VS Code if scans overlap or fan out without limits. | Refreshes are coalesced, scans use bounded concurrency, and `vscode.scanAgentRoots` is compared against a managed-root serial control while full-root scanning remains diagnostic. |",
    "| Cross-OS safety | Windows, macOS, and Linux differ on path separators, Unicode normalization, symlink permissions, and shell commands. | Tests use Node path/fs APIs, spaces and Korean path fixtures, traversal rejection, and OS-aware symlink checks. |",
    "| Performance gates | CI runner timing can be noisy, so every measured operation should not become a hard gate. | File collection, folder copy, transfer apply, and transfer-plan generation have conservative speedup gates; broader loading scans are reported for trend watching. |"
  );
}

function appendCurrentMilestone(lines) {
  lines.push(
    "",
    "## Current Milestone",
    "",
    "Goal: make Skill Bridge file movement and loading measurable, shared, and package-safe across the supported VS Code extension matrix.",
    "",
    "| Completion criterion | Local evidence | Remote evidence |",
    "| --- | --- | --- |",
    "| Shared file operations are used for extension scans and core workflows. | `skillPaths.collectFiles` delegates to core `collectFiles` with `containmentRoot`; `test:file-ops` verifies path safety. | Covered by the OS/Node smoke artifacts. |",
    "| File movement, scan, and transfer-plan paths are compared with serial controls. | `check:performance` writes smoke/loading/transfer benchmark JSON and enforces speedup gates for stable file movement and transfer-plan operations while reporting broader loading trends. | `file-ops-*`, `loading-file-ops-*`, and `transfer-file-ops-*` artifacts are compared with `--require-matrix`. |",
    "| VSIX packages are runnable with the shared core runtime included. | `package:vsix` vendors core, checks dist runtime files, and opens the generated VSIX. | `skill-bridge-vscode-*` artifacts are compared with `compare:vsix-artifacts --require-matrix`. |",
    "| Broader loading scans are observed without premature hard gates. | `vscode.scanAgentRoots` appears as `observe` against `control.serialScanManagedSkillRoots` in smoke/loading speedup tables. | CI artifacts keep per-OS trend data for later tuning. |"
  );
}

async function run() {
  const summaryPath = readStringArg("--summary", ".benchmarks/performance-status.md");
  const root = process.cwd();
  const packageJson = JSON.parse(await readText(path.join(root, "package.json")));
  const vscodePackageJson = JSON.parse(await readText(path.join(root, "apps", "vscode", "package.json")));
  const workflow = await readText(path.join(root, ".github", "workflows", "file-ops.yml"));
  const registrar = await readText(path.join(root, "apps", "vscode", "src", "extensionCommandRegistrar.ts"));
  const skillPaths = await readText(path.join(root, "apps", "vscode", "src", "skillPaths.ts"));
  const refreshRuntime = await readText(path.join(root, "apps", "vscode", "src", "extensionRefreshRuntime.ts"));
  const refreshTimingSummarizer = await readText(path.join(root, "scripts", "summarize-refresh-timings.cjs"));
  const benchmarkDocs = await readText(path.join(root, "BENCHMARKS.md"));
  const benchmarkArtifactSummaryPath = readStringArg(
    "--benchmark-artifact-summary",
    path.join(root, ".benchmarks", "file-ops-artifacts.md")
  );
  const smokeArtifactSummaryPath = readStringArg(
    "--smoke-artifact-summary",
    path.join(root, ".benchmarks", "smoke-file-ops-artifacts.md")
  );
  const loadingArtifactSummaryPath = readStringArg(
    "--loading-artifact-summary",
    path.join(root, ".benchmarks", "loading-file-ops-artifacts.md")
  );
  const transferArtifactSummaryPath = readStringArg(
    "--transfer-artifact-summary",
    path.join(root, ".benchmarks", "transfer-file-ops-artifacts.md")
  );
  const vsixArtifactSummaryPath = readStringArg(
    "--vsix-artifact-summary",
    path.join(root, ".benchmarks", "vsix-artifacts.md")
  );
  const localBenchmarkPath = readStringArg(
    "--benchmark-json",
    path.join(root, ".benchmarks", "performance-check.json")
  );
  const loadingBenchmarkPath = readStringArg(
    "--loading-benchmark-json",
    path.join(root, ".benchmarks", "performance-loading.json")
  );
  const transferBenchmarkPath = readStringArg(
    "--transfer-benchmark-json",
    path.join(root, ".benchmarks", "performance-transfer.json")
  );
  const localBenchmark = await readJsonIfExists(localBenchmarkPath);
  const loadingBenchmark = await readJsonIfExists(loadingBenchmarkPath);
  const transferBenchmark = await readJsonIfExists(transferBenchmarkPath);
  const localSpeedups = readControlSpeedups(localBenchmark);
  const loadingSpeedups = readControlSpeedups(loadingBenchmark);
  const transferSpeedups = readControlSpeedups(transferBenchmark);
  const [benchmarkArtifactSummary, loadingArtifactSummary, transferArtifactSummary, smokeArtifactSummary, vsixArtifactSummary] = await Promise.all([
    readSummaryStatus(benchmarkArtifactSummaryPath, [
      "## Skill Bridge File Operations Artifact Comparison",
      "- Matrix gaps: none",
      "- Artifact failures: none"
    ]),
    readSummaryStatus(loadingArtifactSummaryPath, [
      "## Skill Bridge File Operations Artifact Comparison",
      "- Matrix gaps: none",
      "- Artifact failures: none"
    ]),
    readSummaryStatus(transferArtifactSummaryPath, [
      "## Skill Bridge File Operations Artifact Comparison",
      "- Matrix gaps: none",
      "- Artifact failures: none"
    ]),
    readSummaryStatus(smokeArtifactSummaryPath, [
      "## Skill Bridge File Operations Smoke Artifact Comparison",
      "- Matrix gaps: none",
      "- Artifact failures: none"
    ]),
    readSummaryStatus(vsixArtifactSummaryPath, [
      "## Skill Bridge VSIX Artifact Comparison",
      "- Matrix gaps: none",
      "- Artifact failures: none"
    ])
  ]);
  const hasCiArtifactSummaries = process.env.GITHUB_ACTIONS === "true"
    && benchmarkArtifactSummary.valid
    && loadingArtifactSummary.valid
    && transferArtifactSummary.valid
    && smokeArtifactSummary.valid
    && vsixArtifactSummary.valid;
  const hasPartialInvalidCiArtifactSummaries = process.env.GITHUB_ACTIONS === "true"
    && (benchmarkArtifactSummary.exists || loadingArtifactSummary.exists || transferArtifactSummary.exists || smokeArtifactSummary.exists || vsixArtifactSummary.exists)
    && !hasCiArtifactSummaries;

  const scripts = packageJson.scripts && typeof packageJson.scripts === "object" ? packageJson.scripts : {};
  const rows = [
    {
      requirement: "FileZilla-style transfer discipline",
      evidence: "BENCHMARKS.md documents queue-like transfer plans, collapsed selections, bounded concurrency, explicit review, and correctness checks.",
      status: hasAll(benchmarkDocs, ["FileZilla-style", "queue-like transfer plan", "bounded concurrency", "Measure both speed and correctness"]) ? "verified" : "missing"
    },
    {
      requirement: "Local speed comparison",
      evidence: "`benchmark:file-ops:dist` and `check:performance` run smoke, loading, and transfer serial-control benchmarks with minimum speedup gates.",
      status: scripts["benchmark:file-ops:dist"] && hasAll(await readText(path.join(root, "scripts", "check-performance.cjs")), ["--include-control", "--fail-on-min-speedup", "--preset", "transfer", "performance-transfer.json"]) ? "verified" : "missing"
    },
    {
      requirement: "Real refresh timing observability",
      evidence: "The extension logs aggregate refresh stages plus workspace/central scan breakdowns, and the timing summarizer can compare refresh baselines.",
      status: scripts["check:refresh-timings"]
        && hasAll(refreshRuntime, ["[Refresh:timing]", "[Refresh:scan]", "workspaceSkills=", "centralSkills=", "workspaceInstructions=", "centralInstructions="])
        && hasAll(refreshTimingSummarizer, ["SCAN_DETAIL_PATTERN", "Scan Breakdown", "fail-on-median-regression"])
        ? "verified"
        : "missing"
    },
    {
      requirement: "Shared file operation implementation",
      evidence: "VS Code file scanning delegates to the core `collectFiles` helper with a containment root, so symlink safety and traversal behavior stay in one implementation.",
      status: hasAll(skillPaths, ["collectFiles as collectCoreFiles", "containmentRoot: basePath"]) ? "verified" : "missing"
    },
    {
      requirement: "VSIX runtime packaging",
      evidence: "The VS Code package command vendors the core runtime, checks dist runtime files, opens the generated VSIX, and CI uploads OS/Node-specific VSIX artifacts.",
      status: hasAll(JSON.stringify(vscodePackageJson.scripts ?? {}), ["vendor:core", "check:runtime-deps", "check:vsix-runtime-deps"])
        && hasAll(workflow, ["npm --workspace apps/vscode run package:vsix", "skill-bridge-vscode-${{ matrix.os }}-node${{ matrix.node }}"])
        ? "verified"
        : "missing"
    },
    {
      requirement: "Cross-OS workflow coverage",
      evidence: "GitHub Actions matrix covers ubuntu-latest, macos-latest, windows-latest, Node 20/24, and the local guard scripts used to keep benchmark, status, and refresh timing tooling portable.",
      status: hasAll(workflow, ["ubuntu-latest", "macos-latest", "windows-latest", '- "20"', '- "24"', "npm run check:file-ops-workflow", "npm run check:performance-tools", "npm run check:performance-status", "npm run check:refresh-timings"]) ? "verified" : "missing"
    },
    {
      requirement: "Cross-OS smoke artifacts",
      evidence: "Workflow uploads smoke-file-ops artifacts and compares them with `compare:smoke-file-ops-artifacts --require-matrix`.",
      status: hasAll(workflow, ["smoke-file-ops-${{ matrix.os }}-node${{ matrix.node }}.json", "compare:smoke-file-ops-artifacts", "--require-matrix"]) ? "verified" : "missing"
    },
    {
      requirement: "Benchmark artifacts",
      evidence: "Workflow uploads smoke-sized, loading-sized, and transfer-sized benchmark artifacts and compares all three matrices.",
      status: hasAll(workflow, ["file-ops-${{ matrix.os }}-node${{ matrix.node }}.json", "loading-file-ops-${{ matrix.os }}-node${{ matrix.node }}.json", "transfer-file-ops-${{ matrix.os }}-node${{ matrix.node }}.json", "compare:file-ops-artifacts", "compare:loading-file-ops-artifacts", "compare:transfer-file-ops-artifacts", "--require-matrix"]) ? "verified" : "missing"
    },
    {
      requirement: "VS Code Performance Tools exposure",
      evidence: "Extension command copies local checks, smoke/loading benchmark commands, refresh timing commands, benchmark artifact comparisons, smoke artifact comparison, and the status report command.",
      status: hasAll(registrar, ["npm run check:performance", "npm run check:file-ops-comparers", "npm run benchmark:file-ops:dist -- --preset loading --include-control", "npm run summarize:refresh-timings", "npm run check:refresh-timings", "npm run compare:file-ops-artifacts", "npm run compare:loading-file-ops-artifacts", "npm run compare:transfer-file-ops-artifacts", "npm run compare:smoke-file-ops-artifacts", "npm run report:performance-status"]) ? "verified" : "missing"
    },
    {
      requirement: "Remote macOS/Linux/Windows execution evidence",
      evidence: hasCiArtifactSummaries
        ? "GitHub Actions comparison job produced benchmark and smoke artifact summaries after the OS/Node matrix completed."
        : hasPartialInvalidCiArtifactSummaries
          ? "GitHub Actions artifact summaries exist but do not prove a complete successful OS/Node matrix."
          : "Requires actual GitHub Actions artifacts from a pushed workflow run.",
      status: hasCiArtifactSummaries ? "verified" : hasPartialInvalidCiArtifactSummaries ? "missing" : "pending external CI"
    }
  ];

  const lines = [
    "# Skill Bridge Performance Status",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "| Requirement | Status | Evidence |",
    "| --- | --- | --- |"
  ];
  for (const row of rows) {
    lines.push(`| ${row.requirement} | ${row.status} | ${row.evidence.replace(/\|/g, "\\|")} |`);
  }
  appendCurrentMilestone(lines);
  appendArchitectureReadout(lines);
  appendSpeedupSection(lines, "Local Smoke Speedups", root, localBenchmarkPath, localSpeedups);
  appendSpeedupSection(lines, "Local Loading Speedups", root, loadingBenchmarkPath, loadingSpeedups);
  appendSpeedupSection(lines, "Local Transfer Speedups", root, transferBenchmarkPath, transferSpeedups);
  appendExternalEvidenceChecklist(lines);
  lines.push(
    "",
    "Remote CI evidence is intentionally listed separately: local checks can prove the workflow and comparers are wired, but only a GitHub Actions run can prove hosted macOS/Linux/Windows execution."
  );

  await fs.mkdir(path.dirname(path.resolve(summaryPath)), { recursive: true });
  await fs.writeFile(summaryPath, `${lines.join("\n")}\n`, "utf8");
  console.log(`${lines.join("\n")}\n`);

  const missing = rows.filter((row) => row.status === "missing");
  if (missing.length > 0) process.exitCode = 1;
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[performance-status] ${message}`);
  process.exitCode = 1;
});
