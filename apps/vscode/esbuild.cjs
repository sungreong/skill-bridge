const esbuild = require("esbuild");
const fs = require("node:fs");

const production = process.argv.includes("--production");
fs.rmSync("dist", { recursive: true, force: true });

async function build() {
  await esbuild.build({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    outfile: "dist/extension.js",
    external: [
      "vscode",
      "./vendor/core"
    ],
    format: "cjs",
    platform: "node",
    sourcemap: !production,
    sourcesContent: false,
    minify: production,
    logLevel: "info"
  });

  if (!production) {
    await esbuild.build({
      entryPoints: [
        "src/installGrouping.ts",
        "src/skillPaths.ts",
        "src/skillScanner.ts",
        "src/writeTextFileIfChanged.ts"
      ],
      bundle: false,
      outdir: "dist",
      format: "cjs",
      platform: "node",
      sourcemap: true,
      sourcesContent: false,
      logLevel: "info"
    });
  }
}

build().catch(() => {
  process.exitCode = 1;
});
