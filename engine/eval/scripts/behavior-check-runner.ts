import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const SENTINEL_PREFIX = "LIUBAI_BEHAVIOR_CHECK_RESULT:";

interface ReturnsCheck {
  args: unknown[];
  returns: unknown;
}

interface ThrowsCheck {
  args: unknown[];
  throws: string;
}

type BehaviorCheckSpec = ReturnsCheck | ThrowsCheck;

type CompareMode = "exact" | "subset";

interface BehaviorCheckRunnerInput {
  sourcePath: string;
  entrySymbol: string;
  behaviorChecks: BehaviorCheckSpec[];
  compare: CompareMode;
}

interface BehaviorCheckResultOk {
  pass: true;
}

interface BehaviorCheckResultFail {
  pass: false;
  reason: string;
}

type BehaviorCheckResult = BehaviorCheckResultOk | BehaviorCheckResultFail;

type EntryFn = (...args: unknown[]) => unknown;

function isThrowsCheck(behaviorCheck: BehaviorCheckSpec): behaviorCheck is ThrowsCheck {
  return "throws" in behaviorCheck;
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

function runReturnsCheck(fn: EntryFn, behaviorCheck: ReturnsCheck, number: number, compare: CompareMode): BehaviorCheckResult {
  let actual: unknown;
  try {
    actual = fn(...behaviorCheck.args);
  } catch (err) {
    return { pass: false, reason: `behaviorCheck ${number}: expected ${safeStringify(behaviorCheck.returns)}, got throw "${errorMessage(err)}"` };
  }
  if (valuesMatch(actual, behaviorCheck.returns, compare)) return { pass: true };
  return { pass: false, reason: `behaviorCheck ${number}: expected ${safeStringify(behaviorCheck.returns)}, got ${safeStringify(actual)}` };
}

function runThrowsCheck(fn: EntryFn, behaviorCheck: ThrowsCheck, number: number): BehaviorCheckResult {
  let actual: unknown;
  try {
    actual = fn(...behaviorCheck.args);
  } catch (err) {
    const message = errorMessage(err);
    if (message === behaviorCheck.throws) return { pass: true };
    return { pass: false, reason: `behaviorCheck ${number}: expected throw "${behaviorCheck.throws}", got throw "${message}"` };
  }
  return { pass: false, reason: `behaviorCheck ${number}: expected throw "${behaviorCheck.throws}", got return ${safeStringify(actual)}` };
}

function runCheck(fn: EntryFn, behaviorCheck: BehaviorCheckSpec, number: number, compare: CompareMode): BehaviorCheckResult {
  return isThrowsCheck(behaviorCheck) ? runThrowsCheck(fn, behaviorCheck, number) : runReturnsCheck(fn, behaviorCheck, number, compare);
}

function printSentinel(payload: unknown): void {
  process.stdout.write(`${SENTINEL_PREFIX}${JSON.stringify(payload)}\n`);
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const input = JSON.parse(raw) as BehaviorCheckRunnerInput;

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
  const results = input.behaviorChecks.map((behaviorCheck, i) => runCheck(entryFn, behaviorCheck, i + 1, input.compare));
  printSentinel({ results });
}

main().catch((err: unknown) => {
  process.stderr.write(`${errorMessage(err)}\n`);
  process.exitCode = 1;
});
