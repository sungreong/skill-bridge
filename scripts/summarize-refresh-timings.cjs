const fs = require("node:fs/promises");
const path = require("node:path");

const TIMING_PATTERN = /\[Refresh:timing\]\s+scan=(\d+)ms\s+inventory\+meta=(\d+)ms\s+providers\+diagnostics=(\d+)ms\s+groups\+chrome=(\d+)ms\s+watchers=(\d+)ms\s+fingerprint=(\d+)ms/;
const SCAN_DETAIL_PATTERN = /\[Refresh:scan\]\s+workspaceSkills=(\d+)ms\/(\d+)\s+centralSkills=(\d+)ms\/(\d+)\s+workspaceInstructions=(\d+)ms\/(\d+)\s+centralInstructions=(\d+)ms\/(\d+)\s+agents=(\d+)/;
const ACTIVATION_PATTERN = /\[Activation\]\s+registered in (\d+)ms; initial refresh queued/;
const VISIBLE_PATTERN = /\[Refresh:visible\]\s+completed=(\d+)ms\s+workspace=(\d+)\s+central=(\d+)/;
const ENRICH_PATTERN = /\[Refresh:enrich\]\s+metadata=(\d+)ms\s+providers\+diagnostics=(\d+)ms\s+workspaceMeta=(\d+)\s+centralMeta=(\d+)/;
const STAGES = ["scan", "inventoryMeta", "providersDiagnostics", "groupsChrome", "watchers", "fingerprint"];
const SCAN_DETAIL_STAGES = ["workspaceSkills", "centralSkills", "workspaceInstructions", "centralInstructions"];
const ENRICH_STAGES = ["metadata", "providersDiagnostics"];

function readStringArg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

function readOptionalPercentArg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const raw = process.argv[index + 1];
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }
  return parsed;
}

function percentile(sortedValues, ratio) {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.floor(sortedValues.length * ratio));
  return sortedValues[index] ?? 0;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function summarizeValues(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
    avgMs: round(total / Math.max(1, sorted.length)),
    medianMs: percentile(sorted, 0.5),
    p90Ms: percentile(sorted, 0.9)
  };
}

function parseTimings(text) {
  const samples = [];
  for (const line of text.split(/\r?\n/)) {
    const match = TIMING_PATTERN.exec(line);
    if (!match) continue;
    const [scan, inventoryMeta, providersDiagnostics, groupsChrome, watchers, fingerprint] = match
      .slice(1)
      .map((value) => Number(value));
    samples.push({
      scan,
      inventoryMeta,
      providersDiagnostics,
      groupsChrome,
      watchers,
      fingerprint,
      total: scan + inventoryMeta + providersDiagnostics + groupsChrome + watchers + fingerprint
    });
  }
  return samples;
}

function summarizeTimings(samples) {
  const stages = Object.fromEntries(
    [...STAGES, "total"].map((stage) => [stage, summarizeValues(samples.map((sample) => sample[stage]))])
  );
  const slowestStage = STAGES
    .map((stage) => ({ stage, avgMs: stages[stage].avgMs }))
    .sort((left, right) => right.avgMs - left.avgMs)[0] ?? { stage: "none", avgMs: 0 };
  return {
    sampleCount: samples.length,
    slowestStage,
    stages
  };
}

function parseScanDetails(text) {
  const samples = [];
  for (const line of text.split(/\r?\n/)) {
    const match = SCAN_DETAIL_PATTERN.exec(line);
    if (!match) continue;
    const values = match.slice(1).map((value) => Number(value));
    samples.push({
      workspaceSkills: values[0],
      workspaceSkillCount: values[1],
      centralSkills: values[2],
      centralSkillCount: values[3],
      workspaceInstructions: values[4],
      workspaceInstructionCount: values[5],
      centralInstructions: values[6],
      centralInstructionCount: values[7],
      agents: values[8]
    });
  }
  return samples;
}

