# Working in dmi-e2e

Guidance for AI-assisted sessions in this repo. [README.md](README.md) documents the harness itself —
how to run it, every environment variable, the findings it has produced. This file is about how to
**change** this repo without degrading the gate. The rules below were each learned the hard way; the
short version is that this suite's only product is a trustworthy red.

## What this repo is

Black-box e2e for the DMI platform: a fast suite (smoke + tenant isolation against a real dmi-api),
plus per-provider full-stack loops (`HARNESS_FULL_STACK=1 HARNESS_STACK=<provider>`) that boot the
**real** provider integration container against a **synthetic** vendor mock and assert the
order → result → report loop closes. This repo is **public**.

## Every assertion must be able to fail

A green e2e suite that cannot go red is worse than no suite — it manufactures confidence. A
retrospective mutation pass over an earlier loop found most mutations to the mock left the suite
green; the assertions were decorative. So:

- **When you add or change an assertion or mock behaviour, prove it can fail.** Mutate the mock —
  rename a field the integration's mapper reads, change a value the scenario asserts, drop an item,
  serve an empty set — and confirm the suite goes **red with a message naming what broke**. Revert
  the mutation. If a mutation leaves the suite green, the assertion is decorative: fix it.
- **Assert values, not existence.** `toBeDefined()` is as true of `LOW` as of `HIGH`. Compare result
  codes, units, numbers, reference-range bounds, and the identity chain report → order → patient.
- **Know the wire-value traps:** dmi-api persists enum *wire* values (`'H'`, not `'HIGH'`), and a
  deleted in-range interpretation serialises as `null`, not `undefined`.
- **Never "fix" a red build by relaxing an assertion.** See the README's section of the same name —
  reds here are usually the suite doing its job.

## Mocks imitate the vendor, not the test

A mock written alongside its own test encodes the author's *reading* of the vendor contract; when
that reading is wrong, mock and integration agree on a fiction and the test is green forever.

- **Read the integration's source first, write the mock second.** The contract is what the
  integration's client, mappers and interceptors actually send and parse — verify endpoints, auth,
  field names and element forms there; don't assume.
- **Validate, never default.** A mock that fills in a missing field can fabricate exactly the value
  the scenario asserts — the test then passes *because* of the defect it should catch. Reject
  missing required fields with the vendor's error status; a regressed integration must produce a
  loud red.
- **Error envelopes are part of the contract.** Match the *field names* and the *code values* the
  integration's error mapper actually reads (e.g. an envelope keyed `errorCode` where the mock said
  `code` leaves the mapper's real branch unexercised — the test stays red-capable but proves less
  than it claims). After wiring a rejection, trigger it once and read the surfaced HTTP error:
  "goes red" is not the same as "surfaces correctly".
- **Model the vendor's acknowledge semantics** (results persist until acked, then stop). A mock that
  serves results unconditionally forever leaves the integration's ack path untested.
- **Use real vendor catalogue codes** (test mnemonics) in the mock's catalogue, and **enforce it** —
  an invented code that both mock and scenario agree on is evidence about the author, not the
  vendor.

## Per-provider differences that bite

