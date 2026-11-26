import { createHash, randomUUID } from 'crypto'
import { ApiClient, ApiResponse, expectOk } from '../src/api-client'
import { appEnv, env } from '../src/env'
import { pollUntil } from '../src/poll'
import { lookupRefCode } from '../src/refs'
import { adminLogin, orderPayload, seedOrganization, SeededOrg } from '../src/seed'
import { assertStackWhole, REDIS, restoreServices, serviceFaults, serviceLogs, waitForEveryServiceRunning, watchExits } from '../src/services'
import { closePool, query } from '../src/sql'

/* Full-system gate for Antech V6 (HARNESS_FULL_STACK=1, HARNESS_STACK=antech-v6): dmi-api under a
 * NORMAL NODE_ENV, wired over real MQTT/Bull/HTTP to the REAL `dmi-engine` container — which is
 * what hosts the antech-v6 integration in production, as an npm module rather than a container of
 * its own — and an Antech V6 mock provider (src/antech-v6-mock). Every hop is real except the
 * provider, which is the mock, so the run is deterministic and never touches a live Antech host.
 *
 * THE LOOP IS SHAPED DIFFERENTLY FROM THE OTHER THREE, in three ways that decide what the
 * assertions below can and cannot claim.
 *
 * 1. THE ENGINE IS SPLIT INTO TWO PROCESSES, as production runs it. `dmi-engine-api` attaches the
 *    MQTT handlers dmi-api RPCs (order create; integration create, which SCHEDULES the repeatable
 *    Bull jobs) and `dmi-engine-worker` runs those jobs against the mock. So an order is enqueued
 *    by one process and polled by another, through Redis. A loop that closes here has exercised
 *    that handoff; a single-role container would have hidden it.
 *
 * 2. THERE ARE TWO PLACEMENT PATHS, and the integration chooses between them. A real order
 *    (`POST /LabOrders/v6/Order`) only when the request asked for `autoSubmitOrder`, the
 *    integration option `autoSubmitEnabled` allows it, AND every ordered code is point-of-care per
 *    Antech's own test guide. Otherwise a PRE-ORDER (`.../PreOrderPlacement`) — a draft, which dmi
 *    reports as WAITING_FOR_INPUT with a `submissionUri` for a human to finish in Antech's UI.
 *    Both paths are driven below, and the POC catalogue flag is what selects between them, so the
 *    scenario picks its test codes BY FLAG (from the mock's control plane) and never by position.
 *
 * 3. THE ORDERS CHANNEL CARRIES THE PROVIDER'S OWN STATUS, BUT ONLY WHEN THE FEED OFFERS THE ORDER.
 *    `OrderStatus` is a STRING on the wire (`"Submitted"`, `"Received"`, `"In Progress"`,
 *    `"Partial"`, `"Final"`, …) and the integration maps it, ignoring case and surrounding
 *    whitespace: `Draft` to dmi ACCEPTED; `Submitted`, `Received` and `In Progress` to SUBMITTED,
 *    because dmi's PARTIAL means some tests are complete and available, and a lab that has only
 *    received the sample has produced none; `Partial` to PARTIAL; `Resulted` and `Final` to
 *    COMPLETED; `Expired` and `Canceled` to CANCELLED; anything it does not know to SUBMITTED,
 *    with a warning. A describe of its own drives `Final`, `Canceled`, `Expired` and `Partial`
 *    through the whole loop, and shows that `Received` and `In Progress` leave the order
 *    SUBMITTED, on orders that never get a result. What bounds the channel is the feed, not the
 *    mapping: the orders poll reads only records it has not acknowledged, and the provider was
 *    observed NOT to re-offer an acknowledged order when its status changes, so the mock does not
 *    either. An order acknowledged at `Submitted` never returns to the orders channel unless a test
 *    replays it through the control plane, or switches on the unchanged redelivery production has
 *    shown. The describe for nominal-systems/dmi-api#409 does that, per channel, on orders of its
 *    own: the results channel on the order whose result it redelivers, the orders channel on the
 *    promoted draft whose order form it redelivers. Seeding a result moves the mock's provider
 *    status to `Partial` or `Final`, so every result in this file — the headline order's, the
 *    CBC's, the promoted draft's, both of the partial order's deliveries, both of the redelivered
 *    result's and the one delivered beside it — is seeded only once the orders poll has
 *    acknowledged that order at `Submitted`, and the mock refuses a seed for an order it has not
 *    (409, unless the seed passes `allowUnacked`). That wait is what makes the order's PARTIAL or
 *    COMPLETED in those tests the results channel's alone. A report's PARTIAL or FINAL needs no
 *    such wait: dmi-api moves a report only on the results path. The orders channel makes two
 *    transitions without a replay: a promoted draft's WAITING_FOR_INPUT -> SUBMITTED, because
 *    promotion puts a record the poll has never acknowledged into the feed, and, in the
 *    dmi-api#409 describe, the redelivered order's SUBMITTED -> PARTIAL, because its redelivery
 *    puts it in every poll's feed.
 *
 * RECONCILIATION. dmi-api matches a polled result to its order on `externalId`, and for antech-v6
 * that is the whole of it: `mapAntechV6Result` attaches a `.order` to a result ONLY when the result
 * is an orphan (empty ClinicAccessionID), and this harness seeds no orphans — so dmi-api's
 * patient-matching guard (`ProviderResultUtils.isMatchingOrder`) is never consulted, as with zoetis,
 * and the `pims:patient:id` identifier plays no part in reconciliation. The orders here keep the
 * harness's default patient identifier, which becomes the provider's `PetID`, because carrying it
 * costs nothing and makes the forwarded patient assertable. The id that matters is
 * `requisitionId == ClinicAccessionID == externalId`.
 *
 * POLL CADENCE. The engine exposes ANTECH_V6_POLLING_INTERVAL_MS and the compose profile dials it
 * to ~3s (the engine's own default is 60s), so the waits below are short — but they still budget
 * several ticks, because the repeatable jobs are only scheduled once the integration's start event
 * has been handled. A slow pass is the poll cadence, not a hang.
 *
 * WHAT MAKES THESE ASSERTIONS WORTH ANYTHING is that the mock VALIDATES rather than defaults: it
 * refuses an order missing a required field, an order carrying a code outside the catalogue it
 * advertises, a call without an access token, a foreign clinic, and — verbatim, as the live
 * endpoint does — a BreedID that does not belong to its SpeciesID. A mock that substituted its own
 * values would make the forwarding assertions below pass against its own invention. */

/* The compose profile's ANTECH_V6_POLLING_INTERVAL_MS. */
const POLL_MS = 3_000

/* Generous multiples of the poll interval rather than tight ones: the first tick only happens once
 * the integration's start event has been handled and the repeatable jobs scheduled, and the orders
 * poll does a login + status + per-order result-status + (sometimes) a TRF fetch per tick. */
const COMPLETION_WAIT_MS = 60_000
const ORDER_ACK_WAIT_MS = 45_000
/* How long to wait before concluding that something did NOT happen. Used by the status-poll audit
 * tripwire, by the guard that a COMPLETED order does not go back, and by the two provider statuses
 * that leave an order SUBMITTED, where a short budget is the point. */
const NEGATIVE_WAIT_MS = 20_000
/* How long dmi-api gets to apply a status the orders poll has delivered. The orders-channel tests
 * start this wait only once the mock has re-acknowledged the order at its new status, and the
 * integration emits `external_orders` BEFORE it acknowledges, so all that is left is dmi-api
 * handling one event. Short, because a red waits it out. */
const STATUS_APPLIED_WAIT_MS = 20_000

/* ---- ref mapping ----
 *
 * dmi-api seeds NO antech-v6 `provider_ref` rows, so this scenario does what an operator does: it
 * syncs the provider's reference data (the engine reads the mock's `Master/v6/GetSpeciesBreed` and
 * its own local sex enum) and then maps canonical dmi refs onto provider refs: the headline
 * species / breed / sex trio, and the bird pair (see the constants below).
 *
 * The pairing below is the whole point of the mapping assertions. dmi's canonical codes are opaque
 * UUIDs, so the scenario looks each one up BY NAME over `GET /refs/*` rather than hard-coding a
 * UUID that would rot silently, and what must come out the other end is ANTECH's vocabulary —
 * numeric species and breed ids, and a two-letter sex code. Input and expected output are
 * deliberately different: if the mapping stopped resolving, the integration would fall back to its
 * own defaults (SpeciesID 49 + BreedID 370) and the mock would REFUSE the placement, because 370 is
 * species 41's breed and species 49's only breed is 648. That is a loud red, and it is the same
 * refusal the live endpoint gives. */
const SPECIES_REF_NAME = 'Canis familiaris'
const EXPECTED_SPECIES_ID = 41
const BREED_REF_NAME = 'Labrador Retriever'
const EXPECTED_BREED_ID = 130
const SEX_REF_NAME = 'Male Sterilized'
const EXPECTED_PET_SEX = 'CM'

/* Deliberately left UNMAPPED, for the fully-unmapped-patient tripwire at the bottom. `Felidae` is
 * the canonical dmi species ref for cats; nothing below maps it to antech-v6. */
const UNMAPPED_SPECIES_REF_NAME = 'Felidae'
/* A plain descriptive string, not a ref code: it resolves to nothing for any provider, so the
 * integration's breed fallback (370) is what reaches the mock. */
const UNMAPPED_BREED = 'Ragdoll'

/* The integration's own fallback pair, and the reason the tripwire exists. */
const DEFAULT_PET_SPECIES = 49
const DEFAULT_PET_BREED = 370

/* Birds. dmi has one species for them, `Avian`; Antech has no `Avian` and splits birds into 12
 * species, each with its own breeds, and refuses a breed sent under a species it does not belong
 * to. So `Avian` is mapped to ONE of them — 53 Psittacine, with 796 Parrot as that species' default
 * breed, the configuration a production that takes bird orders at all has to have — and the hawk's
 * breed ref is mapped to 834, a breed of a DIFFERENT species, 119 Raptor. The species that reaches
 * Antech is then the breed's, not `Avian`'s mapping. */
const AVIAN_SPECIES_REF_NAME = 'Avian'
const AVIAN_MAPPED_SPECIES_ID = 53
const AVIAN_DEFAULT_BREED_ID = 796
const HAWK_BREED_REF_NAME = 'Red-tailed Hawk (Buteo jamaicensis)'
const HAWK_BREED_ID = 834
const HAWK_SPECIES_ID = 119

/* Antech's ids are numbers sent as strings; `.sort()` alone would put '119' before '41'. */
function byNumber (a: string, b: string): number {
  return Number(a) - Number(b)
}

/* A clinic the seeded account does not own. The mock refuses the login, and the refusal surfaces
 * end to end as the provider's own bare-text body. */
const FOREIGN_CLINIC_ID = '999000'

/* ---- catalogue codes ----
 *
 * Genuine Antech mnemonics, named here because the panels differ in what they can demonstrate: the
 * Kidney Panel carries the chemistry analytes the value assertions pin, the CBC is the one profile
 * the integration RE-SEQUENCES, and the heartworm test is a single qualitative assay. They are
 * resolved against the mock's catalogue at setup and their POC flag is ASSERTED rather than assumed
 * — the flag is what selects between the two placement paths and what decides whether a TRF is
 * fetched, so a code whose flag changed would silently move three tests onto the other path.
 * `referenceLabCode` is picked by flag alone, since any non-POC code will do. */
const KIDNEY_PANEL_CODE = 'HDC-3'
const CBC_CODE = 'HHEM-1'
const HEARTWORM_CODE = 'HTR-1'

/* ---- seeded result content ----
 *
 * Every value, unit and reference range here is INVENTED within plausible veterinary limits. The
 * analyte names are the panels' own (and, for the CBC, exactly the names the integration's
 * re-sequencing table keys on — which is what makes the ordering assertion possible at all). */

/* Kidney Panel: an in-range numeric, an out-of-range numeric flagged HIGH, and a numeric sitting
 * exactly on its upper bound with no flag. Three distinct mapper branches. */
const KIDNEY_PANEL = [
  { test: 'BUN', testCodeExtID: 'BUN', result: '24.3', unit: 'mg/dl', range: '9.0-29.0' },
  {
    test: 'CREA',
    testCodeExtID: 'CREA',
    result: '2.4',
    unit: 'mg/dl',
    range: '0.5-1.8',
    abnormalFlag: 'H',
    comments: 'Repeat with a fasted sample.',
  },
  { test: 'GLOB', testCodeExtID: 'GLOB', result: '3.6', unit: 'g/dl', range: '2.0-3.6' },
]

/* The CBC, seeded DELIBERATELY OUT OF the integration's sequence. `TEST_RESULT_SEQUENCING_MAP`
 * re-orders the items of any unit code result whose OrderCode is `HHEM-1`, so the report must come
 * back in the map's order, not this one. `PLT Histogram` carries a non-numeric result, which is
 * both faithful (a histogram row has no number) and the one item here that takes the mapper's
 * valueString branch. */
const CBC_SEEDED_ORDER = [
  { test: 'PLT Histogram', testCodeExtID: 'PLTHIST', result: 'see attached' },
  { test: 'HCT', testCodeExtID: 'HCT', result: '44.5', unit: '%', range: '37.3-61.7' },
  { test: 'WBC', testCodeExtID: 'WBC', result: '11.2', unit: 'K/uL', range: '5.7-16.3' },
  { test: 'MPV', testCodeExtID: 'MPV', result: '11.4', unit: 'fL', range: '8.7-13.2' },
  { test: 'NEU', testCodeExtID: 'NEU', result: '7.8', unit: 'K/uL', range: '3.0-11.5' },
  { test: 'PLT', testCodeExtID: 'PLT', result: '320', unit: 'K/uL', range: '143-448' },
  { test: 'LYM', testCodeExtID: 'LYM', result: '2.1', unit: 'K/uL', range: '1.0-4.9' },
]

/* The order `TEST_RESULT_SEQUENCING_MAP['HHEM-1']` puts those seven in. Written out rather than
 * derived from the seed, so the assertion is a pin rather than a restatement of the input. */
const CBC_EXPECTED_ORDER = ['WBC', 'NEU', 'LYM', 'HCT', 'PLT', 'MPV', 'PLT Histogram']

interface Observation {
  code: string
  name?: string
  valueQuantity?: { value: number, units?: string | null } | null
  valueString?: string | null
  referenceRange?: Array<{ low?: number, high?: number, text?: string }> | null
  interpretation?: { code?: string, text?: string } | null
  notes?: string | null
}

interface TestResultSet {
  code: string
  name?: string
  observations?: Observation[]
}

interface ReportBody {
  id: string
  status: string
  testResultsSet?: TestResultSet[]
}

/* dmi-api's ref types, as the `ref`/`provider_ref` tables spell them: SINGULAR. The public
 * `GET /refs/<kind>` routes use the plural; the admin ones take a `:type` they pass straight into
 * the query, so they need the singular. */
type RefType = 'species' | 'breed' | 'sex'

interface ProviderRefItem {
  code: string
  name: string
  species?: string
}

interface CatalogueEntry {
  code: string
  name: string
  category: string
  price: number
  pointOfCare: boolean
  labId: number
}

interface MockOrder {
  clinicAccessionId: string
  vendorId: string
  kind: string
  labAccessionId: string | null
  orderStatus: string | null
  resultStatus: string | null
  orderAcked: boolean
  orderAckedStatus: string | null
  resultStatusAcked: boolean
  trfFetches: number
  clinicId: string
  labId: number | null
  petId: string | null
  petName: string
  petSex: string
  petAge: number | null
  petAgeUnits: string | null
  speciesId: number
  breedId: number
  clientFirstName: string
  clientLastName: string
  doctorFirstName: string
  doctorLastName: string
  orderCodes: string[]
  hasResult: boolean
  /* sha256 of each TRF the mock served for the order: regenerated per fetch, as production's are. */
  trfDigests: string[]
  /* Beside each digest, the provider status of the delivery that form went out with. */
  trfOrderStatuses: Array<string | null>
  /* The production redelivery the mock can be switched into, per channel, and its window counters. */
  redelivery: { results: RedeliveryWindow, orders: RedeliveryWindow }
}

interface RedeliveryWindow {
  on: boolean
  served: number
  acked: number
}

/* The mock's token revocation, as its control plane lists it (the mock's header, load-bearing
 * detail 10): the status it refuses with, how many tokens it refuses, the calls it refused per
 * operation, and the logins made while it was armed. */
interface Revocation {
  status: number
  armedAt: string
  revokedTokens: number
  refused: Record<string, number>
  logins: number
}

/* A transport fault as the mock reports it (src/mock-faults): what it was armed with, how many
 * requests it took, and, per request in arrival order, its outcome and the milliseconds from its
 * arrival to that outcome (null while still open). */
interface Fault {
  id: number
  fault: string
  times: number
  hits: number
  remaining: number
  open: number
  requests: Array<{ outcome: string | null, ms: number | null }>
}

/* One provider call in the mock's call log, as it arrived, with the answer it got. */
interface LoggedCall {
  seq: number
  at: string
  method: string
  path: string
  operation: string
  clinicAccessionId: string | null
  /* The labOrder status polls the mock had answered when the call arrived: two calls carrying the
   * same number were made within one orders poll. */
  labOrderPolls: number
  status: number | null
  retryAfter: string | null
}

