# dmi-e2e

Black-box end-to-end tests for the DMI platform. This repo stands up **dmi-api** plus its real
dependencies (MySQL, Mongo, ActiveMQ) in Docker and drives them over real HTTP, as an integrator
would.

## What this is, and what it isn't

The word "e2e" is overloaded across the DMI repos. It is worth being precise, because this repo is
different from everything else that carries the name:

- `dmi-api/test/e2e/*.e2e-spec.ts` — **controller tests**. The service layer is mocked and the auth
  guard is stubbed. No database, no HTTP server.
- `dmi-engine-antech-integration/test/antech.module.e2e-spec.ts` — a **module-wiring test** against
  an in-memory `AntechApiMock` and a mocked Bull queue.
- The provider repos' other `*.spec.ts` — **fixture-driven unit tests**: a captured payload → a
  mapper → an asserted DTO, no IO.

**`dmi-e2e` is the platform's only real-services suite.** It runs the actual dmi-api process
against actual MySQL/Mongo/ActiveMQ containers and asserts on real HTTP responses. Nothing here is
mocked. It is the first true integration layer the platform has had, which is also why it was the
first to catch dmi-api letting one organization read and write another's data — no mocked suite
could have. Those defects are fixed now, and the tests that caught them stay on as guards (see
"Tripwires").

It imports **nothing** from dmi-api. It talks to a running server over HTTP, and — for setup and
assertions that no HTTP route exposes — to MySQL directly via `mysql2`. Two scenarios also reach
Mongo, via the `mongodb` driver, but only to make one of dmi-api's own writes fail on purpose
(`src/mongo.ts`). That boundary is the whole point: the harness must survive dmi-api refactors and
stay reusable as a conformance suite. Two setup steps could go over HTTP and do not, each because
the route that exists for it is broken and pinned by a tripwire (see "Tripwires"): the shared
seeder inserts each user over SQL, because `POST /users` answers 500, and the two engine loops
insert their provider's reference data, because `POST /admin/refs/sync/<provider>` stores nothing.
Everything after that, from login to orders, is real HTTP.

## Requirements

- **Docker**, running.
- **Node 20+**.
- **A dmi-api checkout** with its dependencies installed. Point `DMI_API_DIR` at it (defaults to
  `../dmi-api`). Installing dmi-api's deps needs a **`GHP_TOKEN` with `read:packages`**, because
  dmi-api resolves `@nominal-systems/*` from GitHub Packages — a property of dmi-api, not of this
  repo. This repo's own `npm install` needs no token.

## Running it

```bash
npm install                 # this repo — no token needed

# one-time, in the dmi-api checkout:
#   GHP_TOKEN=<read:packages token> npm install

npm run test:harness        # DMI_API_DIR defaults to ../dmi-api
```

That does the whole thing from a clean state:

1. Take the run's slot (slot 0 unless you ask for another — see "Parallel runs" below), then
   `docker compose up -d` — MySQL 8, Mongo 4, ActiveMQ (this repo's `docker-compose.yml`). Mongo
   runs with test commands on, so that a scenario can arm a failpoint in it (see "Layout").
2. Poll until all three accept connections. No fixed sleeps.
3. `npm run migration:run` in the dmi-api checkout, against the harness database. This also
   regression-tests that dmi-api's migrations produce a working schema from empty.
4. `npm run build` in the checkout, then spawn `node dist/main` and poll `/health` until every
   dependency reports up.
5. Run the scenarios, one file at a time (`maxWorkers: 1`): they share one database, one event
   stream and one `seq` counter, and must not race.
6. Stop dmi-api (and any dmi-api a scenario started again; see "Service control") and
   `docker compose down -v`.

Faster iteration:

```bash
HARNESS_KEEP_UP=1 npm run test:harness   # leave containers running on exit
HARNESS_BUILD=0   npm run test:harness   # skip `npm run build` in the checkout

# drive a dmi-api you are already running yourself; the harness touches no checkout:
HARNESS_BASE_URL=http://127.0.0.1:3000 HARNESS_MANAGE_CONTAINERS=0 npm run test:harness
```

With `HARNESS_MANAGE_CONTAINERS=0` the databases and the broker are yours as well, and your Mongo must
be started with `--setParameter enableTestCommands=1`: `scenarios/event-store-throttling.e2e.ts`
and the idexx loop's dmi-api#371 test arm a `failCommand` failpoint in it, and without the flag they fail,
naming the flag.

**Full-system re-runs with `HARNESS_KEEP_UP=1`.** A loop's integration (see "Full-system mode"
below) polls its mock through Bull jobs kept in Redis, and Redis outlives a kept-up run, so a stale
job from an earlier run could race a later run for its results. Each loop's scenario stops the
integration it started in `afterAll`, which removes its jobs. If a run is interrupted before that,
`docker compose --profile <loop> down -v` clears Redis (outside a slot tree, in slot n add
`-p dmi-e2e-s<n>`; see "Parallel runs — slots" below). A run without `HARNESS_KEEP_UP` tears Redis
down every time, so it is never affected. A container a killed run's scenario had paused (see
"Service control") is unpaused before the next run starts its containers, since `compose up` refuses
a paused one, and setup does not go on until every container of the project is running.

### Parallel runs — slots

A run owns a compose project and a set of host ports, so by default runs go one at a time. A
**slot** moves a run off both at once: every host port is its default **+10 per slot**, and the
compose project is `dmi-e2e-s<n>`. Slot 0 is the plain `dmi-e2e` project on the default ports —
the harness exactly as it always ran. Runs in different slots share nothing: each has its own MySQL,
Mongo, broker, Redis, mock and locally built images. The broker matters as much as the ports: two
dmi-api instances on one broker are one MQTT shared-subscription group, so the broker would split
each run's results between them, and nothing in a serial run would show it.

```bash
HARNESS_SLOT=2 npm run test:harness   # slot 2: dmi-api on 3030, MySQL on 3327, project dmi-e2e-s2
echo 2 > .harness-slot                # or make 2 this checkout's slot (the file is gitignored)
node src/slots.js ports 2             # every host port slot 2 uses
```

- The slot comes from `HARNESS_SLOT`, else a `.harness-slot` file in the checkout's root, else 0.
  An explicit `HARNESS_*_PORT` still wins over the slot's. The harness sets `COMPOSE_PROJECT_NAME`
  itself, and refuses to start if a different one is already set.
- **A run holds its slot until it ends.** A second run on a taken slot fails at once, naming the run
  that holds it; a lock whose run died is taken over by the next run. A run is also refused while
  another run, in any slot, works from the same checkout (they would share its `reports/`) or on the
  same dmi-api checkout while either of them builds it (`npm run build` deletes `dist/` first).
- **The locks are per OS user**: `~/.cache/dmi-e2e/slot-locks`. Runs under *different* OS users that
  share one Docker daemon do not see each other's locks — point `HARNESS_LOCK_DIR` at one directory
  they can all write.
- **A run will not start dmi-api where something already listens.** A dmi-api that a killed run left
  behind would otherwise answer `/health` for this run and be tested in place of this checkout's
  build. The run fails at the start instead, naming the port.
- **A stack left up stays with the checkout that started it.** After `HARNESS_KEEP_UP=1`, a run from
  another checkout in the same slot refuses to start into those containers — compose would adopt
  them, and that run's teardown would wipe their database — and names the
  `docker compose -p <project> down -v` that clears them. The checkout that left them reuses them, as
  before.
- **A slot separates the stacks, not the code.** The harness builds from the checkouts beside this
  one (`../dmi-api`, `../<integration>`), so runs from one set of checkouts test the same files, and
  two runs from one checkout share its dmi-api build and `reports/`. To work on several changes at
  once, give each slot its own tree of checkouts:

```bash
scripts/slot-tree.sh 3 idexx      # ../slots/s3/: worktrees of dmi-e2e, dmi-api and the idexx
                                  # integration, detached at origin's default branch;
                                  # .harness-slot = 3; npm ci in dmi-e2e and dmi-api
cd ../slots/s3/dmi-engine-idexx-integration && git switch -c <topic>    # change it here
cd ../dmi-e2e && HARNESS_FULL_STACK=1 HARNESS_STACK=idexx npm run test:harness
scripts/slot-tree.sh --list       # the trees, what each worktree is on, which slots are running
scripts/slot-tree.sh --remove 3   # stack, volumes, images and worktrees; refused while a run holds
                                  # the slot or a worktree has uncommitted work
```

A tree holds a worktree of every repo its suites build from, edited or not, made from the clones
beside the main dmi-e2e clone (clone a missing one there first). With no suites named it covers every
loop whose checkouts are cloned. Branches made in a tree are ordinary branches of those clones, and
outlive the tree; `--remove` takes the tree's gitignored files (`node_modules`, `reports/`, builds)
with it. Trees go in `slots/` next to the clones; `DMI_SLOTS_DIR` moves them. `--common` adds a
worktree of dmi-engine-common and names it in the tree's `.env` as `DMI_ENGINE_COMMON_DIR`, so every
loop run there builds against it (see "Running a common candidate before a release"); a
dmi-engine-common worktree the `.env` does not name is used only when the variable is set, and
`--list` says which.

**`docker compose` by hand.** A tree's dmi-e2e carries a gitignored `.env` naming its slot's project
and ports, which compose reads on its own — so `docker compose ps` or `docker compose down -v` typed
in a tree addresses that tree's stack. Anywhere else, a bare `docker compose` addresses slot 0: with
`HARNESS_SLOT` exported, add `-p dmi-e2e-s<n>`.

**The nightly** runs at slot 0 and starts each suite by taking the `dmi-e2e` project down, so on a
machine that runs it, keep other work off slot 0 at night.

### Run reports

Every run leaves an HTML report behind, whatever the suite and whether it went green or red:

```
reports/
  index.html          a status banner, then one row per suite: result, counts, test and wall
                      duration, when, the last 20 runs as a strip, what was under test (with a
                      "changed" tag on anything that moved since the previous run, and commit
                      links), plus a per-test list per suite; failures inline
  <suite>/index.html  the full jest-html-reporters page (self-contained; open it from file://)
  <suite>/summary.json, <suite>/run.json   the data the index is built from
  <suite>/history.json  one entry per run this directory has seen (capped), for the strip and
                      "last red"; written at setup as incomplete, upgraded at teardown, and merged
                      — never replaced — when publishing
```

`<suite>` is `fast`, or the `HARNESS_STACK` name under `HARNESS_FULL_STACK=1`. Each run overwrites
its own suite's directory only, so running zoetis never hides the last idexx result. "Under test"
is `git describe` of this checkout, the dmi-api checkout and every checkout the loop's containers
are built from, as the stack registry lists them (`-dirty` when one has local changes), and for
dmi-engine-common either its checkout or `published <version>` — recorded
at setup, before anything is built, so a run that dies
before the tests report still shows what it was testing and is listed as *did not complete*.

**Serving it.** Set `HARNESS_PUBLISH_REPORT=1` and teardown copies the suite that just ran into
`HARNESS_REPORT_PUBLISH_DIR` (default `/opt/homebrew/var/www/dmi-e2e`) and rebuilds the index
*there*, over every suite it holds. `npm run report:publish [suite...]` does the same by hand for
every local suite (or the named ones). The directory is meant for an nginx `location /dmi-e2e/`
block — [docs/nginx/dmi-e2e.conf](docs/nginx/dmi-e2e.conf) is the snippet — which is how the
shared mac mini serves the latest run of each loop behind its existing auth. The report is copied
out of the repo rather than served in place because nginx's worker typically runs as `nobody`, which
cannot read into a home directory; the copy is made world-readable. A report problem is logged and
never fails the run: the suite's exit code is the suite's, not the reporter's.

Nothing is published unless the flag is set, so a developer's local run never writes outside the
repo; on their machine the `reports/` files open straight from the filesystem.

### Nightly runs on the mac mini

