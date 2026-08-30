import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const SENTINEL_PREFIX = "LIUBAI_PROBE_RESULT:";

interface ReturnsProbe {
  args: unknown[];
  returns: unknown;
}

interface ThrowsProbe {
  args: unknown[];
  throws: string;
}

type ProbeSpec = ReturnsProbe | ThrowsProbe;

type CompareMode = "exact" | "subset";

interface ProbeRunnerInput {
  sourcePath: string;
  entrySymbol: string;
  probes: ProbeSpec[];
  compare: CompareMode;
}

interface ProbeResultOk {
  pass: true;
}

interface ProbeResultFail {
  pass: false;
  reason: string;
}

type ProbeResult = ProbeResultOk | ProbeResultFail;

type EntryFn = (...args: unknown[]) => unknown;

function isThrowsProbe(probe: ProbeSpec): probe is ThrowsProbe {
  return "throws" in probe;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSubsetMatch(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((expectedItem, i) => isSubsetMatch(actual[i], expectedItem));
  }
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return false;
    return Object.keys(expected).every((key) => isSubsetMatch(actual[key], expected[key]));
  }
  return isDeepStrictEqual(actual, expected);
}

function valuesMatch(actual: unknown, expected: unknown, compare: CompareMode): boolean {
  return compare === "subset" ? isSubsetMatch(actual, expected) : isDeepStrictEqual(actual, expected);
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function runReturnsProbe(fn: EntryFn, probe: ReturnsProbe, number: number, compare: CompareMode): ProbeResult {
  let actual: unknown;
  try {
    actual = fn(...probe.args);
  } catch (err) {
    return { pass: false, reason: `probe ${number}: expected ${safeStringify(probe.returns)}, got throw "${errorMessage(err)}"` };
  }
  if (valuesMatch(actual, probe.returns, compare)) return { pass: true };
  return { pass: false, reason: `probe ${number}: expected ${safeStringify(probe.returns)}, got ${safeStringify(actual)}` };
}

function runThrowsProbe(fn: EntryFn, probe: ThrowsProbe, number: number): ProbeResult {
  let actual: unknown;
  try {
    actual = fn(...probe.args);
  } catch (err) {
    const message = errorMessage(err);
    if (message === probe.throws) return { pass: true };
    return { pass: false, reason: `probe ${number}: expected throw "${probe.throws}", got throw "${message}"` };
  }
  return { pass: false, reason: `probe ${number}: expected throw "${probe.throws}", got return ${safeStringify(actual)}` };
}

function runProbe(fn: EntryFn, probe: ProbeSpec, number: number, compare: CompareMode): ProbeResult {
  return isThrowsProbe(probe) ? runThrowsProbe(fn, probe, number) : runReturnsProbe(fn, probe, number, compare);
}

function printSentinel(payload: unknown): void {
  process.stdout.write(`${SENTINEL_PREFIX}${JSON.stringify(payload)}\n`);
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const input = JSON.parse(raw) as ProbeRunnerInput;

  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(input.sourcePath).href)) as Record<string, unknown>;
  } catch (err) {
    printSentinel({ loadError: errorMessage(err) });
    return;
  }

  const fn = mod[input.entrySymbol];
  if (typeof fn !== "function") {
    printSentinel({ loadError: `entry symbol "${input.entrySymbol}" is not an exported function` });
    return;
  }

  const entryFn = fn as EntryFn;
  const results = input.probes.map((probe, i) => runProbe(entryFn, probe, i + 1, input.compare));
  printSentinel({ results });
}

main().catch((err: unknown) => {
  process.stderr.write(`${errorMessage(err)}\n`);
  process.exitCode = 1;
});
