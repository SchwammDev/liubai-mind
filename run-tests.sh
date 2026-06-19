#!/bin/bash
# Runs the TypeScript pi-extension tests on the bundled node (system node is too old
# for type stripping). Override the interpreter with LIUBAI_NODE. Forwards args verbatim;
# defaults to the rails bridge test.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
NODE="${LIUBAI_NODE:-$(ls "$ROOT"/playground/node-*/bin/node 2>/dev/null | head -1)}"
[ -x "$NODE" ] || NODE=node

args=("$@")
[ ${#args[@]} -eq 0 ] && args=("$ROOT/.pi/extensions/rails/bridge.test.ts")

exec "$NODE" --test --experimental-strip-types "${args[@]}"
