#!/usr/bin/env python3
from __future__ import annotations

import ast
import json
import sys


def main() -> int:
    source = sys.stdin.read()
    try:
        ast.parse(source)
        parsed = True
    except SyntaxError:
        parsed = False
    json.dump({"parsed": parsed}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
