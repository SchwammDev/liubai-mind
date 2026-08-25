import { test } from "node:test";
import assert from "node:assert/strict";

import {
  countSilentHandlers,
  countSilentHandlersTs,
  countSilentHandlersPy,
} from "./silent-handlers.ts";
import type { PyRunner } from "./silent-handlers.ts";
import { venvPythonAvailable } from "./judge-env.ts";

test("empty_catch_body_is_counted_as_silent", () => {
  const src = "function f() {\n  try {\n    doIt();\n  } catch (e) {\n  }\n}\n";

  const count = countSilentHandlersTs(src);

  assert.equal(count, 1);
});

test("catch_that_rethrows_is_not_counted", () => {
  const src = "function f() {\n  try {\n    doIt();\n  } catch (e) {\n    throw e;\n  }\n}\n";

  const count = countSilentHandlersTs(src);

  assert.equal(count, 0);
});

test("catch_that_calls_console_error_is_not_counted", () => {
  const src = "function f() {\n  try {\n    doIt();\n  } catch (e) {\n    console.error(e);\n  }\n}\n";

  const count = countSilentHandlersTs(src);

  assert.equal(count, 0);
});

test("catch_returning_a_default_literal_is_counted", () => {
  const src = "function f() {\n  try {\n    return doIt();\n  } catch (e) {\n    return DEFAULT;\n  }\n}\n";

  const count = countSilentHandlersTs(src);

  assert.equal(count, 1);
});

test("two_nested_try_catches_are_each_counted_individually", () => {
  const src = "function f() { try { try { doIt(); } catch (inner) {} } catch (outer) {} }\n";

  const count = countSilentHandlersTs(src);

  assert.equal(count, 2);
});

test("source_with_no_catch_clause_counts_zero", () => {
  const src = "function f() {\n  return doIt();\n}\n";

  const count = countSilentHandlersTs(src);

  assert.equal(count, 0);
});

function capturingRunner(): { calls: { script: string; source: string }[]; runner: PyRunner } {
  const calls: { script: string; source: string }[] = [];
  const runner: PyRunner = (script, source) => {
    calls.push({ script, source });
    return JSON.stringify({ count: 0 });
  };
  return { calls, runner };
}

test("countSilentHandlersPy_forwards_the_bundled_script_path_to_the_runner", () => {
  const { calls, runner } = capturingRunner();

  countSilentHandlersPy("except Exception:\n    pass\n", runner);

  assert.ok(calls[0]!.script.endsWith("silent_handlers.py"));
});

test("countSilentHandlersPy_forwards_the_source_to_the_runner", () => {
  const { calls, runner } = capturingRunner();
  const source = "except Exception:\n    pass\n";

  countSilentHandlersPy(source, runner);

  assert.equal(calls[0]!.source, source);
});

test("countSilentHandlersPy_parses_the_count_field_from_the_runner_json_output", () => {
  const fakeRunner: PyRunner = () => JSON.stringify({ count: 3 });

  const count = countSilentHandlersPy("irrelevant", fakeRunner);

  assert.equal(count, 3);
});

test("countSilentHandlers_dispatches_to_the_typescript_detector_for_typescript", () => {
  const src = "function f() {\n  try {\n    doIt();\n  } catch (e) {\n  }\n}\n";

  const count = countSilentHandlers(src, "typescript");

  assert.equal(count, 1);
});

test("countSilentHandlers_dispatches_to_the_python_detector_for_python", { skip: !venvPythonAvailable() }, () => {
  const src = "try:\n    do_it()\nexcept Exception:\n    pass\n";

  const count = countSilentHandlers(src, "python");

  assert.equal(count, 1);
});

test("bare_except_pass_is_counted_as_silent", { skip: !venvPythonAvailable() }, () => {
  const src = "try:\n    do_it()\nexcept:\n    pass\n";

  const count = countSilentHandlersPy(src);

  assert.equal(count, 1);
});

test("except_exception_returning_none_is_counted_as_silent", { skip: !venvPythonAvailable() }, () => {
  const src = "def f():\n    try:\n        return do_it()\n    except Exception:\n        return None\n";

  const count = countSilentHandlersPy(src);

  assert.equal(count, 1);
});

test("except_narrow_key_error_pass_is_not_counted", { skip: !venvPythonAvailable() }, () => {
  const src = "try:\n    do_it()\nexcept KeyError:\n    pass\n";

  const count = countSilentHandlersPy(src);

  assert.equal(count, 0);
});

test("except_exception_with_logging_call_is_not_counted", { skip: !venvPythonAvailable() }, () => {
  const src = "try:\n    do_it()\nexcept Exception:\n    log.error('boom')\n";

  const count = countSilentHandlersPy(src);

  assert.equal(count, 0);
});

test("except_exception_that_reraises_a_different_error_is_not_counted", { skip: !venvPythonAvailable() }, () => {
  const src = "try:\n    do_it()\nexcept Exception:\n    raise ValueError('boom')\n";

  const count = countSilentHandlersPy(src);

  assert.equal(count, 0);
});
