#!/usr/bin/env python3
from __future__ import annotations

import ast
import io
import json
import re
import sys
import tokenize
from pathlib import Path


DECISION_NODES = (
    ast.If,
    ast.For,
    ast.AsyncFor,
    ast.While,
    ast.ExceptHandler,
    ast.IfExp,
    ast.match_case,
)
SCOPE_NODES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)

SELF_LIKE_NAMES = ("self", "cls")
RETURN_LABEL = "-> return"

ALLOW_PATTERN = re.compile(
    r"^#\s*(!|noqa|type:|ty:|pragma:|fmt:|pylint:|isort:|pyright:)", re.IGNORECASE
)


def is_allowed_comment(text: str) -> bool:
    return bool(ALLOW_PATTERN.match(text.lstrip()))


def _node_contribution(node: ast.AST) -> int:
    if isinstance(node, DECISION_NODES):
        return 1
    if isinstance(node, ast.BoolOp):
        return len(node.values) - 1
    if isinstance(node, ast.comprehension):
        return len(node.ifs)
    return 0


def cyclomatic_complexity(func_node: ast.AST) -> int:
    cc = 1

    def visit(node: ast.AST) -> None:
        nonlocal cc
        cc += _node_contribution(node)
        for child in ast.iter_child_nodes(node):
            if isinstance(child, SCOPE_NODES):
                continue
            visit(child)

    for child in ast.iter_child_nodes(func_node):
        if isinstance(child, SCOPE_NODES):
            continue
        visit(child)
    return cc


def _lizard_cc(after: str) -> dict[tuple[str, int], int]:
    try:
        import lizard
    except ImportError:
        sys.stderr.write("extract-python: lizard not installed; run `uv pip install lizard` in engine/\n")
        sys.exit(2)
    analyzer = lizard.FileAnalyzer(lizard.get_extensions([]))
    info = analyzer.analyze_source_code("<extract>", after)
    return {(fi.name.rsplit(".", 1)[-1], fi.start_line): fi.cyclomatic_complexity for fi in info.function_list}


def _missing_positional(args: ast.arguments) -> list[str]:
    positional = list(args.posonlyargs) + list(args.args)
    skip_first = bool(positional) and positional[0].arg in SELF_LIKE_NAMES
    missing: list[str] = []
    for index, arg in enumerate(positional):
        if skip_first and index == 0:
            continue
        if arg.annotation is None:
            missing.append(arg.arg)
    return missing


def missing_annotations(func: ast.FunctionDef | ast.AsyncFunctionDef) -> list[str]:
    args = func.args
    missing = _missing_positional(args)
    if args.vararg and args.vararg.annotation is None:
        missing.append(f"*{args.vararg.arg}")
    for arg in args.kwonlyargs:
        if arg.annotation is None:
            missing.append(arg.arg)
    if args.kwarg and args.kwarg.annotation is None:
        missing.append(f"**{args.kwarg.arg}")
    if func.returns is None:
        missing.append(RETURN_LABEL)
    return missing


def is_test_path(path: str) -> bool:
    p = Path(path)
    name = p.name
    if not name.endswith(".py"):
        return False
    if name == "conftest.py":
        return True
    if name.startswith("test_") or name.endswith("_test.py"):
        return True
    return "tests" in p.parts


def _region(lines: list[str], start_line: int, end_line: int) -> str:
    return "\n".join(lines[start_line - 1:end_line])


def _function_regions(text: str) -> dict[str, tuple[str, str]]:
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return {}
    lines = text.split("\n")
    results: dict[str, tuple[str, str]] = {}
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.body:
            first_body = node.body[0]
            end = node.end_lineno or first_body.lineno
            sig = _region(lines, node.lineno, first_body.lineno - 1)
            body = _region(lines, first_body.lineno, end)
            results[node.name] = (sig, body)
    return results


