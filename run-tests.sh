#!/bin/bash
# One entrypoint for the whole suite: TypeScript extension tests (node --test)
# and the vendored Python hook tests (pytest). Forwards args verbatim to each.
#
# Node: system node is too old for type stripping, so use the mise-managed
# node@22 from setup.sh. Python: `uv run --with pytest` injects pytest on demand,
# so no venv or pyproject is required. Full output is shown on failure only.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
TS_DIR="$ROOT/.pi/extensions/rails"
PY_DIR="$ROOT/.pi/extensions/rails/hooks"

args=("$@")
ts_args=("${args[@]}")
py_args=("${args[@]}")
[ ${#args[@]} -eq 0 ] && ts_args=("$TS_DIR"/*.test.ts)
[ ${#args[@]} -eq 0 ] && py_args=("$PY_DIR")

status=0

echo "## TypeScript (node --test)"
ts_out=$(mise exec -- node --test --experimental-strip-types "${ts_args[@]}" 2>&1) || status=1
if [ $status -eq 0 ]; then
  echo "✅ TypeScript tests passed"
else
  echo "$ts_out"
fi

py_status=0
echo
echo "## Python (pytest)"
py_out=$(uv run --with pytest pytest "${py_args[@]}" 2>&1) || py_status=1
if [ $py_status -eq 0 ]; then
  echo "✅ Python tests passed"
else
  echo "$py_out"
  status=1
fi

exit "$status"
