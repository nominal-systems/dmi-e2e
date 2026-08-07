import { ApiClient, expectOk } from '../src/api-client'
import { env } from '../src/env'
import { pollUntil } from '../src/poll'
import { adminLogin, orderPayload, seedOrganization, SeededOrg } from '../src/seed'
import { closePool } from '../src/sql'

/* Phase 1 full-system gate for Zoetis (HARNESS_FULL_STACK=1, HARNESS_STACK=zoetis): dmi-api under a
 * NORMAL NODE_ENV, wired over real MQTT/Bull/HTTP to the REAL `dmi-engine-zoetis-integration`
 * container (provider id `zoetis`) and a Zoetis mock vendor (src/zoetis-mock). It drives the whole
 * loop as an integrator would — configure the zoetis provider pointed at the mock, create an
 * integration, start it, place an order over HTTP, let the mock produce a result, and watch the
 * order->result->report loop close — with every hop real except the vendor, which is the mock so the
 * run is deterministic and never touches a live Zoetis host.
 *
 * The order flows: POST /orders -> dmi-api RPCs `zoetis/orders/create` to the integration -> the
 * integration builds a <LabReport> request document and POSTs it, once, to
 * `{baseUrl}/vetsync/v1/orders` under HTTP Basic -> the mock answers with the order-status document,
 * whose `client_order_id` the integration assigns as BOTH the requisitionId and the externalId. Then
 * two Bull jobs tick every 30s: the results poll reads /orders/batch/results and, once a test seeds a
 * result there, emits `external_results` (-> report) and `external_order_results` (-> order
 * COMPLETED) before acking the batch; the orders poll reads /orders, fetches each order's status and
 * results, emits `external_orders`, and acks each order individually.
 *
 * Note that BOTH channels can move the order to COMPLETED, and that matters when reading the
 * assertions below. Seeding a result flips the mock's own order status, which the orders poll then
 * reports through `external_orders` independently of the results poll — so a COMPLETED order is not
 * by itself evidence that a result reconciled. Only the report reaching FINAL is. See the completion
 * test for the full argument.
 *
 * How this differs from the other two loops, all verified against the integration's source:
 *   - Everything is XML, in both directions, and the integration parses it with xmlbuilder2's object
 *     format — so element MULTIPLICITY is load-bearing in several places. See the header of
 *     src/zoetis-mock/server.js for the full list; the mock is built to satisfy all of them.
 *   - Placement is a SINGLE POST. There is no login step (antech) and no confirmOrder browser
 *     handshake (idexx), so the order is SUBMITTED the moment it lands.
 *   - Auth is HTTP Basic with a domain-style username, `<partnerId>\<clientId>` — joining a provider
 *     CONFIGURATION field to an INTEGRATION option. The mock accepts any credential VALUES (they are
 *     dummy by design) but requires them PRESENT and requires that join to have happened.
 *   - There are TWO acknowledge channels, and both are asserted below: results ack as a batch, orders
 *     ack one at a time by POSTing to the `href` the order-status document advertises.
 *   - The poll interval is hardcoded to 30s in the integration and is NOT env-tunable (idexx exposes
 *     IDEXX_*_POLLING_INTERVAL_MS), exactly as with antech — so the waits below budget whole
 *     intervals. A slow pass here is the poll cadence, not a hang.
 *
 * RECONCILIATION IS A THIRD CASE, and it is worth stating because copying either of the other two
 * scenarios would be wrong. dmi-api's `ProviderResultUtils.isMatchingOrder` compares
 * `pims:patient:id` across the order it holds and the order the integration extracts FROM A RESULT,
 * and rejects the match when only one side carries one. idexx must therefore SUPPLY the identifier
 * (dmi-api#334) and antech must OMIT it (its mapper tags `antech:pet:id`). Zoetis reaches that guard
 * at all: `ZoetisMapper.mapLabReport` attaches no `.order` to a result, so results always take
 * dmi-api's externalId path and `isMatchingOrder` is never consulted. Reconciliation is therefore
 * purely `PracticeRef == client_order_id == externalId == requisitionId`. Carrying a patient
 * identifier is a free choice; this scenario omits one, mirroring antech, to keep the order minimal.
 *
 * A note on the mock, because it is what makes these assertions worth anything: it VALIDATES the
 * order it receives rather than defaulting the missing bits, and it enforces its own catalogues for
 * the test code, the species and the gender. A mock that substituted its own values would make the
 * forwarding assertions below pass against its own invention. */

/* The integration's Bull jobs repeat every 30s (hardcoded). A result seeded just after a tick waits a
 * full interval, and the job is only scheduled once the integration has handled the start event — so
 * allow three intervals plus slack before calling the loop broken. */
const COMPLETION_WAIT_MS = 120_000

/* The orders channel acks on its own 30s cadence, independently of the results channel, and only
 * re-reports an order once its status has actually changed — so the COMPLETED acknowledgement can be
 * up to a full interval behind completion itself. */
const ORDER_ACK_WAIT_MS = 90_000

/* The analytes the mock reports on. Genuine Zoetis analyte codes; the values, units and ranges
 * attached to them are invented. The last two exist only to be FILTERED OUT — the mapper drops any
 * code ending `_IMG64` or `_HIST_DATA` — so the report must contain the first four and neither of
 * the last two. */
const GLUCOSE = 'GLU'
const CREATININE = 'CRE'
const ALT = 'ALT'
const ALBUMIN = 'ALB'
const HISTOGRAM_IMAGE = 'GLU_HIST_IMG64'
const HISTOGRAM_DATA = 'GLU_HIST_DATA'

