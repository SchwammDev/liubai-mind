import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface RunSpec {
  cwd: string;
  env: Record<string, string>;
  model: string;
  task: string;
  timeoutMs: number;
}

export interface RunOutcome {
  exitCode: number;
  stdoutJsonl: string;
  timedOut: boolean;
}

export type PiSpawner = (spec: RunSpec) => Promise<RunOutcome>;

const KILL_GRACE_MS = 5000;

const EXPERIMENT_TOGGLES = ["LIUBAI_RAILS_OFF", "LIUBAI_PHRASING_PACK", "LIUBAI_CC_DELTA_OFF", "LIUBAI_SHADOW_RULES"];

export function buildSpawnEnv(
  parent: Record<string, string | undefined>,
  overrides: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined || EXPERIMENT_TOGGLES.includes(key)) continue;
    env[key] = value;
  }
  return { ...env, ...overrides };
}

function piArgs(repoRoot: string, spec: RunSpec): string[] {
  const railsExtension = join(repoRoot, "extensions", "rails");
  return ["--no-extensions", "-e", railsExtension, "--model", spec.model, "--mode", "json", "-p", spec.task];
}

export function defaultPiSpawner(repoRoot: string): PiSpawner {
  return (spec) => runPi(repoRoot, spec);
}

export interface BwrapMountPlan {
  repoRoot: string;
  homeDir: string;
  workDir: string;
}

const REPO_EXPOSED_PATHS = ["node_modules", "extensions", "engine", "package.json", "tsconfig.json"];
const HOME_EXPOSED_PATHS = [join(".local", "share", "mise")];
const PI_AGENT_HIDDEN_ENTRIES = ["engine", "extensions", "sessions", "complexity.json", "liubai-dedup-log.jsonl"];

function roBindIfExists(args: string[], path: string): void {
  if (existsSync(path)) args.push("--ro-bind", path, path);
}

function tmpfsMaskIfExists(args: string[], path: string): void {
  if (existsSync(path)) args.push("--tmpfs", path);
}

function bindVisibleAgentConfig(args: string[], piAgentDir: string): void {
  args.push("--tmpfs", piAgentDir);
  for (const entry of readdirSync(piAgentDir)) {
    if (PI_AGENT_HIDDEN_ENTRIES.includes(entry)) continue;
    roBindIfExists(args, join(piAgentDir, entry));
  }
}

export function buildBwrapArgs({ repoRoot, homeDir, workDir }: BwrapMountPlan): string[] {
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--tmpfs", "/home"];

  for (const relative of HOME_EXPOSED_PATHS) roBindIfExists(args, join(homeDir, relative));
  for (const relative of REPO_EXPOSED_PATHS) roBindIfExists(args, join(repoRoot, relative));
  tmpfsMaskIfExists(args, join(repoRoot, "engine", "eval"));

  const piAgentDir = join(homeDir, ".pi", "agent");
  if (existsSync(piAgentDir)) bindVisibleAgentConfig(args, piAgentDir);

  args.push("--bind", workDir, workDir);
  args.push("--unshare-user", "--die-with-parent");

  return args;
}

function bwrapNotFoundError(): Error {
  return new Error("bwrap not found on PATH; refusing to run the eval agent unsandboxed");
}

function runPi(repoRoot: string, spec: RunSpec): Promise<RunOutcome> {
  const piBin = join(repoRoot, "node_modules", ".bin", "pi");
  const bwrapArgs = buildBwrapArgs({ repoRoot, homeDir: homedir(), workDir: spec.cwd });
  const args = [...bwrapArgs, "--", piBin, ...piArgs(repoRoot, spec)];

  return new Promise((resolve, reject) => {
    let settled = false;

    const child = spawn("bwrap", args, {
      cwd: spec.cwd,
      env: buildSpawnEnv(process.env, spec.env),
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      reject(err.code === "ENOENT" ? bwrapNotFoundError() : err);
    });

    child.stderr?.resume();

    let stdout = "";
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    }, spec.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolve({ exitCode: code ?? -1, stdoutJsonl: stdout, timedOut });
    });
  });
}
