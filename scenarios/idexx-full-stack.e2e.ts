import { ApiClient, expectOk } from '../src/api-client'
import { env } from '../src/env'
import { pollUntil } from '../src/poll'
import { adminLogin, orderPayload, seedOrganization, SeededOrg } from '../src/seed'
import { closePool } from '../src/sql'

/* Phase 0 full-system gate for IDEXX (HARNESS_FULL_STACK=1, HARNESS_STACK=idexx — the default):
 * dmi-api under a NORMAL NODE_ENV, wired over real MQTT/Bull/HTTP to the REAL
 * `dmi-engine-idexx-integration` container and a VetConnect Plus mock vendor (src/idexx-mock). It
 * drives the whole loop as an integrator would — configure the idexx provider pointed at the mock,
 * create an integration, start it, place an order over HTTP, let the mock produce a result, and
 * watch the order->result->report loop close — with every hop real except the vendor, which is the
 * mock so the run is deterministic and never touches live IDEXX.
 *
 * The order flows: POST /orders -> dmi-api RPCs `idexx/orders/create` to the integration -> the
 * integration POSTs the order to the mock's /api/v1/order and (autoSubmitOrder) runs the confirmOrder
 * browser handshake against the mock -> dmi-api stores the order with the mock's idexxOrderId as its
 * externalId. Then the integration's Bull results poll hits the mock's /api/v3/results/latest; once a
 * test seeds a result there, the integration maps it and emits `external_results` (-> report) and
 * `external_order_results` (-> order COMPLETED) back to dmi-api, then acks the batch. */

