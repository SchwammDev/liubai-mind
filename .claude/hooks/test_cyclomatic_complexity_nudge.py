from __future__ import annotations

import importlib.util
import io
import json
from pathlib import Path


HOOK_PATH = Path(__file__).parent / "cyclomatic_complexity_nudge.py"


def _load_hook():
    spec = importlib.util.spec_from_file_location("cyclomatic_complexity_nudge", HOOK_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


hook = _load_hook()


def _simple(name: str = "f") -> str:
    return f"def {name}():\n    return 1\n"


def _with_branches(name: str, n: int) -> str:
    if n == 0:
        return _simple(name)
    body = "\n".join(f"    if x == {i}:\n        return {i}" for i in range(n))
    return f"def {name}(x):\n{body}\n"


def _cc(text: str, name: str) -> int:
    return hook.function_complexities(text)[name][1]


def _payload(tool: str, **tool_input) -> dict:
    return {"tool_name": tool, "tool_input": tool_input}


def _edit_payload(file_path, old_string, new_string) -> dict:
    return _payload("Edit", file_path=str(file_path), old_string=old_string, new_string=new_string)


def _run_main(payload, monkeypatch, capsys) -> tuple[int, str]:
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(payload)))
    rc = hook.main()
    return rc, capsys.readouterr().out


def assert_flagged_names(flagged, expected) -> None:
    assert sorted(name for name, _ in flagged) == sorted(expected)


def test_straight_line_function_has_complexity_one():
    assert _cc(_simple("f"), "f") == 1


def test_each_if_branch_adds_one_to_complexity():
    assert _cc(_with_branches("f", 3), "f") == 4


def test_and_operator_adds_one_per_extra_operand():
    text = "def f(x):\n    return x and x and x\n"

    assert _cc(text, "f") == 3


def test_or_operator_adds_one_per_extra_operand():
    text = "def f(x):\n    return x or x or x or x\n"

    assert _cc(text, "f") == 4


def test_for_loop_adds_one_to_complexity():
    text = "def f(xs):\n    for x in xs:\n        pass\n"

    assert _cc(text, "f") == 2


def test_while_loop_adds_one_to_complexity():
    text = "def f(x):\n    while x:\n        x -= 1\n"

    assert _cc(text, "f") == 2


def test_each_except_handler_adds_one_to_complexity():
    text = (
        "def f():\n"
        "    try:\n"
        "        pass\n"
        "    except KeyError:\n"
        "        pass\n"
        "    except ValueError:\n"
        "        pass\n"
    )

    assert _cc(text, "f") == 3


def test_ternary_adds_one_to_complexity():
    text = "def f(x):\n    return 1 if x else 0\n"

    assert _cc(text, "f") == 2


def test_comprehension_if_clause_adds_one_to_complexity():
    text = "def f(xs):\n    return [x for x in xs if x > 0]\n"

    assert _cc(text, "f") == 2


def test_match_statement_adds_one_per_case():
    text = (
        "def f(x):\n"
        "    match x:\n"
        "        case 1:\n"
        "            return 'one'\n"
        "        case 2:\n"
        "            return 'two'\n"
        "        case _:\n"
        "            return 'other'\n"
    )

    assert _cc(text, "f") == 4


def test_nested_function_complexity_does_not_count_toward_outer():
    text = (
        "def outer():\n"
        "    def inner(x):\n"
        "        if x:\n"
        "            if x > 1:\n"
        "                return 1\n"
        "    return inner\n"
    )

    assert _cc(text, "outer") == 1


def test_complexity_at_threshold_is_not_flagged():
    text = _with_branches("f", 7)

    flagged = hook.complex_touched_functions("", text)

    assert flagged == []


def test_complexity_above_threshold_is_flagged():
    text = _with_branches("f", 8)

    flagged = hook.complex_touched_functions("", text)

    assert_flagged_names(flagged, ["f"])


def test_unchanged_complex_function_is_not_flagged_when_neighbour_added():
    complex_text = _with_branches("f", 10)
    new = complex_text + "\n\n" + _simple("g")

    flagged = hook.complex_touched_functions(complex_text, new)

    assert flagged == []


def test_modified_complex_function_is_flagged():
    old = _with_branches("f", 10)
    new = old.replace("return 0", "return 99")

    flagged = hook.complex_touched_functions(old, new)

    assert_flagged_names(flagged, ["f"])


def test_newly_added_complex_function_is_flagged():
    old = _simple("g")
    new = old + "\n\n" + _with_branches("f", 10)

    flagged = hook.complex_touched_functions(old, new)

    assert_flagged_names(flagged, ["f"])


def test_syntax_error_in_new_text_is_silent():
    flagged = hook.complex_touched_functions(_with_branches("f", 10), "def broken(:")

    assert flagged == []


def test_path_inside_migrations_is_skipped():
    assert hook.is_skipped_path("app/migrations/0001_init.py")


def test_path_inside_playground_is_skipped():
    assert hook.is_skipped_path("playground/scratch.py")


def test_protobuf_generated_paths_are_skipped():
    assert hook.is_skipped_path("api/foo_pb2.py")
    assert hook.is_skipped_path("api/foo_pb2_grpc.py")


def test_non_python_path_is_skipped():
    assert hook.is_skipped_path("README.md")


def test_regular_python_path_is_not_skipped():
    assert not hook.is_skipped_path("app/services/billing.py")


def test_test_path_is_not_skipped():
    assert not hook.is_skipped_path("tests/test_billing.py")


def test_generated_marker_in_header_is_detected():
    assert hook.is_generated_content("# @generated\ndef f():\n    pass\n")
    assert hook.is_generated_content("# Generated by protoc\ndef f():\n    pass\n")
    assert hook.is_generated_content("# DO NOT EDIT\ndef f():\n    pass\n")


def test_plain_header_is_not_generated():
    assert not hook.is_generated_content("def f():\n    pass\n")


def test_main_emits_nudge_naming_complex_function(tmp_path, monkeypatch, capsys):
    path = tmp_path / "service.py"
    path.write_text(_with_branches("f", 10))
    payload = _edit_payload(path, "return 0", "return 99")

    rc, out = _run_main(payload, monkeypatch, capsys)

    assert rc == 0
    assert "f" in json.loads(out)["hookSpecificOutput"]["additionalContext"]


def test_main_is_silent_when_complex_function_untouched(tmp_path, monkeypatch, capsys):
    path = tmp_path / "service.py"
    path.write_text(_with_branches("f", 10) + "\n\n" + _simple("g"))
    payload = _edit_payload(path, "def g():\n    return 1\n", "def g():\n    return 99\n")

    rc, out = _run_main(payload, monkeypatch, capsys)

    assert rc == 0
    assert out == ""


def test_main_is_silent_for_generated_file(tmp_path, monkeypatch, capsys):
    path = tmp_path / "client.py"
    path.write_text("# @generated by openapi-codegen\n" + _with_branches("f", 10))
    payload = _edit_payload(path, "return 0", "return 99")

    rc, out = _run_main(payload, monkeypatch, capsys)

    assert rc == 0
    assert out == ""


def test_main_is_silent_for_path_in_playground(tmp_path, monkeypatch, capsys):
    path = tmp_path / "playground" / "scratch.py"
    path.parent.mkdir()
    path.write_text(_with_branches("f", 10))
    payload = _edit_payload(path, "return 0", "return 99")

    rc, out = _run_main(payload, monkeypatch, capsys)

    assert rc == 0
    assert out == ""
