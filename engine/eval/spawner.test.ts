import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildBwrapArgs, buildSpawnEnv, defaultPiSpawner, defaultProbeSpawner } from "./spawner.ts";
import type { RunSpec } from "./spawner.ts";
import { evaluateCanary } from "./canary.ts";
import type { ConditionManifest } from "./eval-contract.ts";

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
  const parent = {
    PATH: "/bin",
    LIUBAI_RAILS_OFF: "1",
    LIUBAI_PHRASING_PACK: "/tmp/pack.json",
    LIUBAI_CC_DELTA_OFF: "1",
    LIUBAI_SHADOW_RULES: "cc-delta",
  };

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
  const repoRoot = stubRepoRoot("exec sleep 60");

  const outcome = await defaultPiSpawner(repoRoot)(spec({ timeoutMs: 200 }));

  assert.equal(outcome.timedOut, true);
  assert.notEqual(outcome.exitCode, 0);
});

test("defaultPiSpawner_rejects_clearly_when_bwrap_is_missing_from_path", async () => {
  const repoRoot = stubRepoRoot('echo "{\\"event\\":\\"done\\"}"');
  const pathWithoutBwrap = mkdtempSync(join(tmpdir(), "eval-empty-path-"));

  await assert.rejects(
    defaultPiSpawner(repoRoot)(spec({ env: { PATH: pathWithoutBwrap } })),
    /bwrap/i,
  );
});

function stubMountPlan(over: Partial<{ repoRoot: string; homeDir: string; workDir: string }> = {}) {
  return {
    repoRoot: mkdtempSync(join(tmpdir(), "bwrap-repo-")),
    homeDir: mkdtempSync(join(tmpdir(), "bwrap-home-")),
    workDir: mkdtempSync(join(tmpdir(), "bwrap-work-")),
    ...over,
  };
}

function withRepoFile(repoRoot: string, relativePath: string): void {
  const path = join(repoRoot, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "");
}

function withRepoDir(repoRoot: string, relativePath: string): void {
  mkdirSync(join(repoRoot, relativePath), { recursive: true });
}

function repoRootWithEvalCorpus(): string {
  const plan = stubMountPlan();
  withRepoDir(plan.repoRoot, "node_modules");
  withRepoDir(plan.repoRoot, "extensions");
  withRepoDir(plan.repoRoot, "engine/eval/corpus");
  withRepoFile(plan.repoRoot, "package.json");
  withRepoFile(plan.repoRoot, "tsconfig.json");
  return plan.repoRoot;
}

function piAgentHomeWithSessionState(): string {
  const homeDir = mkdtempSync(join(tmpdir(), "bwrap-home-"));
  const agentDir = join(homeDir, ".pi", "agent");
  mkdirSync(join(agentDir, "engine", "eval"), { recursive: true });
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  mkdirSync(join(agentDir, "sessions"), { recursive: true });
  writeFileSync(join(agentDir, "engine", "venv-marker.txt"), "venv\n");
  writeFileSync(join(agentDir, "complexity.json"), "{}");
  writeFileSync(join(agentDir, "liubai-dedup-log.jsonl"), "");
  writeFileSync(join(agentDir, "auth.json"), "{}");
  return homeDir;
}

function indexOfArg(args: string[], value: string): number {
  return args.indexOf(value);
}

const ROOT_ISOLATION_PREFIX = [
  "--ro-bind", "/", "/",
  "--dev", "/dev",
  "--proc", "/proc",
  "--tmpfs", "/tmp",
  "--tmpfs", "/home",
];

function assertOpensWithRootIsolation(args: string[]): void {
  assert.deepEqual(args.slice(0, ROOT_ISOLATION_PREFIX.length), ROOT_ISOLATION_PREFIX);
}

test("buildBwrapArgs_isolates_the_root_filesystem_and_scratch_directories", () => {
  const args = buildBwrapArgs(stubMountPlan());

  assertOpensWithRootIsolation(args);
});

