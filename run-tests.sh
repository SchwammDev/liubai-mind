#!/bin/bash
# One entrypoint for the whole suite: TypeScript tests in extensions/ and
# engine/ (node --test) and the tsc type gate. Args are forwarded verbatim to
# the one test runner; tsc always checks the whole project, since `tsc -p <cfg> <file>` is an error.
#
# Node: system node is too old for type stripping, so use the mise-managed
# node@22 from setup.sh. Concurrency pinned to 1: async tests with live timers
# (clarify suspend-path) interleave TAP output and keep the process from exiting
# cleanly under higher concurrency — serial execution is the deterministic surface.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
TS_DIR="$ROOT/extensions/rails"

args=("$@")
ts_args=("${args[@]}")
[ ${#args[@]} -eq 0 ] && ts_args=("$TS_DIR"/*.test.ts "$ROOT/extensions/subagent"/*.test.ts "$ROOT/engine"/*.test.ts)

status=0

echo "## TypeScript (node --test)"
ts_out=$(mise exec -- node --test --experimental-strip-types --test-concurrency=1 "${ts_args[@]}" 2>&1) || status=1
if [ $status -eq 0 ]; then
  echo "✅ TypeScript tests passed"
else
  echo "$ts_out"
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
