const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  buildGroupTargetsFromNames,
  collectSkillFolderSyncTargets,
  extractInstalledSkillFolderNames,
  inferNewSkillFolderNames
} = require("../apps/vscode/dist/installGrouping.js");

const DEFAULT_REPO = "vercel-labs/agent-skills";
const DEFAULT_SKILL = "web-design-guidelines";

function walkFiles(rootDir, currentDir = rootDir, out = []) {
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const nextPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(rootDir, nextPath, out);
      continue;
    }
    out.push(path.relative(rootDir, nextPath).replace(/\\/g, "/"));
  }
  return out;
}

function collectAgentSkillFiles(agentRoot, tool) {
  if (!fs.existsSync(agentRoot)) return [];
  return walkFiles(agentRoot).map((relativePath) => ({
    tool,
    relativePath
  }));
}

function run() {
  const repo = process.argv[2] || DEFAULT_REPO;
  const skill = process.argv[3] || DEFAULT_SKILL;
  const keepTemp = process.argv.includes("--keep");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-bridge-npx-test-"));
  const beforeFiles = [];
  let shouldClean = !keepTemp;

  try {
    const args = ["-y", "skills", "add", repo, "--skill", skill, "--yes"];
    const command = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "npx";
    const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", "npx", ...args] : args;
    const result = spawnSync(command, commandArgs, {
      cwd: tempDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: process.platform === "win32"
    });
    if (result.error) throw result.error;
    const combinedOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (result.status !== 0) {
      throw new Error(`npx skills add failed with exit code ${result.status}\n${combinedOutput}`.trim());
    }
    const afterFiles = collectAgentSkillFiles(path.join(tempDir, ".agents"), "agents");
    const installedNames = extractInstalledSkillFolderNames(combinedOutput);
    const inferredNames = inferNewSkillFolderNames(beforeFiles, afterFiles);
    const groupTargets = buildGroupTargetsFromNames(afterFiles, installedNames.length > 0 ? installedNames : inferredNames);
    const syncTargets = collectSkillFolderSyncTargets(groupTargets);
    const expectedTarget = `skills/${skill}`;
    const hasSkillMd = fs.existsSync(path.join(tempDir, ".agents", expectedTarget, "SKILL.md"));

    if (!hasSkillMd) {
      throw new Error(`Installed folder is missing SKILL.md: ${expectedTarget}`);
    }
    if (!installedNames.includes(skill) && !inferredNames.includes(skill)) {
      throw new Error(`Installed skill was not detected from output or diff: ${skill}`);
    }
    if (!groupTargets.some((target) => target.tool === "agents" && target.relativePath === expectedTarget)) {
      throw new Error(`Group target detection failed for ${expectedTarget}`);
    }
    if (!syncTargets.some((target) => target.tool === "agents" && target.skillFolderRel === expectedTarget)) {
      throw new Error(`Auto-sync target detection failed for ${expectedTarget}`);
    }

    console.log(JSON.stringify({
      ok: true,
      repo,
      skill,
      tempDir,
      installedNames,
      inferredNames,
      groupTargets,
      syncTargets
    }, null, 2));
  } catch (error) {
    shouldClean = false;
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({
      ok: false,
      repo,
      skill,
      tempDir,
      message
    }, null, 2));
    process.exitCode = 1;
  } finally {
    if (shouldClean) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

run();
