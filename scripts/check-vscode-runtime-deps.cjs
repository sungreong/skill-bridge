const fs = require("node:fs/promises");
const path = require("node:path");

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function run() {
  const repoRoot = path.resolve(__dirname, "..");
  const vscodeRoot = path.join(repoRoot, "apps", "vscode");
  const runtimeCorePath = path.join(vscodeRoot, "dist", "vendor", "core-runtime");
  const vendorCoreJs = await fs.readFile(path.join(vscodeRoot, "dist", "vendor", "core.js"), "utf8");
  const extensionJs = await fs.readFile(path.join(vscodeRoot, "dist", "extension.js"), "utf8");
  const failures = [];

  if (!vendorCoreJs.includes('require("./core-runtime/index.js")')) {
    failures.push("dist/vendor/core.js must require ./core-runtime/index.js");
  }
  if (!extensionJs.includes('require("./vendor/core")')) {
    failures.push("dist/extension.js must load the local vendor/core bridge");
  }
  if (!await pathExists(path.join(runtimeCorePath, "package.json"))) {
    failures.push("apps/vscode/dist/vendor/core-runtime/package.json is missing");
  }
  if (!await pathExists(path.join(runtimeCorePath, "index.js"))) {
    failures.push("apps/vscode/dist/vendor/core-runtime/index.js is missing");
  }
  if (!await pathExists(path.join(runtimeCorePath, "shared.js"))) {
    failures.push("apps/vscode/dist/vendor/core-runtime/shared.js is missing");
  }
  if (!await pathExists(path.join(runtimeCorePath, "node_modules", "diff", "package.json"))) {
    failures.push("apps/vscode/dist/vendor/core-runtime/node_modules/diff/package.json is missing");
  }
  if (!await pathExists(path.join(runtimeCorePath, "node_modules", "diff", "libcjs", "index.js"))) {
    failures.push("apps/vscode/dist/vendor/core-runtime/node_modules/diff/libcjs/index.js is missing");
  }

  if (failures.length > 0) {
    console.error("[vscode-runtime-deps] Missing runtime dependency packaging:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log("[vscode-runtime-deps] OK. VSIX runtime dependencies include the dist-local core runtime and diff package.");
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[vscode-runtime-deps] ${message}`);
  process.exitCode = 1;
});
