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

### Ports

Shifted off dmi-api's defaults so a developer's dev stack can keep running alongside the harness.

| Service  | Harness | dmi-api default |
|----------|---------|-----------------|
| dmi-api  | 3010    | 3000            |
| MySQL    | 3307    | 3306            |
| Mongo    | 27018   | 27017           |
| ActiveMQ | 1884    | 1883            |

## Environment

Every variable has a working default; the table exists so CI and debugging are not guesswork.

| Variable | Default | Purpose |
|---|---|---|
| `DMI_API_DIR` | `../dmi-api` | dmi-api checkout to build, migrate and run. Ignored when `HARNESS_MANAGE_APP=0`. |
| `HARNESS_BASE_URL` | `http://127.0.0.1:3010` | dmi-api under test. Setting it implies `HARNESS_MANAGE_APP=0`. |
| `HARNESS_APP_PORT` | `3010` | Port the harness starts dmi-api on. |
| `HARNESS_ADMIN_USERNAME` / `_PASSWORD` | `admin` / `admin` | Basic-auth admin, for `POST /users`. |
| `HARNESS_SECRET_KEY` | a 32-byte literal | `aes-256-ctr` key for provider-config encryption. Must be exactly 32 bytes. |
| `HARNESS_JWT_SECRET_KEY` | `harness-jwt-secret` | |
| `HARNESS_MYSQL_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_DATABASE` | `127.0.0.1` / `3307` / `root` / `harness` / `dmi_harness` | Also consumed by `docker-compose.yml`. |
| `HARNESS_MONGO_URI` | `mongodb://127.0.0.1:27018/dmi_harness` | |
| `HARNESS_MONGO_PORT` | `27018` | Host port published by the Mongo container. |
| `HARNESS_ACTIVEMQ_HOST` / `_PORT` | `127.0.0.1` / `1884` | |
| `HARNESS_MANAGE_CONTAINERS` | `1` | `0` to bring your own MySQL/Mongo/ActiveMQ and schema. |
| `HARNESS_MANAGE_APP` | `1` unless `HARNESS_BASE_URL` is set | `0` to bring your own dmi-api. |
| `HARNESS_BUILD` | `1` | `0` to reuse an existing `dist/` in the checkout. |
| `HARNESS_KEEP_UP` | `0` | `1` to skip `docker compose down -v` on exit. |
| `HARNESS_DEPS_READY_MS` / `HARNESS_APP_READY_MS` | `180000` | Readiness budgets. |
| `HARNESS_REQUEST_MS` | `30000` | Per-request timeout. |

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
docker-compose.yml            MySQL + Mongo + ActiveMQ, own project & volumes
src/
  env.ts                      all configuration, resolved once
  containers.ts               compose up/down, readiness polling, dmi-api migrations
  dmi-api.ts                  build, spawn `node dist/main`, poll /health, kill
  api-client.ts               immutable HTTP client: basic / bearer / api-key
  sql.ts                      mysql2 pool for setup and assertions
  seed.ts                     the quickstart flow; two independent organizations
  global-setup.ts             orchestration, once per run
  global-teardown.ts          teardown, once per run
scenarios/
  smoke.e2e.ts                the stack is really up and really wired
  tenant-isolation.e2e.ts     the point of this suite
```

## Findings

The harness was built to test tenant isolation. Reading dmi-api's source turned up five distinct
places where it appears to be missing. **None are fixed here** — that is out of scope, and they
want a considered fix plus a data-exposure review, not a drive-by patch.

Each finding has a test that asserts the *correct* behaviour and is marked `it.failing`. That keeps
CI green while the defect exists, and turns the test red the moment someone fixes it — at which
point the `.failing` marker should be deleted in the same commit.

| # | Route | Defect | Status |
|---|---|---|---|
| F1 | `GET /events` | `getEventsForOrganization` takes an `organization` and never reads it. Returns **every tenant's** events. | SUSPECTED |
| F2 | `GET /reports/*` | `ReportsController` has **no guard**, and there is no global guard. Reachable **unauthenticated**. | SUSPECTED |
| F3 | `GET /reports/:id` | `getReport(id, _organization)` ignores the organization (has a `TODO` admitting it). | SUSPECTED |
| F4 | `POST /orders`, `POST /integrations` | Neither takes an `@Organization()`; referenced IDs are never checked for ownership. Cross-tenant **writes**. | SUSPECTED |
| F5 | `GET /orders/:id/report` | `getOrderReport(organization, orderId)` ignores the organization. | SUSPECTED |

**SUSPECTED** = read from dmi-api source. **CONFIRMED** = reproduced by this suite against a running
app. As of writing, all five are SUSPECTED: the suite has not yet been executed end-to-end (the
dmi-api checkout it drives has no dependencies installed — see Requirements). The
`HARNESS_IMPLEMENTATION_PLAN.md` log tracks their status.

F1 is the most serious: `GET /events` is reachable with any valid API key, and `event.data` for an
`order:created` event embeds the whole order — patient name, client name, veterinarian. F2 needs no
credentials at all, though report IDs are UUIDv4 and so are not enumerable. F4 compounds: on
success, org B binds its own practice to org A's provider configuration.

### Do not "fix" a red build by relaxing an assertion

If a test in `tenant-isolation.e2e.ts` fails with *"Failing test passed even though it was supposed
to fail"*, that is the tripwire firing: the underlying defect was fixed. Delete the `.failing`
marker and the comment above it. That is the only correct response.

## Known gaps

- **No engine, no demo lab.** The full order → report loop needs the demo provider stack; deferred.
  Reports are inserted via `sql.ts` rather than arriving over MQTT, and orders never leave
  `accepted`.
- **No wire-format snapshots** yet (a follow-up).
- **`maxWorkers: 1`.** One database, one event stream, one `seq` counter. Scenarios must not race.
