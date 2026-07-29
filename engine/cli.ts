import type { AnalyzeReq, Env, Rule } from "./contract.ts";
import { analyze } from "./analyze.ts";

function backends(): { env: Env; rules: readonly Rule[] } {
  return { env: {}, rules: [] };
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

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail("payload is not a json object");
  }

  const { env, rules } = backends();
  const resp = await analyze(parsed as AnalyzeReq, env, rules);

  process.stdout.write(`${JSON.stringify(resp)}\n`);
  process.exit(0);
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
  });
}

await main();
