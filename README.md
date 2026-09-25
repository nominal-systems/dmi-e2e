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
mocked. It is the first true integration layer the platform has had, which is also why it is the
thing that surfaced the tenant-isolation findings below — no mocked suite could have.

It imports **nothing** from dmi-api. It talks to a running server over HTTP, and — for setup and
assertions that no HTTP route exposes — to MySQL directly via `mysql2`. That boundary is the whole
point: the harness must survive dmi-api refactors and stay reusable as a conformance suite.

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

1. `docker compose up -d` — MySQL 8, Mongo 4, ActiveMQ (this repo's `docker-compose.yml`).
2. Poll until all three accept connections. No fixed sleeps.
3. `npm run migration:run` in the dmi-api checkout, against the harness database. This also
   regression-tests that dmi-api's migrations produce a working schema from empty.
4. `npm run build` in the checkout, then spawn `node dist/main` and poll `/health` until every
   dependency reports up.
5. Run the scenarios.
6. Stop dmi-api and `docker compose down -v`.

Faster iteration:

```bash
HARNESS_KEEP_UP=1 npm run test:harness   # leave containers running on exit
HARNESS_BUILD=0   npm run test:harness   # skip `npm run build` in the checkout

# drive a dmi-api you are already running yourself; the harness touches no checkout:
HARNESS_BASE_URL=http://127.0.0.1:3000 HARNESS_MANAGE_CONTAINERS=0 npm run test:harness
```

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

- **`idexx`** (default) — the Phase 0 loop. dmi-api + ActiveMQ + Redis + the **VetConnect Plus mock**
  (`src/idexx-mock`, built from this repo) + the **real `dmi-engine-idexx-integration`** container,
  behind the `idexx` compose profile. Runs `scenarios/idexx-full-stack.e2e.ts`.
- **`antech-v3`** — the Phase 1 loop for **classic Antech**, API generation V3. dmi-api's provider id
  is the bare `antech` (it predates V6); the harness key carries the generation so nothing derived
  from it — files, env variables, the workflow's `paths:` glob — can be confused with the
  `antech-v6` loop's. dmi-api + ActiveMQ + Redis + the **antech-v3 mock** (`src/antech-v3-mock`,
  built from this repo) + the **real `dmi-engine-antech-integration`** container (the repo keeps its
  name), behind the `antech-v3` compose profile. Runs `scenarios/antech-v3-full-stack.e2e.ts`.
- **`zoetis`** — the Phase 1 loop for **Zoetis VetSync v1** (provider id `zoetis`). dmi-api +
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
- **`demo`** — the pre-existing demo loop (ActiveMQ, Redis, `dmi-demo-provider-api` + its MySQL, and
  `dmi-engine-demo-provider-integration`), behind the `full-stack` profile. Runs
  `scenarios/full-stack-smoke.e2e.ts`. **Blocked upstream** (see below).

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

# demo (the upstream-blocked loop):
GHP_TOKEN=$(gh auth token) HARNESS_FULL_STACK=1 HARNESS_STACK=demo npm run test:harness
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
deterministic, need no credentials, and place no real orders. See "The VetConnect Plus mock" below.

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
  and breed. See "Full-system findings".

**Status: the `demo` scenario is blocked upstream.** Its end-to-end order→report loop cannot close
because the demo integration on `main` is not compatible with the current dmi-api. The dmi-api
handlers, the provider sim and this harness's plumbing are all sound — the gap is entirely in the demo
integration, and its fix is tracked privately (routed upstream), not in this repo. So
`full-stack-smoke.e2e.ts` ships with its completion assertions `describe.skip`ped and an active test
that *confirms* the break; it is unaffected by, and independent of, the idexx loop.

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
| demo-provider-api  | 3011    | `full-stack`| the simulated demo provider; harness mints keys here |
| demo-provider MySQL| 3308    | `full-stack`| the demo provider's own database |

## Environment

Every variable has a working default; the table exists so CI and debugging are not guesswork.

