#!/bin/bash
# scripts/nightly-install.sh — install (or remove) the nightly launchd job on this machine.
#
#   scripts/nightly-install.sh              render docs/launchd/*.plist for this checkout and load it
#   scripts/nightly-install.sh --uninstall  unload and delete it
#
# Afterwards:
#   launchctl print gui/$UID/com.nominal.dmi-e2e.nightly      # state, next run
#   launchctl kickstart gui/$UID/com.nominal.dmi-e2e.nightly  # run it now
#   tail -f ~/Library/Logs/dmi-e2e/nightly-*.log              # follow a run
set -eu

LABEL=com.nominal.dmi-e2e.nightly
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
LOGS=${NIGHTLY_LOG_DIR:-$HOME/Library/Logs/dmi-e2e}
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

mkdir -p "$LOGS" "$(dirname "$TARGET")"
sed -e "s|__REPO__|$ROOT|g" -e "s|__LOGS__|$LOGS|g" "$TEMPLATE" > "$TARGET"
plutil -lint "$TARGET"
launchctl bootstrap "$DOMAIN" "$TARGET"
echo "loaded $LABEL from $TARGET"
launchctl print "$DOMAIN/$LABEL" | grep -E 'state|next' || true
echo "run it now with: launchctl kickstart $DOMAIN/$LABEL"
