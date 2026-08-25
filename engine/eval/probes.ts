import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import type { Probe } from "./eval-contract.ts";
import { PYTHON_BIN } from "../extract-python.ts";

export interface ProbeFailure {
  index: number;
  reason: string;
}

export interface ProbeOutcome {
  passed: boolean;
  failures: ProbeFailure[];
}

export interface ProbeRunInput {
  lang: "typescript" | "python";
  entryFilename: string;
  source: string;
  entrySymbol: string;
  probes: Probe[];
  timeoutMs?: number;
  env?: Record<string, string>;
  files?: Record<string, string>;
}

interface ProbeResultOk {
  pass: true;
}

interface ProbeResultFail {
  pass: false;
  reason: string;
}

type ProbeResult = ProbeResultOk | ProbeResultFail;

interface SentinelResults {
  results: ProbeResult[];
}

interface SentinelLoadError {
  loadError: string;
}

type Sentinel = SentinelResults | SentinelLoadError;

const SENTINEL_PREFIX = "LIUBAI_PROBE_RESULT:";
const DEFAULT_TIMEOUT_MS = 10_000;

const TS_RUNNER_PATH = join(import.meta.dirname, "scripts", "probe-runner.ts");
const PY_RUNNER_PATH = join(import.meta.dirname, "scripts", "probe_runner.py");

function buildChildEnv(overrides: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key === "NODE_TEST_CONTEXT") continue;
    env[key] = value;
  }
  return { ...env, ...overrides };
}

type SpawnResult = SpawnSyncReturns<string>;

function spawnRunner(lang: ProbeRunInput["lang"], payload: string, timeoutMs: number, env: Record<string, string>): SpawnResult {
  const opts = { input: payload, encoding: "utf8" as const, timeout: timeoutMs, killSignal: "SIGKILL" as const, env };
  if (lang === "typescript") {
    return spawnSync(process.execPath, ["--experimental-strip-types", TS_RUNNER_PATH], opts);
  }
  return spawnSync(PYTHON_BIN, [PY_RUNNER_PATH], opts);
}

function didTimeOut(res: SpawnResult): boolean {
  const errorCode = (res.error as NodeJS.ErrnoException | undefined)?.code;
  return res.signal === "SIGKILL" || errorCode === "ETIMEDOUT";
}

function stderrTail(stderr: string): string | undefined {
  const lines = stderr.split("\n").filter((line) => line.length > 0);
  return lines[lines.length - 1];
}

function findSentinelLine(stdout: string): string | undefined {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line !== undefined && line.startsWith(SENTINEL_PREFIX)) return line;
  }
  return undefined;
}

function parseSentinel(line: string): Sentinel | undefined {
  try {
    return JSON.parse(line.slice(SENTINEL_PREFIX.length)) as Sentinel;
  } catch {
    return undefined;
  }
}

function outcomeFromSentinel(sentinel: Sentinel): ProbeOutcome {
  if ("loadError" in sentinel) {
    return { passed: false, failures: [{ index: 0, reason: sentinel.loadError }] };
  }
  const failures: ProbeFailure[] = [];
  sentinel.results.forEach((result, index) => {
    if (!result.pass) failures.push({ index, reason: result.reason });
  });
  return { passed: failures.length === 0, failures };
}

function outcomeFromUnparseableExit(res: SpawnResult): ProbeOutcome {
  const tail = stderrTail(res.stderr ?? "");
  const suffix = tail !== undefined ? `: ${tail}` : "";
  const reason = `probe runner exited with code ${res.status ?? "null"}${suffix}`;
  return { passed: false, failures: [{ index: 0, reason }] };
}

function assertSandboxKey(key: string): void {
  if (isAbsolute(key) || key.split("/").includes("..")) {
    throw new Error(`probe sandbox: unsafe file path: ${key}`);
  }
}

function materializeFiles(workDir: string, files: Record<string, string>): void {
  for (const [key, content] of Object.entries(files)) {
    assertSandboxKey(key);
    const filePath = join(workDir, key);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
}

export function runProbesInDir(workDir: string, input: ProbeRunInput): ProbeOutcome {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (input.files !== undefined) materializeFiles(workDir, input.files);

  const sourcePath = join(workDir, input.entryFilename);
  writeFileSync(sourcePath, input.source);

  const payload = JSON.stringify({ sourcePath, entrySymbol: input.entrySymbol, probes: input.probes });
  const env = buildChildEnv(input.env);
  const res = spawnRunner(input.lang, payload, timeoutMs, env);

  if (didTimeOut(res)) {
    return { passed: false, failures: [{ index: 0, reason: `probe run timed out after ${timeoutMs}ms` }] };
  }

  if (res.error !== undefined) {
    throw new Error(res.error.message);
  }

  const sentinelLine = findSentinelLine(res.stdout ?? "");
  const sentinel = sentinelLine !== undefined ? parseSentinel(sentinelLine) : undefined;

  return sentinel !== undefined ? outcomeFromSentinel(sentinel) : outcomeFromUnparseableExit(res);
}

export function runProbes(input: ProbeRunInput): ProbeOutcome {
  const workDir = mkdtempSync(join(tmpdir(), "liubai-probe-"));
  try {
    return runProbesInDir(workDir, input);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
