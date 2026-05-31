from __future__ import annotations

import json
import os
import sys
from pathlib import Path


_CLAUDE_HOOKS = Path(__file__).resolve().parents[2] / ".claude" / "hooks"
if str(_CLAUDE_HOOKS) not in sys.path:
    sys.path.insert(0, str(_CLAUDE_HOOKS))


def _normalize(raw: dict) -> dict:
    tool = raw.get("tool_name", "")
    inp = raw.get("tool_input", {}) or {}
    if tool == "write_file":
        return {
            "tool_name": "Write",
            "tool_input": {"file_path": inp.get("path", ""), "content": inp.get("content", "")},
        }
    if tool == "edit_file":
        return {
            "tool_name": "Edit",
            "tool_input": {
                "file_path": inp.get("path", ""),
                "old_string": inp.get("old_str", ""),
                "new_string": inp.get("new_str", ""),
            },
        }
    return raw


def payload() -> dict:
    try:
        raw = json.loads(os.environ.get("OPENHARNESS_HOOK_PAYLOAD", ""))
    except json.JSONDecodeError:
        return {}
    return _normalize(raw)


def block(body: str) -> int:
    sys.stderr.write(
        "⛔ Edit BLOCKED — your change was NOT applied. The file is unchanged.\n\n"
        + body.rstrip()
        + "\n\nFix this and re-issue the edit.\n"
    )
    return 1
