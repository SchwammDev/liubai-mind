import type { AnalyzeReq, Env, Rule } from "./contract.ts";
import { analyze } from "./analyze.ts";
import { pythonExtractor } from "./extract-python.ts";
import { buildRules, DEFAULT_POLICY } from "./policy.ts";
import { detectLang } from "./lang.ts";

function backends(req: AnalyzeReq): { env: Env; rules: readonly Rule[] } {
  const lang = req.lang ?? detectLang(req.path);
  const env: Env = lang ? { extractors: { python: pythonExtractor } } : {};
  const rules = lang ? buildRules(DEFAULT_POLICY, lang) : [];
  return { env, rules };
}

function fail(msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const stdin = await readStdin();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdin);
  } catch {
    fail("malformed json on stdin");
  }

  if (!isAnalyzeReq(parsed)) {
    fail("payload is not an analyze request: need { path: string, after: string }");
  }

  const { env, rules } = backends(parsed);
  const resp = await analyze(parsed, env, rules);

  process.stdout.write(`${JSON.stringify(resp)}\n`);
  process.exit(0);
}

function isAnalyzeReq(value: unknown): value is AnalyzeReq {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const req = value as Record<string, unknown>;
  return typeof req["path"] === "string" && typeof req["after"] === "string";
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
  });
}

try {
  await main();
} catch (err) {
  fail(String(err));
}
