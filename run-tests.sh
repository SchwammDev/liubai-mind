#!/bin/bash
# Runs the TypeScript pi-extension tests on node@22 (system node is too old for type
# stripping). Uses the mise-managed node from setup.sh. Forwards args verbatim;
# defaults to every extension test.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

args=("$@")
[ ${#args[@]} -eq 0 ] && args=("$ROOT"/.pi/extensions/rails/*.test.ts)

exec mise exec -- node --test --experimental-strip-types "${args[@]}"
