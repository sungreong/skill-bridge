const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  collectFiles: collectVsCodeFiles,
  collectScopeEntries,
  resolveSkillPath
} = require("../apps/vscode/dist/skillPaths.js");
const {
  collectFiles: collectCoreFiles,
  copyDirectory,
  resolveSkillPath: resolveCoreSkillPath
} = require("../packages/core/dist/shared.js");

const requireSymlinkCheck = process.argv.includes("--require-symlink-check");
const writePath = readOption("--write");

async function writeFixtureSkill(root, skillName) {
  const skillRoot = path.join(root, "skills", skillName);
  await fs.mkdir(path.join(skillRoot, "nested", "deeper folder"), { recursive: true });
  await fs.writeFile(path.join(skillRoot, "SKILL.md"), `# ${skillName}\n`, "utf8");
  await fs.writeFile(path.join(skillRoot, "nested", "notes.txt"), "hello", "utf8");
  await fs.writeFile(path.join(skillRoot, "nested", "deeper folder", "data.json"), "{}\n", "utf8");
  return skillRoot;
}

async function tryCreateSymlink(target, linkPath, type) {
  try {
    await fs.symlink(target, linkPath, type);
    return true;
  } catch {
    return false;
  }
}

function assertIncludes(values, expected, label) {
  if (!values.includes(expected)) {
    throw new Error(`${label} missing ${expected}. Got: ${JSON.stringify(values)}`);
  }
}

function normalizeList(values) {
  return values.map((item) => item.replace(/\\/g, "/")).sort();
}

