#!/usr/bin/env python3
from __future__ import annotations

import sys

from _oh_hook import block, payload
from long_test_nudge import (
    TEST_BODY_LINE_THRESHOLD,
    edit_states,
    helper_inventory,
    is_test_path,
    long_touched_tests,
)


def main() -> int:
    path, old_text, new_text = edit_states(payload())
    if not path or not is_test_path(path):
        return 0

    long_tests = long_touched_tests(old_text, new_text)
    if not long_tests:
        return 0

    over = ", ".join(f"{name} ({length}L)" for name, length in long_tests)
    helpers = helper_inventory()
    message = (
        f"Test too long — {over} (limit {TEST_BODY_LINE_THRESHOLD}L). "
        "Hide asserts behind intent-named helpers; extract setup."
    )
    if helpers:
        message += " Existing helpers: " + ", ".join(helpers) + "."
    else:
        message += " No assert_*/_* helpers in tests/ yet — write one."
    return block(message)


if __name__ == "__main__":
    sys.exit(main())
