import { test } from "node:test";
import assert from "node:assert/strict";

import { scanReferences } from "./references.ts";
import type { ReferenceScan } from "./references.ts";

function scanTs(files: Record<string, string>, created: readonly string[]): ReferenceScan {
  return scanReferences({ lang: "typescript", entry: "entry.ts", files, created });
}

function scanPy(files: Record<string, string>, created: readonly string[]): ReferenceScan {
  return scanReferences({ lang: "python", entry: "entry.py", files, created });
}

function assertScan(result: ReferenceScan, referenced: string[], unresolved: string[] = []): void {
  assert.deepEqual(result, { referenced, unresolved });
}

test("scanReferences_finds_a_created_module_via_plain_import", () => {
  const files = { "entry.ts": `import { x } from "./helpers.ts";`, "helpers.ts": "export const x = 1;" };

  const result = scanTs(files, ["helpers.ts"]);

  assertScan(result, ["helpers.ts"]);
});

test("scanReferences_resolves_extensionless_specifier_to_a_created_ts_file", () => {
  const files = { "entry.ts": `import { x } from "./helpers";`, "helpers.ts": "export const x = 1;" };

  const result = scanTs(files, ["helpers.ts"]);

  assertScan(result, ["helpers.ts"]);
});

test("scanReferences_resolves_extensionless_specifier_to_a_created_js_file", () => {
  const files = { "entry.ts": `import { x } from "./helpers";`, "helpers.js": "export const x = 1;" };

  const result = scanTs(files, ["helpers.js"]);

  assertScan(result, ["helpers.js"]);
});

test("scanReferences_finds_a_created_module_via_side_effect_import", () => {
  const files = { "entry.ts": `import "./setup.ts";`, "setup.ts": "sideEffect();" };

  const result = scanTs(files, ["setup.ts"]);

  assertScan(result, ["setup.ts"]);
});

test("scanReferences_finds_a_created_module_via_require_call", () => {
  const files = { "entry.ts": `const helpers = require("./helpers.ts");`, "helpers.ts": "module.exports = {};" };

  const result = scanTs(files, ["helpers.ts"]);

  assertScan(result, ["helpers.ts"]);
});

test("scanReferences_finds_a_created_module_via_dynamic_import", () => {
  const files = { "entry.ts": `async function load() { await import("./lazy.ts"); }`, "lazy.ts": "export const y = 1;" };

  const result = scanTs(files, ["lazy.ts"]);

  assertScan(result, ["lazy.ts"]);
});

test("scanReferences_finds_a_created_module_via_re_export", () => {
  const files = { "entry.ts": `export { x } from "./mod.ts";`, "mod.ts": "export const x = 1;" };

  const result = scanTs(files, ["mod.ts"]);

  assertScan(result, ["mod.ts"]);
});

test("scanReferences_finds_specifier_on_the_closing_line_of_a_multi_line_import", () => {
  const files = { "entry.ts": `import {\n  x,\n  y,\n} from "./h.ts";`, "h.ts": "export const x = 1;\nexport const y = 2;" };

  const result = scanTs(files, ["h.ts"]);

  assertScan(result, ["h.ts"]);
});

test("scanReferences_ignores_bare_package_specifiers", () => {
  const files = { "entry.ts": `import { join } from "node:path";\nimport _ from "lodash";` };

  const result = scanTs(files, []);

  assertScan(result, []);
});

test("scanReferences_resolves_specifier_relative_to_the_importing_subdir_file", () => {
  const files = { "entry.ts": `import "./lib/util.ts";`, "lib/util.ts": `import "./mod.ts";`, "lib/mod.ts": "export const z = 1;" };

  const result = scanTs(files, ["lib/util.ts", "lib/mod.ts"]);

  assertScan(result, ["lib/mod.ts", "lib/util.ts"]);
});

test("scanReferences_resolves_parent_relative_specifier_from_a_subdir_file_to_root", () => {
  const files = { "entry.ts": `import "./lib/util.ts";`, "lib/util.ts": `import "../root.ts";`, "root.ts": "export const r = 1;" };

  const result = scanTs(files, ["lib/util.ts", "root.ts"]);

  assertScan(result, ["lib/util.ts", "root.ts"]);
});

test("scanReferences_ignores_import_on_a_comment_line", () => {
  const files = { "entry.ts": `// import { x } from "./helpers.ts";\nconst y = 1;`, "helpers.ts": "export const x = 1;" };

  const result = scanTs(files, ["helpers.ts"]);

  assertScan(result, []);
});

