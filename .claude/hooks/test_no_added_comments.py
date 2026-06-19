from __future__ import annotations

import importlib.util
from pathlib import Path


HOOK_PATH = Path(__file__).parent / "no_added_comments.py"


def _load_hook():
    spec = importlib.util.spec_from_file_location("no_added_comments", HOOK_PATH)
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
