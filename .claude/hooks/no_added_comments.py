#!/usr/bin/env python3
from __future__ import annotations

import io
import json
import re
import sys
import tokenize
from pathlib import Path


ALLOW_PATTERN = re.compile(
    r"^#\s*(!|noqa|type:|ty:|pragma:|fmt:|pylint:|isort:|pyright:)", re.IGNORECASE
)


def is_allowed_comment(text: str) -> bool:
    return bool(ALLOW_PATTERN.match(text.lstrip()))


def find_comment_lines(text: str) -> dict[int, str]:
    found: dict[int, str] = {}
    lines = text.split("\n")

    try:
        for tok in tokenize.generate_tokens(io.StringIO(text).readline):
            if tok.type == tokenize.COMMENT:
                if not is_allowed_comment(tok.string):
                    found[tok.start[0]] = lines[tok.start[0] - 1]
            elif tok.type == tokenize.STRING and tok.string.lstrip().startswith(('"""', "'''")):
                start_line, end_line = tok.start[0], tok.end[0]
                for ln in range(start_line, end_line + 1):
                    found[ln] = lines[ln - 1]
        return found
    except (tokenize.TokenizeError, IndentationError, SyntaxError):
        pass

    in_triple = False
    triple_quote = ""
    for i, line in enumerate(lines, start=1):
        if in_triple:
            found[i] = line
            if triple_quote in line:
                in_triple = False
            continue

        stripped = line.strip()
        if not stripped:
            continue

        triple_match = re.search(r'("""|\'\'\')', line)
        if triple_match:
            quote = triple_match.group(1)
            after = line[triple_match.end():]
            if quote in after:
                found[i] = line
            else:
                found[i] = line
                in_triple = True
                triple_quote = quote
            continue

        if stripped.startswith("#"):
            if not is_allowed_comment(stripped):
                found[i] = line
            continue

        m = re.search(r"\s+#", line)
        if m:
            tail = line[m.start() + 1:].strip()
            if not is_allowed_comment("#" + tail):
                found[i] = line

    return found


def added_comments(old_text: str, new_text: str) -> list[tuple[int, str]]:
    old_lines = set(old_text.split("\n"))
    new_comments = find_comment_lines(new_text)
    return sorted(
        (line_no, line) for line_no, line in new_comments.items() if line not in old_lines
    )


def existing_file_text(path: str) -> str:
    try:
        return Path(path).read_text()
    except (FileNotFoundError, IsADirectoryError, PermissionError, UnicodeDecodeError):
        return ""


def is_python_file(path: str) -> bool:
    return path.endswith(".py")


def collect_added_comments(payload: dict) -> tuple[str, list[tuple[int, str]]]:
    tool = payload.get("tool_name", "")
    inp = payload.get("tool_input", {}) or {}

    if tool == "Write":
        path = inp.get("file_path", "")
        if not is_python_file(path):
            return path, []
        return path, added_comments(existing_file_text(path), inp.get("content", ""))

    if tool == "Edit":
        path = inp.get("file_path", "")
        if not is_python_file(path):
            return path, []
        return path, added_comments(inp.get("old_string", ""), inp.get("new_string", ""))

    if tool == "MultiEdit":
        path = inp.get("file_path", "")
        if not is_python_file(path):
            return path, []
        all_added: list[tuple[int, str]] = []
        for edit in inp.get("edits", []) or []:
            all_added.extend(
                added_comments(edit.get("old_string", ""), edit.get("new_string", ""))
            )
        return path, sorted(set(all_added))

    return "", []


def format_message(path: str, items: list[tuple[int, str]]) -> str:
    out = [f"Blocked: new Python comments detected in {path}:"]
    for line_no, line in items:
        snippet = line.strip()
        if len(snippet) > 100:
            snippet = snippet[:97] + "..."
        out.append(f"  L{line_no}: {snippet}")
    out.append("")
    out.append(
        "Comments are noise — write expressive code. "
        "If you truly think a WHY-comment is justified, propose it to the user before writing it."
    )
    return "\n".join(out)


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        return 0

    path, items = collect_added_comments(payload)
    if not items:
        return 0

    sys.stderr.write(format_message(path, items) + "\n")
    return 2


if __name__ == "__main__":
    sys.exit(main())