test("buildBwrapArgs_shares_the_network_namespace_and_dies_with_the_parent", () => {
  const args = buildBwrapArgs(stubMountPlan());

  assert.equal(args.includes("--unshare-net"), false);
  assert.equal(args.includes("--unshare-user"), true);
  assert.equal(args.includes("--die-with-parent"), true);
});

test("buildBwrapArgs_exposes_the_repo_paths_pi_and_the_rails_extension_import_from", () => {
  const repoRoot = repoRootWithEvalCorpus();

  const args = buildBwrapArgs(stubMountPlan({ repoRoot }));

  for (const relative of ["node_modules", "extensions", "engine", "package.json", "tsconfig.json"]) {
    const path = join(repoRoot, relative);
    assert.equal(args.includes(path), true, `expected ${path} to be exposed`);
  }
});

test("buildBwrapArgs_masks_the_eval_harness_directory_after_exposing_engine", () => {
  const repoRoot = repoRootWithEvalCorpus();

  const args = buildBwrapArgs(stubMountPlan({ repoRoot }));

  const engineBindIndex = indexOfArg(args, join(repoRoot, "engine"));
  const evalMaskIndex = indexOfArg(args, join(repoRoot, "engine", "eval"));
  assert.ok(engineBindIndex >= 0 && evalMaskIndex >= 0);
  assert.ok(engineBindIndex < evalMaskIndex);
});

test("buildBwrapArgs_skips_exposing_repo_paths_that_do_not_exist_on_disk", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "bwrap-bare-repo-"));

  const args = buildBwrapArgs(stubMountPlan({ repoRoot }));

  assert.equal(args.includes(join(repoRoot, "node_modules")), false);
  assert.equal(args.includes(join(repoRoot, "engine", "eval")), false);
});

const PI_AGENT_SESSION_STATE = ["extensions", "sessions", "complexity.json", "liubai-dedup-log.jsonl"];

function assertAgentDirIsTmpfsWithSessionStateHidden(args: string[], agentDir: string): void {
  const tmpfsIndex = indexOfArg(args, agentDir);
  assert.equal(args[tmpfsIndex - 1], "--tmpfs");
  for (const hidden of PI_AGENT_SESSION_STATE) {
    assert.equal(args.includes(join(agentDir, hidden)), false, `expected ${hidden} to stay hidden`);
  }
}

test("buildBwrapArgs_replaces_the_agent_dir_with_a_writable_tmpfs_holding_only_config", () => {
  const homeDir = piAgentHomeWithSessionState();

  const args = buildBwrapArgs(stubMountPlan({ homeDir }));

  assertAgentDirIsTmpfsWithSessionStateHidden(args, join(homeDir, ".pi", "agent"));
});

test("buildBwrapArgs_binds_pi_agent_config_files_into_the_agent_tmpfs", () => {
  const homeDir = piAgentHomeWithSessionState();

  const args = buildBwrapArgs(stubMountPlan({ homeDir }));

  assert.equal(args.includes(join(homeDir, ".pi", "agent", "auth.json")), true);
});

function assertRoBound(args: string[], path: string): void {
  const index = indexOfArg(args, path);
  assert.ok(index > 0, `expected ${path} to be ro-bound`);
  assert.equal(args[index - 1], "--ro-bind");
}

function assertTmpfsMasked(args: string[], path: string): void {
  const index = indexOfArg(args, path);
  assert.ok(index > 0, `expected ${path} to be tmpfs-masked`);
  assert.equal(args[index - 1], "--tmpfs");
}

test("buildBwrapArgs_ro_binds_the_deployed_pi_agent_engine_so_its_venv_is_usable", () => {
  const homeDir = piAgentHomeWithSessionState();
  const agentDir = join(homeDir, ".pi", "agent");

  const args = buildBwrapArgs(stubMountPlan({ homeDir }));

  assertRoBound(args, join(agentDir, "engine"));
});

test("buildBwrapArgs_masks_the_deployed_pi_agent_eval_answer_key", () => {
  const homeDir = piAgentHomeWithSessionState();
  const agentDir = join(homeDir, ".pi", "agent");

  const args = buildBwrapArgs(stubMountPlan({ homeDir }));

  assertTmpfsMasked(args, join(agentDir, "engine", "eval"));
});

