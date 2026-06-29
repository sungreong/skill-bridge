import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsPath } from "./shared";
import type { SkillsCliRequest, SkillsCliResult } from "./types";

const execFileAsync = promisify(execFile);

export async function runSkillsCli(req: SkillsCliRequest): Promise<SkillsCliResult> {
  if (!(await existsPath(req.cwd))) {
    throw new Error(`작업 경로가 없습니다: ${req.cwd}`);
  }

  const args: string[] = [];
  if (req.yes !== false) args.push("-y");
  args.push("skills", req.action);

  if (req.action === "add") {
    if (!req.repo?.trim()) throw new Error("add 동작에는 repo가 필요합니다.");
    const rawRepo = req.repo.trim();
    const repoArg = rawRepo.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
    args.push(repoArg);
    const normalizedSkills = (req.skills ?? [])
      .map((skill) => skill.trim().replace(/^['"]+|['"]+$/g, "").trim())
      .filter(Boolean);
    const targetSkills = normalizedSkills.length > 0 ? normalizedSkills : ["*"];
    for (const skill of targetSkills) {
      const trimmed = skill.trim();
      if (!trimmed) continue;
      args.push("--skill", trimmed);
    }
    if (req.yes !== false) args.push("--yes");
  }

  if (req.action === "find" && req.query?.trim()) {
    args.push(req.query.trim());
  }

  const command = formatCommandForDisplay("npx", args);
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?][0-9;]*[A-Za-z]|\x1b\[[0-9;]*m|\r/g, "").trim();
  const execOpts = {
    cwd: req.cwd,
    timeout: 180000,
    windowsHide: process.platform === "win32",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" }
  };
  try {
    for (const cmd of getNpxExecFileCandidates()) {
      try {
        const { stdout, stderr } = await execFileAsync(cmd, args, execOpts);
        const mirrorNote = req.action === "add" ? await mirrorInstalledSkillsIfCentralLayout(req.cwd) : "";
        return { ok: true, command, stdout: stripAnsi(stdout), stderr: stripAnsi(joinMessages(stderr, mirrorNote)) };
      } catch (error: unknown) {
        const execError = error as { code?: number | string; stdout?: unknown; stderr?: unknown };
        if (execError.code === "ENOENT") continue;
        if (typeof execError.code === "number") {
          const mirrorNote = req.action === "add" ? await mirrorInstalledSkillsIfCentralLayout(req.cwd) : "";
          return {
            ok: false,
            command,
            stdout: stripAnsi(String(execError.stdout ?? "")),
            stderr: stripAnsi(joinMessages(String(execError.stderr ?? ""), mirrorNote))
          };
        }
        throw error;
      }
    }

    const spawned = await runSkillsCliWithSpawn(args, execOpts);
    if (spawned.code !== 0) {
      const mirrorNote = req.action === "add" ? await mirrorInstalledSkillsIfCentralLayout(req.cwd) : "";
      return {
        ok: false,
        command,
        stdout: stripAnsi(spawned.stdout),
        stderr: stripAnsi(joinMessages(spawned.stderr, mirrorNote))
      };
    }
    const mirrorNote = req.action === "add" ? await mirrorInstalledSkillsIfCentralLayout(req.cwd) : "";
    return { ok: true, command, stdout: stripAnsi(spawned.stdout), stderr: stripAnsi(joinMessages(spawned.stderr, mirrorNote)) };
  } catch (error: unknown) {
    const stdout = typeof error === "object" && error && "stdout" in error ? String((error as { stdout?: unknown }).stdout ?? "") : "";
    const stderrRaw = typeof error === "object" && error && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : "";
    const fallback = error instanceof Error ? error.message : String(error);
    const stderr = stderrRaw.trim() ? stderrRaw : fallback;
    return { ok: false, command, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr) };
  }
}

type SkillsCliExecOptions = {
  cwd: string;
  timeout: number;
  windowsHide: boolean;
  env: NodeJS.ProcessEnv;
};

async function runSkillsCliWithSpawn(args: string[], opts: SkillsCliExecOptions): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    return await spawnNpx(args, opts);
  } catch (error) {
    const spawnError = error as { code?: string };
    if (spawnError.code !== "ENOENT") throw error;
  }
  return {
    code: 1,
    stdout: "",
    stderr: "npx 실행 파일을 찾을 수 없습니다. Node.js/npm 설치와 PATH 설정을 확인해주세요."
  };
}

async function spawnNpx(args: string[], opts: SkillsCliExecOptions): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const command = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "npx";
    const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", "npx", ...args] : args;
    const child = spawn(command, commandArgs, {
      cwd: opts.cwd,
      timeout: opts.timeout,
      windowsHide: opts.windowsHide,
      env: opts.env,
      shell: false
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function mirrorInstalledSkillsIfCentralLayout(cwd: string): Promise<string> {
  const centralRoots = ["claude", "codex", "gemini", "cursor", "antigravity"];
  const centralReady = await Promise.all(centralRoots.map(async (name) => existsPath(path.join(cwd, name))));
  if (!centralReady.every(Boolean)) return "";
  await fs.mkdir(path.join(cwd, "agents"), { recursive: true });

  const mappings: Array<{ from: string; to: string }> = [
    { from: path.join(cwd, ".claude", "skills"), to: path.join(cwd, "claude", "skills") },
    { from: path.join(cwd, ".codex", "skills"), to: path.join(cwd, "codex", "skills") },
    { from: path.join(cwd, ".gemini", "skills"), to: path.join(cwd, "gemini", "skills") },
    { from: path.join(cwd, ".cursor", "skills"), to: path.join(cwd, "cursor", "skills") },
    { from: path.join(cwd, ".antigravity", "skills"), to: path.join(cwd, "antigravity", "skills") },
    { from: path.join(cwd, ".agents", "skills"), to: path.join(cwd, "agents", "skills") }
  ];

  let copiedCount = 0;
  for (const item of mappings) {
    if (!(await existsPath(item.from))) continue;
    await fs.mkdir(item.to, { recursive: true });
    const entries = await fs.readdir(item.from, { withFileTypes: true });
    for (const entry of entries) {
      const src = path.join(item.from, entry.name);
      const dest = path.join(item.to, entry.name);
      await fs.cp(src, dest, { recursive: true, force: true, dereference: true });
      copiedCount += 1;
    }
  }

  if (copiedCount === 0) return "";
  return `중앙 레이아웃 동기화: ${copiedCount}개 항목`;
}

function joinMessages(a: string, b: string): string {
  const first = a.trim();
  const second = b.trim();
  if (first && second) return `${first}\n${second}`;
  return first || second;
}

function getNpxExecFileCandidates(): string[] {
  return process.platform === "win32" ? [] : ["npx"];
}

function formatCommandForDisplay(command: string, args: string[]): string {
  return [command, ...args].map(quoteCommandArg).join(" ");
}

function quoteCommandArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}