/* The two order fields that go through a real dmi-api ref-mapping transformation on their way to the
 * vendor, expressed as (canonical dmi ref name -> the zoetis code it must arrive as).
 *
 * This pairing is the whole point of the mapping assertions below. dmi-api's canonical ref codes are
 * opaque UUIDs, so the scenario looks each one up BY NAME over `GET /refs/*` (rather than hard-coding
 * a UUID that would rot silently) and sends that as the order's species/sex. What must come out the
 * other end is the zoetis vocabulary — `DOG`, `MALE_NEUTERED` — and those are pinned as literals
 * here, because they are also what the mock's /species and /genders endpoints advertise.
 *
 * Input and expected output are deliberately DIFFERENT strings. If dmi-api's zoetis provider_ref
 * rows stopped resolving, `mapPatientRefs` falls back to passing the raw value through, the vendor
 * would receive a UUID, and the mock — which enforces its own vocabulary — rejects the order at
 * placement. That is a loud red at the first test, which is exactly what a silent mapping regression
 * should produce. Picking a species/sex whose dmi and zoetis codes happen to be spelled the same
 * (e.g. sending `DOG` directly, which also resolves) would make these assertions unfalsifiable. */
const SPECIES_REF_NAME = 'Canis familiaris'
const EXPECTED_ZOETIS_SPECIES = 'DOG'
const SEX_REF_NAME = 'Male Sterilized'
const EXPECTED_ZOETIS_GENDER = 'MALE_NEUTERED'

/* Breed is NOT ref-mapped for zoetis and this value is chosen to make that explicit rather than to
 * hide it: dmi-api seeds 1307 zoetis breed provider_ref rows but every one of them has a NULL code
 * (the integration's getBreeds is a no-op — Zoetis publishes no breed catalogue), so nothing here can
 * resolve to a vendor code. A plain descriptive string therefore passes through verbatim, and
 * asserting it at the mock tests FORWARDING, which is the only thing there is to test for this field.
 * Deliberately not a dmi breed ref code: that would resolve to NULL and strip the breed entirely. */
const BREED = 'Labrador Retriever'

interface RefItem { code: string, name: string }

/* Resolve a canonical dmi ref code by its human-readable name. Throws loudly rather than returning
 * undefined: if the seed data ever stops carrying this ref, the scenario must fail at setup with a
 * message that says so, not place an order with `undefined` and fail somewhere confusing. */
