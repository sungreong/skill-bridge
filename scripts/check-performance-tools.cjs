const fs = require("node:fs/promises");
const path = require("node:path");

const REQUIRED_SCRIPTS = [
  "check:performance",
  "check:file-ops-comparers",
  "benchmark:file-ops:dist",
  "benchmark:file-ops:loading",
  "compare:file-ops-artifacts",
  "compare:loading-file-ops-artifacts",
  "compare:transfer-file-ops-artifacts",
  "compare:smoke-file-ops-artifacts",
  "compare:vsix-artifacts",
  "prepare:performance-artifacts",
  "check:prepare-performance-artifacts",
  "check:refresh-timings",
  "verify:performance-artifacts",
  "check:verify-performance-artifacts",
  "check:vscode-runtime-deps",
  "check:vsix-runtime-deps",
  "report:performance-status",
  "check:performance-status"
];

const REQUIRED_COMMAND_SNIPPETS = [
  "npm run check:performance",
  "npm run check:file-ops-comparers",
  "npm run benchmark:file-ops:dist -- --preset smoke --include-control",
  "npm run benchmark:file-ops:dist -- --preset loading --include-control",
  "npm run summarize:refresh-timings -- --input .benchmarks/refresh.log --summary .benchmarks/refresh-summary.md",
  "npm run summarize:refresh-timings -- --input .benchmarks/refresh.log --write .benchmarks/refresh-baseline.json",
  "npm run summarize:refresh-timings -- --input .benchmarks/refresh-new.log --compare .benchmarks/refresh-baseline.json --fail-on-median-regression 25",
  "npm run check:refresh-timings",
  "npm run prepare:performance-artifacts -- --out-dir .benchmarks",
  "# Download CI artifacts into .benchmarks/artifacts, .benchmarks/loading-artifacts, .benchmarks/transfer-artifacts, .benchmarks/smoke-artifacts, and .benchmarks/vsix-artifacts before artifact comparisons.",
  "npm run compare:file-ops-artifacts -- --dir .benchmarks/artifacts --summary .benchmarks/file-ops-artifacts.md --require-matrix --require-preset smoke",
  "npm run compare:loading-file-ops-artifacts -- --dir .benchmarks/loading-artifacts --summary .benchmarks/loading-file-ops-artifacts.md --require-matrix --require-preset loading",
  "npm run compare:transfer-file-ops-artifacts -- --dir .benchmarks/transfer-artifacts --summary .benchmarks/transfer-file-ops-artifacts.md --require-matrix --require-preset transfer",
  "npm run compare:smoke-file-ops-artifacts -- --dir .benchmarks/smoke-artifacts --summary .benchmarks/smoke-file-ops-artifacts.md --require-matrix",
  "npm run compare:vsix-artifacts -- --dir .benchmarks/vsix-artifacts --summary .benchmarks/vsix-artifacts.md --require-matrix",
  "npm run verify:performance-artifacts -- --benchmark-dir .benchmarks/artifacts --loading-dir .benchmarks/loading-artifacts --transfer-dir .benchmarks/transfer-artifacts --smoke-dir .benchmarks/smoke-artifacts --vsix-dir .benchmarks/vsix-artifacts --out-dir .benchmarks",
  "npm run report:performance-status -- --summary .benchmarks/performance-status.md",
  ".benchmarks/performance-status.md",
  "Open Performance Status"
];

async function run() {
  const packageJsonPath = path.join(process.cwd(), "package.json");
  const registrarPath = path.join(process.cwd(), "apps", "vscode", "src", "extensionCommandRegistrar.ts");
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  const registrar = await fs.readFile(registrarPath, "utf8");
  const scripts = packageJson.scripts && typeof packageJson.scripts === "object" ? packageJson.scripts : {};

  const missingScripts = REQUIRED_SCRIPTS.filter((scriptName) => typeof scripts[scriptName] !== "string");
  const missingCommandSnippets = REQUIRED_COMMAND_SNIPPETS.filter((snippet) => !registrar.includes(snippet));
  const missingCommandRegistration = registrar.includes('args.register("skillBridge.openPerformanceTools"') ? [] : ["skillBridge.openPerformanceTools registration"];

  const failures = [
    ...missingScripts.map((item) => `missing package script: ${item}`),
    ...missingCommandSnippets.map((item) => `missing Performance Tools command: ${item}`),
    ...missingCommandRegistration
  ];

  if (failures.length > 0) {
    console.error("[performance-tools] Missing required Performance Tools wiring:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log("[performance-tools] OK. VS Code Performance Tools command matches the benchmark and artifact scripts.");
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[performance-tools] ${message}`);
  process.exitCode = 1;
});
