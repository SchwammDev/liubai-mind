from __future__ import annotations

import importlib.util
import io
import json
from pathlib import Path


HOOK_PATH = Path(__file__).parent / "long_test_nudge.py"


def _load_hook():
    spec = importlib.util.spec_from_file_location("long_test_nudge", HOOK_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


hook = _load_hook()


def _long_test(name: str, body_lines: int = 12) -> str:
    body = "\n".join(f"    x_{i} = {i}" for i in range(body_lines))
    return f"def {name}():\n{body}\n"


def _short_test(name: str, body_lines: int = 3) -> str:
    body = "\n".join(f"    x_{i} = {i}" for i in range(body_lines))
    return f"def {name}():\n{body}\n"


def _payload(tool: str, **tool_input) -> dict:
    return {"tool_name": tool, "tool_input": tool_input}


def _edit_payload(file_path, old_string, new_string) -> dict:
    return _payload("Edit", file_path=str(file_path), old_string=old_string, new_string=new_string)


def _multiedit_payload(file_path, *replacements) -> dict:
    return _payload(
        "MultiEdit",
        file_path=str(file_path),
        edits=[{"old_string": o, "new_string": n} for o, n in replacements],
    )


def _file_with_long_test(tmp_path, name: str = "test_foo.py", body_lines: int = 12) -> Path:
    path = tmp_path / name
    path.write_text(_long_test("test_long", body_lines))
    return path


def _run_main(payload, monkeypatch, capsys) -> tuple[int, str]:
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(payload)))
    rc = hook.main()
    return rc, capsys.readouterr().out


def assert_flagged_names(flagged, expected) -> None:
    assert sorted(name for name, _ in flagged) == sorted(expected)


def test_long_test_unchanged_by_edit_above_is_not_flagged():
    long_test = _long_test("test_long", 12)
    new = "def helper():\n    pass\n\n\n" + long_test

    flagged = hook.long_touched_tests(long_test, new)

    assert flagged == []


def test_long_test_with_modified_body_is_flagged():
    old = _long_test("test_long", 12)
    new = old.replace("x_0 = 0", "x_0 = 99")

    flagged = hook.long_touched_tests(old, new)

    assert_flagged_names(flagged, ["test_long"])


def test_newly_added_long_test_is_flagged():
    old = _short_test("test_existing", 2)
    new = old + "\n\n" + _long_test("test_new_long", 12)

    flagged = hook.long_touched_tests(old, new)

    assert_flagged_names(flagged, ["test_new_long"])


def test_short_tests_are_never_flagged():
    old = _short_test("test_a", 2)
    new = _short_test("test_a", 5)

    flagged = hook.long_touched_tests(old, new)

    assert flagged == []


def test_renamed_long_test_is_flagged():
    old = _long_test("test_old_name", 12)
    new = old.replace("test_old_name", "test_new_name")

    flagged = hook.long_touched_tests(old, new)

    assert_flagged_names(flagged, ["test_new_name"])


def test_write_to_brand_new_file_flags_every_long_test():
    new = _long_test("test_a", 12) + "\n\n" + _long_test("test_b", 12)

    flagged = hook.long_touched_tests("", new)

    assert_flagged_names(flagged, ["test_a", "test_b"])


def test_neighbouring_long_test_is_silent_when_only_other_long_test_edited():
    long_a = _long_test("test_a", 12)
    long_b = _long_test("test_b", 12)
    old = long_a + "\n\n" + long_b
    new = long_a.replace("x_0 = 0", "x_0 = 999") + "\n\n" + long_b

    flagged = hook.long_touched_tests(old, new)

    assert_flagged_names(flagged, ["test_a"])


def test_formatting_only_change_inside_long_test_is_flagged():
    old = _long_test("test_long", 12)
    new = old.replace("    x_0 = 0", "    x_0 = 0  ")

    flagged = hook.long_touched_tests(old, new)

    assert_flagged_names(flagged, ["test_long"])


def test_syntax_error_in_new_text_is_silent():
    flagged = hook.long_touched_tests(_long_test("test_long", 12), "def broken(:")

    assert flagged == []