test("buildBwrapArgs_masks_the_deployed_pi_agent_eval_answer_key_after_binding_engine", () => {
  const homeDir = piAgentHomeWithSessionState();
  const agentDir = join(homeDir, ".pi", "agent");

  const args = buildBwrapArgs(stubMountPlan({ homeDir }));

  const engineBindIndex = indexOfArg(args, join(agentDir, "engine"));
  const evalMaskIndex = indexOfArg(args, join(agentDir, "engine", "eval"));
  assert.ok(engineBindIndex >= 0 && evalMaskIndex >= 0);
  assert.ok(engineBindIndex < evalMaskIndex);
});

function homeWithDotfilesManagedConfig(): { homeDir: string; agentDir: string } {
  const homeDir = mkdtempSync(join(tmpdir(), "bwrap-home-"));
  const agentDir = join(homeDir, ".pi", "agent");
  const dotfilesDir = join(homeDir, "code", "dotfiles");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(dotfilesDir, { recursive: true });
  writeFileSync(join(dotfilesDir, "models.json"), "{}");
  symlinkSync(join(dotfilesDir, "models.json"), join(agentDir, "models.json"));
  symlinkSync(join(dotfilesDir, "missing.json"), join(agentDir, "liubai.json"));
  return { homeDir, agentDir };
}

test("buildBwrapArgs_binds_a_symlinked_config_file_so_bwrap_resolves_its_target", () => {
  const { homeDir, agentDir } = homeWithDotfilesManagedConfig();

  const args = buildBwrapArgs(stubMountPlan({ homeDir }));

  assert.equal(args.includes(join(agentDir, "models.json")), true);
});

test("buildBwrapArgs_skips_a_dangling_config_symlink_instead_of_breaking_the_sandbox", () => {
  const { homeDir, agentDir } = homeWithDotfilesManagedConfig();

  const args = buildBwrapArgs(stubMountPlan({ homeDir }));

  assert.equal(args.includes(join(agentDir, "liubai.json")), false);
});

function homeWithMiseToolchain(): string {
  const homeDir = mkdtempSync(join(tmpdir(), "bwrap-home-"));
  mkdirSync(join(homeDir, ".local", "share", "mise"), { recursive: true });
  return homeDir;
}

test("buildBwrapArgs_exposes_the_mise_toolchain_the_pi_shebang_resolves_node_from", () => {
  const homeDir = homeWithMiseToolchain();

  const args = buildBwrapArgs(stubMountPlan({ homeDir }));

  const misePath = join(homeDir, ".local", "share", "mise");
  assert.ok(args.lastIndexOf(misePath) > indexOfArg(args, "/home"), `expected ${misePath} bound after the /home mask`);
});

function homeWithUvToolchain(): string {
  const homeDir = mkdtempSync(join(tmpdir(), "bwrap-home-"));
  mkdirSync(join(homeDir, ".local", "share", "uv"), { recursive: true });
  return homeDir;
}

function foreignHomeWithInstalledVenv(): { installedVenv: string; pythonInstall: string } {
  const foreignHome = mkdtempSync(join(tmpdir(), "bwrap-foreign-home-"));
  const pythonInstall = join(foreignHome, ".local", "share", "uv", "python", "cpython-3.12.9");
  mkdirSync(join(pythonInstall, "bin"), { recursive: true });
  writeFileSync(join(pythonInstall, "bin", "python3.12"), "");
  const installedVenv = join(foreignHome, ".pi", "agent", "engine", ".venv");
  mkdirSync(join(installedVenv, "bin"), { recursive: true });
  symlinkSync(join(pythonInstall, "bin", "python3.12"), join(installedVenv, "bin", "python"));
  return { installedVenv, pythonInstall };
}

function repoWithVenvSymlinkedInto(installedVenv: string): string {
  const plan = stubMountPlan();
  withRepoDir(plan.repoRoot, "engine");
  symlinkSync(installedVenv, join(plan.repoRoot, "engine", ".venv"));
  return plan.repoRoot;
}

