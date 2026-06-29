const fs = require("node:fs/promises");
const path = require("node:path");

function readStringArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function toPosix(filePath) {
  return filePath.split(path.sep).join("/");
}

async function run() {
  const outDir = readStringArg("--out-dir", ".benchmarks");
  const root = path.resolve(outDir);
  const directories = [
    "artifacts",
    "loading-artifacts",
    "transfer-artifacts",
    "smoke-artifacts",
    "vsix-artifacts"
  ];

  await fs.mkdir(root, { recursive: true });
  for (const directory of directories) {
    await fs.mkdir(path.join(root, directory), { recursive: true });
  }

  const guidePath = path.join(root, "ARTIFACT_LAYOUT.md");
  const lines = [
    "# Skill Bridge Performance Artifact Layout",
    "",
    "Download GitHub Actions artifacts into these isolated folders before comparing:",
    "",
    `- \`${toPosix(path.join(outDir, "artifacts"))}\`: \`file-ops-*\` benchmark artifacts`,
    `- \`${toPosix(path.join(outDir, "loading-artifacts"))}\`: \`loading-file-ops-*\` benchmark artifacts`,
    `- \`${toPosix(path.join(outDir, "transfer-artifacts"))}\`: \`transfer-file-ops-*\` benchmark artifacts`,
    `- \`${toPosix(path.join(outDir, "smoke-artifacts"))}\`: \`smoke-file-ops-*\` compatibility artifacts`,
    `- \`${toPosix(path.join(outDir, "vsix-artifacts"))}\`: \`skill-bridge-vscode-*\` VSIX artifacts`,
    "",
    "Then run:",
    "",
    "```bash",
    `npm run verify:performance-artifacts -- --benchmark-dir ${toPosix(path.join(outDir, "artifacts"))} --loading-dir ${toPosix(path.join(outDir, "loading-artifacts"))} --transfer-dir ${toPosix(path.join(outDir, "transfer-artifacts"))} --smoke-dir ${toPosix(path.join(outDir, "smoke-artifacts"))} --vsix-dir ${toPosix(path.join(outDir, "vsix-artifacts"))} --out-dir ${toPosix(outDir)}`,
    "```",
    "",
    "Keep local benchmark JSON such as `performance-check.json` out of these artifact folders; mixed or stale files are intentionally reported as failures.",
    ""
  ];
  await fs.writeFile(guidePath, lines.join("\n"), "utf8");

  console.log("[prepare-performance-artifacts] Ready:");
  for (const directory of directories) {
    console.log(`  ${toPosix(path.join(outDir, directory))}`);
  }
  console.log(`  ${toPosix(path.join(outDir, "ARTIFACT_LAYOUT.md"))}`);
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[prepare-performance-artifacts] ${message}`);
  process.exitCode = 1;
});