- **Reconciliation is provider-specific, and there are more than two shapes.** Whether an order must
  carry a `pims:patient:id` identifier — or must omit it — depends on what the provider's result
  mapper emits. But first check whether its results reach dmi-api's matching guard at all: a mapper
  that attaches no `.order` to a result (zoetis) makes reconciliation pure `externalId`, and the
  identifier becomes a free choice. Read the mapper **before** copying an existing scenario; the
  wrong choice strands orders at `SUBMITTED` forever. Background:
  [dmi-api#334](https://github.com/nominal-systems/dmi-api/issues/334).
- **Ref-mapped fields need value assertions, or they are not tested at all.** dmi-api maps an order's
  species/sex/breed from its canonical refs to provider codes before handing it to the engine, and
  falls back to forwarding the raw string when nothing resolves — so a scenario that places an order
  with a non-ref string exercises no mapping and cannot detect one breaking. Place with the canonical
  ref code (look it up over `GET /refs/*`; dmi's codes are opaque UUIDs), assert the **provider's**
  vocabulary arrived at the mock, and make sure the two strings differ. Which fields are mapped at
  all varies: check the provider's `provider_ref` rows, not just its reference endpoints.
- **Watch element multiplicity in XML dialects.** Where an integration calls `.find`/`.filter`/`.map`
  on a parsed collection without normalising, a one-element response deserialises to an object and
  throws. Grep the mapper and service for that before deciding how many of each element to emit. Then
  **enforce the requirement in the mock's control plane** with an explanatory error — a shape rule
  stated only in a comment leaves the next author a silent poll timeout.
- **A more faithful mock can WEAKEN an assertion that was sound against a cruder one.** Assertion
  strength does not transfer with the template — re-derive it per provider. Worked example: the idexx
  and antech mocks drop an order from the orders feed permanently once acked, so the only route to a
  `COMPLETED` order is the results channel, and waiting on `COMPLETED` is a fair reconciliation proof
  there. The zoetis mock instead models the vendor's re-notification on status change, which is more
  faithful — and that extra fidelity lets its orders poll reach `COMPLETED` on its own, so the same
  assertion passes with the results channel severed outright. It has to wait on the report reaching
  `FINAL`. Ask of every completion assertion: **which channels can satisfy this, and is the one I
  mean the only one?**
- **The idexx integration decides device inclusion from the vendor catalogue.** It fetches
  `/ref/tests`, and an order with any `inHouse` code must carry a `devices` serial or it is refused
  before reaching the vendor; an all-reference-lab order has its devices stripped. The mock's
  catalogue flags are therefore load-bearing, and the mock enforces the same rule so the integration's
  kill switch (`IDEXX_DEVICE_RULE_ENABLED`) cannot quietly turn the check off. Read the order's
  device serial from the mock's `/ivls/devices`, never a literal.
- **Poll intervals differ.** Some integrations expose an env knob the harness dials down (~3s);
  others hardcode ~30s. Budget scenario timeouts for at least one full poll tick and don't mistake
  the wait for a hang.
- Reuse the shared foundation (`HARNESS_STACK` selector, compose profiles, `src/seed.ts`,
  `src/poll.ts`, `src/containers.ts`, `src/env.ts`) rather than forking it per provider. **A new
  loop is one entry in `src/stacks.js`** (stack key → provider id, scenario, compose profile,
  integration checkout, mock endpoint, poll class) plus its compose profile, scenario and workflow —
  never another `if (env.stack === …)`; everything that varies by stack reads the registry.

## Data hygiene — this repo is public, and history is permanent

- **No credentials, real hostnames, or captured clinic/patient data — anywhere, ever**, including
  compose files, workflow files, comments, test names, and **git history** (a secret committed and
  later removed is still published).
- **Mock data is synthetic, authored fresh from the shapes.** Treat fixtures inside the private
  integration repos as potentially containing real clinic/patient data: read them to learn
  structure, copy no values. Genuine vendor *catalogue* identifiers (test codes) are fine and
  preferred.
- **Never point the harness at a live vendor host.** All base URLs resolve to the mock or the
  compose network.

## Git and PR discipline

- **There is no branch protection.** Branch from your local updated `main`
  (`git pull --ff-only && git switch -c <topic>`), never `git checkout -b <topic> origin/main`
  (that tracks `main`, and a stray push lands there). Make the first push explicit
  (`git push -u origin <topic>`) and verify `git rev-parse --abbrev-ref @{u}`.
- **Humans review and merge.** Never merge a PR; never post issue/PR comments or tick checkboxes on
  a human's behalf — draft the text and hand it over.
- **Provider PRs stay provider-only.** Cross-cutting changes (shared `src/`, another provider's
  scenario or workflow) go in their own PR so provider branches rebase cleanly.
- **Keep a running log in the PR description** — Progress, Corrections (where dmi-api or the
  integration differed from expectation), Deviations (+ why), Blockers, Findings (SUSPECTED /
  CONFIRMED, with evidence).
- **Defects found in private integration repos get no specifics here — and don't file them
  yourself.** Surface them to the human running the session, in a clearly separated section of your
  output; the human decides where (and whether) each gets tracked. In this repo, at most a neutral
  "tracked privately" note.

## Running

See the README ("Running it", "Environment"). Practical notes: prefer native Linux (the full-stack
loops build the integration Dockerfiles, which needs a GitHub Packages `read:packages` token as
`GHP_TOKEN`); a cold run is `docker compose down -v` first; `maxWorkers: 1` is load-bearing —
scenarios share one database and one event stream and must not race.
