import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { INSTRUCTION_ROOT, TOOL_PATHS } from "./constants";
import { existsPath, listGitRemotes as listGitRemotesShared } from "./shared";
import type {
  CentralRepoStatus,
  GitDiagnostics,
  GitRemoteTestResult,
  SyncCentralRepoRequest,
  SyncCentralRepoResult,
  ToolType
} from "./types";

const execFileAsync = promisify(execFile);

export async function checkCentralRepo(centralRepoPath: string): Promise<CentralRepoStatus> {
  const exists = await existsPath(centralRepoPath);
  if (!exists) return { exists: false, isGitRepo: false };
  return { exists: true, isGitRepo: await existsPath(path.join(centralRepoPath, ".git")) };
}

export async function initializeCentralRepo(centralRepoPath: string): Promise<void> {
  await fs.mkdir(centralRepoPath, { recursive: true });
  if (!(await existsPath(path.join(centralRepoPath, ".git")))) {
    await runGit(centralRepoPath, ["init"]);
  }

  for (const tool of Object.keys(TOOL_PATHS) as ToolType[]) {
    await fs.mkdir(path.join(centralRepoPath, TOOL_PATHS[tool].central), { recursive: true });
  }
  await fs.mkdir(path.join(centralRepoPath, INSTRUCTION_ROOT), { recursive: true });
}

export async function syncCentralRepo(req: SyncCentralRepoRequest): Promise<SyncCentralRepoResult> {
  await ensureGitRepo(req.centralRepoPath);

  const changedFiles = await listGitChangedFiles(req.centralRepoPath);
  if (changedFiles.length === 0) {
    return { changedFiles: [], pushed: false, message: "동기화할 변경사항이 없습니다." };
  }

  if (!req.commitMessage.trim()) {
    throw new Error("동기화 commit message를 입력해주세요.");
  }

  await runGit(req.centralRepoPath, ["add", "-A"]);
  await runGit(req.centralRepoPath, ["commit", "-m", req.commitMessage]);
  const commitHash = (await runGit(req.centralRepoPath, ["rev-parse", "HEAD"])).trim();

  if (req.push === false) {
    return { changedFiles, commitHash, pushed: false, message: "로컬 commit만 완료했습니다." };
  }

  const branch = (await runGit(req.centralRepoPath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (!branch || branch === "HEAD") {
    throw new Error("현재 브랜치를 확인할 수 없습니다. 브랜치를 만든 뒤 다시 시도해주세요.");
  }

  try {
    await runGit(req.centralRepoPath, ["push"]);
  } catch (error) {
    const message = String(error).toLowerCase();
    if (message.includes("tracking information") || message.includes("no upstream")) {
      const remotes = (await runGit(req.centralRepoPath, ["remote"])).split(/\r?\n/).filter(Boolean);
      if (!remotes.includes("origin")) {
        throw new Error("origin 원격 저장소가 없습니다. origin 설정 후 다시 시도해주세요.");
      }
      await runGit(req.centralRepoPath, ["push", "-u", "origin", branch]);
    } else {
      throw error;
    }
  }

  return { changedFiles, commitHash, pushed: true, message: "동기화(commit + push) 완료" };
}

export async function getGitDiagnostics(centralRepoPath: string): Promise<GitDiagnostics> {
  const status = await checkCentralRepo(centralRepoPath);
  if (!status.isGitRepo) {
    return {
      isGitRepo: false,
      branch: "",
      upstream: null,
      changedFiles: [],
      remotes: [],
      originUrl: null
    };
  }

  const branch = (await runGit(centralRepoPath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  const upstream = (await runGitAllowFail(centralRepoPath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])).trim() || null;
  const changedFiles = await listGitChangedFiles(centralRepoPath);
  const remotes = await listGitRemotesShared(centralRepoPath, runGit);
  const origin = remotes.find((item) => item.name === "origin");

  return {
    isGitRepo: true,
    branch,
    upstream,
    changedFiles,
    remotes,
    originUrl: origin?.fetchUrl ?? null
  };
}

export async function testGitRemote(centralRepoPath: string, remote = "origin"): Promise<GitRemoteTestResult> {
  await ensureGitRepo(centralRepoPath);
  const remotes = await listGitRemotesShared(centralRepoPath, runGit);
  const target = remotes.find((item) => item.name === remote);
  if (!target) {
    return { ok: false, remote, url: null, message: `${remote} 원격 저장소가 없습니다.` };
  }

  try {
    await runGit(centralRepoPath, ["ls-remote", "--heads", remote]);
    return { ok: true, remote, url: target.fetchUrl, message: `${remote} 연결 확인 성공` };
  } catch (error) {
    return { ok: false, remote, url: target.fetchUrl, message: `연결 실패: ${String(error)}` };
  }
}

async function listGitChangedFiles(repoPath: string): Promise<string[]> {
  const out = await runGit(repoPath, ["status", "--porcelain"]);
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(3));
}

async function ensureGitRepo(repoPath: string): Promise<void> {
  if (!(await existsPath(path.join(repoPath, ".git")))) {
    throw new Error(`Git 저장소가 아닙니다: ${repoPath}`);
  }
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync("git", args, { cwd });
  if (stderr && stderr.toLowerCase().includes("fatal")) {
    throw new Error(stderr.trim());
  }
  return stdout;
}

async function runGitAllowFail(cwd: string, args: string[]): Promise<string> {
  try {
    return await runGit(cwd, args);
  } catch {
    return "";
  }
}
