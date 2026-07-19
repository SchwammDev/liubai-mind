from __future__ import annotations

import importlib.util
from pathlib import Path


HOOK_PATH = Path(__file__).parent / "no_added_comments.py"


def _load_hook():
    spec = importlib.util.spec_from_file_location("no_added_comments", HOOK_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


hook = _load_hook()


def assert_allowed(comment: str) -> None:
    assert hook.is_allowed_comment(comment), f"expected linter directive to be allowed: {comment!r}"


def assert_not_allowed(comment: str) -> None:
    assert not hook.is_allowed_comment(comment), f"expected plain comment to be blocked: {comment!r}"


def test_shebang_is_allowed():
    assert_allowed("#!/usr/bin/env python3")


def test_flake8_ruff_noqa_is_allowed():
    assert_allowed("# noqa: F401")


def test_mypy_type_ignore_is_allowed():
    assert_allowed("# type: ignore")


def test_coverage_pragma_is_allowed():
    assert_allowed("# pragma: no cover")


def test_formatter_directive_is_allowed():
    assert_allowed("# fmt: off")


def test_pylint_disable_is_allowed():
    assert_allowed("# pylint: disable=unused-import")


def test_isort_skip_is_allowed():
    assert_allowed("# isort: skip")


def test_pyright_ignore_is_allowed():
    assert_allowed("# pyright: ignore[reportUnusedImport]")


def test_ty_ignore_is_allowed():
    assert_allowed("# ty: ignore[unused-import]")


def test_directive_match_is_case_insensitive():
    assert_allowed("# NOQA: F401")


def test_plain_prose_comment_is_blocked():
    assert_not_allowed("# this explains the loop")


def test_directive_word_inside_prose_is_blocked():
    assert_not_allowed("# remember to add a noqa here later")


def test_block_message_names_docstrings_so_agents_dont_keep_them() -> None:
    message = hook.format_message("src/x.py", [(2, '    """move it"""')])

    assert "docstring" in message.lower()


def test_block_message_points_to_allowed_tooling_directives() -> None:
    message = hook.format_message("src/x.py", [(2, "# explain")])

    assert "ty:" in message
    assert "allowed" in message.lower()


def test_find_comment_lines_flags_a_plain_comment() -> None:
    found = hook.find_comment_lines("x = 1\n# noise\n")

    assert 2 in found and "# noise" in found[2]


def test_find_comment_lines_allows_tooling_directive_comment() -> None:
    found = hook.find_comment_lines("x = 1\n# type: ignore\n")

    assert 2 not in found


def test_find_comment_lines_flags_a_docstring() -> None:
    found = hook.find_comment_lines('def f():\n    """doc"""\n    pass\n')

    assert 2 in found


def test_manual_scan_flags_a_comment_in_unparseable_code() -> None:
    broken = 'def f(:\n    # noise\n    pass\n'

    found = hook.find_comment_lines(broken)

    assert any("# noise" in line for line in found.values())


def test_manual_scan_flags_a_trailing_comment_in_unparseable_code() -> None:
    broken = 'def f(:\n    x = 1  # noise\n'

    found = hook.find_comment_lines(broken)

    assert any("# noise" in line for line in found.values())


def test_manual_scan_flags_lines_inside_an_open_triple_quoted_string() -> None:
    broken = 'def f(:\n    """opened\n    still inside\n'

    found = hook.find_comment_lines(broken)

    assert {2, 3} <= set(found)


def test_manual_scan_allows_a_directive_comment_in_unparseable_code() -> None:
    broken = 'def f(:\n    # type: ignore\n'

    found = hook.find_comment_lines(broken)

    assert 2 not in found


def _payload(tool: str, **tool_input) -> dict:
    return {"tool_name": tool, "tool_input": tool_input}


def test_collect_added_comments_returns_empty_for_non_python_write() -> None:
    path, items = hook.collect_added_comments(_payload("Write", file_path="notes.md", content="# noise\n"))

    assert (path, items) == ("notes.md", [])


def test_collect_added_comments_for_write_reads_existing_file(tmp_path) -> None:
    path = tmp_path / "svc.py"
    path.write_text("x = 1\n")
    _, items = hook.collect_added_comments(_payload("Write", file_path=str(path), content="x = 1\n# noise\n"))

    assert items and "# noise" in items[0][1]


def test_collect_added_comments_for_edit_detects_new_comment(tmp_path) -> None:
    path = tmp_path / "svc.py"
    payload = _payload("Edit", file_path=str(path), old_string="x = 1", new_string="x = 1  # noise")

    _, items = hook.collect_added_comments(payload)

    assert items and "# noise" in items[0][1]


def test_collect_added_comments_returns_empty_for_non_python_edit() -> None:
    payload = _payload("Edit", file_path="notes.md", old_string="x", new_string="x  # noise")

    _, items = hook.collect_added_comments(payload)

    assert items == []


def test_collect_added_comments_returns_empty_for_non_python_multiedit() -> None:
    payload = _payload("MultiEdit", file_path="notes.md", edits=[{"old_string": "x", "new_string": "x  # noise"}])

    _, items = hook.collect_added_comments(payload)

    assert items == []


def test_collect_added_comments_for_multiedit_merges_across_edits() -> None:
    edits = [
        {"old_string": "a = 1", "new_string": "a = 1  # one"},
        {"old_string": "b = 2", "new_string": "b = 2  # two"},
    ]
    payload = _payload("MultiEdit", file_path="svc.py", edits=edits)

    _, items = hook.collect_added_comments(payload)

    assert {line.split("#")[-1].strip() for _, line in items} == {"one", "two"}


def test_collect_added_comments_returns_empty_for_unknown_tool() -> None:
    path, items = hook.collect_added_comments(_payload("Read", file_path="svc.py"))

    assert (path, items) == ("", [])
