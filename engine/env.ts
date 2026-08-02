import { spawnSync } from "node:child_process";

import { pythonExtractor } from "./extract-python.ts";
import { typescriptExtractor } from "./extract-typescript.ts";
import type { Env, Lang } from "./contract.ts";

const HELPER_CAP = 6;

function pythonHelpers(): string[] {
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
  return names.slice(0, HELPER_CAP);
}

const TS_DECL_RE = /(?:function|const|let|var)\s+(assert\w+|expect\w+)/;

function collectNames(sources: string[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    for (const line of source.split("\n")) {
      const match = TS_DECL_RE.exec(line);
      if (match === null || match[1] === undefined) continue;
      const name = match[1];
      if (name === "assert" || name === "expect" || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
  }
  return names.slice(0, HELPER_CAP);
}

function typescriptHelpers(): string[] {
  const sources: string[] = [];
  const pattern = "(function|const|let|var)\\s+(assert\\w+|expect\\w+)";

  const named = spawnSync(
    "grep",
    [
      "-rhE", pattern,
      "--include=*.test.ts", "--include=*.spec.ts",
      "--include=*.test.tsx", "--include=*.spec.tsx",
      "--include=*.test.mts", "--include=*.spec.mts",
      "--include=*.test.cts", "--include=*.spec.cts",
      "--exclude-dir=node_modules",
      ".",
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  if (named.stdout !== undefined && named.stdout.length > 0) sources.push(named.stdout);

  for (const dir of ["tests", "__tests__"]) {
    const res = spawnSync(
      "grep",
      [
        "-rhE", pattern,
        "--include=*.ts", "--include=*.tsx",
        "--exclude-dir=node_modules",
        dir,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    if (res.stdout !== undefined && res.stdout.length > 0) sources.push(res.stdout);
  }

  return collectNames(sources);
}

export function helpersFor(lang: Lang): string[] {
  if (lang === "python") return pythonHelpers();
  if (lang === "typescript") return typescriptHelpers();
  return [];
}

export function defaultEnv(): Env {
  return {
    extractors: { python: pythonExtractor, typescript: typescriptExtractor },
    helpers: helpersFor,
  };
}
