from __future__ import annotations

import importlib.util
import io
import json
from pathlib import Path


HOOK_PATH = Path(__file__).parent / "type_annotation_nudge.py"


def _load_hook():
    spec = importlib.util.spec_from_file_location("type_annotation_nudge", HOOK_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


hook = _load_hook()


def _missing(text: str, name: str = "f") -> list[str]:
    return hook.function_signatures(text)[name][1]


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


def test_fully_annotated_function_has_no_missing_annotations():
    text = "def f(x: int, y: int) -> int:\n    return x + y\n"

    assert _missing(text) == []


def test_missing_return_annotation_is_reported():
    text = "def f(x: int):\n    return x\n"

    assert _missing(text) == ["-> return"]


def test_missing_parameter_annotation_is_reported():
    text = "def f(x) -> int:\n    return x\n"

    assert _missing(text) == ["x"]


def test_function_without_any_annotations_reports_each_param_and_return():
    text = "def f(x, y):\n    return x + y\n"

    assert _missing(text) == ["x", "y", "-> return"]


def test_self_on_method_is_not_required_to_be_annotated():
    text = (
        "class C:\n"
        "    def f(self, x: int) -> int:\n"
        "        return x\n"
    )

    assert _missing(text) == []


def test_cls_on_classmethod_is_not_required_to_be_annotated():
    text = (
        "class C:\n"
        "    @classmethod\n"
        "    def f(cls, x: int) -> int:\n"
        "        return x\n"
    )

    assert _missing(text) == []


def test_vararg_without_annotation_is_reported():
    text = "def f(*args) -> int:\n    return 0\n"

    assert _missing(text) == ["*args"]


def test_kwarg_without_annotation_is_reported():
    text = "def f(**kwargs) -> int:\n    return 0\n"

    assert _missing(text) == ["**kwargs"]


def test_keyword_only_arg_without_annotation_is_reported():
    text = "def f(*, x) -> int:\n    return x\n"

    assert _missing(text) == ["x"]


def test_async_function_missing_return_annotation_is_reported():
    text = "async def f(x: int):\n    return x\n"

    assert _missing(text) == ["-> return"]


def test_unchanged_unannotated_function_is_not_flagged_when_neighbour_added():
    unannotated = "def f(x):\n    return x\n"
    new = unannotated + "\n\n" + "def g(x: int) -> int:\n    return x\n"

    flagged = hook.touched_unannotated(unannotated, new)

    assert flagged == []


def test_newly_added_unannotated_function_is_flagged():
    old = "def g(x: int) -> int:\n    return x\n"
    new = old + "\n\n" + "def f(x):\n    return x\n"

    flagged = hook.touched_unannotated(old, new)

    assert_flagged_names(flagged, ["f"])


def test_body_edit_in_unannotated_function_re_flags_it():
    old = "def f(x):\n    return x\n"
    new = "def f(x):\n    return x + 1\n"

    flagged = hook.touched_unannotated(old, new)

    assert_flagged_names(flagged, ["f"])


def test_body_edit_in_fully_annotated_function_is_silent():
    old = "def f(x: int) -> int:\n    return x\n"
    new = "def f(x: int) -> int:\n    return x + 1\n"

    flagged = hook.touched_unannotated(old, new)

    assert flagged == []


def test_signature_change_adding_unannotated_param_is_flagged():
    old = "def f(x: int) -> int:\n    return x\n"
    new = "def f(x: int, y) -> int:\n    return x + y\n"

    flagged = hook.touched_unannotated(old, new)

    assert_flagged_names(flagged, ["f"])


def test_syntax_error_in_new_text_is_silent():
    flagged = hook.touched_unannotated("def f(x):\n    return x\n", "def broken(:")

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


def test_test_file_path_is_not_skipped():
    assert not hook.is_skipped_path("tests/test_billing.py")
    assert not hook.is_skipped_path("app/foo_test.py")


def test_conftest_path_is_not_skipped():
    assert not hook.is_skipped_path("tests/conftest.py")


def test_tests_directory_path_is_not_skipped():
    assert not hook.is_skipped_path("tests/support/factories.py")


def test_regular_python_path_is_not_skipped():
    assert not hook.is_skipped_path("app/services/billing.py")


def test_generated_marker_in_header_is_detected():
    assert hook.is_generated_content("# @generated\ndef f():\n    pass\n")
    assert hook.is_generated_content("# Generated by protoc\ndef f():\n    pass\n")
    assert hook.is_generated_content("# DO NOT EDIT\ndef f():\n    pass\n")


def test_plain_header_is_not_generated():
    assert not hook.is_generated_content("def f():\n    pass\n")


def test_main_emits_nudge_naming_unannotated_function(tmp_path, monkeypatch, capsys):
    path = tmp_path / "service.py"
    path.write_text("def f(x):\n    return x\n")
    payload = _edit_payload(path, "return x\n", "return x + 1\n")

    rc, out = _run_main(payload, monkeypatch, capsys)

    assert rc == 0
    assert "f" in json.loads(out)["hookSpecificOutput"]["additionalContext"]


def test_main_is_silent_when_function_is_fully_annotated(tmp_path, monkeypatch, capsys):
    path = tmp_path / "service.py"
    path.write_text("def f(x: int) -> int:\n    return x\n")
    payload = _edit_payload(path, "return x\n", "return x + 1\n")

    rc, out = _run_main(payload, monkeypatch, capsys)

    assert rc == 0
    assert out == ""


def test_main_emits_nudge_for_unannotated_function_in_test_file(tmp_path, monkeypatch, capsys):
    path = tmp_path / "test_service.py"
    path.write_text("def f(x):\n    return x\n")
    payload = _edit_payload(path, "return x\n", "return x + 1\n")

    rc, out = _run_main(payload, monkeypatch, capsys)

    assert rc == 0
    assert "f" in json.loads(out)["hookSpecificOutput"]["additionalContext"]


def test_main_is_silent_for_generated_file(tmp_path, monkeypatch, capsys):
    path = tmp_path / "client.py"
    path.write_text("# @generated by openapi-codegen\ndef f(x):\n    return x\n")
    payload = _edit_payload(path, "return x\n", "return x + 1\n")

    rc, out = _run_main(payload, monkeypatch, capsys)

    assert rc == 0
    assert out == ""


def _multiedit_payload(file_path, *replacements) -> dict:
    return _payload(
        "MultiEdit",
        file_path=str(file_path),
        edits=[{"old_string": o, "new_string": n} for o, n in replacements],
    )


def test_edit_states_for_write_returns_empty_old_for_brand_new_file(tmp_path):
    payload = _payload("Write", file_path=str(tmp_path / "new.py"), content="def f(x):\n    return x\n")

    path, old, new = hook.edit_states(payload)

    assert old == ""
    assert "def f" in new


def test_edit_states_for_edit_replaces_old_string_in_existing_file(tmp_path):
    path = tmp_path / "service.py"
    path.write_text("def f(x):\n    return x\n")
    payload = _edit_payload(path, "return x\n", "return x + 1\n")

    _, old, new = hook.edit_states(payload)

    assert "return x\n" in old
    assert "return x + 1\n" in new


def test_edit_states_for_multiedit_applies_each_edit_in_sequence(tmp_path):
    path = tmp_path / "service.py"
    path.write_text("def f(x):\n    return x\n")
    payload = _multiedit_payload(path, ("return x\n", "return 1\n"), ("return 1\n", "return 2\n"))

    _, _, new = hook.edit_states(payload)

    assert "return 2\n" in new


def test_edit_states_for_unknown_tool_returns_empty_strings():
    path, old, new = hook.edit_states(_payload("Read", file_path="x.py"))

    assert (path, old, new) == ("", "", "")
