import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { PYTHON_BIN } from "../extract-python.ts";

function lastNonEmptyLine(text: string): string | undefined {
  const lines = text.split("\n").filter((line) => line.length > 0);
  return lines[lines.length - 1];
}

export function probePyCcBackend(pythonBin: string = PYTHON_BIN): string {
  if (!existsSync(pythonBin)) {
    throw new Error(`judge-env: venv missing at ${pythonBin}; run \`./setup.sh\` (requires uv on PATH)`);
  }

  const res = spawnSync(pythonBin, ["-c", "import lizard; from importlib.metadata import version; print(version('lizard'))"], {
    encoding: "utf8",
  });

  if (res.error !== undefined) {
    throw new Error(res.error.message);
  }

  if (res.status !== 0) {
    const last = lastNonEmptyLine(res.stderr ?? "");
    throw new Error(last ?? `judge-env: exit ${res.status}`);
  }

  const version = res.stdout.trim();
  if (version.length === 0) {
    throw new Error("judge-env: lizard probe produced no output");
  }

  return `lizard ${version}`;
}

export function venvPythonAvailable(): boolean {
  return existsSync(PYTHON_BIN);
}