test("buildBwrapArgs_exposes_a_venv_symlinked_into_another_users_home", () => {
  const { installedVenv, pythonInstall } = foreignHomeWithInstalledVenv();
  const repoRoot = repoWithVenvSymlinkedInto(installedVenv);

  const args = buildBwrapArgs(stubMountPlan({ repoRoot }));

  assert.equal(args.includes(installedVenv), true, "resolved venv target is not bound into the sandbox");
  assert.equal(args.includes(pythonInstall), true, "python installation the venv resolves to is not bound into the sandbox");
});

function foreignHomeWithVenvMissingPython(): string {
  const foreignHome = mkdtempSync(join(tmpdir(), "bwrap-foreign-home-"));
  const installedVenv = join(foreignHome, ".pi", "agent", "engine", ".venv");
  mkdirSync(join(installedVenv, "bin"), { recursive: true });
  symlinkSync(join(foreignHome, "no-such-interpreter"), join(installedVenv, "bin", "python"));
  return installedVenv;
}

test("buildBwrapArgs_skips_the_python_install_bind_when_the_venvs_python_symlink_is_dangling", () => {
  const installedVenv = foreignHomeWithVenvMissingPython();
  const repoRoot = repoWithVenvSymlinkedInto(installedVenv);

  const args = buildBwrapArgs(stubMountPlan({ repoRoot }));

  assert.equal(args.includes(installedVenv), true, "venv itself should still be exposed");
});

test("buildBwrapArgs_exposes_the_uv_toolchain_the_python_venv_resolves_from", () => {
  const homeDir = homeWithUvToolchain();

  const args = buildBwrapArgs(stubMountPlan({ homeDir }));

  const uvPath = join(homeDir, ".local", "share", "uv");
  assert.ok(args.lastIndexOf(uvPath) > indexOfArg(args, "/home"), `expected ${uvPath} bound after the /home mask`);
});

test("buildBwrapArgs_binds_the_workdir_read_write", () => {
  const plan = stubMountPlan();

  const args = buildBwrapArgs(plan);

  const bindIndex = indexOfArg(args, "--bind");
  assert.equal(args[bindIndex + 1], plan.workDir);
  assert.equal(args[bindIndex + 2], plan.workDir);
});

function bwrapProbeStatus(): number | null {
  const result = spawnSync("bwrap", ["--unshare-user", "--ro-bind", "/", "/", "--die-with-parent", "true"]);
  return result.error ? null : result.status;
}

function bwrapUnavailableReason(): string | undefined {
  if (spawnSync("bwrap", ["--version"]).error) return "bwrap is not installed";
  if (bwrapProbeStatus() !== 0) return "unprivileged user namespaces are unavailable";
  return undefined;
}

const bwrapSkipReason = bwrapUnavailableReason();

function sandboxedRun(args: string[], command: string) {
  return spawnSync("bwrap", [...args, "--", "bash", "-c", command]);
}

function assertCorpusUnreadable(args: string[], repoRoot: string): void {
  assert.notEqual(sandboxedRun(args, `cat ${join(repoRoot, "engine", "eval", "corpus")}`).status, 0);
}

function assertDeployedEngineEvalEmpty(args: string[], homeDir: string): void {
  const listing = sandboxedRun(args, `ls -A ${join(homeDir, ".pi", "agent", "engine", "eval")}`);
  assert.equal(listing.stdout.toString().trim(), "");
}

function assertDeployedEngineVenvReadable(args: string[], homeDir: string): void {
  const path = join(homeDir, ".pi", "agent", "engine", "venv-marker.txt");
  assert.equal(sandboxedRun(args, `cat ${path}`).status, 0);
}

function assertWorkdirWritable(args: string[], workDir: string): void {
  const path = join(workDir, "written.txt");
  assert.equal(sandboxedRun(args, `echo hi > ${path} && cat ${path}`).status, 0);
}

function assertAnalyzeTsReadable(args: string[], repoRoot: string): void {
  assert.equal(sandboxedRun(args, `cat ${join(repoRoot, "engine", "analyze.ts")}`).status, 0);
}