GitHub Actions reruns every suite nightly (`schedule:` in the six workflows) to catch upstream
drift, but a cloud run leaves no report anywhere you can open. The mac mini therefore runs the same
six suites itself each night and publishes each one, so the served index is never more than a day
old.

- [scripts/nightly.sh](scripts/nightly.sh) is the run, and it runs from **its own tree of clones**,
  never from a checkout a person works in. The tree (`../nightly` beside this checkout by default;
  `scripts/nightly-install.sh` creates it and marks it with a `.dmi-e2e-nightly` file) holds one
  clone per repo under the repo's own name — `dmi-e2e`, `dmi-api` and every checkout the registry
  lists for the suites it runs — which is exactly the `../<repo>` layout the compose file and the
  harness default to, so no `DMI_*_DIR` is set (an override is refused: the run tests only what it
  synced). Every night each clone is **forced to `origin/main`** (`NIGHTLY_BRANCH`): fetch, discard
  local changes, reset the branch. A clone the tree lacks is made on the spot, over **ssh**
  (`NIGHTLY_GIT_URL`), because launchd has no credential source for https. A fetch that fails leaves
  that clone as it was, logged, and the report's "under test" column records what actually ran. The
  marker is the safety: the hard reset refuses to run in a directory without it, and a directory
  that already holds checkouts is never marked. A machine-local hook, `<tree>/patches/<repo>.sh`,
  runs inside a clone after every sync (never in git — it is for a toolchain workaround the machine
  needs and the repo does not carry, and the clone then honestly reads `-dirty` in the report; the
  mac mini needed one for dmi-api's argon2 pin until dmi-api#368). `dmi-e2e` and `dmi-api` get `npm ci` when a
  clone is new or its lockfile moved. Then it makes sure Docker Desktop is up and runs `fast`, `idexx`,
  `antech-v3`, `zoetis`, `antech-v6` and `wisdom-panel` in turn with `HARNESS_PUBLISH_REPORT=1`. A red suite does
  not stop the loop; a suite that overruns `NIGHTLY_SUITE_TIMEOUT` (40 min) is killed and its
  containers removed. A lock keeps runs from overlapping. Each run writes a dated log under
  `~/Library/Logs/dmi-e2e/` ending in a one-line-per-suite summary; logs older than 14 days are
  pruned. `NIGHTLY_PULL=0` is the "test what is here" mode: no tree, no reset, whatever is checked
  out where the script lives. (Why the tree: for seven nights in 2026-09 the shared dmi-api checkout
  sat, clean and in sync with its remote, on a topic branch that predated a fix the fast suite
  asserted, and the ff-only pull of the day kept it there.) The GitHub Packages token is read from
  `~/.config/dmi-e2e/token` (`NIGHTLY_TOKEN_FILE`) when that file exists — a token scoped to
  `read:packages` alone is all the job needs — and from `gh auth token` otherwise. It assumes
  nothing about the caller's environment (launchd sources no profile): PATH, nvm and `GHP_TOKEN`
  are resolved inside. It also runs the docker CLI from a
  `DOCKER_CONFIG` that mirrors `~/.docker` minus the credential store: under launchd, Docker
  Desktop's `docker-credential-desktop` blocks forever when a non-Apple binary (node, python3) is
  among its ancestors, and every image build then fails resolving its base image with
  `DeadlineExceeded`. Nothing here needs registry credentials, so the helper is simply never
  consulted. Runnable by hand: from the tree's clone
  (`NIGHTLY_SUITES=fast ../nightly/dmi-e2e/scripts/nightly.sh`) it is the nightly; from this
  checkout it needs `NIGHTLY_PULL=0`.
- [docs/launchd/com.nominal.dmi-e2e.nightly.plist](docs/launchd/com.nominal.dmi-e2e.nightly.plist)
  schedules it at 03:00 local time as a **user LaunchAgent** — not a daemon, not cron — because the
  job needs what only the login session has: Docker Desktop, the `gh` token and write access to the
  nginx directory. `scripts/nightly-install.sh` creates the tree (or takes its directory as an
  argument), clones `dmi-e2e` into it, renders the template to run **that clone's** script, writes
  it to `~/Library/LaunchAgents/` and loads it; `--uninstall` reverses the job and leaves the tree.
- **When a loop's key changes** — as `antech` → `antech-v3` did — two things need a hand. The run
  index lists every suite directory it finds, so the old key's row (`reports/<old>/` here,
  `<HARNESS_REPORT_PUBLISH_DIR>/<old>/` on the mini) sits beside the new one until someone deletes
  it; and the first unattended run after the merge refuses to run, because `nightly.sh` is parsed
  in full before it syncs, so the *old* script's suite list and registry CLI meet the *new*
  `src/stacks.js` and stop, named, before any suite starts. Delete the two directories once, run
  the tree's `scripts/nightly.sh` by hand once, and move any `HARNESS_<OLD>_*` / `NIGHTLY_SUITES`
  overrides in a profile or plist to the new names.

```bash
scripts/nightly-install.sh                                  # create ../nightly, install / reinstall
launchctl print gui/$UID/com.nominal.dmi-e2e.nightly        # state, last exit, next run
launchctl kickstart gui/$UID/com.nominal.dmi-e2e.nightly    # run it now
tail -f ~/Library/Logs/dmi-e2e/nightly-*.log                # follow
```

### Full-system mode

The default suite is dmi-api alone under `NODE_ENV=seed`. `HARNESS_FULL_STACK=1` selects a second
jest project that runs dmi-api under a **normal `NODE_ENV`** (so `createOrder` actually RPCs the
engine over MQTT) against a real provider loop. Which loop is picked by `HARNESS_STACK`:

- **`idexx`** (default) — the loop for **IDEXX VetConnect Plus** (provider id `idexx`). dmi-api +
  ActiveMQ + Redis + the **VetConnect Plus mock** (`src/idexx-mock`, built from this repo) + the
  **real `dmi-engine-idexx-integration`** container, as two replicas, behind the `idexx` compose
  profile. Runs
  `scenarios/idexx-full-stack.e2e.ts`.
- **`antech-v3`** — the loop for **classic Antech**, API generation V3. dmi-api's provider id
  is the bare `antech` (it predates V6); the harness key carries the generation so nothing derived
  from it — files, env variables, the workflow's `paths:` glob — can be confused with the
  `antech-v6` loop's. dmi-api + ActiveMQ + Redis + the **antech-v3 mock** (`src/antech-v3-mock`,
  built from this repo) + the **real `dmi-engine-antech-integration`** container (the repo keeps its
  name), behind the `antech-v3` compose profile. Runs `scenarios/antech-v3-full-stack.e2e.ts`.
- **`zoetis`** — the loop for **Zoetis VetSync v1** (provider id `zoetis`). dmi-api +
  ActiveMQ + Redis + the **Zoetis mock** (`src/zoetis-mock`, built from this repo) + the **real
  `dmi-engine-zoetis-integration`** container, behind the `zoetis` compose profile. Runs
  `scenarios/zoetis-full-stack.e2e.ts`.