describe('idexx full-stack (VetConnect Plus mock)', () => {
  let org: SeededOrg
  let admin: ApiClient
  let orderId: string
  let externalId: string
  let requisitionId: string
  let reportId: string
  /* Read from the mock's own /api/v1/ref/tests rather than hard-coded, so the code the harness
   * orders is by construction one the vendor advertises — and the mock now rejects anything else. */
  let serviceCode: string
  /* Client for the mock's host-facing control plane (/__control__/*, /status). */
  const mock = ApiClient.create(env.idexx.mockBaseUrl)

  beforeAll(async () => {
    /* A fresh container starts clean; reset is only load-bearing for warm reruns (HARNESS_KEEP_UP),
     * where it clears the previous run's seeded orders/results. Harmless on a cold start. */
    await mock.post('/__control__/reset').catch(() => undefined)

    const catalogue = expectOk<{ list: Array<{ code: string }> }>(
      await mock.get('/api/v1/ref/tests'),
      'read the mock orderable-test catalogue',
    )
    serviceCode = catalogue.list[0].code

    const root = ApiClient.create()
    /* Quickstart bootstrap: org -> idexx provider config whose orderingBaseUrl/resultBaseUrl point at
     * the mock's compose-network URL, carrying the (dummy) PIMS headers -> integration carrying the
     * (dummy) idexx username/password/locale. POST /integrations returns 201 without any engine RPC;
     * it leaves the integration status NEW and does NOT schedule polling. */
    org = await seedOrganization(root, 'idexx', {
      providerId: 'idexx',
      configuration: {
        orderingBaseUrl: env.idexx.orderingBaseUrl,
        resultBaseUrl: env.idexx.resultBaseUrl,
        'X-Pims-Id': env.idexx.pimsId,
        'X-Pims-Version': env.idexx.pimsVersion,
      },
      integrationOptions: {
        username: env.idexx.username,
        password: env.idexx.password,
        locale: env.idexx.locale,
      },
    })

    /* Start the integration so it schedules its Bull results/orders polling. dmi-api's admin start
     * emits `idexx/integration/create` to the engine, which the integration handles by adding the
     * repeatable jobs, then flips the integration to RUNNING (a clean 201). We log the outcome but
     * tolerate a non-2xx here rather than asserting it — the real proof that polling started is the
     * result flow closing the loop below. */
    admin = await adminLogin(root)
    const startResponse = await admin.post(`/admin/integrations/${org.integrationId}/start`)
    console.log(
      `[idexx-scenario] integration start -> HTTP ${startResponse.status}: ${startResponse.text.slice(0, 200)}`,
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

    it('the VetConnect Plus mock is reachable', async () => {
      const response = await mock.get('/status')

      expect(response.status).toBe(200)
      expect(response.body.status).toBe('ok')
      expect(response.body.service).toBe('vcp-mock')
    })

    it('the quickstart bootstrap completed (org, idexx provider config, integration)', () => {
      expect(org.organizationId).toBeTruthy()
      expect(org.providerConfigurationId).toBeTruthy()
      expect(org.integrationId).toBeTruthy()
    })
  })

  describe('an order round-trips through the real integration and the mock, and the loop closes', () => {
    it('POST /orders creates the order via the real idexx integration (externalId assigned)', async () => {
      const payload = orderPayload(org.integrationId, { testCodes: [{ code: serviceCode }] })
      requisitionId = payload.requisitionId as string

      /* autoSubmitOrder=true drives the integration's confirmOrder browser handshake against the
       * mock after create. dmi-api sends this as an RPC and awaits the integration's reply, so a
       * created order (not a 5xx) confirms the create RPC round-tripped end to end. */
      const created = expectOk<{ id: string, externalId: string, status: string }>(
        await org.api.post('/orders', payload, { autoSubmitOrder: true }),
        'place idexx order',
      )
      orderId = created.id
      externalId = created.externalId

      expect(orderId).toBeTruthy()
      /* externalId is the mock's idexxOrderId; it is the key dmi-api later correlates results on. */
      expect(externalId).toBeTruthy()
    }, 30_000)

    it('the mock received the order and the confirmOrder handshake submitted it', async () => {
      /* Proves the fiddly confirmOrder flow works against the REAL integration: create-order -> follow
       * the mock's uiURL -> harvest the cookie -> XHR PUT. The mock flips the order to SUBMITTED only
       * on that PUT. (If confirmOrder ever regressed, the integration swallows the error and the order
       * would still be created — so this is asserted separately from loop closure below.) */
      const received = expectOk<{ status: string, corporateRequisitionId: string, tests: string[] }>(
        await mock.get(`/__control__/orders/${requisitionId}`),
        'read order from mock control plane',
      )

      expect(received.corporateRequisitionId).toBe(requisitionId)
      expect(received.status).toBe('SUBMITTED')
      /* The ordered test survived the mapping into IDEXX's dialect. The mock rejects an order whose
       * codes are outside its catalogue, so this also pins that the integration forwards them. */
      expect(received.tests).toEqual([serviceCode])
    })

    it('seeding a result at the mock closes the loop: the order reaches COMPLETED', async () => {
      /* Deterministic completion: the mock holds no results until a test seeds one. Seed a synthetic
       * COMPLETE result for this order; the integration's results poll (every few seconds) then maps
       * it and pushes it back to dmi-api. */
      expectOk(
        await mock.post(`/__control__/orders/${requisitionId}/results`, {}),
        'seed a result at the mock',
      )

      const response = await pollUntil(
        async () => await org.api.get(`/orders/${orderId}`),
        (r) => r.body?.status === 'COMPLETED',
        90_000,
        2_000,
      )

      expect(response.body.status).toBe('COMPLETED')
    }, 100_000)

    it('a report with test results is readable over HTTP', async () => {
      const report = expectOk<{
        id: string
        status: string
        testResultsSet: Array<{
          code: string
          observations: Array<{
            code: string
            valueQuantity?: { value: number, units?: string }
            referenceRange?: unknown[]
            interpretation?: unknown
          }>
        }>
      }>(await org.api.get(`/orders/${orderId}/report`), 'read order report')
      reportId = report.id

      /* Exactly FINAL: the single seeded result is COMPLETE, so this is deterministic, and
       * accepting PARTIAL as well would hide a downgrade. */
      expect(report.status).toBe('FINAL')
      expect(Array.isArray(report.testResultsSet)).toBe(true)
      expect(report.testResultsSet.length).toBeGreaterThan(0)

      /* Flatten the panel to its observations and assert the seeded analytes survived the whole
       * mapping chain (mock -> integration IdexxResultMapper -> dmi-api Observation). */
      const observations = report.testResultsSet.flatMap((testResult) => testResult.observations ?? [])
      expect(observations.length).toBeGreaterThan(0)

      /* The WHOLE seeded analyte set, so a dropped observation fails rather than being ignored. */
      expect(observations.map((observation) => observation.code).sort()).toEqual(['CREA', 'GLU'])

      /* Glucose was seeded NUMERIC, out-of-range-high, with a reference range. */
      const glucose = observations.find((observation) => observation.code === 'GLU')
      expect(glucose).toBeDefined()
      expect(glucose?.valueQuantity?.value).toBe(150)
      expect(glucose?.valueQuantity?.units).toBe('mg/dL')
      /* Bounds, not merely presence: the mapper emits a range entry for any low/high pair, so the
       * numbers can drift silently while `length > 0` stays true. */
      expect(glucose?.referenceRange).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'NORMAL', low: 74, high: 143 }),
        ]),
      )
      /* The interpretation CODE, not merely its presence: `toBeDefined()` was as true of LOW as of
       * HIGH. dmi-api persists the wire value, so this is 'H' (not 'HIGH'). */
      expect(glucose?.interpretation).toMatchObject({ code: 'H' })

      /* Creatinine was seeded in range: it must carry its value and NO interpretation. */
      const creatinine = observations.find((observation) => observation.code === 'CREA')
      expect(creatinine?.valueQuantity?.value).toBe(1.2)
      expect(creatinine?.valueQuantity?.units).toBe('mg/dL')
      /* dmi-api deletes the interpretation when the item is in range; it serialises as null. */
      expect(creatinine?.interpretation ?? null).toBeNull()
    })

    it('Mongo events show the order and report lifecycle', async () => {
      const events = expectOk<{ data: Array<{ type: string, data?: { orderId?: string, reportId?: string } }> }>(
        await org.api.get('/events', { start_seq: 0, limit: 1000 }),
        'list events',
      )

      /* Scope to this order/report (a cold run has just this one; F1 means /events isn't tenant-
       * scoped, so filter explicitly rather than assume). */
      const types = new Set(
        events.data
          .filter((event) => event.data?.orderId === orderId || event.data?.reportId === reportId)
          .map((event) => event.type),
      )

      expect(Array.from(types)).toEqual(
        expect.arrayContaining(['order:created', 'order:updated', 'report:created', 'report:updated']),
      )
    })
  })
})
