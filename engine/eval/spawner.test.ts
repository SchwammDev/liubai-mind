import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSpawnEnv, defaultPiSpawner } from "./spawner.ts";
import type { RunSpec } from "./spawner.ts";

function stubRepoRoot(piScript: string): string {
  const root = mkdtempSync(join(tmpdir(), "eval-stub-pi-"));
  const binDir = join(root, "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  const piPath = join(binDir, "pi");
  writeFileSync(piPath, `#!/usr/bin/env bash\n${piScript}\n`);
  chmodSync(piPath, 0o755);
  return root;
}

function spec(over: Partial<RunSpec> = {}): RunSpec {
  return {
    cwd: mkdtempSync(join(tmpdir(), "eval-spawn-cwd-")),
    env: {},
    model: "prov/model",
    task: "improve",
    timeoutMs: 5000,
    ...over,
  };
}

test("buildSpawnEnv_strips_experiment_toggles_inherited_from_the_parent_shell", () => {
  const parent = { PATH: "/bin", LIUBAI_RAILS_OFF: "1", LIUBAI_PHRASING_PACK: "/tmp/pack.json" };

  const env = buildSpawnEnv(parent, {});

  assert.deepEqual(env, { PATH: "/bin" });
});

test("buildSpawnEnv_applies_condition_env_over_the_sanitized_base", () => {
  const parent = { PATH: "/bin", LIUBAI_RAILS_OFF: "1" };

  const env = buildSpawnEnv(parent, { LIUBAI_RAILS_OFF: "1", LIUBAI_PHRASING_PACK: "/packs/coaching.json" });

  assert.deepEqual(env, { PATH: "/bin", LIUBAI_RAILS_OFF: "1", LIUBAI_PHRASING_PACK: "/packs/coaching.json" });
});

test("buildSpawnEnv_drops_undefined_parent_entries", () => {
  const parent = { PATH: "/bin", HOME: undefined };

  const env = buildSpawnEnv(parent, {});

  assert.deepEqual(env, { PATH: "/bin" });
});

test("defaultPiSpawner_captures_stdout_and_exit_code_from_the_pi_process", async () => {
  const repoRoot = stubRepoRoot('echo "{\\"event\\":\\"done\\"}"; exit 3');

  const outcome = await defaultPiSpawner(repoRoot)(spec());

  assert.equal(outcome.exitCode, 3);
  assert.equal(outcome.stdoutJsonl.trim(), '{"event":"done"}');
  assert.equal(outcome.timedOut, false);
});

test("defaultPiSpawner_receives_model_task_and_rails_extension_as_arguments", async () => {
  const repoRoot = stubRepoRoot('echo "$@"');

  const outcome = await defaultPiSpawner(repoRoot)(spec({ model: "aqueduct/m1", task: "fix it" }));

  assert.match(outcome.stdoutJsonl, /--no-extensions -e .*extensions\/rails --model aqueduct\/m1 --mode json -p fix it/);
});

test("defaultPiSpawner_kills_a_hung_process_and_reports_timeout", async () => {
  const repoRoot = stubRepoRoot("sleep 60");

  const outcome = await defaultPiSpawner(repoRoot)(spec({ timeoutMs: 200 }));

  assert.equal(outcome.timedOut, true);
  assert.notEqual(outcome.exitCode, 0);
});
