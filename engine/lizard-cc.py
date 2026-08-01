#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from pathlib import PurePosixPath


TS_PROXY_EXTS = (".mts", ".cts")


def _lizard_filename(path: str) -> str:
    name = PurePosixPath(path).name if path else ""
    lower = name.lower()
    if lower.endswith(TS_PROXY_EXTS):
        return name[: -len(lower[-4:])] + ".ts"
    return name


def lizard_cc(source: str, path: str) -> list[dict]:
    try:
        import lizard
    except ImportError:
        sys.stderr.write("lizard-cc: lizard not installed; run `uv pip install lizard` in engine/\n")
        sys.exit(2)

    analyzer = lizard.FileAnalyzer(lizard.get_extensions([]))
    info = analyzer.analyze_source_code(_lizard_filename(path), source)
    return [
        {
            "name": fi.name.rsplit(".", 1)[-1],
            "startLine": fi.start_line,
            "cyclomaticComplexity": fi.cyclomatic_complexity,
        }
        for fi in info.function_list
    ]


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        sys.stderr.write(f"lizard-cc: invalid JSON input: {exc}\n")
        return 1

    path = payload.get("path", "")
    after = payload.get("after", "")
    functions = lizard_cc(after, path)
    json.dump({"functions": functions}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
