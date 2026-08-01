import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SETUP_SH = join(REPO, "setup.sh");

function newSandbox() {
  const home = mkdtempSync(join(tmpdir(), "liubai-install-"));
  const agentDir = join(home, ".pi/agent");
  mkdirSync(agentDir, { recursive: true });
  return { home, agentDir, engineDest: join(agentDir, "engine") };
}

function runIn({ home, agentDir }, body) {
  return spawnSync("bash", ["-c", `source "${SETUP_SH}"\n${body}`], {
    env: {
      ...process.env,
      HOME: home,
      LIUBAI_REPO: REPO,
      LIUBAI_AGENT_DIR: agentDir,
      LIUBAI_ENGINE_DEST: join(agentDir, "engine"),
    },
    encoding: "utf8",
  });
}

test("install_engine copies the engine and strips .venv + node_modules", () => {
  const sb = newSandbox();
  const res = runIn(sb, "install_engine");
  assert.equal(res.status, 0, res.stderr);

  assert.ok(existsSync(join(sb.engineDest, "extract-typescript.ts")));
  assert.ok(!existsSync(join(sb.engineDest, ".venv")));
  assert.ok(!existsSync(join(sb.engineDest, "node_modules")));

  rmSync(sb.home, { recursive: true, force: true });
});

test("install_engine_deps installs tree-sitter-typescript beside the engine", () => {
  const sb = newSandbox();
  const res = runIn(sb, `
    install_engine
    install_engine_deps "${sb.engineDest}"
  `);
  assert.equal(res.status, 0, res.stderr);

  assert.ok(existsSync(join(sb.engineDest, "node_modules/tree-sitter-typescript")));
  assert.ok(existsSync(join(sb.engineDest, "node_modules/tree-sitter")));

  rmSync(sb.home, { recursive: true, force: true });
});

test("install_engine_deps is idempotent across re-runs", () => {
  const sb = newSandbox();
  const res = runIn(sb, `
    install_engine
    install_engine_deps "${sb.engineDest}"
    install_engine_deps "${sb.engineDest}"
  `);
  assert.equal(res.status, 0, res.stderr);

  assert.ok(existsSync(join(sb.engineDest, "package-lock.json")));

  rmSync(sb.home, { recursive: true, force: true });
});

test("installed engine resolves tree-sitter-typescript via createRequire", () => {
  const sb = newSandbox();
  const install = runIn(sb, `
    install_engine
    install_engine_deps "${sb.engineDest}"
  `);
  assert.equal(install.status, 0, install.stderr);

  // The bug: extract-typescript.ts does createRequire(import.meta.url) and
  // require_("tree-sitter-typescript"). After install, the require must
  // resolve from a file inside the installed engine dir.
  const probe = spawnSync(
    "node",
    [
      "--input-type=module",
      "-e",
      `import { createRequire } from "node:module";
       import { pathToFileURL } from "node:url";
       const req = createRequire(pathToFileURL("${sb.engineDest}/extract-typescript.ts").href);
       const ts = req("tree-sitter-typescript");
       if (typeof ts.typescript !== "object" || typeof ts.tsx !== "object") process.exit(1);`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);

  rmSync(sb.home, { recursive: true, force: true });
});

test("link_project_venv replaces a real venv with a symlink to the installed one", () => {
  const sb = newSandbox();
  const installedVenv = join(sb.engineDest, ".venv");
  const projectVenv = join(sb.home, "fake-project", "engine", ".venv");
  mkdirSync(installedVenv, { recursive: true });
  mkdirSync(dirname(projectVenv), { recursive: true });
  mkdirSync(projectVenv, { recursive: true });

  const res = runIn(sb, `link_project_venv "${installedVenv}" "${projectVenv}"`);
  assert.equal(res.status, 0, res.stderr);

  const lst = spawnSync("ls", ["-la", projectVenv], { encoding: "utf8" });
  assert.match(lst.stdout, /\.venv -> .*\.venv/, "project venv is a symlink");
  assert.ok(!existsSync(join(projectVenv, "bin")), "real venv contents are gone");

  rmSync(sb.home, { recursive: true, force: true });
});