function refCodeByName (items: RefItem[], name: string, kind: string): string {
  const matches = items.filter((item) => item.name === name)
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one dmi ${kind} ref named '${name}', found ${matches.length}. ` +
        'dmi-api\'s ref seed data has changed; pick another ref whose zoetis code differs from its own.',
    )
  }
  return matches[0].code
}

describe('zoetis full-stack (Zoetis mock)', () => {
  let org: SeededOrg
  let admin: ApiClient
  let orderId: string
  let externalId: string
  let requisitionId: string
  let reportId: string
  /* The test code the order is placed with, read from the mock's own service catalogue rather than
   * hard-coded here. Zoetis codes are short mnemonics (CDP, HEM, T4); the mock rejects anything
   * outside its catalogue, so sourcing it from there keeps the two from drifting apart. */
  let serviceCode: string
  /* The canonical dmi ref codes the order is placed with — resolved at setup, see the note above. */
  let speciesRefCode: string
  let sexRefCode: string
  /* Highest event seq observed before the result is seeded, so the /events assertion can prove which
   * events the RESULT loop produced rather than counting ones order creation already emitted. */
  let seqBeforeSeed = 0
  /* Client for the mock's host-facing control plane (/__control__/*, /status). */
  const mock = ApiClient.create(env.zoetis.mockBaseUrl)

  /* Place an order the same way the headline test does, for the "second time" scenarios below that
   * each need their own. Every one of them gets a FRESH order rather than reusing the first: they
   * assert on report content and acknowledge state, and sharing an order would make one test's
   * amendment another's flake. `requisitionId` is unique per call (seed.orderPayload), which is what
   * keeps them independent all the way down to the mock's own keying. */
  async function placeOrder (): Promise<{ orderId: string, requisitionId: string }> {
    const payload = orderPayload(org.integrationId, {
      patient: { name: 'Rex', sex: sexRefCode, species: speciesRefCode, breed: BREED },
      testCodes: [{ code: serviceCode }],
    })
    const created = expectOk<{ id: string }>(
      await org.api.post('/orders', payload),
      'place zoetis order',
    )
    return { orderId: created.id, requisitionId: payload.requisitionId as string }
  }

  /* Read the observations of an order's report, flattened across its panels. Returns [] when the
   * report has no test results yet, so a caller can poll on it. */
  async function observationsFor (id: string): Promise<Array<{
    code: string
    valueQuantity?: { value: number, units?: string | null } | null
  }>> {
    const response = await org.api.get(`/orders/${id}/report`)
    const panels = (response.body?.testResultsSet ?? []) as Array<{ observations?: any[] }>
    return panels.flatMap((panel) => panel.observations ?? [])
  }

  beforeAll(async () => {
    /* A fresh container starts clean; reset is only load-bearing for warm reruns (HARNESS_KEEP_UP),
     * where it clears the previous run's orders/results. Harmless on a cold start. */
    await mock.post('/__control__/reset').catch(() => undefined)

    const catalogue = expectOk<{ defaultCode: string, services: Array<{ code: string }> }>(
      await mock.get('/__control__/services'),
      'read the mock service catalogue',
    )
    serviceCode = catalogue.defaultCode

    const root = ApiClient.create()
    /* Quickstart bootstrap: org -> zoetis provider config whose baseUrl points at the mock's
     * compose-network URL -> integration carrying the (dummy) FUSE client id. dmi-api validates
     * these at runtime against the provider_option rows its migrations seed: baseUrl, partnerId and
     * partnerPassword are required CONFIGURATION options and clientId a required INTEGRATION option.
     * All four are declared `string` — unlike antech, zoetis has no integer-typed option to trip
     * over. The split is not cosmetic: the integration joins partnerId and clientId into the HTTP
     * Basic username, so a config that lost either half would fail to authenticate. */
    org = await seedOrganization(root, 'zoetis', {
      providerId: 'zoetis',
      configuration: {
        baseUrl: env.zoetis.baseUrl,
        partnerId: env.zoetis.partnerId,
        partnerPassword: env.zoetis.partnerPassword,
      },
      integrationOptions: {
        clientId: env.zoetis.clientId,
      },
    })

    /* Resolve the canonical ref codes the order will carry, over HTTP with the org's own API key —
     * the same route an integrator would use to discover them. */
    const species = expectOk<{ items: RefItem[] }>(await org.api.get('/refs/species'), 'list dmi species refs')
    const sexes = expectOk<{ items: RefItem[] }>(await org.api.get('/refs/sexes'), 'list dmi sex refs')
    speciesRefCode = refCodeByName(species.items, SPECIES_REF_NAME, 'species')
    sexRefCode = refCodeByName(sexes.items, SEX_REF_NAME, 'sex')

    /* Start the integration so it schedules its Bull results/orders polling. dmi-api's admin start
     * emits `zoetis/integration/create` to the engine, which the integration handles by adding the
     * repeatable jobs, then flips the integration to RUNNING. We log the outcome but tolerate a
     * non-2xx here rather than asserting it — the real proof that polling started is the result flow
     * closing the loop below. */
    admin = await adminLogin(root)
    const startResponse = await admin.post(`/admin/integrations/${org.integrationId}/start`)
    console.log(
      `[zoetis-scenario] integration start -> HTTP ${startResponse.status}: ${startResponse.text.slice(0, 200)}`,
    )
  }, 120_000)

  afterAll(async () => {
    /* Stop this integration so its Bull polling jobs are removed. The jobs live in the integration
     * container's Redis, which survives between runs when HARNESS_KEEP_UP=1; leaving them scheduled
     * would let a prior run's integration keep polling the shared mock and race a later run for its
     * results. Best-effort — a normal (down -v) teardown wipes Redis anyway. */
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

    it('the Zoetis mock is reachable', async () => {
      const response = await mock.get('/status')

      expect(response.status).toBe(200)
      expect(response.body.status).toBe('ok')
      expect(response.body.service).toBe('zoetis-mock')
    })

    it('the quickstart bootstrap completed (org, zoetis provider config, integration)', () => {
      expect(org.organizationId).toBeTruthy()
      expect(org.providerConfigurationId).toBeTruthy()
      expect(org.integrationId).toBeTruthy()
    })

    it('the dmi refs the order will be placed with resolve, and are not already the zoetis codes', () => {
      /* Guards the falsifiability of the mapping assertions below. If either canonical code were
       * spelled the same as the zoetis code it maps to, "the mock received DOG" would be equally true
       * of a working mapping and of no mapping at all. */
      expect(speciesRefCode).toBeTruthy()
      expect(sexRefCode).toBeTruthy()
      expect(speciesRefCode).not.toBe(EXPECTED_ZOETIS_SPECIES)
      expect(sexRefCode).not.toBe(EXPECTED_ZOETIS_GENDER)
    })
  })

  describe('an order round-trips through the real integration and the mock, and the loop closes', () => {
    it('POST /orders creates the order via the real zoetis integration (externalId assigned)', async () => {
      /* Deliberately NO `pims:patient:id` identifier — see the reconciliation note in the file
       * header. For zoetis it is a free choice rather than a workaround, because its results never
       * reach dmi-api's patient-matching guard; omitting it keeps the order minimal.
       *
       * species/sex are canonical dmi ref codes, NOT vendor codes: dmi-api maps them to the zoetis
       * vocabulary on the way to the engine, and the next test asserts the mapped values arrived.
       *
       * autoSubmitOrder is not passed: it drives idexx's confirmOrder handshake, and zoetis placement
       * is a single POST with no equivalent. */
      const payload = orderPayload(org.integrationId, {
        patient: { name: 'Rex', sex: sexRefCode, species: speciesRefCode, breed: BREED },
        /* testCodes is required (orderPayload does not default it — a shared default is wrong for
         * every provider but the one it was written for). Pass a real Zoetis code read from the
         * mock's catalogue; the mock enforces that catalogue and rejects anything outside it. */
        testCodes: [{ code: serviceCode }],
      })
      requisitionId = payload.requisitionId as string

      /* dmi-api sends this as an RPC and awaits the integration's reply, so a created order (not a
       * 5xx) confirms the create RPC round-tripped end to end: one authenticated POST to the mock and
       * a parsed order-status document back. */
      const created = expectOk<{ id: string, externalId: string, status: string }>(
        await org.api.post('/orders', payload),
        'place zoetis order',
      )
      orderId = created.id
      externalId = created.externalId

      expect(orderId).toBeTruthy()
      /* getOrderFromZoetisOrderResponse assigns the order-status document's `client_order_id` as both
       * the requisitionId and the externalId, and the mock echoes back the PracticeRef it was sent.
       * All three agreeing is the entire basis of zoetis reconciliation — it is what lets a polled
       * result find this order. */
      expect(externalId).toBe(requisitionId)
    }, 60_000)

    it('the mock received the order with the REF-MAPPED species and sex, not the raw dmi codes', async () => {
      const received = expectOk<{
        practiceRef: string
        status: string
        species: string
        gender: string
        breed: string
        animalName: string
        ownerName: string
        vetName: string
        clientId: string
        testCodes: string[]
      }>(
        await mock.get(`/__control__/orders/${requisitionId}`),
        'read order from mock control plane',
      )

      expect(received.practiceRef).toBe(requisitionId)
      expect(received.status).toBe('SUBMITTED')

      /* THE POINT OF THIS TEST. species and sex are the only order fields dmi-api transforms on the
       * way to the vendor, and they must arrive in the ZOETIS vocabulary. Asserting the exact mapped
       * strings — rather than that the fields are merely present — is what makes a silently broken
       * ref mapping fail here instead of producing a well-formed order the vendor cannot read.
       * (Belt and braces: the mock also enforces both vocabularies at placement, so a raw UUID would
       * already have been rejected with a 400 in the test above. Both checks are deliberate — one
       * proves the vendor refuses it, this one proves what was actually sent.) */
      expect(received.species).toBe(EXPECTED_ZOETIS_SPECIES)
      expect(received.gender).toBe(EXPECTED_ZOETIS_GENDER)
      /* Breed is not ref-mapped for zoetis (see the BREED note above): it must arrive verbatim. */
      expect(received.breed).toBe(BREED)

      /* The rest of what the integration forwarded. The mock REJECTS an order missing any of these
       * rather than substituting a default, so a regression that dropped one fails at placement — it
       * cannot reach here and quietly match a mock-invented fallback. */
      expect(received.animalName).toBe('Rex')
      /* getOrder builds these as "<last>, <first>" from the order's client/veterinarian. */
      expect(received.ownerName).toBe('Doe, Jane')
      expect(received.vetName).toBe('Vet, Ann')
      expect(received.testCodes).toEqual([serviceCode])
      /* The integration option, carried into the request document's ClientId (and into the HTTP Basic
       * username). Asserting it proves integrationOptions reached the vendor call, not just the
       * provider configuration. */
      expect(received.clientId).toBe(env.zoetis.clientId)
    })

    it('seeding a result at the mock closes the loop: the report reaches FINAL, the order COMPLETED', async () => {
      /* Watermark the event stream before seeding, so the /events test below can distinguish events
       * the RESULT loop produced from the ones order creation already emitted. */
      const before = expectOk<{ data: Array<{ seq: number }> }>(
        await org.api.get('/events', { start_seq: 0, limit: 1000 }),
        'read the event stream before seeding',
      )
      seqBeforeSeed = before.data.reduce((max, event) => Math.max(max, event.seq ?? 0), 0)

      /* Deterministic completion: the mock holds no results until a test seeds one, so the results
       * poll stays empty until this point. Seed a synthetic `Done` result for this order; the
       * integration's next results poll then pulls the <LabReports> document, maps it and pushes it
       * back to dmi-api. This is the slow step — up to a full 30s hardcoded interval before the poll
       * even fires. */
      expectOk(
        await mock.post(`/__control__/orders/${requisitionId}/results`, {}),
        'seed a result at the mock',
      )

      /* Wait on the REPORT reaching FINAL, not on the order reaching COMPLETED — the obvious choice
       * here is the wrong one, and it took an independent review to catch it.
       *
       * Seeding a result flips the MOCK's own order status to COMPLETED (faithfully: a real Zoetis
       * order with final results reports exactly that). The ORDERS poll then carries that status to
       * dmi-api through `external_orders` -> handleExternalOrders -> updateOrder, which is an
       * entirely separate channel from the results poll. So `GET /orders/:id -> COMPLETED` is
       * evidence that the ORDERS poll ran — it stays green with the results channel severed
       * outright, with the results document carrying a mismatched PracticeRef, or with every
       * ResultStatus downgraded. All three were reproduced; all three left a COMPLETED assertion
       * green. It is not the reconciliation proof it reads as.
       *
       * A FINAL report is. dmi-api sets a report to FINAL in exactly one place
       * (ReportsService, via resultStatusMapper on the `external_results` path); order creation
       * leaves it REGISTERED, and no orders-poll path touches it. So FINAL is reachable only through
       * the results channel, i.e. only if `PracticeRef == externalId` reconciliation actually
       * happened — which is the claim this loop rests on.
       *
       * The order status is still asserted, after the wait: it is a real part of the loop closing,
       * just not the part that proves reconciliation. */
      const report = await pollUntil(
        async () => await org.api.get(`/orders/${orderId}/report`),
        (r) => r.body?.status === 'FINAL',
        COMPLETION_WAIT_MS,
        2_000,
      )

      expect(report.body.status).toBe('FINAL')

      const order = await org.api.get(`/orders/${orderId}`)
      expect(order.body.status).toBe('COMPLETED')
    }, COMPLETION_WAIT_MS + 30_000)

    it('the integration acknowledged the result batch', async () => {
      /* The results processor acks by client_order_id after emitting. Asserting it proves the poll
       * ran to completion rather than dying midway — worth checking explicitly because a failing
       * zoetis poll is silent (the processor catches and logs), so a half-finished poll would
       * otherwise look identical to a healthy one. */
      const received = expectOk<{ resultAcknowledged: boolean }>(
        await mock.get(`/__control__/orders/${requisitionId}`),
        'read order from mock control plane',
      )

      expect(received.resultAcknowledged).toBe(true)
    })

    it('the integration acknowledged the order itself, via the link href the mock advertised', async () => {
      /* The ORDERS channel, which the results channel never touches. It is a genuinely separate code
       * path: acknowledgeOrders re-fetches /orders/:id/status, finds the link whose rel is
       * `acknowledged` and POSTs to that href VERBATIM — so this assertion covers the order-status
       * document's link array, that href resolving back to the mock, and the poll surviving
       * ZoetisMapper.mapOrder (whose getEditable would throw on a single-link document).
       *
       * Waiting for specifically COMPLETED, not merely "acked at all", is what makes it meaningful:
       * the mock only re-lists an order once its status has changed since the last acknowledgement,
       * so a COMPLETED ack proves a full poll->fetch->emit->ack cycle ran AFTER the result landed. */
      const received = await pollUntil(
        async () => await mock.get(`/__control__/orders/${requisitionId}`),
        (r) => r.body?.acknowledgedStatus === 'COMPLETED',
        ORDER_ACK_WAIT_MS,
        2_000,
      )

      expect(received.body.acknowledgedStatus).toBe('COMPLETED')
    }, ORDER_ACK_WAIT_MS + 30_000)

    it('a report with test results is readable over HTTP', async () => {
      const report = expectOk<{
        id: string
        status: string
        testResultsSet: Array<{
          code: string
          notes?: string
          observations: Array<{
            code: string
            name?: string
            valueQuantity?: { value: number, units?: string | null } | null
            valueString?: string
            referenceRange?: Array<{ low?: number, high?: number, text?: string }>
            interpretation?: { code?: string, text?: string } | null
          }>
        }>
      }>(await org.api.get(`/orders/${orderId}/report`), 'read order report')
      reportId = report.id

      /* The seeded result carries ResultStatus `Done` on every LabResult, which is the only value
       * ZoetisMapper.getResultStatus turns into COMPLETED — and dmi-api maps COMPLETED to FINAL.
       * Accepting PARTIAL too would let a regression that downgraded final results slip through. */
      expect(report.status).toBe('FINAL')
      expect(Array.isArray(report.testResultsSet)).toBe(true)
      expect(report.testResultsSet.length).toBeGreaterThan(0)

      /* The panel's code is the LabResultHeader's TestCode, which the mock sets to the code the order
       * was placed with — so this also proves the ordered code survived the round trip. */
      expect(report.testResultsSet.map((testResult) => testResult.code)).toContain(serviceCode)
      /* ResultNotes on the header become the panel's notes (the mapper only sets them when the
       * element is a string, so this keeps that branch honest). */
      expect(report.testResultsSet.find((testResult) => testResult.code === serviceCode)?.notes).toBe(
        'Synthetic harness result.',
      )

      /* Flatten the panel to its observations and assert the seeded analytes survived the whole
       * mapping chain (mock XML -> ZoetisMapper -> dmi-api Observation).
       *
       * The EXACT set is asserted, and that does double duty. It catches a mapper regression that
       * silently dropped an analyte, and it pins the mapper's image/histogram FILTER: the mock seeds
       * six items, two of them with the `_IMG64` and `_HIST_DATA` suffixes the mapper discards, so a
       * filter that stopped working shows up here as two extra observations rather than as nothing at
       * all. */
      const observations = report.testResultsSet.flatMap((testResult) => testResult.observations ?? [])
      expect(observations.map((observation) => observation.code).sort()).toEqual(
        [GLUCOSE, CREATININE, ALT, ALBUMIN].sort(),
      )
      expect(observations.map((observation) => observation.code)).not.toContain(HISTOGRAM_IMAGE)
      expect(observations.map((observation) => observation.code)).not.toContain(HISTOGRAM_DATA)

      /* Glucose was seeded numeric, out-of-range-high, with units and both range bounds: it must map
       * to a quantitative value with units, a bounded reference range, and specifically a HIGH
       * interpretation. The bounds and the interpretation code are asserted exactly — an inverted
       * flag would still be "defined", so a looser check would pass on a HIGH silently becoming LOW. */
      const glucose = observations.find((observation) => observation.code === GLUCOSE)
      expect(glucose).toBeDefined()
      expect(glucose?.name).toBe('Glucose')
      expect(glucose?.valueQuantity?.value).toBe(150)
      expect(glucose?.valueQuantity?.units).toBe('mg/dL')
      expect(glucose?.referenceRange).toEqual([
        expect.objectContaining({ low: 74, high: 143, text: '74-143' }),
      ])
      /* 'H' is the wire value of dmi-engine-common's TestResultItemInterpretationCode.HIGH; LOW is
       * 'L', so this distinguishes the two rather than merely asserting a flag exists. */
      expect(glucose?.interpretation).toMatchObject({ code: 'H' })

      /* Creatinine is in range and carries no flag: a reference range but NO interpretation. dmi-api
       * serialises the absent interpretation as an explicit null (a nullable column), so normalise
       * before asserting rather than expecting undefined. */
      const creatinine = observations.find((observation) => observation.code === CREATININE)
      expect(creatinine?.valueQuantity?.value).toBe(1.2)
      expect(creatinine?.valueQuantity?.units).toBe('mg/dL')
      expect(creatinine?.referenceRange).toEqual([
        expect.objectContaining({ low: 0.5, high: 1.8, text: '0.5-1.8' }),
      ])
      expect(creatinine?.interpretation ?? null).toBeNull()

      /* ALT was seeded as non-numeric TEXT, which takes getValueX's second branch: a valueString with
       * the units APPENDED to it, and no quantity. Asserting the concatenated form is the only thing
       * that covers that append. */
      const alt = observations.find((observation) => observation.code === ALT)
      expect(alt?.valueString).toBe('HEMOLYZED U/L')
      expect(alt?.valueQuantity ?? null).toBeNull()

      /* Albumin was seeded as a FLAGGED NUMERIC in text form ('0.4 *'), which takes getValueX's third
       * branch: the number is parsed back out into a quantity, and — unlike the numeric branch — no
       * units are attached even though a value is produced. */
      const albumin = observations.find((observation) => observation.code === ALBUMIN)
      expect(albumin?.valueQuantity?.value).toBe(0.4)
      expect(albumin?.valueQuantity?.units ?? null).toBeNull()
      expect(albumin?.valueString ?? null).toBeNull()
    })

    it('Mongo events show the order and report lifecycle, including the result loop', async () => {
      const events = expectOk<{
        data: Array<{ seq: number, type: string, data?: { orderId?: string, reportId?: string } }>
      }>(
        await org.api.get('/events', { start_seq: 0, limit: 1000 }),
        'list events',
      )

      /* Scope to this order/report (a cold run has just this one; F1 means /events isn't tenant-
       * scoped, so filter explicitly rather than assume). */
      const mine = events.data.filter(
        (event) => event.data?.orderId === orderId || event.data?.reportId === reportId,
      )

      expect(Array.from(new Set(mine.map((event) => event.type)))).toEqual(
        expect.arrayContaining(['order:created', 'order:updated', 'report:created', 'report:updated']),
      )

      /* The set above is weaker than it looks: dmi-api emits order:created, order:updated AND
       * report:created while the order is being placed, before any result exists. So assert
       * separately on the events that appeared only AFTER the result was seeded (seq is monotonic) —
       * that is the part the result loop is actually responsible for, and the part that would go
       * missing if the poll or the reconciliation broke. */
      const afterSeed = new Set(
        mine.filter((event) => event.seq > seqBeforeSeed).map((event) => event.type),
      )

      expect(seqBeforeSeed).toBeGreaterThan(0)
      expect(Array.from(afterSeed)).toEqual(
        expect.arrayContaining(['order:updated', 'report:updated']),
      )
    })

    it('a rejected order surfaces the vendor field error, not a generic fallback', async () => {
      /* Exercises the integration's error path, which the happy path never touches. The mock rejects
       * a code outside its catalogue with a 400 whose body is `{ error: { context, message } }` — the
       * exact shape zoetis's providerErrorMapper reads — and dmi-api re-throws the engine error out
       * of createOrder, so POST /orders answers non-2xx with the field name in the body. A separate
       * order (unique requisitionId) that never reaches COMPLETED — it lands ERROR in dmi-api — so it
       * does not perturb the loop asserted above.
       *
       * The mock answers errors as JSON while every success is XML, and that asymmetry is what makes
       * this test prove something: providerErrorMapper reads `error.response.data.error.context`,
       * which axios only ever produces from a JSON body. An XML error body would leave `data` a
       * string and the mapper would fall through to its generic branch — the rejection would still be
       * red, but the mapper's real path would never run. */
      const payload = orderPayload(org.integrationId, {
        patient: { name: 'Rex', sex: sexRefCode, species: speciesRefCode, breed: BREED },
        testCodes: [{ code: 'NOT-A-REAL-ZOETIS-CODE' }],
      })

      const response = await org.api.post('/orders', payload)
      console.log(
        `[zoetis-scenario] rejected-order response -> HTTP ${response.status}: ${response.text.slice(0, 300)}`,
      )

      expect(response.ok).toBe(false)
      /* The field branch names the field: providerErrorMapper emits "<context> error in zoetis: …"
       * (surfaced in dmi-api's `errors[]`) ONLY when it can read the mock's `error.context`. Its
       * generic fallback — "A request to … failed with <status> status code." — is what appears when
       * the envelope is unreadable, so asserting that did NOT fire is what proves the mock reaches
       * the real branch. */
      expect(response.text).toMatch(/LabRequests\/LabRequest\/TestCode error in zoetis/)
      expect(response.text).not.toMatch(/failed with \d+ status code/)
    }, 30_000)
  })

  /* ---- "second time" coverage ----
   *
   * Everything above happens once per run: one order, one final result, one of each poll. The blocks
   * below cover what happens the SECOND time — a result that arrives incomplete and is later amended,
   * a delivery that is repeated because its acknowledgement failed, and a feed carrying two documents
   * instead of one. Each takes its own fresh order so it cannot perturb the assertions above. */

  describe('a Pending result is amended to Done, and the report updates in place', () => {
    /* The clinical norm for in-clinic analyzers: a panel reports partial results, then completes.
     * dmi-api merges the second delivery into the first report rather than accumulating a second
     * copy, and this is what proves it. */
    let progressiveOrderId: string
    let progressiveRequisitionId: string
    let observationCountAfterPending = 0

    /* Two analytes (the mock's floor — a lone <LabResultItem> deserialises to an object and the
     * mapper's .filter throws), seeded explicitly rather than using the mock's defaults so the
     * amendment can change exactly one value and leave the other provably untouched. */
    const pendingAnalytes = [
      { code: GLUCOSE, name: 'Glucose', result: '150', units: 'mg/dL', lowRange: '74', highRange: '143', notes: 'H' },
      { code: CREATININE, name: 'Creatinine', result: '1.2', units: 'mg/dL', lowRange: '0.5', highRange: '1.8' },
    ]
    const AMENDED_GLUCOSE = '210'

    it('a Pending result gives a REGISTERED report that already carries observations', async () => {
      const placed = await placeOrder()
      progressiveOrderId = placed.orderId
      progressiveRequisitionId = placed.requisitionId

      expectOk(
        await mock.post(`/__control__/orders/${progressiveRequisitionId}/results`, {
          resultStatus: 'Pending',
          analytes: pendingAnalytes,
        }),
        'seed a Pending result at the mock',
      )

      /* Traced rather than assumed: ZoetisMapper.getResultStatus only reports COMPLETED when EVERY
       * LabResult carries ResultStatus `Done`, so a `Pending` panel maps to ResultStatus.PENDING;
       * dmi-api's resultStatusMapper has no PENDING case and falls through to REGISTERED. The
       * observations are mapped regardless of status, which is the point of this assertion — a
       * partial result is readable, not withheld. */
      const observations = await pollUntil(
        async () => await observationsFor(progressiveOrderId),
        (items) => items.length > 0,
        COMPLETION_WAIT_MS,
        2_000,
      )

      const report = expectOk<{ status: string }>(
        await org.api.get(`/orders/${progressiveOrderId}/report`),
        'read the progressive report',
      )
      expect(report.status).toBe('REGISTERED')

      observationCountAfterPending = observations.length
      expect(observations.map((observation) => observation.code).sort()).toEqual(
        [GLUCOSE, CREATININE].sort(),
      )
      expect(observations.find((o) => o.code === GLUCOSE)?.valueQuantity?.value).toBe(150)
      expect(observations.find((o) => o.code === CREATININE)?.valueQuantity?.value).toBe(1.2)
    }, COMPLETION_WAIT_MS + 30_000)

    it('the order reaches PARTIAL — and only the orders channel can have done that', async () => {
      /* Worth stating because it is the completion-channels trap from the file header, in its other
       * direction. A PENDING result cannot move the order at all: dmi-api's
       * ProviderResultUtils.setOrderStatusFromResult only acts on COMPLETED and PARTIAL result
       * statuses, and this result is PENDING. So PARTIAL here is unambiguously the ORDERS poll
       * carrying the mock's `PARTIAL-RESULTS` vendor status through ZoetisMapper.getOrderStatus —
       * the one assertion in this file that is specifically about that channel's status mapping. */
      const response = await pollUntil(
        async () => await org.api.get(`/orders/${progressiveOrderId}`),
        (r) => r.body?.status === 'PARTIAL',
        ORDER_ACK_WAIT_MS,
        2_000,
      )

      expect(response.body.status).toBe('PARTIAL')
    }, ORDER_ACK_WAIT_MS + 30_000)

    it('re-seeding Done amends the existing observation in place: FINAL, no duplicate, no loss', async () => {
      expectOk(
        await mock.post(`/__control__/orders/${progressiveRequisitionId}/results`, {
          resultStatus: 'Done',
          analytes: [
            { ...pendingAnalytes[0], result: AMENDED_GLUCOSE },
            pendingAnalytes[1],
          ],
        }),
        'amend the result to Done at the mock',
      )

      /* FINAL is the results-channel signal (see the headline completion test): the orders poll can
       * move the ORDER to COMPLETED on its own, but only `external_results` can move the REPORT. */
      const report = await pollUntil(
        async () => await org.api.get(`/orders/${progressiveOrderId}/report`),
        (r) => r.body?.status === 'FINAL',
        COMPLETION_WAIT_MS,
        2_000,
      )
      expect(report.body.status).toBe('FINAL')

      const observations = await observationsFor(progressiveOrderId)

      /* The substance of this test. dmi-api merges a re-delivered result into the existing report by
       * observation CODE (ReportsService.updateTestResultObservations builds a map keyed on it and
       * updates matches in place), so an amendment must overwrite rather than accumulate. Asserting
       * the count is unchanged AND that exactly one glucose observation exists is what would catch a
       * regression that started appending — which would otherwise look like a perfectly healthy
       * report with a stale duplicate hiding in it. */
      expect(observations.length).toBe(observationCountAfterPending)
      expect(observations.filter((observation) => observation.code === GLUCOSE)).toHaveLength(1)
      expect(observations.find((o) => o.code === GLUCOSE)?.valueQuantity?.value).toBe(
        Number(AMENDED_GLUCOSE),
      )
      /* The analyte the amendment did NOT touch must still carry its first-delivery value — a merge
       * that dropped unmentioned observations, or reset them, fails here rather than silently
       * shrinking the report. */
      expect(observations.find((o) => o.code === CREATININE)?.valueQuantity?.value).toBe(1.2)
    }, COMPLETION_WAIT_MS + 30_000)
  })

  describe('a failed batch acknowledgement is retried, and the redelivery does not duplicate', () => {
    /* The vendor's acknowledge model is at-least-once, and this is the case it exists for. The
     * integration emits results to dmi-api and THEN acks them (ZoetisResultsProcessor), so an ack
     * that fails leaves the batch unacked at the vendor: it is re-served on the next tick and dmi-api
     * sees the same result a second time. Nothing in the loop above ever exercises that, because the
     * ack has never failed. */
    let retryOrderId: string
    let retryRequisitionId: string

    it('the result survives one lost acknowledgement: FINAL, observations once, ack eventually true', async () => {
      const placed = await placeOrder()
      retryOrderId = placed.orderId
      retryRequisitionId = placed.requisitionId

      /* One-shot: the first batch acknowledge 500s and the injection is consumed, so the retry on the
       * following tick succeeds. That models a transient vendor failure rather than an outage, which
       * is what makes "eventually acknowledged" the right assertion. */
      expectOk(
        await mock.post('/__control__/scenarios', {
          key: 'batchAcknowledge',
          status: 500,
          once: true,
        }),
        'arm a one-shot batch-acknowledge failure',
      )

      expectOk(
        await mock.post(`/__control__/orders/${retryRequisitionId}/results`, {}),
        'seed a result whose first acknowledgement will fail',
      )

      /* Two ticks minimum: the first delivers and fails its ack, the second redelivers and acks. */
      const acknowledged = await pollUntil(
        async () => await mock.get(`/__control__/orders/${retryRequisitionId}`),
        (r) => r.body?.resultAcknowledged === true,
        COMPLETION_WAIT_MS,
        2_000,
      )
      expect(acknowledged.body.resultAcknowledged).toBe(true)

      const report = await pollUntil(
        async () => await org.api.get(`/orders/${retryOrderId}/report`),
        (r) => r.body?.status === 'FINAL',
        COMPLETION_WAIT_MS,
        2_000,
      )
      expect(report.body.status).toBe('FINAL')

      /* The substance: the result was delivered TWICE and the report must still hold one copy of
       * each observation. Content, not event cardinality — how many `report:updated` events fired is
       * an implementation detail of the retry and pinning it would make this test fragile for no
       * gain. The mock's default seed is six analytes, two of which the mapper filters out. */
      const observations = await observationsFor(retryOrderId)
      expect(observations.map((observation) => observation.code).sort()).toEqual(
        [GLUCOSE, CREATININE, ALT, ALBUMIN].sort(),
      )
      expect(observations).toHaveLength(4)
      expect(observations.find((o) => o.code === GLUCOSE)?.valueQuantity?.value).toBe(150)
    }, COMPLETION_WAIT_MS * 2 + 30_000)
  })

  describe('two orders in flight: the feeds carry two documents, and both close', () => {
    /* Until here every run has held exactly one order, so the orders feed and the results batch have
     * only ever carried ONE document — and the array-shaped parse paths (`objectOrArray` over
     * `LabReports.LabReport` and `orders.order`) have never run against the real integration. A
     * dialect this multiplicity-sensitive should not ship with the plural case untested. */
    let firstOrder: { orderId: string, requisitionId: string }
    let secondOrder: { orderId: string, requisitionId: string }

    it('both reports reach FINAL, and a single batch really did carry both results', async () => {
      firstOrder = await placeOrder()
      secondOrder = await placeOrder()
      expect(firstOrder.requisitionId).not.toBe(secondOrder.requisitionId)

      /* Making simultaneity DETERMINISTIC rather than hoping for it. Two seeds landing either side of
       * a poll tick would be served as two one-document batches and prove nothing new. So: arm a
       * one-shot failure on the results poll BEFORE seeding either result. The next tick consumes the
       * injection and fails; by the tick after, both results are pending and are served together in
       * one batch. */
      expectOk(
        await mock.post('/__control__/scenarios', { key: 'batchResults', status: 500, once: true }),
        'arm a one-shot results-poll failure to force both results into one batch',
      )

      expectOk(
        await mock.post(`/__control__/orders/${firstOrder.requisitionId}/results`, {}),
        'seed a result for the first order',
      )
      expectOk(
        await mock.post(`/__control__/orders/${secondOrder.requisitionId}/results`, {}),
        'seed a result for the second order',
      )

      /* Each wait is scoped to its own order — a shared assertion would let one order's success mask
       * the other's failure, which is the whole risk this test exists to cover. The assertion carries
       * the requisitionId so a failure NAMES which of the two broke; `expect(status).toBe('FINAL')`
       * inside a loop would report "Expected FINAL, received REGISTERED" without saying whose. */
      for (const order of [firstOrder, secondOrder]) {
        /* One COMPLETION_WAIT_MS per order, not two: both waits plus slack have to fit inside this
         * test's own timeout, or a broken second order exhausts the budget during its poll and jest
         * reports a bare "Exceeded timeout" instead of the assertion below — losing exactly the
         * naming this test is built to provide. (Learned from the prove-red run, which did that.) */
        const report = await pollUntil(
          async () => await org.api.get(`/orders/${order.orderId}/report`),
          (r) => r.body?.status === 'FINAL',
          COMPLETION_WAIT_MS,
          2_000,
        )
        expect({ requisitionId: order.requisitionId, reportStatus: report.body?.status }).toEqual({
          requisitionId: order.requisitionId,
          reportStatus: 'FINAL',
        })
      }

      /* Asserted, not assumed: both orders completing is equally true of two separate one-document
       * batches, which would leave the array path just as untested as before. The high-water mark is
       * the only thing that distinguishes the two. */
      const feeds = expectOk<{ maxLabReportsInOneBatch: number, maxDistinctOrdersInOneAck: number }>(
        await mock.get('/__control__/feeds'),
        'read the mock feed high-water marks',
      )
      expect(feeds.maxLabReportsInOneBatch).toBeGreaterThanOrEqual(2)

      /* The serving count alone is not enough, and this took a surviving mutation to notice.
       * Cross-wiring both documents in the batch onto ONE order's PracticeRef still serves two
       * documents and still ends with both reports FINAL — because this mock self-heals: the order
       * whose result was misattributed stays pending and is served ALONE, correctly, on the next
       * tick. Both the count above and the per-order FINAL waits stayed green through exactly that.
       *
       * Acknowledging is where the difference survives. The integration acks the ids it parsed OUT
       * of the batch, so correctly-attributed documents produce two DISTINCT ids in one POST, and
       * cross-wired ones produce the same id twice. That is the assertion that the two documents
       * were not merely delivered together but read as two different orders. */
      expect(feeds.maxDistinctOrdersInOneAck).toBeGreaterThanOrEqual(2)
    }, COMPLETION_WAIT_MS * 2 + 90_000)

    it('both results were batch-acknowledged and both orders link-acknowledged at COMPLETED', async () => {
      /* The two acknowledge channels again, now with two orders in flight: the batch ack must cover
       * both client_order_ids in one POST, and each order must still be acked individually through
       * its own status document's `acknowledged` link. */
      for (const order of [firstOrder, secondOrder]) {
        const received = await pollUntil(
          async () => await mock.get(`/__control__/orders/${order.requisitionId}`),
          (r) => r.body?.resultAcknowledged === true && r.body?.acknowledgedStatus === 'COMPLETED',
          ORDER_ACK_WAIT_MS,
          2_000,
        )

        /* Self-identifying for the same reason as above. */
        expect({
          requisitionId: order.requisitionId,
          resultAcknowledged: received.body?.resultAcknowledged,
          acknowledgedStatus: received.body?.acknowledgedStatus,
        }).toEqual({
          requisitionId: order.requisitionId,
          resultAcknowledged: true,
          acknowledgedStatus: 'COMPLETED',
        })
      }

      /* The orders feed is the other array-shaped parse path. Both orders are placed within one tick
       * of each other, so it should have carried both at once — but assert it rather than assume it,
       * for the same reason as the batch above. */
      const feeds = expectOk<{ maxOrdersInOneFeed: number }>(
        await mock.get('/__control__/feeds'),
        'read the mock feed high-water marks',
      )
      expect(feeds.maxOrdersInOneFeed).toBeGreaterThanOrEqual(2)
    }, ORDER_ACK_WAIT_MS * 2 + 30_000)
  })
})
