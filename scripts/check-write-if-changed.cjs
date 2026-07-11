const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

async function run() {
  const { writeTextFileIfChanged } = require("../apps/vscode/dist/writeTextFileIfChanged.js");
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skill-bridge-write-if-changed-"));
  const target = path.join(tempRoot, "skill-groups.md");
  try {
    const created = await writeTextFileIfChanged(target, "first\n");
    if (!created) throw new Error("missing file should be created");
    const firstStat = await fs.stat(target);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const unchanged = await writeTextFileIfChanged(target, "first\n");
    if (unchanged) throw new Error("unchanged content should not be written");
    const unchangedStat = await fs.stat(target);
    if (unchangedStat.mtimeMs !== firstStat.mtimeMs) {
      throw new Error("unchanged content modified the file timestamp");
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
    const updated = await writeTextFileIfChanged(target, "second\n");
    if (!updated) throw new Error("changed content should be written");
    const updatedStat = await fs.stat(target);
    if (updatedStat.mtimeMs <= unchangedStat.mtimeMs) {
      throw new Error("changed content did not update the file timestamp");
    }
    if (await fs.readFile(target, "utf8") !== "second\n") {
      throw new Error("changed content was not persisted");
    }

    await fs.writeFile(target, "external\n", "utf8");
    const restored = await writeTextFileIfChanged(target, "second\n");
    if (!restored || await fs.readFile(target, "utf8") !== "second\n") {
      throw new Error("external file changes should invalidate the cache");
    }

    const benchmarkTarget = path.join(tempRoot, "benchmark.md");
    const benchmarkContent = `${"# Group\n- skill\n".repeat(1024)}`;
    const iterations = 200;
    let startedAt = process.hrtime.bigint();
    for (let index = 0; index < iterations; index += 1) {
      await fs.writeFile(benchmarkTarget, benchmarkContent, "utf8");
    }
    const alwaysWriteMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

    startedAt = process.hrtime.bigint();
    for (let index = 0; index < iterations; index += 1) {
      await writeTextFileIfChanged(benchmarkTarget, benchmarkContent);
    }
    const writeIfChangedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const speedup = alwaysWriteMs / Math.max(writeIfChangedMs, 0.001);

    console.log("[write-if-changed] OK. Unchanged generated Markdown avoids a filesystem write.");
    console.log(`[write-if-changed] benchmark iterations=${iterations} alwaysWrite=${alwaysWriteMs.toFixed(2)}ms writeIfChanged=${writeIfChangedMs.toFixed(2)}ms speedup=${speedup.toFixed(2)}x`);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(`[write-if-changed] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