| Variable | Default | Purpose |
|---|---|---|
| `DMI_API_DIR` | `../dmi-api` | dmi-api checkout to build, migrate and run. Ignored when `HARNESS_MANAGE_APP=0`. |
| `HARNESS_HOST` | `127.0.0.1` | Host that the published container ports are reachable on. A single knob; each per-service `*_HOST` var (and the Mongo URI) defaults to it, so pointing the suite at a remote docker host is one variable. |
| `HARNESS_FULL_STACK` | `0` | `1` selects a full-system suite instead of the default fast suite. See "Full-system mode". |
| `HARNESS_STACK` | `idexx` | Which full-system loop `HARNESS_FULL_STACK=1` runs — a key of the stack registry in `src/stacks.js`: `idexx` (real idexx integration + VetConnect Plus mock), `antech-v3` (real classic-Antech integration + antech-v3 mock; dmi-api's provider id is the bare `antech`), `zoetis` (real zoetis integration + Zoetis mock), `antech-v6` (the real dmi-engine as api + worker + antech-v6 mock), `wisdom-panel` (the same dmi-engine + wisdom-panel mock) or `demo` (upstream-blocked demo loop). Anything else is refused — including the old `antech`. |
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
| `HARNESS_DEMO_PROVIDER_PORT` | `3011` | demo only. Host port for the demo provider API (where the harness mints an X-Api-Key). |
| `HARNESS_DEMO_PROVIDER_URL` | `http://$HARNESS_HOST:3011/demo` | demo only. Host-facing demo provider base URL (includes its `/demo` prefix). |
| `HARNESS_DEMO_PROVIDER_INTERNAL_URL` | `http://dmi-demo-provider-api:3000/demo` | demo only. URL the integration container uses to reach the provider; stored verbatim in the dmi-api provider configuration, so it must resolve inside the compose network. |
| `HARNESS_REDIS_PORT` | `6380` | full-stack only (both loops). Host port for Redis (the integration's Bull queues). |
| `HARNESS_DEMO_MYSQL_PORT` / `_PASSWORD` / `_DATABASE` | `3308` / `demo` / `demo_provider` | demo only. The demo provider's own MySQL (auto-synchronised schema). |
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
  the engine. No engine or demo lab runs in this harness, so this is how orders get created through
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
                              from three checkouts), a `wisdom-panel` profile (redis + the wisdom-panel
                              mock + the same two dmi-engine services) and a `full-stack`
                              profile (redis + the demo provider + its MySQL + the demo integration)
src/
  env.ts                      all configuration, resolved once; HARNESS_HOST / HARNESS_FULL_STACK / HARNESS_STACK
  stacks.js                   the stack registry: one entry per full-system loop (provider id, scenario, compose profile, the checkouts it is built from, mock endpoint, poll class); `npm run check:stacks` verifies entries against the files they name (every run does too, at start)
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
scenarios/
  smoke.e2e.ts                the stack is really up and really wired
  tenant-isolation.e2e.ts     the point of this suite
  idexx-full-stack.e2e.ts     the idexx loop (HARNESS_FULL_STACK=1); closes end to end
  antech-v3-full-stack.e2e.ts the antech-v3 loop (HARNESS_FULL_STACK=1 HARNESS_STACK=antech-v3); closes end to end
  zoetis-full-stack.e2e.ts    the zoetis loop (HARNESS_FULL_STACK=1 HARNESS_STACK=zoetis); closes end to end
  antech-v6-full-stack.e2e.ts the antech-v6 loop (HARNESS_FULL_STACK=1 HARNESS_STACK=antech-v6); closes end to end, four tripwires red by design
  wisdom-panel-full-stack.e2e.ts the wisdom-panel loop (HARNESS_FULL_STACK=1 HARNESS_STACK=wisdom-panel); closes end to end, four tripwires red by design
  full-stack-smoke.e2e.ts     the demo loop (HARNESS_FULL_STACK=1 HARNESS_STACK=demo); blocked upstream
```

## Findings

Tenant isolation was the first scenario this harness exercised — not the reason it exists (it is a
general-purpose real-services suite for the platform). That first pass immediately turned up six
distinct places where dmi-api's isolation or auth is missing. **None are fixed here** — that is out
of scope, and they want a considered fix plus a data-exposure review, not a drive-by patch.

Each finding has a test that asserts the *correct* behaviour. While the defect is open the test is
marked `it.failing`: that keeps CI green while the defect exists, and turns the test red the moment
someone fixes it — at which point the `.failing` marker is deleted in the same commit and the test
stays on as a plain regression guard. F2–F5 have reached that stage (dmi-api #361).

| # | Route | Defect | Observed | Status |
|---|---|---|---|---|
| F1 | `GET /events` | `getEventsForOrganization` takes an `organization` and never reads it. Returns **every tenant's** events. | org B → **200**, sees org A's events; counts identical | **CONFIRMED** |
| F2 | `GET /reports/*` | `ReportsController` had **no guard**, and there is no global guard. Was reachable **unauthenticated**. | anon → **200** | **FIXED** in dmi-api #361; guarded |
| F3 | `GET /reports/:id` | `getReport(id, _organization)` ignored the organization (had a `TODO` admitting it). | org B → **200** | **FIXED** in dmi-api #361; guarded |
| F4 | `POST /orders`, `POST /integrations`, `PUT /providers/:id/configurations/:id` | None took an `@Organization()`; referenced IDs were never checked for ownership. Cross-tenant **writes**. | org B → **201 Created** / **200** | **FIXED** in dmi-api #361; guarded |
| F5 | `GET /orders/:id/report` | `getOrderReport(organization, orderId)` ignored the organization. | org B → **200** | **FIXED** in dmi-api #361; guarded |
| F6 | `POST /users`, `GET /users` | HTTP Basic auth is unregistered: `BasicStrategy` is in no module's `providers`, so Passport has no `basic` strategy. | any → **500** "Unknown authentication strategy 'basic'" | **CONFIRMED** |

**SUSPECTED** = read from dmi-api source. **CONFIRMED** = reproduced by this suite against a running
app. **FIXED** = closed upstream, and the test now runs as a plain guard that fails if the defect
returns. All six were CONFIRMED end-to-end against a live dmi-api with the status codes above; the
`HARNESS_IMPLEMENTATION_PLAN.md` log records the full probe output. F1 and F6 remain open.

F1 is the most serious: `GET /events` is reachable with any valid API key, and `event.data` for an
`order:created` event embeds the whole order — patient name, client name, veterinarian. F2 needs no
credentials at all, though report IDs are UUIDv4 and so are not enumerable. F4 compounds: on
success, org B binds its own practice to org A's provider configuration.

F6 is a functional break rather than a data leak, but it blocks the documented user-provisioning
flow entirely. Because of it, the seeder cannot create users over HTTP; it inserts each user row via
`sql.ts` (a constant `argon2id` password hash) and then runs the rest of the quickstart — login,
org, keys, provider config, practice, integration, order — over real HTTP. Only user creation is
faked.

Correctly scoped, and asserted as ordinary passing tests: `GET /orders/:id` (org B → **403**, *not*
404), `GET /orders/:id/result.json` (**403**), and all of `/orders`, `/practices`, `/integrations`,
`/providers/configurations`, `/organizations/:id/keys`.

### Do not "fix" a red build by relaxing an assertion

If a test in `tenant-isolation.e2e.ts` fails with *"Failing test passed even though it was supposed
to fail"*, that is the tripwire firing: the underlying defect was fixed. Delete the `.failing`
marker and the comment above it. That is the only correct response.

## Full-system findings

**The idexx loop closes.** Standing up the idexx loop (Phase 0) confirmed that
`dmi-engine-idexx-integration` interoperates with the current dmi-api over the real MQTT transport:
`POST /orders` RPCs the integration, which creates the order at the mock (and runs the confirmOrder
browser handshake), and the integration's results poll pushes a seeded result back so dmi-api writes a
`FINAL` report and moves the order to `COMPLETED`. Two dmi-api mechanics are worth recording for the
next integration:

- **Creating an integration does not start its polling.** `POST /integrations` leaves it `NEW`;
  polling begins only after `POST /admin/integrations/:id/start` (which emits the engine's
  `integration/create` event and moves the integration to `RUNNING`). The harness gets an admin JWT
  from `POST /auth/admin/login`.
- **Results correlate to an order by its `externalId`** (the provider order id the create RPC returned),
  and dmi-api completes the order only when the result's PIMS patient id matches the order's — so the
  order carries a `pims:patient:id` and the mock echoes it back in the result. Without one, the result
  lands as a duplicate orphan order and the original stays `SUBMITTED` — a dmi-api reconciliation bug
  tracked as [nominal-systems/dmi-api#334](https://github.com/nominal-systems/dmi-api/issues/334);
  the `pims:patient:id` is the workaround until it lands.
- **The broker must speak MQTT 5.0 shared subscriptions.** The engine transport uses
  `$share/<group>/<topic>` subscriptions; ActiveMQ 5.x "classic" (the old harness broker) silently
  drops them, so the harness broker is `eclipse-mosquitto:2` (see "The MQTT broker" below).

**The antech-v3 loop closes too** (Phase 1), confirming `dmi-engine-antech-integration` (the classic
`antech` provider) interoperates with the current dmi-api the same way. What the second provider
taught us, beyond the mechanics above:

- **The `pims:patient:id` workaround is provider-specific — and inverts for antech.** dmi-api's
  reconciliation guard (`ProviderResultUtils.isMatchingOrder`) compares `pims:patient:id` across the
  order it holds and the order the integration extracts from a result, and rejects the match when only
  one side carries one. The antech result mapper tags the patient it extracts with its **own**
  `antech:pet:id` system, never the PIMS one — so an antech order carrying a `pims:patient:id` can
  *never* be reconciled by its own results (dmi-api logs `Skipping order update ... patient/client
  mismatch` and the order sits at `SUBMITTED`). The antech-v3 scenario therefore deliberately places its
  order **without** a patient identifier, which leaves both sides without one — a state the guard
  treats as compatible — and falls back to matching on patient name + client last name. This is the
  exact opposite of the idexx scenario, which must *supply* one. The generalisable lesson: whether a
  provider needs the identifier depends on which identifier system *its* result mapper emits, so check
  the mapper before copying either scenario.
- **Two ids are in play and must agree.** The integration assigns the **raw body** of
  `External/OrderPlacement` as the order's `externalId`, but results are correlated by
  `ClinicAccessionID` — so a provider whose placement response is anything other than the
  ClinicAccessionID would strand every result as an orphan. The mock echoes the requisition id back,
  which is the only self-consistent reading of the contract.
- **A mock that defaults is a mock that agrees with you.** The first cut of the antech-v3 mock filled in
  `PetName`/`ClientLastName`/test-code when an order omitted them — with exactly the values the
  scenario then asserted. That made the order-forwarding test unfalsifiable, and because dmi-api
  reconciles results on patient name + client last name, the fabricated values kept completion, the
  report and `/events` green too: an integration that stopped forwarding the patient would have
  shipped a permanently green gate. The mocks now validate required fields and reject unknown test
  codes. Worth checking in any provider mock: **for each field the scenario asserts, ask what happens if
  the integration stops sending it.** If the answer isn't "the test fails", the assertion is decorative.
- **A failing antech results poll is silent**, so shape errors in the mock are invisible from outside:
  a healthy poll and a fatally broken one look identical, with no log output either way. The mock's
  response shapes were therefore verified directly against the mapper's accessors (and `xmlbuilder2`'s
  object format) rather than by iterating against the running stack, and the scenario asserts the
  batch was **acknowledged** as explicit positive evidence that the poll ran to completion rather than
  dying midway. Worth knowing before you debug this loop — and worth copying for the next provider.

**The zoetis loop closes too** (Phase 1), making `dmi-engine-zoetis-integration` the third provider
confirmed to interoperate with the current dmi-api. What the third provider taught us:

- **Reconciliation has a third shape, not two.** idexx orders must *carry* a `pims:patient:id` and
  antech orders must *omit* one — but both are workarounds for the same guard,
  `ProviderResultUtils.isMatchingOrder`. Zoetis never reaches that guard at all: its result mapper
  attaches no `.order` to a result, so results always take dmi-api's `externalId` path.
  Reconciliation is purely `PracticeRef == client_order_id == externalId == requisitionId`, and the
  patient identifier is a free choice. The generalisable lesson is stronger than "check the mapper's
  identifier system": **check first whether the provider's results reach the guard at all.**
- **Ref mapping was never actually exercised until this loop.** dmi-api maps an order's
  species/sex/breed from its canonical refs to provider codes (`RefsService.mapPatientRefs`) before
  handing the order to the engine, and nothing in the earlier scenarios asserted the result — they
  place orders with `species: 'DOG'`, `sex: 'MALE'`, `breed: 'LABRADOR'`, **none of which is a dmi ref
  code**, so the mapping silently no-ops and the raw strings are forwarded. A mapping that stopped
  resolving would have changed nothing observable. The zoetis scenario closes that hole for its own
  loop by placing the order with the canonical ref codes (looked up by name over `GET /refs/*`, since
  dmi's codes are opaque UUIDs) and asserting the provider received the *zoetis* vocabulary — `DOG` and
  `MALE_NEUTERED` — with the mock enforcing both. Input and expected output are deliberately
  different strings, so a no-op mapping fails loudly. Verified: pointing the order at a species with
  no zoetis mapping makes the mock reject placement with `'<uuid>' is not a Zoetis species code`.
  The antech-v3 loop now does the same — and for **all three** fields, because antech maps breeds too
  (numeric BreedIDs, from the ~1,100 dog-breed rows dmi-api's migrations seed): `Canis familiaris`,
  `Male Sterilized`, `Labrador Retriever` in, `41` / `CM` / `130` at the mock, numeric ids as numbers.
  The antech-v3 mock echoes these rather than validating them, so there the scenario assertion is the
  whole guard: with an unmapped species the raw dmi code reaches the mock and the assertion names it.
  The idexx loop asserts **all three** as well, because idexx maps breeds too (upper-case
  mnemonics, from the ~1,100 dog-breed rows dmi-api's migrations seed): `Canis familiaris`,
  `Male Sterilized`, `Labrador Retriever` in, `CANINE` / `MALE_NEUTERED` / `LABRADOR_RETRIEVER` at the
  mock. The idexx mock echoes these rather than validating them, so there the scenario assertion is
  the whole guard: with an unmapped ref the raw dmi code reaches the mock and the assertion names it.
- **Zoetis breeds cannot be ref-mapped at all.** dmi-api seeds 1307 zoetis breed `provider_ref` rows
  and **every one has a NULL `code`** (the other three providers have none) — consistent with the
  integration's `getBreeds` being a no-op, since Zoetis publishes no breed catalogue. So a breed that
  *does* resolve maps to null and is dropped from the order; only an unresolvable string survives.
  The scenario therefore sends a plain descriptive breed and asserts forwarding, not mapping.
- **Multiplicity is this dialect's version of Antech's CDATA sensitivity.** Wherever an integration
  consumes a parsed XML collection as an array, a one-element response is a different shape — the
  object formats return an object, not a one-element array. Worth grepping for in the next provider
  before deciding how many of each element its mock should emit.
- **Its failing polls are silent too**, exactly as antech's are, so the scenario asserts **both**
  acknowledge channels as positive evidence that each poll ran to completion rather than dying midway
  — including that the *orders* ack happened at `COMPLETED`, which can only be true if a full
  poll → fetch → emit → ack cycle ran after the result landed.

**The demo loop is blocked upstream.** `dmi-engine-demo-provider-integration` on `main` is no longer
compatible with the current dmi-api — over the MQTT transport it does not answer dmi-api's engine
RPCs, so its order → result → report loop cannot close. The provider sim, dmi-api's inbound handlers and
all of this harness's plumbing are sound; the gap is entirely in that integration. **Not fixed here** —
the integration repo is read-only, and the detailed defect writeup is **tracked privately** (routed
upstream), not in this public repo. The demo scenario ships gated on it: its completion assertions are
`describe.skip`ped and an active test *confirms* the block (`POST /orders` times out at the engine and
the order lands in `ERROR`).

**The antech-v6 loop closes too — and it is the first loop through the engine process itself.**
`POST /orders` → dmi-api RPCs `antech-v6/orders/create` to the `api` engine process → the
integration logs in to the mock and places the order: at `/LabOrders/v6/Order` when auto-submit was
asked for, the integration option allows it and every code is point-of-care per the provider's own
test guide, otherwise as a **pre-order draft** (dmi `WAITING_FOR_INPUT`, with a `submissionUri` for
a human to finish in Antech's UI) → the `worker` engine process polls: orders (`GetStatus`, then a
per-order result status and a requisition form unless every test is in-house, acknowledged by
clinic accession id) and results (`GetAllResults`, emitted then acknowledged by lab accession id on
the irregular `labAccessionsIds` key) → dmi-api writes the report. 30 tests, four of them
`it.failing` tripwires. What the fourth provider taught us:

- **The engine's two roles really are two halves.** The `api` process takes the integration
  create and schedules the repeatable jobs; the `worker` process runs them. An order is placed by
  one process and polled by the other, through Redis, and the loop closes — which a single
  `all`-role container would have proved nothing about.
- **Only the results channel can complete an order today.** The provider sends `OrderStatus` as a
  string; the integration's status enum is numeric, so every polled status reaches dmi as
  SUBMITTED. The mock serves the strings on purpose — integers would make the mapping appear to
  work — and every completion assertion rests on the report reaching FINAL. Tripwire.
- **A provider error on a status poll leaves no audit record.** The integration's logging
  interceptor throws on the error body before emitting anything, so the provider's own explanation
  is discarded. Tripwire, observable through `GET /admin/external-requests`.
- **A fully unmapped patient's order is refused by the provider.** The integration substitutes a
  default species and a default breed independently, and the pair is invalid at Antech; the mock
  refuses it from the same species tree. Tripwire, paired with the assertion that the refusal's
  wording reaches the operator through the one envelope the error mapper surfaces.
- **Ref data is seeded the operator's way — almost.** dmi-api ships no antech-v6 provider refs. The
  scenario reads the provider's species, breeds and sexes *through the engine* (the same RPC the
  admin sync uses) and maps three canonical refs over the admin API, then asserts `41` / `130` /
  `CM` arrived at the mock. The admin sync route itself answers 400 and stores nothing, for every
  provider, so the rows are inserted from what the engine returned; a fourth tripwire pins the
  route. The cause: the route's upsert passes the loaded Provider entity — decorated with two
  computed properties — as a TypeORM relation condition, and TypeORM refuses the query
  (`Property "integrationOptions" was not found in "Provider"`). Not yet filed upstream.
- **A pre-order is a draft the engine cannot see** — it is in none of the status views and has no
  requisition form (a 500, as live) — so the mock's control plane models the clinic completing it,
  and the promoted order is the one place the orders channel moves a dmi order (to SUBMITTED).
- **Deliberately not modelled:** the status feed's sub-minute visibility window and its retention,
  both observed live and both a timing race against the engine's default 60 s poll that the
  harness cannot make deterministic (it dials the poll to 3 s); and re-notification on status
  change, observed *not* to happen.

**The wisdom-panel loop closes too — through the same engine, under a second profile.**
`POST /orders` (a `labRequisitionInfo.KitCode`, the one requisition parameter dmi-api declares
for this provider) → dmi-api RPCs `wisdom-panel/orders/create` to the `api` engine process → the
integration takes an OAuth2 token and ACTIVATES the kit at `/api/voyager/pet` (the order's
`requisitionId` comes back overwritten by the kit code, its `externalId` is the kit's id, its
manifest the requisition form) → the `worker` process polls two JSON:API feeds scoped by hospital
number: kits (acknowledged by kit id) and result-sets (each resolved to its kit from `included`,
then the simplified genetic result and the vet-report PDF fetched per set, emitted, acknowledged
by result-set id) → dmi-api writes the report. 35 tests, five of them `it.failing` tripwires.
What the fifth provider taught us:

- **An `included` that is omitted, not empty, is the whole orders channel.** JSON:API leaves the
  key out when nothing in the page carries the relationship — an empty page, and a page of
  shipped-but-unused kits, which have no pet. The integration dereferences it unguarded, so the
  second page is a `TypeError`; the mock omits the key exactly as the live server does, and an
  active test pins that page shape. (It is not a tripwire: any kit that would become an order has
  a pet, and its presence restores `included`, so the crash cannot be shown through dmi-api.)
- **One vendor, three error dialects, and a strict content negotiator.** JSON:API `errors[]` on
  the feeds, `{message}` on the voyager endpoints, RFC 6749 on the token grant; and a bare
  `Accept: application/json` is a 406 — the integration passes only because axios's default
  contains `*/*`. The mock enforces all of it, so a tidy-up is a red build here rather than an
  outage.
- **Acknowledge is a filter, not a delete; both channels answer 201; a duplicate is an idempotent
  201.** Copying the zoetis mock's 409 would have been fiction — assertion strength does not
  transfer between loops.
- **The ideal-weight section can be an empty object**, on a sizeable minority of real kits, and the
  mapper turns it into three DONE observations with no value. Tripwire.
- **A single failed PDF discards the whole results batch**, and since nothing is acknowledged the
  same batch fails every tick — the provider's PDF generator does fail on a sizeable minority of
  real kits. Tripwire, with its positive twin (clear the failure, both complete).
- **The token is cached for ten days and never refreshed on a 401**, so a rotated credential fails
  every call for up to ten days. Tripwire — measured at the grant endpoint, because the results
  path throws a plain `Error` that never reaches dmi-api as a provider error.
- **Ref mapping is the only transformation on the way out, and the integration defaults silently**
  (`dog` / `male` for anything it does not recognise). Every order is therefore a cat and a female,
  placed with canonical codes; a broken mapping goes red naming `dog` or `male`. There are no
  breeds at all.
- **The provider's "services" are its unactivated kits**, so the mock enforces its inventory as a
  catalogue and depletes it on activation — and, uniquely, every kit code is invented, because a
  kit code names one physical kit rather than an assay.

## Known gaps

- **The full-stack CI jobs are scoped, not universal.** Each provider loop lives in its own workflow
  (`.github/workflows/e2e-idexx.yml`, `e2e-antech-v3.yml`, `e2e-zoetis.yml`, `e2e-antech-v6.yml`, `e2e-wisdom-panel.yml`) because each needs a
  `paths:` filter and those are per-workflow, not per-job. They run: on **push to `main`** always; on a **pull request** only
  when the harness, the mock, compose or that loop's scenario changes (a docs or tenant-isolation edit
  shouldn't pay for ~7 containers per provider — this matters more as the fan-out grows); and on
  demand via `workflow_dispatch`. They skip on **fork** PRs, which cannot read the org secrets they
  need. The fast `harness` job in `e2e.yml` still runs on every PR.
- **The demo loop is blocked upstream** (tracked privately). Run it with `HARNESS_STACK=demo`.
- **The antech-v3 and zoetis loops are slow by construction.** Both integrations hardcode their two Bull
  poll intervals to 30s with no env knob (idexx exposes `IDEXX_*_POLLING_INTERVAL_MS`, which the
  harness dials down to ~3s), so those scenarios wait whole intervals for a result. Making the
  interval env-configurable would be a small change in each integration repo and would cut this
  suite's runtime substantially — a possible team follow-up, out of scope here (both repos are
  read-only).
- **Full-stack re-runs with `HARNESS_KEEP_UP=1`.** The integration polls the shared mock via Bull jobs
  kept in the (persisted) Redis, so a stale job from a prior run could race a later run for its
  results. Both mock-backed scenarios avoid this by stopping their integration in `afterAll` (removing
  its jobs); if a run is interrupted before that, `docker compose --profile <loop> down -v` clears
  Redis. A normal (non-KEEP_UP) run tears Redis down every time, so it is never affected.
- **No wire-format snapshots** yet (a follow-up).
- **`maxWorkers: 1`.** One database, one event stream, one `seq` counter. Scenarios must not race.
