import { analyze } from "./analyze.ts";
import type { AnalyzeReq, Lang, RailError } from "./contract.ts";
import { packHash } from "./contract.ts";
import { defaultEnv } from "./env.ts";
import { CC_DELTA_NUDGE, CC_NUDGE } from "./messages.ts";
import { buildRules, DEFAULT_POLICY } from "./policy.ts";

export type FixtureLang = "python" | "typescript";

export interface ProbeFixture {
  lang: FixtureLang;
  path: string;
  after: string;
  functionName: string;
  cyclomaticComplexity: number;
}

const PYTHON_FIXTURE = `def classify(x: int) -> str:
    if x == 1:
        return "one"
    elif x == 2:
        return "two"
    elif x == 3:
        return "three"
    elif x == 4:
        return "four"
    elif x == 5:
        return "five"
    elif x == 6:
        return "six"
    elif x == 7:
        return "seven"
    elif x == 8:
        return "eight"
    elif x == 9:
        return "nine"
    elif x == 10:
        return "ten"
    else:
        return "unknown"
`;

const TYPESCRIPT_FIXTURE = `function classify(x: number): string {
  if (x === 1) {
    return "one";
  } else if (x === 2) {
    return "two";
  } else if (x === 3) {
    return "three";
  } else if (x === 4) {
    return "four";
  } else if (x === 5) {
    return "five";
  } else if (x === 6) {
    return "six";
  } else if (x === 7) {
    return "seven";
  } else if (x === 8) {
    return "eight";
  } else if (x === 9) {
    return "nine";
  } else if (x === 10) {
    return "ten";
  } else {
    return "unknown";
  }
}
`;

export const PROBE_FIXTURES: ProbeFixture[] = [
  { lang: "python", path: "probe/sample.py", after: PYTHON_FIXTURE, functionName: "classify", cyclomaticComplexity: 11 },
  { lang: "typescript", path: "probe/sample.ts", after: TYPESCRIPT_FIXTURE, functionName: "classify", cyclomaticComplexity: 11 },
];

export interface ProbeReport {
  packHash: string | null;
  nudges: Partial<Record<FixtureLang, string[]>>;
  errors: RailError[];
  ccNudge: Record<Lang, { first: string; rest: string }>;
  ccDeltaNudge: string;
}

function resolvedPackHash(): string | null {
  const raw = process.env.LIUBAI_PHRASING_PACK;
  return packHash(raw !== undefined && raw.length > 0 ? raw : null);
}

export async function runProbe(): Promise<ProbeReport> {
  const env = defaultEnv();
  const nudges: Partial<Record<FixtureLang, string[]>> = {};
  const errors: RailError[] = [];

  for (const fixture of PROBE_FIXTURES) {
    const req: AnalyzeReq = { path: fixture.path, after: fixture.after, lang: fixture.lang };
    const rules = buildRules(DEFAULT_POLICY, fixture.lang);
    const resp = await analyze(req, env, rules);
    nudges[fixture.lang] = resp.nudges.map((n) => n.msg);
    errors.push(...resp.errors);
  }

  return { packHash: resolvedPackHash(), nudges, errors, ccNudge: CC_NUDGE, ccDeltaNudge: CC_DELTA_NUDGE };
}

async function main(): Promise<void> {
  const report = await runProbe();
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (import.meta.main) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exit(1);
    });
}
