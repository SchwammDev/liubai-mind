import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { probePyCcBackend, venvPythonAvailable } from "./judge-env.ts";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "judge-env-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function stubScript(dir: string, contents: string, mode = 0o755): string {
  const path = join(dir, "python");
  writeFileSync(path, contents);
  chmodSync(path, mode);
  return path;
}

function thrownMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  assert.fail("expected function to throw");
}

test("probePyCcBackend_returns_the_lizard_version_string_when_the_venv_python_has_lizard", { skip: !venvPythonAvailable() }, () => {
  const version = probePyCcBackend();

  assert.match(version, /^lizard \d+\.\d+/);
});

test("probePyCcBackend_throws_a_setup_hint_when_the_python_binary_does_not_exist", () => {
  withTempDir((dir) => {
    const missingBin = join(dir, "python");

    const message = thrownMessage(() => probePyCcBackend(missingBin));

    assert.equal(message, `judge-env: venv missing at ${missingBin}; run \`./setup.sh\` (requires uv on PATH)`);
  });
});

test("probePyCcBackend_surfaces_the_spawn_error_message_when_the_interpreter_cannot_be_executed", () => {
  withTempDir((dir) => {
    const notExecutable = stubScript(dir, "#!/bin/sh\necho hi\n", 0o644);

    assert.match(thrownMessage(() => probePyCcBackend(notExecutable)), /EACCES/);
  });
});

test("probePyCcBackend_throws_the_last_non_empty_stderr_line_when_the_backend_exits_non_zero", () => {
  withTempDir((dir) => {
    const installHint = "lizard-cc: lizard not installed; run `uv pip install lizard` in engine/";
    const stub = stubScript(dir, `#!/bin/sh\necho ignored earlier line >&2\necho '${installHint}' >&2\nexit 2\n`);

    const message = thrownMessage(() => probePyCcBackend(stub));

    assert.equal(message, installHint);
  });
});

test("probePyCcBackend_throws_when_stdout_is_empty_after_trimming", () => {
  withTempDir((dir) => {
    const stub = stubScript(dir, "#!/bin/sh\nexit 0\n");

    const message = thrownMessage(() => probePyCcBackend(stub));

    assert.match(message, /^judge-env:/);
  });
});