- **`antech-v6`** — the loop for **Antech V6**, Antech's newer API generation and a separate dmi-api
  provider (`antech-v6`, next to the classic `antech`). A different kind of loop: the integration
  (`dmi-engine-antech-v6-integration`) is an npm module, not a container, so what boots is the
  **real `dmi-engine`** — the process that hosts it in production — **twice, as prod runs it**: an
  `api` process (MQTT handlers) and a `worker` process (Bull polling), from one image built from the
  sibling `dmi-engine` checkout with the antech-v6 **and** wisdom-panel modules injected from their
  own sibling checkouts (the engine's Dockerfile would install the published packages instead) and
  both loaded, as in production — a boot-time incompatibility between them fails this loop too.
  Plus dmi-api + ActiveMQ + Redis + the **antech-v6 mock** (`src/antech-v6-mock`), behind the
  `antech-v6` compose profile. Runs `scenarios/antech-v6-full-stack.e2e.ts`. Its last describe
  restarts the engine's worker with Redis stopped: the worker must exit with code 1, naming every
  queue it could not initialize, which the engine services' `restart: on-failure` relies on, and must
  be polling again once Redis is back ([dmi-engine#68](https://github.com/nominal-systems/dmi-engine/pull/68)).
  In November 2026 production twice saw Antech V6 return records the integration had already
  acknowledged, unchanged, on every poll and on both feeds, while answering every `AckStatus` 200,
  until it stopped by itself: the same results from `GetAllResults`, and the same orders from the
  labOrder status feed, each fetched with a freshly generated order form (TRF), whose bytes differ
  on every fetch. The mock models both, from what production showed (load-bearing details 8 and 9
  in its header): its TRF endpoint serves a new document per fetch and keeps each one's digest
  (`trfDigests` on `GET /__control__/orders/<id>`), beside the provider status of the delivery it
  went out with (`trfOrderStatuses`), and
  `POST /__control__/orders/<id>/redelivery` with `{results, orders}`, each `true` or `false`,
  switches one order into that redelivery, per feed, and out again. While a feed is on, the
  order's record is served on every poll whether or not it was acknowledged, its acknowledgements
  are answered and recorded, and the window's counters (`redelivery.results` /
  `redelivery.orders`: `served`, `acked`) count both; switched off, a record acknowledged in the
  window leaves the feed. Re-seeding a result leaves the switch as it is, and each result lists the
  `GetAllResults` calls that carried it (`servedInCalls` on `GET /__control__/orders/<id>/result`).
  With it, the loop asserts
  [dmi-api#409](https://github.com/nominal-systems/dmi-api/issues/409): an identical redelivered
  result writes nothing and sends no `report:updated` or `order:updated`, while another order's new
  result served in the same `GetAllResults` response is still reported (so the silence is not a
  handler that failed); an amendment made while
  the result is being redelivered still reaches the report, and is reported once however often it
  is redelivered after; an order re-offered with a regenerated order form sends no `order:updated`
  and keeps the form first stored, while another order's status change read in the same poll is
  still applied (so the silence is not a handler that failed); a status change to the re-offered
  order itself is one `order:updated`, stored with the form fetched for it, however often the
  changed order is re-offered after; and once the redelivery stops, both records stay off the
  feeds.
  The mock can also stop accepting the tokens it has issued while its login keeps working, as Wisdom
  Panel did after a maintenance in November 2026 (load-bearing detail 10 in its header).
  `POST /__control__/revocation` with `{status}` (401 if left out) refuses every token issued before
  it, on every endpoint that takes one, in the envelope that endpoint answers a token it does not
  take with, at that status (`/Tests/v6` answers with its own 404 whatever the status), and accepts
  every token a later login issues. It counts the calls it refused, per operation, and the logins it
  saw, and it is listed with those counts, on `GET /__control__/revocation` and beside the error
  scenarios on `GET /__control__/scenarios`, until `DELETE /__control__/revocation` disarms it and
  answers with the final counts. Disarming makes the refused tokens good again: the integration
  caches a token for 12 hours in each engine process, and a test that ended with one still held
  would leave the polls failing for the rest of the run. With it, the loop shows that a placement
  whose cached token is refused with a 401 logs in again and goes through, and that a refusal
  answered 500 makes nothing log in; and it pins, as a tripwire, that the two polls do not recover
  ([dmi-engine-antech-v6-integration#95](https://github.com/nominal-systems/dmi-engine-antech-v6-integration/issues/95)).
  An error scenario answering 429 or 503 can carry a `Retry-After` header (`retryAfter` on
  `POST /__control__/scenarios`: whole seconds, or a string sent as it is, such as an HTTP date);
  whether Antech ever sends one is not known. `GET /__control__/calls/log` lists each provider call
  as it arrived (`?operation=`, `?since=`): when, its operation and accession, how many labOrder
  status polls had been answered before it, and the status and `Retry-After` it was answered with.
  The loop uses the two to show that the integration's HTTP layer honours the header
  ([dmi-engine-common#27](https://github.com/nominal-systems/dmi-engine-common/pull/27)): a one-shot
  503 with `Retry-After: 2` on an order form is retried about two seconds later, within the same
  poll, rather than after the default 100 ms, and the form the retry fetched is the one dmi-api
  stores. Each test that arms the revocation or a `Retry-After` disarms it in a `finally` and
  checks from the counts or the call log that it fired, the describes they are in check after each
  test that nothing is left armed (as the refusals' describe does for its one-shot answers), and the
  run begins by asserting that nothing is.
  The mock also takes transport faults (see "Transport faults in the mocks") on two keys:
  `getStatus`, the status feed, whose labOrder call is the orders poll's first, and `placeOrder`,
  the order endpoint; they are listed as `faults` beside the scenarios and the revocation on
  `GET /__control__/scenarios`. A status poll held past the integration's 60 s HTTP timeout
  ([dmi-engine-antech-v6-integration#70](https://github.com/nominal-systems/dmi-engine-antech-v6-integration/pull/70))
  is given up on at 60 s and asked again within a second (dmi-engine-common's one retry), and an
  order placed meanwhile is delivered; without the timeout the held answer would simply come late.
  That test holds the poll 62 s, and is most of what it costs the loop. A placement held past the
  10 s dmi-api waits for the engine, which the provider then completes, is a tripwire for
  [dmi-api#365](https://github.com/nominal-systems/dmi-api/issues/365), beside a placement held
  3 s that is placed as usual.
- **`wisdom-panel`** — the loop for **Wisdom Panel** (provider id `wisdom-panel`), pet DNA: an
  "order" activates a physical kit the clinic already holds, there is no test catalogue and no
  cancel, and a result is breed percentages, an ideal-weight estimate, genetic health findings and a
  PDF. The same kind of loop as `antech-v6` — the integration (`dmi-engine-wisdom-panel-integration`)
  is the other npm module `dmi-engine` hosts — so it boots the **same two engine containers, from the
  same three checkouts**, under its own compose profile, against the **wisdom-panel mock**
  (`src/wisdom-panel-mock`: the OAuth2 password grant, the two JSON:API polling feeds with an
  `included` that is omitted rather than empty, kit activation, both acknowledge channels, the
  simplified genetic result, a binary vet report). Plus dmi-api + ActiveMQ + Redis, behind the
  `wisdom-panel` compose profile. Runs `scenarios/wisdom-panel-full-stack.e2e.ts`.
  Since 2026-09-22 Wisdom Panel lists a result set about twelve hours before its kit's report is
  ready, and the mock models that window from the kit's state, the way the vendor shows it: the kit
  reads `generating-report` with both of its readiness keys (`report-ready-at`, `report-ready-on`)
  null, the simplified result answers 200 with no data, and the vet report 404. A scenario seeds
  such a set with `reportPending: true` on `POST /__control__/kits/<kit>/result-sets` (with
  `additional: true` for a kit's second set), and the vendor finishes the report with
  `POST /__control__/kits/<kit>/report-ready`. The loop asserts that the integration asks for
  nothing while the report is pending and leaves the set unacknowledged, delivers it on the first
  poll after the report is ready, and delivers a kit with two sets once, acknowledging both in one
  call. The mock's header comment (load-bearing detail 9) has the measurements and their sources.
  What it asserts is the integration's answer in
  [dmi-engine-wisdom-panel-integration#51](https://github.com/nominal-systems/dmi-engine-wisdom-panel-integration/pull/51).
  `e2e-wisdom-panel.yml` builds the integration at its `main`, so the loop's job is red on those
  tests until that change merges.
  Kits activated at the provider rather than through dmi are provisioned with
  `POST /__control__/kits`, or several at once with `POST /__control__/kits/batch`
  (`{"kits": [<one kit's body>, …]}`, each naming its `code`): the mock checks every kit before it
  creates any and creates them in one go, so they reach the integration in one orders poll, and so in
  one `external_orders` batch, in the order given. A pet provisioned with `ownerLastName: null` is
  served with `owner-last-name: null`; leaving the field out is still refused. What production
  showed is dmi-api refusing orders from this feed for a null client last name, which the integration
  takes from that attribute; that the vendor sends it as an explicit null, not a missing key, is
  inferred from the error (the mock's header comment, load-bearing detail 10). The
  call log (`GET /__control__/calls`) records on each kits-feed request the ids of the kits that page
  served (`servedKitIds`), so a scenario can prove which kits travelled in one batch. The loop uses
  both to assert that one order dmi-api cannot save costs only that order
  ([dmi-api#411](https://github.com/nominal-systems/dmi-api/issues/411)).
  The mock refuses bearers in two ways (load-bearing detail 5 in its header).
  `POST /__control__/bearer {"accept": false}` refuses every bearer, the tokens issued already and
  any a login issues meanwhile, with a 401, and switched back on it accepts the same tokens again: a
  vendor that refuses whatever it is shown. The audit tripwire uses it, and the test after it shows
  the polls resuming with no new login. `POST /__control__/revocation` with `{status}` (401 if left
  out) refuses only the tokens issued before it and accepts every later one, which is what Wisdom
  did from 2026-11-23
  ([dmi-engine-wisdom-panel-integration#53](https://github.com/nominal-systems/dmi-engine-wisdom-panel-integration/issues/53)):
  the feeds answer with JSON:API's 401, and the voyager endpoints with the
  `WIS_VOY__001: You do not have permission to access these records. Must have a valid token.` 401
  production logged for every activation of that outage. It counts the calls it refused, per
  endpoint, and the logins it saw, and it is listed with those counts, on
  `GET /__control__/revocation` and on the call log, until `DELETE /__control__/revocation` disarms it
  and answers with the final counts. Disarming makes the refused tokens good again: the integration
  caches its token for ten days. Each call-log entry records the status it was answered with. The
  loop shows the revocation refusing both feeds and an activation and accepting a token issued after
  it, and pins, as a tripwire, that the integration never logs in again, so that neither feed is read
  until the revocation is lifted. Another status can be staged in the same envelopes; no test here
  does, because nothing the integration does today depends on the status (it logs in again on none,
  and with dmi-engine-common 1.7.0 its polls see a 500 whatever the vendor answered), and which
  statuses a fix should react to is what #53 is deciding.

```bash
# idexx (default): builds the mock image (no token) + the idexx integration image (needs a GitHub
# Packages read token) and boots ~7 containers alongside dmi-api:
GHP_TOKEN=$(gh auth token) HARNESS_FULL_STACK=1 npm run test:harness

# antech-v3 (classic Antech): the antech-v3 mock + the real antech integration.
GHP_TOKEN=$(gh auth token) HARNESS_FULL_STACK=1 HARNESS_STACK=antech-v3 npm run test:harness

# zoetis (VetSync v1): the Zoetis mock + the real zoetis integration.
GHP_TOKEN=$(gh auth token) HARNESS_FULL_STACK=1 HARNESS_STACK=zoetis npm run test:harness

# antech-v6: the antech-v6 mock + the real dmi-engine (api + worker), built from three sibling checkouts.
GHP_TOKEN=$(gh auth token) HARNESS_FULL_STACK=1 HARNESS_STACK=antech-v6 npm run test:harness

# wisdom-panel: the wisdom-panel mock + the same real dmi-engine (api + worker), same three checkouts.
GHP_TOKEN=$(gh auth token) HARNESS_FULL_STACK=1 HARNESS_STACK=wisdom-panel npm run test:harness
```

Each integration image builds from a sibling checkout (`../dmi-engine-idexx-integration` /
`../dmi-engine-antech-integration` / `../dmi-engine-zoetis-integration`; override with
`DMI_IDEXX_INTEGRATION_DIR` / `DMI_ANTECH_V3_INTEGRATION_DIR` / `DMI_ZOETIS_INTEGRATION_DIR` — the
registry in `src/stacks.js` lists each loop's checkouts and the variable for each) and its
`npm install` resolves `@nominal-systems/*` from GitHub Packages, so `GHP_TOKEN` (a `read:packages`
token — a `gh auth token` works) must be exported for the Docker build. All five mocks are
zero-dependency Node servers built inline, so they need no token. The fast suite needs no token.

The `antech-v6` and `wisdom-panel` loops build from the same **three** checkouts — `../dmi-engine`,
`../dmi-engine-antech-v6-integration` and `../dmi-engine-wisdom-panel-integration` (override with
`DMI_ENGINE_DIR` / `DMI_ANTECH_V6_INTEGRATION_DIR` / `DMI_WISDOM_PANEL_INTEGRATION_DIR`). The two
modules are packed from their checkouts and installed into the engine before it is built, so all
three working trees are what runs, and the run report records all three for either loop. The two
engine services carry both compose profiles (one image, built once, cached for the other loop);
each profile adds its own mock. Needs compose ≥ 2.17 (`additional_contexts`) and the same
`GHP_TOKEN` (three npm installs resolve `@nominal-systems/dmi-engine-common`).

`@nominal-systems/dmi-engine-common` is no loop's checkout: every image installs it from GitHub
Packages at the version its lockfile pins. `DMI_ENGINE_COMMON_DIR`, unset by default, builds every
loop against a dmi-engine-common checkout instead — see "Running a common candidate before a
release" below.

**The idexx loop closes end to end.** An order placed over real HTTP round-trips through the real
idexx integration and the mock provider: `POST /orders?autoSubmitOrder=true` → the integration creates
the order at the mock and runs IDEXX's confirmOrder browser handshake against it → the integration's
results poll picks up a result the scenario seeds at the mock → dmi-api writes a `FINAL` report with
test results and moves the order to `COMPLETED`, and `/events` shows the `order:*`/`report:*`
sequence. The harness talks **only to the mock**, never to live `*.vetconnectplus.com`, so runs are
deterministic, need no credentials, and place no real orders. See "The idexx mock (VetConnect Plus)"
below. One of its tests is the full-system half of dmi-api#371: the fast suite's event-store
throttling scenario proves a throttled event write is retried, but runs dmi-api in seed mode, where
no order reaches an engine; here, with every `events_v2` insert refused, the order is still sent to
the mock and comes back `SUBMITTED`, while the feed has no `order:created` for it. Its last test pins
dmi-engine-idexx-integration#88: the integration runs here as two replicas with one results worker
each (`HARNESS_IDEXX_REPLICAS`), the mock holds one poll's answer for three poll intervals so that
the next ticks fall due meanwhile — and with the held poll occupying its replica's only worker, only
the other replica can take them — and the batch must still be fetched once and confirmed once, with
one `report:updated` for it. Compose also gives the integration's results poll lock a lifetime shorter
than that hold (`HARNESS_IDEXX_RESULTS_LOCK_TTL_MS`), so the test fails as well on a lock that is not
extended while its poll runs. Before it, one `describe` fails one IDEXX call of a placement at a time
with a transport fault (see "Transport faults in the mocks"):
[dmi-engine-idexx-integration#81](https://github.com/nominal-systems/dmi-engine-idexx-integration/pull/81)'s
create timeout, with a create held past it (`HARNESS_IDEXX_CREATE_ORDER_TIMEOUT_MS`), and its manifest
fetch that no longer fails the create;
[dmi-engine-idexx-integration#83](https://github.com/nominal-systems/dmi-engine-idexx-integration/pull/83)'s
named transport errors, with a create reset or stalled and a device list cut short after its headers;
a failed confirm step that still reports the created order; a failed results confirm, whose batch a
later poll delivers again and confirms, and which the PIMS sees as one `report:updated`
([dmi-api#409](https://github.com/nominal-systems/dmi-api/issues/409)); and
[dmi-engine-idexx-integration#93](https://github.com/nominal-systems/dmi-engine-idexx-integration/issues/93)'s
tripwire, an order the confirm submitted whose manifest fetch after it fails. A describe of its own,
after the loop's, takes the stack's services away from under an integration of its own (see
"Service control" below), each test pinning a merged change: with Redis frozen, the integration fails a restart within its Redis command timeout instead
of hanging on Redis, and polling resumes once Redis answers (dmi-engine-idexx-integration#74); after
Redis is flushed, dmi-api's `ensure-integration-status` brings polling back, retrying an integration
whose engine missed its first attempt (dmi-api#346); and after a broker restart, device lookups and
order placement get their replies again, at worst after one timeout, including two lookups in flight
at once (dmi-api#367). Its last test sends dmi-api a SIGTERM with a device lookup held in flight at
the mock: the lookup gets its answer after dmi-api has stopped taking connections, and dmi-api exits
within `SHUTDOWN_TIMEOUT_MS` and is started again
([dmi-api#399](https://github.com/nominal-systems/dmi-api/pull/399)).

**The antech-v3 loop closes end to end**, the same way and with the same guarantees: `POST /orders` →
the integration logs in to the mock and places the order (`External/OrderPlacement`) → its results
poll picks up a result the scenario seeds at the mock, pulls the `LabResults/XML` document and maps
it → dmi-api writes a report with test results, moves the order to `COMPLETED`, and `/events` shows
the same sequence. It never touches a live Antech host. Two things differ from idexx and are worth
knowing before you run it:

- **It is slower.** The antech integration hardcodes both its Bull poll intervals to 30s
  (`src/config/configuration.ts`) and exposes no env knob, where idexx's are dialed down to ~3s via
  `IDEXX_*_POLLING_INTERVAL_MS`. A result can therefore sit for a full interval before the engine
  picks it up; the scenario budgets whole intervals, so a slow pass is the poll cadence, not a hang.
- **Its results are XML**, not JSON, and the mock synthesises a `<LabReport>` document that the real
  `AntechResultMapper` parses. See "The antech-v3 mock" below.

**The zoetis loop closes end to end** as well: `POST /orders` → the integration builds a `<LabReport>`
request document and places it with a single authenticated `POST /vetsync/v1/orders` → its results
poll picks up a result the scenario seeds at the mock, maps it and pushes it back, so dmi-api writes a
`FINAL` report, moves the order to `COMPLETED`, and `/events` shows the same sequence. It never
touches a live Zoetis host. What differs from the other two:

- **It is slow, like antech, and for the same reason**: the zoetis integration hardcodes both Bull
  poll intervals to 30s (`src/config/configuration.ts`) with no env knob.
- **Everything is XML in both directions**, and the integration parses it with `xmlbuilder2`'s object
  format — so element *multiplicity* is load-bearing in several places. See "The Zoetis mock" below.
- **It has two acknowledge channels**, and the scenario asserts both: results ack as a batch, orders
  ack one at a time by POSTing to an `href` the order-status document itself advertises.
- **Its species and sex really are ref-mapped**, which made it the first loop where the scenario could
  assert dmi-api's ref mapping end to end; the antech and idexx loops now do the same for species, sex
  and breed. Why it takes a value assertion: the *Ref-mapped fields need value assertions* rule in
  [CLAUDE.md](CLAUDE.md).

### Running a common candidate before a release

A change on dmi-engine-common's `main`, or on a branch of it, reaches the loops only once it is
released and a lockfile moves to it. To run the loops against it first, point
`DMI_ENGINE_COMMON_DIR` at the checkout:

```bash
DMI_ENGINE_COMMON_DIR=../dmi-engine-common HARNESS_FULL_STACK=1 HARNESS_STACK=antech-v6 npm run test:harness
scripts/slot-tree.sh 3 --common antech-v6 idexx   # or a tree whose .env sets it for every run there
```

The checkout is built and packed (`npm ci`, `npm run build`, `npm pack`) inside each image build,
and the pack is the only copy of the package in the image; the build fails if any other copy is
left (its version number can be the published one's, so npm could otherwise keep one quietly).

The variable may come from the environment or from the checkout's `.env`, in any form compose
accepts there (`export`, `KEY: value`, quotes, a later line overriding an earlier one), and an
empty value means unset. The harness does not read `.env` for it: it asks compose
(`docker compose config` on the engine service) what the engine build will use, and goes by that
answer for every loop, so the report cannot record the published package while an image builds the
checkout, or the reverse. A value that compose resolves to anything but a dmi-engine-common
checkout is refused before anything is built, naming the variable and where it came from; a build
by hand with such a value fails at its first stage, naming the variable. Whether the variable is
set is all that decides: unset, the placeholder context `src/published-common` is ignored whatever
it holds. How each image takes it:

- **The engine image** (`antech-v6`, `wisdom-panel`): both modules compile against the checkout, and
  the engine installs it with them, so engine and modules compile and run against it.
- **The standalone integrations** (`idexx`, `antech-v3`, `zoetis`) are built from their own repos'
  Dockerfiles, which this repo does not change. The harness then adds
  `docker-compose.common-checkout.yml`, which builds each one first exactly as `docker-compose.yml`
  does and then installs the checkout over the published package in that image. The integration's
  code is therefore compiled against the version its lockfile pins and run against the checkout: a
  change in the checkout's types shows in the engine image's build, not here. By hand, a bare
  `docker compose` needs `-f docker-compose.yml -f docker-compose.common-checkout.yml`; a tree made
  with `--common` names both in its `.env`. A new standalone loop needs a block of its own there:
  with the variable set, the harness asks compose which images the loop builds and refuses the run,
  naming the service, if one of them would not take the checkout. The override relies on compose's
  `service:` build contexts and the build-only services they reference; it has been run with Docker
  Compose v5.8.0, and no earlier version has been tried.

**dmi-api is not covered.** It depends on dmi-engine-common too (`ProviderError`, the
shared-subscription decorators, the result types), but the harness runs it on the host from
`DMI_API_DIR`, out of that checkout's own `node_modules`, and builds no image of it: it keeps the
version its own lockfile installed, whatever `DMI_ENGINE_COMMON_DIR` says. A candidate run
therefore proves the images' side of a common change only; dmi-api's side is proven once dmi-api's
own dependency moves to the release and the loops run again.

The run report records the checkout like any other (`git describe`, path, and
`(DMI_ENGINE_COMMON_DIR)`); a run without it records `published <version> in the image`, the version
the lockfile of the image's repo pins, and `version unknown` instead when that lockfile pins none or
when a checkout asks for a range the pinned version is outside (a provider module the engine image
installs, say: npm then installs another). Either way, a line of its own, `dmi-engine-common in
dmi-api`, records the copy dmi-api ran with: the version installed in its `node_modules` and where it
came from (a link, yalc, or the host npm fetched it from), or its lockfile's when nothing is installed. The fast suite builds no image, so
it ignores the variable and says so in its setup log. Expect the tripwires that track a
dmi-engine-common defect to fire when the checkout fixes it: *"Failing test passed even though it was supposed to fail"* is the
candidate doing what it should, not a broken run. Leave their markers in place: they come out in
the companion change once the release reaches the loops' own builds (see "Tripwires").

### The idexx mock (VetConnect Plus)

`src/idexx-mock/server.js` is a small, zero-dependency Node HTTP server that stands in for IDEXX (its VetConnect Plus API). It speaks IDEXX's **public, documented dialect** (developer.vetconnectplus.com)
closely enough for the real integration to drive it unmodified:

- **Ordering** (`/api/v1/*`): `POST /order`, `GET/DELETE /order/:id`, the external-orders poll, auth
  validate, and reference data — including the test catalogue (`/ref/tests`) and the clinic's one
  IVLS analyzer (`/ivls/devices`). The catalogue carries one in-house code and one genuine
  reference-lab code, so both halves of the integration's device rule execute. The device list
  is also what `GET /providers/idexx/devices` returns through dmi-api, and its `ivlsDevices` scenario
  fails it with the `ErrorResponse` IDEXX's spec gives that endpoint's 500. The integration reads
  the `inHouse` flag to decide whether an order must carry a device, and the mock enforces the
  in-house half at placement: an in-house order without an `ivls` serial, or with one the clinic does
  not own, is refused. The reference-lab half — the integration strips the devices it was given — is
  echoed, not enforced: the provider's tolerance of a device on such an order is unverified, so the
  scenario pins the empty device list at the control plane instead.
- **confirmOrder handshake**: `POST /order` returns a `uiURL` that points back at the mock; the mock
  serves that HTML page (setting a cookie), then accepts the follow-up XHR `GET`/`PUT` the
  integration issues to submit the order. The `PUT` answers with the order's `pdfURL`, which the
  integration reads from that answer and fetches once more after the submission. That the live
  confirm answers with one is the integration's reading of it (`IdexxConfirmOrderResponse`), not
  something probed here.
- **Manifest**: the create answer carries a `pdfURL` in IDEXX's shape, `/api/v1/pdf/<order id>?token=
  <token>&orderId=<order id>`, pointing back at the mock, and the mock serves the order's form there
  as a real PDF (synthetic text naming the order). Like every ordering call it needs HTTP Basic, and
  the token must be the order's: a URL rebuilt without it is answered 404, like an unknown order (a
  body of the mock's own; IDEXX's answer to a bad token has not been seen). So every placement runs
  the integration's manifest fetch: once after the create, and with autoSubmitOrder once more after
  the confirm. `GET /__control__/orders/<requisition>` reports the order's `pdfURL`, the order's status
  at each fetch the mock answered (`manifestFetches`) and the SHA-256 of the PDF (`pdfSha256`), so a
  test can tell which fetches ran and that dmi-api stored these bytes.
- **Results** (`/api/v3/*`): the latest-results batch poll, its `confirm/:batchId` ack, and search.
  A batch stays on the poll until it is confirmed — a result that arrives meanwhile joins the next
  batch, formed after the confirm, as IDEXX's spec has each batch acknowledged before the next can be
  downloaded — and only the batch being served can be confirmed: a confirm of any other id — one
  already confirmed, or one never served — answers IDEXX's own 404
  `{"error":"INVALID_BATCH_ID","message":"Invalid batch ID: <id>","status":"NOT_FOUND"}`, as its
  live API does, so an integration that confirms one batch twice sees what it would in production.
- **Control plane** (`/__control__/*`, host-facing): tests seed a (synthetic) result for an order,
  list the orders the mock received, reset state, and inject error scenarios. This is how the
  order→result→report loop is made deterministic — the mock holds no results until a test seeds one.
  `GET /__control__/batches` is the ledger of every results batch the mock formed: the requisition
  ids its results carry, how many poll answers carried it, and how each confirm of it was answered.
  The `resultsLatestDelay` scenario (`{ delayMs, once }`) holds the next poll answer that carries a
  batch for `delayMs`, its content fixed on arrival, and the ledger counts the polls that reached
  the mock meanwhile: it is how the loop puts two polls of one integration in flight at once.
  `GET /__control__/scenarios` lists everything armed — the status scenarios (with `hits`; a `once`
  scenario leaves the list when it is used) and the transport faults — and
  `DELETE /__control__/scenarios/<key>` disarms one key. The status-scenario keys are
  `authValidate`, `createOrder`, `resultsLatest`, `ivlsDevices` and `resultsLatestDelay`; a scenario
  on any other key is refused.
- **Transport faults** (see "Transport faults in the mocks" below) are armed on `createOrder`, the
  three steps of the confirmOrder handshake (`uiPage` the UI page, `uiOrderGet` the order setup,
  `uiOrderPut` the submission), `manifest` (the PDF), `ivlsDevices` and `resultsConfirm`. A confirm a
  fault takes never reaches the batch, which stays the one being served, and the batch ledger
  records only the confirms the route answered. `resultsLatestDelay` stays a scenario of its own
  rather than a `hold`: it waits for
  the first answer that carries a batch, letting empty polls through, and the batch ledger counts
  the polls that reach the mock while it holds. The dmi-engine-idexx-integration#88 test reads both.
  A `hold` on a route takes its next request, whatever the answer.

All of the mock's canned data is **synthetic** — invented values shaped like IDEXX responses, never
captured clinic/patient data — and the mock never authenticates for real (the integration's dummy
Basic credentials and `X-Pims-*` headers are accepted as-is).

### The antech-v3 mock

`src/antech-v3-mock/server.js` is the same idea for **classic Antech (V3)**: a small, zero-dependency Node
HTTP server that stands in for the Antech provider API, speaking its `/api/v1.1` dialect closely enough
for the real integration to drive it unmodified. Unlike IDEXX's, Antech's dialect is not publicly
documented, so the contract mirrored here was read out of the integration's own source
(`antech.service.ts`, `mapper/antech-result.mapper.ts`, `interceptors/antech-api.interceptor.ts`):

- **Auth**: `POST Users/login` mints a `Token`, which the integration replays as an `?accessToken=`
  **query param** on every subsequent call — including POSTs. It logs in again before *every single
  request* (there is no token cache upstream), so this endpoint is hit several times per poll.
- **Ordering**: `POST External/OrderPlacement`. Its response **body is the externalId** — the
  integration assigns the raw body with no field access — and results are later correlated by
  `ClinicAccessionID`, so the mock echoes the requisition id back. `LabOrders/PDFPIMS` serves the PDF
  manifest, fetched on every order creation.
- **Polling**: `GET External/GetStatus?serviceType=labOrder|labResult` returns items pending
  acknowledgement (`overrideAck=true` bypasses that), and `POST External/AckStatus` acknowledges a
  batch. The mock models the acknowledge state, so a placed order does not replay on every tick.
- **Results**: `GET LabResults/XML` returns a `<LabReport>` document. This is the fussy part — the
  integration parses it with `xmlbuilder2`'s object format, so element shape is load-bearing:
  `<Species>`/`<Breed>` must carry an attribute (the mapper reads their `'#'` text node),
  `<Units>`/`<Comment>` must be **CDATA** (it reads their `'$'` node, and plain text silently drops
  the units), and `<Accession-ID>` must repeat with both `Type="Lab-AccID"` and
  `Type="Requisition-ID"`. The status JSON and the XML are joined on `LabAccessionID` **and** on
  `LabTests[].DisplayName` matching `<UnitCode><Name>` byte-for-byte, so the mock generates both from
  one constant rather than writing the name out twice.
- **Control plane** (`/__control__/*`, host-facing): seed a (synthetic) result for an order, list or
  inspect the orders the mock received, read its service catalogue, reset state, and inject error
  scenarios — the same determinism story as the idexx mock: no results exist until a test seeds one.

**It validates rather than defaults, deliberately.** A mock that quietly substitutes its own value
for a field the integration failed to send doesn't test the integration — it agrees with it, and the
assertions downstream then pass against the mock's own invention. So order placement **rejects** a
request missing the patient name, sex, species, breed, client/doctor surname or tests; login rejects
missing credentials (their *values* are dummy and unchecked, but their *presence* is contract); and
placement rejects any test code outside the mock's service catalogue, which is the same list its
`External/ServiceList` advertises. Antech mnemonics are 4–7 characters (`SA804`, `S16100`, `T960`) —
notably **not** the bare `SA` the IDEXX mock uses, which is how an IDEXX-shaped placeholder can drift
into an Antech test and pass against a permissive mock.

All of its canned data is **synthetic** — invented values shaped like Antech responses, never
captured clinic/patient data. The service mnemonics are genuine Antech catalogue codes (provider
identifiers published to integrators, not clinic or patient data); the descriptions and prices
attached to them are invented. It never authenticates for real: the token is a fixed dummy.

### The Zoetis mock

`src/zoetis-mock/server.js` is the same idea for **Zoetis VetSync v1**: a zero-dependency Node HTTP
server speaking the `/vetsync/v1` dialect closely enough for the real integration to drive it
unmodified. As with Antech, the dialect is not publicly documented, so the contract was read out of
the integration's own source (`zoetis.service.ts`, `helpers/zoetis-order.helper.ts`,
`helpers/zoetis-responses.helper.ts`, `mappers/zoetis.mapper.ts`,
`interceptors/zoetis-api.interceptor.ts`):

- **Auth**: HTTP Basic, with a **domain-style username** the integration builds as
  `` `${partnerId}\${clientId}` `` — joining a provider *configuration* field to an *integration*
  option. Values are dummy and unchecked; presence, and the fact that the join happened, are enforced.
- **Ordering**: a single `POST /vetsync/v1/orders` carrying a `<LabReport>` request document. The
  response is the order-status document, whose `client_order_id` the integration assigns as **both**
  the requisitionId and the externalId — which is the whole of Zoetis reconciliation.
- **Polling and the two acks**: `GET /orders` lists orders whose status the practice has not
  acknowledged, and each is acked individually by POSTing to the `href` of its `acknowledged` link;
  `GET /orders/batch/results` serves unacked results, acked as a batch via
  `POST /orders/batch/acknowledged`. The mock models both, so neither poll replays forever.
- **Reference data**: `/services` (the enforced catalogue), `/species`, `/genders`, `/devices`. There
  is deliberately **no `/breeds`** — the integration's `getBreeds` is a no-op that never calls the
  provider, so an endpoint would be fiction.
- **Control plane** (`/__control__/*`, host-facing): seed a result, list/inspect received orders, read
  the catalogue, reset, inject error scenarios — the same determinism story as the other two mocks.
  Two more are Zoetis's own. `POST /__control__/orders/<ref>/cancel` cancels an order as the provider
  would of its own accord, with no call from the practice. Since dmi-api#409, dmi-api leaves alone an
  order delivered in the state it already holds, so the order dmi-api cancels itself only shows that
  its CANCELLED delivery changes nothing. The provider-cancelled order is the one that shows dmi-api
  accepting the orders poll's CANCELLED reading (SUBMITTED → CANCELLED, one `order:updated`). The
  feeds view counts the orders feeds served, and each order records the last feed that listed it. A
  scenario can then tell that two orders arrived in one `external_orders` message, and wait for a
  later poll cycle instead of sleeping.

**Element multiplicity is the fussy part here**, where Antech's was CDATA and attribute sensitivity.
`xmlbuilder2`'s object format gives an object for a lone child and an array for repeated ones, and
the integration consumes several of these as arrays — so the mock always emits **≥ 2** of:
order-status `<link>`, `<LabResultItem>`, `<Section>`, `<specie>`, `<gender>`, `<Device>`. The mirror
image of the same rule: an **empty `<LabResults/>` is not equivalent to an absent one**, because
`getTests` branches on falsiness and `{}` is truthy — so an order with no result yet omits the
element entirely.

**Errors go back as JSON while every success is XML**, deliberately. The integration's
`providerErrorMapper` reads `error.response.data.error.context`, which axios only ever produces from a
JSON body; an XML error body would leave `data` a string and send the mapper down its generic
fallback, so a rejection test would go red without ever exercising the real branch. Same lesson as the
Antech `ModelState` envelope.

**It validates rather than defaults**, for the same reasons the Antech mock does — and one more that
is specific to this loop. Order placement rejects a missing animal name, species, breed, gender,
owner or vet name, client id, practice ref or tests; it rejects a duplicate practice ref; and it
**enforces its own species, gender and service vocabularies**. That last one matters because species
and sex are the only order fields dmi-api actually *transforms* on the way to the provider: a ref
mapping that silently stopped resolving would otherwise produce a well-formed order the mock accepted,
keeping the gate green while the provider received a code it had never heard of.

All of its canned data is **synthetic**. The service codes (`CDP`, `HEM`, `T4`) and analyte codes
(`GLU`, `CRE`, `ALT`, `ALB`) are genuine Zoetis catalogue identifiers — provider codes published to
integrators, not clinic or patient data — and every name, value, unit and range attached to them is
invented. It never authenticates for real, and it builds the `link href`s it advertises from the
request's own `Host` header, so even the URLs the integration POSTs back to resolve to the mock rather
than anywhere real.

### Transport faults in the mocks

A status scenario answers a call with the wrong thing. Some failures are not an answer at all: the
answer comes late, the connection closes with no answer, or the headers arrive and the body never
finishes. `src/mock-faults/index.js` stages those three, and every mock that wires it stages them
the same way. It is zero-dependency CommonJS like the mocks. Each mock image copies it beside its
server through a second named build context (`additional_contexts: mock-faults` in
docker-compose.yml), so the server requires it as `../mock-faults` in the repo and in the image alike.

A fault is armed on one of the mock's **route keys** over the control route its status scenarios
use, for the next `times` requests to that route (default 1). After those the route answers as
usual again. The model is the Mongo failpoint in `src/mongo.ts`: one target, a number of attempts,
and a count of what it hit, read back to prove the fault fired.

| `fault` | Options | What the mock does | What a Node client sees (Node 20, axios on `http`) |
|---|---|---|---|
| `hold` | `delayMs` (required, ≤ 10 min) | Runs the route's handler on arrival, so its answer and whatever else it does (an order created, a scenario used up) are fixed then, and sends the answer `delayMs` later. | The answer, late. A client whose timeout is shorter gives up first and gets nothing. |
| `reset` | `close`: `rst` (default) or `fin` | Never runs the route. Once the request has arrived whole, closes the connection with no response: a TCP RST (`socket.resetAndDestroy()`), or a plain FIN (`socket.destroy()`). | `rst`: `ECONNRESET`, "read ECONNRESET". `fin`: `ECONNRESET`, "socket hang up". The same for GET and POST, with keep-alive or without. |
| `stall` | `bytes` (default 0), `capMs` (default 120 s, ≤ 10 min) | Runs the route's handler on arrival, sends its status line and headers and the first `bytes` bytes of its body (never all of it: the headers still announce its full length), then nothing. After `capMs` the connection is closed. | A response whose body never completes. Its own timeout fires, or, at `capMs`, the body is cut short. axios (1.17, as the idexx integration has it) reports both alike, with the response attached: `ERR_BAD_RESPONSE`, "stream has been aborted", not a timeout. |

```
POST   /__control__/scenarios           {"key": "createOrder", "fault": "hold", "delayMs": 15000}
                                         -> {"ok": true, "key": "createOrder", "fault": {"id": 7, ...}}
GET    /__control__/scenarios           -> {"scenarios": {...}, "faults": {"createOrder": {...}}}
DELETE /__control__/scenarios/<key>?id=<id>   -> {"scenario": null, "fault": {... its final count ...}}
POST   /__control__/reset
```

A fault reads back as `{id, fault, <its options>, times, hits, remaining, open, requests}`. `requests`
lists, in arrival order, each request it took: its `outcome` and the milliseconds from arrival to
it (`ms`, null while open). The outcomes are `held` and `stalled` (still open), `answered` (a hold
sent its answer), `client-closed` (the client closed the connection first, e.g. on its own
timeout), `capped` (a stall reached `capMs`), `destroyed` (disarmed or reset while open), and
`reset`. A fault stays listed once it is used up, with that record, until it is disarmed. Options
a fault does not take, and keys the mock does not have, are refused with a 400 naming the allowed
ones.

**Nothing leaks into the next test.**

- Disarming a key (`DELETE`) and `POST /__control__/reset` destroy every connection its fault still
  holds or stalls. The client sees the request fail; it never gets a late answer.
- Every open connection also has its own end: a hold's `delayMs`, a stall's `capMs`.
- `DELETE …?id=<id>` disarms the fault only while it is that arming, so a cleanup that runs late
  (after a jest timeout) cannot disarm the next test's fault on the same key.

A scenario that arms a fault disarms it in a `finally` with its id. It then asserts the count the
`DELETE` returns: a fault that never fired fails the test. A `describe` that arms faults asserts at
its start that nothing is armed, and after each test, that the test left nothing armed.

**Wiring it into a mock** is three things:

- `const faults = createFaults({ keys, log })`;
- `if (faults.intercept('<key>', req, res)) return` as the first line of each route's handler;
- the control routes above calling `faults.arm`, `faults.list`, `faults.disarm` and `faults.reset`.

`intercept` answers true only for a reset, which has taken the request. For a hold or a stall the
handler answers as it always does, and the module sends that answer late or in part. A key is wired
only together with a test that arms a fault on it. Which keys each mock has is in its own section.

### The MQTT broker

The harness broker is **`eclipse-mosquitto:2`**, not ActiveMQ. dmi-api and the provider integrations
talk to the engine over MQTT using dmi-engine-common's shared-subscription patterns, which subscribe
to `$share/<group>/<topic>` — an **MQTT 5.0 shared subscription**. ActiveMQ 5.x "classic" (the broker
the foundation started with) speaks only MQTT 3.1.1 and silently treats `$share/...` as a literal
topic, so nothing is delivered: the engine RPCs and the inbound result/event streams never arrive and
the loop can't close. Mosquitto routes shared subscriptions for both MQTT 3.1.1 and 5.0 clients. The
compose service is still named `activemq` so all `ACTIVEMQ_*` / `MQTT_HOST` configuration is
unchanged, and dmi-api's `activemq: up` health check (a generic MQTT ping) still passes, so the fast
suite is unaffected.

### Service control: the broker, Redis, an engine or dmi-api taken away mid-run

A scenario can take one service of its own stack away and put it back, to test what happens while
it is gone and after it returns. `src/services.ts` stops, starts, pauses, unpauses or restarts a
compose service of the run's project — the broker (`activemq`), `redis`, an engine container —
flushes Redis, and stops dmi-api with a signal and starts it again (`src/dmi-api.ts` keeps the
processes).
The Mongo failpoint (`src/mongo.ts`) is the model: a fault is scoped to one target, the harness
undoes it, and it reports what it reached, so a test asserts that it fired.

```ts
const faults = serviceFaults()                    // this test's controls
let paused: Disruption
try {
  paused = await faults.pause(REDIS)              // or stop(), restart(), flushRedis()
  /* … the test, with Redis frozen … */
} finally {
  await faults.restore(REDIS)
}
expect(paused.containers).toEqual([`${env.composeProject}-redis-1`])
```

- **Only this run's containers.** Every operation goes through the harness's own compose invocation
  (`compose()` in `src/containers.ts`: the files, profile and project `composeUp` uses, the project
  named with `-p` as well as through `COMPOSE_PROJECT_NAME`, so that it does not depend on the
  environment of the process that calls it), and is first run in compose's `--dry-run` mode:
  compose names the containers the command would touch, and the command is refused unless each one
  is a container compose lists for the slot's project. Pausing one replica of a replicated service
  (`pause(service, { replica: n })`) has no compose command; the container is the one compose lists
  for that replica, and `docker pause` gets its id.
- **Nothing stays down.** Each fault is entered in a ledger as it is made (`disrupted()` lists it:
  service, fault, containers, since when, by which test). `restoreServices()` undoes every entry,
  waits until compose reports every container of the project running, and checks each restored
  service answers (Redis a `PING`, the broker an MQTT publish, MySQL a query, the mock `/status`);
  it throws naming whatever is still down. A describe that injects faults calls it from
  `afterEach`, so a test that fails or times out midway still hands the next test a whole stack,
  and asserts at its start, with `assertStackWhole()`, that every container is running and nothing
  is in the ledger. A test's controls (`serviceFaults()`) stop working once `restoreServices()` has
  run after it: jest keeps running a test body it abandoned on a timeout, and that body must not
  fault the stack under the next test.
- **Redis.** `flushRedis()` empties it (`FLUSHALL`, through `redis-cli` in the container: no client
  library) and reports the key count before and after; `repeatableJobsNaming(id)` lists the Bull
  repeat registrations that name an integration; `redisAnswers(ms)` says whether Redis answers a
  `PING` on its published port. A paused Redis accepts the connection and never answers.
- **What an engine did.** `watchExits(service)` collects the exit code of each of the service's
  containers as it exits, from Docker's event stream: a container under a restart policy is up
  again before its state could be read, and the daemon keeps too few past events, for every
  container on the machine, to be asked afterwards. `serviceLogs(service, since)` reads its log.
- **dmi-api.** Global setup starts dmi-api, and a scenario cannot see that process's handle: it runs
  in a module registry of its own (in band, in jest's main process, with `maxWorkers: 1`; in a
  worker otherwise). So every dmi-api a run starts is recorded, with its exit as its parent saw it,
  in a file of the slot's beside its lock (`~/.cache/dmi-e2e/slot-locks/slot-<n>.dmi-api.json`).
  `faults.stopDmiApi('SIGTERM')` enters dmi-api in the ledger as the signal goes out, and resolves
  once it has exited, with how long that took and how: a code (1 is dmi-api's shutdown timeout) or
  the signal (a shutdown that finished re-raises it). Restoring it, from the test's `finally` or
  from `afterEach`, waits for that process to be gone (15 s at most, then kills it) and starts
  dmi-api again from the run's build (`startDmiApi({ build: false, startedBy })`), so a test that
  fails right after the signal still hands the next one a healthy dmi-api. Global teardown stops
  every dmi-api the file lists as alive, whoever started it, so no run leaves one holding the slot's
  port. `runDmiApiScript(script, args)` runs one of
  dmi-api's npm scripts from the checkout under test with the app's environment, the way an operator
  runs `ensure-integration-status` beside a deployment.
- **A kept-up stack.** Global setup unpauses any container a killed run left paused (`compose up`
  refuses a paused container), and does not go on until every container of the project is running.

### Ports

Shifted off dmi-api's defaults so a developer's dev stack can keep running alongside the harness.
These are slot 0's; slot n adds 10 × n to every one (see "Parallel runs — slots").

| Service  | Harness | dmi-api default |
|----------|---------|-----------------|
| dmi-api  | 3010    | 3000            |
| MySQL    | 3307    | 3306            |
| Mongo    | 27018   | 27017           |
| ActiveMQ | 1884    | 1883            |

Full-system services (behind a compose profile — only the selected loop's ports are published):

| Service            | Harness | Profile     | Notes |
|--------------------|---------|-------------|-------|
| VetConnect Plus mock | 3012  | `idexx`     | the simulated IDEXX provider; tests drive its `/__control__` plane |
| antech-v3 mock     | 3013    | `antech-v3` | the simulated classic-Antech provider; tests drive its `/__control__` plane |
| Zoetis mock        | 3014    | `zoetis`    | the simulated Zoetis provider; tests drive its `/__control__` plane |
| antech-v6 mock     | 3015    | `antech-v6` | the simulated Antech V6 provider; tests drive its `/__control__` plane. The two `dmi-engine` containers publish no port |
| wisdom-panel mock  | 3016    | `wisdom-panel` | the simulated Wisdom Panel provider; tests drive its `/__control__` plane. Same two `dmi-engine` containers, no port |
| Redis              | 6380    | all         | the integration's Bull queues |

### CI

Six GitHub Actions workflows run the suites: `e2e.yml` the fast suite, and one workflow per loop
(`e2e-idexx.yml`, `e2e-antech-v3.yml`, `e2e-zoetis.yml`, `e2e-antech-v6.yml`,
`e2e-wisdom-panel.yml`). Each loop has a workflow of its own because it needs a `paths:` filter, and
those are per workflow, not per job — a filter in `e2e.yml` would gate the fast suite too. Each
loop workflow's header comment carries its reasoning.

- **Push to `main`**: every workflow, always.
- **Pull request**: the fast suite always. A loop only when the harness or a mock (`src/`), compose,
  the jest or TypeScript config, the dependencies, its own workflow or that loop's scenario changes:
  a docs or tenant-isolation edit should not pay for ~7 containers per provider. A loop also skips a
  pull request from a **fork**, which cannot read the org secrets it needs.
- **Nightly** (`schedule:`): every workflow, at 03:17 UTC — wisdom-panel at 03:37, twenty minutes
  after antech-v6, which builds the same engine image. dmi-api and the integrations are checked out
  at `main` and move without a pull request here to trigger a run, so the nightly is what surfaces
  their drift within a day.
- **On demand**: `workflow_dispatch`, every workflow.

## Environment

Every variable has a working default; the table exists so CI and debugging are not guesswork. Port
defaults are slot 0's: under `HARNESS_SLOT=n` each is 10 × n higher.

| Variable | Default | Purpose |
|---|---|---|
| `HARNESS_SLOT` | the checkout's `.harness-slot`, else `0` | Which slot the run occupies (0–99): every host port + 10 × slot, compose project `dmi-e2e-s<n>`. See "Parallel runs — slots". |
| `HARNESS_LOCK_DIR` | `~/.cache/dmi-e2e/slot-locks` | Where the per-slot locks live. Must be one directory for every run sharing a Docker daemon. |
| `DMI_SLOTS_DIR` | `slots/` beside the main dmi-e2e clone | `scripts/slot-tree.sh` only: where slot trees are created. |
| `DMI_API_DIR` | `../dmi-api` | dmi-api checkout to build, migrate and run. Ignored when `HARNESS_MANAGE_APP=0`. |
| `DMI_ENGINE_COMMON_DIR` | unset: the published package | full-stack only (every loop). A dmi-engine-common checkout to build every image against instead of the version each lockfile pins; refused unless it is one. Never defaulted to `../dmi-engine-common`. From the environment, else from the checkout's `.env`: the harness asks compose how it resolves it rather than reading `.env` itself. See "Running a common candidate before a release". |
| `HARNESS_HOST` | `127.0.0.1` | Host that the published container ports are reachable on. A single knob; each per-service `*_HOST` var (and the Mongo URI) defaults to it, so pointing the suite at a remote docker host is one variable. |
| `HARNESS_FULL_STACK` | `0` | `1` selects a full-system suite instead of the default fast suite. See "Full-system mode". |
| `HARNESS_STACK` | `idexx` | Which full-system loop `HARNESS_FULL_STACK=1` runs — a key of the stack registry in `src/stacks.js`: `idexx` (real idexx integration + VetConnect Plus mock), `antech-v3` (real classic-Antech integration + antech-v3 mock; dmi-api's provider id is the bare `antech`), `zoetis` (real zoetis integration + Zoetis mock), `antech-v6` (the real dmi-engine as api + worker + antech-v6 mock) or `wisdom-panel` (the same dmi-engine + wisdom-panel mock). Anything else is refused — including the old `antech`. |
| `HARNESS_BASE_URL` | `http://127.0.0.1:3010` | dmi-api under test. Setting it implies `HARNESS_MANAGE_APP=0`. |
| `HARNESS_APP_PORT` | `3010` | Port the harness starts dmi-api on. |
| `HARNESS_ADMIN_USERNAME` / `_PASSWORD` | `admin` / `admin` | Basic-auth admin, for `POST /users`. |
| `HARNESS_SECRET_KEY` | a 32-byte literal | `aes-256-ctr` key for provider-config encryption. Must be exactly 32 bytes. |
| `HARNESS_JWT_SECRET_KEY` | `harness-jwt-secret` | |
| `HARNESS_MYSQL_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_DATABASE` | `127.0.0.1` / `3307` / `root` / `harness` / `dmi_harness` | Also consumed by `docker-compose.yml`. |
| `HARNESS_MONGO_URI` | `mongodb://127.0.0.1:27018/dmi_harness` | |
| `HARNESS_MONGO_PORT` | `27018` | Host port published by the Mongo container. |
| `HARNESS_ACTIVEMQ_HOST` / `_PORT` | `127.0.0.1` / `1884` | |
| `HARNESS_IDEXX_MOCK_PORT` | `3012` | idexx only. Host port for the VetConnect Plus mock (its `/__control__` plane and `/status`). |
| `HARNESS_IDEXX_MOCK_URL` | `http://$HARNESS_HOST:3012` | idexx only. Host-facing mock base URL the scenario drives. |
| `HARNESS_IDEXX_ORDERING_URL` / `_RESULT_URL` | `http://idexx-mock:3000` | idexx only. Compose-network base URLs stored in the provider config; the integration reaches the mock here. Never point at live `*.vetconnectplus.com`. |
| `HARNESS_IDEXX_PIMS_ID` / `_PIMS_VERSION` / `_USERNAME` / `_PASSWORD` / `_LOCALE` | `dmi-e2e-harness` / `1.0.0` / `harness-user` / `harness-pass` / `en` | idexx only. Dummy provider-config PIMS headers and integration credentials; the mock never authenticates for real. |
| `HARNESS_IDEXX_POLL_MS` | `3000` | idexx only. The integration's Bull results/orders polling interval (dialed down from its 30s default so the loop closes quickly). |
| `HARNESS_IDEXX_REPLICAS` | `2` | idexx only. How many replicas of the integration container compose runs, each with the integration's default of one results worker. When the integration runs as more than one replica, two results polls of one integration can be in flight at once; with one replica the loop could never show that. The overlapping-polls test needs at least 2 and refuses to run with fewer. It reads the variable from its own environment, so set it there: a value in a slot tree's `.env` reaches compose but not the test. |
| `HARNESS_IDEXX_RESULTS_LOCK_TTL_MS` | `5000` | idexx only. How long the integration's results poll lock lasts as first taken (its `IDEXX_RESULTS_LOCK_TTL_MS`), dialed down from the integration's default so that it runs out while the overlapping-polls test still holds a poll in flight: the test then also fails on a lock that is not extended while its poll runs. It has to be a positive number of milliseconds under two poll intervals, and the test refuses to run otherwise: the integration replaces any other value with its own default, which outlasts the hold. Like `HARNESS_IDEXX_REPLICAS`, the test reads it from its own environment. |
| `HARNESS_IDEXX_HTTP_TIMEOUT_MS` | `30000` | idexx only. The integration's HTTP timeout (its `IDEXX_HTTP_TIMEOUT_MS`), at the integration's own default. It is set so that the overlapping-polls test reads the value the integration runs with: the answer that test holds for three poll intervals has to come inside it, and the test refuses to run otherwise. Like `HARNESS_IDEXX_REPLICAS`, the test reads it from its own environment. |
| `HARNESS_IDEXX_CREATE_ORDER_TIMEOUT_MS` | `5000` | idexx only. The integration's timeout for the create POST (its `IDEXX_CREATE_ORDER_TIMEOUT_MS`, 80 s by default), dialled down to under the 10 s dmi-api waits for the engine here, so that a create held past it fails at the integration, naming its timeout, before dmi-api gives up on the RPC. The held-create test refuses to run unless it is below dmi-api's `ENGINE_RESPONSE_TIMEOUT` and differs from `HARNESS_IDEXX_HTTP_TIMEOUT_MS`, which the error would otherwise not tell apart. Like `HARNESS_IDEXX_REPLICAS`, the test reads it from its own environment. |
| `HARNESS_ANTECH_V3_MOCK_PORT` | `3013` | antech-v3 only. Host port for the antech-v3 mock (its `/__control__` plane and `/status`). |
| `HARNESS_ANTECH_V3_MOCK_URL` | `http://$HARNESS_HOST:3013` | antech-v3 only. Host-facing mock base URL the scenario drives. |
| `HARNESS_ANTECH_V3_BASE_URL` | `http://antech-v3-mock:3000` | antech-v3 only. Compose-network base URL stored in the provider config; the integration appends `/api/v1.1/<endpoint>` to it. Never point at a live Antech host. |
| `HARNESS_ANTECH_V3_UI_BASE_URL` | `http://antech-v3-mock:3000` | antech-v3 only. Antech's web host. A required provider-config option, but only ever string-built into submission/manifest URIs — never fetched. Points at the mock so nothing can leak to a live host. |
| `HARNESS_ANTECH_V3_PIMS_IDENTIFIER` | `HRN` | antech-v3 only. The 3-4 letter PIMS identifier; only appears in a generated requisition id (the harness supplies its own). |
| `HARNESS_ANTECH_V3_USERNAME` / `_PASSWORD` / `_CLINIC_ID` | `harness-user` / `harness-pass` / `900001` | antech-v3 only. Dummy integration credentials; the mock never authenticates for real. |
| `HARNESS_ANTECH_V3_LAB_ID` | `1` | antech-v3 only. dmi-api declares `LabId` as an **integer** provider option and rejects a string, so this stays a number. There is deliberately no antech-v3 poll-interval knob to pair with `HARNESS_IDEXX_POLL_MS`: that integration hardcodes its Bull intervals to 30s. |
| `HARNESS_ANTECH_V6_MOCK_PORT` | `3015` | antech-v6 only. Host port for the antech-v6 mock (its `/__control__` plane and `/status`). |
| `HARNESS_ANTECH_V6_MOCK_URL` | `http://$HARNESS_HOST:3015` | antech-v6 only. Host-facing mock base URL the scenario drives. |
| `HARNESS_ANTECH_V6_BASE_URL` / `_UI_BASE_URL` | `http://antech-v6-mock:3000` | antech-v6 only. Compose-network base URLs stored in the provider config: the integration appends `/Users/v6/Login`, `/LabResults/v6/…` etc. to the first and string-builds a pre-order's `submissionUri` from the second (never fetched). Never point at a live Antech host. |
| `HARNESS_ANTECH_V6_PIMS_IDENTIFIER` | `HRN` | antech-v6 only. The 3–4 character PIMS identifier the integration requires and builds into generated accession ids. |
| `HARNESS_ANTECH_V6_USERNAME` / `_PASSWORD` / `_CLINIC_ID` / `_LAB_ID` | `harness-user` / `harness-pass` / `900001` / `1` | antech-v6 only. Dummy integration options; the mock never authenticates for real, but it refuses a clinic it is not provisioned for (`ANTECH_V6_MOCK_CLINIC_ID` on the mock side, same default). `labId` is a **string** here — dmi-api declares it so, unlike classic antech's integer `LabId`. |
| `HARNESS_ANTECH_V6_POLL_MS` | `3000` | antech-v6 only. The engine's `ANTECH_V6_POLLING_INTERVAL_MS` (60 s by default), dialled down so the loop closes quickly. |
| `HARNESS_WISDOM_PANEL_MOCK_PORT` | `3016` | wisdom-panel only. Host port for the wisdom-panel mock (its `/__control__` plane and `/status`). |
| `HARNESS_WISDOM_PANEL_MOCK_URL` | `http://$HARNESS_HOST:3016` | wisdom-panel only. Host-facing mock base URL the scenario drives. |
| `HARNESS_WISDOM_PANEL_BASE_URL` | `http://wisdom-panel-mock:3000` | wisdom-panel only. Compose-network base URL stored in the provider config: the integration appends `/oauth/token`, `/api/v1/kits`, `/api/voyager/pet` etc. Never point at a live Wisdom Panel host. |
| `HARNESS_WISDOM_PANEL_USERNAME` / `_PASSWORD` / `_ORGANIZATION_UNIT_ID` | `harness-user` / `harness-pass` / `harness-org-unit` | wisdom-panel only. Dummy **provider-configuration** values (this provider keeps its credentials on the org-level configuration, the inverse of the others); the mock never authenticates for real but refuses any other username/password (an RFC 6749 `invalid_grant`) or organization unit. Passed through to the mock as `WISDOM_PANEL_MOCK_*`. |
| `HARNESS_WISDOM_PANEL_HOSPITAL_NAME` / `_HOSPITAL_NUMBER` / `_HOSPITAL_PHONE` | `Harness Animal Hospital` / `700001` / `555-0100` | wisdom-panel only. Dummy integration options — the clinic's identity as the provider knows it. The hospital number is the filter key of both polls and is sent on every activation; the mock scopes its feeds by it. |
| `HARNESS_WISDOM_PANEL_POLL_MS` | `3000` | wisdom-panel only. The engine's `WISDOM_PANEL_POLLING_INTERVAL_MS` (10 min by default), dialled down so the loop closes quickly. |
| `HARNESS_ZOETIS_MOCK_PORT` | `3014` | zoetis only. Host port for the Zoetis mock (its `/__control__` plane and `/status`). |
| `HARNESS_ZOETIS_MOCK_URL` | `http://$HARNESS_HOST:3014` | zoetis only. Host-facing mock base URL the scenario drives. |
| `HARNESS_ZOETIS_BASE_URL` | `http://zoetis-mock:3000` | zoetis only. Compose-network base URL stored in the provider config; the integration appends `/vetsync/v1/<endpoint>` to it. Never point at a live Zoetis host. |
| `HARNESS_ZOETIS_PARTNER_ID` / `_PARTNER_PASSWORD` | `harness-partner` / `harness-pass` | zoetis only. Dummy provider-**configuration** credentials; the mock never authenticates for real. |
| `HARNESS_ZOETIS_CLIENT_ID` | `harness-client` | zoetis only. The dummy "FUSE Client ID" **integration** option. The integration joins it to `partnerId` as the HTTP Basic username `partnerId\clientId`, which is why the two live in different places. All four zoetis provider options are declared `string` by dmi-api — unlike antech's `LabId`, none is an integer. There is deliberately no zoetis poll-interval knob, for the same reason as antech. |
| `HARNESS_REDIS_PORT` | `6380` | full-stack only (every loop). Host port for Redis (the integration's Bull queues). |
| `HARNESS_MANAGE_CONTAINERS` | `1` | `0` to bring your own MySQL/Mongo/ActiveMQ and schema. Start that Mongo with `--setParameter enableTestCommands=1`, as `docker-compose.yml` does: the event-store throttling scenario and the idexx loop arm a failpoint in it. |
| `HARNESS_MANAGE_APP` | `1` unless `HARNESS_BASE_URL` is set | `0` to bring your own dmi-api. |
| `HARNESS_BUILD` | `1` | `0` to reuse an existing `dist/` in the checkout. |
| `HARNESS_KEEP_UP` | `0` | `1` to skip `docker compose down -v` on exit. |
| `HARNESS_DEPS_READY_MS` / `HARNESS_APP_READY_MS` | `180000` | Readiness budgets. |
| `HARNESS_REQUEST_MS` | `30000` | Per-request timeout. |
| `HARNESS_REPORT_DIR` | `./reports` | Where each run writes `<suite>/index.html`, `summary.json`, `run.json` and the index. See "Run reports". |
| `HARNESS_PUBLISH_REPORT` | `0` | `1` to copy the suite that just ran into `HARNESS_REPORT_PUBLISH_DIR` on teardown and rebuild the index there. |
| `HARNESS_REPORT_PUBLISH_DIR` | `/opt/homebrew/var/www/dmi-e2e` | The directory nginx serves (`docs/nginx/dmi-e2e.conf`). Also the target of `npm run report:publish`. |

dmi-api is started with a fixed environment (`src/env.ts`, `appEnv()`), the load-bearing parts of
which are:

- **`NODE_ENV=seed`** — dmi-api's `orders.service` returns from `createOrder` *after* the order is
  committed to MySQL and the `order:created` event to Mongo, but *before* the MQTT round-trip to
  the engine. No engine or lab runs in the fast suite — its integrations are for dmi-api's built-in
  `demo` provider, configured with an unreachable URL — so this is how orders get created through
  the real HTTP endpoint. It is a pre-existing dmi-api code path, not one added for testing.
- **`ENGINE_RESPONSE_TIMEOUT=2000`** — anything that *does* reach for the absent engine fails in 2s
  rather than hanging for dmi-api's 90s default. `engine-failures.e2e.ts` relies on it: that
  timeout is the outage it asserts dmi-api reports as one.
- **`STATSIG_ENABLED=false`**, **`DATABASE_RUN_MIGRATIONS=false`** — no network for feature flags;
  migrations run as an explicit, observable step.

The harness also creates a `public/` directory in the checkout if absent (dmi-api's
`registerStaticAssets` points `@fastify/static` at it, and a clean checkout has none). That empty
directory is the only write the harness makes inside the dmi-api checkout.

## Layout

```
docker-compose.yml            base MySQL + Mongo + ActiveMQ; + an `idexx` profile (redis + the
                              VetConnect Plus mock + the idexx integration), an `antech-v3` profile
                              (redis + the antech-v3 mock + the antech integration), a `zoetis` profile
                              (redis + the Zoetis mock + the zoetis integration), an `antech-v6` profile
                              (redis + the antech-v6 mock + the real dmi-engine as api + worker, built
                              from three checkouts) and a `wisdom-panel` profile (redis + the
                              wisdom-panel mock + the same two dmi-engine services). Mongo runs
                              with test commands on, for the failpoint the event-store throttling
                              scenario and the idexx loop arm
docker-compose.common-checkout.yml  added by the harness only with DMI_ENGINE_COMMON_DIR set: the
                              idexx, antech-v3 and zoetis images with that checkout installed over
                              the published dmi-engine-common
src/
  env.ts                      all configuration, resolved once; HARNESS_HOST / HARNESS_FULL_STACK / HARNESS_STACK
  slots.js                    harness slots: the host-port table, HARNESS_SLOT / .harness-slot, the per-slot lock, and `verifySlots()` (every published port slotted, no image shared across slots), which every run runs at start
  stacks.js                   the stack registry: one entry per full-system loop (provider id, scenario, compose profile, the checkouts it is built from, mock endpoint, poll class); `npm run check:stacks` verifies entries against the files they name, and the slot table (`src/slots.js`) against docker-compose.yml (every run does both too, at start)
  containers.ts               compose up/down (profile-aware), the harness's one compose invocation, the
                              project's containers as compose lists them, readiness polling, dmi-api migrations
  dmi-api.ts                  build, spawn `node dist/main`, poll /health, kill; the record of every dmi-api
                              a run starts (signal it, start it again, stop them all at teardown); dmi-api's
                              own npm scripts, run beside it
  services.ts                 failure injection on the stack: stop, start, pause, restart a compose service
                              of the run's project, flush Redis; the ledger of what is down, and its restore
  api-client.ts               immutable HTTP client: basic / bearer / api-key
  sql.ts                      mysql2 pool for setup and assertions
  mongo.ts                    mongodb client for failure injection: arms the `failCommand` failpoint so
                              one command on one of dmi-api's collections fails, and reads back how often
  mock-faults/index.js        transport faults the mocks share (hold, reset, stall), armed per route key
                              with a count of what each took; built into each mock image that wires it
  seed.ts                     the quickstart flow; two independent orgs; provider config; admin login
  refs.ts                     canonical dmi ref codes looked up by name over GET /refs/*, for the ref-mapping value assertions
  idexx-mock/server.js        the VetConnect Plus mock provider (zero-dependency Node HTTP server)
  antech-v3-mock/server.js    the antech-v3 mock provider, classic Antech (zero-dependency Node HTTP server)
  zoetis-mock/server.js       the Zoetis mock provider (zero-dependency Node HTTP server)
  antech-v6-mock/server.js    the antech-v6 mock provider (zero-dependency Node HTTP server)
  wisdom-panel-mock/server.js the wisdom-panel mock provider (zero-dependency Node HTTP server)
  published-common/           the build context DMI_ENGINE_COMMON_DIR defaults to: "no checkout"
  poll.ts                     pollUntil, shared by the full-system scenarios
  report/summary-reporter.js  jest reporter: writes reports/<suite>/summary.json when the run ends
  report/report.ts            run.json at setup, the run index, publishing to the nginx directory
  report/publish.ts           `npm run report:publish`
  global-setup.ts             orchestration, once per run
  global-teardown.ts          teardown, once per run
docs/nginx/dmi-e2e.conf       the nginx location block that serves the published reports
docs/launchd/*.plist          the nightly LaunchAgent for the mac mini (template; scripts/nightly-install.sh renders it)
scripts/
  nightly.sh                  every suite in turn from the nightly tree's clones, forced to origin/main,
                              each report published — what the LaunchAgent runs
  nightly-install.sh          create the nightly tree, render + load (or --uninstall) the LaunchAgent
  slot-tree.sh                create (or --remove, --list) a slot's tree of worktrees, so parallel slots also test separate code
scenarios/
  smoke.e2e.ts                the stack is really up and really wired
  tenant-isolation.e2e.ts     two organizations, neither able to read, count or write the other's data
  event-store-throttling.e2e.ts an order survives the event store throttling its order:created write
                              (dmi-api#371): the insert and its sequence-counter write are retried,
                              and an event that still fails no longer fails the request
  engine-failures.e2e.ts      an engine that does not answer is a 504 (devices and refs), not a 404
  idexx-full-stack.e2e.ts     the idexx loop (HARNESS_FULL_STACK=1); closes end to end, an order
                              throttled on every event write is still sent to the provider (dmi-api#371),
                              IDEXX calls that time out, reset or stall fail named, and a failed manifest
                              or confirm step still reports the created order
                              (dmi-engine-idexx-integration#81, #83, #93), and two results polls in
                              flight deliver a batch once (dmi-engine-idexx-integration#88); the loop
                              outlives Redis frozen (dmi-engine-idexx-integration#74) and flushed
                              (dmi-api#346), the broker restarted (dmi-api#367) and dmi-api stopped
                              with a request in flight (dmi-api#399)
  antech-v3-full-stack.e2e.ts the antech-v3 loop (HARNESS_FULL_STACK=1 HARNESS_STACK=antech-v3); closes end to end
  zoetis-full-stack.e2e.ts    the zoetis loop (HARNESS_FULL_STACK=1 HARNESS_STACK=zoetis); closes end to end
  antech-v6-full-stack.e2e.ts the antech-v6 loop (HARNESS_FULL_STACK=1 HARNESS_STACK=antech-v6); closes end to end,
                              a result or order the provider redelivers unchanged changes nothing
                              (dmi-api#409), a 503's Retry-After is honoured (dmi-engine-common#27),
                              a token the provider revokes is replaced at placement, a status poll
                              held past 60 s is given up on and asked again
                              (dmi-engine-antech-v6-integration#70); an engine that cannot reach
                              Redis at start exits, and recovers once Redis is back (dmi-engine#68)
  wisdom-panel-full-stack.e2e.ts the wisdom-panel loop (HARNESS_FULL_STACK=1 HARNESS_STACK=wisdom-panel); closes
                              end to end, and one order dmi-api cannot save does not cost the rest of its
                              batch (dmi-api#411)
                              (which scenarios carry `it.failing` tripwires, and for what: the table under "Tripwires")
```

## Tripwires

When this suite finds a defect that is still open, the test asserts the *correct* behaviour and is
marked `it.failing`. That keeps CI green while the defect exists and turns the test red the moment
it is fixed. The fix's companion commit here deletes the marker, the test stays on as a plain
regression guard, and its row leaves the table below. Each tripwire's comment says what it expects,
what happens today and why, so a fix can be matched to it. The tenant-isolation suite is the worked
example: every defect it found has been fixed upstream
([dmi-api#347](https://github.com/nominal-systems/dmi-api/pull/347),
[dmi-api#361](https://github.com/nominal-systems/dmi-api/pull/361)), and all its tests are now
guards.

### Do not "fix" a red build by relaxing an assertion

If any scenario fails with *"Failing test passed even though it was supposed to fail"*, that is a
tripwire firing: the defect underneath it was fixed. Delete the `.failing` marker, make the comment
above the test say what it now guards, move the test out of the scenario's tripwires block where
the scenario keeps one, and take its row out of the table below. That is the only correct
response. A plain test that goes red is the same case in reverse — something the suite
guards has broken — and the fix belongs where the break is, not in the assertion.

### Open tripwires on `main`

| Suite | Test | Correct behaviour — and today | Tracked in |
|---|---|---|---|
| fast (`smoke`) | `rejects an unauthenticated POST /users` | 401. Today 500 "Unknown authentication strategy 'basic'": dmi-api never registers its HTTP Basic auth, so no user can be created over HTTP | [dmi-api#379](https://github.com/nominal-systems/dmi-api/issues/379) |
| fast (`smoke`) | `rejects the wrong admin password on POST /users` | 401. Today 500, same cause | [dmi-api#379](https://github.com/nominal-systems/dmi-api/issues/379) |
| idexx | `the order is reported SUBMITTED` (under `a confirm that succeeds and a manifest fetch after it that fails`) | An order the confirm submitted is reported `SUBMITTED`, whatever becomes of the manifest fetch after it. Today `WAITING_FOR_INPUT`: the integration sets `SUBMITTED` only after that fetch, in a `try` whose `catch` only logs, so a failed fetch skips it while the order sits submitted at IDEXX | [dmi-engine-idexx-integration#93](https://github.com/nominal-systems/dmi-engine-idexx-integration/issues/93) |
| zoetis | `the dmi order's local test list shrinks to the remaining code` | Cancelling one test removes it from the dmi order's test list. Today the provider-side cancel happens, but dmi-api appends the cancelled test to the order's list instead of removing it | not yet filed |
| antech-v6 | `POST /admin/refs/sync/<provider> stores the reference data it fetched` | 201, and the provider's species, breeds and sexes stored. Today 400 and nothing stored, for every provider — which is why both engine loops seed their reference rows themselves | [dmi-api#378](https://github.com/nominal-systems/dmi-api/issues/378) |
| antech-v6 | `a provider error on the status poll is recorded in the audit trail` | An audit record carrying the provider's error. Today none: the logging interceptor throws on the error body before it records anything | [a comment on dmi-engine-common#29](https://github.com/nominal-systems/dmi-engine-common/issues/29#issuecomment-5909649362) |
| antech-v6 | `the integration logs in again when Antech stops accepting its token, and both polls deliver again` | A new login on each refused poll, one or two since the two polls share a tick, and no more over two further orders polls; a draft completed at the provider delivered as SUBMITTED and a result as a FINAL report. Today no poll logs in again: on the polls the 401 reaches the integration as a 500, because the logging interceptor throws on the error body, so its re-login on a 401 never runs and nothing is delivered while the token stays refused (it is cached for 12 hours) | [dmi-engine-antech-v6-integration#95](https://github.com/nominal-systems/dmi-engine-antech-v6-integration/issues/95) |
| antech-v6 | `an order the provider created after dmi-api stopped waiting ends with the provider's id and SUBMITTED, never a bare ERROR` | One dmi order, SUBMITTED, carrying the provider's id, for a placement held past `ENGINE_RESPONSE_TIMEOUT` that the provider then completes. Today dmi-api answers 504 and records the order ERROR with no external id, discards the engine's late answer, and the orders poll, unable to match the provider's order to an order with no id, records it as an order of its own | [dmi-api#365](https://github.com/nominal-systems/dmi-api/issues/365) |
| antech-v6 | `an order for a patient with no species OR breed mapping is still placeable` | The order is placed. Today the provider refuses it: the integration's default species and default breed are not a valid pair | [dmi-engine-antech-v6-integration#88](https://github.com/nominal-systems/dmi-engine-antech-v6-integration/issues/88) |
| wisdom-panel | `POST /admin/refs/sync/<provider> stores the reference data it fetched` | As in the antech-v6 loop: dmi-api's defect, not the provider's | [dmi-api#378](https://github.com/nominal-systems/dmi-api/issues/378) |
| wisdom-panel | `a result whose ideal-weight section is empty yields no ideal-weight items` | No ideal-weight panel. Today three DONE items with no value | [dmi-engine-wisdom-panel-integration#46](https://github.com/nominal-systems/dmi-engine-wisdom-panel-integration/issues/46) |
| wisdom-panel | `a provider error on the orders poll is recorded in the audit trail` | An audit record carrying the provider's error. Today none, as in the antech-v6 loop | [a comment on dmi-engine-common#29](https://github.com/nominal-systems/dmi-engine-common/issues/29#issuecomment-5909649362) |
| wisdom-panel | `the integration logs in again when the provider revokes its token, and both polls resume` | A new token once the vendor refuses the old one with a 401, and both feeds read again. Today the token is cached for ten days and nothing replaces it on a refusal, so nothing is delivered until the cache expires or the engine restarts | [dmi-engine-wisdom-panel-integration#53](https://github.com/nominal-systems/dmi-engine-wisdom-panel-integration/issues/53) |
