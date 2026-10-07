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
assertions that no HTTP route exposes — to MySQL directly via `mysql2`. That boundary is the whole
point: the harness must survive dmi-api refactors and stay reusable as a conformance suite. Two
setup steps could go over HTTP and do not, each because the route that exists for it is broken and
pinned by a tripwire (see "Tripwires"): the shared seeder inserts each user over SQL, because
`POST /users` answers 500, and the two engine loops insert their provider's reference data,
because `POST /admin/refs/sync/<provider>` stores nothing. Everything after that, from login to
orders, is real HTTP.

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
   `docker compose up -d` — MySQL 8, Mongo 4, ActiveMQ (this repo's `docker-compose.yml`).
2. Poll until all three accept connections. No fixed sleeps.
3. `npm run migration:run` in the dmi-api checkout, against the harness database. This also
   regression-tests that dmi-api's migrations produce a working schema from empty.
4. `npm run build` in the checkout, then spawn `node dist/main` and poll `/health` until every
   dependency reports up.
5. Run the scenarios, one file at a time (`maxWorkers: 1`): they share one database, one event
   stream and one `seq` counter, and must not race.
6. Stop dmi-api and `docker compose down -v`.

Faster iteration:

```bash
HARNESS_KEEP_UP=1 npm run test:harness   # leave containers running on exit
HARNESS_BUILD=0   npm run test:harness   # skip `npm run build` in the checkout

# drive a dmi-api you are already running yourself; the harness touches no checkout:
HARNESS_BASE_URL=http://127.0.0.1:3000 HARNESS_MANAGE_CONTAINERS=0 npm run test:harness
```

**Full-system re-runs with `HARNESS_KEEP_UP=1`.** A loop's integration (see "Full-system mode"
below) polls its mock through Bull jobs kept in Redis, and Redis outlives a kept-up run, so a stale
job from an earlier run could race a later run for its results. Each loop's scenario stops the
integration it started in `afterAll`, which removes its jobs. If a run is interrupted before that,
`docker compose --profile <loop> down -v` clears Redis (outside a slot tree, in slot n add
`-p dmi-e2e-s<n>`; see "Parallel runs — slots" below). A run without `HARNESS_KEEP_UP` tears Redis
down every time, so it is never affected.

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
with it. Trees go in `slots/` next to the clones; `DMI_SLOTS_DIR` moves them.

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
are built from, as the stack registry lists them (`-dirty` when one has local changes) — recorded
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
  **real `dmi-engine-idexx-integration`** container, behind the `idexx` compose profile. Runs
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
  `antech-v6` compose profile. Runs `scenarios/antech-v6-full-stack.e2e.ts`.
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

**The idexx loop closes end to end.** An order placed over real HTTP round-trips through the real
idexx integration and the mock provider: `POST /orders?autoSubmitOrder=true` → the integration creates
the order at the mock and runs IDEXX's confirmOrder browser handshake against it → the integration's
results poll picks up a result the scenario seeds at the mock → dmi-api writes a `FINAL` report with
test results and moves the order to `COMPLETED`, and `/events` shows the `order:*`/`report:*`
sequence. The harness talks **only to the mock**, never to live `*.vetconnectplus.com`, so runs are
deterministic, need no credentials, and place no real orders. See "The idexx mock (VetConnect Plus)"
below.

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

### The idexx mock (VetConnect Plus)

`src/idexx-mock/server.js` is a small, zero-dependency Node HTTP server that stands in for IDEXX (its VetConnect Plus API). It speaks IDEXX's **public, documented dialect** (developer.vetconnectplus.com)
closely enough for the real integration to drive it unmodified:

- **Ordering** (`/api/v1/*`): `POST /order`, `GET/DELETE /order/:id`, the external-orders poll, auth
  validate, and reference data — including the test catalogue (`/ref/tests`) and the clinic's one
  IVLS analyzer (`/ivls/devices`). The catalogue carries one in-house code and one genuine
  reference-lab code, so both halves of the integration's device rule execute. The integration reads
  the `inHouse` flag to decide whether an order must carry a device, and the mock enforces the
  in-house half at placement: an in-house order without an `ivls` serial, or with one the clinic does
  not own, is refused. The reference-lab half — the integration strips the devices it was given — is
  echoed, not enforced: the provider's tolerance of a device on such an order is unverified, so the
  scenario pins the empty device list at the control plane instead.
- **confirmOrder handshake**: `POST /order` returns a `uiURL` that points back at the mock; the mock
  serves that HTML page (setting a cookie), then accepts the follow-up XHR `GET`/`PUT` the
  integration issues to submit the order.
- **Results** (`/api/v3/*`): the latest-results batch poll, its `confirm/:batchId` ack, and search.
- **Control plane** (`/__control__/*`, host-facing): tests seed a (synthetic) result for an order,
  list the orders the mock received, reset state, and inject error scenarios. This is how the
  order→result→report loop is made deterministic — the mock holds no results until a test seeds one.

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
| `HARNESS_MANAGE_CONTAINERS` | `1` | `0` to bring your own MySQL/Mongo/ActiveMQ and schema. |
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
  rather than hanging for dmi-api's 90s default.
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
                              wisdom-panel mock + the same two dmi-engine services)
