#!/bin/bash
# scripts/slot-tree.sh — a tree of checkouts for one harness slot, so a change to any repo the
# harness builds from can be tested while other slots do the same on the same machine.
#
#   scripts/slot-tree.sh <n> [suite …]   create slot tree <n> (1–99): a worktree of dmi-e2e, of
#                                        dmi-api and of every checkout the named suites are built
#                                        from (default: every loop in src/stacks.js), each detached
#                                        at origin's default branch; `.harness-slot` = n in its
#                                        dmi-e2e; `npm ci` in dmi-e2e and dmi-api
#   scripts/slot-tree.sh --remove <n>    take slot n's stack down (containers, volumes, the images it
#                                        built) and remove the tree's worktrees. Refused while a run
#                                        holds the slot, or while any worktree has uncommitted
#                                        changes or commits that no branch holds
#   scripts/slot-tree.sh --list          every slot tree: what each worktree is on, and whether a
#                                        run holds the slot
#
# Why a tree. A slot (src/slots.js) gives a run its own ports and compose project, but not its own
# code: the harness builds dmi-api and every integration image from the checkouts BESIDE dmi-e2e
# (`../dmi-api`, `../<integration>`). Two runs from one checkout test the same folders — each
# other's half-made edits, or whatever branch someone left checked out. A slot tree is every repo
# a run builds from, side by side under one directory, so those `../<repo>` defaults resolve inside
# the tree, and nothing in it is shared with another slot. After creating one: check out a branch
# in the repos you change (a change across two repos is two branches in one tree, tested
# together), then run the harness from the tree's dmi-e2e — it reads its slot from `.harness-slot`,
# so there is nothing else to set.
#
# Worktrees, not clones: they share the existing clones' objects, so a tree takes seconds, needs no
# credentials beyond a fetch, and a branch made in one is an ordinary branch of the clone it came
# from. Detached, so no tree holds `main` (git checks a branch out in one worktree at a time) and
# no tree can move it. Every repo a run builds from gets a worktree, edited or not: a repo missing
# from the tree fails the build loudly instead of falling back to a shared folder.
#
# Where. The worktrees come from the clones beside the main dmi-e2e clone (the directory that
# holds dmi-e2e, dmi-api and the integrations); a repo a suite needs must be cloned there first.
# Trees go in DMI_SLOTS_DIR, default `slots/` in that same directory; tree n is `<slots>/s<n>`.
#
# Needs node, git 2.31+, docker, and GHP_TOKEN (a GitHub Packages read token) for dmi-api's
# `npm ci`. One harness run per tree at a time: two runs in one tree would share its dmi-api build
# and its reports/.

set -euo pipefail

HERE=$(cd "$(dirname "$0")/.." && pwd)
MAIN=$(dirname "$(git -C "$HERE" rev-parse --path-format=absolute --git-common-dir)")
REPOS=$(dirname "$MAIN")
SLOTS=${DMI_SLOTS_DIR:-$REPOS/slots}

die() { echo "slot-tree: $*" >&2; exit 1; }
slots() { node "$HERE/src/slots.js" "$@"; }
stacks() { node "$HERE/src/stacks.js" "$@"; }

# The remote default branch of a clone, as a ref a worktree can be detached at.
default_ref() {
  local src=$1 ref
  if ref=$(git -C "$src" symbolic-ref -q --short refs/remotes/origin/HEAD); then echo "$ref"; return; fi
  for ref in origin/main origin/master; do
    if git -C "$src" rev-parse -q --verify "$ref^{commit}" >/dev/null; then echo "$ref"; return; fi
  done
  die "$src has no origin/HEAD, origin/main or origin/master to start from"
}

create() {
  local n=$1; shift
  local project tree=$SLOTS/s$n holder
  project=$(slots project "$n") || exit 1
  [ "$n" -ge 1 ] || die "slot 0 is the plain checkout's; a tree takes a slot from 1 up"
  [ ! -e "$tree" ] || die "$tree already exists — --remove $n first, or pick another number (--list shows them)"
  holder=$(slots holder "$n")
  [ -z "$holder" ] || die "a harness run holds slot $n (pid, since, checkout: $holder)"
  [ -n "${GHP_TOKEN:-}" ] || die "GHP_TOKEN is not set: dmi-api's npm ci resolves @nominal-systems/* from GitHub Packages and needs a read:packages token"

  local named=1 suites="$*"
  if [ -z "$suites" ]; then named=0; suites=$(stacks list | tr '\n' ' '); fi

  # The repos: dmi-e2e and dmi-api always, then every checkout of every suite, once each. A suite
  # whose checkouts are not all cloned is an error when named, and left out when defaulted.
  local repos="dmi-e2e dmi-api" kept="" s list repo missing
  for repo in dmi-e2e dmi-api; do
    [ -e "$REPOS/$repo/.git" ] || die "$REPOS/$repo is not a clone"
  done
  for s in $suites; do
    list=$(stacks checkouts "$s") || exit 1
    missing=""
    while read -r repo _; do
      [ -e "$REPOS/$repo/.git" ] || missing="$missing $repo"
    done <<< "$list"
    if [ -n "$missing" ]; then
      [ "$named" = 0 ] || die "suite $s is built from$missing, which is not cloned in $REPOS — clone it there first"
      echo "slot-tree: leaving out suite $s:$missing not cloned in $REPOS"
      continue
    fi
    kept="$kept $s"
    while read -r repo _; do
      case " $repos " in *" $repo "*) ;; *) repos="$repos $repo" ;; esac
    done <<< "$list"
  done

  echo "slot-tree: slot $n — tree $tree, compose project $project"
  mkdir -p "$tree"
  local src ref
  for repo in $repos; do
    src=$REPOS/$repo
    git -C "$src" fetch -q origin || echo "slot-tree: could not fetch $repo; using the origin refs it already has"
    ref=$(default_ref "$src")
    git -C "$src" worktree prune
    git -C "$src" worktree add -q --detach "$tree/$repo" "$ref" || die "git worktree add failed for $repo"
    printf '  %-38s %s @ %s\n' "$repo" "$ref" "$(git -C "$tree/$repo" rev-parse --short HEAD)"
  done
  echo "$n" > "$tree/dmi-e2e/.harness-slot"

  # The harness runs these two on the host; the integrations and the engine build inside Docker.
  for repo in dmi-e2e dmi-api; do
    echo "slot-tree: npm ci in $repo"
    if ! (cd "$tree/$repo" && npm ci --no-audit --no-fund) > "$tree/npm-ci-$repo.log" 2>&1; then
      tail -20 "$tree/npm-ci-$repo.log" >&2
      die "npm ci failed in $tree/$repo (log: $tree/npm-ci-$repo.log); the tree is left as it is — --remove $n clears it"
    fi
  done

  cat <<EOF