function summarizeScanDetails(samples) {
  if (samples.length === 0) return null;
  const stages = Object.fromEntries(
    SCAN_DETAIL_STAGES.map((stage) => [stage, summarizeValues(samples.map((sample) => sample[stage]))])
  );
  const counts = {
    workspaceSkills: summarizeValues(samples.map((sample) => sample.workspaceSkillCount)),
    centralSkills: summarizeValues(samples.map((sample) => sample.centralSkillCount)),
    workspaceInstructions: summarizeValues(samples.map((sample) => sample.workspaceInstructionCount)),
    centralInstructions: summarizeValues(samples.map((sample) => sample.centralInstructionCount)),
    agents: summarizeValues(samples.map((sample) => sample.agents))
  };
  const slowestStage = SCAN_DETAIL_STAGES
    .map((stage) => ({ stage, avgMs: stages[stage].avgMs }))
    .sort((left, right) => right.avgMs - left.avgMs)[0] ?? { stage: "none", avgMs: 0 };
  return {
    sampleCount: samples.length,
    slowestStage,
    stages,
    counts
  };
}

function parseActivationDetails(text) {
  const samples = [];
  for (const line of text.split(/\r?\n/)) {
    const match = ACTIVATION_PATTERN.exec(line);
    if (!match) continue;
    samples.push({ registered: Number(match[1]) });
  }
  return samples;
}

function summarizeActivationDetails(samples) {
  if (samples.length === 0) return null;
  return {
    sampleCount: samples.length,
    registered: summarizeValues(samples.map((sample) => sample.registered))
  };
}

function parseVisibleDetails(text) {
  const samples = [];
  for (const line of text.split(/\r?\n/)) {
    const match = VISIBLE_PATTERN.exec(line);
    if (!match) continue;
    samples.push({
      completed: Number(match[1]),
      workspaceCount: Number(match[2]),
      centralCount: Number(match[3])
    });
  }
  return samples;
}

function summarizeVisibleDetails(samples) {
  if (samples.length === 0) return null;
  return {
    sampleCount: samples.length,
    completed: summarizeValues(samples.map((sample) => sample.completed)),
    counts: {
      workspace: summarizeValues(samples.map((sample) => sample.workspaceCount)),
      central: summarizeValues(samples.map((sample) => sample.centralCount))
    }
  };
}

function parseEnrichDetails(text) {
  const samples = [];
  for (const line of text.split(/\r?\n/)) {
    const match = ENRICH_PATTERN.exec(line);
    if (!match) continue;
    samples.push({
      metadata: Number(match[1]),
      providersDiagnostics: Number(match[2]),
      workspaceMetaCount: Number(match[3]),
      centralMetaCount: Number(match[4])
    });
  }
  return samples;
}

function summarizeEnrichDetails(samples) {
  if (samples.length === 0) return null;
  const stages = Object.fromEntries(
    ENRICH_STAGES.map((stage) => [stage, summarizeValues(samples.map((sample) => sample[stage]))])
  );
  return {
    sampleCount: samples.length,
    stages,
    counts: {
      workspaceMeta: summarizeValues(samples.map((sample) => sample.workspaceMetaCount)),
      centralMeta: summarizeValues(samples.map((sample) => sample.centralMetaCount))
    }
  };
}

function compareSummaries(current, baseline) {
  if (!baseline || !baseline.stages) return [];
  return [...STAGES, "total"].map((stage) => {
    const currentStage = current.stages[stage];
    const previousStage = baseline.stages[stage];
    if (!previousStage || typeof previousStage.medianMs !== "number" || previousStage.medianMs <= 0) {
      return {
        stage,
        previousMedianMs: null,
        currentMedianMs: currentStage.medianMs,
        medianChangePercent: null,
        previousAvgMs: null,
        currentAvgMs: currentStage.avgMs,
        avgChangePercent: null
      };
    }
    return {
      stage,
      previousMedianMs: previousStage.medianMs,
      currentMedianMs: currentStage.medianMs,
      medianChangePercent: round(((currentStage.medianMs - previousStage.medianMs) / previousStage.medianMs) * 100),
      previousAvgMs: previousStage.avgMs,
      currentAvgMs: currentStage.avgMs,
      avgChangePercent: round(((currentStage.avgMs - previousStage.avgMs) / previousStage.avgMs) * 100)
    };
  });
}

