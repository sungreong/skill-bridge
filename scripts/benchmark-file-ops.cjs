const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const {
  collectFiles: collectVsCodeFiles,
  collectScopeEntries
} = require("../apps/vscode/dist/skillPaths.js");
const {
  collectFiles: collectCoreFiles,
  copyDirectory
} = require("../packages/core/dist/shared.js");
const {
  scanSkillFiles
} = require("../apps/vscode/dist/skillScanner.js");

const AGENT_TOOLS = ["codex", "agents", "cursor", "gemini", "claude", "antigravity"];
const AGENT_ROOT_BY_TOOL = {
  codex: ".codex",
  agents: ".agents",
  cursor: ".cursor",
  gemini: ".gemini",
  claude: ".claude",
  antigravity: ".antigravity"
};
const PRESETS = {
  smoke: { skills: 12, filesPerSkill: 8, depth: 2, rounds: 3, agents: 4, rootNoiseFiles: 8 },
  loading: { skills: 24, filesPerSkill: 16, depth: 2, rounds: 5, agents: 6, rootNoiseFiles: 32 },
  transfer: { skills: 48, filesPerSkill: 32, depth: 2, rounds: 5, agents: 4, rootNoiseFiles: 32 }
};

function readNumberArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const raw = process.argv[index + 1];
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive number.`);
  }
  return Math.floor(parsed);
}

function readStringArg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

function getNodeMajor() {
  return process.version.replace(/^v/, "").split(".")[0] || "unknown";
}

function readPresetDefaults() {
  const raw = readStringArg("--preset") ?? "smoke";
  const preset = PRESETS[raw];
  if (!preset) {
    throw new Error(`--preset must be one of: ${Object.keys(PRESETS).join(", ")}.`);
  }
  return { name: raw, values: preset };
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

function readSpeedupRequirementsArg(name) {
  const raw = readStringArg(name);
  if (!raw) return new Map();
  const requirements = new Map();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const separator = trimmed.lastIndexOf("=");
    if (separator <= 0) {
      throw new Error(`${name} entries must use operation=ratio.`);
    }
    const operation = trimmed.slice(0, separator).trim();
    const ratio = Number(trimmed.slice(separator + 1).trim());
    if (!operation || !Number.isFinite(ratio) || ratio <= 0) {
      throw new Error(`${name} entries must use operation=positive-number.`);
    }
    requirements.set(operation, ratio);
  }
  return requirements;
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function collectFilesSerial(root, current = root, out = []) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await collectFilesSerial(root, absolute, out);
    } else if (entry.isFile()) {
      out.push(path.relative(root, absolute).replace(/\\/g, "/"));
    }
  }
  return out;
}

async function copyDirectorySerial(from, to) {
  await fs.mkdir(to, { recursive: true });
  const entries = await fs.readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await copyDirectorySerial(src, dst);
    } else if (entry.isFile()) {
      await fs.copyFile(src, dst);
    }
  }
}

async function copySkillFoldersQueued(sourceRoot, targetRoot, skillNames) {
  await fs.mkdir(path.join(targetRoot, "skills"), { recursive: true });
  await mapWithConcurrency(skillNames, 6, async (skillName) => {
    await copyDirectory(
      path.join(sourceRoot, "skills", skillName),
      path.join(targetRoot, "skills", skillName)
    );
  });
}

async function copySkillFoldersSerial(sourceRoot, targetRoot, skillNames) {
  await fs.mkdir(path.join(targetRoot, "skills"), { recursive: true });
  for (const skillName of skillNames) {
    await copyDirectorySerial(
      path.join(sourceRoot, "skills", skillName),
      path.join(targetRoot, "skills", skillName)
    );
  }
}

async function isSameFileContent(src, dst, srcSize, dstSize) {
  if (srcSize !== dstSize) return false;
  const [srcBuffer, dstBuffer] = await Promise.all([fs.readFile(src), fs.readFile(dst)]);
  return srcBuffer.equals(dstBuffer);
}

async function buildTransferPlanCore(sourceRoot, targetRoot, scopeRelativePath) {
  const [sourceEntries, targetEntries] = await Promise.all([
    collectScopeEntries(sourceRoot, scopeRelativePath, "folder"),
    collectScopeEntries(targetRoot, scopeRelativePath, "folder")
  ]);
  const allPaths = [...new Set([...sourceEntries.keys(), ...targetEntries.keys()])];
  const rows = await mapWithConcurrency(allPaths, 12, async (relativePath) => {
    const sourceEntry = sourceEntries.get(relativePath);
    const targetEntry = targetEntries.get(relativePath);
    if (sourceEntry && !targetEntry) return "added";
    if (!sourceEntry && targetEntry) return "removed";
    if (sourceEntry && targetEntry && sourceEntry.kind !== targetEntry.kind) return "typeChanged";
    if (sourceEntry && targetEntry && sourceEntry.kind === "folder") return "same";
    if (sourceEntry && targetEntry) {
      const same = await isSameFileContent(
        sourceEntry.absolutePath,
        targetEntry.absolutePath,
        sourceEntry.size ?? 0,
        targetEntry.size ?? 0
      );
      return same ? "same" : "modified";
    }
    return "same";
  });
  return rows.reduce((summary, status) => {
    summary.total += 1;
    summary[status] += 1;
    return summary;
  }, { total: 0, added: 0, removed: 0, modified: 0, typeChanged: 0, same: 0 });
}

async function collectScopeEntriesSerial(toolRoot, scopeRelativePath, scopeKind) {
  const result = new Map();
  const scopePath = path.join(toolRoot, ...scopeRelativePath.split("/"));
  if (!(await exists(scopePath))) return result;

  const add = async (relativePath, absolutePath, kind) => {
    const stat = await fs.stat(absolutePath).catch(() => null);
    result.set(relativePath, {
      relativePath,
      absolutePath,
      kind,
      size: kind === "file" && stat ? stat.size : null
    });
  };

  const walk = async (dirPath, relPath) => {
    await add(relPath, dirPath, "folder");
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(dirPath, entry.name);
      const childRel = normalizeRel(path.posix.join(relPath, entry.name));
      if (!isManagedSkillPath(childRel)) continue;
      if (entry.isDirectory()) {
        await walk(absolute, childRel);
      } else if (entry.isFile()) {
        await add(childRel, absolute, "file");
      }
    }
  };

  const scopeStat = await fs.stat(scopePath).catch(() => null);
  if (!scopeStat) return result;
  if (scopeKind === "file" || scopeStat.isFile()) {
    await add(normalizeRel(scopeRelativePath), scopePath, "file");
    return result;
  }
  await walk(scopePath, normalizeRel(scopeRelativePath));
  return result;
}

async function buildTransferPlanSerial(sourceRoot, targetRoot, scopeRelativePath) {
  const sourceEntries = await collectScopeEntriesSerial(sourceRoot, scopeRelativePath, "folder");
  const targetEntries = await collectScopeEntriesSerial(targetRoot, scopeRelativePath, "folder");
  const allPaths = [...new Set([...sourceEntries.keys(), ...targetEntries.keys()])];
  const summary = { total: 0, added: 0, removed: 0, modified: 0, typeChanged: 0, same: 0 };
  for (const relativePath of allPaths) {
    const sourceEntry = sourceEntries.get(relativePath);
    const targetEntry = targetEntries.get(relativePath);
    summary.total += 1;
    if (sourceEntry && !targetEntry) {
      summary.added += 1;
    } else if (!sourceEntry && targetEntry) {
      summary.removed += 1;
    } else if (sourceEntry && targetEntry && sourceEntry.kind !== targetEntry.kind) {
      summary.typeChanged += 1;
    } else if (sourceEntry && targetEntry && sourceEntry.kind === "folder") {
      summary.same += 1;
    } else if (sourceEntry && targetEntry) {
      const same = await isSameFileContent(
        sourceEntry.absolutePath,
        targetEntry.absolutePath,
        sourceEntry.size ?? 0,
        targetEntry.size ?? 0
      );
      if (same) summary.same += 1;
      else summary.modified += 1;
    } else {
      summary.same += 1;
    }
  }
  return summary;
}

async function mapWithConcurrency(items, limit, mapper) {
  if (items.length === 0) return [];
  if (items.length === 1) return [await mapper(items[0], 0)];
  const cappedLimit = Math.max(1, Math.min(limit, items.length));
  const results = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: cappedLimit }, () => worker()));
  return results;
}

async function scanAgentRoots(workspacePath, agentRoots, concurrent) {
  const scanner = async (agentRoot) => {
    const root = path.join(workspacePath, agentRoot);
    const files = await collectVsCodeFiles(root, root);
    return files
      .filter(isManagedSkillPath)
      .map((relativePath) => ({
        agentRoot,
        relativePath
      }));
  };
  const byRoot = concurrent
    ? await mapWithConcurrency(agentRoots, 6, scanner)
    : await serialMap(agentRoots, scanner);
  return byRoot.flat();
}

async function scanManagedSkillRootsSerial(workspacePath, agentRoots) {
  const out = [];
  for (const agentRoot of agentRoots) {
    const skillsRoot = path.join(workspacePath, agentRoot, "skills");
    if (!(await exists(skillsRoot))) continue;
    const files = await collectFilesSerial(skillsRoot);
    for (const relativePath of files) {
      out.push({
        agentRoot,
        relativePath: path.posix.join("skills", relativePath)
      });
    }
  }
  return out;
}

function isManagedSkillPath(relativePath) {
  const normalized = String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
  return normalized === "skills" || normalized.startsWith("skills/");
}

function normalizeRel(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

async function scanSkillFilesForTools(workspacePath, agentTools) {
  return await scanSkillFiles(workspacePath, "workspace", agentTools);
}

async function serialMap(items, mapper) {
  const out = [];
  for (let index = 0; index < items.length; index += 1) {
    out.push(await mapper(items[index], index));
  }
  return out;
}

async function writeFixtureSkill(root, skillIndex, filesPerSkill, depth) {
  const skillName = `skill-${String(skillIndex).padStart(3, "0")}`;
  const skillRoot = path.join(root, "skills", skillName);
  await fs.mkdir(skillRoot, { recursive: true });
  await fs.writeFile(path.join(skillRoot, "SKILL.md"), `# ${skillName}\n`, "utf8");

  for (let fileIndex = 0; fileIndex < filesPerSkill; fileIndex += 1) {
    const segments = [];
    for (let depthIndex = 0; depthIndex < depth; depthIndex += 1) {
      segments.push(`section ${depthIndex}-${fileIndex % 5}`);
    }
    const dir = path.join(skillRoot, ...segments);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `file-${String(fileIndex).padStart(4, "0")}.md`),
      `# ${skillName} file ${fileIndex}\n\n${"content\n".repeat(8)}`,
      "utf8"
    );
  }

  return skillName;
}

