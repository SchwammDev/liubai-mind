#!/usr/bin/env python3
from __future__ import annotations

import sys

from _oh_hook import block, payload
from type_annotation_nudge import (
    edit_states,
    is_generated_content,
    is_skipped_path,
    touched_unannotated,
)


def main() -> int:
    path, old_text, new_text = edit_states(payload())
    if not path or is_skipped_path(path):
        return 0
    if is_generated_content(old_text) or is_generated_content(new_text):
        return 0

    flagged = touched_unannotated(old_text, new_text)
    if not flagged:
        return 0

    parts = "; ".join(f"{name} (missing: {', '.join(items)})" for name, items in flagged)
    return block(
        f"Missing type annotations — {parts}. "
        "Annotate every parameter (except self/cls) and the return type."
    )


if __name__ == "__main__":
    sys.exit(main())
