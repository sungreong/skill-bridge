const { spawnSync } = require("node:child_process");

function runStep(label, args) {
  console.log(`\n[performance-check] ${label}`);
  const command = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "npm";
  const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", "npm", ...args] : args;
  const result = spawnSync(command, commandArgs, {
    stdio: "inherit",
    shell: false,
    windowsHide: process.platform === "win32"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

runStep("File operation workflow coverage", ["run", "check:file-ops-workflow"]);
runStep("File operation artifact comparers", ["run", "check:file-ops-comparers"]);
runStep("VS Code Performance Tools wiring", ["run", "check:performance-tools"]);
runStep("Performance artifact preparation", ["run", "check:prepare-performance-artifacts"]);
runStep("Refresh timing summaries", ["run", "check:refresh-timings"]);
runStep("Performance status behavior", ["run", "check:performance-status"]);
runStep("Performance artifact verifier", ["run", "check:verify-performance-artifacts"]);
runStep("VS Code command manifest", ["--workspace", "apps/vscode", "run", "check:manifest"]);
runStep("Build", ["run", "build"]);
runStep("Vendor VS Code runtime core", ["--workspace", "apps/vscode", "run", "vendor:core"]);
runStep("VS Code runtime dependencies", ["run", "check:vscode-runtime-deps"]);
runStep("Cross-platform file operation smoke test", ["run", "test:file-ops:dist"]);
runStep("File operation smoke benchmark", [
  "run",
  "benchmark:file-ops:dist",
  "--",
  "--preset",
  "smoke",
  "--include-control",
  "--fail-on-min-speedup",
  "core.copyDirectory=1.1,vscode.collectFiles=1.1,core.collectFiles=1.1,vscode.applyTransferQueueCore=1.2,vscode.transferPlanCore=1.2",
  "--summary",
  ".benchmarks/performance-check-summary.md",
  "--write",
  ".benchmarks/performance-check.json"
]);
runStep("File operation loading benchmark", [
  "run",
  "benchmark:file-ops:dist",
  "--",
  "--preset",
  "loading",
  "--include-control",
  "--fail-on-min-speedup",
  "core.copyDirectory=1.1,vscode.collectFiles=1.1,core.collectFiles=1.1,vscode.applyTransferQueueCore=1.2,vscode.transferPlanCore=1.2",
  "--summary",
  ".benchmarks/performance-loading-summary.md",
  "--write",
  ".benchmarks/performance-loading.json"
]);
runStep("File operation transfer benchmark", [
  "run",
  "benchmark:file-ops:dist",
  "--",
  "--preset",
  "transfer",
  "--rounds",
  "3",
  "--include-control",
  "--fail-on-min-speedup",
  "core.copyDirectory=1.1,vscode.applyTransferQueueCore=1.2,vscode.transferPlanCore=1.2",
  "--summary",
  ".benchmarks/performance-transfer-summary.md",
  "--write",
  ".benchmarks/performance-transfer.json"
]);
runStep("Performance status report", ["run", "report:performance-status", "--", "--summary", ".benchmarks/performance-status.md"]);
