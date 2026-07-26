#!/usr/bin/env bash
# One-time, idempotent setup for the liubai daily driver. Re-running is safe.
#
#   1. mise + node@22   (user-local, no sudo; system node is too old for pi)
#   2. pinned pi engine (npm install honours the exact pin in package.json)
#   3. global steering  (a copy of extensions/, loaded in every repo you open)
#   4. PATH command     (`liubai` available everywhere)
#
# Step 3 installs a snapshot, so the working tree is never live: this script is
# the promote step, and `liubai --dev` runs the tree without touching the copy.
#
# Model config (~/.pi/agent/models.json) is owned by the dotfiles repo and
# linked by its stow install — not created here. The agent memory file
# (~/.pi/agent/CLAUDE.md) is owned by the user and not touched here.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$HOME/.pi/agent"
LOCAL_BIN="$HOME/.local/bin"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

install_extension() {
  local dest="$AGENT_DIR/extensions/$1"
  rm -rf "$dest"
  cp -a "$REPO/extensions/$1" "$dest"
  find "$dest" -name __pycache__ -type d -prune -exec rm -rf {} +
}

installed_source() {
  local commit dirty
  commit="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo "no-git")"
  dirty=""
  [ -z "$(git -C "$REPO" status --porcelain 2>/dev/null)" ] || dirty=" (dirty)"
  printf '%s @ %s%s\n' "$REPO" "$commit" "$dirty"
}

step "mise (node version manager)"
if ! command -v mise >/dev/null 2>&1; then
  curl -fsSL https://mise.run | sh
fi
MISE="$(command -v mise || echo "$HOME/.local/bin/mise")"
"$MISE" use -g node@22

step "pinned pi engine"
"$MISE" exec -- npm install --prefix "$REPO"

step "global steering rails"
mkdir -p "$AGENT_DIR/extensions"
install_extension rails
install_extension subagent
installed_source > "$AGENT_DIR/extensions/.liubai-installed"
printf 'installed from %s' "$(installed_source)"

step "liubai command"
mkdir -p "$LOCAL_BIN"
ln -sfn "$REPO/bin/liubai" "$LOCAL_BIN/liubai"

printf '\n\033[1mDone.\033[0m '
case ":$PATH:" in
  *":$LOCAL_BIN:"*) echo "Run: liubai" ;;
  *) echo "Add $LOCAL_BIN to PATH, then run: liubai" ;;
esac
echo "Steering is on by default; baseline = LIUBAI_RAILS_OFF=1 liubai ..."
