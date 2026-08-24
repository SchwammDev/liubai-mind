#!/usr/bin/env python3
from __future__ import annotations

import ast
import json
import sys

SILENT_TYPE_NAMES = ("Exception", "BaseException")


def _handler_type_names(handler: ast.ExceptHandler) -> list[str]:
    if handler.type is None:
        return []
    if isinstance(handler.type, ast.Tuple):
        return [elt.id for elt in handler.type.elts if isinstance(elt, ast.Name)]
    if isinstance(handler.type, ast.Name):
        return [handler.type.id]
    return []


def is_broad_handler(handler: ast.ExceptHandler) -> bool:
    names = _handler_type_names(handler)
    if handler.type is None:
        return True
    return any(name in SILENT_TYPE_NAMES for name in names)


def is_silent_body(body: list[ast.stmt]) -> bool:
    for stmt in ast.walk(ast.Module(body=body, type_ignores=[])):
        if isinstance(stmt, (ast.Raise, ast.Call)):
            return False
    return True


def count_silent_handlers(source: str) -> int:
    tree = ast.parse(source)
    count = 0
    for node in ast.walk(tree):
        if not isinstance(node, ast.ExceptHandler):
            continue
        if not is_broad_handler(node):
            continue
        if is_silent_body(node.body):
            count += 1
    return count


def main() -> int:
    source = sys.stdin.read()
    count = count_silent_handlers(source)
    json.dump({"count": count}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
