#!/bin/bash
# scripts/nightly-install.sh — create the nightly tree and install (or remove) the launchd job.
#
#   scripts/nightly-install.sh [TREE]       create TREE (default: ../nightly beside this checkout),
#                                           clone dmi-e2e into it, render docs/launchd/*.plist to
#                                           run THAT clone's scripts/nightly.sh, and load it
#   scripts/nightly-install.sh --uninstall  unload and delete the job (the tree is left alone)
#
# The tree is the point: the nightly runs from its own clones, one per repo under the repo's name,
# and forces each to origin/main every night (see scripts/nightly.sh). It never touches the
# checkouts a person works in — this one included. The marker file the tree gets here is what
# nightly.sh checks before it hard-resets anything. Only dmi-e2e is cloned now; the nightly clones
# dmi-api and each loop's checkouts on its first run, and installs what needs installing.
#
# Afterwards:
#   launchctl print gui/$UID/com.nominal.dmi-e2e.nightly      # state, next run
#   launchctl kickstart gui/$UID/com.nominal.dmi-e2e.nightly  # run it now
#   tail -f ~/Library/Logs/dmi-e2e/nightly-*.log              # follow a run
set -eu

LABEL=com.nominal.dmi-e2e.nightly
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
LOGS=${NIGHTLY_LOG_DIR:-$HOME/Library/Logs/dmi-e2e}
GIT_URL=${NIGHTLY_GIT_URL:-git@github.com:nominal-systems/}
TEMPLATE=$ROOT/docs/launchd/$LABEL.plist
TARGET=$HOME/Library/LaunchAgents/$LABEL.plist
DOMAIN=gui/$(id -u)

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL"
  echo "unloaded $LABEL"
fi

if [ "${1:-}" = --uninstall ]; then
  rm -f "$TARGET"
  echo "removed $TARGET"
  exit 0
fi

# Run from inside a tree (its own dmi-e2e clone), reuse that tree; otherwise a `nightly` directory
# beside this checkout, so the tree's `../<repo>` layout mirrors the developer's.
if [ -n "${1:-}" ]; then
  TREE=$(mkdir -p "$1" && cd "$1" && pwd)
elif [ -f "$(dirname "$ROOT")/.dmi-e2e-nightly" ]; then
  TREE=$(dirname "$ROOT")
else
  TREE=$(dirname "$ROOT")/nightly
fi
mkdir -p "$TREE"
if [ ! -f "$TREE/.dmi-e2e-nightly" ]; then
  # Refuse to mark a directory that already holds checkouts: those are somebody's, and the marker
  # is what licenses nightly.sh to hard-reset everything under it.
  if ls -d "$TREE"/*/.git >/dev/null 2>&1; then
    echo "$TREE already contains git checkouts and is not a nightly tree — pick an empty directory" >&2
    exit 1
  fi
  printf 'Created by dmi-e2e/scripts/nightly-install.sh on %s. Every clone in this directory is reset to origin/main by the nightly; do not work here.\n' "$(date +%F)" > "$TREE/.dmi-e2e-nightly"
  echo "created nightly tree $TREE"
fi
if [ ! -d "$TREE/dmi-e2e/.git" ]; then
  git clone --quiet "${GIT_URL}dmi-e2e.git" "$TREE/dmi-e2e"
  echo "cloned dmi-e2e into $TREE/dmi-e2e"
fi
NIGHTLY_ROOT=$TREE/dmi-e2e

mkdir -p "$LOGS" "$(dirname "$TARGET")"
sed -e "s|__REPO__|$NIGHTLY_ROOT|g" -e "s|__LOGS__|$LOGS|g" "$TEMPLATE" > "$TARGET"
plutil -lint "$TARGET"
launchctl bootstrap "$DOMAIN" "$TARGET"
echo "loaded $LABEL from $TARGET — runs $NIGHTLY_ROOT/scripts/nightly.sh"
launchctl print "$DOMAIN/$LABEL" | grep -E 'state|next' || true
echo "run it now with: launchctl kickstart $DOMAIN/$LABEL"