async function writeRootNoise(root, count) {
  for (let index = 0; index < count; index += 1) {
    const dir = path.join(root, "cache", `bucket-${index % 4}`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `noise-${String(index).padStart(4, "0")}.json`),
      JSON.stringify({ index, ignored: true }),
      "utf8"
    );
  }
}

async function createFixture(options) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skill-bridge-benchmark "));
  const workspacePath = path.join(tmp, "workspace with spaces");
  const agentTools = AGENT_TOOLS.slice(0, Math.min(options.agents, AGENT_TOOLS.length));
  const agentRoots = agentTools.map((tool) => AGENT_ROOT_BY_TOOL[tool]);
  const workspaceRoot = path.join(workspacePath, ".codex");
  const transferTargetRoot = path.join(tmp, "central with spaces", "codex");
  for (const agentRoot of agentRoots) {
    await fs.mkdir(path.join(workspacePath, agentRoot), { recursive: true });
    await writeRootNoise(path.join(workspacePath, agentRoot), options.rootNoiseFiles);
  }

  const skillNames = [];
  for (let index = 0; index < options.skills; index += 1) {
    const skillName = await writeFixtureSkill(workspaceRoot, index, options.filesPerSkill, options.depth);
    skillNames.push(skillName);
    for (const agentRoot of agentRoots.filter((item) => item !== ".codex")) {
      await writeFixtureSkill(path.join(workspacePath, agentRoot), index, options.filesPerSkill, options.depth);
    }
  }

  await copyDirectorySerial(workspaceRoot, transferTargetRoot);
  const modifiedSkill = skillNames[0];
  if (modifiedSkill) {
    const sameSizeTarget = path.join(
      transferTargetRoot,
      "skills",
      modifiedSkill,
      "section 0-0",
      "section 1-0",
      "file-0000.md"
    );
    const original = await fs.readFile(sameSizeTarget, "utf8");
    await fs.writeFile(sameSizeTarget, original.replace("content", "changed"), "utf8");
  }

  return { tmp, workspacePath, workspaceRoot, transferTargetRoot, agentRoots, agentTools, skillNames };
}

