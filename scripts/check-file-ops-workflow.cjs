const fs = require("node:fs/promises");
const path = require("node:path");

const requiredSnippets = [
  ["workflow_dispatch", "manual workflow dispatch trigger"],
  ["pull_request:", "pull request trigger"],
  ["ubuntu-latest", "Linux runner"],
  ["macos-latest", "macOS runner"],
  ["windows-latest", "Windows runner"],
  ['- "20"', "Node 20 matrix entry"],
  ['- "24"', "Node 24 matrix entry"],
  ["npm ci", "clean dependency install"],
  ["npm run check:file-ops-workflow", "workflow coverage guard step"],
  ["npm run check:performance-tools", "performance tools guard step"],
  ["npm run check:performance-status", "performance status guard step"],
  ["npm run check:refresh-timings", "refresh timing parser guard step"],
  ["npm run typecheck", "typecheck step"],
  ["npm run build", "build step"],
  ["npm --workspace apps/vscode run package:vsix", "VSIX package step with runtime dependency check"],
  ["Upload VSIX", "VSIX artifact upload"],
  ["name: skill-bridge-vscode-${{ matrix.os }}-node${{ matrix.node }}", "OS and Node specific VSIX artifact"],
  ["apps/vscode/skill-bridge-vscode-*.vsix", "VSIX artifact path"],
  ['npm run test:file-ops:dist -- --write ".benchmarks/smoke-file-ops-${{ matrix.os }}-node${{ matrix.node }}.json"', "cross-platform file operation smoke test artifact"],
  ["File operation symlink escape smoke test", "required Unix symlink escape smoke test step"],
  ["if: runner.os != 'Windows'", "Windows symlink permission exception"],
  ['npm run test:file-ops:dist -- --require-symlink-check --write ".benchmarks/smoke-file-ops-symlink-${{ matrix.os }}-node${{ matrix.node }}.json"', "mandatory symlink escape check artifact on Unix runners"],
  ["Upload smoke test result", "smoke test artifact upload"],
  ["name: smoke-file-ops-${{ matrix.os }}-node${{ matrix.node }}", "OS and Node specific smoke artifact"],
  ['.benchmarks/smoke-file-ops-${{ matrix.os }}-node${{ matrix.node }}.json', "base smoke JSON artifact"],
  ['.benchmarks/smoke-file-ops-symlink-${{ matrix.os }}-node${{ matrix.node }}.json', "Unix symlink smoke JSON artifact"],
  ["npm run benchmark:file-ops:dist -- --preset smoke --include-control --fail-on-min-speedup core.copyDirectory=1.1,vscode.collectFiles=1.1,core.collectFiles=1.1,vscode.applyTransferQueueCore=1.2,vscode.transferPlanCore=1.2 --os", "benchmark with serial controls, speedup gate, and OS metadata"],
  ['--node-major "${{ matrix.node }}"', "benchmark Node matrix metadata"],
  ['.benchmarks/file-ops-${{ matrix.os }}-node${{ matrix.node }}.json', "OS and Node specific benchmark artifact"],
  ["npm run benchmark:file-ops:dist -- --preset loading --include-control --fail-on-min-speedup core.copyDirectory=1.1,vscode.collectFiles=1.1,core.collectFiles=1.1,vscode.applyTransferQueueCore=1.2,vscode.transferPlanCore=1.2 --os", "loading benchmark with serial controls, speedup gate, and OS metadata"],
  ['.benchmarks/loading-file-ops-${{ matrix.os }}-node${{ matrix.node }}.json', "OS and Node specific loading benchmark artifact"],
  ["Upload loading benchmark result", "loading benchmark artifact upload"],
  ["name: loading-file-ops-${{ matrix.os }}-node${{ matrix.node }}", "OS and Node specific loading benchmark artifact name"],
  ["npm run benchmark:file-ops:dist -- --preset transfer --rounds 3 --include-control --fail-on-min-speedup core.copyDirectory=1.1,vscode.collectFiles=1.1,core.collectFiles=1.1,vscode.applyTransferQueueCore=1.2,vscode.transferPlanCore=1.2 --os", "transfer benchmark with serial controls, speedup gate, and OS metadata"],
  ['.benchmarks/transfer-file-ops-${{ matrix.os }}-node${{ matrix.node }}.json', "OS and Node specific transfer benchmark artifact"],
  ["Upload transfer benchmark result", "transfer benchmark artifact upload"],
  ["name: transfer-file-ops-${{ matrix.os }}-node${{ matrix.node }}", "OS and Node specific transfer benchmark artifact name"],
  ["actions/upload-artifact@v4", "benchmark artifact upload"],
  ["if-no-files-found: error", "artifact missing-file failure"],
  ["retention-days: 14", "benchmark artifact retention"],
  ["compare-file-ops:", "artifact comparison job"],
  ["needs: file-ops", "comparison waits for matrix job"],
  ["npm run check:file-ops-comparers", "artifact comparer self-check step"],
  ["actions/download-artifact@v4", "benchmark artifact download"],
  ["pattern: file-ops-*", "download all file operation artifacts"],
  ["pattern: loading-file-ops-*", "download all loading file operation artifacts"],
  ["pattern: transfer-file-ops-*", "download all transfer file operation artifacts"],
  ["pattern: smoke-file-ops-*", "download all smoke test artifacts"],
  ["pattern: skill-bridge-vscode-*", "download all VSIX artifacts"],
  ["npm run compare:file-ops-artifacts -- --dir .benchmarks/artifacts --summary .benchmarks/file-ops-artifacts.md --require-matrix --require-preset smoke", "required matrix artifact comparison"],
  ["npm run compare:loading-file-ops-artifacts -- --dir .benchmarks/loading-artifacts --summary .benchmarks/loading-file-ops-artifacts.md --require-matrix --require-preset loading", "required loading matrix artifact comparison"],
  ["npm run compare:transfer-file-ops-artifacts -- --dir .benchmarks/transfer-artifacts --summary .benchmarks/transfer-file-ops-artifacts.md --require-matrix --require-preset transfer", "required transfer matrix artifact comparison"],
  ["npm run compare:smoke-file-ops-artifacts -- --dir .benchmarks/smoke-artifacts --summary .benchmarks/smoke-file-ops-artifacts.md --require-matrix", "required smoke artifact comparison"],
  ["npm run compare:vsix-artifacts -- --dir .benchmarks/vsix-artifacts --summary .benchmarks/vsix-artifacts.md --require-matrix", "required VSIX artifact comparison"],
  ["npm run report:performance-status -- --summary .benchmarks/performance-status.md --transfer-artifact-summary .benchmarks/transfer-file-ops-artifacts.md", "performance status report"],
  ['cat .benchmarks/file-ops-artifacts.md .benchmarks/loading-file-ops-artifacts.md .benchmarks/transfer-file-ops-artifacts.md .benchmarks/smoke-file-ops-artifacts.md .benchmarks/vsix-artifacts.md .benchmarks/performance-status.md >> "$GITHUB_STEP_SUMMARY"', "comparison job summary"],
  [".benchmarks/performance-status.md", "performance status artifact"],
  [".benchmarks/loading-file-ops-artifacts.md", "loading performance status artifact"],
  [".benchmarks/transfer-file-ops-artifacts.md", "transfer performance status artifact"],
  [".benchmarks/vsix-artifacts.md", "VSIX performance status artifact"],
  ["name: file-ops-comparison", "comparison summary artifact"]
];

async function run() {
  const workflowPath = path.join(".github", "workflows", "file-ops.yml");
  const workflow = await fs.readFile(workflowPath, "utf8");
  const missing = requiredSnippets
    .filter(([snippet]) => !workflow.includes(snippet))
    .map(([, label]) => label);

  if (missing.length > 0) {
    console.error("[file-ops-workflow] Missing required workflow coverage:");
    for (const label of missing) {
      console.error(`  - ${label}`);
    }
    process.exitCode = 1;
  } else {
    console.log("[file-ops-workflow] OK. Cross-OS file operation workflow coverage is present.");
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[file-ops-workflow] ${message}`);
  process.exitCode = 1;
});
