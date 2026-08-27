import { spawn } from "node:child_process";
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

const EXPERIMENT_TOGGLES = ["LIUBAI_RAILS_OFF", "LIUBAI_PHRASING_PACK", "LIUBAI_DP_DELTA"];

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

function runPi(repoRoot: string, spec: RunSpec): Promise<RunOutcome> {
  const piBin = join(repoRoot, "node_modules", ".bin", "pi");

  return new Promise((resolve) => {
    const child = spawn(piBin, piArgs(repoRoot, spec), {
      cwd: spec.cwd,
      env: buildSpawnEnv(process.env, spec.env),
      stdio: ["ignore", "pipe", "pipe"],
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
      clearTimeout(timeoutTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolve({ exitCode: code ?? -1, stdoutJsonl: stdout, timedOut });
    });
  });
}
