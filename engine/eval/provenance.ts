import { spawnSync } from "node:child_process";

import type { Provenance } from "./eval-contract.ts";
import { packHash } from "./phrasing.ts";

function runGit(repoRoot: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return res.stdout.trim();
}

function isDirty(repoRoot: string): boolean {
  return runGit(repoRoot, ["status", "--porcelain"]).length > 0;
}

export function gitSha(repoRoot: string): string {
  const sha = runGit(repoRoot, ["rev-parse", "--short", "HEAD"]);
  return isDirty(repoRoot) ? `${sha}-dirty` : sha;
}

export function buildProvenance(input: {
  conditionId: string;
  packBytes: string | null;
  repoRoot: string;
  model: string;
  now: string;
  pyCcBackend?: string;
}): Provenance {
  return {
    conditionId: input.conditionId,
    phrasingPackHash: packHash(input.packBytes),
    liubaiSha: gitSha(input.repoRoot),
    model: input.model,
    collectedAt: input.now,
    ...(input.pyCcBackend !== undefined ? { pyCcBackend: input.pyCcBackend } : {}),
  };
}
