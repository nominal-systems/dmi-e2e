import { ApiClient, expectOk } from '../src/api-client'
import { env } from '../src/env'
import { pollUntil } from '../src/poll'
import { adminLogin, orderPayload, seedOrganization, SeededOrg } from '../src/seed'
import { closePool } from '../src/sql'

/* Phase 1 full-system gate for Antech (HARNESS_FULL_STACK=1, HARNESS_STACK=antech): dmi-api under a
 * NORMAL NODE_ENV, wired over real MQTT/Bull/HTTP to the REAL `dmi-engine-antech-integration`
 * container (the classic antech provider, id `antech`) and an Antech mock vendor (src/antech-mock).
 * It drives the whole loop as an integrator would — configure the antech provider pointed at the
 * mock, create an integration, start it, place an order over HTTP, let the mock produce a result,
 * and watch the order->result->report loop close — with every hop real except the vendor, which is
 * the mock so the run is deterministic and never touches a live Antech host.
 *
 * The order flows: POST /orders -> dmi-api RPCs `antech/orders/create` to the integration -> the
 * integration logs in to the mock (POST Users/login -> Token, replayed as ?accessToken= on every
 * later call), POSTs the order to External/OrderPlacement, reads its status back from
 * External/GetStatus and fetches the LabOrders/PDFPIMS manifest -> dmi-api stores the order with the
 * ClinicAccessionID the mock echoed as its externalId. Then the integration's Bull results poll hits
 * External/GetStatus?serviceType=labResult; once a test seeds a result there, the integration pulls
 * the LabResults/XML document, maps it and emits `external_results` (-> report) and
 * `external_order_results` (-> order COMPLETED) back to dmi-api, then acks the batch.
 *
 * How this differs from the idexx loop, all verified against the integration's source:
 *   - Results are XML, not JSON. The mock synthesises a <LabReport> document that the integration's
 *     AntechResultMapper parses (see src/antech-mock/server.js for the shape constraints).
 *   - Auth is a token in a ?accessToken= query param, not Basic + X-Pims-* headers. The integration
 *     logs in again before every single request. The mock accepts any credential VALUES (they are
 *     dummy by design) but requires them to be PRESENT.
 *   - There is no confirmOrder browser handshake — placement is a single POST, so the order is
 *     SUBMITTED the moment it lands and there is no separate submit step to assert.
 *   - The poll interval is hardcoded to 30s in the integration and is NOT env-tunable (idexx exposes
 *     IDEXX_*_POLLING_INTERVAL_MS), so the completion wait below budgets whole intervals. A slow
 *     pass here is the poll cadence, not a hang.
 *
 * A note on the mock, because it is what makes these assertions worth anything: it VALIDATES the
 * order it receives rather than defaulting the missing bits. A mock that substituted its own
 * `PetName` when the integration sent none would make the forwarding assertions below pass against
 * its own invention — and because dmi-api reconciles results on patient name + client last name, the
 * whole loop would stay green with a broken integration. Missing fields are a 400 instead. */

/* The integration's Bull jobs repeat every 30s (hardcoded). A result seeded just after a tick waits
 * a full interval, and the job is only scheduled once the integration has handled the start event —
 * so allow three intervals plus slack before calling the loop broken. */
const COMPLETION_WAIT_MS = 120_000

/* The analyte ids the mock reports on. They are the mock's own invented codes (Antech's real analyte
 * ids are opaque numeric strings), surfaced here so the assertions read as more than magic numbers. */
const GLUCOSE = '1001'
const CREATININE = '1002'
const HEMOLYSIS_INDEX = '1003'