src/
  env.ts                      all configuration, resolved once; HARNESS_HOST / HARNESS_FULL_STACK / HARNESS_STACK
  slots.js                    harness slots: the host-port table, HARNESS_SLOT / .harness-slot, the per-slot lock, and `verifySlots()` (every published port slotted, no image shared across slots), which every run runs at start
  stacks.js                   the stack registry: one entry per full-system loop (provider id, scenario, compose profile, the checkouts it is built from, mock endpoint, poll class); `npm run check:stacks` verifies entries against the files they name, and the slot table (`src/slots.js`) against docker-compose.yml (every run does both too, at start)
  containers.ts               compose up/down (profile-aware), readiness polling, dmi-api migrations
  dmi-api.ts                  build, spawn `node dist/main`, poll /health, kill
  api-client.ts               immutable HTTP client: basic / bearer / api-key
  sql.ts                      mysql2 pool for setup and assertions
  seed.ts                     the quickstart flow; two independent orgs; provider config; admin login
  refs.ts                     canonical dmi ref codes looked up by name over GET /refs/*, for the ref-mapping value assertions
  idexx-mock/server.js        the VetConnect Plus mock provider (zero-dependency Node HTTP server)
  antech-v3-mock/server.js    the antech-v3 mock provider, classic Antech (zero-dependency Node HTTP server)
  zoetis-mock/server.js       the Zoetis mock provider (zero-dependency Node HTTP server)
  antech-v6-mock/server.js    the antech-v6 mock provider (zero-dependency Node HTTP server)
  wisdom-panel-mock/server.js the wisdom-panel mock provider (zero-dependency Node HTTP server)
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
  idexx-full-stack.e2e.ts     the idexx loop (HARNESS_FULL_STACK=1); closes end to end
  antech-v3-full-stack.e2e.ts the antech-v3 loop (HARNESS_FULL_STACK=1 HARNESS_STACK=antech-v3); closes end to end
  zoetis-full-stack.e2e.ts    the zoetis loop (HARNESS_FULL_STACK=1 HARNESS_STACK=zoetis); closes end to end
  antech-v6-full-stack.e2e.ts the antech-v6 loop (HARNESS_FULL_STACK=1 HARNESS_STACK=antech-v6); closes end to end
  wisdom-panel-full-stack.e2e.ts the wisdom-panel loop (HARNESS_FULL_STACK=1 HARNESS_STACK=wisdom-panel); closes
                              end to end
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
| zoetis | `the dmi order's local test list shrinks to the remaining code` | Cancelling one test removes it from the dmi order's test list. Today the provider-side cancel happens, but dmi-api appends the cancelled test to the order's list instead of removing it | not yet filed |
| antech-v6 | `POST /admin/refs/sync/<provider> stores the reference data it fetched` | 201, and the provider's species, breeds and sexes stored. Today 400 and nothing stored, for every provider — which is why both engine loops seed their reference rows themselves | [dmi-api#378](https://github.com/nominal-systems/dmi-api/issues/378) |
| antech-v6 | `the orders channel completes an order whose provider status has reached Final` | COMPLETED. Today it stays SUBMITTED: the integration's status enum is numeric and the provider sends strings, so every completion assertion in the loop rests on the results channel | [dmi-engine-antech-v6-integration#84](https://github.com/nominal-systems/dmi-engine-antech-v6-integration/issues/84) |
| antech-v6 | `a provider error on the status poll is recorded in the audit trail` | An audit record carrying the provider's error. Today none: the logging interceptor throws on the error body before it records anything | [a comment on dmi-engine-common#29](https://github.com/nominal-systems/dmi-engine-common/issues/29#issuecomment-5909649362) |
| antech-v6 | `an order for a patient with no species OR breed mapping is still placeable` | The order is placed. Today the provider refuses it: the integration's default species and default breed are not a valid pair | [dmi-engine-antech-v6-integration#88](https://github.com/nominal-systems/dmi-engine-antech-v6-integration/issues/88) |
| antech-v6 | `a hawk whose breed is mapped to Antech's red-tailed hawk goes out as 119 Raptor / 834, not as the species Avian maps to` | SpeciesID 119 / BreedID 834, the pair the hawk's mapped breed belongs to. Today 53 / 834 and the provider refuses it: dmi-api sends the one species `Avian` is mapped to whatever the breed, so with the breed mapped the order is refused and with it unmapped every bird goes out as the default parrot | [dmi-api#377](https://github.com/nominal-systems/dmi-api/issues/377) |
| wisdom-panel | `POST /admin/refs/sync/<provider> stores the reference data it fetched` | As in the antech-v6 loop: dmi-api's defect, not the provider's | [dmi-api#378](https://github.com/nominal-systems/dmi-api/issues/378) |
| wisdom-panel | `a result whose ideal-weight section is empty yields no ideal-weight items` | No ideal-weight panel. Today three DONE items with no value | [dmi-engine-wisdom-panel-integration#46](https://github.com/nominal-systems/dmi-engine-wisdom-panel-integration/issues/46) |
| wisdom-panel | `a provider error on the orders poll is recorded in the audit trail` | An audit record carrying the provider's error. Today none, as in the antech-v6 loop | [a comment on dmi-engine-common#29](https://github.com/nominal-systems/dmi-engine-common/issues/29#issuecomment-5909649362) |
| wisdom-panel | `the integration re-authenticates when the provider stops accepting its token` | A new token after a 401. Today the token is cached for ten days and never refreshed, so a credential rotated at the provider fails every call until the cache expires | no open issue |