def test_edit_states_for_write_returns_empty_old_for_brand_new_file(tmp_path):
    payload = _payload("Write", file_path=str(tmp_path / "test_new.py"), content=_long_test("test_x", 12))

    path, old, new = hook.edit_states(payload)

    assert old == ""
    assert "test_x" in new


def test_edit_states_for_edit_replaces_old_string_in_existing_file(tmp_path):
    file_path = _file_with_long_test(tmp_path)
    payload = _edit_payload(file_path, "x_0 = 0", "x_0 = 99")

    path, old, new = hook.edit_states(payload)

    assert "x_0 = 0" in old
    assert "x_0 = 99" in new


def test_edit_states_for_multiedit_applies_each_edit_in_sequence(tmp_path):
    file_path = _file_with_long_test(tmp_path)
    payload = _multiedit_payload(file_path, ("x_0 = 0", "x_0 = 99"), ("x_1 = 1", "x_1 = 88"))

    path, old, new = hook.edit_states(payload)

    assert "x_0 = 99" in new
    assert "x_1 = 88" in new


def test_main_is_silent_when_edit_does_not_touch_a_long_test(tmp_path, monkeypatch, capsys):
    file_path = _file_with_long_test(tmp_path)
    payload = _edit_payload(file_path, "nonexistent", "still nonexistent")

    rc, out = _run_main(payload, monkeypatch, capsys)

    assert rc == 0
    assert out == ""


def test_main_emits_nudge_naming_the_touched_long_test(tmp_path, monkeypatch, capsys):
    file_path = _file_with_long_test(tmp_path)
    payload = _edit_payload(file_path, "x_0 = 0", "x_0 = 99")

    rc, out = _run_main(payload, monkeypatch, capsys)

    assert rc == 0
    assert "test_long" in json.loads(out)["hookSpecificOutput"]["additionalContext"]


def test_main_ignores_edits_to_non_test_files(tmp_path, monkeypatch, capsys):
    file_path = _file_with_long_test(tmp_path, name="module.py")
    payload = _edit_payload(file_path, "x_0 = 0", "x_0 = 99")

    rc, out = _run_main(payload, monkeypatch, capsys)

    assert rc == 0
    assert out == ""



def test_helper_inventory_returns_empty_when_tests_root_is_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(hook, "TESTS_ROOT", tmp_path / "does_not_exist")

    assert hook.helper_inventory() == []


def test_helper_inventory_dedupes_names_and_skips_bare_underscore(tmp_path, monkeypatch):
    tests = tmp_path / "tests"
    tests.mkdir()
    (tests / "a_test.py").write_text(
        "def _helper_a():\n    pass\n"
        "def _helper_a():\n    pass\n"
        "def assert_eq():\n    pass\n"
        "def _():\n    pass\n"
    )
    monkeypatch.setattr(hook, "TESTS_ROOT", tests)

    names = hook.helper_inventory()

    assert names.count("_helper_a") == 1
    assert "_" not in names
    assert "assert_eq" in names


def test_helper_inventory_caps_the_number_of_helpers_returned(tmp_path, monkeypatch):
    tests = tmp_path / "tests"
    tests.mkdir()
    extra = "\n".join(f"def _h{i}():\n    pass\n" for i in range(hook.HELPER_INVENTORY_LIMIT + 2))
    (tests / "b_test.py").write_text(extra)
    monkeypatch.setattr(hook, "TESTS_ROOT", tests)

    assert len(hook.helper_inventory()) == hook.HELPER_INVENTORY_LIMIT


def test_helper_inventory_returns_empty_when_grep_times_out(tmp_path, monkeypatch):
    tests = tmp_path / "tests"
    tests.mkdir()
    monkeypatch.setattr(hook, "TESTS_ROOT", tests)

    def _raise(*_args, **_kwargs):
        raise hook.subprocess.TimeoutExpired(cmd="grep", timeout=5)

    monkeypatch.setattr(hook.subprocess, "run", _raise)

    assert hook.helper_inventory() == []
