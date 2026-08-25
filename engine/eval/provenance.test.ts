import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { gitSha, buildProvenance } from "./provenance.ts";
import { packHash } from "./phrasing.ts";

function tempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "eval-provenance-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "file.txt"), "hello\n");
  spawnSync("git", ["add", "file.txt"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
  return dir;
}

test("gitSha_returns_the_short_sha_of_head", () => {
  const repo = tempGitRepo();
  const expected = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();

  const sha = gitSha(repo);

  assert.equal(sha, expected);
});

test("gitSha_marks_a_dirty_tree_with_a_dirty_suffix", () => {
  const repo = tempGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");

  const sha = gitSha(repo);

  assert.match(sha, /-dirty$/);
});

test("gitSha_does_not_mark_a_clean_tree_as_dirty", () => {
  const repo = tempGitRepo();

  const sha = gitSha(repo);

  assert.doesNotMatch(sha, /-dirty$/);
});

test("buildProvenance_stamps_a_null_pack_hash_when_no_pack_bytes_are_given", () => {
  const repo = tempGitRepo();

  const provenance = buildProvenance({
    conditionId: "control",
    packBytes: null,
    repoRoot: repo,
    model: "claude-test",
    now: "2026-08-24T00:00:00.000Z",
  });

  assert.equal(provenance.phrasingPackHash, null);
});

test("buildProvenance_stamps_a_sha256_pack_hash_when_pack_bytes_are_given", () => {
  const repo = tempGitRepo();
  const bytes = '{"CC_ADVICE":{"python":"a"}}';

  const provenance = buildProvenance({
    conditionId: "rails-default",
    packBytes: bytes,
    repoRoot: repo,
    model: "claude-test",
    now: "2026-08-24T00:00:00.000Z",
  });

  assert.equal(provenance.phrasingPackHash, packHash(bytes));
});

test("buildProvenance_passes_model_condition_and_timestamp_through_unchanged", () => {
  const repo = tempGitRepo();

  const provenance = buildProvenance({
    conditionId: "rails-default",
    packBytes: null,
    repoRoot: repo,
    model: "claude-test",
    now: "2026-08-24T00:00:00.000Z",
  });

  assert.equal(provenance.conditionId, "rails-default");
  assert.equal(provenance.model, "claude-test");
  assert.equal(provenance.collectedAt, "2026-08-24T00:00:00.000Z");
});