function assertRejectsPathTraversal(label, fn) {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(`${label} allowed path traversal.`);
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

async function emitReport(report) {
  const text = `${JSON.stringify(report, null, 2)}\n`;
  console.log(text.trimEnd());
  if (!writePath) return;
  await fs.mkdir(path.dirname(writePath), { recursive: true });
  await fs.writeFile(writePath, text, "utf8");
}

async function run() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skill bridge file ops "));
  let shouldClean = true;

  try {
    const workspacePath = path.join(tmp, "workspace with spaces");
    const unicodeWorkspacePath = path.join(tmp, "workspace unicode 한글");
    const centralPath = path.join(tmp, "central repo with spaces");
    const workspaceCodexRoot = path.join(workspacePath, ".codex");
    const unicodeCodexRoot = path.join(unicodeWorkspacePath, ".codex");
    const centralCodexRoot = path.join(centralPath, "codex");
    const skillName = "sample-skill";
    const unicodeSkillName = "unicode-skill-한글";
    const workspaceSkillRoot = await writeFixtureSkill(workspaceCodexRoot, skillName);
    const unicodeSkillRoot = await writeFixtureSkill(unicodeCodexRoot, unicodeSkillName);
    await writeFixtureSkill(centralCodexRoot, "central-skill");

    const vscodeFiles = normalizeList(await collectVsCodeFiles(workspaceCodexRoot, workspaceCodexRoot));
    const unicodeVscodeFiles = normalizeList(await collectVsCodeFiles(unicodeCodexRoot, unicodeCodexRoot));
    const coreFiles = normalizeList(await collectCoreFiles(workspaceCodexRoot));
    const unicodeCoreFiles = normalizeList(await collectCoreFiles(unicodeCodexRoot));
    const scopeEntries = await collectScopeEntries(workspaceCodexRoot, `skills/${skillName}`, "folder");
    const unicodeScopeEntries = await collectScopeEntries(unicodeCodexRoot, `skills/${unicodeSkillName}`, "folder");
    const resolvedWorkspaceSkillMd = resolveSkillPath(workspacePath, "codex", `skills/${skillName}/SKILL.md`, "workspace");
    const resolvedUnicodeSkillMd = resolveSkillPath(unicodeWorkspacePath, "codex", `skills/${unicodeSkillName}/SKILL.md`, "workspace");
    assertRejectsPathTraversal("vscode resolveSkillPath", () => {
      resolveSkillPath(workspacePath, "codex", `skills/${skillName}/../escape.md`, "workspace");
    });
    assertRejectsPathTraversal("vscode resolveSkillPath absolute", () => {
      resolveSkillPath(workspacePath, "codex", path.join(path.sep, "skills", skillName, "SKILL.md"), "workspace");
    });
    assertRejectsPathTraversal("core resolveSkillPath", () => {
      resolveCoreSkillPath(workspacePath, "codex", `skills/${skillName}/../escape.md`, "workspace");
    });
    assertRejectsPathTraversal("core resolveSkillPath absolute", () => {
      resolveCoreSkillPath(workspacePath, "codex", path.join(path.sep, "skills", skillName, "SKILL.md"), "workspace");
    });
    const copiedSkillRoot = path.join(tmp, "copied skill");
    const copiedUnicodeSkillRoot = path.join(tmp, "copied unicode skill 한글");
    const outsideRoot = path.join(tmp, "outside root");
    await fs.mkdir(outsideRoot, { recursive: true });
    await fs.writeFile(path.join(outsideRoot, "outside-secret.txt"), "outside", "utf8");
    const escapeLinkCreated = await tryCreateSymlink(
      outsideRoot,
      path.join(workspaceCodexRoot, "skills", skillName, "escape-outside"),
      "dir"
    );
    await copyDirectory(workspaceSkillRoot, copiedSkillRoot);
    await copyDirectory(unicodeSkillRoot, copiedUnicodeSkillRoot);
    const copiedFiles = normalizeList(await collectCoreFiles(copiedSkillRoot));
    const copiedUnicodeFiles = normalizeList(await collectCoreFiles(copiedUnicodeSkillRoot));

    assertIncludes(vscodeFiles, `skills/${skillName}/SKILL.md`, "vscode collectFiles");
    assertIncludes(vscodeFiles, `skills/${skillName}/nested/deeper folder/data.json`, "vscode collectFiles");
    assertIncludes(unicodeVscodeFiles, `skills/${unicodeSkillName}/SKILL.md`, "unicode vscode collectFiles");
    assertIncludes(coreFiles, `skills/${skillName}/nested/notes.txt`, "core collectFiles");
    assertIncludes(unicodeCoreFiles, `skills/${unicodeSkillName}/nested/notes.txt`, "unicode core collectFiles");
    assertIncludes(copiedFiles, "SKILL.md", "copyDirectory");
    assertIncludes(copiedFiles, "nested/deeper folder/data.json", "copyDirectory");
    assertIncludes(copiedUnicodeFiles, "nested/deeper folder/data.json", "unicode copyDirectory");

    if (scopeEntries.size !== 6) {
      throw new Error(`collectScopeEntries expected 6 entries, got ${scopeEntries.size}`);
    }
    if (unicodeScopeEntries.size !== 6) {
      throw new Error(`unicode collectScopeEntries expected 6 entries, got ${unicodeScopeEntries.size}`);
    }
    if (path.resolve(resolvedWorkspaceSkillMd) !== path.resolve(path.join(workspaceSkillRoot, "SKILL.md"))) {
      throw new Error(`resolveSkillPath returned an unexpected path: ${resolvedWorkspaceSkillMd}`);
    }
    if (path.resolve(resolvedUnicodeSkillMd) !== path.resolve(path.join(unicodeSkillRoot, "SKILL.md"))) {
      throw new Error(`resolveSkillPath returned an unexpected unicode path: ${resolvedUnicodeSkillMd}`);
    }
    if (escapeLinkCreated) {
      const filesAfterEscapeLink = normalizeList(await collectCoreFiles(workspaceCodexRoot));
      if (filesAfterEscapeLink.some((item) => item.includes("outside-secret.txt"))) {
        throw new Error("core collectFiles followed a symlink outside the workspace root.");
      }
      const vscodeFilesAfterEscapeLink = normalizeList(await collectVsCodeFiles(workspaceCodexRoot, workspaceCodexRoot));
      if (vscodeFilesAfterEscapeLink.some((item) => item.includes("outside-secret.txt"))) {
        throw new Error("vscode collectFiles followed a symlink outside the workspace root.");
      }
    } else if (requireSymlinkCheck) {
      throw new Error("Symlink escape check was required, but this environment could not create a directory symlink.");
    }

    await emitReport({
      ok: true,
      platform: process.platform,
      node: process.version,
      requireSymlinkCheck,
      tmp,
      vscodeFileCount: vscodeFiles.length,
      unicodeVscodeFileCount: unicodeVscodeFiles.length,
      coreFileCount: coreFiles.length,
      unicodeCoreFileCount: unicodeCoreFiles.length,
      scopeEntryCount: scopeEntries.size,
      unicodeScopeEntryCount: unicodeScopeEntries.size,
      copiedFileCount: copiedFiles.length,
      copiedUnicodeFileCount: copiedUnicodeFiles.length,
      symlinkEscapeChecked: escapeLinkCreated,
      vscodeSymlinkEscapeChecked: escapeLinkCreated,
      pathTraversalRejected: true
    });
  } catch (error) {
    shouldClean = false;
    const message = error instanceof Error ? error.message : String(error);
    await emitReport({
      ok: false,
      platform: process.platform,
      node: process.version,
      requireSymlinkCheck,
      tmp,
      message
    });
    process.exitCode = 1;
  } finally {
    if (shouldClean) {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }
}

run();
