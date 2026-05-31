#!/bin/bash
# Transparent wrapper around `uv run pytest`. Forwards all args verbatim.
# Prints "✅ All tests passed!" on success, full pytest output on failure.
# Prefer over raw `uv run pytest` for local runs.

output=$(uv run pytest "$@" 2>&1)
exit_code=$?

if [ $exit_code -eq 0 ]; then
    coverage=$(echo "$output" | grep -E '^TOTAL' | awk '{print $NF}')
    if [ -n "$coverage" ]; then
        echo "✅ All tests passed! (coverage: $coverage)"
    else
        echo "✅ All tests passed!"
    fi
else
    echo "$output"
fi