function findMedianRegressions(comparison, maxRegressionPercent) {
  if (maxRegressionPercent === null) return [];
  return comparison.filter((item) => (
    typeof item.medianChangePercent === "number"
    && item.medianChangePercent > maxRegressionPercent
  ));
}

function formatPercent(value) {
  if (typeof value !== "number") return "";
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value}%`;
}

function formatMarkdown(summary) {
  const lines = [
    "## Skill Bridge Refresh Timing Summary",
    "",
    `- Samples: ${summary.sampleCount}`,
    `- Slowest average stage: \`${summary.slowestStage.stage}\` (${summary.slowestStage.avgMs}ms)`,
    "",
    "| Stage | Median ms | Avg ms | P90 ms | Max ms |",
    "| --- | ---: | ---: | ---: | ---: |"
  ];
  for (const stage of [...STAGES, "total"]) {
    const item = summary.stages[stage];
    lines.push(`| ${stage} | ${item.medianMs} | ${item.avgMs} | ${item.p90Ms} | ${item.maxMs} |`);
  }
  if (Array.isArray(summary.comparison) && summary.comparison.length > 0) {
    lines.push(
      "",
      "| Stage | Median change | Avg change | Previous median | Current median |",
      "| --- | ---: | ---: | ---: | ---: |"
    );
    for (const item of summary.comparison) {
      lines.push(`| ${item.stage} | ${formatPercent(item.medianChangePercent)} | ${formatPercent(item.avgChangePercent)} | ${item.previousMedianMs ?? ""} | ${item.currentMedianMs} |`);
    }
  }
  if (Array.isArray(summary.medianRegressions) && summary.medianRegressions.length > 0) {
    lines.push("", `Median regressions over ${summary.maxMedianRegressionPercent}%:`);
    for (const item of summary.medianRegressions) {
      lines.push(`- ${item.stage}: ${formatPercent(item.medianChangePercent)}`);
    }
  }
  if (summary.scanDetails) {
    lines.push(
      "",
      "### Scan Breakdown",
      "",
      `- Samples: ${summary.scanDetails.sampleCount}`,
      `- Slowest average scan part: \`${summary.scanDetails.slowestStage.stage}\` (${summary.scanDetails.slowestStage.avgMs}ms)`,
      "",
      "| Scan part | Median ms | Avg ms | P90 ms | Max ms | Median count |",
      "| --- | ---: | ---: | ---: | ---: | ---: |"
    );
    for (const stage of SCAN_DETAIL_STAGES) {
      const item = summary.scanDetails.stages[stage];
      const count = summary.scanDetails.counts[stage];
      lines.push(`| ${stage} | ${item.medianMs} | ${item.avgMs} | ${item.p90Ms} | ${item.maxMs} | ${count.medianMs} |`);
    }
    lines.push(`| agents |  |  |  |  | ${summary.scanDetails.counts.agents.medianMs} |`);
  }
  if (summary.activationDetails) {
    lines.push(
      "",
      "### Activation",
      "",
      `- Samples: ${summary.activationDetails.sampleCount}`,
      "",
      "| Metric | Median ms | Avg ms | P90 ms | Max ms |",
      "| --- | ---: | ---: | ---: | ---: |"
    );
    const item = summary.activationDetails.registered;
    lines.push(`| registered | ${item.medianMs} | ${item.avgMs} | ${item.p90Ms} | ${item.maxMs} |`);
  }
  if (summary.visibleDetails) {
    lines.push(
      "",
      "### First Visible Refresh",
      "",
      `- Samples: ${summary.visibleDetails.sampleCount}`,
      "",
      "| Metric | Median ms | Avg ms | P90 ms | Max ms | Median count |",
      "| --- | ---: | ---: | ---: | ---: | ---: |"
    );
    const item = summary.visibleDetails.completed;
    lines.push(`| completed | ${item.medianMs} | ${item.avgMs} | ${item.p90Ms} | ${item.maxMs} |  |`);
    lines.push(`| workspace |  |  |  |  | ${summary.visibleDetails.counts.workspace.medianMs} |`);
    lines.push(`| central |  |  |  |  | ${summary.visibleDetails.counts.central.medianMs} |`);
  }
  if (summary.enrichDetails) {
    lines.push(
      "",
      "### Post-Refresh Enrichment",
      "",
      `- Samples: ${summary.enrichDetails.sampleCount}`,
      "",
      "| Stage | Median ms | Avg ms | P90 ms | Max ms | Median count |",
      "| --- | ---: | ---: | ---: | ---: | ---: |"
    );
    for (const stage of ENRICH_STAGES) {
      const item = summary.enrichDetails.stages[stage];
      lines.push(`| ${stage} | ${item.medianMs} | ${item.avgMs} | ${item.p90Ms} | ${item.maxMs} |  |`);
    }
    lines.push(`| workspaceMeta |  |  |  |  | ${summary.enrichDetails.counts.workspaceMeta.medianMs} |`);
    lines.push(`| centralMeta |  |  |  |  | ${summary.enrichDetails.counts.centralMeta.medianMs} |`);
  }
  return `${lines.join("\n")}\n`;
}

