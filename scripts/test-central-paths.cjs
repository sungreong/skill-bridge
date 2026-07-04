const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

async function main() {
  const workspacePath = process.cwd();
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-bridge-central-paths-"));
  const bundlePath = path.join(bundleDir, "centralPath.cjs");

  try {
    await esbuild.build({
      entryPoints: [path.join(workspacePath, "apps", "vscode", "src", "centralPath.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node18",
      outfile: bundlePath,
      logLevel: "silent"
    });

    const centralPath = require(bundlePath);

    const defaultResult = centralPath.resolveCentralRepoPath(
      centralPath.DEFAULT_CENTRAL_REPO_PATH_SETTING,
      workspacePath,
      "default"
    );
    assert.equal(defaultResult.ok, true, "default central path should resolve");
    assert.ok(
      defaultResult.absolutePath.endsWith(path.join("skill-bridge-repo")),
      `default path should end with skill-bridge-repo, got ${defaultResult.absolutePath}`
    );

    const contaminated = centralPath.resolveCentralRepoPath(
      "e-server/bin/server-id/13/c:/Users/leesu/skill-bridge-repo",
      workspacePath,
      "configured"
    );
    assert.equal(contaminated.ok, false, "contaminated path should fail");
    assert.equal(contaminated.issue, "contaminatedAbsolutePrefix");

    const remoteUri = centralPath.resolveCentralRepoPath(
      "vscode-remote://ssh-remote+box/home/user/skill-bridge-repo",
      workspacePath,
      "configured"
    );
    assert.equal(remoteUri.ok, false, "remote URI should fail");
    assert.equal(remoteUri.issue, "nonFileUri");

    if (process.platform === "win32") {
      const fileUri = centralPath.resolveCentralRepoPath(
        "file:///C:/Users/test/skill-bridge-repo",
        workspacePath,
        "configured"
      );
      assert.equal(fileUri.ok, true, "Windows file URI should resolve on Windows");

      const hostMismatch = centralPath.resolveCentralRepoPath(
        "/home/test/skill-bridge-repo",
        workspacePath,
        "configured"
      );
      assert.equal(hostMismatch.ok, false, "POSIX home path should fail on Windows");
      assert.equal(hostMismatch.issue, "hostMismatch");

      const guardMismatch = centralPath.resolveHostPath("/home/test/skill-bridge-repo");
      assert.equal(guardMismatch.ok, false, "generic path guard should reject POSIX home path on Windows");
      assert.equal(guardMismatch.issue, "hostMismatch");
    } else {
      const fileUri = centralPath.resolveCentralRepoPath(
        "file:///tmp/skill-bridge-repo",
        workspacePath,
        "configured"
      );
      assert.equal(fileUri.ok, true, "POSIX file URI should resolve on POSIX hosts");

      const windowsPath = centralPath.resolveCentralRepoPath(
        "C:/Users/test/skill-bridge-repo",
        workspacePath,
        "configured"
      );
      assert.equal(windowsPath.ok, false, "Windows path should fail on POSIX hosts");
      assert.equal(windowsPath.issue, "hostMismatch");

      const wrappedWindowsFileUri = centralPath.resolveCentralRepoPath(
        "file:///C:/Users/test/skill-bridge-repo",
        workspacePath,
        "configured"
      );
      assert.equal(wrappedWindowsFileUri.ok, false, "Windows file URI should fail on POSIX hosts");
      assert.equal(wrappedWindowsFileUri.issue, "hostMismatch");

      const guardContaminated = centralPath.resolveHostPath(
        path.join(os.tmpdir(), "skill-bridge-host", "c:/Users/leesu/skill-bridge-repo")
      );
      assert.equal(guardContaminated.ok, false, "generic path guard should reject contaminated absolute prefixes");
      assert.equal(guardContaminated.issue, "contaminatedAbsolutePrefix");
    }

    console.log("[central-paths] OK");
  } finally {
    await fs.rm(bundleDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("[central-paths] FAILED");
  console.error(error);
  process.exitCode = 1;
});
