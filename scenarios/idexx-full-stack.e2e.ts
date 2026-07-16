import { ApiClient, expectOk } from '../src/api-client'
import { env } from '../src/env'
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

/* Poll a request until `done` holds or the deadline passes; returns the last response either way. */
async function pollUntil<T> (
  fetchFn: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
  intervalMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last = await fetchFn()
  while (!done(last) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
    last = await fetchFn()
  }
  return last
}

describe('idexx full-stack (VetConnect Plus mock)', () => {
  let org: SeededOrg
  let admin: ApiClient
  let orderId: string
  let externalId: string
  let requisitionId: string
  let reportId: string
  /* Client for the mock's host-facing control plane (/__control__/*, /status). */
  const mock = ApiClient.create(env.idexx.mockBaseUrl)

  beforeAll(async () => {
    /* A fresh container starts clean; reset is only load-bearing for warm reruns (HARNESS_KEEP_UP),
     * where it clears the previous run's seeded orders/results. Harmless on a cold start. */
    await mock.post('/__control__/reset').catch(() => undefined)

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
      const payload = orderPayload(org.integrationId)
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
      const received = expectOk<{ status: string, corporateRequisitionId: string }>(
        await mock.get(`/__control__/orders/${requisitionId}`),
        'read order from mock control plane',
      )

      expect(received.corporateRequisitionId).toBe(requisitionId)
      expect(received.status).toBe('SUBMITTED')
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

      expect(['FINAL', 'PARTIAL']).toContain(report.status)
      expect(Array.isArray(report.testResultsSet)).toBe(true)
      expect(report.testResultsSet.length).toBeGreaterThan(0)

      /* Flatten the panel to its observations and assert the seeded analytes survived the whole
       * mapping chain (mock -> integration IdexxResultMapper -> dmi-api Observation). */
      const observations = report.testResultsSet.flatMap((testResult) => testResult.observations ?? [])
      expect(observations.length).toBeGreaterThan(0)

      /* Glucose was seeded NUMERIC, out-of-range-high, with a reference range: it must map to a
       * quantitative value with units, a reference range, and a high interpretation. */
      const glucose = observations.find((observation) => observation.code === 'GLU')
      expect(glucose).toBeDefined()
      expect(glucose?.valueQuantity?.value).toBe(150)
      expect(glucose?.valueQuantity?.units).toBe('mg/dL')
      expect(Array.isArray(glucose?.referenceRange)).toBe(true)
      expect((glucose?.referenceRange ?? []).length).toBeGreaterThan(0)
      expect(glucose?.interpretation).toBeDefined()
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
