#!/bin/bash
# One entrypoint for the whole suite: TypeScript tests in extensions/ and
# engine/ (node --test), the vendored Python hook tests (pytest), and the tsc
# type gate. Args are forwarded verbatim to the two test runners; tsc always
# checks the whole project, since `tsc -p <cfg> <file>` is an error.
#
# Node: system node is too old for type stripping, so use the mise-managed
# node@22 from setup.sh. Concurrency pinned to 1: async tests with live timers
# (clarify suspend-path) interleave TAP output and keep the process from exiting
# cleanly under higher concurrency — serial execution is the deterministic surface.
# Python: `uv run --with pytest` injects pytest on demand, so no venv or pyproject
# is required. Full output is shown on failure only.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
TS_DIR="$ROOT/extensions/rails"
PY_DIR="$ROOT/extensions/rails/hooks"

args=("$@")
ts_args=("${args[@]}")
py_args=("${args[@]}")
[ ${#args[@]} -eq 0 ] && ts_args=("$TS_DIR"/*.test.ts "$ROOT/extensions/subagent"/*.test.ts "$ROOT/engine"/*.test.ts)
[ ${#args[@]} -eq 0 ] && py_args=("$PY_DIR")

status=0

echo "## TypeScript (node --test)"
ts_out=$(mise exec -- node --test --experimental-strip-types --test-concurrency=1 "${ts_args[@]}" 2>&1) || status=1
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

tsc_status=0
echo
echo "## Types (tsc)"
tsc_out=$(mise exec -- ./node_modules/.bin/tsc --noEmit -p "$ROOT/tsconfig.json" 2>&1) || tsc_status=1
if [ $tsc_status -eq 0 ]; then
  echo "✅ Types check clean"
else
  echo "$tsc_out"
  status=1
fi

exit "$status"
