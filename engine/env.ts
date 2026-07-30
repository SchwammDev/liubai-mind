import { spawnSync } from "node:child_process";

import { pythonExtractor } from "./extract-python.ts";
import type { Env, Lang } from "./contract.ts";

// Mirrors the old long_test_nudge.py helper inventory: `assert_*` / `_*`
// helpers in tests/, deduped, capped. Empty when there is no tests/ or grep is
// unavailable. The engine's test-body rule only calls this when a long test is
// flagged, so it never runs on a clean call.
export function helpersFor(lang: Lang): string[] {
  if (lang !== "python") return [];
  const res = spawnSync("grep", ["-rh", "-E", "^def (assert_|_)", "tests"], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (res.error || res.status !== 0) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const line of res.stdout.split("\n")) {
    const match = /^def (\w+)/.exec(line);
    if (!match || match[1] === undefined) continue;
    const name = match[1];
    if (name === "_" || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names.slice(0, 6);
}

export function defaultEnv(): Env {
  return { extractors: { python: pythonExtractor }, helpers: helpersFor };
}
