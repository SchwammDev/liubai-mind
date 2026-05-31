from __future__ import annotations

import json
import os
import sys
from pathlib import Path


_CLAUDE_HOOKS = Path(__file__).resolve().parents[2] / ".claude" / "hooks"
if str(_CLAUDE_HOOKS) not in sys.path:
    sys.path.insert(0, str(_CLAUDE_HOOKS))


def payload() -> dict:
    try:
        return json.loads(os.environ.get("OPENHARNESS_HOOK_PAYLOAD", ""))
    except json.JSONDecodeError:
        return {}


def block(body: str) -> int:
    sys.stderr.write(
        "⛔ Edit BLOCKED — your change was NOT applied. The file is unchanged.\n\n"
        + body.rstrip()
        + "\n\nFix this and re-issue the edit.\n"
    )
    return 1