describe('antech full-stack (Antech mock)', () => {
  let org: SeededOrg
  let admin: ApiClient
  let orderId: string
  let externalId: string
  let requisitionId: string
  let reportId: string
  /* The test code the order is placed with, read from the mock's own service catalogue rather than
   * hard-coded here. Antech mnemonics are 4-7 character codes (SA804, S16100, …); the mock rejects
   * anything outside its catalogue, so sourcing it from there keeps the two from drifting apart —
   * and stops an IDEXX-flavoured placeholder like a bare `SA` from creeping back in. */
  let serviceCode: string
  /* Highest event seq observed before the result is seeded, so the /events assertion can prove which
   * events the RESULT loop produced rather than counting ones order creation already emitted. */
  let seqBeforeSeed = 0
  /* Client for the mock's host-facing control plane (/__control__/*, /status). */
  const mock = ApiClient.create(env.antech.mockBaseUrl)

  beforeAll(async () => {
    /* A fresh container starts clean; reset is only load-bearing for warm reruns (HARNESS_KEEP_UP),
     * where it clears the previous run's orders/results. Harmless on a cold start. */
    await mock.post('/__control__/reset').catch(() => undefined)

    const catalogue = expectOk<{ defaultCode: string, services: Array<{ mnemonic: string }> }>(
      await mock.get('/__control__/services'),
      'read the mock service catalogue',
    )
    serviceCode = catalogue.defaultCode

    const root = ApiClient.create()
    /* Quickstart bootstrap: org -> antech provider config whose baseUrl points at the mock's
     * compose-network URL -> integration carrying the (dummy) antech credentials. All three
     * configuration options are required by dmi-api, which validates them at runtime against the
     * provider_option rows seeded by its migrations (baseUrl, uiBaseUrl, PimsIdentifier as strings;
     * UserName/Password/ClinicID as strings and LabId as an integer — a stringified LabId is
     * rejected). uiBaseUrl is only ever string-built into submission/manifest URIs by the
     * integration, never fetched, but it still points at the mock rather than a live Antech host. */
    org = await seedOrganization(root, 'antech', {
      providerId: 'antech',
      configuration: {
        baseUrl: env.antech.baseUrl,
        uiBaseUrl: env.antech.uiBaseUrl,
        PimsIdentifier: env.antech.pimsIdentifier,
      },
      integrationOptions: {
        UserName: env.antech.username,
        Password: env.antech.password,
        ClinicID: env.antech.clinicId,
        LabId: env.antech.labId,
      },
    })

    /* Start the integration so it schedules its Bull results/orders polling. dmi-api's admin start
     * emits `antech/integration/create` to the engine, which the integration handles by adding the
     * repeatable jobs, then flips the integration to RUNNING (a clean 201). We log the outcome but
     * tolerate a non-2xx here rather than asserting it — the real proof that polling started is the
     * result flow closing the loop below. */
    admin = await adminLogin(root)
    const startResponse = await admin.post(`/admin/integrations/${org.integrationId}/start`)
    console.log(
      `[antech-scenario] integration start -> HTTP ${startResponse.status}: ${startResponse.text.slice(0, 200)}`,
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

    it('the Antech mock is reachable', async () => {
      const response = await mock.get('/status')

      expect(response.status).toBe(200)
      expect(response.body.status).toBe('ok')
      expect(response.body.service).toBe('antech-mock')
    })

    it('the quickstart bootstrap completed (org, antech provider config, integration)', () => {
      expect(org.organizationId).toBeTruthy()
      expect(org.providerConfigurationId).toBeTruthy()
      expect(org.integrationId).toBeTruthy()
    })
  })

  describe('an order round-trips through the real integration and the mock, and the loop closes', () => {
    it('POST /orders creates the order via the real antech integration (externalId assigned)', async () => {
      /* Deliberately NO `pims:patient:id` identifier, which is where antech parts company with idexx.
       * The antech result mapper tags the patient it extracts from a result with its own
       * `antech:pet:id` system, while dmi-api's reconciliation guard (ProviderResultUtils
       * .isMatchingOrder) looks up `pims:patient:id` on both sides and rejects the match when only
       * one side has it. An order carrying one would therefore never be updated by its own results —
       * dmi-api logs "Skipping order update ... patient/client mismatch" and the order sits at
       * SUBMITTED forever. Omitting it leaves both sides without a patient id, which the guard
       * treats as compatible, and reconciliation falls back to patient name + client last name (both
       * echoed by the mock). This is the mirror image of the idexx scenario, which must SUPPLY the
       * identifier to work around dmi-api#334.
       *
       * autoSubmitOrder is not passed: it drives idexx's confirmOrder handshake and antech has no
       * equivalent — placement is a single POST and the order is SUBMITTED once it lands. */
      const payload = orderPayload(org.integrationId, {
        patient: { name: 'Rex', sex: 'MALE', species: 'DOG', breed: 'LABRADOR' },
        /* Override the shared default (`SA`, an IDEXX code): the mock enforces Antech's catalogue
         * and rejects anything outside it. */
        testCodes: [{ code: serviceCode }],
      })
      requisitionId = payload.requisitionId as string

      /* dmi-api sends this as an RPC and awaits the integration's reply, so a created order (not a
       * 5xx) confirms the create RPC round-tripped end to end: login -> OrderPlacement -> GetStatus
       * -> PDFPIMS, all four against the mock. */
      const created = expectOk<{ id: string, externalId: string, status: string }>(
        await org.api.post('/orders', payload),
        'place antech order',
      )
      orderId = created.id
      externalId = created.externalId

      expect(orderId).toBeTruthy()
      /* The integration assigns the raw OrderPlacement response body as the externalId, and results
       * are later correlated by ClinicAccessionID — so the mock echoes the requisitionId back and
       * the two agree. That agreement is what lets a polled result find this order. */
      expect(externalId).toBe(requisitionId)
    }, 60_000)

    it('the mock received the order, with the tests and patient it was placed with', async () => {
      const received = expectOk<{
        clinicAccessionId: string
        labAccessionId: string
        orderStatus: number
        mnemonic: string
        petName: string
        clientLastName: string
      }>(
        await mock.get(`/__control__/orders/${requisitionId}`),
        'read order from mock control plane',
      )

      expect(received.clinicAccessionId).toBe(requisitionId)
      /* 1 == SUBMITTED in Antech's numeric order-status vocabulary: placed, no results yet. */
      expect(received.orderStatus).toBe(1)
      /* These four are the substance of this test: they are what the integration actually forwarded.
       * The mock REJECTS an order missing any of them rather than substituting a default, so a
       * regression that dropped the patient name or the tests fails at placement — it cannot reach
       * here and quietly match a mock-invented fallback. */
      expect(received.mnemonic).toBe(serviceCode)
      /* The patient/client the mock echoes back on results is what dmi-api reconciles against. */
      expect(received.petName).toBe('Rex')
      expect(received.clientLastName).toBe('Doe')
      /* The vendor-assigned accession that keys the results XML and the acknowledge call. */
      expect(received.labAccessionId).toBeTruthy()
    })

    it('seeding a result at the mock closes the loop: the order reaches COMPLETED', async () => {
      /* Watermark the event stream before seeding, so the /events test below can distinguish events
       * the RESULT loop produced from the ones order creation already emitted. */
      const before = expectOk<{ data: Array<{ seq: number }> }>(
        await org.api.get('/events', { start_seq: 0, limit: 1000 }),
        'read the event stream before seeding',
      )
      seqBeforeSeed = before.data.reduce((max, event) => Math.max(max, event.seq ?? 0), 0)

      /* Deterministic completion: the mock holds no results until a test seeds one, so the labResult
       * poll stays empty until this point. Seed a synthetic final ('F') result for this order; the
       * integration's next results poll then pulls the XML, maps it and pushes it back to dmi-api.
       * This is the slow step — up to a full 30s hardcoded interval before the poll even fires. */
      expectOk(
        await mock.post(`/__control__/orders/${requisitionId}/results`, {}),
        'seed a result at the mock',
      )

      const response = await pollUntil(
        async () => await org.api.get(`/orders/${orderId}`),
        (r) => r.body?.status === 'COMPLETED',
        COMPLETION_WAIT_MS,
        2_000,
      )

      expect(response.body.status).toBe('COMPLETED')
    }, COMPLETION_WAIT_MS + 30_000)

    it('the integration acknowledged the result batch', async () => {
      /* The results processor acks by LabAccessionID after emitting. Asserting it proves the poll ran
       * to completion rather than dying midway — worth checking explicitly here because a failing
       * antech results poll is silent, so a half-finished poll would otherwise look identical to a
       * healthy one. */
      const received = expectOk<{ resultAcked: boolean }>(
        await mock.get(`/__control__/orders/${requisitionId}`),
        'read order from mock control plane',
      )

      expect(received.resultAcked).toBe(true)
    })

    it('a report with test results is readable over HTTP', async () => {
      const report = expectOk<{
        id: string
        status: string
        testResultsSet: Array<{
          code: string
          observations: Array<{
            code: string
            name?: string
            valueQuantity?: { value: number, units?: string } | null
            valueString?: string
            referenceRange?: Array<{ low?: number, high?: number, text?: string }>
            interpretation?: { code?: string, text?: string } | null
            notes?: string
          }>
        }>
      }>(await org.api.get(`/orders/${orderId}/report`), 'read order report')
      reportId = report.id

      /* The seeded result is final ('F'), so FINAL is deterministic — accepting PARTIAL too would
       * let a regression that downgraded final results slip through. */
      expect(report.status).toBe('FINAL')
      expect(Array.isArray(report.testResultsSet)).toBe(true)
      expect(report.testResultsSet.length).toBeGreaterThan(0)

      /* The panel's code is the Mnemonic from the status JSON, which the mock sets to the code the
       * order was placed with. */
      expect(report.testResultsSet.map((testResult) => testResult.code)).toContain(serviceCode)

      /* Flatten the panel to its observations and assert the seeded analytes survived the whole
       * mapping chain (mock XML -> integration AntechResultMapper -> dmi-api Observation).
       *
       * The exact set is asserted, not merely a non-empty one: the mock seeds three analytes, and a
       * mapper regression that silently dropped one would otherwise pass. */
      const observations = report.testResultsSet.flatMap((testResult) => testResult.observations ?? [])
      expect(observations.map((observation) => observation.code).sort()).toEqual(
        [GLUCOSE, CREATININE, HEMOLYSIS_INDEX].sort(),
      )

      /* Glucose was seeded numeric, out-of-range-high, with units and a reference range: it must map
       * to a quantitative value with units, a bounded reference range, and specifically a HIGH
       * interpretation. The bounds and the code are asserted exactly — the mapper emits a
       * referenceRange entry for ANY <Range> text (carrying only `text` when its regex doesn't
       * match), and an inverted flag would still be "defined", so a looser check here would pass on
       * a lost range or a HIGH silently becoming LOW. The units are the fussy part: they survive
       * only because the mock emits <Units> as CDATA, the one form the mapper reads. */
      const glucose = observations.find((observation) => observation.code === GLUCOSE)
      expect(glucose).toBeDefined()
      expect(glucose?.name).toBe('Glucose')
      expect(glucose?.valueQuantity?.value).toBe(150)
      expect(glucose?.valueQuantity?.units).toBe('mg/dL')
      expect(glucose?.referenceRange).toEqual([
        expect.objectContaining({ low: 74, high: 143 }),
      ])
      /* 'H' is the wire value of dmi-engine-common's TestResultItemInterpretationCode.HIGH; LOW is
       * 'L', so this distinguishes the two rather than merely asserting a flag exists. */
      expect(glucose?.interpretation).toMatchObject({ code: 'H' })

      /* Creatinine carries a comment, which must arrive as the observation's notes — the mapper only
       * reads it from a CDATA <Comment>, so this is the assertion that keeps that branch honest. */
      const creatinine = observations.find((observation) => observation.code === CREATININE)
      expect(creatinine?.valueQuantity?.value).toBe(1.2)
      expect(creatinine?.notes).toBe('Within normal limits.')

      /* A non-numeric analyte takes the other branch of the mapper and must land as a string value
       * rather than a quantity. dmi-api serialises the absent quantity as an explicit null (it is a
       * nullable column), so normalise before asserting rather than expecting undefined. */
      const hemolysis = observations.find((observation) => observation.code === HEMOLYSIS_INDEX)
      expect(hemolysis).toBeDefined()
      expect(hemolysis?.valueString).toBe('NEGATIVE')
      expect(hemolysis?.valueQuantity ?? null).toBeNull()
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
  })
})