test("scanReferences_finds_a_created_module_via_plain_python_import", () => {
  const files = { "entry.py": "import helpers\n", "helpers.py": "x = 1\n" };

  const result = scanPy(files, ["helpers.py"]);

  assertScan(result, ["helpers.py"]);
});

test("scanReferences_finds_a_created_module_via_python_import_as", () => {
  const files = { "entry.py": "import helpers as h\n", "helpers.py": "x = 1\n" };

  const result = scanPy(files, ["helpers.py"]);

  assertScan(result, ["helpers.py"]);
});

test("scanReferences_finds_a_created_module_via_python_from_import", () => {
  const files = { "entry.py": "from helpers import x\n", "helpers.py": "x = 1\n" };

  const result = scanPy(files, ["helpers.py"]);

  assertScan(result, ["helpers.py"]);
});

test("scanReferences_resolves_dotted_python_module_to_nested_path", () => {
  const files = { "entry.py": "import lib.helpers\n", "lib/helpers.py": "x = 1\n" };

  const result = scanPy(files, ["lib/helpers.py"]);

  assertScan(result, ["lib/helpers.py"]);
});

test("scanReferences_resolves_python_package_module_to_its_init_file", () => {
  const files = { "entry.py": "import lib\n", "lib/__init__.py": "x = 1\n" };

  const result = scanPy(files, ["lib/__init__.py"]);

  assertScan(result, ["lib/__init__.py"]);
});

test("scanReferences_finds_both_modules_in_comma_separated_python_import", () => {
  const files = { "entry.py": "import a, b as c\n", "a.py": "x = 1\n", "b.py": "y = 1\n" };

  const result = scanPy(files, ["a.py", "b.py"]);

  assertScan(result, ["a.py", "b.py"]);
});

test("scanReferences_finds_python_module_despite_trailing_comment", () => {
  const files = { "entry.py": "import helpers  # loads helpers\n", "helpers.py": "x = 1\n" };

  const result = scanPy(files, ["helpers.py"]);

  assertScan(result, ["helpers.py"]);
});

test("scanReferences_ignores_python_relative_from_dot_import", () => {
  const files = { "entry.py": "from . import helpers\n", "helpers.py": "x = 1\n" };

  const result = scanPy(files, ["helpers.py"]);

  assertScan(result, []);
});

test("scanReferences_reports_unmatched_python_import_as_unresolved_candidates", () => {
  const files = { "entry.py": "import json\n" };

  const result = scanPy(files, []);

  assertScan(result, [], ["json.py", "json/__init__.py"]);
});

test("scanReferences_follows_transitive_imports_through_created_files", () => {
  const files = { "entry.ts": `import "./a.ts";`, "a.ts": `import "./b.ts";`, "b.ts": "export const z = 1;" };

  const result = scanTs(files, ["a.ts", "b.ts"]);

  assertScan(result, ["a.ts", "b.ts"]);
});

test("scanReferences_terminates_on_a_mutual_import_cycle_with_both_files_referenced", () => {
  const files = { "entry.ts": `import "./a.ts";`, "a.ts": `import "./b.ts";`, "b.ts": `import "./a.ts";` };

  const result = scanTs(files, ["a.ts", "b.ts"]);

  assertScan(result, ["a.ts", "b.ts"]);
});

test("scanReferences_excludes_a_created_file_nothing_references", () => {
  const files = { "entry.ts": `import "./a.ts";`, "a.ts": "export const x = 1;", "orphan.ts": "export const y = 1;" };

  const result = scanTs(files, ["a.ts", "orphan.ts"]);

  assertScan(result, ["a.ts"]);
});

test("scanReferences_with_no_created_files_returns_empty_arrays", () => {
  const files = { "entry.ts": "export const x = 1;" };

  const result = scanTs(files, []);

  assertScan(result, []);
});

test("scanReferences_with_missing_entry_source_returns_empty_arrays", () => {
  const result = scanTs({}, ["helpers.ts"]);

  assertScan(result, []);
});

test("scanReferences_never_reports_the_entry_itself", () => {
  const files = { "entry.ts": `import "./a.ts";`, "a.ts": `import "./entry.ts";` };

  const result = scanTs(files, ["a.ts"]);

  assertScan(result, ["a.ts"]);
});