async function run() {
  const inputPath = readStringArg("--input") ?? process.argv[2];
  const writePath = readStringArg("--write");
  const summaryPath = readStringArg("--summary");
  const comparePath = readStringArg("--compare");
  const maxMedianRegressionPercent = readOptionalPercentArg("--fail-on-median-regression");
  if (!inputPath) {
    throw new Error("Usage: node scripts/summarize-refresh-timings.cjs --input <log-file> [--write out.json] [--summary out.md]");
  }

  const text = await fs.readFile(inputPath, "utf8");
  const samples = parseTimings(text);
  const scanDetails = summarizeScanDetails(parseScanDetails(text));
  const activationDetails = summarizeActivationDetails(parseActivationDetails(text));
  const visibleDetails = summarizeVisibleDetails(parseVisibleDetails(text));
  const enrichDetails = summarizeEnrichDetails(parseEnrichDetails(text));
  if (samples.length === 0) {
    throw new Error(`No [Refresh:timing] lines found in ${inputPath}`);
  }
  const outputBase = summarizeTimings(samples);
  const baseline = comparePath ? JSON.parse(await fs.readFile(comparePath, "utf8")) : null;
  const comparison = compareSummaries(outputBase, baseline);
  const medianRegressions = findMedianRegressions(comparison, maxMedianRegressionPercent);
  const output = {
    ...outputBase,
    ...(scanDetails ? { scanDetails } : {}),
    ...(activationDetails ? { activationDetails } : {}),
    ...(visibleDetails ? { visibleDetails } : {}),
    ...(enrichDetails ? { enrichDetails } : {}),
    ...(comparison.length > 0 ? { comparison } : {}),
    ...(maxMedianRegressionPercent !== null ? { maxMedianRegressionPercent, medianRegressions } : {})
  };

  if (writePath) {
    await fs.mkdir(path.dirname(path.resolve(writePath)), { recursive: true });
    await fs.writeFile(writePath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  }
  const markdownTarget = summaryPath || process.env.GITHUB_STEP_SUMMARY || null;
  if (markdownTarget) {
    await fs.mkdir(path.dirname(path.resolve(markdownTarget)), { recursive: true });
    await fs.appendFile(markdownTarget, formatMarkdown(output), "utf8");
  }
  console.log(JSON.stringify(output, null, 2));
  if (medianRegressions.length > 0) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
