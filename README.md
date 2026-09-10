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
  index.html          one row per suite: result, counts, duration, when, what was under test
  <suite>/index.html  the full jest-html-reporters page (self-contained; open it from file://)
  <suite>/summary.json, <suite>/run.json   the data the index is built from
```

`<suite>` is `fast`, or the `HARNESS_STACK` name under `HARNESS_FULL_STACK=1`. Each run overwrites
its own suite's directory only, so running zoetis never hides the last idexx result. "Under test"
is `git describe` of this checkout, the dmi-api checkout and the integration checkout (`-dirty`
when one has local changes) — recorded at setup, before anything is built, so a run that dies
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

GitHub Actions reruns every suite nightly (`schedule:` in the four workflows) to catch upstream
drift, but a cloud run leaves no report anywhere you can open. The mac mini therefore runs the same
four suites itself each night and publishes each one, so the served index is never more than a day
old.

- [scripts/nightly.sh](scripts/nightly.sh) is the run. It fast-forwards this checkout, the dmi-api
  checkout and the three integration checkouts (ff-only; a checkout that cannot fast-forward is
  tested as it stands, and the report's "under test" column says so — and they need **ssh
  remotes**, because launchd has no credential source for https), makes sure Docker Desktop is
  up, then runs `fast`, `idexx`, `antech` and `zoetis` in turn with `HARNESS_PUBLISH_REPORT=1`. A
  red suite does not stop the loop; a suite that overruns `NIGHTLY_SUITE_TIMEOUT` (40 min) is killed
  and its containers removed. A lock keeps runs from overlapping. Each run writes a dated log under
  `~/Library/Logs/dmi-e2e/` ending in a one-line-per-suite summary; logs older than 14 days are
  pruned. It assumes nothing about the caller's environment (launchd sources no profile): PATH, nvm
  and `GHP_TOKEN` (from `gh auth token`) are resolved inside. It also runs the docker CLI from a
  `DOCKER_CONFIG` that mirrors `~/.docker` minus the credential store: under launchd, Docker
  Desktop's `docker-credential-desktop` blocks forever when a non-Apple binary (node, python3) is
  among its ancestors, and every image build then fails resolving its base image with
  `DeadlineExceeded`. Nothing here needs registry credentials, so the helper is simply never
  consulted. Runnable by hand, e.g. `NIGHTLY_SUITES=fast scripts/nightly.sh`.
- [docs/launchd/com.nominal.dmi-e2e.nightly.plist](docs/launchd/com.nominal.dmi-e2e.nightly.plist)
  schedules it at 03:00 local time as a **user LaunchAgent** — not a daemon, not cron — because the
  job needs what only the login session has: Docker Desktop, the `gh` token and write access to the
  nginx directory. `scripts/nightly-install.sh` renders the template for this checkout, writes it to
  `~/Library/LaunchAgents/` and loads it; `--uninstall` reverses that. The job runs whatever branch
  the checkout is on.

```bash
scripts/nightly-install.sh                                  # install / reinstall
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
- **`antech`** — the Phase 1 loop for **classic Antech** (provider id `antech`). dmi-api + ActiveMQ +
  Redis + the **Antech mock** (`src/antech-mock`, built from this repo) + the **real
  `dmi-engine-antech-integration`** container, behind the `antech` compose profile. Runs
  `scenarios/antech-full-stack.e2e.ts`.
- **`zoetis`** — the Phase 1 loop for **Zoetis VetSync v1** (provider id `zoetis`). dmi-api +
  ActiveMQ + Redis + the **Zoetis mock** (`src/zoetis-mock`, built from this repo) + the **real
  `dmi-engine-zoetis-integration`** container, behind the `zoetis` compose profile. Runs
  `scenarios/zoetis-full-stack.e2e.ts`.
- **`demo`** — the pre-existing demo loop (ActiveMQ, Redis, `dmi-demo-provider-api` + its MySQL, and
  `dmi-engine-demo-provider-integration`), behind the `full-stack` profile. Runs
  `scenarios/full-stack-smoke.e2e.ts`. **Blocked upstream** (see below).

```bash
# idexx (default): builds the mock image (no token) + the idexx integration image (needs a GitHub
# Packages read token) and boots ~7 containers alongside dmi-api:
GHP_TOKEN=$(gh auth token) HARNESS_FULL_STACK=1 npm run test:harness

# antech (classic): the Antech mock + the real antech integration.
GHP_TOKEN=$(gh auth token) HARNESS_FULL_STACK=1 HARNESS_STACK=antech npm run test:harness

# zoetis (VetSync v1): the Zoetis mock + the real zoetis integration.
GHP_TOKEN=$(gh auth token) HARNESS_FULL_STACK=1 HARNESS_STACK=zoetis npm run test:harness

# demo (the upstream-blocked loop):
GHP_TOKEN=$(gh auth token) HARNESS_FULL_STACK=1 HARNESS_STACK=demo npm run test:harness
```

Each integration image builds from a sibling checkout (`../dmi-engine-idexx-integration` /
`../dmi-engine-antech-integration` / `../dmi-engine-zoetis-integration`; override with
`DMI_IDEXX_INTEGRATION_DIR` / `DMI_ANTECH_INTEGRATION_DIR` / `DMI_ZOETIS_INTEGRATION_DIR`) and its
`npm install` resolves `@nominal-systems/*` from GitHub Packages, so `GHP_TOKEN` (a `read:packages`
token — a `gh auth token` works) must be exported for the Docker build. All three mocks are
zero-dependency Node servers built inline, so they need no token. The fast suite needs no token.

**The idexx loop closes end to end.** An order placed over real HTTP round-trips through the real
idexx integration and the mock vendor: `POST /orders?autoSubmitOrder=true` → the integration creates
the order at the mock and runs IDEXX's confirmOrder browser handshake against it → the integration's
results poll picks up a result the scenario seeds at the mock → dmi-api writes a `FINAL` report with
test results and moves the order to `COMPLETED`, and `/events` shows the `order:*`/`report:*`
sequence. The harness talks **only to the mock**, never to live `*.vetconnectplus.com`, so runs are
deterministic, need no credentials, and place no real orders. See "The VetConnect Plus mock" below.

**The antech loop closes end to end**, the same way and with the same guarantees: `POST /orders` →
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
  `AntechResultMapper` parses. See "The Antech mock" below.

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
- **Its species and sex really are ref-mapped**, which makes it the first loop where the scenario can
  assert dmi-api's ref mapping end to end. See "Full-system findings".

**Status: the `demo` scenario is blocked upstream.** Its end-to-end order→report loop cannot close
because the demo integration on `main` is not compatible with the current dmi-api. The dmi-api
handlers, the vendor sim and this harness's plumbing are all sound — the gap is entirely in the demo
integration, and its fix is tracked privately (routed upstream), not in this repo. So
`full-stack-smoke.e2e.ts` ships with its completion assertions `describe.skip`ped and an active test
that *confirms* the break; it is unaffected by, and independent of, the idexx loop.

### The VetConnect Plus mock

`src/idexx-mock/server.js` is a small, zero-dependency Node HTTP server that stands in for IDEXX's
VetConnect Plus vendor. It speaks IDEXX's **public, documented dialect** (developer.vetconnectplus.com)
closely enough for the real integration to drive it unmodified:

- **Ordering** (`/api/v1/*`): `POST /order`, `GET/DELETE /order/:id`, the external-orders poll, auth
  validate, and reference data — including the test catalogue (`/ref/tests`) and the clinic's one
  IVLS analyzer (`/ivls/devices`). The integration reads the catalogue's `inHouse` flag to decide
  whether an order must carry a device, and the mock enforces the same rule at placement: an
  in-house order without an `ivls` serial, or with one the clinic does not own, is refused.
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

### The Antech mock

`src/antech-mock/server.js` is the same idea for **classic Antech**: a small, zero-dependency Node
HTTP server that stands in for the Antech vendor API, speaking its `/api/v1.1` dialect closely enough
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
captured clinic/patient data. The service mnemonics are genuine Antech catalogue codes (vendor
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
  vendor, so an endpoint would be fiction.
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
and sex are the only order fields dmi-api actually *transforms* on the way to the vendor: a ref
mapping that silently stopped resolving would otherwise produce a well-formed order the mock accepted,
keeping the gate green while the vendor received a code it had never heard of.

All of its canned data is **synthetic**. The service codes (`CDP`, `HEM`, `T4`) and analyte codes
(`GLU`, `CRE`, `ALT`, `ALB`) are genuine Zoetis catalogue identifiers — vendor codes published to
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
| VetConnect Plus mock | 3012  | `idexx`     | the simulated IDEXX vendor; tests drive its `/__control__` plane |
| Antech mock        | 3013    | `antech`    | the simulated Antech vendor; tests drive its `/__control__` plane |
| Zoetis mock        | 3014    | `zoetis`    | the simulated Zoetis vendor; tests drive its `/__control__` plane |
| Redis              | 6380    | all         | the integration's Bull queues |
| demo-provider-api  | 3011    | `full-stack`| the simulated demo vendor; harness mints keys here |
| demo-provider MySQL| 3308    | `full-stack`| the demo vendor's own database |

## Environment

Every variable has a working default; the table exists so CI and debugging are not guesswork.

| Variable | Default | Purpose |
|---|---|---|
| `DMI_API_DIR` | `../dmi-api` | dmi-api checkout to build, migrate and run. Ignored when `HARNESS_MANAGE_APP=0`. |
| `HARNESS_HOST` | `127.0.0.1` | Host that the published container ports are reachable on. A single knob; each per-service `*_HOST` var (and the Mongo URI) defaults to it, so pointing the suite at a remote docker host is one variable. |
| `HARNESS_FULL_STACK` | `0` | `1` selects a full-system suite instead of the default fast suite. See "Full-system mode". |
| `HARNESS_STACK` | `idexx` | Which full-system loop `HARNESS_FULL_STACK=1` runs: `idexx` (real idexx integration + VetConnect Plus mock), `antech` (real classic-antech integration + Antech mock), `zoetis` (real zoetis integration + Zoetis mock) or `demo` (upstream-blocked demo loop). |
| `HARNESS_BASE_URL` | `http://127.0.0.1:3010` | dmi-api under test. Setting it implies `HARNESS_MANAGE_APP=0`. |
| `HARNESS_APP_PORT` | `3010` | Port the harness starts dmi-api on. |
| `HARNESS_ADMIN_USERNAME` / `_PASSWORD` | `admin` / `admin` | Basic-auth admin, for `POST /users`. |
| `HARNESS_SECRET_KEY` | a 32-byte literal | `aes-256-ctr` key for provider-config encryption. Must be exactly 32 bytes. |
| `HARNESS_JWT_SECRET_KEY` | `harness-jwt-secret` | |
| `HARNESS_MYSQL_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_DATABASE` | `127.0.0.1` / `3307` / `root` / `harness` / `dmi_harness` | Also consumed by `docker-compose.yml`. |
| `HARNESS_MONGO_URI` | `mongodb://127.0.0.1:27018/dmi_harness` | |
| `HARNESS_MONGO_PORT` | `27018` | Host port published by the Mongo container. |
| `HARNESS_ACTIVEMQ_HOST` / `_PORT` | `127.0.0.1` / `1884` | |
| `HARNESS_VCP_MOCK_PORT` | `3012` | idexx only. Host port for the VetConnect Plus mock (its `/__control__` plane and `/status`). |
| `HARNESS_VCP_MOCK_URL` | `http://$HARNESS_HOST:3012` | idexx only. Host-facing mock base URL the scenario drives. |
| `HARNESS_IDEXX_ORDERING_URL` / `_RESULT_URL` | `http://vetconnect-mock:3000` | idexx only. Compose-network base URLs stored in the provider config; the integration reaches the mock here. Never point at live `*.vetconnectplus.com`. |
| `HARNESS_IDEXX_PIMS_ID` / `_PIMS_VERSION` / `_USERNAME` / `_PASSWORD` / `_LOCALE` | `dmi-e2e-harness` / `1.0.0` / `harness-user` / `harness-pass` / `en` | idexx only. Dummy provider-config PIMS headers and integration credentials; the mock never authenticates for real. |
| `HARNESS_IDEXX_POLL_MS` | `3000` | idexx only. The integration's Bull results/orders polling interval (dialed down from its 30s default so the loop closes quickly). |
| `HARNESS_ANTECH_MOCK_PORT` | `3013` | antech only. Host port for the Antech mock (its `/__control__` plane and `/status`). |
| `HARNESS_ANTECH_MOCK_URL` | `http://$HARNESS_HOST:3013` | antech only. Host-facing mock base URL the scenario drives. |
| `HARNESS_ANTECH_BASE_URL` | `http://antech-mock:3000` | antech only. Compose-network base URL stored in the provider config; the integration appends `/api/v1.1/<endpoint>` to it. Never point at a live Antech host. |
| `HARNESS_ANTECH_UI_BASE_URL` | `http://antech-mock:3000` | antech only. Antech's web host. A required provider-config option, but only ever string-built into submission/manifest URIs — never fetched. Points at the mock so nothing can leak to a live host. |
| `HARNESS_ANTECH_PIMS_IDENTIFIER` | `HRN` | antech only. The 3-4 letter PIMS identifier; only appears in a generated requisition id (the harness supplies its own). |
| `HARNESS_ANTECH_USERNAME` / `_PASSWORD` / `_CLINIC_ID` | `harness-user` / `harness-pass` / `900001` | antech only. Dummy integration credentials; the mock never authenticates for real. |
| `HARNESS_ANTECH_LAB_ID` | `1` | antech only. dmi-api declares `LabId` as an **integer** provider option and rejects a string, so this stays a number. There is deliberately no antech poll-interval knob to pair with `HARNESS_IDEXX_POLL_MS`: that integration hardcodes its Bull intervals to 30s. |
| `HARNESS_ZOETIS_MOCK_PORT` | `3014` | zoetis only. Host port for the Zoetis mock (its `/__control__` plane and `/status`). |
| `HARNESS_ZOETIS_MOCK_URL` | `http://$HARNESS_HOST:3014` | zoetis only. Host-facing mock base URL the scenario drives. |
| `HARNESS_ZOETIS_BASE_URL` | `http://zoetis-mock:3000` | zoetis only. Compose-network base URL stored in the provider config; the integration appends `/vetsync/v1/<endpoint>` to it. Never point at a live Zoetis host. |
| `HARNESS_ZOETIS_PARTNER_ID` / `_PARTNER_PASSWORD` | `harness-partner` / `harness-pass` | zoetis only. Dummy provider-**configuration** credentials; the mock never authenticates for real. |
| `HARNESS_ZOETIS_CLIENT_ID` | `harness-client` | zoetis only. The dummy "FUSE Client ID" **integration** option. The integration joins it to `partnerId` as the HTTP Basic username `partnerId\clientId`, which is why the two live in different places. All four zoetis provider options are declared `string` by dmi-api — unlike antech's `LabId`, none is an integer. There is deliberately no zoetis poll-interval knob, for the same reason as antech. |
| `HARNESS_DEMO_PROVIDER_PORT` | `3011` | demo only. Host port for the demo vendor API (where the harness mints an X-Api-Key). |
| `HARNESS_DEMO_PROVIDER_URL` | `http://$HARNESS_HOST:3011/demo` | demo only. Host-facing demo vendor base URL (includes its `/demo` prefix). |
| `HARNESS_DEMO_PROVIDER_INTERNAL_URL` | `http://dmi-demo-provider-api:3000/demo` | demo only. URL the integration container uses to reach the vendor; stored verbatim in the dmi-api provider configuration, so it must resolve inside the compose network. |
| `HARNESS_REDIS_PORT` | `6380` | full-stack only (both loops). Host port for Redis (the integration's Bull queues). |
| `HARNESS_DEMO_MYSQL_PORT` / `_PASSWORD` / `_DATABASE` | `3308` / `demo` / `demo_provider` | demo only. The demo vendor's own MySQL (auto-synchronised schema). |
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
                              VetConnect Plus mock + the idexx integration), an `antech` profile
                              (redis + the Antech mock + the antech integration), a `zoetis` profile
                              (redis + the Zoetis mock + the zoetis integration) and a `full-stack`
                              profile (redis + the demo vendor + its MySQL + the demo integration)
src/
  env.ts                      all configuration, resolved once; HARNESS_HOST / HARNESS_FULL_STACK / HARNESS_STACK
  containers.ts               compose up/down (profile-aware), readiness polling, dmi-api migrations
  dmi-api.ts                  build, spawn `node dist/main`, poll /health, kill
  api-client.ts               immutable HTTP client: basic / bearer / api-key
  sql.ts                      mysql2 pool for setup and assertions
  seed.ts                     the quickstart flow; two independent orgs; provider config; admin login
  idexx-mock/server.js        the VetConnect Plus mock vendor (zero-dependency Node HTTP server)
  antech-mock/server.js       the Antech mock vendor (zero-dependency Node HTTP server)
  zoetis-mock/server.js       the Zoetis mock vendor (zero-dependency Node HTTP server)
  poll.ts                     pollUntil, shared by the full-system scenarios
  report/summary-reporter.js  jest reporter: writes reports/<suite>/summary.json when the run ends
  report/report.ts            run.json at setup, the run index, publishing to the nginx directory
  report/publish.ts           `npm run report:publish`
  global-setup.ts             orchestration, once per run
  global-teardown.ts          teardown, once per run
docs/nginx/dmi-e2e.conf       the nginx location block that serves the published reports
docs/launchd/*.plist          the nightly LaunchAgent for the mac mini (template; scripts/nightly-install.sh renders it)
scripts/
  nightly.sh                  every suite in turn, each report published — what the LaunchAgent runs
  nightly-install.sh          render + load (or --uninstall) the LaunchAgent on this machine
scenarios/
  smoke.e2e.ts                the stack is really up and really wired
  tenant-isolation.e2e.ts     the point of this suite
  idexx-full-stack.e2e.ts     the idexx loop (HARNESS_FULL_STACK=1); closes end to end
  antech-full-stack.e2e.ts    the antech loop (HARNESS_FULL_STACK=1 HARNESS_STACK=antech); closes end to end
  zoetis-full-stack.e2e.ts    the zoetis loop (HARNESS_FULL_STACK=1 HARNESS_STACK=zoetis); closes end to end
  full-stack-smoke.e2e.ts     the demo loop (HARNESS_FULL_STACK=1 HARNESS_STACK=demo); blocked upstream
```

## Findings

Tenant isolation was the first scenario this harness exercised — not the reason it exists (it is a
general-purpose real-services suite for the platform). That first pass immediately turned up six
distinct places where dmi-api's isolation or auth is missing. **None are fixed here** — that is out
of scope, and they want a considered fix plus a data-exposure review, not a drive-by patch.

Each finding has a test that asserts the *correct* behaviour and is marked `it.failing`. That keeps
CI green while the defect exists, and turns the test red the moment someone fixes it — at which
point the `.failing` marker should be deleted in the same commit.

| # | Route | Defect | Observed | Status |
|---|---|---|---|---|
| F1 | `GET /events` | `getEventsForOrganization` takes an `organization` and never reads it. Returns **every tenant's** events. | org B → **200**, sees org A's events; counts identical | **CONFIRMED** |
| F2 | `GET /reports/*` | `ReportsController` has **no guard**, and there is no global guard. Reachable **unauthenticated**. | anon → **200** | **CONFIRMED** |
| F3 | `GET /reports/:id` | `getReport(id, _organization)` ignores the organization (has a `TODO` admitting it). | org B → **200** | **CONFIRMED** |
| F4 | `POST /orders`, `POST /integrations` | Neither takes an `@Organization()`; referenced IDs are never checked for ownership. Cross-tenant **writes**. | org B → **201 Created** | **CONFIRMED** |
| F5 | `GET /orders/:id/report` | `getOrderReport(organization, orderId)` ignores the organization. | org B → **200** | **CONFIRMED** |
| F6 | `POST /users`, `GET /users` | HTTP Basic auth is unregistered: `BasicStrategy` is in no module's `providers`, so Passport has no `basic` strategy. | any → **500** "Unknown authentication strategy 'basic'" | **CONFIRMED** |

**SUSPECTED** = read from dmi-api source. **CONFIRMED** = reproduced by this suite against a running
app. As of the last run, **all six are CONFIRMED** — the suite executed end-to-end against a live
dmi-api and every defect reproduced with the status codes above. The `HARNESS_IMPLEMENTATION_PLAN.md`
log records the full probe output.

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
- **Results correlate to an order by its `externalId`** (the vendor order id the create RPC returned),
  and dmi-api completes the order only when the result's PIMS patient id matches the order's — so the
  order carries a `pims:patient:id` and the mock echoes it back in the result. Without one, the result
  lands as a duplicate orphan order and the original stays `SUBMITTED` — a dmi-api reconciliation bug
  tracked as [nominal-systems/dmi-api#334](https://github.com/nominal-systems/dmi-api/issues/334);
  the `pims:patient:id` is the workaround until it lands.
- **The broker must speak MQTT 5.0 shared subscriptions.** The engine transport uses
  `$share/<group>/<topic>` subscriptions; ActiveMQ 5.x "classic" (the old harness broker) silently
  drops them, so the harness broker is `eclipse-mosquitto:2` (see "The MQTT broker" below).

**The antech loop closes too** (Phase 1), confirming `dmi-engine-antech-integration` (the classic
`antech` provider) interoperates with the current dmi-api the same way. What the second provider
taught us, beyond the mechanics above:

- **The `pims:patient:id` workaround is provider-specific — and inverts for antech.** dmi-api's
  reconciliation guard (`ProviderResultUtils.isMatchingOrder`) compares `pims:patient:id` across the
  order it holds and the order the integration extracts from a result, and rejects the match when only
  one side carries one. The antech result mapper tags the patient it extracts with its **own**
  `antech:pet:id` system, never the PIMS one — so an antech order carrying a `pims:patient:id` can
  *never* be reconciled by its own results (dmi-api logs `Skipping order update ... patient/client
  mismatch` and the order sits at `SUBMITTED`). The antech scenario therefore deliberately places its
  order **without** a patient identifier, which leaves both sides without one — a state the guard
  treats as compatible — and falls back to matching on patient name + client last name. This is the
  exact opposite of the idexx scenario, which must *supply* one. The generalisable lesson: whether a
  provider needs the identifier depends on which identifier system *its* result mapper emits, so check
  the mapper before copying either scenario.
- **Two ids are in play and must agree.** The integration assigns the **raw body** of
  `External/OrderPlacement` as the order's `externalId`, but results are correlated by
  `ClinicAccessionID` — so a vendor whose placement response is anything other than the
  ClinicAccessionID would strand every result as an orphan. The mock echoes the requisition id back,
  which is the only self-consistent reading of the contract.
- **A mock that defaults is a mock that agrees with you.** The first cut of the antech mock filled in
  `PetName`/`ClientLastName`/test-code when an order omitted them — with exactly the values the
  scenario then asserted. That made the order-forwarding test unfalsifiable, and because dmi-api
  reconciles results on patient name + client last name, the fabricated values kept completion, the
  report and `/events` green too: an integration that stopped forwarding the patient would have
  shipped a permanently green gate. The mocks now validate required fields and reject unknown test
  codes. Worth checking in any vendor mock: **for each field the scenario asserts, ask what happens if
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
  dmi's codes are opaque UUIDs) and asserting the vendor received the *zoetis* vocabulary — `DOG` and
  `MALE_NEUTERED` — with the mock enforcing both. Input and expected output are deliberately
  different strings, so a no-op mapping fails loudly. Verified: pointing the order at a species with
  no zoetis mapping makes the mock reject placement with `'<uuid>' is not a Zoetis species code`.
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
RPCs, so its order → result → report loop cannot close. The vendor sim, dmi-api's inbound handlers and
all of this harness's plumbing are sound; the gap is entirely in that integration. **Not fixed here** —
the integration repo is read-only, and the detailed defect writeup is **tracked privately** (routed
upstream), not in this public repo. The demo scenario ships gated on it: its completion assertions are
`describe.skip`ped and an active test *confirms* the block (`POST /orders` times out at the engine and
the order lands in `ERROR`).

## Known gaps

- **The full-stack CI jobs are scoped, not universal.** Each provider loop lives in its own workflow
  (`.github/workflows/e2e-idexx.yml`, `e2e-antech.yml`, `e2e-zoetis.yml`) because each needs a
  `paths:` filter and those are per-workflow, not per-job. They run: on **push to `main`** always; on a **pull request** only
  when the harness, the mock, compose or that loop's scenario changes (a docs or tenant-isolation edit
  shouldn't pay for ~7 containers per provider — this matters more as the fan-out grows); and on
  demand via `workflow_dispatch`. They skip on **fork** PRs, which cannot read the org secrets they
  need. The fast `harness` job in `e2e.yml` still runs on every PR.
- **The demo loop is blocked upstream** (tracked privately). Run it with `HARNESS_STACK=demo`.
- **The antech and zoetis loops are slow by construction.** Both integrations hardcode their two Bull
  poll intervals to 30s with no env knob (idexx exposes `IDEXX_*_POLLING_INTERVAL_MS`, which the
  harness dials down to ~3s), so those scenarios wait whole intervals for a result. Making the
  interval env-configurable would be a small change in each integration repo and would cut this
  suite's runtime substantially — a possible team follow-up, out of scope here (both repos are
  read-only).
- **Only the zoetis loop asserts dmi-api's ref mapping.** The idexx and antech scenarios place orders
  with species/sex/breed strings that are not dmi ref codes, so the mapping no-ops and their
  assertions cover forwarding only (see "Full-system findings"). Porting the zoetis approach — place
  with canonical ref codes, assert the provider vocabulary at the mock — would close that gap for
  them, but it is a change to another provider's scenario and belongs in its own PR.
- **Full-stack re-runs with `HARNESS_KEEP_UP=1`.** The integration polls the shared mock via Bull jobs
  kept in the (persisted) Redis, so a stale job from a prior run could race a later run for its
  results. Both mock-backed scenarios avoid this by stopping their integration in `afterAll` (removing
  its jobs); if a run is interrupted before that, `docker compose --profile <loop> down -v` clears
  Redis. A normal (non-KEEP_UP) run tears Redis down every time, so it is never affected.
- **No wire-format snapshots** yet (a follow-up).
- **`maxWorkers: 1`.** One database, one event stream, one `seq` counter. Scenarios must not race.
