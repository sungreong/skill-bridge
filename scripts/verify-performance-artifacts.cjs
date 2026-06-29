const { spawnSync } = require("node:child_process");

function readStringArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function runStep(label, args, env = {}) {
  console.log(`\n[verify-performance-artifacts] ${label}`);
  const command = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "npm";
  const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", "npm", ...args] : args;
  const result = spawnSync(command, commandArgs, {
    stdio: "inherit",
    shell: false,
    env: { ...process.env, ...env },
    windowsHide: process.platform === "win32"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const benchmarkDir = readStringArg("--benchmark-dir", ".benchmarks/artifacts");
const loadingDir = readStringArg("--loading-dir", ".benchmarks/loading-artifacts");
const transferDir = readStringArg("--transfer-dir", ".benchmarks/transfer-artifacts");
const smokeDir = readStringArg("--smoke-dir", ".benchmarks/smoke-artifacts");
const vsixDir = readStringArg("--vsix-dir", ".benchmarks/vsix-artifacts");
const outDir = readStringArg("--out-dir", ".benchmarks");

console.log("[verify-performance-artifacts] Using isolated artifact directories:");
console.log(`  benchmark: ${benchmarkDir}`);
console.log(`  loading:   ${loadingDir}`);
console.log(`  transfer:  ${transferDir}`);
console.log(`  smoke:     ${smokeDir}`);
console.log(`  vsix:      ${vsixDir}`);
console.log(`  out:       ${outDir}`);

runStep("Compare smoke benchmark artifact matrix", [
  "run",
  "compare:file-ops-artifacts",
  "--",
  "--dir",
  benchmarkDir,
  "--summary",
  `${outDir}/file-ops-artifacts.md`,
  "--require-matrix",
  "--require-preset",
  "smoke"
]);

runStep("Compare loading benchmark artifact matrix", [
  "run",
  "compare:loading-file-ops-artifacts",
  "--",
  "--dir",
  loadingDir,
  "--summary",
  `${outDir}/loading-file-ops-artifacts.md`,
  "--require-matrix",
  "--require-preset",
  "loading"
]);

runStep("Compare transfer benchmark artifact matrix", [
  "run",
  "compare:transfer-file-ops-artifacts",
  "--",
  "--dir",
  transferDir,
  "--summary",
  `${outDir}/transfer-file-ops-artifacts.md`,
  "--require-matrix",
  "--require-preset",
  "transfer"
]);

runStep("Compare smoke compatibility artifact matrix", [
  "run",
  "compare:smoke-file-ops-artifacts",
  "--",
  "--dir",
  smokeDir,
  "--summary",
  `${outDir}/smoke-file-ops-artifacts.md`,
  "--require-matrix"
]);

runStep("Compare VSIX artifact matrix", [
  "run",
  "compare:vsix-artifacts",
  "--",
  "--dir",
  vsixDir,
  "--summary",
  `${outDir}/vsix-artifacts.md`,
  "--require-matrix"
]);

runStep("Generate verified performance status", [
  "run",
  "report:performance-status",
  "--",
  "--summary",
  `${outDir}/performance-status.md`,
  "--benchmark-artifact-summary",
  `${outDir}/file-ops-artifacts.md`,
  "--loading-artifact-summary",
  `${outDir}/loading-file-ops-artifacts.md`,
  "--transfer-artifact-summary",
  `${outDir}/transfer-file-ops-artifacts.md`,
  "--smoke-artifact-summary",
  `${outDir}/smoke-file-ops-artifacts.md`,
  "--vsix-artifact-summary",
  `${outDir}/vsix-artifacts.md`
], { GITHUB_ACTIONS: "true" });
