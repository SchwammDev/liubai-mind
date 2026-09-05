import { spawnSync } from "node:child_process";

import type { Provenance } from "./eval-contract.ts";
import { packHash } from "../contract.ts";

function runGit(repoRoot: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return res.stdout.trim();
}

const RUN_OUTPUTS_PATHSPEC = ":(exclude)engine/eval/runs";

function isDirtyOutsideRunOutputs(repoRoot: string): boolean {
  return runGit(repoRoot, ["status", "--porcelain", "--", RUN_OUTPUTS_PATHSPEC]).length > 0;
}

export function gitSha(repoRoot: string): string {
  const sha = runGit(repoRoot, ["rev-parse", "--short", "HEAD"]);
  return isDirtyOutsideRunOutputs(repoRoot) ? `${sha}-dirty` : sha;
}

export type FileAtCommit = { content: string } | { unavailable: true };

function isDirtySha(sha: string): boolean {
  return sha.endsWith("-dirty");
}

export function showFileAtCommit(repoRoot: string, sha: string, relativePath: string): FileAtCommit {
  if (isDirtySha(sha)) return { unavailable: true };

  const res = spawnSync("git", ["show", `${sha}:${relativePath}`], { cwd: repoRoot, encoding: "utf8" });
  if (res.status !== 0) return { unavailable: true };

  return { content: res.stdout };
}

export function buildProvenance(input: {
  treatmentId: string;
  packBytes: string | null;
  repoRoot: string;
  model: string;
  now: string;
  reasoning: string;
}): Provenance {
  return {
    treatmentId: input.treatmentId,
    phrasingPackHash: packHash(input.packBytes),
    liubaiSha: gitSha(input.repoRoot),
    model: input.model,
    collectedAt: input.now,
    reasoning: input.reasoning,
  };
}