def _function_facts(tree: ast.AST, lines: list[str], path: str, before_funcs: dict[str, tuple[str, str]], lizard_map: dict[tuple[str, int], int]) -> list[dict]:
    facts: dict[str, dict] = {}
    test_file = is_test_path(path)
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if not node.body:
            continue
        first_body = node.body[0]
        end = node.end_lineno or first_body.lineno
        sig_after = _region(lines, node.lineno, first_body.lineno - 1)
        body_after = _region(lines, first_body.lineno, end)
        previous = before_funcs.get(node.name)
        if previous is None:
            signature = "new"
            body = "new"
        else:
            sig_before, body_before = previous
            signature = "same" if sig_after == sig_before else "changed"
            body = "same" if body_after == body_before else "changed"
        facts[node.name] = {
            "name": node.name,
            "startLine": node.lineno,
            "cyclomaticComplexity": cyclomatic_complexity(node),
            "missingAnnotations": missing_annotations(node),
            "isTest": node.name.startswith("test_") and test_file,
            "bodyLineCount": end - first_body.lineno + 1,
            "signature": signature,
            "body": body,
        }
        lizard_cc = lizard_map.get((node.name, node.lineno))
        if lizard_cc is not None:
            facts[node.name]["cyclomaticComplexity"] = lizard_cc
    return list(facts.values())


def _comment_text(stripped: str, line: str) -> str | None:
    if stripped.startswith("#"):
        return stripped
    m = re.search(r"\s+#", line)
    if m:
        return "#" + line[m.start() + 1:].strip()
    return None


def _tokenized_comment_kinds(text: str, lines: list[str]) -> dict[int, str]:
    found: dict[int, str] = {}
    for tok in tokenize.generate_tokens(io.StringIO(text).readline):
        if tok.type == tokenize.COMMENT:
            kind = "tooling" if is_allowed_comment(tok.string) else "line"
            found[tok.start[0]] = kind
        elif tok.type == tokenize.STRING and tok.string.lstrip().startswith(('"""', "'''")):
            for ln in range(tok.start[0], tok.end[0] + 1):
                found[ln] = "doc"
    return found


def _manual_comment_kinds(lines: list[str]) -> dict[int, str]:
    found: dict[int, str] = {}
    in_triple = False
    triple_quote = ""
    for i, line in enumerate(lines, start=1):
        if in_triple:
            found[i] = "doc"
            if triple_quote in line:
                in_triple = False
            continue

        triple_match = re.search(r'("""|\'\'\')', line)
        if triple_match:
            found[i] = "doc"
            if triple_match.group(1) not in line[triple_match.end():]:
                in_triple = True
                triple_quote = triple_match.group(1)
            continue

        comment = _comment_text(line.strip(), line)
        if comment is not None:
            found[i] = "tooling" if is_allowed_comment(comment) else "line"
    return found


def find_comment_kinds(text: str) -> dict[int, str]:
    lines = text.split("\n")
    try:
        return _tokenized_comment_kinds(text, lines)
    except (tokenize.TokenError, IndentationError, SyntaxError):
        return _manual_comment_kinds(lines)


def _comment_facts(after: str, before: str | None) -> list[dict]:
    after_lines = after.split("\n")
    before_lines = set((before or "").split("\n"))
    kinds = find_comment_kinds(after)
    facts: list[dict] = []
    for line_no in sorted(kinds):
        kind = kinds[line_no]
        if kind == "tooling":
            mapped = "tooling"
        elif kind == "doc":
            mapped = "doc"
        else:
            mapped = "line"
        text = after_lines[line_no - 1]
        facts.append({
            "line": line_no,
            "text": text,
            "kind": mapped,
            "added": text not in before_lines,
        })
    return facts


def _functions(after: str, before: str | None, path: str) -> list[dict]:
    before_funcs = _function_regions(before) if before else {}
    try:
        tree = ast.parse(after)
    except SyntaxError:
        return []
    lines = after.split("\n")
    lizard_map = _lizard_cc(after)
    return _function_facts(tree, lines, path, before_funcs, lizard_map)


def extract(path: str, before: str | None, after: str) -> dict:
    return {
        "functions": _functions(after, before, path),
        "comments": _comment_facts(after, before),
    }


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        sys.stderr.write(f"extract-python: invalid JSON input: {exc}\n")
        return 1

    path = payload.get("path", "")
    before = payload.get("before")
    after = payload.get("after", "")

    try:
        result = extract(path, before, after)
    except Exception as exc:
        sys.stderr.write(f"extract-python: internal failure: {exc}\n")
        return 1

    json.dump(result, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
