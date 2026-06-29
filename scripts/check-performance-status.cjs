const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

async function writeText(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
}

function runReportResult(args, env) {
  return spawnSync(process.execPath, ["scripts/report-performance-status.cjs", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...env },
    shell: false,
    windowsHide: process.platform === "win32"
  });
}

function runReport(label, args, env) {
  const result = runReportResult(args, env);
  if (result.status !== 0) {
    throw new Error(`${label} failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result.stdout;
}

function runReportExpectFailure(label, args, env) {
  const result = runReportResult(args, env);
  if (result.status === 0) {
    throw new Error(`${label} was expected to fail.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result.stdout;
}

function assertIncludes(label, text, snippet) {
  if (!text.includes(snippet)) {
    throw new Error(`${label} missing expected snippet: ${snippet}`);
  }
}

async function run() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skill-bridge-performance-status-"));
  try {
    const benchmarkSummary = path.join(tmp, "file-ops-artifacts.md");
    const loadingArtifactSummary = path.join(tmp, "loading-file-ops-artifacts.md");
    const transferArtifactSummary = path.join(tmp, "transfer-file-ops-artifacts.md");
    const smokeSummary = path.join(tmp, "smoke-file-ops-artifacts.md");
    const vsixSummary = path.join(tmp, "vsix-artifacts.md");
    const localSummary = path.join(tmp, "local-status.md");
    const ciSummary = path.join(tmp, "ci-status.md");
    const localBenchmark = path.join(tmp, "performance-check.json");
    const loadingBenchmark = path.join(tmp, "performance-loading.json");
    const transferBenchmark = path.join(tmp, "performance-transfer.json");
    await writeText(benchmarkSummary, [
      "## Skill Bridge File Operations Artifact Comparison",
      "",
      "- Matrix gaps: none",
      "- Artifact failures: none",
      ""
    ].join("\n"));
    await writeText(loadingArtifactSummary, [
      "## Skill Bridge File Operations Artifact Comparison",
      "",
      "- Matrix gaps: none",
      "- Artifact failures: none",
      ""
    ].join("\n"));
    await writeText(transferArtifactSummary, [
      "## Skill Bridge File Operations Artifact Comparison",
      "",
      "- Matrix gaps: none",
      "- Artifact failures: none",
      ""
    ].join("\n"));
    await writeText(smokeSummary, [
      "## Skill Bridge File Operations Smoke Artifact Comparison",
      "",
      "- Matrix gaps: none",
      "- Artifact failures: none",
      ""
    ].join("\n"));
    await writeText(vsixSummary, [
      "## Skill Bridge VSIX Artifact Comparison",
      "",
      "- Matrix gaps: none",
      "- Artifact failures: none",
      ""
    ].join("\n"));
    await writeText(localBenchmark, JSON.stringify({
      ok: true,
      minSpeedupRequirements: {
        "core.copyDirectory": 1.1,
        "vscode.transferPlanCore": 1.2
      },
      controlSpeedups: [
        {
          operation: "core.copyDirectory",
          control: "control.serialCopyDirectory",
          medianSpeedup: 2.25,
          avgSpeedup: 2.5
        },
        {
          operation: "vscode.transferPlanCore",
          control: "control.serialTransferPlan",
          medianSpeedup: 2.4,
          avgSpeedup: 2.3
        }
      ]
    }));
    await writeText(loadingBenchmark, JSON.stringify({
      ok: true,
      minSpeedupRequirements: {
        "vscode.applyTransferQueueCore": 1.2
      },
      controlSpeedups: [
        {
          operation: "vscode.applyTransferQueueCore",
          control: "control.serialApplyTransferQueue",
          medianSpeedup: 3.5,
          avgSpeedup: 3.25
        }
      ]
    }));
    await writeText(transferBenchmark, JSON.stringify({
      ok: true,
      minSpeedupRequirements: {
        "core.copyDirectory": 1.1,
        "vscode.applyTransferQueueCore": 1.2,
        "vscode.transferPlanCore": 1.2
      },
      controlSpeedups: [
        {
          operation: "core.copyDirectory",
          control: "control.serialCopyDirectory",
          medianSpeedup: 2.1,
          avgSpeedup: 2.2
        },
        {
          operation: "vscode.applyTransferQueueCore",
          control: "control.serialApplyTransferQueue",
          medianSpeedup: 2.6,
          avgSpeedup: 2.4
        },
        {
          operation: "vscode.transferPlanCore",
          control: "control.serialTransferPlan",
          medianSpeedup: 2.8,
          avgSpeedup: 2.7
        }
      ]
    }));

    const localOutput = runReport("local performance status", [
      "--summary", localSummary,
      "--benchmark-artifact-summary", benchmarkSummary,
      "--loading-artifact-summary", loadingArtifactSummary,
      "--transfer-artifact-summary", transferArtifactSummary,
      "--smoke-artifact-summary", smokeSummary,
      "--vsix-artifact-summary", vsixSummary,
      "--benchmark-json", localBenchmark,
      "--loading-benchmark-json", loadingBenchmark,
      "--transfer-benchmark-json", transferBenchmark
    ], { GITHUB_ACTIONS: "false" });
    assertIncludes("local performance status", localOutput, "| Remote macOS/Linux/Windows execution evidence | pending external CI |");
    assertIncludes("local performance status", localOutput, "| Real refresh timing observability | verified |");
    assertIncludes("local performance status", localOutput, "refresh timing commands");
    assertIncludes("local performance status", localOutput, "| Shared file operation implementation | verified |");
    assertIncludes("local performance status", localOutput, "| VSIX runtime packaging | verified |");
    assertIncludes("local performance status", localOutput, "refresh timing tooling portable");
    assertIncludes("local performance status", localOutput, "## Current Milestone");
    assertIncludes("local performance status", localOutput, "Goal: make Skill Bridge file movement and loading measurable, shared, and package-safe across the supported VS Code extension matrix.");
    assertIncludes("local performance status", localOutput, "| VSIX packages are runnable with the shared core runtime included. |");
    assertIncludes("local performance status", localOutput, "`transfer-file-ops-*` artifacts are compared with `--require-matrix`");
    assertIncludes("local performance status", localOutput, "`compare:vsix-artifacts --require-matrix`");
    assertIncludes("local performance status", localOutput, "## Architecture Readout");
    assertIncludes("local performance status", localOutput, "| Shared file operations | Copying and scanning skill assets are common capabilities across promote, import, group transfer, tree loading, and benchmarks. |");
    assertIncludes("local performance status", localOutput, "| Performance gates | CI runner timing can be noisy, so every measured operation should not become a hard gate. |");
    assertIncludes("local performance status", localOutput, "| core.copyDirectory | control.serialCopyDirectory | 2.25x | 2.5x | 1.1x | pass |");
    assertIncludes("local performance status", localOutput, "| vscode.transferPlanCore | control.serialTransferPlan | 2.4x | 2.3x | 1.2x | pass |");
    assertIncludes("local performance status", localOutput, "| vscode.applyTransferQueueCore | control.serialApplyTransferQueue | 3.5x | 3.25x | 1.2x | pass |");
    assertIncludes("local performance status", localOutput, "## Local Transfer Speedups");
    assertIncludes("local performance status", localOutput, "| vscode.transferPlanCore | control.serialTransferPlan | 2.8x | 2.7x | 1.2x | pass |");
    assertIncludes("local performance status", localOutput, "## External CI Evidence Checklist");
    assertIncludes("local performance status", localOutput, "- `.benchmarks/transfer-file-ops-artifacts.md`");
    assertIncludes("local performance status", localOutput, "- `.benchmarks/vsix-artifacts.md`");
    assertIncludes("local performance status", localOutput, "| macos-latest | 24 | file-ops-macos-latest-node24 | loading-file-ops-macos-latest-node24 | transfer-file-ops-macos-latest-node24 | smoke-file-ops-macos-latest-node24 | smoke-file-ops-symlink-macos-latest-node24 |");
    assertIncludes("local performance status", localOutput, "skill-bridge-vscode-macos-latest-node24");
    assertIncludes("local performance status", localOutput, "| windows-latest | 20 | file-ops-windows-latest-node20 | loading-file-ops-windows-latest-node20 | transfer-file-ops-windows-latest-node20 | smoke-file-ops-windows-latest-node20 | optional on Windows | skill-bridge-vscode-windows-latest-node20 |");

    const ciOutput = runReport("CI performance status", [
      "--summary", ciSummary,
      "--benchmark-artifact-summary", benchmarkSummary,
      "--loading-artifact-summary", loadingArtifactSummary,
      "--transfer-artifact-summary", transferArtifactSummary,
      "--smoke-artifact-summary", smokeSummary,
      "--vsix-artifact-summary", vsixSummary,
      "--benchmark-json", localBenchmark,
      "--loading-benchmark-json", loadingBenchmark,
      "--transfer-benchmark-json", transferBenchmark
    ], { GITHUB_ACTIONS: "true" });
    assertIncludes("CI performance status", ciOutput, "| Remote macOS/Linux/Windows execution evidence | verified |");

    const invalidSummary = path.join(tmp, "invalid-ci-status.md");
    await writeText(loadingArtifactSummary, [
      "## Skill Bridge File Operations Artifact Comparison",
      "",
      "- Matrix gaps: ubuntu-latest:node20",
      "- Artifact failures: none",
      ""
    ].join("\n"));
    const invalidCiOutput = runReportExpectFailure("invalid CI performance status", [
      "--summary", invalidSummary,
      "--benchmark-artifact-summary", benchmarkSummary,
      "--loading-artifact-summary", loadingArtifactSummary,
      "--transfer-artifact-summary", transferArtifactSummary,
      "--smoke-artifact-summary", smokeSummary,
      "--vsix-artifact-summary", vsixSummary,
      "--benchmark-json", localBenchmark,
      "--loading-benchmark-json", loadingBenchmark,
      "--transfer-benchmark-json", transferBenchmark
    ], { GITHUB_ACTIONS: "true" });
    assertIncludes("invalid CI performance status", invalidCiOutput, "| Remote macOS/Linux/Windows execution evidence | missing |");

    console.log("[performance-status] OK. Status report keeps local CI evidence pending and marks CI artifact summaries verified.");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[performance-status] ${message}`);
  process.exitCode = 1;
});
