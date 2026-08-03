import fs from "node:fs";
import path from "node:path";

import { v8CoverageToSnapshot } from "./coverage-v8.ts";

const [coverageDir, repoRoot, outFile] = process.argv.slice(2);

if (coverageDir === undefined || repoRoot === undefined || outFile === undefined) {
  process.stderr.write("usage: coverage-v8-cli.ts <coverageDir> <repoRoot> <outFile>\n");
  process.exit(2);
}

const snapshot = await v8CoverageToSnapshot(coverageDir, repoRoot);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(snapshot, null, 2) + "\n");
