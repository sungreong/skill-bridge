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

async function removeMatching(root, shouldRemove) {
  if (!await pathExists(root)) return;
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (shouldRemove(target, entry)) {
      await fs.rm(target, { recursive: true, force: true });
      continue;
    }
    if (entry.isDirectory()) {
      await removeMatching(target, shouldRemove);
    }
  }
}

async function run() {
  const repoRoot = path.resolve(__dirname, "..");
  const coreRoot = path.join(repoRoot, "packages", "core");
  const coreDist = path.join(coreRoot, "dist");
  const diffRuntimeRoot = path.join(repoRoot, "node_modules", "diff");
  const vscodeVendorRoot = path.join(repoRoot, "apps", "vscode", "dist", "vendor");
  const runtimeRoot = path.join(vscodeVendorRoot, "core-runtime");
  const corePackage = JSON.parse(await fs.readFile(path.join(coreRoot, "package.json"), "utf8"));

  if (!await pathExists(path.join(coreDist, "index.js"))) {
    throw new Error("packages/core/dist/index.js is missing. Run the core build before vendoring.");
  }
  if (!await pathExists(path.join(diffRuntimeRoot, "package.json"))) {
    throw new Error("node_modules/diff is missing. Run npm install before vendoring.");
  }

  await fs.rm(runtimeRoot, { recursive: true, force: true });
  await fs.mkdir(runtimeRoot, { recursive: true });
  await fs.cp(coreDist, runtimeRoot, { recursive: true });
  await removeMatching(runtimeRoot, (target, entry) => (
    entry.isFile() && (target.endsWith(".map") || target.endsWith(".d.ts"))
  ));
  await fs.mkdir(path.join(runtimeRoot, "node_modules"), { recursive: true });
  await fs.cp(diffRuntimeRoot, path.join(runtimeRoot, "node_modules", "diff"), { recursive: true });
  const vendoredDiffRoot = path.join(runtimeRoot, "node_modules", "diff");
  await removeMatching(vendoredDiffRoot, (target, entry) => {
    if (entry.isDirectory()) {
      return entry.name === "dist" || entry.name === "libesm";
    }
    if (!entry.isFile()) return false;
    if (target.endsWith(".js")) return false;
    if (path.basename(target) === "package.json") return false;
    return true;
  });
  await fs.writeFile(path.join(runtimeRoot, "package.json"), `${JSON.stringify({
    name: corePackage.name,
    version: corePackage.version,
    main: "index.js",
    private: true,
    dependencies: corePackage.dependencies ?? {}
  }, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(vscodeVendorRoot, "core.js"), [
    '"use strict";',
    'Object.defineProperty(exports, "__esModule", { value: true });',
    'const core = require("./core-runtime/index.js");',
    'for (const key of Object.keys(core)) {',
    '  if (key !== "default" && !Object.prototype.hasOwnProperty.call(exports, key)) {',
    '    Object.defineProperty(exports, key, { enumerable: true, get: () => core[key] });',
    '  }',
    '}',
    ""
  ].join("\n"), "utf8");

  console.log(`[vendor-vscode-core] Vendored ${corePackage.name}@${corePackage.version} and runtime dependencies into apps/vscode/dist/vendor/core-runtime.`);
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[vendor-vscode-core] ${message}`);
  process.exitCode = 1;
});
