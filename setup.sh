#!/usr/bin/env bash
# One-time, idempotent setup for the liubai daily driver. Re-running is safe.
#
#   1. mise + node@22   (user-local, no sudo; system node is too old for pi)
#   2. pinned pi engine (npm install honours the exact pin in package.json)
#   3. engine deps      (npm install honours the exact pin in engine/package.json)
#   4. global steering  (a copy of extensions/ + engine/, loaded in every repo you open)
#   5. PATH command     (`liubai` available everywhere)
#
# Steps 3-4 install a snapshot, so the working tree is never live: this script is
# the promote step, and `liubai --dev` runs the tree without touching the copy.
#
# Model config (~/.pi/agent/models.json) is owned by the dotfiles repo and
# linked by its stow install — not created here. The agent memory file
# (~/.pi/agent/CLAUDE.md) is owned by the user and not touched here.
#
# The install functions are sourceable (main() only runs when this file is
# executed, not when sourced) so tests can exercise them with LIUBAI_* env
# overrides instead of running the whole script end-to-end.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$HOME/.pi/agent"
LOCAL_BIN="$HOME/.local/bin"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

mise_bin() {
  command -v mise || echo "$HOME/.local/bin/mise"
}

install_engine() {
  local src="${LIUBAI_REPO:-$REPO}"
  local dest="${LIUBAI_ENGINE_DEST:-$AGENT_DIR/engine}"
  rm -rf "$dest"
  cp -a "$src/engine" "$dest"
  rm -rf "$dest/.venv"
  rm -rf "$dest/node_modules"
}

# Engine ships its own package.json so the installed copy can `npm install`
# its tree-sitter runtime; the dev project and the installed copy both need
# node_modules beside the .ts files that `createRequire(import.meta.url)`
# resolves from. Idempotent: skips if tree-sitter-typescript is already there.
install_engine_deps() {
  local dest="${1:-${LIUBAI_ENGINE_DEST:-$AGENT_DIR/engine}}"
  if [ ! -d "$dest/node_modules/tree-sitter-typescript" ]; then
    "$(mise_bin)" exec -- npm install --prefix "$dest" --no-audit --no-fund
  fi
}

install_extension() {
  local src="${LIUBAI_REPO:-$REPO}"
  local dest="${LIUBAI_AGENT_DIR:-$AGENT_DIR}/extensions/$1"
  rm -rf "$dest"
  cp -a "$src/extensions/$1" "$dest"
  find "$dest" -name __pycache__ -type d -prune -exec rm -rf {} +
}

installed_source() {
  local commit dirty
  commit="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo "no-git")"
  dirty=""
  [ -z "$(git -C "$REPO" status --porcelain 2>/dev/null)" ] || dirty=" (dirty)"
  printf '%s @ %s%s\n' "$REPO" "$commit" "$dirty"
}

ensure_lizard_venv() {
  local eng_dir="$1"
  local py="$eng_dir/.venv/bin/python"
  if [ ! -x "$py" ]; then
    rm -rf "$eng_dir/.venv"
    uv venv "$eng_dir/.venv"
  fi
  uv pip install --quiet --python "$py" lizard
}

main() {
  step "mise (node version manager)"
  if ! command -v mise >/dev/null 2>&1; then
    curl -fsSL https://mise.run | sh
  fi
  local mise
  mise="$(mise_bin)"
  "$mise" use -g node@22

  step "pinned pi engine"
  "$mise" exec -- npm install --prefix "$REPO" --no-audit --no-fund

  step "engine deps (project)"
  install_engine_deps "$REPO/engine"

  step "global steering rails"
  mkdir -p "$AGENT_DIR/extensions"
  install_engine
  install_extension rails
  install_extension subagent
  installed_source > "$AGENT_DIR/extensions/.liubai-installed"
  printf 'installed from %s' "$(installed_source)"

  step "engine deps (installed copy)"
  install_engine_deps

  step "lizard venv"
  if command -v uv >/dev/null 2>&1; then
    ensure_lizard_venv "$REPO/engine"
    ensure_lizard_venv "$AGENT_DIR/engine"
  else
    printf 'uv not found on PATH; install with: curl -LsSf https://astral.sh/uv/install.sh | sh\n' >&2
  fi

  step "liubai command"
  mkdir -p "$LOCAL_BIN"
  ln -sfn "$REPO/bin/liubai" "$LOCAL_BIN/liubai"

  step "Claude Code global hook"
  mkdir -p "$HOME/.claude"
  "$mise" exec -- node "$REPO/bin/sync-claude-settings.mjs" "$HOME/.claude/settings.json" "$REPO/config/claude-managed-hooks.json"

  printf '\n\033[1mDone.\033[0m '
  case ":$PATH:" in
    *":$LOCAL_BIN:"*) echo "Run: liubai" ;;
    *) echo "Add $LOCAL_BIN to PATH, then run: liubai" ;;
  esac
  echo "Steering is on by default; baseline = LIUBAI_RAILS_OFF=1 liubai ..."
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
