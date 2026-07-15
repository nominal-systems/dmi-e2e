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

### Full-system mode

The default suite is dmi-api alone under `NODE_ENV=seed`. `HARNESS_FULL_STACK=1` selects a second
jest project — `scenarios/full-stack-*.e2e.ts` — that runs dmi-api under a **normal `NODE_ENV`**
(so `createOrder` actually RPCs the engine over MQTT) against the real demo provider loop: ActiveMQ,
Redis, the demo vendor API (`dmi-demo-provider-api`, with its own MySQL) and the demo provider
integration (`dmi-engine-demo-provider-integration`), all behind the `full-stack` compose profile.

```bash
# builds the two Node-14 integration/vendor images (needs a GitHub Packages read token) and boots
# ~7 containers alongside dmi-api:
GHP_TOKEN=$(gh auth token) HARNESS_FULL_STACK=1 npm run test:harness
```

The two app images build from sibling checkouts (`../dmi-demo-provider-api`,
`../dmi-engine-demo-provider-integration`; override with `DMI_DEMO_PROVIDER_DIR` /
`DMI_DEMO_INTEGRATION_DIR`) and their `npm install` resolves `@nominal-systems/*` from GitHub
Packages, so `GHP_TOKEN` (a `read:packages` token — a `gh auth token` works) must be exported for the
Docker build. The fast suite needs no token.

**Status: the full-stack demo scenario is blocked upstream.** The end-to-end order→report loop cannot
close today because the demo integration on `main` is not compatible with the current dmi-api. The
dmi-api handlers, the vendor sim and this harness's plumbing are all sound — the gap is entirely in
the demo integration, and its fix is tracked privately (routed upstream), not in this repo. So
`full-stack-smoke.e2e.ts` ships with its completion assertions `describe.skip`ped and an active test
that *confirms* the break; the fast suite remains the default and is unaffected.

### Ports

Shifted off dmi-api's defaults so a developer's dev stack can keep running alongside the harness.

| Service  | Harness | dmi-api default |
|----------|---------|-----------------|
| dmi-api  | 3010    | 3000            |
| MySQL    | 3307    | 3306            |
| Mongo    | 27018   | 27017           |
| ActiveMQ | 1884    | 1883            |

Full-stack-only services (behind the `full-stack` compose profile):

| Service            | Harness | Notes |
|--------------------|---------|-------|
| demo-provider-api  | 3011    | the simulated vendor; harness mints keys here |
| Redis              | 6380    | the integration's Bull queues |
| demo-provider MySQL| 3308    | the vendor's own database |

## Environment

Every variable has a working default; the table exists so CI and debugging are not guesswork.

| Variable | Default | Purpose |
|---|---|---|
| `DMI_API_DIR` | `../dmi-api` | dmi-api checkout to build, migrate and run. Ignored when `HARNESS_MANAGE_APP=0`. |
| `HARNESS_HOST` | `127.0.0.1` | Host that the published container ports are reachable on. A single knob; each per-service `*_HOST` var (and the Mongo URI) defaults to it, so pointing the suite at a remote docker host is one variable. |
| `HARNESS_FULL_STACK` | `0` | `1` selects the full-system suite (the demo provider loop) instead of the default fast suite. See "Full-system mode". |
| `HARNESS_BASE_URL` | `http://127.0.0.1:3010` | dmi-api under test. Setting it implies `HARNESS_MANAGE_APP=0`. |
| `HARNESS_APP_PORT` | `3010` | Port the harness starts dmi-api on. |
| `HARNESS_ADMIN_USERNAME` / `_PASSWORD` | `admin` / `admin` | Basic-auth admin, for `POST /users`. |
| `HARNESS_SECRET_KEY` | a 32-byte literal | `aes-256-ctr` key for provider-config encryption. Must be exactly 32 bytes. |
| `HARNESS_JWT_SECRET_KEY` | `harness-jwt-secret` | |
| `HARNESS_MYSQL_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_DATABASE` | `127.0.0.1` / `3307` / `root` / `harness` / `dmi_harness` | Also consumed by `docker-compose.yml`. |
| `HARNESS_MONGO_URI` | `mongodb://127.0.0.1:27018/dmi_harness` | |
| `HARNESS_MONGO_PORT` | `27018` | Host port published by the Mongo container. |
| `HARNESS_ACTIVEMQ_HOST` / `_PORT` | `127.0.0.1` / `1884` | |
| `HARNESS_DEMO_PROVIDER_PORT` | `3011` | full-stack only. Host port for the demo vendor API (where the harness mints an X-Api-Key). |
| `HARNESS_DEMO_PROVIDER_URL` | `http://$HARNESS_HOST:3011/demo` | full-stack only. Host-facing demo vendor base URL (includes its `/demo` prefix). |
| `HARNESS_DEMO_PROVIDER_INTERNAL_URL` | `http://dmi-demo-provider-api:3000/demo` | full-stack only. URL the integration container uses to reach the vendor; stored verbatim in the dmi-api provider configuration, so it must resolve inside the compose network. |
| `HARNESS_REDIS_PORT` | `6380` | full-stack only. Host port for Redis (the integration's Bull queues). |
| `HARNESS_DEMO_MYSQL_PORT` / `_PASSWORD` / `_DATABASE` | `3308` / `demo` / `demo_provider` | full-stack only. The demo vendor's own MySQL (auto-synchronised schema). |
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
docker-compose.yml            base MySQL + Mongo + ActiveMQ; + a `full-stack` profile adding redis,
                              the demo vendor API (+ its MySQL) and the demo integration
src/
  env.ts                      all configuration, resolved once; HARNESS_HOST / HARNESS_FULL_STACK
  containers.ts               compose up/down (profile-aware), readiness polling, dmi-api migrations
  dmi-api.ts                  build, spawn `node dist/main`, poll /health, kill
  api-client.ts               immutable HTTP client: basic / bearer / api-key
  sql.ts                      mysql2 pool for setup and assertions
  seed.ts                     the quickstart flow; two independent orgs; demo-key minting
  global-setup.ts             orchestration, once per run
  global-teardown.ts          teardown, once per run
scenarios/
  smoke.e2e.ts                the stack is really up and really wired
  tenant-isolation.e2e.ts     the point of this suite
  full-stack-smoke.e2e.ts     the demo provider loop (HARNESS_FULL_STACK=1); gate blocked upstream
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

## Full-system findings (demo provider loop)

Standing the demo provider loop up (Phase 0) surfaced that `dmi-engine-demo-provider-integration` on
`main` is no longer compatible with the current dmi-api — over the MQTT transport it does not answer
dmi-api's engine RPCs, so the order → result → report loop cannot close. The vendor sim, dmi-api's
inbound handlers and all of this harness's plumbing are sound; the gap is entirely in the integration.
**None are fixed here** — the integration repo is read-only, and the detailed defect writeup is
**tracked privately** (routed upstream), not in this public repo. The full-stack scenario ships gated
on it: its completion assertions are `describe.skip`ped and an active test *confirms* the block
(`POST /orders` times out at the engine and the order lands in `ERROR`).

## Known gaps

- **The demo loop is blocked upstream.** `HARNESS_FULL_STACK=1` stands the whole topology up, but the
  order → report loop cannot close until the demo integration is fixed (tracked privately). The fast
  suite still inserts reports via `sql.ts` and its orders never leave `accepted`.
- **No wire-format snapshots** yet (a follow-up).
- **`maxWorkers: 1`.** One database, one event stream, one `seq` counter. Scenarios must not race.