describe('antech-v6 full-stack (Antech V6 mock)', () => {
  let root: ApiClient
  let org: SeededOrg
  let admin: ApiClient

  /* Host-facing client for the mock's control plane (/__control__/*) and its provider endpoints,
   * which a few tests probe directly to pin the error envelopes the loop never provokes. */
  const mock = ApiClient.create(env.antechV6.mockBaseUrl)

  /* The mock's catalogue, read from its control plane at setup. */
  let catalogue: CatalogueEntry[] = []
  let pocCodes: string[] = []
  let referenceLabCode = ''

  /* The provider's own reference data, read through the engine at setup (see beforeAll). */
  let liveSpecies: ProviderRefItem[] = []
  let liveBreeds: ProviderRefItem[] = []
  let liveSexes: ProviderRefItem[] = []
  /* What the admin ref sync did, recorded rather than asserted — the tripwire reports it. */
  let syncResponse: { status: number, ok: boolean, text: string } = { status: 0, ok: false, text: '' }
  let speciesRefsAfterSync = -1
  let providerRefsWereSeededDirectly = false

  /* Canonical dmi ref codes (opaque UUIDs), resolved by name at setup. */
  let speciesRefCode = ''
  let breedRefCode = ''
  let sexRefCode = ''
  let unmappedSpeciesRefCode = ''
  let avianSpeciesRefCode = ''
  let hawkBreedRefCode = ''

  /* The headline POC order. */
  let pocOrderId = ''
  let pocRequisitionId = ''
  let pocReportId = ''
  let pocLabAccessionId = ''
  /* Highest event seq observed before the headline result was seeded, so the /events assertion can
   * prove which events the RESULT loop produced rather than counting ones order creation emitted. */
  let seqBeforeSeed = 0

  /* The pre-order (draft) path. */
  let draftOrderId = ''
  let draftRequisitionId = ''

  let orderSeq = 0

  /* A patient built on the harness's defaults, with the ref codes the mapping will transform and a
   * unique PIMS identifier per order.
   *
   * NOTE the shape: `orderPayload`'s `patient:` override REPLACES the whole default patient,
   * identifier included, so anything that must survive is merged in here rather than assumed. */
  function patientFor (overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      name: 'Rex',
      sex: sexRefCode,
      species: speciesRefCode,
      breed: breedRefCode,
      identifier: [{ system: 'pims:patient:id', value: `pat-${randomUUID().slice(0, 8)}` }],
      ...overrides,
    }
  }

  function payloadFor (
    testCodes: string[],
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    orderSeq += 1
    const base = orderPayload(org.integrationId, {
      patient: patientFor(),
      testCodes: testCodes.map((code) => ({ code })),
    })
    /* A readable, unique requisitionId. It becomes the provider's ClinicAccessionID, the dmi
     * order's externalId, and the key the mock's control plane is addressed by — so making it
     * greppable per test pays for itself the first time a run goes red. */
    return { ...base, requisitionId: `hrn-v6-${orderSeq}-${randomUUID().slice(0, 8)}`, ...overrides }
  }

  async function mockOrder (clinicAccessionId: string): Promise<MockOrder> {
    return expectOk<MockOrder>(
      await mock.get(`/__control__/orders/${encodeURIComponent(clinicAccessionId)}`),
      `read order ${clinicAccessionId} from the mock control plane`,
    )
  }

  /* Wait for the orders poll to acknowledge an order AT `status` — `Submitted`, the status every
   * order is placed at, unless a test has since set another — and return the mock's record of it.
   * An order is acknowledged only after a full orders-poll cycle, and the integration emits
   * `external_orders` to dmi-api BEFORE it acknowledges, so once the ack has landed, dmi-api has
   * been handed the status the poll saw. The one copy of this wait in the file; a red names the
   * order and the acknowledgement the mock held when the budget ran out. */
  async function waitForOrderAck (clinicAccessionId: string, status = 'Submitted'): Promise<MockOrder> {
    const entry = await pollUntil(
      async () => await mockOrder(clinicAccessionId),
      (order) => order.orderAckedStatus === status,
      ORDER_ACK_WAIT_MS,
      1_000,
    )
    expect({ order: clinicAccessionId, acked: entry.orderAcked, at: entry.orderAckedStatus }).toEqual({
      order: clinicAccessionId,
      acked: true,
      at: status,
    })
    return entry
  }

  async function observationsFor (orderId: string): Promise<Observation[]> {
    const response = await org.api.get(`/orders/${orderId}/report`)
    const panels = (response.body?.testResultsSet ?? []) as TestResultSet[]
    return panels.flatMap((panel) => panel.observations ?? [])
  }

  /* Place a point-of-care order and wait for the orders poll to acknowledge it at `Submitted`.
   * Acknowledged, it is off the unacknowledged feed until a test replays it. `label` says what the
   * order is for, and goes into its requisitionId (lower case, a dash for each run of anything
   * else), so a red can be traced to the order. */
  async function placeAcknowledgedOrder (label: string): Promise<{ orderId: string, requisitionId: string }> {
    const payload = payloadFor([KIDNEY_PANEL_CODE], {
      requisitionId: `hrn-v6-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomUUID().slice(0, 8)}`,
    })
    const requisitionId = payload.requisitionId as string
    const created = expectOk<{ id: string, status: string }>(
      await org.api.post('/orders', payload, { autoSubmitOrder: true }),
      `place the order for '${label}'`,
    )
    expect(created.status).toBe('SUBMITTED')

    await waitForOrderAck(requisitionId)
    return { orderId: created.id, requisitionId }
  }

  /* Set the provider status, offer the record again, and wait for the orders poll to acknowledge
   * it AT that status. */
  async function advanceProviderStatus (requisitionId: string, orderStatus: string): Promise<void> {
    expectOk(
      await mock.post(`/__control__/orders/${encodeURIComponent(requisitionId)}/status`, {
        orderStatus,
        replay: true,
      }),
      `advance the provider order status to '${orderStatus}' and re-offer the record`,
    )
    await waitForOrderAck(requisitionId, orderStatus)
  }

  /* The results channel did nothing for this order: the mock holds no result for it (its control
   * plane answers 404 for the result, with its own message: the mock answers 404 for a path it
   * does not know too, so the status alone would prove little), and the order's report is the
   * one order creation made, REGISTERED with no panels — dmi-api moves a report only on the
   * results path. So a status the order reaches is the orders channel's doing. */
  async function expectNothingFromTheResultsChannel (orderId: string, requisitionId: string): Promise<void> {
    expect((await mockOrder(requisitionId)).hasResult).toBe(false)
    const result = await mock.get(`/__control__/orders/${encodeURIComponent(requisitionId)}/result`)
    expect(result.status).toBe(404)
    expect(result.body?.message).toMatch(/^no seeded result for/)

    const report = await org.api.get(`/orders/${orderId}/report`)
    expect({ status: report.body?.status, panels: report.body?.testResultsSet }).toEqual({
      status: 'REGISTERED',
      panels: [],
    })
  }

  /* What is armed at the mock: the error scenarios and the transport faults, per key, and the token
   * revocation, null when none is. */
  interface Armed {
    scenarios: Record<string, unknown>
    faults: Record<string, Fault>
    revocation: Revocation | null
  }

  async function armedAtMock (): Promise<Armed> {
    return expectOk<Armed>(await mock.get('/__control__/scenarios'), 'list what is armed at the mock')
  }

  /* The fault armed on `key` now, as the mock reports it (undefined once disarmed). */
  async function faultOn (key: string): Promise<Fault | undefined> {
    return (await armedAtMock()).faults[key]
  }

  /* Arm one transport fault, run the test's step, and disarm the fault whatever the step did: by its
   * id, so a disarm that runs late cannot take a later test's fault (src/mock-faults). Returns the
   * step's result and the fault as its disarm left it, with every request it took. Disarming
   * destroys a connection the fault still holds, so a step that needs a held answer to go out waits
   * for that before it returns. */
  async function withFault<T> (
    spec: { key: string, fault: string } & Record<string, unknown>,
    step: () => Promise<T>,
  ): Promise<{ result: T, fault: Fault }> {
    const armed = expectOk<{ fault: Fault }>(
      await mock.post('/__control__/scenarios', spec),
      `arm a ${spec.fault} on ${spec.key} at the mock`,
    )
    let result: T | undefined
    let fault: Fault | null = null
    try {
      result = await step()
    } finally {
      fault = expectOk<{ fault: Fault | null }>(
        await mock.delete(`/__control__/scenarios/${encodeURIComponent(spec.key)}?id=${armed.fault.id}`),
        `disarm the ${spec.fault} on ${spec.key}`,
      ).fault
    }
    if (fault == null) {
      throw new Error(`the ${spec.fault} armed on ${spec.key} (id ${armed.fault.id}) was gone before the test disarmed it`)
    }
    return { result: result as T, fault }
  }

  /* What a fault did, as one value: how many requests it took, and what became of each. */
  function fired (fault: Fault): { hits: number, outcomes: Array<string | null> } {
    return { hits: fault.hits, outcomes: fault.requests.map((request) => request.outcome) }
  }

  /* Whatever is still armed at the mock is cleared, and then named as a failure. Run after each test
   * that arms something: a test that failed or timed out before its own cleanup ran would otherwise
   * leave the next test a refused token or a one-shot answer, and the red would land in the wrong
   * test. Jest reports a failing `afterEach` on the test it followed, which is the one that left it
   * armed; clearing first means the tests after it start clean whatever happens here. */
  async function expectNothingLeftArmed (): Promise<void> {
    const { scenarios, faults, revocation } = await armedAtMock()
    const leftoverScenarios = Object.keys(scenarios)
    const leftoverFaults = Object.keys(faults)
    for (const key of new Set([...leftoverScenarios, ...leftoverFaults])) {
      expectOk(
        await mock.delete(`/__control__/scenarios/${encodeURIComponent(key)}`),
        `clear what is left armed on '${key}' at the mock`,
      )
    }
    if (revocation != null) await disarmRevocation()
    expect({ leftoverScenarios, leftoverFaults, leftoverRevocation: revocation }).toEqual({
      leftoverScenarios: [],
      leftoverFaults: [],
      leftoverRevocation: null,
    })
  }

  /* Revoke every token the mock has issued so far, refused with `status` (401 when left out); the
   * tokens later logins issue are accepted. */
  async function armRevocation (status?: number): Promise<Revocation> {
    return expectOk<{ revocation: Revocation }>(
      await mock.post('/__control__/revocation', status === undefined ? {} : { status }),
      `revoke the tokens the mock has issued${status === undefined ? '' : `, refusing them with ${status}`}`,
    ).revocation
  }

  async function revocationNow (): Promise<Revocation | null> {
    return expectOk<{ revocation: Revocation | null }>(
      await mock.get('/__control__/revocation'),
      'read the revocation at the mock',
    ).revocation
  }

  /* Disarm the revocation and return what it did, null if none was armed. The tokens it refused are
   * good again. Safe to call twice: each test disarms as soon as it is done with it, and again in
   * its `finally`. */
  async function disarmRevocation (): Promise<Revocation | null> {
    return expectOk<{ revocation: Revocation | null }>(
      await mock.delete('/__control__/revocation'),
      'disarm the revocation at the mock',
    ).revocation
  }

  /* A token from the mock's own login, as the integration gets one. */
  async function mintToken (): Promise<string> {
    return expectOk<{ Token: string }>(
      await mock.post('/Users/v6/Login', {
        UserName: env.antechV6.username,
        Password: env.antechV6.password,
        ClinicID: env.antechV6.clinicId,
      }),
      'log in to the mock directly',
    ).Token
  }

  /* The labOrder status feed, asked for directly with `token`. The harness's ApiClient speaks
   * dmi-api's auth schemes, not Antech's `accessToken` header, so provider-side probes go out over
   * plain fetch. */
  async function labOrderFeedWith (token: string): Promise<{ status: number, body: any }> {
    const response = await fetch(
      `${env.antechV6.mockBaseUrl}/LabResults/v6/GetStatus?serviceType=labOrder` +
        `&ClinicID=${encodeURIComponent(env.antechV6.clinicId)}&overrideAck=true&ClinicAccessionID=none`,
      { headers: { accessToken: token } },
    )
    return { status: response.status, body: await response.json() }
  }

  /* The provider calls the mock logged after `since`, of one operation. */
  async function loggedCalls (operation: string, since: number): Promise<LoggedCall[]> {
    return expectOk<{ calls: LoggedCall[] }>(
      await mock.get('/__control__/calls/log', { operation, since }),
      `read the mock's log of ${operation} calls`,
    ).calls
  }

  async function lastLoggedSeq (): Promise<number> {
    return expectOk<{ lastSeq: number }>(await mock.get('/__control__/calls/log', { since: Number.MAX_SAFE_INTEGER }), "read the mock's call log").lastSeq
  }

  /* The generic line the integration puts first in the error list of a failed placement: the URL
   * that failed, built from the baseUrl this scenario seeded into the provider configuration, so
   * the whole-list assertions in this file follow the harness's configuration rather than a host
   * written into the test. */
  function failedPost (endpoint: string): string {
    return `Failed to POST ${env.antechV6.baseUrl}${endpoint}`
  }

  /* Admin helpers for the ref sync + mapping. dmi ref ids are numeric row ids (the CODES are the
   * UUIDs), so both halves of a mapping have to be looked up rather than known.
   *
   * Two behaviours of the admin listings, worked around here and not yet filed upstream: both need
   * an explicit `page` — their query is typed as an intersection (`PaginationDto & {...}`) rather
   * than a DTO class, so the validation pipe never instantiates the DTO and its `page = 1` default
   * never applies; omitting it is a 500 ("Provided \"skip\" value is not a number") — and
   * `GET /admin/refs/:type` uses the path value verbatim as `ref.type = :type`, where the column
   * holds the SINGULAR ('species', 'breed', 'sex'), so the advertised `breeds` / `sexes` answer an
   * empty page and only `species` works, being spelled the same either way. */
  async function canonicalRefId (type: RefType, name: string): Promise<number> {
    const listing = expectOk<{ data: Array<{ id: number, name: string, code: string }> }>(
      await admin.get(`/admin/refs/${type}`, { search: name, page: 1, limit: 200 }),
      `list dmi ${type} refs matching '${name}'`,
    )
    const matches = listing.data.filter((ref) => ref.name === name)
    if (matches.length !== 1) {
      throw new Error(
        `expected exactly one dmi ${type} ref named '${name}', found ${matches.length}. ` +
          "dmi-api's ref seed has changed; pick a ref with a unique name.",
      )
    }
    return matches[0].id
  }

  async function providerRefs (type: RefType): Promise<Array<{ id: number, code: string, name: string }>> {
    const listing = expectOk<{ data: Array<{ id: number, code: string, name: string }> }>(
      await admin.get(`/admin/providers/antech-v6/refs/${type}`, { page: 1, limit: 500 }),
      `list antech-v6 ${type} provider refs`,
    )
    return listing.data
  }

  /* Write provider_ref rows straight into MySQL. The one sanctioned crack in the black box (see
   * src/sql.ts): no HTTP route creates a provider_ref, and the admin route that should is broken.
   * The table is part of dmi-api's migration-defined schema, so a schema change breaks this loudly
   * — which is the point of doing it in raw SQL rather than through an ORM. */
  async function insertProviderRefs (
    type: 'species' | 'breed' | 'sex',
    items: ProviderRefItem[],
  ): Promise<void> {
    for (const item of items) {
      await query(
        'INSERT INTO `provider_ref` (`code`, `name`, `species`, `type`, `provider`) VALUES (?, ?, ?, ?, ?)',
        [item.code, item.name, item.species ?? null, type, 'antech-v6'],
      )
    }
  }

  async function mapRef (type: RefType, refName: string, providerCode: string): Promise<void> {
    const refId = await canonicalRefId(type, refName)
    const providerRef = (await providerRefs(type)).find((entry) => entry.code === providerCode)
    if (providerRef === undefined) {
      throw new Error(
        `dmi-api holds no antech-v6 ${type} provider ref with code '${providerCode}' — ` +
          'either the reference data never reached it or the mock catalogue changed',
      )
    }
    expectOk(
      await admin.post(`/admin/refs/${refId}/mapping`, {
        providerId: 'antech-v6',
        providerRefId: providerRef.id,
      }),
      `map dmi ${type} '${refName}' to antech-v6 ${type} '${providerCode}'`,
    )
  }

  beforeAll(async () => {
    /* A fresh container starts clean; the reset only matters for warm reruns (HARNESS_KEEP_UP),
     * where it clears the previous run's orders and results. */
    await mock.post('/__control__/reset').catch(() => undefined)

    /* Read the catalogue the mock both advertises at /Tests/v6 and enforces at placement, so the
     * scenario and the mock cannot drift onto different code lists. */
    catalogue = expectOk<{ tests: CatalogueEntry[] }>(
      await mock.get('/__control__/catalogue'),
      'read the mock test catalogue',
    ).tests
    pocCodes = catalogue.filter((test) => test.pointOfCare).map((test) => test.code)
    referenceLabCode = catalogue.find((test) => !test.pointOfCare)?.code ?? ''

    root = ApiClient.create()
    org = await seedOrganization(root, 'antech-v6', {
      providerId: 'antech-v6',
      configuration: {
        baseUrl: env.antechV6.baseUrl,
        uiBaseUrl: env.antechV6.uiBaseUrl,
        PimsIdentifier: env.antechV6.pimsIdentifier,
      },
      integrationOptions: {
        username: env.antechV6.username,
        password: env.antechV6.password,
        clinicId: env.antechV6.clinicId,
        labId: env.antechV6.labId,
        /* Without this the integration refuses to auto-submit even when asked, and every order
         * below would take the pre-order path. */
        autoSubmitEnabled: true,
      },
    })

    admin = await adminLogin(root)

    /* Start the integration FIRST: the ref sync RPCs the engine, and the engine only answers for a
     * running integration's message pattern once its module is up. Starting also schedules the
     * repeatable Bull jobs, which is what makes the loop below run at all. */
    const startResponse = await admin.post(`/admin/integrations/${org.integrationId}/start`)
    console.log(
      `[antech-v6-scenario] integration start -> HTTP ${startResponse.status}: ${startResponse.text.slice(0, 200)}`,
    )
    expectOk(startResponse, 'start integration')

    /* Read the provider's reference data LIVE, through the engine. `GET /refs/<kind>/<providerId>`
     * does the same RPC dmi-api's ref sync does and hands the answer straight back without storing
     * it — so this is the round trip itself: dmi-api -> MQTT -> the engine -> the integration ->
     * the mock's `Master/v6/GetSpeciesBreed` (species and breeds) or the integration's own local
     * sex enum (sexes), and back. Everything downstream is derived from these three lists. */
    liveSpecies = expectOk<{ items: ProviderRefItem[] }>(
      await org.api.get('/refs/species/antech-v6', { integrationId: org.integrationId }),
      'read the antech-v6 species list through the engine',
    ).items
    liveBreeds = expectOk<{ items: ProviderRefItem[] }>(
      await org.api.get('/refs/breeds/antech-v6', { integrationId: org.integrationId }),
      'read the antech-v6 breed list through the engine',
    ).items
    liveSexes = expectOk<{ items: ProviderRefItem[] }>(
      await org.api.get('/refs/sexes/antech-v6', { integrationId: org.integrationId }),
      'read the antech-v6 sex list through the engine',
    ).items

    /* The operator's real path: dmi-api asks the engine for those same lists and UPSERTS them as
     * `provider_ref` rows, which is the only thing that makes a canonical ref mappable to a
     * provider code. It is attempted here rather than asserted, because it does not work — see the
     * tripwire below, which pins the correct behaviour. The outcome is recorded so that tripwire
     * can report what actually happened rather than re-running it. */
    syncResponse = await admin.post('/admin/refs/sync/antech-v6', undefined, {
      integrationId: org.integrationId,
    })
    console.log(
      `[antech-v6-scenario] refs sync -> HTTP ${syncResponse.status}: ${syncResponse.text.slice(0, 300)}`,
    )
    speciesRefsAfterSync = (await providerRefs('species')).length

    if (speciesRefsAfterSync === 0) {
      /* Fallback, so the ref-MAPPING coverage below is not lost to the sync defect. The rows are
       * built from the three lists fetched above — i.e. from the provider's own catalogue, read
       * over the wire this run — and not from literals in this file, so what dmi-api ends up
       * holding is still the provider's data rather than the test's opinion of it. Inserted
       * straight into MySQL because no other route creates a provider_ref; `POST /admin/refs/:id/
       * mapping`, which does work, then joins them to the canonical refs over HTTP as an operator
       * would. */
      await insertProviderRefs('species', liveSpecies)
      await insertProviderRefs('breed', liveBreeds)
      await insertProviderRefs('sex', liveSexes)
      providerRefsWereSeededDirectly = true
      console.log(
        '[antech-v6-scenario] the admin ref sync stored nothing; provider refs seeded directly from ' +
          'the catalogue the engine returned (see the ref-sync tripwire)',
      )
    }

    speciesRefCode = await lookupRefCode(org.api, 'species', SPECIES_REF_NAME)
    breedRefCode = await lookupRefCode(org.api, 'breeds', BREED_REF_NAME)
    sexRefCode = await lookupRefCode(org.api, 'sexes', SEX_REF_NAME)
    unmappedSpeciesRefCode = await lookupRefCode(org.api, 'species', UNMAPPED_SPECIES_REF_NAME)
    avianSpeciesRefCode = await lookupRefCode(org.api, 'species', AVIAN_SPECIES_REF_NAME)
    hawkBreedRefCode = await lookupRefCode(org.api, 'breeds', HAWK_BREED_REF_NAME)

    await mapRef('species', SPECIES_REF_NAME, String(EXPECTED_SPECIES_ID))
    await mapRef('breed', BREED_REF_NAME, String(EXPECTED_BREED_ID))
    await mapRef('sex', SEX_REF_NAME, EXPECTED_PET_SEX)

    /* The bird configuration (see the constants): `Avian` -> 53 Psittacine, 796 Parrot as the
     * provider-level default breed for 53, and the hawk's breed ref -> 834, a breed of 119 Raptor. */
    await mapRef('species', AVIAN_SPECIES_REF_NAME, String(AVIAN_MAPPED_SPECIES_ID))
    expectOk(
      await admin.put(
        `/admin/providers/antech-v6/defaultBreed?species=${AVIAN_MAPPED_SPECIES_ID}&breed=${AVIAN_DEFAULT_BREED_ID}`,
      ),
      `set antech-v6's default breed for species ${AVIAN_MAPPED_SPECIES_ID} to ${AVIAN_DEFAULT_BREED_ID}`,
    )
    await mapRef('breed', HAWK_BREED_REF_NAME, String(HAWK_BREED_ID))
  }, 180_000)

  afterAll(async () => {
    /* Stop this integration so its Bull jobs are removed. They live in the shared Redis, which
     * survives between runs under HARNESS_KEEP_UP; leaving them scheduled would let a prior run's
     * engine keep polling the mock and race a later run for its results. */
    if (admin != null && org?.integrationId != null) {
      await admin.post(`/admin/integrations/${org.integrationId}/stop`).catch(() => undefined)
    }
    await closePool()
  })

  describe('the full stack booted and is wired', () => {
    it('dmi-api is healthy under a normal NODE_ENV', async () => {
      const response = await ApiClient.create().get('/health')

      expect(response.status).toBe(200)
      expect(response.body.status).toBe('ok')
      expect(response.body.info).toMatchObject({
        database: { status: 'up' },
        mongo: { status: 'up' },
        activemq: { status: 'up' },
      })
    })

    it('the antech-v6 mock is reachable', async () => {
      const response = await mock.get('/status')

      expect(response.status).toBe(200)
      expect(response.body.status).toBe('ok')
      expect(response.body.service).toBe('antech-v6-mock')
    })

    it('the quickstart bootstrap completed (org, antech-v6 provider config, integration)', () => {
      expect(org.organizationId).toBeTruthy()
      expect(org.providerConfigurationId).toBeTruthy()
      expect(org.integrationId).toBeTruthy()
    })

    it('the mock starts the run with nothing armed: no error scenario, no transport fault, no token revocation', async () => {
      /* Every switch a test arms is listed until it is disarmed, so a run that inherited one from a
       * warm rerun, or a mock that came up armed, is named here before any test can be confused by
       * it. */
      expect(await armedAtMock()).toEqual({ scenarios: {}, faults: {}, revocation: null })
    })

    it('the mock is provisioned for the clinic and lab the integration was configured with', async () => {
      /* The mock refuses a login for a clinic it was not provisioned for, and refuses a ClinicID it
       * does not recognise on every other call — so if the harness's two halves were configured
       * with different clinics, nothing would work and the symptom would be an empty feed. Pinning
       * them against each other here turns that into a named failure at the first test instead. */
      const config = expectOk<{ clinicId: string, labId: number, pocCodes: string[], referenceLabCodes: string[] }>(
        await mock.get('/__control__/config'),
        'read the mock configuration',
      )

      expect(config.clinicId).toBe(env.antechV6.clinicId)
      expect(config.labId).toBe(Number(env.antechV6.labId))
      /* Both halves of the catalogue are non-empty, or the POC-driven placement decision would be
       * untestable in one direction. */
      expect(config.pocCodes.length).toBeGreaterThanOrEqual(2)
      expect(config.referenceLabCodes.length).toBeGreaterThanOrEqual(1)
      expect(referenceLabCode).toBeTruthy()
      expect(pocCodes).toEqual(config.pocCodes)

      /* The three named panels the tests below rely on, each asserted to be point-of-care rather
       * than assumed to be: the flag is what routes an order to the real-order endpoint instead of
       * the pre-order one, and what suppresses the TRF fetch. A code whose flag changed would move
       * three tests onto the other path without any of them saying so. And the reference-lab code
       * must NOT be point-of-care, or the pre-order path would never be taken at all. */
      for (const code of [KIDNEY_PANEL_CODE, CBC_CODE, HEARTWORM_CODE]) {
        expect({ code, pointOfCare: catalogue.find((test) => test.code === code)?.pointOfCare }).toEqual({
          code,
          pointOfCare: true,
        })
      }
      expect(catalogue.find((test) => test.code === referenceLabCode)?.pointOfCare).toBe(false)
    })

    it('the engine reads Antech\'s species, breed and sex catalogue over the reference-data RPC', () => {
      /* The round trip itself: dmi-api -> MQTT -> the engine -> the integration -> the mock's
       * `Master/v6/GetSpeciesBreed`, and back, fetched at setup through `GET /refs/<kind>/antech-v6`
       * (which does the RPC and returns the answer without storing it).
       *
       * The exact values matter. `getSpecies` maps each species to `{name, code: String(id)}` and
       * `getBreeds` FLATTENS the tree, tagging each breed with `species: String(species.id)` — so
       * this also pins that the flattening kept the parentage, which is the only thing that makes
       * the 49 + 370 pairing detectable further down. */
      expect(liveSpecies.map((item) => item.code).sort(byNumber)).toEqual(['41', '42', '49', '53', '119'])
      expect(liveSpecies.find((item) => item.code === '41')?.name).toBe('Canine')
      expect(liveSpecies.find((item) => item.code === '49')?.name).toBe('Other species')

      const labrador = liveBreeds.find((item) => item.code === String(EXPECTED_BREED_ID))
      expect(labrador?.name).toBe(BREED_REF_NAME)
      expect(labrador?.species).toBe(String(EXPECTED_SPECIES_ID))
      /* The pairing the unmapped-patient tripwire rests on, read from the provider rather than
       * asserted from memory: breed 370 belongs to species 41, and species 49's only breed is 648. */
      expect(liveBreeds.find((item) => item.code === String(DEFAULT_PET_BREED))?.species).toBe('41')
      expect(liveBreeds.filter((item) => item.species === String(DEFAULT_PET_SPECIES)).map((item) => item.code)).toEqual(['648'])

      /* Sexes need no provider endpoint at all — the integration derives them from its own local
       * enum, and this is the only place that is visible from outside. */
      expect(liveSexes.map((item) => item.code).sort()).toEqual(['CM', 'F', 'M', 'SF', 'U'])
      expect(liveSexes.find((item) => item.code === EXPECTED_PET_SEX)?.name).toBe('MALE_CASTRATED')
    })

    it('dmi-api holds antech-v6 provider refs matching that catalogue', async () => {
      /* dmi-api ships no antech-v6 provider_ref rows: everything here was produced this run, from
       * the lists the engine returned above. (By the admin sync when it works — see the tripwire —
       * and otherwise by the setup's direct insert of those same lists.) A canonical ref can only
       * be mapped to a provider code that exists as a row, so this is the precondition for every
       * mapping assertion below. */
      const species = await providerRefs('species')
      const breeds = await providerRefs('breed')
      const sexes = await providerRefs('sex')

      expect(species.map((ref) => ref.code).sort(byNumber)).toEqual(['41', '42', '49', '53', '119'])
      expect(species.find((ref) => ref.code === '41')?.name).toBe('Canine')

      expect(breeds.map((ref) => ref.code)).toContain(String(EXPECTED_BREED_ID))
      expect(breeds.find((ref) => ref.code === String(EXPECTED_BREED_ID))?.name).toBe(BREED_REF_NAME)
      /* Breed 370 belongs to species 41, and species 49 has exactly one breed, 648. That is what
       * makes the integration's own 49 + 370 fallback pair invalid at the provider. */
      expect(breeds.map((ref) => ref.code)).toContain(String(DEFAULT_PET_BREED))
      expect(breeds.map((ref) => ref.code)).toContain('648')

      /* Sexes come from the integration's local enum, not from any endpoint. */
      expect(sexes.map((ref) => ref.code).sort()).toEqual(['CM', 'F', 'M', 'SF', 'U'])
      expect(sexes.find((ref) => ref.code === EXPECTED_PET_SEX)?.name).toBe('MALE_CASTRATED')

      /* And the rows really are this provider's, not another's read by accident: every provider in
       * dmi-api has its own species/breed/sex rows, and antech (V3) uses the same numeric code
       * space as antech-v6. */
      expect(species.every((ref) => ref.code !== '')).toBe(true)
      expect(breeds.length).toBe(liveBreeds.length)
    })

    it('the dmi refs the orders are placed with resolve, and are not already the Antech codes', () => {
      /* Guards the falsifiability of every mapping assertion below. If a canonical code happened to
       * be spelled the same as the Antech code it maps to, "the mock received 41" would be equally
       * true of a working mapping and of no mapping at all. */
      expect(speciesRefCode).toBeTruthy()
      expect(breedRefCode).toBeTruthy()
      expect(sexRefCode).toBeTruthy()
      expect(unmappedSpeciesRefCode).toBeTruthy()

      expect(speciesRefCode).not.toBe(String(EXPECTED_SPECIES_ID))
      expect(breedRefCode).not.toBe(String(EXPECTED_BREED_ID))
      expect(sexRefCode).not.toBe(EXPECTED_PET_SEX)
      expect(unmappedSpeciesRefCode).not.toBe(speciesRefCode)
    })
  })

  describe('the auto-submit path: a point-of-care order is placed for real and the results channel closes it', () => {
    it('POST /orders?autoSubmitOrder=true places a real order, SUBMITTED, with externalId == requisitionId', async () => {
      /* Two POC codes, so the integration's "every ordered code is point-of-care" rule is exercised
       * over a set rather than a singleton — and so the result below can carry one unit that
       * reports analytes and one that reports none. */
      const payload = payloadFor([KIDNEY_PANEL_CODE, HEARTWORM_CODE])
      pocRequisitionId = payload.requisitionId as string

      const created = expectOk<{ id: string, externalId: string, requisitionId: string, status: string }>(
        await org.api.post('/orders', payload, { autoSubmitOrder: true }),
        'place an auto-submitted antech-v6 order',
      )
      pocOrderId = created.id

      expect(pocOrderId).toBeTruthy()
      /* `mapAntechV6Order` reports the ClinicAccessionID it SENT as both ids — the provider's own
       * numeric requisition id, which placement returns, is discarded. All three agreeing is the
       * entire basis of antech-v6 reconciliation: it is what lets a polled result find this order. */
      expect(created.requisitionId).toBe(pocRequisitionId)
      expect(created.externalId).toBe(pocRequisitionId)
      /* SUBMITTED, not WAITING_FOR_INPUT: proof the real-order path was taken rather than the
       * pre-order one, i.e. that the test guide was fetched and both codes were found POC. */
      expect(created.status).toBe('SUBMITTED')
    }, 60_000)

    it('the mock received it at the ORDER endpoint with the ref-mapped species, breed and sex', async () => {
      const received = await mockOrder(pocRequisitionId)

      /* `kind: 'order'` is the mock's record of WHICH endpoint was used. A pre-order would read
       * 'preorder' — so this distinguishes the two placement paths at the provider, not just at
       * dmi-api. */
      expect(received.kind).toBe('order')
      expect(received.clinicAccessionId).toBe(pocRequisitionId)
      expect(received.orderStatus).toBe('Submitted')
      expect(received.labAccessionId).toBeTruthy()
      pocLabAccessionId = received.labAccessionId as string

      /* THE POINT OF THIS TEST. species, breed and sex are the only order fields dmi-api transforms
       * on the way to the provider, and they must arrive in ANTECH's vocabulary. Asserting the
       * exact values — as NUMBERS for the two ids, which is what the integration's parseInt
       * produces — is what makes a silently broken mapping fail here rather than produce a
       * well-formed order carrying a code Antech has never heard of. (Belt and braces: the mock
       * also enforces its own species/breed tree at placement, so a fallback to 49 + 370 would have
       * been refused in the test above. Both checks are deliberate — one proves the provider
       * refuses it, this one proves what was actually sent.) */
      expect(received.speciesId).toBe(EXPECTED_SPECIES_ID)
      expect(received.breedId).toBe(EXPECTED_BREED_ID)
      expect(received.petSex).toBe(EXPECTED_PET_SEX)

      /* The rest of what the integration forwarded. The mock REJECTS an order missing any of these
       * rather than substituting a default, so a regression that dropped one fails at placement —
       * it cannot reach here and quietly match a mock-invented fallback. */
      expect(received.petName).toBe('Rex')
      expect(received.clientFirstName).toBe('Jane')
      expect(received.clientLastName).toBe('Doe')
      expect(received.doctorFirstName).toBe('Ann')
      expect(received.doctorLastName).toBe('Vet')
      expect([...received.orderCodes].sort()).toEqual([KIDNEY_PANEL_CODE, HEARTWORM_CODE].sort())

      /* The integration option and the provider configuration both reached the wire: the clinic id
       * is an integration option, and `LabID` is only sent when the option parses as a positive
       * integer. */
      expect(received.clinicId).toBe(env.antechV6.clinicId)
      expect(received.labId).toBe(Number(env.antechV6.labId))

      /* `extractPetAge`'s default, which fires because the harness order carries no birthdate.
       * Pinned so that a change to the default is a named failure rather than a silent one. */
      expect(received.petAge).toBe(1)
      expect(received.petAgeUnits).toBe('Y')
    })

    it('the orders channel acknowledged the order, and NO TRF was fetched (every code is point-of-care)', async () => {
      /* Waiting on the acknowledgement is what makes the TRF assertion mean anything: an order is
       * only acked after a full orders-poll cycle (poll -> status -> per-order result status ->
       * emit external_orders -> ack), so once the ack lands, the integration has provably decided
       * whether to fetch this order's TRF. Without the ack gate, "no TRF was fetched" would be
       * equally true of a poll that had not run yet.
       *
       * Acknowledged AT the status it was serving — the mock records which one, and the wait
       * asserts it — so this also pins that the ack followed the poll rather than preceding it. */
      const received = await waitForOrderAck(pocRequisitionId)

      /* The POC rule, observed at the provider. `getBatchOrders` skips the TRF when every mnemonic
       * on the order is point-of-care per the test guide — so a zero here is evidence of three
       * things at once: the test guide was fetched, POC_FLAG=Y really filtered, and the rule ran.
       * If the guide fetch had failed, `getPocCodes` returns undefined, nothing is in-house, and
       * the TRF would have been fetched. */
      expect(received.trfFetches).toBe(0)

      const calls = expectOk<{ testGuidePoc: number, getStatusLabOrder: number, getStatusLabResult: number }>(
        await mock.get('/__control__/calls'),
        'read the mock call counters',
      )
      expect(calls.testGuidePoc).toBeGreaterThanOrEqual(1)
      /* The orders poll fetches the per-order result status inside the same loop; both must have
       * run for the merged order to carry a patient at all. */
      expect(calls.getStatusLabOrder).toBeGreaterThanOrEqual(1)
      expect(calls.getStatusLabResult).toBeGreaterThanOrEqual(1)
    }, ORDER_ACK_WAIT_MS + 30_000)

    it('seeding a result closes the loop: the report reaches FINAL and the order COMPLETED', async () => {
      /* Watermark the event stream before seeding, so the /events test below can distinguish events
       * the RESULT loop produced from the ones order creation already emitted. */
      const before = expectOk<{ data: Array<{ seq: number }> }>(
        await org.api.get('/events', { start_seq: 0, limit: 1000 }),
        'read the event stream before seeding',
      )
      seqBeforeSeed = before.data.reduce((max, event) => Math.max(max, event.seq ?? 0), 0)
      expect(seqBeforeSeed).toBeGreaterThan(0)

      /* Deterministic completion: the mock holds no results until a test seeds one, so the results
       * poll stays empty until this point.
       *
       * TWO unit code results, and the second one is the point of the pair: a unit with
       * ResultStatus 'F' and NO TestCodeResults is FILTERED OUT by the integration (a test that
       * finished with nothing to report). Seeding one is the only way that filter is covered, and
       * without it a filter that stopped working would be invisible. */
      expectOk(
        await mock.post(`/__control__/orders/${encodeURIComponent(pocRequisitionId)}/results`, {
          unitCodeResults: [
            { orderCode: KIDNEY_PANEL_CODE, testCodeResults: KIDNEY_PANEL },
            { orderCode: HEARTWORM_CODE, resultStatus: 'F', testCodeResults: [] },
          ],
          pendingTestCount: 0,
          totalTestCount: 2,
        }),
        'seed a final result at the mock',
      )

      /* Wait on the REPORT reaching FINAL rather than on the order reaching COMPLETED, and ask the
       * question CLAUDE.md insists on: which channels can satisfy this assertion?
       *
       * For the report the answer is unusually clean. dmi-api sets a report to FINAL in exactly one
       * place (ReportsService, on the `external_results` path); order creation leaves it REGISTERED
       * and no orders-poll path touches it. So FINAL is reachable only through the results channel.
       * The ORDER's COMPLETED takes one more step of reasoning, because the orders channel can
       * complete an order too — a polled `Final` does (see the file header), and seeding just moved
       * the mock's provider status to `Final`. It cannot reach the orders channel: this order was
       * acknowledged at 'Submitted' in the previous test and the mock does not re-notify on a status
       * change, so it never returns to the unacknowledged feed. Both assertions are the results
       * channel's. */
      const report = await pollUntil(
        async () => await org.api.get(`/orders/${pocOrderId}/report`),
        (response) => response.body?.status === 'FINAL',
        COMPLETION_WAIT_MS,
        1_000,
      )
      expect(report.body.status).toBe('FINAL')
      pocReportId = report.body.id

      const order = await org.api.get(`/orders/${pocOrderId}`)
      expect(order.body.status).toBe('COMPLETED')
    }, COMPLETION_WAIT_MS + 30_000)

    it('the report carries the exact values, units, range bounds and interpretation codes', async () => {
      const report = expectOk<ReportBody>(
        await org.api.get(`/orders/${pocOrderId}/report`),
        'read the order report',
      )

      expect(report.status).toBe('FINAL')
      /* EXACTLY one panel, and it is the one that reported analytes. The second seeded unit —
       * ResultStatus 'F' with no TestCodeResults — must have been dropped by the integration's
       * filter; if it stopped filtering, this is two panels, not zero, so the failure names itself. */
      expect((report.testResultsSet ?? []).map((panel) => panel.code)).toEqual([KIDNEY_PANEL_CODE])
      expect(report.testResultsSet?.[0]?.name).toBe('Kidney Panel')

      const observations = report.testResultsSet?.[0]?.observations ?? []
      expect(observations.map((observation) => observation.code)).toEqual(['BUN', 'CREA', 'GLOB'])

      /* BUN: an in-range numeric with units and both range bounds. The `9.0-29.0` text form is
       * split by the integration into low/high, and both are asserted — a range that stopped
       * parsing would still be "defined". */
      const bun = observations.find((observation) => observation.code === 'BUN')
      expect(bun?.name).toBe('BUN')
      expect(bun?.valueQuantity?.value).toBe(24.3)
      expect(bun?.valueQuantity?.units).toBe('mg/dl')
      expect(bun?.referenceRange).toEqual([
        expect.objectContaining({ low: 9, high: 29, text: '9.0-29.0' }),
      ])
      /* No AbnormalFlag on the wire means no interpretation at all. dmi-api serialises the absent
       * interpretation as an explicit null (a nullable column), so normalise before asserting
       * rather than expecting undefined. */
      expect(bun?.interpretation ?? null).toBeNull()

      /* CREA: out of range and flagged. 'H' is the WIRE value of dmi-engine-common's
       * TestResultItemInterpretationCode.HIGH — 'L' is LOW — so pinning it exactly distinguishes an
       * inverted flag from a missing one, which `toBeDefined()` would not. `text` carries Antech's
       * own flag character. And `Comments` become the observation's notes. */
      const crea = observations.find((observation) => observation.code === 'CREA')
      expect(crea?.valueQuantity?.value).toBe(2.4)
      expect(crea?.valueQuantity?.units).toBe('mg/dl')
      expect(crea?.referenceRange).toEqual([
        expect.objectContaining({ low: 0.5, high: 1.8, text: '0.5-1.8' }),
      ])
      expect(crea?.interpretation).toMatchObject({ code: 'H', text: 'H' })
      expect(crea?.notes).toBe('Repeat with a fasted sample.')

      /* GLOB: sitting exactly on its upper bound, unflagged. Pinned because "on the boundary" is
       * where an off-by-one in a range check would show, and because it is the third distinct
       * shape in this panel. */
      const glob = observations.find((observation) => observation.code === 'GLOB')
      expect(glob?.valueQuantity?.value).toBe(3.6)
      expect(glob?.valueQuantity?.units).toBe('g/dl')
      expect(glob?.referenceRange).toEqual([
        expect.objectContaining({ low: 2, high: 3.6, text: '2.0-3.6' }),
      ])
      expect(glob?.interpretation ?? null).toBeNull()
    })

    it('the result was served once and acknowledged once, on the irregular labAccessionsIds channel', async () => {
      /* Antech's acknowledge model is the reason this assertion exists. The integration emits the
       * results to dmi-api and THEN acks them by LabAccessionID; an acknowledged result leaves the
       * GetAllResults feed. If it did not — if the mock served results unconditionally, or if the
       * ack body's irregular plural (`labAccessionsIds`, note the extra s) stopped matching — the
       * feed would redeliver the same document every tick forever. dmi-api merges redeliveries, so
       * the report would still read FINAL and every assertion above would stay green: exactly once
       * is the only thing that catches it.
       *
       * Waited out over several poll intervals first, so "once" means "and not again", not "not
       * yet". */
      await new Promise((resolve) => setTimeout(resolve, POLL_MS * 4))

      const result = expectOk<{
        labAccessionId: string
        acknowledged: boolean
        servedCount: number
        ackCount: number
      }>(
        await mock.get(`/__control__/orders/${encodeURIComponent(pocRequisitionId)}/result`),
        'read the seeded result state from the mock control plane',
      )

      expect(result.labAccessionId).toBe(pocLabAccessionId)
      expect(result.acknowledged).toBe(true)
      expect(result.servedCount).toBe(1)
      expect(result.ackCount).toBe(1)
    }, 60_000)

    it('Mongo events show the order and report lifecycle, including the result loop', async () => {
      const events = expectOk<{
        data: Array<{ seq: number, type: string, data?: { orderId?: string, reportId?: string } }>
      }>(await org.api.get('/events', { start_seq: 0, limit: 1000 }), 'list events')

      /* Scope to this order/report explicitly: /events is not tenant-scoped (a known dmi-api
       * finding), and this file places several orders. */
      const mine = events.data.filter(
        (event) => event.data?.orderId === pocOrderId || event.data?.reportId === pocReportId,
      )

      expect(Array.from(new Set(mine.map((event) => event.type)))).toEqual(
        expect.arrayContaining(['order:created', 'order:updated', 'report:created', 'report:updated']),
      )

      /* That set is weaker than it looks: order:created, order:updated AND report:created are all
       * emitted while the order is being placed, before any result exists. So assert separately on
       * the events that appeared only AFTER the result was seeded — that is the part the result
       * loop is responsible for, and the part that would go missing if reconciliation broke. */
      const afterSeed = new Set(
        mine.filter((event) => event.seq > seqBeforeSeed).map((event) => event.type),
      )
      expect(Array.from(afterSeed)).toEqual(
        expect.arrayContaining(['order:updated', 'report:updated']),
      )
    })

    it('the audit trail recorded the placement against this integration, with its accession id', async () => {
      /* Every provider response the integration's interceptor does not filter is emitted as
       * `raw_data` and stored by dmi-api. Asserting the PLACEMENT record is a positive check on
       * three separate things: the interceptor ran, its `extractAccessionIds` picked the
       * ClinicAccessionID out of the request body, and the integration id travelled with the call
       * (it comes from the request context the engine's module installs). */
      const records = await pollUntil(
        async () =>
          expectOk<{ data: Array<{ url: string, status: number, method: string, accessionIds?: string[], provider: string }> }>(
            await admin.get('/admin/external-requests', {
              providers: 'antech-v6',
              integrationId: org.integrationId,
              page: 1,
              limit: 200,
            }),
            'read the antech-v6 audit trail',
          ).data,
        (data) => data.some((record) => record.url.includes('/LabOrders/v6/Order')),
        ORDER_ACK_WAIT_MS,
        1_000,
      )

      const placement = records.find((record) => record.url.includes('/LabOrders/v6/Order'))
      expect(placement).toBeDefined()
      expect(placement?.provider).toBe('antech-v6')
      expect(placement?.method).toBe('POST')
      expect(placement?.status).toBe(200)
      expect(placement?.accessionIds).toEqual([pocRequisitionId])

      /* The login is deliberately NOT audited on the success path (the interceptor excludes it), so
       * its absence is a pin too: a change that started storing credentials-adjacent traffic would
       * fail here. */
      expect(records.some((record) => record.url.includes('/Users/v6/Login') && record.status < 400)).toBe(false)
    }, ORDER_ACK_WAIT_MS + 30_000)
  })

  describe('a bird goes out as its mapped breed\'s species, else as the Avian mapping and its default breed', () => {
    /* dmi has one species for birds, `Avian`; Antech has twelve, each with its own breeds, and
     * refuses a breed sent under another species. So the breed is what names a bird's species:
     * when it resolves to a provider breed, dmi-api sends that breed's own species; when it does
     * not, the species mapping and its default breed decide. All three orders go on the
     * auto-submit path, so the mock's breed-belongs-to-species check judges each pair at the real
     * ORDER endpoint, as the provider does. */
    it('a hawk whose breed is mapped to Antech\'s red-tailed hawk goes out as 119 Raptor / 834, not as the species Avian maps to', async () => {
      /* The breed decides the species. The hawk's breed ref is mapped to 834, a breed of 119
       * Raptor, so 119 / 834 is the only pair the provider accepts for it — and dmi-api sends it,
       * whatever `Avian` is mapped to (53 Psittacine here). Was an `it.failing` tripwire until
       * nominal-systems/dmi-api#383 (for #377): before it, dmi-api mapped species and breed
       * independently and sent 53 / 834, which the provider refused with `Invalid BreedId 834`.
       * The refs guard below pins that 834 really is filed under 119 in the catalogue the engine
       * returned, so this cannot pass by the mock's tree drifting. */
      const payload = payloadFor([KIDNEY_PANEL_CODE], {
        patient: patientFor({ name: 'Talon', species: avianSpeciesRefCode, breed: hawkBreedRefCode }),
        requisitionId: `hrn-v6-hawk-${randomUUID().slice(0, 8)}`,
      })
      const requisitionId = payload.requisitionId as string

      const response = await org.api.post('/orders', payload, { autoSubmitOrder: true })
      /* Status and refusal together, so a refused placement fails naming the provider's reason. */
      expect({ status: response.status, refusal: response.ok ? '' : response.text.slice(0, 300) }).toEqual({
        status: 201,
        refusal: '',
      })
      expect(response.body.status).toBe('SUBMITTED')

      const received = await mockOrder(requisitionId)
      expect(received.kind).toBe('order')
      expect({ speciesId: received.speciesId, breedId: received.breedId }).toEqual({
        speciesId: HAWK_SPECIES_ID,
        breedId: HAWK_BREED_ID,
      })
    }, 60_000)

    it('an Avian patient with no breed goes out as the species mapping and its default breed: 53 / 796', async () => {
      /* `breed: undefined` drops the key from the JSON body: the order carries no breed at all. */
      const payload = payloadFor([KIDNEY_PANEL_CODE], {
        patient: patientFor({ name: 'Polly', species: avianSpeciesRefCode, breed: undefined }),
        requisitionId: `hrn-v6-avian-${randomUUID().slice(0, 8)}`,
      })
      const requisitionId = payload.requisitionId as string

      const response = await org.api.post('/orders', payload, { autoSubmitOrder: true })
      expect({ status: response.status, refusal: response.ok ? '' : response.text.slice(0, 300) }).toEqual({
        status: 201,
        refusal: '',
      })
      expect(response.body.status).toBe('SUBMITTED')

      const received = await mockOrder(requisitionId)
      expect(received.kind).toBe('order')
      expect({ speciesId: received.speciesId, breedId: received.breedId }).toEqual({
        speciesId: AVIAN_MAPPED_SPECIES_ID,
        breedId: AVIAN_DEFAULT_BREED_ID,
      })
    }, 60_000)

    it('an Avian patient with an unmapped breed takes the same fallback: 53 / 796', async () => {
      /* A plain descriptive string resolves to nothing for any provider, as `Ragdoll` does in the
       * unmapped-patient tripwire; here the species IS mapped, so its default breed is what goes —
       * the fix for dmi-api#377 left this path alone, and this pins that it stays so. */
      const payload = payloadFor([KIDNEY_PANEL_CODE], {
        patient: patientFor({ name: 'Scout', species: avianSpeciesRefCode, breed: 'Red-tailed Hawk' }),
        requisitionId: `hrn-v6-unmapped-bird-${randomUUID().slice(0, 8)}`,
      })
      const requisitionId = payload.requisitionId as string

      const response = await org.api.post('/orders', payload, { autoSubmitOrder: true })
      expect({ status: response.status, refusal: response.ok ? '' : response.text.slice(0, 300) }).toEqual({
        status: 201,
        refusal: '',
      })

      const received = await mockOrder(requisitionId)
      expect({ speciesId: received.speciesId, breedId: received.breedId }).toEqual({
        speciesId: AVIAN_MAPPED_SPECIES_ID,
        breedId: AVIAN_DEFAULT_BREED_ID,
      })
    }, 60_000)

    it('the bird refs resolve, are not already Antech codes, and the hawk\'s breed is another species\' than Avian\'s', () => {
      /* As for the headline refs: if a dmi code were spelled like the Antech code it maps to, the
       * assertions above would hold with no mapping at all. */
      expect(avianSpeciesRefCode).toBeTruthy()
      expect(hawkBreedRefCode).toBeTruthy()
      for (const antechCode of [AVIAN_MAPPED_SPECIES_ID, HAWK_SPECIES_ID, HAWK_BREED_ID].map(String)) {
        expect(avianSpeciesRefCode).not.toBe(antechCode)
        expect(hawkBreedRefCode).not.toBe(antechCode)
      }

      /* And the pairing the hawk test is about, read from the provider's catalogue as the engine
       * returned it: 834 is a breed of 119, not of the 53 `Avian` is mapped to, and 796 is a breed
       * of 53. Were 834 filed under 53, the hawk order would be accepted with or without the fix. */
      expect(liveBreeds.find((item) => item.code === String(HAWK_BREED_ID))?.species).toBe(String(HAWK_SPECIES_ID))
      expect(liveBreeds.find((item) => item.code === String(AVIAN_DEFAULT_BREED_ID))?.species).toBe(
        String(AVIAN_MAPPED_SPECIES_ID),
      )
    })
  })

  describe('a CBC comes back in the sequence the integration enforces', () => {
    /* The integration carries a per-profile ordering table and applies it to any unit code result
     * whose OrderCode is `HHEM-1` — the analyser reports its channels in acquisition order, and the
     * report has to read in clinical order. Nothing else in this suite covers it, and the
     * transformation is invisible unless the seed is deliberately out of sequence. */
    let cbcOrderId = ''
    let cbcRequisitionId = ''

    it('a CBC panel seeded out of order is re-sequenced by the time it reaches the report', async () => {
      const payload = payloadFor([CBC_CODE])
      cbcRequisitionId = payload.requisitionId as string
      const created = expectOk<{ id: string, status: string }>(
        await org.api.post('/orders', payload, { autoSubmitOrder: true }),
        'place an auto-submitted CBC order',
      )
      cbcOrderId = created.id
      expect(created.status).toBe('SUBMITTED')

      /* Wait for the orders poll to acknowledge the order at `Submitted` before seeding. Seeding
       * moves the mock's provider status to `Final`, and a record the orders poll has not yet
       * acknowledged is still on the unacknowledged feed: the next tick would carry `Final`
       * through the orders channel, and the orders channel, not the results channel, would
       * complete this order — breaking the file header's claim (point 3) that only the results
       * channel moves an order a result was seeded for. The mock refuses an unacknowledged seed
       * for the same reason. */
      await waitForOrderAck(cbcRequisitionId)

      expectOk(
        await mock.post(`/__control__/orders/${encodeURIComponent(cbcRequisitionId)}/results`, {
          unitCodeResults: [{ orderCode: CBC_CODE, testCodeResults: CBC_SEEDED_ORDER }],
          pendingTestCount: 0,
          totalTestCount: 1,
        }),
        'seed a deliberately out-of-sequence CBC result',
      )

      const report = await pollUntil(
        async () => await org.api.get(`/orders/${cbcOrderId}/report`),
        (response) => response.body?.status === 'FINAL',
        COMPLETION_WAIT_MS,
        1_000,
      )
      expect(report.body.status).toBe('FINAL')

      const observations = await observationsFor(cbcOrderId)

      /* The substance: the ORDER, not the set. The seed and the expectation contain the same seven
       * analytes, so a test that compared sorted sets would pass with the sequencing removed
       * entirely. dmi-api stores the integration's per-item seq and orders a report's observations
       * by it, which is what makes the transformation observable from outside at all. */
      expect(observations.map((observation) => observation.name)).toEqual(CBC_EXPECTED_ORDER)
      expect(observations.map((observation) => observation.name)).not.toEqual(
        CBC_SEEDED_ORDER.map((item) => item.test),
      )

      /* And the values survived the re-ordering rather than being shuffled along with the names. */
      const wbc = observations.find((observation) => observation.code === 'WBC')
      expect(wbc?.valueQuantity?.value).toBe(11.2)
      expect(wbc?.valueQuantity?.units).toBe('K/uL')
      /* The histogram row is non-numeric and takes the mapper's valueString branch — no quantity. */
      const histogram = observations.find((observation) => observation.code === 'PLTHIST')
      expect(histogram?.valueString).toBe('see attached')
      expect(histogram?.valueQuantity ?? null).toBeNull()
    }, ORDER_ACK_WAIT_MS + COMPLETION_WAIT_MS + 60_000)
  })

  describe('the pre-order path: a reference-lab order is a draft until the clinic completes it', () => {
    it('POST /orders pre-orders: WAITING_FOR_INPUT, with a submissionUri carrying a token the mock issued', async () => {
      /* A reference-lab code, so the integration's POC rule sends this down the pre-order path even
       * though auto-submit is requested and enabled. That is the whole reason the catalogue's flags
       * are load-bearing: the same request with a POC code becomes a real order. */
      const payload = payloadFor([referenceLabCode])
      draftRequisitionId = payload.requisitionId as string

      const created = expectOk<{ id: string, externalId: string, requisitionId: string, status: string, submissionUri: string }>(
        await org.api.post('/orders', payload, { autoSubmitOrder: true }),
        'place a reference-lab antech-v6 order',
      )
      draftOrderId = created.id

      expect(created.status).toBe('WAITING_FOR_INPUT')
      expect(created.requisitionId).toBe(draftRequisitionId)
      expect(created.externalId).toBe(draftRequisitionId)

      /* The submissionUri is string-built by the integration from the provider configuration's
       * uiBaseUrl and the token the placement login returned. Pinning its exact shape matters
       * because it is the only thing a human is given to finish the draft with — and because it
       * carries a LIVE access token, which is worth being able to see change. */
      const expectedPrefix = `${env.antechV6.uiBaseUrl}/testGuide?ClinicAccessionID=${draftRequisitionId}&accessToken=`
      expect(created.submissionUri.startsWith(expectedPrefix)).toBe(true)

      const token = created.submissionUri.slice(expectedPrefix.length)
      expect(token).not.toBe('')
      /* Not merely "a non-empty string": the mock confirms it MINTED this token. That is what
       * distinguishes a token that came out of a real login from one invented anywhere in the
       * chain. */
      const tokenState = expectOk<{ issued: boolean, userId: number | null }>(
        await mock.get(`/__control__/tokens/${encodeURIComponent(token)}`),
        'check the submissionUri token against the mock',
      )
      expect(tokenState.issued).toBe(true)
      expect(tokenState.userId).toBeGreaterThan(0)

      /* The mock recorded it at the PRE-ORDER endpoint, with the same ref-mapped patient — the
       * draft path forwards exactly what the order path does. */
      const received = await mockOrder(draftRequisitionId)
      expect(received.kind).toBe('preorder')
      expect(received.speciesId).toBe(EXPECTED_SPECIES_ID)
      expect(received.breedId).toBe(EXPECTED_BREED_ID)
      expect(received.petSex).toBe(EXPECTED_PET_SEX)
      expect(received.orderCodes).toEqual([referenceLabCode])
    }, 60_000)

    it('the draft is invisible to the status feeds and has no TRF, and dmi keeps it WAITING_FOR_INPUT', async () => {
      /* A pre-order enters NEITHER status feed and its requisition form does not exist — the
       * provider's own behaviour, and the reason the engine has no observable signal for the
       * draft -> order transition. Probed directly, because there is no other way to see the
       * absence of something. */
      const login = expectOk<{ Token: string }>(
        await mock.post('/Users/v6/Login', {
          UserName: env.antechV6.username,
          Password: env.antechV6.password,
          ClinicID: env.antechV6.clinicId,
        }),
        'log in to the mock directly',
      )
      /* The harness's ApiClient speaks dmi-api's auth schemes, not Antech's `accessToken` header,
       * so these few provider-side probes go out over plain fetch. */
      const headers = { accessToken: login.Token }
      const views = await Promise.all(
        [
          ['labOrder', 'true'],
          ['labOrder', 'false'],
          ['labResult', 'true'],
          ['labResult', 'false'],
        ].map(async ([serviceType, overrideAck]) => {
          const response = await fetch(
            `${env.antechV6.mockBaseUrl}/LabResults/v6/GetStatus?serviceType=${serviceType}` +
              `&ClinicID=${encodeURIComponent(env.antechV6.clinicId)}&overrideAck=${overrideAck}` +
              `&ClinicAccessionID=${encodeURIComponent(draftRequisitionId)}`,
            { headers },
          )
          return { serviceType, overrideAck, body: (await response.json()) as { LabOrders: unknown[], LabResults: unknown[] } }
        }),
      )

      for (const view of views) {
        /* Both keys always present — the interceptor dereferences both unguarded — and both empty
         * for a draft. */
        expect({
          view: `${view.serviceType}/overrideAck=${view.overrideAck}`,
          orders: view.body.LabOrders.length,
          results: view.body.LabResults.length,
        }).toEqual({ view: `${view.serviceType}/overrideAck=${view.overrideAck}`, orders: 0, results: 0 })
      }

      const trf = await fetch(
        `${env.antechV6.mockBaseUrl}/HTPDF/trf/pims/${encodeURIComponent(draftRequisitionId)}`,
        { headers },
      )
      /* 500, not 404 — the provider's own answer for an accession that has no document. */
      expect(trf.status).toBe(500)
      expect(await trf.json()).toEqual({ StatusCode: 500, ErrorMessage: 'Internal server error' })

      const order = await org.api.get(`/orders/${draftOrderId}`)
      expect(order.body.status).toBe('WAITING_FOR_INPUT')
    }, 60_000)

    it('completing the draft at the provider moves the dmi order to SUBMITTED, and its TRF is fetched', async () => {
      /* The clinic finishes the draft in Antech's own UI. There is no provider endpoint for that —
       * the engine's only polling surface cannot see a draft at all — so the mock's control plane
       * models the completion: the record becomes an order in the feed, as `Submitted`, with a lab
       * accession and a requisition form.
       *
       * Outside the describe that replays orders to the orders channel, this is the one assertion in
       * this file that channel satisfies, and it is worth being precise about why it needs no
       * replay: promotion puts a record the poll has never acknowledged into the feed, at
       * `Submitted`. dmi-api accepts an incoming SUBMITTED only from WAITING_FOR_INPUT or ACCEPTED,
       * and this order is WAITING_FOR_INPUT. The results channel is not involved — nothing is seeded
       * for this order until the next test — so a change here can only have come from
       * `external_orders`. */
      expectOk(
        await mock.post(`/__control__/orders/${encodeURIComponent(draftRequisitionId)}/promote`, {}),
        'promote the draft to a placed order at the mock',
      )

      const order = await pollUntil(
        async () => await org.api.get(`/orders/${draftOrderId}`),
        (response) => response.body?.status === 'SUBMITTED',
        ORDER_ACK_WAIT_MS,
        1_000,
      )
      expect(order.body.status).toBe('SUBMITTED')

      /* And the other half of the POC rule, which the headline order proved in its negative form:
       * this order's only code is a reference-lab one, so the integration MUST have fetched its
       * requisition form. (The mock serves a real `%PDF-1.7` body; the integration base64s it onto
       * the order as a manifest, which dmi-api stores but does not serialise on GET /orders/:id —
       * so the fetch at the provider is the observable half.)
       *
       * Waited for as the acknowledgement at `Submitted`, not as the fetch: the integration fetches
       * the TRF inside the same poll cycle, before it emits the order and acknowledges it, so once
       * the ack has landed the fetch has happened. The ack is also what the next test needs before
       * it seeds a result (the file header, point 3). The wait asserts the ack at `Submitted`. */
      const received = await waitForOrderAck(draftRequisitionId)
      expect(received.kind).toBe('order')
      expect(received.trfFetches).toBeGreaterThanOrEqual(1)
    }, ORDER_ACK_WAIT_MS * 2 + 30_000)

    it('seeding a result completes the promoted order too', async () => {
      expectOk(
        await mock.post(`/__control__/orders/${encodeURIComponent(draftRequisitionId)}/results`, {
          unitCodeResults: [
            {
              orderCode: referenceLabCode,
              testCodeResults: [
                { test: 'SDMA', testCodeExtID: 'SDMA', result: '18', unit: 'ug/dl', range: '<14', abnormalFlag: 'H' },
                { test: 'ALB', testCodeExtID: 'ALB', result: '3.1', unit: 'g/dl', range: '2.3-4.0' },
              ],
            },
          ],
          pendingTestCount: 0,
          totalTestCount: 1,
        }),
        'seed a result for the promoted order',
      )

      const report = await pollUntil(
        async () => await org.api.get(`/orders/${draftOrderId}/report`),
        (response) => response.body?.status === 'FINAL',
        COMPLETION_WAIT_MS,
        1_000,
      )
      expect(report.body.status).toBe('FINAL')

      const order = await org.api.get(`/orders/${draftOrderId}`)
      expect(order.body.status).toBe('COMPLETED')

      /* SDMA carries a SINGLE-BOUND range in the `<n` form, which is a different branch of the
       * integration's range parser from the `low-high` form every other analyte here uses: it must
       * produce a `high` and NO `low`. An absent bound may serialise as null or as a missing key,
       * so normalise before asserting. */
      const observations = await observationsFor(draftOrderId)
      const sdma = observations.find((observation) => observation.code === 'SDMA')
      expect(sdma?.valueQuantity?.value).toBe(18)
      expect(sdma?.referenceRange).toEqual([expect.objectContaining({ high: 14, text: '<14' })])
      expect(sdma?.referenceRange?.[0]?.low ?? null).toBeNull()
      expect(sdma?.interpretation).toMatchObject({ code: 'H' })
    }, COMPLETION_WAIT_MS + 30_000)
  })

  describe('a partial result is amended in place', () => {
    /* The clinical norm for a multi-panel order: one panel reports, the other is still running, and
     * the second delivery completes it. dmi-api merges the second delivery into the existing report
     * rather than accumulating a copy, and this is what proves it. Nothing above covers either the
     * PARTIAL branch of the integration's result-status rule or dmi-api's in-place merge. */
    let partialOrderId = ''
    let partialRequisitionId = ''

    const firstDelivery = [
      { test: 'BUN', testCodeExtID: 'BUN', result: '24.3', unit: 'mg/dl', range: '9.0-29.0' },
      { test: 'CREA', testCodeExtID: 'CREA', result: '1.1', unit: 'mg/dl', range: '0.5-1.8' },
    ]
    const AMENDED_BUN = '31.0'

    it('a result with tests still pending reports PARTIAL, and the observations it does carry are readable', async () => {
      const payload = payloadFor([KIDNEY_PANEL_CODE, HEARTWORM_CODE])
      partialRequisitionId = payload.requisitionId as string
      const created = expectOk<{ id: string, status: string }>(
        await org.api.post('/orders', payload, { autoSubmitOrder: true }),
        'place an order that will report partially first',
      )
      partialOrderId = created.id
      expect(created.status).toBe('SUBMITTED')

      /* Let the orders poll acknowledge the order at `Submitted` before anything is seeded. Seeding
       * moves the mock's provider status to `Partial`, and a record the orders poll has not yet
       * acknowledged is still on the unacknowledged feed — so a result seeded first would let the
       * orders channel carry `Partial` to dmi-api and move the order itself, and the order
       * assertion below would no longer say which channel moved it. */
      await waitForOrderAck(partialRequisitionId)

      /* One of two tests reported. `extractResultStatus` reads ONLY the pending/total counts and
       * `Corrected` — the per-unit ResultStatus is not consulted — so this trio is the whole of the
       * decision: 1 of 2 pending is PARTIAL. */
      expectOk(
        await mock.post(`/__control__/orders/${encodeURIComponent(partialRequisitionId)}/results`, {
          unitCodeResults: [{ orderCode: KIDNEY_PANEL_CODE, resultStatus: 'P', testCodeResults: firstDelivery }],
          pendingTestCount: 1,
          totalTestCount: 2,
        }),
        'seed a partial result',
      )

      const report = await pollUntil(
        async () => await org.api.get(`/orders/${partialOrderId}/report`),
        (response) => response.body?.status === 'PARTIAL',
        COMPLETION_WAIT_MS,
        1_000,
      )
      expect(report.body.status).toBe('PARTIAL')

      /* A partial result moves the ORDER too — `setOrderStatusFromResult` acts on a PARTIAL result
       * status, and dmi-api accepts PARTIAL from SUBMITTED. This is the results channel's: the order
       * was acknowledged at `Submitted` before the result was seeded, and the mock does not re-offer
       * an acknowledged order when its status changes, so the orders channel never saw `Partial`. */
      const order = await org.api.get(`/orders/${partialOrderId}`)
      expect(order.body.status).toBe('PARTIAL')

      const observations = await observationsFor(partialOrderId)
      expect(observations.map((observation) => observation.code)).toEqual(['BUN', 'CREA'])
      expect(observations.find((observation) => observation.code === 'BUN')?.valueQuantity?.value).toBe(24.3)
    }, ORDER_ACK_WAIT_MS + COMPLETION_WAIT_MS + 60_000)

    it('the completing delivery amends in place: FINAL, one copy of each observation, nothing lost', async () => {
      expectOk(
        await mock.post(`/__control__/orders/${encodeURIComponent(partialRequisitionId)}/results`, {
          unitCodeResults: [
            {
              orderCode: KIDNEY_PANEL_CODE,
              testCodeResults: [{ ...firstDelivery[0], result: AMENDED_BUN }, firstDelivery[1]],
            },
            {
              orderCode: HEARTWORM_CODE,
              testCodeResults: [
                { test: 'Heartworm Antigen', testCodeExtID: 'HWAG', result: 'Negative' },
              ],
            },
          ],
          pendingTestCount: 0,
          totalTestCount: 2,
        }),
        'amend the partial result to a complete one',
      )

      const report = await pollUntil(
        async () => await org.api.get(`/orders/${partialOrderId}/report`),
        (response) => response.body?.status === 'FINAL',
        COMPLETION_WAIT_MS,
        1_000,
      )
      expect(report.body.status).toBe('FINAL')

      const panels = (report.body.testResultsSet ?? []) as TestResultSet[]
      expect(panels.map((panel) => panel.code).sort()).toEqual([KIDNEY_PANEL_CODE, HEARTWORM_CODE].sort())

      /* The substance. dmi-api merges a re-delivered result into the existing report by observation
       * CODE, updating matches in place, so an amendment must overwrite rather than accumulate.
       * Asserting one BUN AND its new value AND that the untouched analyte kept its first value is
       * what would catch a merge that started appending — which would otherwise look like a
       * perfectly healthy report with a stale duplicate hiding in it. */
      const observations = await observationsFor(partialOrderId)
      expect(observations.filter((observation) => observation.code === 'BUN')).toHaveLength(1)
      expect(observations.find((observation) => observation.code === 'BUN')?.valueQuantity?.value).toBe(
        Number(AMENDED_BUN),
      )
      expect(observations.find((observation) => observation.code === 'CREA')?.valueQuantity?.value).toBe(1.1)
      /* The second panel's qualitative result: non-numeric, so the valueString branch, and no
       * range. */
      expect(observations.find((observation) => observation.code === 'HWAG')?.valueString).toBe('Negative')
      expect(observations).toHaveLength(3)

      /* Still the results channel's, for the reason the test above gives: neither delivery puts the
       * acknowledged order back on the orders feed. */
      const order = await org.api.get(`/orders/${partialOrderId}`)
      expect(order.body.status).toBe('COMPLETED')
    }, COMPLETION_WAIT_MS + 30_000)
  })

  describe('refusals surface end to end', () => {
    /* The tests at the end of this block arm a one-shot answer on a placement endpoint, and the
     * mock clears it only when that endpoint is hit. A test that fails before its order gets there
     * (dmi-api refuses the payload, the request times out, the order routes to the other endpoint)
     * would leave the answer armed for the next order placed there (the cancel test's, say), and
     * the red would land in the wrong test. So after each test, whatever is still armed at the
     * mock is cleared and then named as a failure. Jest reports a failing `afterEach` on the test it
     * followed, which is the one that armed the answer and never used it; clearing first means the
     * tests after it start clean whatever happens here. */
    afterEach(expectNothingLeftArmed)

    /* Arms `answer` once on `key` (`placeOrder` is `/LabOrders/v6/Order`, `placePreOrder` is
     * `/LabOrders/v6/PreOrderPlacement`): a status and body spelled out here, or one of the mock's
     * own envelopes by name. Then posts an order for `codes` with auto-submit asked for — a
     * separate order, with its own requisitionId, that never reaches the loop above — and returns
     * dmi-api's answer for the test to assert on. */
    async function placeAgainst (
      key: 'placeOrder' | 'placePreOrder',
      answer: { status: number, body: unknown } | { envelope: 'trfUnavailable' | 'unknownPath' },
      codes: string[],
      what: string,
    ): Promise<ApiResponse> {
      expectOk(
        await mock.post('/__control__/scenarios', { key, ...answer, once: true }),
        `arm a one-shot ${what} on the next ${key === 'placeOrder' ? 'order' : 'pre-order'} placement`,
      )
      const response = await org.api.post('/orders', payloadFor(codes), { autoSubmitOrder: true })
      console.log(
        `[antech-v6-scenario] ${key} ${what} response -> HTTP ${response.status}: ${response.text.slice(0, 300)}`,
      )
      return response
    }

    it('an unknown test code fails POST /orders, carrying the provider\'s OWN message', async () => {
      /* Exercises the integration's error path, which the happy path never touches, through the
       * one placement refusal observed live. The mock rejects a code outside its catalogue with
       * that placement-rejection envelope: `{value: {..., Message: "..."}, statusCode,
       * contentType}`. `AntechV6ApiException` reads `.value.Message`, so the provider's explanation
       * survives; dmi-api re-throws the engine error out of createOrder, and POST /orders answers
       * non-2xx with it in `errors`.
       *
       * Pinning the exact message rather than merely "it failed" is what distinguishes the
       * provider's wording from the generic `Failed to POST <url>` line that leads every error
       * list — which, until nominal-systems/dmi-engine-antech-v6-integration#86, was all an
       * operator was told for three more of Antech's envelopes. The tests at the end of this block
       * pin two of those at placement and a placement refusal of the third's family, and what an
       * envelope nobody has seen yet surfaces as, cut to length. A separate order, with its own
       * requisitionId, that never reaches the loop above. */
      const payload = payloadFor(['NOT-A-REAL-ANTECH-CODE'])

      const response = await org.api.post('/orders', payload, { autoSubmitOrder: true })
      console.log(
        `[antech-v6-scenario] unknown-code response -> HTTP ${response.status}: ${response.text.slice(0, 300)}`,
      )

      expect(response.ok).toBe(false)
      /* The whole list: the generic line first, naming the endpoint, then the provider's message,
       * and nothing else, so this also pins that the provider message is added to the generic
       * line, not put in its place. The integration read this envelope before
       * nominal-systems/dmi-engine-antech-v6-integration#86 too, so the list is the same on its
       * main: this test pins the list, it does not prove that fix. */
      expect(response.body?.errors).toEqual([
        failedPost('/LabOrders/v6/PreOrderPlacement'),
        'Invalid OrderCode NOT-A-REAL-ANTECH-CODE',
      ])
    }, 30_000)

    it('an integration pointed at a clinic the account does not own surfaces `Invalid User or Password`', async () => {
      /* The mock accepts any username/password VALUES — they are dummy by design — but refuses a
       * clinic it was not provisioned for, with the bare-text 401 body the live endpoint returns
       * when credentials do not open a session. The interesting part is the surface: that body is a
       * STRING, not JSON, and `AntechV6ApiException`'s bare-string branch is the only thing that
       * carries it through. A mock that answered credential failures in JSON would leave that
       * branch unexercised.
       *
       * A second practice + integration on the SAME provider configuration, deliberately never
       * started, so it schedules no polling and cannot perturb anything above. */
      const practice = expectOk<{ id: string }>(
        await org.api.post('/practices', { name: `practice-foreign-clinic-${randomUUID().slice(0, 8)}` }),
        'create a practice for the foreign-clinic integration',
      )
      const integration = expectOk<{ id: string }>(
        await org.api.post('/integrations', {
          practiceId: practice.id,
          providerConfigurationId: org.providerConfigurationId,
          integrationOptions: {
            username: env.antechV6.username,
            password: env.antechV6.password,
            clinicId: FOREIGN_CLINIC_ID,
            labId: env.antechV6.labId,
            autoSubmitEnabled: true,
          },
        }),
        'create an integration for a clinic the account does not own',
      )

      const payload = orderPayload(integration.id, {
        patient: patientFor(),
        testCodes: [{ code: KIDNEY_PANEL_CODE }],
      })
      const response = await org.api.post('/orders', payload, { autoSubmitOrder: true })
      console.log(
        `[antech-v6-scenario] foreign-clinic response -> HTTP ${response.status}: ${response.text.slice(0, 300)}`,
      )

      expect(response.ok).toBe(false)
      expect(response.text).toContain('Invalid User or Password')
    }, 30_000)

    it('the mock refuses, in the provider\'s own dialects, every call the loop never makes', async () => {
      /* Direct probes. Each of these is a shape the integration can produce but this loop does not,
       * and each is a DIFFERENT envelope — the variety is itself the contract. Since
       * nominal-systems/dmi-engine-antech-v6-integration#86 the integration's error mapper reads
       * Antech's explanation out of every envelope pinned here, but it does so by knowing each
       * one's keys, so a mock that drifted onto one house style would stop testing all but one of
       * them. Pinning them here keeps the mock from drifting. */
      const base = env.antechV6.mockBaseUrl

      /* 1. A missing accessToken header: RFC 9110 401, keyed `message` (lowercase), beside an
       *    empty `errorDetails` map. The error mapper reads the lowercase key since that fix;
       *    before it, this envelope reached an operator as the generic line alone. A 401 cannot be
       *    armed at placement, so a test below pins a 400 of the same family there instead. */
      const noToken = await fetch(
        `${base}/LabResults/v6/GetStatus?serviceType=labOrder&ClinicID=${env.antechV6.clinicId}&overrideAck=false`,
      )
      expect(noToken.status).toBe(401)
      expect(await noToken.json()).toMatchObject({
        type: 'https://www.rfc-editor.org/rfc/rfc9110.html#status.401',
        message: 'Access token is missing.',
        status: 401,
        isSuccess: false,
      })

      const login = expectOk<{ Token: string, UserInfo: { ID: number } }>(
        await mock.post('/Users/v6/Login', {
          UserName: env.antechV6.username,
          Password: env.antechV6.password,
          ClinicID: env.antechV6.clinicId,
        }),
        'log in to the mock directly',
      )
      const headers = { accessToken: login.Token }

      /* 2. The test guide reached with HEADER auth: 404, not 401 — the token's placement really is
       *    endpoint-specific, and only one way round. This is why the integration's getTestGuide is
       *    written differently from every other call it makes. */
      const headerAuthGuide = await fetch(`${base}/Tests/v6?pageSize=2500`, { headers })
      expect(headerAuthGuide.status).toBe(404)
      expect(await headerAuthGuide.json()).toEqual({ statusCode: 404, message: 'Resource not found' })

      /* ...and with query auth it works, so the 404 above is about the placement and not about the
       *    path. The lowercase `accesstoken` is load-bearing. */
      const queryAuthGuide = await fetch(
        `${base}/Tests/v6?accesstoken=${login.Token}&userId=${login.UserInfo.ID}&pageSize=2500&POC_FLAG=Y`,
      )
      expect(queryAuthGuide.status).toBe(200)
      const guide = (await queryAuthGuide.json()) as { TotalCount: number, LabResults: Array<{ Code: string, POC_Flag: string }> }
      expect(guide.LabResults.map((row) => row.Code).sort()).toEqual([...pocCodes].sort())
      expect(guide.LabResults.every((row) => row.POC_Flag === 'Y')).toBe(true)
      expect(guide.TotalCount).toBe(pocCodes.length)

      /* 3. A malformed serviceType: RFC 9110 validation problem+json, keyed by the offending field.
       *    The error mapper reads `title` and `errors`, as it did before that fix too, so this one
       *    reaches an operator. */
      const badServiceType = await fetch(
        `${base}/LabResults/v6/GetStatus?serviceType=notAThing&ClinicID=${env.antechV6.clinicId}`,
        { headers },
      )
      expect(badServiceType.status).toBe(400)
      expect(await badServiceType.json()).toMatchObject({
        title: 'One or more validation errors occurred.',
        status: 400,
        errors: { ServiceType: ['The Service Type is invalid. Please update and try again.'] },
      })

      /* 4. An invalid POC_FLAG: 400 with a BARE JSON STRING body, not an object. */
      const badPocFlag = await fetch(
        `${base}/Tests/v6?accesstoken=${login.Token}&userId=${login.UserInfo.ID}&POC_FLAG=Z`,
      )
      expect(badPocFlag.status).toBe(400)
      expect(await badPocFlag.json()).toBe('POC_Flag:Z is not valid')

      /* 5. The integration's own unmapped-patient fallback pair, refused verbatim as the live
       *    endpoint refuses it. This is the envelope the tripwire at the bottom of this file is
       *    about, probed here in isolation so its shape is pinned independently of the dmi-api
       *    round trip. */
      const badPair = await fetch(`${base}/LabOrders/v6/PreOrderPlacement`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          ClinicID: env.antechV6.clinicId,
          ClinicAccessionID: `probe-${randomUUID().slice(0, 8)}`,
          ClientLastName: 'Doe',
          PetName: 'Rex',
          PetSex: 'U',
          PetAge: 1,
          PetAgeUnits: 'Y',
          SpeciesID: DEFAULT_PET_SPECIES,
          BreedID: DEFAULT_PET_BREED,
          OrderCodes: [KIDNEY_PANEL_CODE],
        }),
      })
      expect(badPair.status).toBe(400)
      expect(await badPair.json()).toEqual({
        value: {
          Data: null,
          StatusCode: 0,
          HttpStatusCode: 400,
          Message: `Invalid BreedId ${DEFAULT_PET_BREED}`,
          InnerExceptionMessage: '',
          Error: null,
          ClientData: null,
        },
        statusCode: 400,
        contentType: 'application/json',
      })

      /* 6. An unknown path: `{statusCode, message}` — a third distinct 4xx shape. The error mapper
       *    reads its lowercase `message` since that fix; a test below pins it end to end, as a
       *    refusal at the pre-order endpoint. */
      const unknownPath = await fetch(`${base}/LabResults/v6/NoSuchThing`, { headers })
      expect(unknownPath.status).toBe(404)
      expect(await unknownPath.json()).toEqual({ statusCode: 404, message: 'Resource not found' })
    }, 60_000)

    it('a 500 `{StatusCode, ErrorMessage}` on the order endpoint reaches the operator with the provider\'s wording', async () => {
      /* The TRF endpoint's 500 envelope, captured there for an unknown accession (the draft test
       * above probes it). Production has shown failed order sends reaching the caller with
       * nothing from Antech, so an envelope the integration could not read does reach placement,
       * though the logs do not say which one. Neither of this envelope's keys was one the
       * integration's error mapper read, so an operator was told only `Failed to POST <url>`.
       * Since nominal-systems/dmi-engine-antech-v6-integration#86 the mapper reads
       * `ErrorMessage`, in any case, and Antech's `Internal server error` follows the generic
       * line.
       *
       * Armed once, by name (`envelope: 'trfUnavailable'`), so the mock answers with the builder
       * that answers at the TRF endpoint, not a copy of its body: a new capture changes both at
       * once, and the wording expected below then goes red until it follows. On the real ORDER
       * endpoint: the order's code is point-of-care and auto-submit is asked for, so the
       * integration places it at `/LabOrders/v6/Order`, as the unmapped-patient refusal at the
       * bottom of this file does. The mock answers that one call before it reads the order, so
       * nothing is recorded at the provider. The WHOLE error list is pinned: the generic line
       * first, naming the URL that failed, which shows the 500 came from placement; then Antech's
       * wording; and nothing else. That is what shows the provider's text is added to the generic
       * line rather than put in its place.
       *
       * The wording expected is the captured one, which the mock also answers when one of its own
       * handlers throws; that cannot pass for the armed answer, because the order handler takes
       * the scenario right after its token check, so a crash before it leaves the scenario armed
       * and the `afterEach` above names it. */
      const response = await placeAgainst(
        'placeOrder',
        { envelope: 'trfUnavailable' },
        [KIDNEY_PANEL_CODE],
        '500 {StatusCode, ErrorMessage}',
      )

      expect(response.ok).toBe(false)
      expect(response.body?.errors).toEqual([failedPost('/LabOrders/v6/Order'), 'Internal server error'])
    }, 30_000)

    it('a 404 `{statusCode, message}` on the pre-order endpoint reaches the operator with the provider\'s wording', async () => {
      /* The unknown-path envelope (probe 6 above): Antech's answer for a path it does not have,
       * and so the answer a placement would get from a moved or misspelled endpoint. Its lowercase
       * `message` was not a key the integration's error mapper read, so an operator was told only
       * `Failed to POST <url>`. Since nominal-systems/dmi-engine-antech-v6-integration#86 it is,
       * and `Resource not found` follows the generic line. Armed once, by name
       * (`envelope: 'unknownPath'`), so the mock answers with the builder its router answers probe
       * 6 with, not a copy of its body: a new capture changes both at once.
       *
       * The pre-order endpoint this time, so both placement paths are covered: a reference-lab
       * code is not point-of-care, so the integration takes the draft path even with auto-submit
       * asked for, as the pre-order test above does. A real catalogue code, unlike the unknown-code
       * refusal's, so the mock would have accepted this order and the 404 can only be the armed
       * answer. The whole error list is pinned, as in the test above; its generic line names
       * `/LabOrders/v6/PreOrderPlacement`, which shows where the 404 came from. A separate order,
       * with its own requisitionId, that never reaches the loop above. */
      const response = await placeAgainst(
        'placePreOrder',
        { envelope: 'unknownPath' },
        [referenceLabCode],
        '404 {statusCode, message}',
      )

      expect(response.ok).toBe(false)
      expect(response.body?.errors).toEqual([failedPost('/LabOrders/v6/PreOrderPlacement'), 'Resource not found'])
    }, 30_000)

    it('a 400 `{message, detail, errorDetails}` on the order endpoint reaches the operator with the message, and the repeated detail once', async () => {
      /* The RFC 9110 family Antech's missing-token 401 belongs to (probe 1 above): a lowercase
       * `message` beside an `errorDetails` field map. This is the shape the integration's own unit
       * tests carry for a point-of-care validation refusal at placement, taken verbatim but for a
       * synthetic requestId; this harness has not captured it. It stands in for the 401, which
       * cannot be armed at placement: the integration answers any 401 by logging in again and
       * retrying the call once, so a one-shot 401 is used up by the first attempt and the retry
       * succeeds, and a standing one cannot be disarmed between tests without resetting the mock.
       *
       * Until nominal-systems/dmi-engine-antech-v6-integration#86 the error mapper read only
       * `detail` here, so the operator never saw the `Validation Failed` headline. It now reads
       * `message` in any case, and the `errorDetails` map as well. The map's one entry renders
       * exactly as `detail` does, and a message repeated under two keys is listed once, so the
       * whole list is three entries: the de-duplication is pinned too. Placed as in the 500 test
       * above, at the ORDER endpoint. A separate order, with its own requisitionId, that never
       * reaches the loop above. */
      const pocRefusal = 'POCValidation: POC validation errors: Only IHD order codes are supported.'
      const response = await placeAgainst(
        'placeOrder',
        {
          status: 400,
          body: {
            type: 'https://www.rfc-editor.org/rfc/rfc9110.html#status.400',
            message: 'Validation Failed',
            status: 400,
            detail: pocRefusal,
            errorDetails: { POCValidation: ['POC validation errors: Only IHD order codes are supported.'] },
            isSuccess: false,
            requestId: '00000000-0000-4000-8000-000000000001',
          },
        },
        [KIDNEY_PANEL_CODE],
        '400 {message, detail, errorDetails}',
      )

      expect(response.ok).toBe(false)
      expect(response.body?.errors).toEqual([failedPost('/LabOrders/v6/Order'), 'Validation Failed', pocRefusal])
    }, 30_000)

    it('an error envelope nobody has captured yet reaches the operator as its raw body', async () => {
      /* INVENTED on purpose: no such envelope has been seen, and its keys are ones the error
       * mapper does not look for. Antech has already been seen answering in seven shapes (the
       * mock's error-envelope builders), so an eighth would be no surprise, and until
       * nominal-systems/dmi-engine-antech-v6-integration#86 the integration dropped a body it did
       * not recognise, leaving the operator `Failed to POST <url>` alone. Since that fix a
       * non-empty body with nothing recognisable is passed on raw (`JSON.stringify`, cut at 500
       * characters) after the generic line, so whatever Antech said still reaches someone who can
       * act on it.
       *
       * Placed as in the 500 test above, at the ORDER endpoint, and the whole error list is pinned
       * the same way. The raw entry within it is pinned whole, so a fallback that altered the
       * body on the way would be a red too. A separate order, with its own requisitionId, that
       * never reaches the loop above. */
      const unseenEnvelope = { Unexpected: 'envelope', Code: 'X-1' }
      const response = await placeAgainst(
        'placeOrder',
        { status: 500, body: unseenEnvelope },
        [KIDNEY_PANEL_CODE],
        '500 with an unseen envelope',
      )

      expect(response.ok).toBe(false)
      expect(response.body?.errors).toEqual([failedPost('/LabOrders/v6/Order'), JSON.stringify(unseenEnvelope)])
    }, 30_000)

    it('an unseen envelope\'s raw body is cut at 500 code points on its way to the operator', async () => {
      /* The bound on the raw-body fallback above. `errors` goes back to the PIMS and is shown to
       * its user, so since nominal-systems/dmi-engine-antech-v6-integration#86 each entry the
       * integration takes from Antech's body is cut at 500 characters, counted in code points,
       * with `…` appended. An unseen envelope whose one value is 2,000 emoji must therefore arrive
       * as the generic line and ONE more entry of exactly 501 code points: the start of the raw
       * body, then the ellipsis. Before that fix the body was dropped, and the list was the
       * generic line alone.
       *
       * Emoji, not ASCII, because each is outside the BMP: 2,000 of them are 4,000 UTF-16 units,
       * so a cut counted in code points and one counted in units give different entries. Counted in
       * code points, the entry is 501. Counted in units, it would be the 15-character
       * `{"Unexpected":"`, 242 whole emoji and half of the next, then the ellipsis: 259 code points
       * and a split pair. An all-ASCII body comes out at 501 either way, and could not tell them
       * apart. Placed as in the 500 test above, at the ORDER endpoint. */
      const rawStart = '{"Unexpected":"'
      const response = await placeAgainst(
        'placeOrder',
        { status: 500, body: { Unexpected: '🧪'.repeat(2000) } },
        [KIDNEY_PANEL_CODE],
        '500 with a 2,000-emoji unseen envelope',
      )

      expect(response.ok).toBe(false)
      /* One object, so a red shows every property of the list at once rather than the first
       * that broke. */
      const errors = (response.body?.errors ?? []) as string[]
      const raw = errors[1] ?? ''
      expect({
        entries: errors.length,
        generic: errors[0],
        codePoints: Array.from(raw).length,
        start: raw.slice(0, rawStart.length),
        end: raw.slice(-1),
      }).toEqual({
        entries: 2,
        generic: failedPost('/LabOrders/v6/Order'),
        codePoints: 501,
        start: rawStart,
        end: '…',
      })
    }, 30_000)
  })

  describe('cancel: the integration has no cancel path, and dmi-api leaves the order as it was', () => {
    it('DELETE /orders/:id is refused with the integration\'s own message, and the order stays SUBMITTED', async () => {
      /* The integration's `cancelOrder` throws a 501 ("does not support cancelling orders") before
       * any HTTP call — there is no cancel endpoint in its dialect, so the mock has nothing to
       * refuse and this pin is about dmi-api's side of the RPC: `cancelOrder` only marks the local
       * order CANCELLED after the engine RPC RESOLVES, so a rejected RPC must leave the order
       * exactly as it was, at the provider and in dmi. Whether Antech's API has a cancel surface
       * the integration could use is unverified — though both placement endpoints DO return the
       * provider's own numeric order id, which the integration discards, and that is the identifier
       * such a surface would most likely want — so there is no tripwire here yet, only the pin that
       * the refusal is loud and lossless. */
      const payload = payloadFor([KIDNEY_PANEL_CODE])
      const requisitionId = payload.requisitionId as string
      const created = expectOk<{ id: string, status: string }>(
        await org.api.post('/orders', payload, { autoSubmitOrder: true }),
        'place an order to attempt cancelling',
      )
      expect(created.status).toBe('SUBMITTED')

      const response = await org.api.delete(`/orders/${created.id}`)
      console.log(
        `[antech-v6-scenario] cancel response -> HTTP ${response.status}: ${response.text.slice(0, 300)}`,
      )
      expect(response.ok).toBe(false)
      expect(response.text).toContain('does not support cancelling orders')

      const order = await org.api.get(`/orders/${created.id}`)
      expect(order.body.status).toBe('SUBMITTED')
      const received = await mockOrder(requisitionId)
      expect(received.orderStatus).toBe('Submitted')
    }, 60_000)
  })

  describe('the orders channel carries the provider\'s own status', () => {
    /* The integration polls Antech's order-status feed and reports each order's `OrderStatus` to
     * dmi-api over `external_orders`, and dmi-api applies it through `isValidStatusChange`. Each
     * test here drives one provider status through that path ALONE, on an order of its own:
     *
     *   - the order is placed on the auto-submit path and the orders poll acknowledges it once, at
     *     `Submitted`, which dmi-api, already holding SUBMITTED, takes as no change. So the status
     *     set next is a SECOND observation, never the first;
     *   - the status is advanced with `replay: true`, the control plane's way of offering the record
     *     again. The provider was observed NOT to re-offer an acknowledged order when its status
     *     changes, and the mock does not either, so the replay is a harness action: it gets the new
     *     status to the integration's mapping, and claims nothing about when production sees one;
     *   - the mock re-acknowledging the order AT THE NEW STATUS is the proof the poll saw it. The
     *     integration emits to dmi-api and then acknowledges, so after that point an unchanged dmi
     *     status means dmi-api refused or never got it — not that the poll had not run yet;
     *   - NO result is ever seeded for these orders, and each test asserts at the mock that none
     *     exists, and at dmi-api that the report is still the empty REGISTERED one order creation
     *     made. The results channel is the only other route to PARTIAL or COMPLETED, so whatever the
     *     order's status becomes is the orders channel's doing.
     *
     * The mapping under test (the file header, point 3, says why `Received` is not PARTIAL): `Draft`
     * to ACCEPTED; `Submitted`, `Received` and `In Progress` to SUBMITTED; `Partial` to PARTIAL;
     * `Resulted` and `Final` to COMPLETED; `Expired` and `Canceled` to CANCELLED; anything else to
     * SUBMITTED, with a warning; case and surrounding whitespace ignored. Driven here: `Final`,
     * `Canceled`, `Expired` and `Partial`, which move the order, and `Received` and `In Progress`,
     * which leave it SUBMITTED. `Resulted` shares its branch with `Final`. `Draft` is not driven:
     * its ACCEPTED could be told apart from the unmapped default on a WAITING_FOR_INPUT order, where
     * dmi-api would apply SUBMITTED and refuses ACCEPTED, but the live feed was observed to show no
     * draft in any status view (the mock's header, load-bearing detail 6), so driving one would be
     * a harness construct. It is left to the integration's unit tests.
     *
     * Until nominal-systems/dmi-engine-antech-v6-integration#84 was fixed, the integration's status
     * enum was numeric while the provider sends strings, so `mapOrderStatus` matched no wire value
     * and every polled status reached dmi-api as SUBMITTED; the `Final` test below was an
     * `it.failing` tripwire for it. Against that code `Final` and the three rows that move the
     * order go red naming SUBMITTED, and the guard after `Final` goes red on its precondition,
     * because `Final` left it no completed order. The `Received` and `In Progress` rows stay green
     * there by design: SUBMITTED is what they expect. */
    let finalOrderId = ''
    let finalRequisitionId = ''

    /* The dmi order's status once dmi-api has handled the re-offered record: polled until it reads a
     * status other than SUBMITTED, so a red waits out the budget and then names the status it got.
     * Only a status ends the poll early: a transient error or an empty body inside the window does
     * not, or the red would read `undefined` instead of the status dmi-api holds. */
    async function dmiStatusAfterThePoll (orderId: string): Promise<string> {
      const order = await pollUntil(
        async () => await org.api.get(`/orders/${orderId}`),
        (response) => typeof response.body?.status === 'string' && response.body.status !== 'SUBMITTED',
        STATUS_APPLIED_WAIT_MS,
        1_000,
      )
      return order.body?.status ?? `HTTP ${order.status}`
    }

    it('the orders channel completes an order whose provider status has reached Final', async () => {
      /* A polled `Final` reaches dmi COMPLETED through the orders channel alone: no result is ever
       * seeded for this order, and the test checks that at both ends, so the results channel — the
       * only other route to COMPLETED — cannot have done it. Was an `it.failing` tripwire until
       * nominal-systems/dmi-engine-antech-v6-integration#84 was fixed: the integration's status
       * enum was numeric and the provider sends the string `"Final"`, so the poll reported
       * SUBMITTED, dmi-api correctly refused SUBMITTED -> SUBMITTED as no change, and the order
       * stayed SUBMITTED. The order stays on for the next test. */
      const { orderId, requisitionId } = await placeAcknowledgedOrder('status Final')
      finalOrderId = orderId
      finalRequisitionId = requisitionId

      await advanceProviderStatus(requisitionId, 'Final')

      expect(await dmiStatusAfterThePoll(orderId)).toBe('COMPLETED')
      await expectNothingFromTheResultsChannel(orderId, requisitionId)
    }, ORDER_ACK_WAIT_MS * 2 + STATUS_APPLIED_WAIT_MS + 30_000)

    it('a COMPLETED order stays COMPLETED when its provider status moves back to Partial', async () => {
      /* `Partial` reaches dmi-api as PARTIAL, and `isValidStatusChange` applies PARTIAL only to an
       * order at SUBMITTED, PARTIAL or ACCEPTED (and never a status equal to the current one), so a
       * completed order stays where it is. `Partial` after `Final` is the realistic move back — an
       * add-on test reopening the order at the lab — and the one that tests that rule: `Received` or
       * `In Progress` arrive as SUBMITTED, which dmi-api refuses from anything but WAITING_FOR_INPUT
       * or ACCEPTED, so they would leave a completed order alone even if COMPLETED were a source for
       * PARTIAL. That is dmi-api's rule, not the integration's; it is pinned here because it is what
       * the two together do end to end, now that the orders channel carries statuses that can move
       * back at all. Waiting for the re-acknowledgement at `Partial` is what makes the wait after it
       * mean "refused", not "not seen yet".
       *
       * It runs on the order the `Final` test completed, so when that test left none, it fails at
       * once saying so, rather than reading `completedBeforehand: undefined`. */
      if (finalOrderId === '') {
        throw new Error(
          "the 'Final' test did not leave a completed order for this guard to run on: " +
            'its placement or acknowledgement wait failed, or this test ran on its own',
        )
      }
      const before = await org.api.get(`/orders/${finalOrderId}`)
      expect({ completedBeforehand: before.body?.status }).toEqual({ completedBeforehand: 'COMPLETED' })

      await advanceProviderStatus(finalRequisitionId, 'Partial')
      await new Promise((resolve) => setTimeout(resolve, NEGATIVE_WAIT_MS))

      const order = await org.api.get(`/orders/${finalOrderId}`)
      expect(order.body.status).toBe('COMPLETED')
    }, ORDER_ACK_WAIT_MS + NEGATIVE_WAIT_MS + 30_000)

    /* The rows that move the order. `Canceled` is the provider's spelling (one L), and dmi-api
     * applies CANCELLED from any status. `Partial` is the one status that reaches dmi PARTIAL, so
     * its row is the only end-to-end proof of the mapping's PARTIAL branch; its PARTIAL comes with
     * a REGISTERED, empty report, which is how the results channel's PARTIAL (that report would be
     * PARTIAL too) is ruled out. dmi-api applies PARTIAL from SUBMITTED, PARTIAL or ACCEPTED, but
     * never a status equal to the current one, so PARTIAL -> PARTIAL is a no-op: the order moves
     * once, from the SUBMITTED it was placed at. */
    for (const { providerStatus, dmiStatus } of [
      { providerStatus: 'Canceled', dmiStatus: 'CANCELLED' },
      { providerStatus: 'Expired', dmiStatus: 'CANCELLED' },
      { providerStatus: 'Partial', dmiStatus: 'PARTIAL' },
    ]) {
      it(`a provider status of '${providerStatus}' moves the order to ${dmiStatus} through the orders channel`, async () => {
        const { orderId, requisitionId } = await placeAcknowledgedOrder(`status ${providerStatus}`)

        await advanceProviderStatus(requisitionId, providerStatus)

        expect(await dmiStatusAfterThePoll(orderId)).toBe(dmiStatus)
        await expectNothingFromTheResultsChannel(orderId, requisitionId)
      }, ORDER_ACK_WAIT_MS * 2 + STATUS_APPLIED_WAIT_MS + 30_000)
    }

    /* The rows that leave it. `Received` and `In Progress` are a lab that holds the sample and has
     * reported nothing yet; both reach dmi-api as SUBMITTED, which it does not apply to an order
     * that is SUBMITTED already. `In Progress` was OBSERVED on the wire (with the space) but not
     * declared by the integration at all before the fix. These two rows are green against the
     * unfixed integration too, where every status reached dmi-api as SUBMITTED: the integration's
     * unit tests carry that red. They are here because they pin the chosen mapping end to end, and
     * go red if someone maps either to PARTIAL. As in the rows above, the re-acknowledgement at the
     * new status is what makes the wait after it mean "not applied", not "not seen yet". */
    for (const providerStatus of ['Received', 'In Progress']) {
      it(`a provider status of '${providerStatus}' leaves the order SUBMITTED`, async () => {
        const { orderId, requisitionId } = await placeAcknowledgedOrder(`status ${providerStatus}`)

        await advanceProviderStatus(requisitionId, providerStatus)
        await new Promise((resolve) => setTimeout(resolve, NEGATIVE_WAIT_MS))

        const order = await org.api.get(`/orders/${orderId}`)
        expect(order.body?.status).toBe('SUBMITTED')
        await expectNothingFromTheResultsChannel(orderId, requisitionId)
      }, ORDER_ACK_WAIT_MS * 2 + NEGATIVE_WAIT_MS + 30_000)
    }
  })

  describe('an identical redelivery changes nothing (nominal-systems/dmi-api#409)', () => {
    /* Production has shown Antech returning records the integration had already acknowledged, on
     * both feeds it polls, unchanged, on every poll for hours, while answering every AckStatus 200
     * (the mock's header, load-bearing detail 8). The integration does what it should with each:
     * fetches it, emits it, acknowledges it. dmi-api applied every one as an update — the report
     * saved and `report:updated` sent again, the order saved and `order:updated` sent again with
     * its order form inline — and so told the PIMS about updates that had not happened. A delivery
     * that changes nothing must change nothing: no write and no event. A delivery that changes
     * something must still go through, once.
     *
     * The mock is switched into that redelivery per order and per channel
     * (`POST /__control__/orders/:id/redelivery`), on orders of this describe's own, and its window
     * counters say how often the record was served and acknowledged while it was on. Every wait
     * below is on those counters, never on the clock: a redelivery counts once the mock has served
     * the record AND been sent its acknowledgement, and the integration emits before it
     * acknowledges, so each counted acknowledgement is an emission dmi-api was handed. The wait
     * asks for one serving more than the acknowledgements it needs, so dmi-api has had a whole
     * poll interval to handle the last of them before anything is asserted.
     *
     * What is asserted is what the PIMS and the database see: the events for the order and its
     * report, read after a watermark taken once the first delivery's events are in (dmi-api's
     * `/events` returns events with a `seq` above `start_seq`), and the stored rows' own timestamps
     * (`updatedAt`, which MySQL moves on any write that changes a row), read over SQL. */
    const REDELIVERIES = 3
    /* At ~3 s a poll, three redeliveries and a serving after them take ~12 s; budget several times
     * that, because a red waits it out. */
    const REDELIVERY_WAIT_MS = 60_000
    const AMENDED_BUN = '31.0'

    interface StreamEvent {
      seq: number
      type: string
      data?: {
        orderId?: string
        reportId?: string
        report?: ReportBody
        status?: string
        order?: { manifest?: Partial<Manifest> | null }
      }
    }

    interface Manifest {
      id: string
      uri: string
      contentType: string
      data: string
    }

    /* The results half: a point-of-care order, so no TRF, whose result is redelivered. */
    let resultOrderId = ''
    let resultRequisitionId = ''
    let resultReportId = ''
    /* Set by the real-change test for the one after it: the watermark taken before the change. */
    let seqBeforeChange = -1
    /* The order-form half: a reference-lab order, completed as a draft, whose TRF is fetched. */
    let formOrderId = ''
    let formRequisitionId = ''
    /* The order form dmi-api stored for it when the draft was completed. */
    let firstForm: Manifest | null = null

    /* Every order this describe switched into redelivery, so afterAll can switch it off whatever
     * failed. */
    const switchedOn = new Set<string>()

    async function setRedelivery (
      requisitionId: string,
      channels: { results?: boolean, orders?: boolean },
    ): Promise<MockOrder> {
      if (channels.results === true || channels.orders === true) switchedOn.add(requisitionId)
      return expectOk<MockOrder>(
        await mock.post(`/__control__/orders/${encodeURIComponent(requisitionId)}/redelivery`, channels),
        `switch the mock's redelivery of ${requisitionId} to ${JSON.stringify(channels)}`,
      )
    }

    /* Wait until the mock has served the record at least `served` times and been sent at least
     * `acked` acknowledgements of it on `channel` while its redelivery was on, and return the
     * order. A red names the channel and what the window held when the budget ran out. */
    async function waitForRedelivery (
      requisitionId: string,
      channel: 'results' | 'orders',
      served: number,
      acked: number,
    ): Promise<MockOrder> {
      const order = await pollUntil(
        async () => await mockOrder(requisitionId),
        (entry) => entry.redelivery[channel].served >= served && entry.redelivery[channel].acked >= acked,
        REDELIVERY_WAIT_MS,
        1_000,
      )
      const window = order.redelivery[channel]
      expect({ channel, on: window.on, servedEnough: window.served >= served, ackedEnough: window.acked >= acked, window }).toEqual({
        channel,
        on: true,
        servedEnough: true,
        ackedEnough: true,
        window,
      })
      return order
    }

    /* The highest event seq this organization has, as a watermark. */
    async function latestSeq (): Promise<number> {
      const page = expectOk<{ data: Array<{ seq: number }> }>(
        await org.api.get('/events', { start_seq: 0, limit: 1000 }),
        'read the event stream for a watermark',
      )
      return page.data.reduce((max, event) => Math.max(max, event.seq ?? 0), 0)
    }

    /* The events above `afterSeq` for one order and its report. /events was once unscoped across
     * tenants (dmi-api#339) and this file places many orders, so scope by id. The page must hold
     * every event above the watermark, or a count below could be short. */
    async function eventsFor (afterSeq: number, ids: { orderId: string, reportId?: string }): Promise<StreamEvent[]> {
      const page = expectOk<{ total: number, data: StreamEvent[] }>(
        await org.api.get('/events', { start_seq: afterSeq, limit: 1000 }),
        `read the events after seq ${afterSeq}`,
      )
      expect({ afterSeq, onThePage: page.data.length }).toEqual({ afterSeq, onThePage: page.total })
      return page.data.filter(
        (event) => event.data?.orderId === ids.orderId || (ids.reportId !== undefined && event.data?.reportId === ids.reportId),
      )
    }

    function countByType (events: StreamEvent[]): Record<string, number> {
      const counts: Record<string, number> = {}
      for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1
      return counts
    }

    /* The BUN value a `report:updated` event carries, as a number. */
    function bunIn (event: StreamEvent): number | undefined {
      const bun = (event.data?.report?.testResultsSet ?? [])
        .flatMap((panel) => panel.observations ?? [])
        .find((observation) => observation.code === 'BUN')
      return bun?.valueQuantity == null ? undefined : Number(bun.valueQuantity.value)
    }

    /* The stored rows' own write times, straight from MySQL: the report row, the order row (and
     * which order form it points at), and every observation of the report. A write that changed a
     * row moves its time. The columns hold microseconds, but the times dmi-api's writes leave in
     * them are whole seconds, so a write shows only against a time at least a second older, which
     * the ~3 s poll interval gives every comparison below. */
    async function storedWrites (orderId: string, reportId?: string): Promise<Record<string, unknown>> {
      const format = "DATE_FORMAT(`updatedAt`, '%Y-%m-%d %H:%i:%s.%f')"
      const [order] = await query<{ updatedAt: string, manifestId: string | null, status: string }>(
        `SELECT ${format} AS updatedAt, \`manifestId\`, \`status\` FROM \`order\` WHERE \`id\` = ?`,
        [orderId],
      )
      const stored: Record<string, unknown> = { order }
      if (reportId !== undefined) {
        const [report] = await query<{ updatedAt: string, status: string }>(
          `SELECT ${format} AS updatedAt, \`status\` FROM \`report\` WHERE \`id\` = ?`,
          [reportId],
        )
        const observations = await query<{ code: string, updatedAt: string }>(
          "SELECT o.`code`, DATE_FORMAT(o.`updatedAt`, '%Y-%m-%d %H:%i:%s.%f') AS updatedAt " +
            'FROM `observation` o JOIN `test_result` t ON o.`testResultId` = t.`id` ' +
            'WHERE t.`reportId` = ? ORDER BY o.`code`',
          [reportId],
        )
        stored.report = report
        stored.observations = observations
      }
      return stored
    }

    async function manifestOf (orderId: string): Promise<Manifest> {
      return expectOk<Manifest>(await org.api.get(`/orders/${orderId}/manifest`), `read the order form of ${orderId}`)
    }

    function sha256 (base64: string): string {
      return createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex')
    }

    /* The mock's record of an order's seeded result: whether it is acknowledged, how often it was
     * served and acknowledged, and which GetAllResults calls carried it. */
    async function resultStateOf (requisitionId: string): Promise<{
      acknowledged: boolean
      servedCount: number
      ackCount: number
      servedInCalls: number[]
    }> {
      return expectOk(
        await mock.get(`/__control__/orders/${encodeURIComponent(requisitionId)}/result`),
        `read the seeded result state of ${requisitionId}`,
      )
    }

    afterAll(async () => {
      /* Leave the mock as the later describes expect it: nothing redelivered. */
      for (const requisitionId of switchedOn) {
        await mock
          .post(`/__control__/orders/${encodeURIComponent(requisitionId)}/redelivery`, { results: false, orders: false })
          .catch(() => undefined)
      }
      const listed = expectOk<{ orders: MockOrder[] }>(await mock.get('/__control__/orders'), 'list the mock orders')
      const stillOn = listed.orders
        .filter((order) => order.redelivery.results.on || order.redelivery.orders.on)
        .map((order) => order.clinicAccessionId)
      expect({ stillRedelivering: stillOn }).toEqual({ stillRedelivering: [] })
    })

    it('a result served again after its acknowledgement, unchanged, is not applied again: no event, no write', async () => {
      const payload = payloadFor([KIDNEY_PANEL_CODE], {
        requisitionId: `hrn-v6-redelivered-result-${randomUUID().slice(0, 8)}`,
      })
      resultRequisitionId = payload.requisitionId as string
      const created = expectOk<{ id: string, status: string }>(
        await org.api.post('/orders', payload, { autoSubmitOrder: true }),
        'place the order whose result will be redelivered',
      )
      resultOrderId = created.id
      expect(created.status).toBe('SUBMITTED')

      /* The orders poll acknowledges the order at `Submitted` before the result is seeded (the file
       * header, point 3), so the order's COMPLETED below is the results channel's. */
      await waitForOrderAck(resultRequisitionId)
      const seqBeforeResult = await latestSeq()

      /* The first delivery, as the loop at the top of this file closes it. */
      expectOk(
        await mock.post(`/__control__/orders/${encodeURIComponent(resultRequisitionId)}/results`, {
          unitCodeResults: [{ orderCode: KIDNEY_PANEL_CODE, testCodeResults: KIDNEY_PANEL }],
          pendingTestCount: 0,
          totalTestCount: 1,
        }),
        'seed the result that will be redelivered',
      )
      const report = await pollUntil(
        async () => await org.api.get(`/orders/${resultOrderId}/report`),
        (response) => response.body?.status === 'FINAL',
        COMPLETION_WAIT_MS,
        1_000,
      )
      expect(report.body.status).toBe('FINAL')
      resultReportId = report.body.id
      expect((await org.api.get(`/orders/${resultOrderId}`)).body.status).toBe('COMPLETED')

      /* Delivered once and acknowledged once, with the redelivery still off: the mock's normal
       * acknowledge semantics, which is what makes everything after the switch a REdelivery. */
      const once = await pollUntil(
        async () =>
          expectOk<{ acknowledged: boolean, servedCount: number, ackCount: number }>(
            await mock.get(`/__control__/orders/${encodeURIComponent(resultRequisitionId)}/result`),
            'read the seeded result state',
          ),
        (state) => state.acknowledged && state.ackCount >= 1,
        ORDER_ACK_WAIT_MS,
        1_000,
      )
      expect({ acknowledged: once.acknowledged, served: once.servedCount, acked: once.ackCount }).toEqual({
        acknowledged: true,
        served: 1,
        acked: 1,
      })

      /* That one delivery produced exactly what the loop expects of a result: one report:updated
       * (REGISTERED -> FINAL) and one order:updated (SUBMITTED -> COMPLETED), and nothing else. */
      const firstDelivery = await pollUntil(
        async () => countByType(await eventsFor(seqBeforeResult, { orderId: resultOrderId, reportId: resultReportId })),
        (counts) => (counts['report:updated'] ?? 0) >= 1 && (counts['order:updated'] ?? 0) >= 1,
        STATUS_APPLIED_WAIT_MS,
        1_000,
      )
      expect(firstDelivery).toEqual({ 'order:updated': 1, 'report:updated': 1 })

      const reportBefore = expectOk<ReportBody>(await org.api.get(`/orders/${resultOrderId}/report`), 'read the report')
      const storedBefore = await storedWrites(resultOrderId, resultReportId)
      expect((storedBefore.observations as unknown[]).length).toBe(KIDNEY_PANEL.length)
      const watermark = await latestSeq()

      /* Antech starts serving the acknowledged result again, on every poll. */
      await setRedelivery(resultRequisitionId, { results: true })
      await waitForRedelivery(resultRequisitionId, 'results', REDELIVERIES + 1, REDELIVERIES)

      /* THE POINT OF THIS TEST. Each of those redeliveries reached dmi-api (the integration emits
       * before it acknowledges) and none of them changed anything, so none of them may be an
       * update: no `report:updated`, no `order:updated`, nothing for the PIMS at all. */
      const sinceRedelivery = countByType(await eventsFor(watermark, { orderId: resultOrderId, reportId: resultReportId }))
      expect({ order: resultRequisitionId, eventsWhileRedelivered: sinceRedelivery }).toEqual({
        order: resultRequisitionId,
        eventsWhileRedelivered: {},
      })

      /* And nothing was written: the report row, the order row and every observation row keep the
       * write time the first delivery gave them. The events above are what prove the fix: a save
       * writes only a column that differs, so even a dmi-api that saved every delivery need not
       * move these rows. This guards against a write that sends no event, such as the report row
       * touched on every unchanged delivery, which goes red here naming the row's `updatedAt`. */
      expect(await storedWrites(resultOrderId, resultReportId)).toEqual(storedBefore)

      /* The report still reads what was delivered, all of it. */
      const reportAfter = expectOk<ReportBody>(await org.api.get(`/orders/${resultOrderId}/report`), 'read the report again')
      expect(reportAfter).toEqual(reportBefore)
      expect((await observationsFor(resultOrderId)).map((observation) => [observation.code, observation.valueQuantity?.value])).toEqual([
        ['BUN', 24.3],
        ['CREA', 2.4],
        ['GLOB', 3.6],
      ])
    }, ORDER_ACK_WAIT_MS * 2 + COMPLETION_WAIT_MS + STATUS_APPLIED_WAIT_MS + REDELIVERY_WAIT_MS + 30_000)

    it('another order\'s new result goes through in the same poll as the unchanged redelivered result', async () => {
      /* The positive control for the test above, as the one after the order-form test is for the
       * orders half. "No report:updated" is also what a dmi-api whose results handler FAILED on the
       * redelivered result would show, so that test cannot tell a redelivery recognised as unchanged
       * from one that crashed the handler. The results poll reads GetAllResults once and hands
       * dmi-api every result it read in ONE `external_results` event, and dmi-api goes through the
       * reports it already has one after the other and sends their events only after the last of
       * them, so a throw on any one of them leaves every report's event unsent. A result for a
       * second order, served in the same GetAllResults response as the redelivered one, gets its
       * `report:updated` only if the unchanged one was handled. That it was the same response is
       * checked at the mock, which records the GetAllResults calls that carried each result: while
       * the redelivery is on, every call carries the redelivered result, and the check makes sure
       * the one that carried the new result did.
       *
       * The second order is point-of-care, placed and acknowledged at `Submitted` before its result
       * is seeded (the file header, point 3), and its result is a real change: its first, taking
       * the report from REGISTERED to FINAL and the order from SUBMITTED to COMPLETED. Runs on the
       * order the test above left in redelivery. */
      if (resultOrderId === '' || resultReportId === '') {
        throw new Error('the redelivery test above left no redelivered result for this test to share a poll with')
      }
      expect((await mockOrder(resultRequisitionId)).redelivery.results.on).toBe(true)

      const { orderId: mateOrderId, requisitionId: mateRequisitionId } = await placeAcknowledgedOrder('result mate')
      const mateReportId = expectOk<ReportBody>(
        await org.api.get(`/orders/${mateOrderId}/report`),
        'read the empty report of the order whose result changes',
      ).id
      const storedBefore = await storedWrites(resultOrderId, resultReportId)
      const watermark = await latestSeq()

      expectOk(
        await mock.post(`/__control__/orders/${encodeURIComponent(mateRequisitionId)}/results`, {
          unitCodeResults: [{ orderCode: KIDNEY_PANEL_CODE, testCodeResults: KIDNEY_PANEL }],
          pendingTestCount: 0,
          totalTestCount: 1,
        }),
        'seed the second order\'s result while the first is being redelivered',
      )
      /* Acknowledged: the poll that served it has emitted it to dmi-api. */
      const mate = await pollUntil(
        async () => await resultStateOf(mateRequisitionId),
        (state) => state.acknowledged && state.ackCount >= 1,
        ORDER_ACK_WAIT_MS,
        1_000,
      )

      /* One poll: the new result was served once, and the GetAllResults call that carried it carried
       * the redelivered result too. Were they served in polls of their own, a handler that failed
       * on the unchanged result would fail only its own poll, and this test would pass anyway. */
      const redelivered = await resultStateOf(resultRequisitionId)
      expect({
        order: mateRequisitionId,
        served: mate.servedInCalls.length,
        acked: mate.ackCount,
        servedWithoutTheRedelivered: mate.servedInCalls.filter((call) => !redelivered.servedInCalls.includes(call)),
      }).toEqual({ order: mateRequisitionId, served: 1, acked: 1, servedWithoutTheRedelivered: [] })

      /* THE POINT OF THIS TEST. The new result is reported, so the batch it came in was handled to
       * the end: one `report:updated`, carrying its values, and the order's completion. */
      const told = await pollUntil(
        async () => await eventsFor(watermark, { orderId: mateOrderId, reportId: mateReportId }),
        (events) => events.some((event) => event.type === 'report:updated') && events.some((event) => event.type === 'order:updated'),
        STATUS_APPLIED_WAIT_MS,
        1_000,
      )
      expect({
        order: mateRequisitionId,
        events: countByType(told),
        bunReported: told.filter((event) => event.type === 'report:updated').map(bunIn),
      }).toEqual({
        order: mateRequisitionId,
        events: { 'order:updated': 1, 'report:updated': 1 },
        bunReported: [24.3],
      })
      expect((await org.api.get(`/orders/${mateOrderId}/report`)).body.status).toBe('FINAL')
      expect((await observationsFor(mateOrderId)).map((observation) => [observation.code, observation.valueQuantity?.value])).toEqual([
        ['BUN', 24.3],
        ['CREA', 2.4],
        ['GLOB', 3.6],
      ])
      expect((await org.api.get(`/orders/${mateOrderId}`)).body.status).toBe('COMPLETED')

      /* And the redelivered result, handled in that poll, still changed nothing. */
      expect({
        order: resultRequisitionId,
        eventsWhileRedelivered: countByType(await eventsFor(watermark, { orderId: resultOrderId, reportId: resultReportId })),
      }).toEqual({ order: resultRequisitionId, eventsWhileRedelivered: {} })
      expect(await storedWrites(resultOrderId, resultReportId)).toEqual(storedBefore)
    }, ORDER_ACK_WAIT_MS * 2 + STATUS_APPLIED_WAIT_MS + 30_000)

    it('a real change made while the result is being redelivered still goes through', async () => {
      /* The guard against a fix that simply stops applying redelivered results: the lab amends the
       * result while Antech is still redelivering it, and the amendment must reach the report and
       * the PIMS. Runs on the order the test above left in redelivery. */
      if (resultOrderId === '' || resultReportId === '') {
        throw new Error('the redelivery test above left no delivered result for this test to amend')
      }
      expect((await mockOrder(resultRequisitionId)).redelivery.results.on).toBe(true)

      const storedBefore = await storedWrites(resultOrderId, resultReportId)
      seqBeforeChange = await latestSeq()

      /* BUN amended, the rest as delivered. Re-seeding makes the result pending again and leaves
       * the redelivery on, so the amended result is delivered and then redelivered in its turn. */
      expectOk(
        await mock.post(`/__control__/orders/${encodeURIComponent(resultRequisitionId)}/results`, {
          unitCodeResults: [
            { orderCode: KIDNEY_PANEL_CODE, testCodeResults: [{ ...KIDNEY_PANEL[0], result: AMENDED_BUN }, ...KIDNEY_PANEL.slice(1)] },
          ],
          pendingTestCount: 0,
          totalTestCount: 1,
        }),
        'amend the result at the provider while it is being redelivered',
      )

      const amended = await pollUntil(
        async () => await observationsFor(resultOrderId),
        (observations) => observations.find((observation) => observation.code === 'BUN')?.valueQuantity?.value === Number(AMENDED_BUN),
        COMPLETION_WAIT_MS,
        1_000,
      )
      /* The amendment, and only the amendment: one BUN, at its new value, beside the analytes that
       * did not change. */
      expect(amended.map((observation) => [observation.code, observation.valueQuantity?.value])).toEqual([
        ['BUN', Number(AMENDED_BUN)],
        ['CREA', 2.4],
        ['GLOB', 3.6],
      ])
      expect((await org.api.get(`/orders/${resultOrderId}/report`)).body.status).toBe('FINAL')

      /* The PIMS was told: a `report:updated` carrying the new value. At least one here — the test
       * after this one pins that it is exactly one. */
      const told = await pollUntil(
        async () => await eventsFor(seqBeforeChange, { orderId: resultOrderId, reportId: resultReportId }),
        (events) => events.some((event) => event.type === 'report:updated' && bunIn(event) === Number(AMENDED_BUN)),
        STATUS_APPLIED_WAIT_MS,
        1_000,
      )
      expect(told.filter((event) => event.type === 'report:updated').map(bunIn)).toContain(Number(AMENDED_BUN))

      /* And it was written: the BUN row's write time moved. */
      const storedAfter = await storedWrites(resultOrderId, resultReportId)
      const bunWrite = (stored: Record<string, unknown>): string | undefined =>
        (stored.observations as Array<{ code: string, updatedAt: string }>).find((row) => row.code === 'BUN')?.updatedAt
      expect(bunWrite(storedAfter)).not.toBe(bunWrite(storedBefore))
      expect(bunWrite(storedAfter)).toBeTruthy()

      /* The order is not the report: an amended observation leaves a completed order as it was. */
      expect((await org.api.get(`/orders/${resultOrderId}`)).body.status).toBe('COMPLETED')
    }, COMPLETION_WAIT_MS + STATUS_APPLIED_WAIT_MS + 30_000)

    it('the amended result, redelivered in its turn, is reported once', async () => {
      /* The amendment was applied (the test above); Antech goes on serving the amended result as it
       * served the first. Exactly ONE `report:updated` carries the new value — the change — and its
       * redeliveries add none, as the first result's added none. */
      if (seqBeforeChange < 0) {
        throw new Error('the real-change test above did not amend the result for this test to follow')
      }
      const window = (await mockOrder(resultRequisitionId)).redelivery.results
      await waitForRedelivery(resultRequisitionId, 'results', window.served + REDELIVERIES + 1, window.acked + REDELIVERIES)

      const sinceChange = await eventsFor(seqBeforeChange, { orderId: resultOrderId, reportId: resultReportId })
      expect({
        order: resultRequisitionId,
        events: countByType(sinceChange),
        bunReported: sinceChange.filter((event) => event.type === 'report:updated').map(bunIn),
      }).toEqual({
        order: resultRequisitionId,
        events: { 'report:updated': 1 },
        bunReported: [Number(AMENDED_BUN)],
      })
    }, REDELIVERY_WAIT_MS + 30_000)

    it('when Antech stops redelivering, the acknowledged result leaves the feed for good', async () => {
      /* "Then it stopped by itself." Switched off, the record is governed by its acknowledgement
       * again, and every redelivery was acknowledged, so it is not served again. Counted against the
       * mock's GetAllResults calls rather than the clock: the first call after the switch can belong
       * to a poll that was already under way, so the count is taken after it, and three polls more
       * must leave it where it was. */
      if (resultRequisitionId === '') throw new Error('no redelivered result to stop redelivering')
      await setRedelivery(resultRequisitionId, { results: false })

      const callsAt = async (): Promise<number> =>
        expectOk<{ getAllResults: number }>(await mock.get('/__control__/calls'), 'read the mock call counters').getAllResults
      const resultState = async (): Promise<{ acknowledged: boolean, servedCount: number }> =>
        expectOk<{ acknowledged: boolean, servedCount: number }>(
          await mock.get(`/__control__/orders/${encodeURIComponent(resultRequisitionId)}/result`),
          'read the result state',
        )

      const offAt = await callsAt()
      await pollUntil(callsAt, (calls) => calls >= offAt + 1, REDELIVERY_WAIT_MS, 500)
      const settled = await resultState()
      const later = await pollUntil(callsAt, (calls) => calls >= offAt + 1 + REDELIVERIES, REDELIVERY_WAIT_MS, 500)
      expect(later).toBeGreaterThanOrEqual(offAt + 1 + REDELIVERIES)

      const after = await resultState()
      expect({ acknowledged: after.acknowledged, served: after.servedCount }).toEqual({
        acknowledged: true,
        served: settled.servedCount,
      })
      expect((await mockOrder(resultRequisitionId)).redelivery.results.on).toBe(false)
    }, REDELIVERY_WAIT_MS * 2 + 30_000)

    it('an order re-offered after its acknowledgement, with a freshly generated order form, is not applied again', async () => {
      /* The orders half, and the one production showed with a PDF inline: the labOrder feed served
       * acknowledged orders again, and for each the integration fetched the order form (TRF) again
       * and re-emitted the order with it as its `manifest`. Antech regenerates that PDF on every
       * fetch (the mock's header, load-bearing detail 9): the same accession's form under the same
       * URL, never the same bytes. So a redelivered order brings a manifest that differs in its
       * bytes from the one stored and is still the same form — and the order must not be updated
       * for it.
       *
       * A reference-lab order, so the TRF is fetched at all (a point-of-care order has none), placed
       * as a draft and completed at the provider, as the pre-order describe above does. */
      const payload = payloadFor([referenceLabCode], {
        requisitionId: `hrn-v6-redelivered-form-${randomUUID().slice(0, 8)}`,
      })
      formRequisitionId = payload.requisitionId as string
      const created = expectOk<{ id: string, status: string }>(
        await org.api.post('/orders', payload, { autoSubmitOrder: true }),
        'place the reference-lab order whose order form will be redelivered',
      )
      formOrderId = created.id
      expect(created.status).toBe('WAITING_FOR_INPUT')

      const seqBeforePromotion = await latestSeq()
      expectOk(
        await mock.post(`/__control__/orders/${encodeURIComponent(formRequisitionId)}/promote`, {}),
        'complete the draft at the provider',
      )
      const submitted = await pollUntil(
        async () => await org.api.get(`/orders/${formOrderId}`),
        (response) => response.body?.status === 'SUBMITTED',
        ORDER_ACK_WAIT_MS,
        1_000,
      )
      expect(submitted.body.status).toBe('SUBMITTED')
      const acked = await waitForOrderAck(formRequisitionId)
      expect(acked.trfFetches).toBeGreaterThanOrEqual(1)

      /* The completion is one order:updated (WAITING_FOR_INPUT -> SUBMITTED, with the form). */
      const completion = await pollUntil(
        async () => await eventsFor(seqBeforePromotion, { orderId: formOrderId }),
        (events) => events.some((event) => event.type === 'order:updated'),
        STATUS_APPLIED_WAIT_MS,
        1_000,
      )
      expect(countByType(completion)).toEqual({ 'order:updated': 1 })

      /* The form dmi-api stored is a PDF the mock served for this accession — its digest is one of
       * the mock's — under the TRF's URL. */
      const formBefore = await manifestOf(formOrderId)
      firstForm = formBefore
      expect(formBefore.contentType).toBe('application/pdf')
      expect(formBefore.uri).toBe(`${env.antechV6.baseUrl}/HTPDF/trf/pims/${formRequisitionId}`)
      const pdf = Buffer.from(formBefore.data, 'base64').toString('latin1')
      expect(pdf.startsWith('%PDF-1.7\n')).toBe(true)
      expect(pdf).toContain(`synthetic harness TRF for ${formRequisitionId}`)
      expect(acked.trfDigests).toContain(sha256(formBefore.data))

      /* And the completion's order:updated carried that form inline: the stored one, by its id,
       * URL, content type and bytes. */
      const told = completion[0].data?.order?.manifest
      expect({
        status: completion[0].data?.status,
        manifest: told == null ? told : { id: told.id, uri: told.uri, contentType: told.contentType, digest: told.data == null ? told.data : sha256(told.data) },
      }).toEqual({
        status: 'SUBMITTED',
        manifest: { id: formBefore.id, uri: formBefore.uri, contentType: formBefore.contentType, digest: sha256(formBefore.data) },
      })

      const storedBefore = await storedWrites(formOrderId)
      expect((storedBefore.order as { manifestId: string | null }).manifestId).toBe(formBefore.id)
      const watermark = await latestSeq()
      const fetchesBefore = (await mockOrder(formRequisitionId)).trfDigests.length

      /* Antech starts offering the acknowledged order again, on every poll. */
      await setRedelivery(formRequisitionId, { orders: true })
      const redelivered = await waitForRedelivery(formRequisitionId, 'orders', REDELIVERIES + 1, REDELIVERIES)

      /* Each redelivery fetched the form again, and every fetch had bytes of its own — so each
       * order dmi-api was handed carried a manifest unlike the one it holds. */
      const fetchedSince = redelivered.trfDigests.slice(fetchesBefore)
      expect(fetchedSince.length).toBeGreaterThanOrEqual(REDELIVERIES)
      expect(new Set(redelivered.trfDigests).size).toBe(redelivered.trfDigests.length)

      /* THE POINT OF THIS TEST. No `order:updated` for any of them. */
      const sinceRedelivery = countByType(await eventsFor(watermark, { orderId: formOrderId }))
      expect({ order: formRequisitionId, eventsWhileRedelivered: sinceRedelivery }).toEqual({
        order: formRequisitionId,
        eventsWhileRedelivered: {},
      })

      /* Nothing written: the order row keeps its write time and points at the same form, and the
       * stored form is still the first one, byte for byte. */
      expect(await storedWrites(formOrderId)).toEqual(storedBefore)
      expect(await manifestOf(formOrderId)).toEqual(formBefore)
      expect((await org.api.get(`/orders/${formOrderId}`)).body.status).toBe('SUBMITTED')
    }, ORDER_ACK_WAIT_MS * 2 + STATUS_APPLIED_WAIT_MS + REDELIVERY_WAIT_MS + 30_000)

    it('another order\'s real change goes through in the same poll as the unchanged re-offered order', async () => {
      /* The positive control for the test above. "No order:updated" is also what a dmi-api whose
       * orders handler FAILED on the re-offered order would show, so that test cannot tell a
       * redelivery recognised as unchanged from one that crashed the handler. The orders poll hands
       * dmi-api every order it read in ONE `external_orders` event, and dmi-api saves and notifies
       * only after it has gone through all of them, so a second order whose provider status really
       * changed, read in a poll that also carries the re-offered order unchanged, is applied only if
       * the unchanged one was handled. The re-offered order is in that poll because its redelivery
       * is on: while it is, every poll's unacknowledged view carries it, which the window counter
       * shows.
       *
       * The second order is point-of-care, placed and acknowledged at `Submitted`, then advanced to
       * `Partial` and offered again with the control plane's `replay` (a harness action, as in the
       * describe on the orders channel above). dmi-api applies PARTIAL from SUBMITTED, so the
       * change is one `order:updated` and the order PARTIAL; no result is seeded for it, so the
       * PARTIAL is the orders channel's. */
      if (formRequisitionId === '') throw new Error('the test above left no re-offered order for this one to share a poll with')
      expect((await mockOrder(formRequisitionId)).redelivery.orders.on).toBe(true)

      const { orderId: mateOrderId, requisitionId: mateRequisitionId } = await placeAcknowledgedOrder('poll mate')

      const servedBefore = (await mockOrder(formRequisitionId)).redelivery.orders.served
      const watermark = await latestSeq()
      /* Acknowledged at `Partial`: the poll that read it so has emitted it to dmi-api. */
      await advanceProviderStatus(mateRequisitionId, 'Partial')
      const formNow = await mockOrder(formRequisitionId)
      expect({ reOffered: formNow.redelivery.orders.on, servedSince: formNow.redelivery.orders.served > servedBefore }).toEqual({
        reOffered: true,
        servedSince: true,
      })

      const mate = await pollUntil(
        async () => await org.api.get(`/orders/${mateOrderId}`),
        (response) => typeof response.body?.status === 'string' && response.body.status !== 'SUBMITTED',
        STATUS_APPLIED_WAIT_MS,
        1_000,
      )
      expect({ order: mateRequisitionId, status: mate.body?.status }).toEqual({ order: mateRequisitionId, status: 'PARTIAL' })

      const told = await eventsFor(watermark, { orderId: mateOrderId })
      expect({ events: countByType(told), statuses: told.map((event) => event.data?.status) }).toEqual({
        events: { 'order:updated': 1 },
        statuses: ['PARTIAL'],
      })
      await expectNothingFromTheResultsChannel(mateOrderId, mateRequisitionId)
    }, ORDER_ACK_WAIT_MS * 2 + STATUS_APPLIED_WAIT_MS + 30_000)

    it('a real change to the re-offered order itself goes through once, with the form fetched for it', async () => {
      /* The order being re-offered changes at the provider: `Partial`, which dmi-api applies from
       * SUBMITTED. That delivery is an update — one `order:updated`, the order PARTIAL — and the
       * order is saved with the order form that delivery carried, the one fetched in the poll that
       * read `Partial`. Antech goes on re-offering the order at `Partial`, each time with a form
       * fetched anew; those deliveries change nothing (PARTIAL again is no change) and add nothing.
       *
       * `replay: false` on the status: the redelivery serves the order on every poll anyway, so the
       * change reaches dmi-api the way production's would, with no harness re-offer. The mock keeps,
       * beside each form's digest, the status the feed last served the order at, which is the
       * status of the delivery the form went out with: that is how the stored form is matched to
       * its fetch. No result is seeded for this order, so its PARTIAL is the orders channel's. */
      if (formRequisitionId === '' || firstForm === null) {
        throw new Error('the order-form test above left no re-offered order for this test to change')
      }
      const before = await mockOrder(formRequisitionId)
      expect(before.redelivery.orders.on).toBe(true)
      const watermark = await latestSeq()

      expectOk(
        await mock.post(`/__control__/orders/${encodeURIComponent(formRequisitionId)}/status`, {
          orderStatus: 'Partial',
          replay: false,
        }),
        'change the re-offered order at the provider: Partial',
      )
      await waitForOrderAck(formRequisitionId, 'Partial')
      const changed = await pollUntil(
        async () => await org.api.get(`/orders/${formOrderId}`),
        (response) => typeof response.body?.status === 'string' && response.body.status !== 'SUBMITTED',
        STATUS_APPLIED_WAIT_MS,
        1_000,
      )
      expect(changed.body?.status).toBe('PARTIAL')

      /* Then Antech re-offers the order at `Partial` as it re-offered it at `Submitted`. */
      const atPartial = (await mockOrder(formRequisitionId)).redelivery.orders
      const after = await waitForRedelivery(
        formRequisitionId,
        'orders',
        atPartial.served + REDELIVERIES + 1,
        atPartial.acked + REDELIVERIES,
      )

      /* Exactly one update, the change, however often the changed order was re-offered. */
      const told = await eventsFor(watermark, { orderId: formOrderId })
      expect({ order: formRequisitionId, events: countByType(told), statuses: told.map((event) => event.data?.status) }).toEqual({
        order: formRequisitionId,
        events: { 'order:updated': 1 },
        statuses: ['PARTIAL'],
      })
      expect((await org.api.get(`/orders/${formOrderId}`)).body.status).toBe('PARTIAL')

      /* The form stored is the one fetched with the change: the first fetch after it that went out
       * at `Partial`, and none of the re-offers' forms after it. Same document, so the same URL and
       * content type as the first form; new bytes. */
      const changeFetch = after.trfOrderStatuses.findIndex(
        (status, index) => index >= before.trfDigests.length && status === 'Partial',
      )
      expect(changeFetch).toBeGreaterThanOrEqual(before.trfDigests.length)
      expect(after.trfDigests.length - changeFetch).toBeGreaterThan(REDELIVERIES)
      const stored = await manifestOf(formOrderId)
      expect({ uri: stored.uri, contentType: stored.contentType, digest: sha256(stored.data) }).toEqual({
        uri: firstForm.uri,
        contentType: firstForm.contentType,
        digest: after.trfDigests[changeFetch],
      })
      expect(stored.data).not.toBe(firstForm.data)
      await expectNothingFromTheResultsChannel(formOrderId, formRequisitionId)
    }, ORDER_ACK_WAIT_MS + STATUS_APPLIED_WAIT_MS + REDELIVERY_WAIT_MS + 30_000)

    it('when Antech stops re-offering, the acknowledged order leaves the feed for good', async () => {
      /* As for the result: switched off, the order is governed by its acknowledgement again. It is
       * a reference-lab order, so every serving would fetch its form, and the form fetches are what
       * is counted, against the mock's labOrder status calls. */
      if (formRequisitionId === '') throw new Error('no redelivered order to stop re-offering')
      await setRedelivery(formRequisitionId, { orders: false })

      const callsAt = async (): Promise<number> =>
        expectOk<{ getStatusLabOrder: number }>(await mock.get('/__control__/calls'), 'read the mock call counters')
          .getStatusLabOrder

      const offAt = await callsAt()
      await pollUntil(callsAt, (calls) => calls >= offAt + 1, REDELIVERY_WAIT_MS, 500)
      const settled = await mockOrder(formRequisitionId)
      const later = await pollUntil(callsAt, (calls) => calls >= offAt + 1 + REDELIVERIES, REDELIVERY_WAIT_MS, 500)
      expect(later).toBeGreaterThanOrEqual(offAt + 1 + REDELIVERIES)

      const after = await mockOrder(formRequisitionId)
      expect({ acked: after.orderAcked, trfFetches: after.trfFetches, on: after.redelivery.orders.on }).toEqual({
        acked: true,
        trfFetches: settled.trfFetches,
        on: false,
      })
    }, REDELIVERY_WAIT_MS * 2 + 30_000)
  })

  describe('a Retry-After from Antech is honoured (nominal-systems/dmi-engine-common#27)', () => {
    /* dmi-engine-common's `BaseApiService.get` retries a GET once when it fails with a 5xx, a 429 or
     * no response: after 100 ms by default, or after the response's `Retry-After` when it carries
     * one (capped at 60 s). That is #27, released in dmi-engine-common 1.7.0, the version dmi-engine's
     * lockfile resolves. Whether Antech ever sends the header is not known; the mock sends it when a
     * scenario asks (its header).
     *
     * WHICH ENDPOINT. The retry decides its delay from the error it is handed, and on 1.7.0 the
     * logging interceptor runs the integration's accession-id extractor on the error body first. On
     * GetStatus and GetAllResults that extractor dereferences success-only keys, throws, and the
     * TypeError replaces the provider's error: it has no response, so no header, and the retry runs
     * after 100 ms whatever the provider said (the status-poll audit tripwire below is the same
     * throw). The TRF's extractor reads the URL alone, so its error reaches the retry whole. And the
     * TRF is fetched inside the orders poll, once per reference-lab order, which gives a call this
     * test can single out: a promoted draft's. */
    afterEach(expectNothingLeftArmed)

    const RETRY_AFTER_SECONDS = 2
    /* A 100 ms retry cannot reach the lower bound and a 2 s one cannot miss it: the integration's
     * timer starts only once the 503 has reached it, so the retry arrives at least 2 s after the
     * 503 did, by the mock's own clock. The upper bound leaves three seconds for a slow CI machine. */
    const MIN_GAP_MS = RETRY_AFTER_SECONDS * 1000 - 100
    const MAX_GAP_MS = RETRY_AFTER_SECONDS * 1000 + 3_000

    it('a 503 with `Retry-After: 2` on an order form is retried about two seconds later, in the same poll, and the retried form is the one stored', async () => {
      const payload = payloadFor([referenceLabCode], {
        requisitionId: `hrn-v6-retry-after-${randomUUID().slice(0, 8)}`,
      })
      const requisitionId = payload.requisitionId as string
      const created = expectOk<{ id: string, status: string }>(
        await org.api.post('/orders', payload, { autoSubmitOrder: true }),
        'place the reference-lab order whose form will be refused once',
      )
      expect(created.status).toBe('WAITING_FOR_INPUT')

      const since = await lastLoggedSeq()
      let trfCalls: LoggedCall[] = []
      try {
        /* The next TRF fetch, whichever order it is for, is answered 503 with the header. Nothing
         * else in this file is on the labOrder feed by now, so it is this order's: the call log
         * below shows that it was. The body is the TRF endpoint's own `{StatusCode, ErrorMessage}`
         * shape, with a wording of the mock's (an Antech 503 was never captured). */
        expectOk(
          await mock.post('/__control__/scenarios', {
            key: 'trf',
            status: 503,
            body: { StatusCode: 503, ErrorMessage: 'Service Unavailable' },
            retryAfter: RETRY_AFTER_SECONDS,
            once: true,
          }),
          `arm a one-shot 503 with Retry-After: ${RETRY_AFTER_SECONDS} on the next TRF fetch`,
        )
        expectOk(
          await mock.post(`/__control__/orders/${encodeURIComponent(requisitionId)}/promote`, {}),
          'promote the draft to a placed order at the mock',
        )
        /* The orders poll fetches the form, emits the order, then acknowledges it: once the ack has
         * landed, every fetch of this poll has happened. */
        await waitForOrderAck(requisitionId)
        trfCalls = (await loggedCalls('trf', since)).filter((call) => call.clinicAccessionId === requisitionId)
      } finally {
        /* Consumed by the 503 when all went well; disarmed here when it did not. */
        await mock.delete('/__control__/scenarios/trf').catch(() => undefined)
      }

      /* The 503 reached this order's form, carrying the header, and one retry followed it. */
      expect(trfCalls.map((call) => ({ status: call.status, retryAfter: call.retryAfter }))).toEqual([
        { status: 503, retryAfter: String(RETRY_AFTER_SECONDS) },
        { status: 200, retryAfter: null },
      ])
      const [refused, retried] = trfCalls
      const gapMs = Date.parse(retried.at) - Date.parse(refused.at)
      console.log(`[antech-v6-scenario] TRF retried ${gapMs} ms after the 503 with Retry-After: ${RETRY_AFTER_SECONDS}`)
      expect({ gapMs, atLeast: gapMs >= MIN_GAP_MS, atMost: gapMs <= MAX_GAP_MS }).toEqual({ gapMs, atLeast: true, atMost: true })
      /* The HTTP layer's retry, not the next poll fetching the form again: no orders poll began
       * between the two. */
      expect(retried.labOrderPolls).toBe(refused.labOrderPolls)

      /* And the retry's answer is what reached dmi-api: the order form it stored is the one document
       * the mock served. Read once dmi-api has applied the order the poll delivered. */
      const submitted = await pollUntil(
        async () => await org.api.get(`/orders/${created.id}`),
        (response) => response.body?.status === 'SUBMITTED',
        STATUS_APPLIED_WAIT_MS,
        1_000,
      )
      expect(submitted.body?.status).toBe('SUBMITTED')
      const order = await mockOrder(requisitionId)
      expect(order.trfDigests).toHaveLength(1)
      const stored = expectOk<{ data: string }>(await org.api.get(`/orders/${created.id}/manifest`), 'read the stored order form')
      expect(createHash('sha256').update(Buffer.from(stored.data, 'base64')).digest('hex')).toBe(order.trfDigests[0])
    }, ORDER_ACK_WAIT_MS + STATUS_APPLIED_WAIT_MS + 30_000)
  })

  describe('a status poll held past the integration\'s HTTP timeout (nominal-systems/dmi-engine-antech-v6-integration#70)', () => {
    /* #70 gave every Antech V6 call a timeout: `HttpModule.register({ timeout: 60000 })` in the
     * integration's `antech-v6-api.module.ts`, 60 s and not configurable. Before it a call had none,
     * and an answer Antech held, held the poll with it. The orders queue runs one poll at a time
     * (`ANTECH_V6_ORDERS_CONCURRENCY`, 1 by default and not set here), and Bull 4 creates a
     * repeatable job's next run only when the current one starts (`nextJobFromJobData`), so while one
     * orders poll is open no other runs: the next falls due and waits for it.
     *
     * What tells the two apart is the held request itself, and this is what the test asserts. With
     * the timeout the integration gives up on it at 60 s (the fault's outcome `client-closed`, 60 s
     * after it arrived) and, since a call that got no response is retried once by dmi-engine-common's
     * `BaseApiService` 100 ms later, asks again: the next status call comes within a second of it,
     * answered, and an order placed meanwhile is delivered and acknowledged. Without the timeout
     * nothing gives up: the held answer goes out at the end of the hold (`answered`, 62 s), and the
     * poll carries on from there. A single held attempt therefore does not fail the poll, only the
     * request; holding the retry too would fail the poll and double the time this costs. Nothing
     * records the timed-out request but the mock: with dmi-engine-common 1.7.0 the logging
     * interceptor reads `err.response.data` on an error that has no response and throws before it
     * records anything (nominal-systems/dmi-engine-common#33 records it, with status 0).
     *
     * The hold is the 60 s timeout and 2 s, as short as lets the timeout win with room to spare, and
     * this test is what it costs the loop. */
    afterEach(expectNothingLeftArmed)

    const HTTP_TIMEOUT_MS = 60_000
    const HOLD_MS = HTTP_TIMEOUT_MS + 2_000

    it('a status poll held past 60 s is given up on at 60 s and asked again, and the orders poll delivers an order placed meanwhile', async () => {
      const payload = payloadFor([KIDNEY_PANEL_CODE], {
        requisitionId: `hrn-v6-held-poll-${randomUUID().slice(0, 8)}`,
      })
      const requisitionId = payload.requisitionId as string
      const since = await lastLoggedSeq()

      const { fault } = await withFault({ key: 'getStatus', fault: 'hold', delayMs: HOLD_MS }, async () => {
        /* The next status call is the orders poll's first, the labOrder feed: nothing else asks for
         * it, and nothing is waiting on the feed for a labResult call to follow one. */
        const taken = await pollUntil(async () => await faultOn('getStatus'), (now) => (now?.hits ?? 0) >= 1, NEGATIVE_WAIT_MS, 250)
        expect({ taken: taken?.hits }).toEqual({ taken: 1 })
        /* Placed while that poll is held: only a later status call can deliver it. */
        const created = expectOk<{ status: string }>(
          await org.api.post('/orders', payload, { autoSubmitOrder: true }),
          'place an order while the orders poll is held',
        )
        expect(created.status).toBe('SUBMITTED')
        await pollUntil(
          async () => await faultOn('getStatus'),
          (now) => now?.requests[0]?.ms != null,
          HOLD_MS + 10_000,
          500,
        )
        await waitForOrderAck(requisitionId)
      })

      /* Given up on by the integration at its timeout, not answered at the end of the hold. */
      const held = fault.requests[0]
      expect(fired(fault)).toEqual({ hits: 1, outcomes: ['client-closed'] })
      expect({
        heldMs: held.ms,
        atTheTimeout: (held.ms ?? 0) >= HTTP_TIMEOUT_MS - 1_000 && (held.ms ?? 0) <= HTTP_TIMEOUT_MS + 1_000,
      }).toEqual({ heldMs: held.ms, atTheTimeout: true })

      /* The held call is the first labOrder status call after the arming, and the one after it, the
       * retry, came within a second of the integration giving up, and was answered. */
      const statusCalls = await loggedCalls('getStatusLabOrder', since)
      const [heldCall, next] = statusCalls
      expect({ held: heldCall?.status ?? null, next: next?.status ?? null }).toEqual({ held: null, next: 200 })
      const gaveUpAt = Date.parse(heldCall.at) + (held.ms ?? 0)
      const askedAgainMs = Date.parse(next.at) - gaveUpAt
      console.log(`[antech-v6-scenario] held status poll given up on after ${held.ms} ms, asked again ${askedAgainMs} ms later`)
      expect({ askedAgainMs, withinASecond: askedAgainMs >= 0 && askedAgainMs <= 1_000 }).toEqual({ askedAgainMs, withinASecond: true })
    }, NEGATIVE_WAIT_MS + HOLD_MS + ORDER_ACK_WAIT_MS + 30_000)
  })

  /* ---- tripwires ----
   *
   * Each asserts the CORRECT behaviour and is marked `failing` while the integration does not have
   * it. That keeps CI green while the defect stands, and turns the test red the moment someone
   * fixes it — at which point the `.failing` marker comes off in the same commit and the test stays
   * on as a plain regression guard. A tripwire that PASSES is a red run: jest reports "Failing test
   * passed even though it was supposed to fail", and the only correct response is to delete the
   * marker, not to relax the assertion.
   *
   * Each comment names the issue that tracks its defect and states the mechanism, so a fix can be
   * matched to its tripwire. */
  describe('tripwires: behaviours the loop should have and does not', () => {
    it.failing('POST /admin/refs/sync/<provider> stores the reference data it fetched', async () => {
      /* EXPECTED: the admin ref sync fetches the provider's species/breeds/sexes (it does — the
       * reference-data test above reads exactly those lists over the same RPC) and upserts them as
       * provider_ref rows, which is the only way a canonical dmi ref becomes mappable to a provider
       * code. ACTUAL: HTTP 400 from the route's own database query, and nothing is stored — for
       * every provider and every ref type, the per-type route included. The RPC to the engine
       * runs and the data comes back; the upsert then fails because the route loads the Provider
       * with `ProvidersService.findOneById`, which decorates the entity with two computed,
       * non-column properties (`integrationOptions`, `configurationOptions`), and
       * `RefsService.syncProviderRefs` passes that whole entity as a relation condition —
       * `findOne({ where: { code, type, provider } })` — which TypeORM expands over the entity's
       * properties and refuses at the first computed one:
       * `Property "integrationOptions" was not found in "Provider"`. Filed as
       * nominal-systems/dmi-api#378.
       *
       * It is why this scenario seeds the provider_ref rows itself, from the catalogue the engine
       * returned, rather than through the route that exists to do it. This test carries no
       * fallback of its own: it reports what the setup observed. */
      expect({
        status: syncResponse.status,
        speciesRefsStoredBySync: speciesRefsAfterSync,
        neededTheDirectSeed: providerRefsWereSeededDirectly,
        body: syncResponse.text.slice(0, 200),
      }).toEqual({
        status: 201,
        speciesRefsStoredBySync: liveSpecies.length,
        neededTheDirectSeed: false,
        body: '',
      })
    })

    it.failing('a provider error on the status poll is recorded in the audit trail', async () => {
      /* EXPECTED: when Antech answers a status poll with an error, the failure is stored as an
       * external request with that status, so an operator can see what the provider said. ACTUAL:
       * no record appears at all.
       *
       * The logging interceptor's rejection path calls its response handler with no filter and no
       * guard, and the handler dereferences `body.LabOrders` / `body.LabResults` — keys an error
       * body does not have. It throws a TypeError before emitting anything, so the provider's own
       * explanation is discarded and the audit record is never written. The success path is safe
       * because the endpoint always returns both keys. Reported in a comment on
       * nominal-systems/dmi-engine-common#29, whose shared interceptor owns the rejection path.
       *
       * Scoped to GetStatus specifically: placement rejections elsewhere in this file DO produce
       * 4xx audit records (their accession-id extraction is guarded), so an unscoped "is there a
       * 4xx?" would pass for the wrong reason. */
      const before = expectOk<{ data: Array<{ url: string, status: number }> }>(
        await admin.get('/admin/external-requests', {
          providers: 'antech-v6',
          integrationId: org.integrationId,
          page: 1,
          limit: 200,
        }),
        'read the audit trail before injecting a status-poll failure',
      ).data.filter((record) => record.url.includes('/LabResults/v6/GetStatus') && record.status >= 400)
      expect(before).toHaveLength(0)

      expectOk(
        await mock.post('/__control__/scenarios', { key: 'getStatus', status: 400, once: true }),
        'arm a one-shot 400 on the next status poll',
      )

      const records = await pollUntil(
        async () =>
          expectOk<{ data: Array<{ url: string, status: number }> }>(
            await admin.get('/admin/external-requests', {
              providers: 'antech-v6',
              integrationId: org.integrationId,
              page: 1,
              limit: 200,
            }),
            'read the audit trail after injecting a status-poll failure',
          ).data.filter((record) => record.url.includes('/LabResults/v6/GetStatus') && record.status >= 400),
        (data) => data.length > 0,
        NEGATIVE_WAIT_MS,
        1_000,
      )
      expect(records.length).toBeGreaterThan(0)
    }, NEGATIVE_WAIT_MS + 60_000)

    it.failing('an order for a patient with no species OR breed mapping is still placeable', async () => {
      /* EXPECTED: a patient whose species and breed both fail dmi-api's ref mapping still produces
       * an order — that is precisely the case the integration's fallback constants exist to serve.
       * ACTUAL: the provider refuses it.
       *
       * The two fallbacks are chosen independently: an unmapped species becomes SpeciesID 49 and an
       * unmapped breed becomes BreedID 370. But 370 is a breed of species 41, and species 49 has
       * exactly one breed, 648 — so the pair is invalid at Antech and the placement is rejected
       * before the order exists. A patient whose species resolves but whose breed does not gets
       * 41 + 370, which IS valid, so this is not every order: it is every order for a fully
       * unmapped patient. Filed as nominal-systems/dmi-engine-antech-v6-integration#88.
       *
       * The mock refuses it from the same species tree the provider publishes, which is why this
       * reproduces rather than merely asserts. The test below pins that the refusal at least
       * reaches the operator legibly. */
      const payload = payloadFor([KIDNEY_PANEL_CODE], {
        patient: patientFor({ species: unmappedSpeciesRefCode, breed: UNMAPPED_BREED }),
      })

      const response = await org.api.post('/orders', payload, { autoSubmitOrder: true })
      console.log(
        `[antech-v6-scenario] unmapped-patient response -> HTTP ${response.status}: ${response.text.slice(0, 300)}`,
      )
      expect(response.ok).toBe(true)
    }, 60_000)

    it('the unmapped-patient refusal reaches the operator with the provider\'s own wording', async () => {
      /* The positive half of the tripwire above, and the reason it is only half-bad: whatever else
       * happens, the operator is told WHY. This is the `.value.Message` envelope, the one placement
       * refusal observed live, and the integration's error mapper reads it, so an operator sees
       * `Invalid BreedId 370` rather than a bare `Failed to POST`. It is also the assertion that
       * would go red first if the ref mapping for species or breed silently stopped resolving for a
       * patient that IS mapped. */
      const payload = payloadFor([KIDNEY_PANEL_CODE], {
        patient: patientFor({ species: unmappedSpeciesRefCode, breed: UNMAPPED_BREED }),
      })

      const response = await org.api.post('/orders', payload, { autoSubmitOrder: true })

      expect(response.ok).toBe(false)
      /* The whole list: the generic line, naming the endpoint, then the provider's wording, and
       * nothing else. The endpoint is worth pinning because the placement path is decided BEFORE
       * the patient is: this order's code is point-of-care and auto-submit was asked for, so the
       * integration went to the real ORDER endpoint and was refused there. The unknown-test-code
       * refusal above names `/LabOrders/v6/PreOrderPlacement` instead — same envelope, different
       * endpoint — because an unknown code is not in the POC set and so routes to the draft path.
       * The pair is what shows the refusal is the provider's, at whichever endpoint it happened.
       * Like that one, this envelope was read before
       * nominal-systems/dmi-engine-antech-v6-integration#86 too, so this pins the list and does
       * not prove that fix. */
      expect(response.body?.errors).toEqual([
        failedPost('/LabOrders/v6/Order'),
        `Invalid BreedId ${DEFAULT_PET_BREED}`,
      ])
    }, 60_000)

    describe('a token Antech stops accepting (nominal-systems/dmi-engine-antech-v6-integration#95)', () => {
      /* The integration caches its token per user and clinic for 12 hours, in each engine process,
       * and `withAuthentication` is its recovery: a call refused with 401 logs in again, refreshes
       * the cache and is retried once. The mock's revocation (its header, load-bearing detail 10)
       * stages a vendor that stops accepting the tokens it has issued while its login keeps working,
       * as Wisdom Panel did on 2026-11-23. The first two tests prove the revocation reaches the
       * integration's calls and that the recovery runs where a 401 reaches it, and does not where
       * the refusal is a 5xx; the tripwire after them is the polls, where the 401 does not reach it.
       *
       * Each test arms the revocation for as long as it needs it and disarms it in a `finally`, and
       * this describe checks after each that nothing is left armed. Disarming makes the revoked
       * tokens good again, so the polls recover whatever the integration did; the tests that follow
       * would otherwise find an engine holding a dead token for 12 hours. */
      afterEach(expectNothingLeftArmed)

      /* Before a revocation, both engine processes must hold a token it will refuse, as they do
       * after any earlier test: the worker once it has answered a poll of each feed, the api
       * process after a placement, which also caches the test guide's point-of-care codes (for an
       * hour). Done here so that the tests do not depend on the ones before them. Run on its own, a
       * test would otherwise arm the revocation before the worker's first login, which then falls
       * after it and is accepted; or place its order with a fresh login, past the revocation; or
       * read the test guide with the refused token, whose 404 the integration takes for a missing
       * guide, so that the order goes to the pre-order endpoint instead. */
      async function warmPlacementPath (before: string): Promise<void> {
        const warm = expectOk<{ status: string }>(
          await org.api.post('/orders', payloadFor([KIDNEY_PANEL_CODE]), { autoSubmitOrder: true }),
          `place an order before ${before}`,
        )
        expect(warm.status).toBe('SUBMITTED')
        const polled = await pollUntil(
          async () =>
            expectOk<{ getStatusLabOrder: number, getAllResults: number }>(
              await mock.get('/__control__/calls'),
              'read the mock call counters',
            ),
          (calls) => calls.getStatusLabOrder >= 1 && calls.getAllResults >= 1,
          ORDER_ACK_WAIT_MS,
          500,
        )
        expect({ ordersPolled: polled.getStatusLabOrder >= 1, resultsPolled: polled.getAllResults >= 1 }).toEqual({
          ordersPolled: true,
          resultsPolled: true,
        })
      }

      it('a revocation refuses the tokens issued before it and accepts those issued after: both polls are refused, a placement logs in again and goes through, and disarmed the polls resume', async () => {
        await warmPlacementPath('the revocation')
        /* A token of this test's own, issued before the revocation. */
        const oldToken = await mintToken()
        const payload = payloadFor([KIDNEY_PANEL_CODE], {
          requisitionId: `hrn-v6-revoked-placement-${randomUUID().slice(0, 8)}`,
        })
        const requisitionId = payload.requisitionId as string

        let revocation: Revocation | null = null
        let polls: Revocation | null = null
        let oldAnswer: { status: number, body: any } = { status: 0, body: null }
        let newAnswer: { status: number, body: any } = { status: 0, body: null }
        let placed: ApiResponse | undefined
        try {
          const armed = await armRevocation()
          /* At least the worker's, the api process's and this test's. */
          expect(armed.revokedTokens).toBeGreaterThanOrEqual(3)

          /* The worker's next ticks meet it on both feeds the polls read. */
          polls = await pollUntil(
            revocationNow,
            (now) => (now?.refused.getStatusLabOrder ?? 0) >= 1 && (now?.refused.getAllResults ?? 0) >= 1,
            NEGATIVE_WAIT_MS,
            500,
          )

          /* The old token is refused, in the envelope the mock answers a token it does not take
           * with; a token from a login made now is accepted. */
          oldAnswer = await labOrderFeedWith(oldToken)
          newAnswer = await labOrderFeedWith(await mintToken())

          /* A placement: the api process's cached token is refused with a 401 that reaches the
           * integration whole (the placement's accession-id extractor reads the request, not the
           * error body), so `withAuthentication` logs in again and the order goes through. */
          placed = await org.api.post('/orders', payload, { autoSubmitOrder: true })
          revocation = await disarmRevocation()
        } finally {
          await disarmRevocation()
        }

        expect({
          labOrderFeedRefused: (polls?.refused.getStatusLabOrder ?? 0) >= 1,
          resultsFeedRefused: (polls?.refused.getAllResults ?? 0) >= 1,
          refused: polls?.refused,
        }).toEqual({ labOrderFeedRefused: true, resultsFeedRefused: true, refused: polls?.refused })
        expect(oldAnswer).toEqual({
          status: 401,
          body: {
            type: 'https://www.rfc-editor.org/rfc/rfc9110.html#status.401',
            message: 'Access token is invalid.',
            status: 401,
            errorDetails: {},
            isSuccess: false,
            requestId: expect.any(String),
          },
        })
        expect({ status: newAnswer.status, keys: Object.keys(newAnswer.body ?? {}).sort() }).toEqual({
          status: 200,
          keys: ['LabOrders', 'LabResults'],
        })

        expect({ httpStatus: placed?.status, status: placed?.body?.status, errors: placed?.body?.errors }).toEqual({
          httpStatus: 201,
          status: 'SUBMITTED',
          errors: undefined,
        })
        /* Refused once, then placed: the only way past the refusal is a token issued after it. And
         * at least two logins in the window, this test's own and the api process's. */
        expect({ placementRefused: revocation?.refused.orderPlacement, loggedIn: (revocation?.logins ?? 0) >= 2 }).toEqual({
          placementRefused: 1,
          loggedIn: true,
        })
        expect((await mockOrder(requisitionId)).kind).toBe('order')

        /* Disarmed, the polls run again: the order placed in the window is acknowledged. */
        await waitForOrderAck(requisitionId)
      }, NEGATIVE_WAIT_MS + ORDER_ACK_WAIT_MS + 30_000)

      it('a revocation answered 500 is not taken for a stale token: nothing logs in again, and the placement fails with the provider\'s wording', async () => {
        /* The status is the revocation's parameter. `withAuthentication` logs in again on a 401 only,
         * which is what keeps a provider outage answered 5xx from doubling into a login per call
         * (the same guard nominal-systems/dmi-engine-wisdom-panel-integration#53 asks for). On the
         * polls a 5xx is retried once, 100 ms later, and the poll fails; at placement, which is not
         * retried, the provider's wording reaches the operator. */
        await warmPlacementPath('the 500 revocation')
        const payload = payloadFor([KIDNEY_PANEL_CODE], {
          requisitionId: `hrn-v6-revoked-500-${randomUUID().slice(0, 8)}`,
        })
        const requisitionId = payload.requisitionId as string

        let revocation: Revocation | null = null
        let placed: ApiResponse | undefined
        try {
          await armRevocation(500)
          placed = await org.api.post('/orders', payload, { autoSubmitOrder: true })
          console.log(
            `[antech-v6-scenario] placement under a 500 revocation -> HTTP ${placed.status}: ${placed.text.slice(0, 300)}`,
          )
          /* And the polls meet it too, so that "no login" covers them as well. */
          await pollUntil(
            revocationNow,
            (now) => (now?.refused.getStatusLabOrder ?? 0) >= 1 && (now?.refused.getAllResults ?? 0) >= 1,
            NEGATIVE_WAIT_MS,
            500,
          )
          revocation = await disarmRevocation()
        } finally {
          await disarmRevocation()
        }

        expect({ ok: placed?.ok, errors: placed?.body?.errors }).toEqual({
          ok: false,
          errors: [failedPost('/LabOrders/v6/Order'), 'Access token is invalid.'],
        })
        expect({
          status: revocation?.status,
          placementRefused: revocation?.refused.orderPlacement,
          labOrderFeedRefused: (revocation?.refused.getStatusLabOrder ?? 0) >= 1,
          resultsFeedRefused: (revocation?.refused.getAllResults ?? 0) >= 1,
          logins: revocation?.logins,
        }).toEqual({ status: 500, placementRefused: 1, labOrderFeedRefused: true, resultsFeedRefused: true, logins: 0 })
        /* The provider never took the order. */
        expect((await mock.get(`/__control__/orders/${encodeURIComponent(requisitionId)}`)).status).toBe(404)
      }, NEGATIVE_WAIT_MS + 30_000)

      it.failing('the integration logs in again when Antech stops accepting its token, and both polls deliver again', async () => {
        /* EXPECTED: when Antech refuses the cached token with a 401, the next orders poll and the
         * next results poll recover as a placement does: each refused poll logs in again, the new
         * token is cached, and the records waiting on each feed are delivered — a draft the clinic
         * completed reaches dmi-api as SUBMITTED, and a result as a FINAL report. ACTUAL: no poll
         * logs in again, and nothing is delivered for as long as the token stays refused (up to the
         * cache's 12 hours).
         *
         * HOW MANY LOGINS: one or two, one per refused poll. The orders and the results poll are two
         * Bull queues whose repeat jobs fall on the same instants (Bull 4 schedules an `every` job at
         * the next multiple of the interval since the epoch), so both read the cached token before
         * either has replaced it, both are refused, and each logs in: two logins in the same second,
         * one per poll, measured against dmi-engine-common `main`, where the polls do recover. That
         * is the recovery working, not the defect. What the upper bound still catches is a token
         * that is not cached: a login on every tick. So the test watches two more orders polls after
         * both deliveries, which would bring such an integration to at least four. Nothing else logs
         * in while the revocation is armed here: this test places its two orders before arming it,
         * so the api process makes no call in the window, and the scenario logs in to the mock
         * itself only in the tests above.
         *
         * WHY: on the polls the 401 never reaches `withAuthentication`. With the dmi-engine-common
         * that dmi-engine resolves (1.7.0), the logging interceptor hands the error body to the
         * integration's `extractAccessionIds`, which dereferences `body.LabOrders` /
         * `body.LabResults` on GetStatus and calls `body.map` on GetAllResults; on an error body
         * that throws a TypeError, which has no response, so `BaseApiService` retries it as a
         * network failure and then throws a 500, and `isUnauthorized` sees 500. The first test above
         * is the positive twin: the same revocation, a 401 that reaches the recovery at placement,
         * and a login. Filed as nominal-systems/dmi-engine-antech-v6-integration#95; its fix is
         * expected from a dmi-engine-common release carrying nominal-systems/dmi-engine-common#33,
         * which passes the provider's error through, so this should flip with the dmi-engine
         * lockfile bump to it.
         *
         * Two records wait for the recovery, one per feed, so a recovery of one poll alone is not
         * enough: a draft placed before the revocation and completed after it (the orders channel,
         * which is the only one that can move it to SUBMITTED), and an order acknowledged before it
         * whose result is seeded after it (the results channel, the only one that writes a report
         * FINAL). */
        const resultOrder = await placeAcknowledgedOrder('revoked token result')
        const draftPayload = payloadFor([referenceLabCode], {
          requisitionId: `hrn-v6-revoked-token-draft-${randomUUID().slice(0, 8)}`,
        })
        const draftRequisitionId = draftPayload.requisitionId as string
        const draft = expectOk<{ id: string, status: string }>(
          await org.api.post('/orders', draftPayload, { autoSubmitOrder: true }),
          'place the reference-lab draft for the orders feed',
        )
        expect(draft.status).toBe('WAITING_FOR_INPUT')

        let revocation: Revocation | null = null
        let draftStatus: unknown
        let reportStatus: unknown
        try {
          await armRevocation()
          expectOk(
            await mock.post(`/__control__/orders/${encodeURIComponent(draftRequisitionId)}/promote`, {}),
            'complete the draft at the provider',
          )
          expectOk(
            await mock.post(`/__control__/orders/${encodeURIComponent(resultOrder.requisitionId)}/results`, {
              unitCodeResults: [{ orderCode: KIDNEY_PANEL_CODE, testCodeResults: KIDNEY_PANEL }],
              pendingTestCount: 0,
              totalTestCount: 1,
            }),
            'seed the result for the results feed',
          )

          const relogin = await pollUntil(revocationNow, (now) => (now?.logins ?? 0) >= 1, NEGATIVE_WAIT_MS, 1_000)
          expect({ loggedInAgain: (relogin?.logins ?? 0) >= 1, refused: relogin?.refused }).toEqual({
            loggedInAgain: true,
            refused: relogin?.refused,
          })

          draftStatus = (
            await pollUntil(
              async () => await org.api.get(`/orders/${draft.id}`),
              (response) => response.body?.status === 'SUBMITTED',
              COMPLETION_WAIT_MS,
              1_000,
            )
          ).body?.status
          reportStatus = (
            await pollUntil(
              async () => await org.api.get(`/orders/${resultOrder.orderId}/report`),
              (response) => response.body?.status === 'FINAL',
              COMPLETION_WAIT_MS,
              1_000,
            )
          ).body?.status
          /* Two more orders polls answered, with the revocation still armed. */
          const ordersPolls = async (): Promise<number> =>
            expectOk<{ getStatusLabOrder: number }>(await mock.get('/__control__/calls'), 'read the mock call counters')
              .getStatusLabOrder
          const pollsAfter = await ordersPolls()
          await pollUntil(ordersPolls, (polls) => polls >= pollsAfter + 2, NEGATIVE_WAIT_MS, 500)
          revocation = await disarmRevocation()
        } finally {
          await disarmRevocation()
        }

        expect({ draft: draftStatus, report: reportStatus }).toEqual({ draft: 'SUBMITTED', report: 'FINAL' })
        const logins = revocation?.logins ?? 0
        expect({
          labOrderFeedRefused: (revocation?.refused.getStatusLabOrder ?? 0) >= 1,
          resultsFeedRefused: (revocation?.refused.getAllResults ?? 0) >= 1,
          oneOrTwoLogins: logins >= 1 && logins <= 2,
          logins,
        }).toEqual({ labOrderFeedRefused: true, resultsFeedRefused: true, oneOrTwoLogins: true, logins })
      }, ORDER_ACK_WAIT_MS + NEGATIVE_WAIT_MS * 2 + COMPLETION_WAIT_MS * 2 + 30_000)
    })

    describe('a placement that outlasts dmi-api\'s wait for the engine (nominal-systems/dmi-api#365)', () => {
      /* dmi-api waits ENGINE_RESPONSE_TIMEOUT for the engine's answer to an order (10 s here,
       * src/env.ts) and then records the order ERROR; nothing stops the engine, whose call to Antech
       * may still succeed. A `hold` on the order endpoint stages that: the mock records the order on
       * arrival, as Antech would, and answers it later. The hold stays well inside the integration's
       * own 60 s HTTP timeout, so its answer reaches the integration, and each test waits for that
       * answer to go out before it disarms the fault, because disarming destroys a held connection
       * (src/mock-faults). The orders carry no requisitionId, the case the issue describes: the
       * integration then mints the ClinicAccessionID, so dmi-api has no id the provider knows until
       * the engine answers. Each order is for a pet of its own name, which is how the test finds it
       * at the mock and in dmi-api. */
      afterEach(expectNothingLeftArmed)

      const engineTimeoutMs = Number(appEnv().ENGINE_RESPONSE_TIMEOUT)
      const HTTP_TIMEOUT_MS = 60_000
      /* Answered well before dmi-api gives up, and well after it has. */
      const HOLD_UNDER_MS = 3_000
      const HOLD_PAST_MS = engineTimeoutMs + 3_000

      /* A placement with no requisitionId, for a pet named `name`. */
      function placementFor (name: string): Record<string, unknown> {
        const payload = payloadFor([KIDNEY_PANEL_CODE], { patient: patientFor({ name }) })
        delete payload.requisitionId
        return payload
      }

      /* Letters only, which the integration's name rule passes as they are. */
      function petName (prefix: string): string {
        return prefix + randomUUID().replace(/[^a-f]/g, '').slice(0, 8)
      }

      async function atAntechFor (name: string): Promise<MockOrder[]> {
        return expectOk<{ orders: MockOrder[] }>(await mock.get('/__control__/orders'), 'list the mock orders')
          .orders.filter((order) => order.petName === name)
      }

      async function dmiOrdersFor (name: string): Promise<Array<{ status: string, externalId: string | null }>> {
        return expectOk<Array<{ status: string, externalId: string | null, patient?: { name?: string } }>>(
          await org.api.get('/orders'),
          'list the organization\'s orders',
        )
          .filter((order) => order.patient?.name === name)
          .map((order) => ({ status: order.status, externalId: order.externalId ?? null }))
      }

      it('a placement held under the engine timeout is answered late and placed: SUBMITTED, with the id the provider has', async () => {
        /* The positive twin of the tripwire below: the hold path is live, the held answer reaches the
         * integration and dmi-api, and the order is found at both ends by its pet's name. */
        const name = petName('Heldtwin')
        const startedAt = Date.now()
        const { result: response, fault } = await withFault(
          { key: 'placeOrder', fault: 'hold', delayMs: HOLD_UNDER_MS },
          async () => await org.api.post('/orders', placementFor(name), { autoSubmitOrder: true }),
        )
        const tookMs = Date.now() - startedAt

        expect(fired(fault)).toEqual({ hits: 1, outcomes: ['answered'] })
        const atAntech = await atAntechFor(name)
        expect(atAntech.map((order) => order.kind)).toEqual(['order'])
        expect({
          httpStatus: response.status,
          status: response.body?.status,
          externalId: response.body?.externalId,
          waitedForTheHold: tookMs >= HOLD_UNDER_MS,
        }).toEqual({ httpStatus: 201, status: 'SUBMITTED', externalId: atAntech[0].clinicAccessionId, waitedForTheHold: true })
        expect(await dmiOrdersFor(name)).toEqual([{ status: 'SUBMITTED', externalId: atAntech[0].clinicAccessionId }])
      }, HOLD_UNDER_MS + 30_000)

      it.failing('an order the provider created after dmi-api stopped waiting ends with the provider\'s id and SUBMITTED, never a bare ERROR', async () => {
        /* EXPECTED (nominal-systems/dmi-api#365's acceptance criteria): an engine RPC that times out
         * while the provider does create the order leaves dmi-api with the provider's order id on it
         * and the order in a correct state, never a bare ERROR with no ids; the provider holds one
         * order, so dmi-api holds one, SUBMITTED, as the provider has it. ACTUAL: dmi-api answers the
         * placement 504 and records the order ERROR with no external id; the engine's late answer is
         * discarded, and the provider's order reaches dmi-api only through the orders poll, which
         * cannot match it to an order with no id and records it as an order of its own.
         *
         * Held for the engine timeout and 3 s, then answered; the test waits for the answer to go out
         * before it disarms (disarming would destroy it), and then gives dmi-api a few polls to put
         * things right. The test before this one is its positive twin. */
        if (HOLD_PAST_MS >= HTTP_TIMEOUT_MS) {
          throw new Error(`ENGINE_RESPONSE_TIMEOUT (${engineTimeoutMs} ms) leaves no room for a hold the integration outwaits`)
        }
        const name = petName('Heldtrip')
        const { result: response } = await withFault(
          { key: 'placeOrder', fault: 'hold', delayMs: HOLD_PAST_MS },
          async () => {
            const placed = await org.api.post('/orders', placementFor(name), { autoSubmitOrder: true })
            console.log(`[antech-v6-scenario] placement held past the engine timeout -> HTTP ${placed.status}: ${placed.text.slice(0, 300)}`)
            await pollUntil(
              async () => await faultOn('placeOrder'),
              (now) => now?.requests[0]?.outcome === 'answered',
              HOLD_PAST_MS + 10_000,
              250,
            )
            return placed
          },
        )
        const atAntech = await atAntechFor(name)
        expect(atAntech.map((order) => order.kind)).toEqual(['order'])
        const expected = [{ status: 'SUBMITTED', externalId: atAntech[0].clinicAccessionId }]
        const stored = await pollUntil(
          async () => await dmiOrdersFor(name),
          (orders) => JSON.stringify(orders) === JSON.stringify(expected),
          NEGATIVE_WAIT_MS,
          1_000,
        )
        console.log(`[antech-v6-scenario] dmi orders for the held placement (POST answered ${response.status}): ${JSON.stringify(stored)}`)
        expect(stored).toEqual(expected)
      }, HOLD_PAST_MS + NEGATIVE_WAIT_MS + 40_000)
    })
  })

  /* ---- dmi-engine#68 guard ----
   *
   * The engine initializes each of its Bull queues at start, against Redis. Before dmi-engine#68 a
   * queue that could not be initialized was logged as a warning and the engine started anyway, with
   * no queue that could ever receive its repeatable jobs: polling silently dead, the pod Ready.
   * Since, the engine names every queue it could not initialize and exits with code 1, so the pod
   * crash-loops where it shows; docker-compose.yml's `restart: on-failure` on the engine services
   * relies on that exit. Here the worker (the process that polls) is restarted while Redis is
   * stopped, so that it starts with Redis unreachable; then Redis comes back, and the restart policy
   * must bring the worker back polling.
   *
   * Last in the file: it takes the engine down, and nothing after it should run on a stack that may
   * not have recovered. The fault comes from src/services.ts, scoped to this slot's compose project,
   * restored in the test's `finally` and again by `afterEach`. */
  describe('an engine that cannot reach Redis when it starts exits, and recovers when Redis is back (dmi-engine#68)', () => {
    const WORKER = 'dmi-engine-worker'
    const QUEUES = ['antech-v6.results', 'antech-v6.orders', 'wisdom-panel.results', 'wisdom-panel.orders']

    beforeAll(async () => {
      /* A run starts with nothing stopped or paused, by this harness or anything else. */
      await assertStackWhole()
    })

    afterEach(async () => {
      await restoreServices()
    }, 180_000)

    it('the worker started with Redis stopped exits with code 1, naming every queue, and polls again once Redis is back', async () => {
      const faults = serviceFaults()
      const since = Date.now()
      const watch = await watchExits(WORKER)
      let exits: number[] = []
      try {
        await faults.stop(REDIS)
        /* Killed a second after its SIGTERM: the engine, its container's pid 1, does not exit on
         * one, and compose would otherwise wait out its 10 s before killing it. */
        await faults.restart(WORKER, 1)
        /* That kill is an exit too (137); the one that matters is the worker's own, once it has
         * tried every queue (four, each given up on after the engine's 10 s Redis command timeout). */
        exits = await pollUntil(async () => [...watch.codes], (codes) => codes.includes(1), 90_000, 1_000)
      } finally {
        watch.stop()
        await faults.restore(REDIS)
      }
      const logs = await serviceLogs(WORKER, since)
      console.log(`[antech-v6-scenario] worker exits since the restart -> ${JSON.stringify(exits)}`)

      /* THE POINT OF THIS TEST: the worker exited with code 1. The engine before dmi-engine#68 logs
       * the same line for each queue, as a warning, and then starts: only the exit tells the two
       * apart. */
      expect(exits).toContain(1)
      expect(QUEUES.filter((queue) => !logs.includes(`Failed to initialize queue '${queue}'`))).toEqual([])

      /* Recovered: the restart policy brings the worker back now that Redis is there, and the loop
       * closes again. An order placed now is acknowledged by the orders poll and completed by a
       * result seeded after that, and both polls run in the worker. */
      expect(await waitForEveryServiceRunning(120_000)).toEqual([])
      const payload = payloadFor([KIDNEY_PANEL_CODE])
      const requisitionId = payload.requisitionId as string
      const created = expectOk<{ id: string, status: string }>(
        await org.api.post('/orders', payload, { autoSubmitOrder: true }),
        'place an antech-v6 order after the worker recovered',
      )
      expect(created.status).toBe('SUBMITTED')
      await waitForOrderAck(requisitionId)
      expectOk(
        await mock.post(`/__control__/orders/${encodeURIComponent(requisitionId)}/results`, {
          unitCodeResults: [{ orderCode: KIDNEY_PANEL_CODE, testCodeResults: KIDNEY_PANEL }],
          pendingTestCount: 0,
          totalTestCount: 1,
        }),
        'seed a result after the worker recovered',
      )
      const report = await pollUntil(
        async () => await org.api.get(`/orders/${created.id}/report`),
        (response) => response.body?.status === 'FINAL',
        COMPLETION_WAIT_MS,
        1_000,
      )
      expect(report.body.status).toBe('FINAL')
    }, 30_000 + 90_000 + 180_000 + ORDER_ACK_WAIT_MS + COMPLETION_WAIT_MS + 30_000)
  })
})
