#!/bin/bash
# scripts/nightly.sh — the unattended run: every suite in turn, each report published as it lands.
#
# Written for launchd on the shared mac mini (docs/launchd/, installed by scripts/nightly-install.sh)
# but runnable by hand. It assumes nothing about the caller's environment: launchd sources no shell
# profile, so PATH, node (nvm) and the GitHub Packages token are all resolved here.
#
# Knobs (all optional):
#   NIGHTLY_SUITES        suites to run, in order          (default: fast idexx antech zoetis)
#   NIGHTLY_PULL          1 to fast-forward every checkout first, 0 to test what is there (default 1)
#   NIGHTLY_SUITE_TIMEOUT seconds before a suite is killed  (default 2400)
#   NIGHTLY_LOG_DIR       where the dated logs go            (default ~/Library/Logs/dmi-e2e)
#   NIGHTLY_LOG_KEEP_DAYS logs older than this are pruned    (default 14)
#   HARNESS_PUBLISH_REPORT  forced to 1 unless set — publishing is the point of this script
#   GHP_TOKEN             taken from `gh auth token` when unset
#
# The whole body is one brace group so bash parses it completely before running a line of it —
# the pull below may rewrite this very file mid-run.
{
set -u

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
LOG_DIR=${NIGHTLY_LOG_DIR:-$HOME/Library/Logs/dmi-e2e}
SUITES=${NIGHTLY_SUITES:-fast idexx antech zoetis}
PULL=${NIGHTLY_PULL:-1}
SUITE_TIMEOUT=${NIGHTLY_SUITE_TIMEOUT:-2400}
KEEP_DAYS=${NIGHTLY_LOG_KEEP_DAYS:-14}
LOCK=$LOG_DIR/nightly.lock

mkdir -p "$LOG_DIR"
LOG=$LOG_DIR/nightly-$(date +%Y%m%d-%H%M%S).log
exec >>"$LOG" 2>&1

log() { printf '[nightly %s] %s\n' "$(date '+%H:%M:%S')" "$*"; }

# --- one run at a time -------------------------------------------------------------------------
# The suites share one database and one event stream; a second run (last night's, still hung, or a
# developer's manual run) must not race this one. mkdir is atomic; a lock left by a dead process
# is stale and reclaimed.
if ! mkdir "$LOCK" 2>/dev/null; then
  other=$(cat "$LOCK/pid" 2>/dev/null || echo '?')
  if [ "$other" != '?' ] && kill -0 "$other" 2>/dev/null; then
    log "another nightly run (pid $other) is still going — skipping this one"
    exit 0
  fi
  log "reclaiming stale lock left by pid $other"
  rm -rf "$LOCK"
  mkdir "$LOCK" || exit 1
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

# --- environment launchd does not give us -------------------------------------------------------
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Applications/Docker.app/Contents/Resources/bin"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
  nvm use default >/dev/null 2>&1 || true
fi
export HARNESS_PUBLISH_REPORT=${HARNESS_PUBLISH_REPORT:-1}
if [ -z "${GHP_TOKEN:-}" ]; then
  GHP_TOKEN=$(gh auth token 2>/dev/null || true)
  export GHP_TOKEN
fi

log "start — root=$ROOT suites=[$SUITES] pull=$PULL publish=$HARNESS_PUBLISH_REPORT log=$LOG"
log "node $(node -v 2>&1) at $(command -v node || echo MISSING); docker $(command -v docker || echo MISSING); token $([ -n "${GHP_TOKEN:-}" ] && echo present || echo MISSING)"

cd "$ROOT" || exit 1

# --- Docker Desktop must be up ------------------------------------------------------------------
if ! docker info >/dev/null 2>&1; then
  log "docker daemon not responding — launching Docker Desktop"
  open -a Docker 2>/dev/null || true
  for _ in $(seq 1 36); do
    sleep 5
    docker info >/dev/null 2>&1 && break
  done
  if ! docker info >/dev/null 2>&1; then
    log "docker never came up — giving up"
    exit 1
  fi
fi

# --- fast-forward every checkout under test -----------------------------------------------------
# ff-only and never fatal: a checkout that cannot fast-forward (diverged, or a local edit the pull
# would overwrite — dmi-api carries one on the mac mini) is tested as it stands, and the report's
# "under test" column records the describe, `-dirty` included.
pull() {
  local dir=$1
  if [ ! -d "$dir/.git" ]; then log "pull: no checkout at $dir (skipped)"; return; fi
  local before after
  before=$(git -C "$dir" rev-parse HEAD)
  if git -C "$dir" pull --ff-only --quiet 2>&1; then
    after=$(git -C "$dir" rev-parse HEAD)
    if [ "$before" = "$after" ]; then
      log "pull: $dir already at $(git -C "$dir" describe --always --dirty) on $(git -C "$dir" rev-parse --abbrev-ref HEAD)"
    else
      log "pull: $dir ${before:0:8} -> ${after:0:8} on $(git -C "$dir" rev-parse --abbrev-ref HEAD)"
    fi
  else
    log "pull: $dir could not fast-forward — testing what is checked out ($(git -C "$dir" describe --always --dirty))"
  fi
}

if [ "$PULL" = 1 ]; then
  lock_before=$(shasum package-lock.json 2>/dev/null)
  pull "$ROOT"
  if [ "$(shasum package-lock.json 2>/dev/null)" != "$lock_before" ]; then
    log "package-lock.json changed — npm install"
    npm install --no-audit --no-fund >/dev/null 2>&1 || log "npm install failed (continuing)"
  fi
  pull "${DMI_API_DIR:-$ROOT/../dmi-api}"
  for s in $SUITES; do
    [ "$s" = fast ] && continue
    var="DMI_$(echo "$s" | tr '[:lower:]' '[:upper:]')_INTEGRATION_DIR"
    pull "${!var:-$ROOT/../dmi-engine-$s-integration}"
  done
fi

# --- run each suite, bounded, never stopping on red ----------------------------------------------
# A suite runs in its own process group (set -m) so the watchdog can take the whole tree down —
# npm → jest → the dmi-api child — if it overruns; the compose down afterwards clears its containers.
run_suite() {
  local suite=$1 rc
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
  log "== $suite: start"
  set -m
  if [ "$suite" = fast ]; then
    HARNESS_FULL_STACK=0 npm run test:harness &
  else
    HARNESS_FULL_STACK=1 HARNESS_STACK=$suite npm run test:harness &
  fi
  local pid=$!
  ( sleep "$SUITE_TIMEOUT" && kill -TERM -- -"$pid" 2>/dev/null && echo "[nightly] $suite overran ${SUITE_TIMEOUT}s — killed" ) &
  local watchdog=$!
  wait "$pid"; rc=$?
  kill "$watchdog" 2>/dev/null; wait "$watchdog" 2>/dev/null
  set +m
  log "== $suite: exit $rc"
  return $rc
}

overall=0
for s in $SUITES; do
  run_suite "$s" || overall=1
done
docker compose down -v --remove-orphans >/dev/null 2>&1 || true

# --- summary -------------------------------------------------------------------------------------
log "summary:"
for s in $SUITES; do
  node -e '
    const s = process.argv[1]; let j;
    try { j = require(process.argv[2] + "/reports/" + s + "/summary.json") } catch { console.log(`  ${s}: no summary (did not complete)`); process.exit() }
    console.log(`  ${s}: ${j.success ? "PASS" : "FAIL"} ${j.passed}/${j.total} passed${j.failed ? ", " + j.failed + " failed" : ""} (${Math.round(j.durationMs / 1000)}s)`)
  ' "$s" "$ROOT"
done
log "published to ${HARNESS_REPORT_PUBLISH_DIR:-/opt/homebrew/var/www/dmi-e2e}"

find "$LOG_DIR" -name 'nightly-*.log' -mtime +"$KEEP_DAYS" -delete 2>/dev/null
log "done — overall $([ $overall = 0 ] && echo green || echo RED)"
exit $overall
}
