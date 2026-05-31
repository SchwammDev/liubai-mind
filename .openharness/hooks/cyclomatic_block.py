#!/usr/bin/env python3
from __future__ import annotations

import sys

from _oh_hook import block, payload
from cyclomatic_complexity_nudge import (
    CC_THRESHOLD,
    complex_touched_functions,
    edit_states,
    is_generated_content,
    is_skipped_path,
)


def main() -> int:
    path, old_text, new_text = edit_states(payload())
    if not path or is_skipped_path(path):
        return 0
    if is_generated_content(old_text) or is_generated_content(new_text):
        return 0

    flagged = complex_touched_functions(old_text, new_text)
    if not flagged:
        return 0

    listed = ", ".join(f"{name} (CC={cc})" for name, cc in flagged)
    return block(
        f"Cyclomatic complexity too high — {listed} (limit {CC_THRESHOLD}). "
        "Extract guard clauses, split branches into named helpers, or use a dispatch table."
    )


if __name__ == "__main__":
    sys.exit(main())
