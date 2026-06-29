const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const REQUIRED_DIRECTORIES = [
  "artifacts",
  "loading-artifacts",
  "transfer-artifacts",
  "smoke-artifacts",
  "vsix-artifacts"
];

const REQUIRED_GUIDE_SNIPPETS = [
  "file-ops-*",
  "loading-file-ops-*",
  "transfer-file-ops-*",
  "smoke-file-ops-*",
  "skill-bridge-vscode-*",
  "verify:performance-artifacts",
  "--benchmark-dir",
  "--loading-dir",
  "--transfer-dir",
  "--smoke-dir",
  "--vsix-dir",
  "mixed or stale files"
];

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function run() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skill-bridge-artifacts-"));
  const outDir = path.join(tempRoot, "benchmarks");
  const markerPath = path.join(outDir, "keep-me.txt");
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(markerPath, "existing local file", "utf8");

  const result = spawnSync(process.execPath, [
    path.join(process.cwd(), "scripts", "prepare-performance-artifacts.cjs"),
    "--out-dir",
    outDir
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: false,
    windowsHide: process.platform === "win32"
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
    throw new Error(output || `prepare-performance-artifacts exited with ${result.status}`);
  }

  const failures = [];
  for (const directory of REQUIRED_DIRECTORIES) {
    const directoryPath = path.join(outDir, directory);
    const stat = await fs.stat(directoryPath).catch(() => undefined);
    if (!stat?.isDirectory()) failures.push(`missing directory: ${directory}`);
  }

  if (!(await exists(markerPath))) {
    failures.push("existing files should be preserved");
  }

  const guidePath = path.join(outDir, "ARTIFACT_LAYOUT.md");
  const guide = await fs.readFile(guidePath, "utf8").catch(() => "");
  for (const snippet of REQUIRED_GUIDE_SNIPPETS) {
    if (!guide.includes(snippet)) failures.push(`guide missing: ${snippet}`);
  }

  if (failures.length > 0) {
    console.error("[prepare-performance-artifacts-check] Failures:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }

  await fs.rm(tempRoot, { recursive: true, force: true });
  console.log("[prepare-performance-artifacts-check] OK. Artifact preparation is non-destructive and documents isolated artifact directories.");
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[prepare-performance-artifacts-check] ${message}`);
  process.exitCode = 1;
});