function sandboxedMountPlan() {
  const repoRoot = repoRootWithEvalCorpus();
  writeFileSync(join(repoRoot, "engine", "analyze.ts"), "export const analyze = 1;\n");
  const homeDir = piAgentHomeWithSessionState();
  const workDir = mkdtempSync(join(tmpdir(), "bwrap-work-"));
  return { repoRoot, homeDir, workDir };
}

test(
  "a real bwrap sandbox hides the eval harness and the deployed agent's eval answer key while exposing its engine and keeping the workdir writable",
  { skip: bwrapSkipReason },
  () => {
    const { repoRoot, homeDir, workDir } = sandboxedMountPlan();

    const args = buildBwrapArgs({ repoRoot, homeDir, workDir });

    assertCorpusUnreadable(args, repoRoot);
    assertDeployedEngineEvalEmpty(args, homeDir);
    assertDeployedEngineVenvReadable(args, homeDir);
    assertWorkdirWritable(args, workDir);
    assertAnalyzeTsReadable(args, repoRoot);
  },
);

test(
  "building bwrap args for this repo and running node --version through them succeeds",
  { skip: bwrapSkipReason },
  () => {
    const repoRoot = join(import.meta.dirname, "..", "..");
    const workDir = mkdtempSync(join(tmpdir(), "bwrap-work-"));

    const args = buildBwrapArgs({ repoRoot, homeDir: tmpdir(), workDir });
    const result = spawnSync("bwrap", [...args, "--", "node", "--version"]);

    assert.equal(result.status, 0);
    assert.match(result.stdout.toString(), /^v\d+\.\d+\.\d+/);
  },
);

function realRepoRoot(): string {
  return join(import.meta.dirname, "..", "..");
}

function packedCondition(id: string): ConditionManifest {
  return { id, env: {}, phrasingPack: "pack.json" };
}

function assertCanaryPassed(verdict: ReturnType<typeof evaluateCanary>): void {
  assert.equal(verdict.ok, true);
}

function assertCanaryFailedWith(verdict: ReturnType<typeof evaluateCanary>, pattern: RegExp): void {
  assert.equal(verdict.ok, false);
  assert.match(verdict.ok ? "" : verdict.reason, pattern);
}

test(
  "defaultProbeSpawner runs the real delivery probe inside bwrap and round-trips the delivered phrasing pack",
  { skip: bwrapSkipReason },
  async () => {
    const workDir = mkdtempSync(join(tmpdir(), "probe-work-"));
    const packContent = JSON.stringify({
      CC_NUDGE: {
        python: { first: "{name} probe-integration python ({cc}/{threshold})", rest: "{name} rest" },
        typescript: { first: "{name} probe-integration ts ({cc}/{threshold})", rest: "{name} rest" },
      },
      CC_DELTA_NUDGE: "probe-integration delta text",
    });

    const outcome = await defaultProbeSpawner(realRepoRoot())({ cwd: workDir, env: { LIUBAI_PHRASING_PACK: packContent } });

    const verdict = evaluateCanary({
      condition: packedCondition("probe-integration"),
      packContent,
      exitCode: outcome.exitCode,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
    });
    assertCanaryPassed(verdict);
  },
);

test(
  "the canary reports a mismatch when the sandbox delivers a phrasing pack that differs from what was expected",
  { skip: bwrapSkipReason },
  async () => {
    const workDir = mkdtempSync(join(tmpdir(), "probe-work-"));
    const deliveredPack = JSON.stringify({ CC_DELTA_NUDGE: "delivered text" });
    const expectedPack = JSON.stringify({ CC_DELTA_NUDGE: "a different expected text" });

    const outcome = await defaultProbeSpawner(realRepoRoot())({ cwd: workDir, env: { LIUBAI_PHRASING_PACK: deliveredPack } });

    const verdict = evaluateCanary({
      condition: packedCondition("probe-integration-mismatch"),
      packContent: expectedPack,
      exitCode: outcome.exitCode,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
    });

    assertCanaryFailedWith(verdict, /probe-integration-mismatch/);
  },
);
