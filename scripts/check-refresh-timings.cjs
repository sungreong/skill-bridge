const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

function runSummarizer(args) {
  return spawnSync(process.execPath, ["scripts/summarize-refresh-timings.cjs", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: false,
    windowsHide: process.platform === "win32"
  });
}

function requireIncludes(label, text, snippet) {
  if (!text.includes(snippet)) {
    throw new Error(`${label} missing ${snippet}`);
  }
}

async function run() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skill-bridge-refresh-timing-"));
  try {
    const logPath = path.join(tempRoot, "refresh.log");
    const summaryPath = path.join(tempRoot, "refresh-summary.md");
    const baselinePath = path.join(tempRoot, "refresh-baseline.json");
    const newLogPath = path.join(tempRoot, "refresh-new.log");

    await fs.writeFile(logPath, [
      "[Activation] registered in 6ms; initial refresh queued",
      "[Refresh:visible] completed=20ms workspace=20 central=14",
      "[Refresh:timing] scan=10ms inventory+meta=4ms providers+diagnostics=2ms groups+chrome=3ms watchers=1ms",
      "[Refresh:scan] workspaceSkills=8ms/20 centralSkills=5ms/14 workspaceInstructions=1ms/2 centralInstructions=1ms/1 agents=4",
      "[Refresh:enrich] metadata=18ms providers+diagnostics=3ms workspaceMeta=4 centralMeta=3",
      "[Activation] registered in 8ms; initial refresh queued",
      "[Refresh:visible] completed=27ms workspace=22 central=15",
      "[Refresh:timing] scan=14ms inventory+meta=5ms providers+diagnostics=3ms groups+chrome=4ms watchers=1ms",
      "[Refresh:scan] workspaceSkills=11ms/22 centralSkills=7ms/15 workspaceInstructions=2ms/2 centralInstructions=1ms/1 agents=4",
      "[Refresh:enrich] metadata=22ms providers+diagnostics=4ms workspaceMeta=5 centralMeta=4",
      ""
    ].join("\n"), "utf8");

    const summarizeResult = runSummarizer(["--input", logPath, "--write", baselinePath, "--summary", summaryPath]);
    if (summarizeResult.error) throw summarizeResult.error;
    if (summarizeResult.status !== 0) {
      throw new Error((summarizeResult.stderr || summarizeResult.stdout).trim());
    }

    const baseline = JSON.parse(await fs.readFile(baselinePath, "utf8"));
    if (baseline.sampleCount !== 2) throw new Error("expected two refresh timing samples");
    if (baseline.scanDetails?.sampleCount !== 2) throw new Error("expected two scan detail samples");
    if (baseline.scanDetails?.slowestStage?.stage !== "workspaceSkills") {
      throw new Error("expected workspaceSkills to be the slowest scan detail stage");
    }
    if (baseline.activationDetails?.sampleCount !== 2) throw new Error("expected two activation samples");
    if (baseline.visibleDetails?.completed?.medianMs !== 27) throw new Error("expected visible completed median");
    if (baseline.enrichDetails?.sampleCount !== 2) throw new Error("expected two enrich samples");

    const markdown = await fs.readFile(summaryPath, "utf8");
    requireIncludes("markdown", markdown, "### Scan Breakdown");
    requireIncludes("markdown", markdown, "### Activation");
    requireIncludes("markdown", markdown, "### First Visible Refresh");
    requireIncludes("markdown", markdown, "### Post-Refresh Enrichment");
    requireIncludes("markdown", markdown, "| workspaceSkills |");
    requireIncludes("markdown", markdown, "| agents |");

    await fs.writeFile(newLogPath, [
      "[Refresh:visible] completed=37ms workspace=20 central=14",
      "[Refresh:timing] scan=30ms inventory+meta=4ms providers+diagnostics=2ms groups+chrome=3ms watchers=1ms",
      "[Refresh:scan] workspaceSkills=25ms/20 centralSkills=5ms/14 workspaceInstructions=1ms/2 centralInstructions=1ms/1 agents=4",
      ""
    ].join("\n"), "utf8");

    const regressionResult = runSummarizer([
      "--input",
      newLogPath,
      "--compare",
      baselinePath,
      "--fail-on-median-regression",
      "25"
    ]);
    if (regressionResult.status === 0) {
      throw new Error("expected refresh timing regression check to fail");
    }

    console.log("[refresh-timings] OK. Refresh timing summaries include scan breakdowns and fail median regressions.");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[refresh-timings] ${message}`);
  process.exitCode = 1;
});