async function measure(name, rounds, task) {
  const samples = [];
  for (let index = 0; index < rounds; index += 1) {
    const started = performance.now();
    const detail = await task(index);
    const durationMs = performance.now() - started;
    samples.push({ durationMs, detail });
  }
  const durations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
  const total = durations.reduce((sum, value) => sum + value, 0);
  return {
    name,
    rounds,
    minMs: round(durations[0] ?? 0),
    maxMs: round(durations[durations.length - 1] ?? 0),
    avgMs: round(total / Math.max(1, durations.length)),
    medianMs: round(durations[Math.floor(durations.length / 2)] ?? 0),
    lastDetail: samples[samples.length - 1]?.detail ?? null
  };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

async function loadBaseline(comparePath) {
  if (!comparePath) return null;
  if (!(await exists(comparePath))) {
    throw new Error(`Compare file does not exist: ${comparePath}`);
  }
  return JSON.parse(await fs.readFile(comparePath, "utf8"));
}

function compareResults(current, baseline) {
  if (!baseline || !Array.isArray(baseline.results)) return [];
  const baselineByName = new Map(baseline.results.map((item) => [item.name, item]));
  return current.results.map((item) => {
    const previous = baselineByName.get(item.name);
    if (!previous || typeof previous.avgMs !== "number" || previous.avgMs <= 0) {
      return {
        name: item.name,
        previousAvgMs: null,
        currentAvgMs: item.avgMs,
        avgChangePercent: null,
        previousMedianMs: null,
        currentMedianMs: item.medianMs,
        medianChangePercent: null
      };
    }
    const medianChangePercent = typeof previous.medianMs === "number" && previous.medianMs > 0
      ? round(((item.medianMs - previous.medianMs) / previous.medianMs) * 100)
      : null;
    return {
      name: item.name,
      previousAvgMs: previous.avgMs,
      currentAvgMs: item.avgMs,
      avgChangePercent: round(((item.avgMs - previous.avgMs) / previous.avgMs) * 100),
      previousMedianMs: typeof previous.medianMs === "number" ? previous.medianMs : null,
      currentMedianMs: item.medianMs,
      medianChangePercent
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

function buildControlSpeedups(results) {
  const byName = new Map(results.map((item) => [item.name, item]));
  const pairs = [
    ["vscode.collectFiles", "control.serialCollectFiles"],
    ["core.collectFiles", "control.serialCollectFiles"],
    ["core.copyDirectory", "control.serialCopyDirectory"],
    ["vscode.applyTransferQueueCore", "control.serialApplyTransferQueue"],
    ["vscode.scanAgentRoots", "control.serialScanManagedSkillRoots"],
    ["vscode.transferPlanCore", "control.serialTransferPlan"]
  ];
  return pairs
    .map(([operation, control]) => {
      const current = byName.get(operation);
      const baseline = byName.get(control);
      if (!current || !baseline || current.medianMs <= 0) return null;
      return {
        operation,
        control,
        medianSpeedup: round(baseline.medianMs / current.medianMs),
        avgSpeedup: current.avgMs > 0 ? round(baseline.avgMs / current.avgMs) : null
      };
    })
    .filter(Boolean);
}

function findSpeedupFailures(controlSpeedups, requirements) {
  if (requirements.size === 0) return [];
  const byOperation = new Map(controlSpeedups.map((item) => [item.operation, item]));
  const failures = [];
  for (const [operation, minimumSpeedup] of requirements.entries()) {
    const speedup = byOperation.get(operation);
    if (!speedup) {
      failures.push({
        operation,
        minimumSpeedup,
        medianSpeedup: null,
        reason: "missing-speedup"
      });
      continue;
    }
    if (speedup.medianSpeedup < minimumSpeedup) {
      failures.push({
        operation,
        minimumSpeedup,
        medianSpeedup: speedup.medianSpeedup,
        reason: "below-minimum"
      });
    }
  }
  return failures;
}

function expectedScopeEntryCount(options) {
  const branchCount = Math.min(options.filesPerSkill, 5);
  const folderCount = 1 + (options.depth * branchCount);
  const fileCount = options.filesPerSkill + 1;
  return folderCount + fileCount;
}

function expectedTransferPlanItemCount(options) {
  const branchCount = Math.min(options.filesPerSkill, 5);
  const foldersPerSkill = 1 + (options.depth * branchCount);
  const filesPerSkill = options.filesPerSkill + 1;
  return 1 + (options.skills * (foldersPerSkill + filesPerSkill));
}

function validateResultDetails(output) {
  const expected = {
    singleRootFiles: output.fixture.expectedSingleRootFiles,
    agentScanFiles: output.fixture.expectedAgentScanFiles,
    copiedFiles: output.options.filesPerSkill + 1,
    queuedCopiedFiles: output.fixture.expectedManagedFiles,
    scopeEntries: expectedScopeEntryCount(output.options),
    transferPlanItems: output.fixture.expectedTransferPlanItems
  };
  const checks = new Map([
    ["vscode.collectFiles", { key: "fileCount", value: expected.singleRootFiles }],
    ["core.collectFiles", { key: "fileCount", value: expected.singleRootFiles }],
    ["vscode.collectScopeEntries", { key: "entryCount", value: expected.scopeEntries }],
    ["core.copyDirectory", { key: "copiedFiles", value: expected.copiedFiles }],
    ["vscode.applyTransferQueueCore", { key: "copiedFiles", value: expected.queuedCopiedFiles }],
    ["vscode.scanAgentRoots", { key: "fileCount", value: expected.agentScanFiles }],
    ["vscode.transferPlanCore", { key: "total", value: expected.transferPlanItems }],
    ["control.serialCollectFiles", { key: "fileCount", value: expected.singleRootFiles }],
    ["control.serialCopyDirectory", { key: "copiedFiles", value: expected.copiedFiles }],
    ["control.serialApplyTransferQueue", { key: "copiedFiles", value: expected.queuedCopiedFiles }],
    ["control.serialScanManagedSkillRoots", { key: "fileCount", value: expected.agentScanFiles }],
    ["control.serialScanAgentRoots", { key: "fileCount", value: expected.agentScanFiles }],
    ["control.serialTransferPlan", { key: "total", value: expected.transferPlanItems }]
  ]);
  const failures = [];
  for (const result of output.results) {
    const check = checks.get(result.name);
    if (!check) continue;
    const actual = result.lastDetail?.[check.key];
    if (actual !== check.value) {
      failures.push({
        operation: result.name,
        field: check.key,
        expected: check.value,
        actual: actual ?? null
      });
    }
  }
  return failures;
}

function formatPercent(value) {
  if (typeof value !== "number") return "";
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value}%`;
}

function formatMarkdownSummary(output) {
  const rows = output.results.map((item) => {
    const comparison = Array.isArray(output.comparison)
      ? output.comparison.find((entry) => entry.name === item.name)
      : null;
    return [
      item.name,
      String(item.medianMs),
      String(item.avgMs),
      String(item.minMs),
      String(item.maxMs),
      comparison ? formatPercent(comparison.medianChangePercent) : "",
      comparison ? formatPercent(comparison.avgChangePercent) : ""
    ];
  });
  const lines = [
    "## Skill Bridge File Operations Benchmark",
    "",
    `- Platform: \`${output.platform}\``,
    `- Node: \`${output.node}\``,
    `- Fixture: ${output.fixture.skillCount} skills, ${output.fixture.expectedManagedFiles} managed files per agent root`,
    `- Root noise: ${output.fixture.rootNoiseFilesPerAgent} ignored files per agent root`,
    `- Agent roots: ${output.fixture.agentCount}`,
    `- Rounds: ${output.options.rounds}`,
    "",
    "| Operation | Median ms | Avg ms | Min ms | Max ms | Median change | Avg change |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows.map((row) => `| ${row.join(" | ")} |`)
  ];
  if (Array.isArray(output.medianRegressions) && output.medianRegressions.length > 0) {
    lines.push("", `Median regressions over ${output.maxMedianRegressionPercent}%:`);
    for (const item of output.medianRegressions) {
      lines.push(`- ${item.name}: ${formatPercent(item.medianChangePercent)}`);
    }
  }
  if (Array.isArray(output.controlSpeedups) && output.controlSpeedups.length > 0) {
    lines.push(
      "",
      "| Operation | Control | Median speedup | Avg speedup |",
      "| --- | --- | ---: | ---: |"
    );
    for (const item of output.controlSpeedups) {
      lines.push(`| ${item.operation} | ${item.control} | ${item.medianSpeedup}x | ${item.avgSpeedup ?? ""}x |`);
    }
  }
  if (Array.isArray(output.speedupFailures) && output.speedupFailures.length > 0) {
    lines.push("", "Speedup requirements not met:");
    for (const item of output.speedupFailures) {
      lines.push(`- ${item.operation}: median ${item.medianSpeedup ?? "n/a"}x, required ${item.minimumSpeedup}x`);
    }
  }
  if (Array.isArray(output.correctnessFailures) && output.correctnessFailures.length > 0) {
    lines.push("", "Correctness checks failed:");
    for (const item of output.correctnessFailures) {
      lines.push(`- ${item.operation}.${item.field}: expected ${item.expected}, got ${item.actual}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

async function writeMarkdownSummaryIfRequested(output, summaryPath) {
  const target = summaryPath || process.env.GITHUB_STEP_SUMMARY || null;
  if (!target) return;
  await fs.mkdir(path.dirname(path.resolve(target)), { recursive: true });
  await fs.appendFile(target, formatMarkdownSummary(output), "utf8");
}

async function run() {
  const preset = readPresetDefaults();
  const options = {
    preset: preset.name,
    skills: readNumberArg("--skills", preset.values.skills),
    filesPerSkill: readNumberArg("--files", preset.values.filesPerSkill),
    depth: readNumberArg("--depth", preset.values.depth),
    rounds: readNumberArg("--rounds", preset.values.rounds),
    agents: readNumberArg("--agents", preset.values.agents),
    rootNoiseFiles: readNumberArg("--noise-files", preset.values.rootNoiseFiles)
  };
  const writePath = readStringArg("--write");
  const comparePath = readStringArg("--compare");
  const summaryPath = readStringArg("--summary");
  const matrixOs = readStringArg("--os") ?? process.env.RUNNER_OS ?? process.platform;
  const matrixNodeMajor = readStringArg("--node-major") ?? getNodeMajor();
  const maxMedianRegressionPercent = readOptionalPercentArg("--fail-on-median-regression");
  const minSpeedupRequirements = readSpeedupRequirementsArg("--fail-on-min-speedup");
  const includeControl = process.argv.includes("--include-control");
  const keepTemp = process.argv.includes("--keep");
  const fixture = await createFixture(options);
  let shouldClean = !keepTemp;

  try {
    const firstSkill = fixture.skillNames[0];
    const copySource = path.join(fixture.workspaceRoot, "skills", firstSkill);
    const results = [];

    results.push(await measure("vscode.collectFiles", options.rounds, async () => {
      const files = await collectVsCodeFiles(fixture.workspaceRoot, fixture.workspaceRoot);
      return { fileCount: files.length };
    }));
    results.push(await measure("core.collectFiles", options.rounds, async () => {
      const files = await collectCoreFiles(fixture.workspaceRoot);
      return { fileCount: files.length };
    }));
    results.push(await measure("vscode.collectScopeEntries", options.rounds, async () => {
      const entries = await collectScopeEntries(fixture.workspaceRoot, `skills/${firstSkill}`, "folder");
      return { entryCount: entries.size };
    }));
    results.push(await measure("core.copyDirectory", options.rounds, async (index) => {
      const target = path.join(fixture.tmp, `copy-${index}`);
      await copyDirectory(copySource, target);
      const files = await collectCoreFiles(target);
      return { copiedFiles: files.length };
    }));
    results.push(await measure("vscode.applyTransferQueueCore", options.rounds, async (index) => {
      const target = path.join(fixture.tmp, `apply-queue-${index}`);
      await copySkillFoldersQueued(fixture.workspaceRoot, target, fixture.skillNames);
      const files = await collectCoreFiles(target);
      return { copiedFiles: files.length };
    }));
    results.push(await measure("vscode.scanAgentRoots", options.rounds, async () => {
      const files = await scanSkillFilesForTools(fixture.workspacePath, fixture.agentTools);
      return { fileCount: files.length, agentCount: fixture.agentTools.length };
    }));
    results.push(await measure("vscode.transferPlanCore", options.rounds, async () => {
      return await buildTransferPlanCore(fixture.workspaceRoot, fixture.transferTargetRoot, "skills");
    }));

    if (includeControl) {
      results.push(await measure("control.serialCollectFiles", options.rounds, async () => {
        const files = await collectFilesSerial(fixture.workspaceRoot);
        return { fileCount: files.length };
      }));
      results.push(await measure("control.serialCopyDirectory", options.rounds, async (index) => {
        const target = path.join(fixture.tmp, `serial-copy-${index}`);
        await copyDirectorySerial(copySource, target);
        const files = await collectFilesSerial(target);
        return { copiedFiles: files.length };
      }));
      results.push(await measure("control.serialApplyTransferQueue", options.rounds, async (index) => {
        const target = path.join(fixture.tmp, `serial-apply-queue-${index}`);
        await copySkillFoldersSerial(fixture.workspaceRoot, target, fixture.skillNames);
        const files = await collectFilesSerial(target);
        return { copiedFiles: files.length };
      }));
      results.push(await measure("control.serialScanManagedSkillRoots", options.rounds, async () => {
        const files = await scanManagedSkillRootsSerial(fixture.workspacePath, fixture.agentRoots);
        return { fileCount: files.length, agentCount: fixture.agentRoots.length };
      }));
      results.push(await measure("control.serialScanAgentRoots", options.rounds, async () => {
        const files = await scanAgentRoots(fixture.workspacePath, fixture.agentRoots, false);
        return { fileCount: files.length, agentCount: fixture.agentRoots.length };
      }));
      results.push(await measure("control.serialTransferPlan", options.rounds, async () => {
        return await buildTransferPlanSerial(fixture.workspaceRoot, fixture.transferTargetRoot, "skills");
      }));
    }

    const controlSpeedups = includeControl ? buildControlSpeedups(results) : [];
    const speedupFailures = findSpeedupFailures(controlSpeedups, minSpeedupRequirements);
    const outputBase = {
      ok: true,
      os: matrixOs,
      nodeMajor: matrixNodeMajor,
      platform: process.platform,
      node: process.version,
      options,
      includeControl,
      fixture: {
        skillCount: fixture.skillNames.length,
        agentCount: fixture.agentRoots.length,
        rootNoiseFilesPerAgent: options.rootNoiseFiles,
        expectedManagedFiles: options.skills * (options.filesPerSkill + 1),
        expectedSingleRootFiles: options.skills * (options.filesPerSkill + 1) + options.rootNoiseFiles,
        expectedAgentScanFiles: fixture.agentRoots.length * options.skills * (options.filesPerSkill + 1),
        expectedTransferPlanItems: expectedTransferPlanItemCount(options)
      },
      results,
      ...(includeControl ? { controlSpeedups } : {}),
      ...(minSpeedupRequirements.size > 0 ? {
        minSpeedupRequirements: Object.fromEntries(minSpeedupRequirements.entries()),
        speedupFailures
      } : {})
    };
    const correctnessFailures = validateResultDetails(outputBase);
    const output = correctnessFailures.length > 0
      ? { ...outputBase, correctnessFailures }
      : outputBase;
    const baseline = await loadBaseline(comparePath);
    const comparison = compareResults(output, baseline);
    const medianRegressions = findMedianRegressions(comparison, maxMedianRegressionPercent);
    const finalOutput = {
      ...output,
      ...(comparison.length > 0 ? { comparison } : {}),
      ...(maxMedianRegressionPercent !== null ? { maxMedianRegressionPercent, medianRegressions } : {})
    };

    if (writePath) {
      await fs.mkdir(path.dirname(path.resolve(writePath)), { recursive: true });
      await fs.writeFile(writePath, `${JSON.stringify(finalOutput, null, 2)}\n`, "utf8");
    }
    await writeMarkdownSummaryIfRequested(finalOutput, summaryPath);

    console.log(JSON.stringify(finalOutput, null, 2));
    if (medianRegressions.length > 0 || speedupFailures.length > 0 || correctnessFailures.length > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    shouldClean = false;
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({
      ok: false,
      os: matrixOs,
      nodeMajor: matrixNodeMajor,
      platform: process.platform,
      node: process.version,
      options,
      tmp: fixture.tmp,
      message
    }, null, 2));
    process.exitCode = 1;
  } finally {
    if (shouldClean) {
      await fs.rm(fixture.tmp, { recursive: true, force: true });
    }
  }
}

run();
