#!/usr/bin/env python3
from __future__ import annotations

import sys

from _oh_hook import block, payload
from no_added_comments import collect_added_comments


def main() -> int:
    path, items = collect_added_comments(payload())
    if not items:
        return 0

    lines = [f"New Python comments in {path}:"]
    for line_no, line in items:
        snippet = line.strip()
        if len(snippet) > 100:
            snippet = snippet[:97] + "..."
        lines.append(f"  L{line_no}: {snippet}")
    lines.append(
        "Comments are noise — encode intent in names and structure, then re-issue. "
        "A genuine WHY-comment must be cleared with the user first."
    )
    return block("\n".join(lines))


if __name__ == "__main__":
    sys.exit(main())