Slot $n is ready: $tree
  compose project $project; host ports +$((n * 10)) on every default (node src/slots.js ports $n)
  suites:$kept

Check out a branch in each repo you change, then run the harness from the tree's dmi-e2e:
  cd $tree/<repo> && git switch -c <topic>
  cd $tree/dmi-e2e && npm run test:harness
  cd $tree/dmi-e2e && HARNESS_FULL_STACK=1 HARNESS_STACK=<suite> npm run test:harness

When done: scripts/slot-tree.sh --remove $n
EOF
}

remove() {
  local n=$1 project tree=$SLOTS/s$1 holder
  project=$(slots project "$n") || exit 1
  [ -d "$tree" ] || die "no slot tree at $tree"
  holder=$(slots holder "$n")
  [ -z "$holder" ] || die "a harness run holds slot $n (pid, since, checkout: $holder) — let it finish first"

  # Nothing is removed unless every worktree can go without losing work. A branch survives its
  # worktree (it lives in the clone), so only uncommitted changes and orphaned commits count.
  local dir repo problems="" branches=""
  for dir in "$tree"/*/; do
    dir=${dir%/}; repo=${dir##*/}
    [ -e "$dir/.git" ] || continue
    # (.harness-slot is the tree's own file: a dmi-e2e commit older than its .gitignore entry
    # would otherwise count it as uncommitted work.)
    [ -z "$(git -C "$dir" status --porcelain -- . ':(exclude).harness-slot')" ] || problems="$problems\n  $repo: uncommitted changes (git -C $dir status)"
    if git -C "$dir" symbolic-ref -q HEAD >/dev/null; then
      branches="$branches $repo:$(git -C "$dir" symbolic-ref --short HEAD)"
    elif [ -z "$(git -C "$dir" for-each-ref --count=1 --contains HEAD refs/heads refs/remotes)" ]; then
      problems="$problems\n  $repo: commits on a detached HEAD that no branch holds (git -C $dir log -1)"
    fi
  done
  [ -z "$problems" ] || die "not removing $tree:$(printf '%b' "$problems")"

  echo "slot-tree: removing slot $n ($project)"
  docker compose -p "$project" down -v --remove-orphans >/dev/null 2>&1 || true
  local images
  images=$(docker image ls --format '{{.Repository}}:{{.Tag}}' | grep "^$project-" || true)
  if [ -n "$images" ]; then
    # shellcheck disable=SC2086
    docker image rm $images >/dev/null && echo "  images removed: $(echo $images | tr '\n' ' ')"
  fi
  local src
  for dir in "$tree"/*/; do
    dir=${dir%/}
    [ -e "$dir/.git" ] || continue
    src=$(dirname "$(git -C "$dir" rev-parse --path-format=absolute --git-common-dir)")
    rm -f "$dir/.harness-slot"
    git -C "$src" worktree remove "$dir" || die "git worktree remove failed for $dir — nothing after it was removed"
  done
  rm -f "$tree"/npm-ci-*.log
  rmdir "$tree" 2>/dev/null || die "$tree still holds files the tree did not make — left in place: $(ls -A "$tree" | tr '\n' ' ')"
  echo "slot-tree: slot $n removed"
  local b
  for b in $branches; do
    echo "  branch ${b#*:} is still in the ${b%%:*} clone ($REPOS/${b%%:*})"
  done
}

list() {
  local tree n holder up dir
  if ! ls -d "$SLOTS"/s* >/dev/null 2>&1; then echo "no slot trees in $SLOTS"; return; fi
  for tree in "$SLOTS"/s*/; do
    tree=${tree%/}; n=${tree##*/s}
    case $n in ''|*[!0-9]*) continue ;; esac
    holder=$(slots holder "$n")
    up=$(docker ps -q --filter "label=com.docker.compose.project=$(slots project "$n")" | wc -l | tr -d ' ')
    echo "s$n  $tree  — $([ -n "$holder" ] && echo "run in progress (pid ${holder%% *})" || echo "no run"), $up containers up"
    for dir in "$tree"/*/; do
      dir=${dir%/}
      [ -e "$dir/.git" ] || continue
      printf '    %-38s %s\n' "${dir##*/}" "$(git -C "$dir" symbolic-ref -q --short HEAD || echo "detached @ $(git -C "$dir" rev-parse --short HEAD)")"
    done
  done
}

case "${1:-}" in
  --remove) [ $# -eq 2 ] || die "usage: $0 --remove <n>"; remove "$2" ;;
  --list) list ;;
  ''|-h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//' ;;
  -*) die "unknown option $1 (see $0 --help)" ;;
  *) create "$@" ;;
esac
