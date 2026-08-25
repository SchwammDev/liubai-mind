#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
import trace
from os import environ
from pathlib import Path

SENTINEL_PREFIX = "LIUBAI_PROBE_RESULT:"


def _category(value: object) -> str:
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "str"
    if value is None:
        return "none"
    if isinstance(value, list):
        return "list"
    if isinstance(value, dict):
        return "dict"
    return "other"


def _lists_equal(actual: list, expected: list) -> bool:
    if len(actual) != len(expected):
        return False
    return all(_deep_equal(a, e) for a, e in zip(actual, expected))


def _dicts_equal(actual: dict, expected: dict) -> bool:
    if set(actual.keys()) != set(expected.keys()):
        return False
    return all(_deep_equal(actual[key], expected[key]) for key in actual)


_EQUALITY_BY_CATEGORY = {
    "bool": lambda a, e: a == e,
    "number": lambda a, e: a == e,
    "str": lambda a, e: a == e,
    "none": lambda a, e: True,
    "list": _lists_equal,
    "dict": _dicts_equal,
    "other": lambda a, e: False,
}


def _deep_equal(actual: object, expected: object) -> bool:
    category = _category(actual)
    if category != _category(expected):
        return False
    return _EQUALITY_BY_CATEGORY[category](actual, expected)


def _safe_json(value: object) -> str:
    try:
        return json.dumps(value)
    except Exception:
        return str(value)


def _error_message(exc: BaseException) -> str:
    return str(exc)


def _load_entry(source_path: str, entry_symbol: str) -> tuple[object, str | None]:
    sys.path.insert(0, str(Path(source_path).parent))
    module_globals: dict[str, object] = {"__name__": Path(source_path).stem, "__file__": source_path}
    try:
        with open(source_path, "r", encoding="utf-8") as f:
            src = f.read()
        code = compile(src, source_path, "exec")
        exec(code, module_globals)
    except Exception as exc:
        return None, _error_message(exc)

    fn = module_globals.get(entry_symbol)
    if not callable(fn):
        return None, f'entry symbol "{entry_symbol}" is not defined or not callable'
    return fn, None


def _run_returns_probe(fn: object, probe: dict, number: int) -> dict:
    try:
        actual = fn(*probe["args"])
    except Exception as exc:
        reason = f'probe {number}: expected {_safe_json(probe["returns"])}, got throw "{_error_message(exc)}"'
        return {"pass": False, "reason": reason}
    if _deep_equal(actual, probe["returns"]):
        return {"pass": True}
    reason = f'probe {number}: expected {_safe_json(probe["returns"])}, got {_safe_json(actual)}'
    return {"pass": False, "reason": reason}


def _run_throws_probe(fn: object, probe: dict, number: int) -> dict:
    try:
        actual = fn(*probe["args"])
    except Exception as exc:
        message = _error_message(exc)
        if message == probe["throws"]:
            return {"pass": True}
        reason = f'probe {number}: expected throw "{probe["throws"]}", got throw "{message}"'
        return {"pass": False, "reason": reason}
    reason = f'probe {number}: expected throw "{probe["throws"]}", got return {_safe_json(actual)}'
    return {"pass": False, "reason": reason}


def _run_probe(fn: object, probe: dict, number: int) -> dict:
    if "throws" in probe:
        return _run_throws_probe(fn, probe, number)
    return _run_returns_probe(fn, probe, number)


def _run_all_probes(fn: object, probes: list[dict]) -> list[dict]:
    return [_run_probe(fn, probe, i + 1) for i, probe in enumerate(probes)]


def _write_trace(tracer: trace.Trace, source_path: str, trace_out_path: str) -> None:
    counts = tracer.results().counts
    executed = sorted({line for (filename, line) in counts if filename == source_path})
    executable = sorted(trace._find_executable_linenos(source_path))
    with open(trace_out_path, "w", encoding="utf-8") as f:
        json.dump({"executed": executed, "executable": executable}, f)


def _print_sentinel(payload: dict) -> None:
    sys.stdout.write(SENTINEL_PREFIX + json.dumps(payload) + "\n")


def main() -> None:
    payload = json.loads(sys.stdin.read())
    source_path = payload["sourcePath"]
    entry_symbol = payload["entrySymbol"]
    probes = payload["probes"]

    trace_out_path = environ.get("LIUBAI_PROBE_TRACE_OUT")
    tracer = trace.Trace(count=1, trace=0) if trace_out_path else None
    run = tracer.runfunc if tracer is not None else lambda f, *args: f(*args)

    fn, load_error = run(_load_entry, source_path, entry_symbol)
    if load_error is not None:
        _print_sentinel({"loadError": load_error})
        return

    results = run(_run_all_probes, fn, probes)
    if tracer is not None:
        _write_trace(tracer, source_path, trace_out_path)

    _print_sentinel({"results": results})


if __name__ == "__main__":
    main()
