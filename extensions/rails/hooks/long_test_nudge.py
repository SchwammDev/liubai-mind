#!/usr/bin/env python3
from __future__ import annotations

import ast
import json
import re
import subprocess
import sys
from pathlib import Path


TEST_BODY_LINE_THRESHOLD = 8
TESTS_ROOT = Path("tests")
HELPER_INVENTORY_LIMIT = 6


def is_test_path(path: str) -> bool:
    p = Path(path)
    name = p.name
    if not name.endswith(".py"):
        return False
    if name == "conftest.py":
        return True
    if name.startswith("test_") or name.endswith("_test.py"):
        return True
    return "tests" in p.parts


def existing_file_text(path: str) -> str:
    try:
        return Path(path).read_text()
    except (FileNotFoundError, IsADirectoryError, PermissionError, UnicodeDecodeError):
        return ""


def edit_states(payload: dict) -> tuple[str, str, str]:
    tool = payload.get("tool_name", "")
    inp = payload.get("tool_input", {}) or {}
    path = inp.get("file_path", "")

    if tool == "Write":
        return path, existing_file_text(path), inp.get("content", "")

    if tool == "Edit":
        old_text = existing_file_text(path)
        new_text = old_text.replace(inp.get("old_string", ""), inp.get("new_string", ""), 1)
        return path, old_text, new_text

    if tool == "MultiEdit":
        old_text = existing_file_text(path)
        new_text = old_text
        for edit in inp.get("edits", []) or []:
            new_text = new_text.replace(edit.get("old_string", ""), edit.get("new_string", ""), 1)
        return path, old_text, new_text

    return "", "", ""


def parse_test_bodies(text: str) -> dict[str, tuple[str, int]]:
    if not text:
        return {}
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return {}
    lines = text.splitlines()
    bodies: dict[str, tuple[str, int]] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name.startswith("test_") and node.body:
            start = node.body[0].lineno
            end = node.end_lineno or start
            body = "\n".join(lines[start - 1: end])
            bodies[node.name] = (body, end - start + 1)
    return bodies


def long_touched_tests(old_text: str, new_text: str) -> list[tuple[str, int]]:
    new_bodies = parse_test_bodies(new_text)
    old_bodies = parse_test_bodies(old_text)
    touched: list[tuple[str, int]] = []
    for name, (body, length) in new_bodies.items():
        if length <= TEST_BODY_LINE_THRESHOLD:
            continue
        previous = old_bodies.get(name)
        if previous is None or previous[0] != body:
            touched.append((name, length))
    return touched


def helper_inventory() -> list[str]:
    if not TESTS_ROOT.is_dir():
        return []
    try:
        result = subprocess.run(
            ["grep", "-rh", "-E", r"^def (assert_|_)", str(TESTS_ROOT)],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return []

    names: list[str] = []
    seen: set[str] = set()
    for line in result.stdout.splitlines():
        m = re.match(r"def (\w+)", line)
        if m:
            name = m.group(1)
            if name == "_" or name in seen:
                continue
            seen.add(name)
            names.append(name)
    return names[:HELPER_INVENTORY_LIMIT]


def format_reminder(long_tests: list[tuple[str, int]], helpers: list[str]) -> str:
    over = ", ".join(f"{name} ({length}L)" for name, length in long_tests)
    msg = (
        f"Long test detected: {over}. "
        "Hide asserts behind intent-named helpers; extract setup. "
        "Multi-assert / fat-setup is the usual cause."
    )
    if helpers:
        msg += " Existing helpers: " + ", ".join(helpers) + "."
    else:
        msg += " No `assert_*`/`_*` helpers in tests/ yet — write one."
    return msg


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        return 0

    path, old_text, new_text = edit_states(payload)
    if not path or not is_test_path(path):
        return 0

    long_tests = long_touched_tests(old_text, new_text)
    if not long_tests:
        return 0

    helpers = helper_inventory()
    output = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "additionalContext": format_reminder(long_tests, helpers),
        }
    }
    print(json.dumps(output))
    return 0


if __name__ == "__main__":
    sys.exit(main())
