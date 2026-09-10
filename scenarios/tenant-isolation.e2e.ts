import { expectOk } from '../src/api-client'
import { orderPayload, seed, SeededContext } from '../src/seed'
import { closePool, insertReport } from '../src/sql'

/* Two organizations, no relationship between them. Every test below asserts what a correct
 * multi-tenant API must do — reject, or omit. Where dmi-api does not do that today, the test is
 * marked `it.failing`, which means:
 *
 *   - it passes CI while the defect exists (the assertion throws, as `failing` expects), and
 *   - it FAILS the moment someone fixes the defect, forcing the marker to be removed.
 *
 * That is deliberate. These are not snapshots of current behaviour; they are the expectations,
 * with a tripwire attached. Each one names the defect. See README.md — do not "fix" a red build
 * here by relaxing an assertion. */

/* `orderPayload` takes no default test code — every vendor rejects codes outside its own catalogue,
 * so a shared default is wrong for all but one provider. This suite runs under NODE_ENV=seed, where
 * dmi-api returns before any engine round-trip, so no vendor ever sees this code; it just has to be
 * present and stable. */
const ANY_TEST_CODE = [{ code: 'HARNESS-TENANT-ISOLATION' }]

describe('tenant isolation', () => {
  let ctx: SeededContext
  let aOrderId: string
  let aReportId: string

  beforeAll(async () => {
    ctx = await seed()

    const order = expectOk<{ id: string }>(
      await ctx.orgA.api.post('/orders', orderPayload(ctx.orgA.integrationId, { testCodes: ANY_TEST_CODE })),
      "create org A's order",
    )
    aOrderId = order.id

    /* No HTTP route creates a report — they arrive from the engine over MQTT, which is out of
     * scope for this PR. Direct insert is the sanctioned escape hatch. */
    aReportId = await insertReport(aOrderId)
  }, 120_000)

  afterAll(async () => {
    await closePool()
  })

  describe('control: org A can reach its own data', () => {
    it('GET /orders/:id returns the order to its owner', async () => {
      const response = await ctx.orgA.api.get(`/orders/${aOrderId}`)

      expect(response.status).toBe(200)
      expect(response.body.id).toBe(aOrderId)
    })

    it('GET /orders lists the order for its owner', async () => {
      const response = await ctx.orgA.api.get('/orders')

      expect(response.status).toBe(200)
      expect(response.body.map((order: { id: string }) => order.id)).toContain(aOrderId)
    })

    /* Load-bearing. Without it, a bad fixture (a report that was never inserted) would make the
     * `it.failing` report tests below "pass" for the wrong reason: they would see a 404 for a
     * nonexistent id, throw, and `failing` would call that success. This assertion holds both
     * today and after F2/F3 are fixed, so it pins the fixture without enshrining the defect. */
    it('the seeded report exists and its owner can read it', async () => {
      const response = await ctx.orgA.api.get(`/reports/${aReportId}`)

      expect(response.status).toBe(200)
      expect(response.body.id).toBe(aReportId)
    })
  })

  describe('orders: correctly scoped today', () => {
    it('GET /orders/:id denies org B', async () => {
      const response = await ctx.orgB.api.get(`/orders/${aOrderId}`)

      /* Expected 403 Forbidden. A 404 would leak less (it would not confirm the id exists), but
       * 403 is a refusal, which is what matters here. */
      expect([403, 404]).toContain(response.status)
    })

    it('GET /orders omits org A from org B\'s list', async () => {
      const response = await ctx.orgB.api.get('/orders')

      expect(response.status).toBe(200)
      expect(response.body.map((order: { id: string }) => order.id)).not.toContain(aOrderId)
    })

    it('GET /orders/:id/result.json denies org B', async () => {
      const response = await ctx.orgB.api.get(`/orders/${aOrderId}/result.json`)

      expect(response.status).not.toBe(200)
    })
  })

  describe('practices, integrations and provider configurations: correctly scoped today', () => {
    it('GET /practices omits org A\'s practice from org B\'s list', async () => {
      const response = await ctx.orgB.api.get('/practices')

      expect(response.status).toBe(200)
      expect(response.body.map((p: { id: string }) => p.id)).not.toContain(ctx.orgA.practiceId)
    })

    it('GET /practices/:id denies org B', async () => {
      const response = await ctx.orgB.api.get(`/practices/${ctx.orgA.practiceId}`)

      expect(response.status).not.toBe(200)
    })

    it('GET /integrations omits org A\'s integration from org B\'s list', async () => {
      const response = await ctx.orgB.api.get('/integrations')

      expect(response.status).toBe(200)
      expect(response.body.map((i: { id: string }) => i.id)).not.toContain(ctx.orgA.integrationId)
    })

    it('GET /providers/configurations omits org A\'s configuration from org B\'s list', async () => {
      const response = await ctx.orgB.api.get('/providers/configurations')

      expect(response.status).toBe(200)
      expect(response.body.map((c: { id: string }) => c.id)).not.toContain(
        ctx.orgA.providerConfigurationId,
      )
    })

    it('GET /organizations/:id/keys denies org B\'s owner', async () => {
      const response = await ctx.orgB.jwt.get(`/organizations/${ctx.orgA.organizationId}/keys`)

      expect(response.status).not.toBe(200)
      expect(response.body?.prodKey).toBeUndefined()
    })
  })

  describe('events', () => {
    /* DEFECT F1 — events.service.ts `getEventsForOrganization` accepts an `organization` argument
     * and never reads it; the Mongo filter is `{ seq: { $gt: seq } }` and nothing more. Any valid
     * API key appears to read every tenant's events, and `event.data` for `order:created` embeds
     * the full order (patient name, client name, veterinarian). Remove `.failing` once scoped. */
    it.failing('GET /events does not expose another organization\'s events', async () => {
      const response = await ctx.orgB.api.get('/events', { start_seq: 0 })

      expect(response.status).toBe(200)
      const practiceIds = response.body.data.map((event: { practiceId: string }) => event.practiceId)
      expect(practiceIds).not.toContain(ctx.orgA.practiceId)
    })

    /* DEFECT F1 (same root cause) — events.controller.ts computes `total` from
     * `eventsService.count(query)` with that same unscoped query, so the count leaks too.
     * Org A owns one order:created event; org B owns none. */
    it.failing('GET /events does not count another organization\'s events', async () => {
      const forA = await ctx.orgA.api.get('/events', { start_seq: 0 })
      const forB = await ctx.orgB.api.get('/events', { start_seq: 0 })

      expect(forA.status).toBe(200)
      expect(forB.status).toBe(200)
      expect(forB.body.total).toBeLessThan(forA.body.total)
    })
  })

  describe('reports', () => {
    /* Was DEFECT F2, FIXED in dmi-api #361 (issue #340) — reports.controller.ts has no `@UseGuards(ApiGuard)` at class or method level,
     * and there is no global guard (no APP_GUARD, no useGlobalGuards anywhere in dmi-api's src/).
     * All three /reports routes appear to be reachable with no credentials at all, despite
     * dmi-api's README "Mapped Routes" table listing them as API Key. */
    it('GET /reports/:id rejects a caller with no API key', async () => {
      const response = await ctx.anonymous.get(`/reports/${aReportId}`)

      expect([401, 403]).toContain(response.status)
    })

    /* Was DEFECT F3, FIXED in dmi-api #361 (issue #340) — reports.service.ts `getReport(id, _organization)` carries a literal
     * "TODO(gb): actually check the user can access this report" and ignores the organization.
     * Independent of F2: adding a guard alone would not fix this. */
    it('GET /reports/:id denies org B', async () => {
      const response = await ctx.orgB.api.get(`/reports/${aReportId}`)

      expect([403, 404]).toContain(response.status)
    })

    /* Was DEFECT F2, FIXED in dmi-api #361 (issue #340) — `getPresentedForm(reportId)` does not even take an organization. This report
     * has no attachments, so an unguarded app answers 404 ("presented form not found") rather
     * than 401; either way, a guarded app would answer 401 before reaching the service. */
    it('GET /reports/:id/presentedForm rejects a caller with no API key', async () => {
      const response = await ctx.anonymous.get(`/reports/${aReportId}/presentedForm`)

      expect([401, 403]).toContain(response.status)
    })

    /* Was DEFECT F5, FIXED in dmi-api #361 (issue #340) — orders.service.ts `getOrderReport(organization, orderId)` ignores its
     * `organization` argument and returns `reportsService.findForOrder(orderId)` outright. */
    it('GET /orders/:id/report denies org B', async () => {
      const response = await ctx.orgB.api.get(`/orders/${aOrderId}/report`)

      expect([403, 404]).toContain(response.status)
    })
  })

  /* Kept last: these mutate state on success, and on success they are the vulnerability. */
  describe('cross-tenant writes', () => {
    /* Was DEFECT F4, FIXED in dmi-api #361 (issue #340) — orders.controller.ts `createOrder` takes no `@Organization()`, and
     * orders.service.ts resolves `createOrderDto.integrationId` with no ownership check. ApiGuard
     * authenticates the caller but nothing authorizes the integration being referenced. */
    it('POST /orders rejects org B targeting org A\'s integration', async () => {
      const response = await ctx.orgB.api.post('/orders', orderPayload(ctx.orgA.integrationId, { testCodes: ANY_TEST_CODE }))

      expect([403, 404]).toContain(response.status)
    })

    /* Was DEFECT F4, FIXED in dmi-api #361 (issue #340) — integrations.controller.ts `createIntegration` likewise takes no
     * `@Organization()`; `providerConfigurationId` is never checked for ownership. On success,
     * org B has bound its own practice to org A's provider configuration — meaning org B's
     * subsequent orders would be placed against org A's lab account. */
    it('POST /integrations rejects org B targeting org A\'s provider configuration', async () => {
      const response = await ctx.orgB.api.post('/integrations', {
        practiceId: ctx.orgB.practiceId,
        providerConfigurationId: ctx.orgA.providerConfigurationId,
        integrationOptions: { apiKey: 'harness-cross-tenant' },
      })

      expect([403, 404]).toContain(response.status)
    })

    /* Fixed in dmi-api #361 (issue #340) — regression guard. `PUT /providers/:providerId/
     * configurations/:configId` overwrote ANY config's encrypted credentials and reassigned its
     * `organization` FK, with no ownership check — so org B, knowing org A's config id, could both
     * repoint org A's provider credentials and steal the config into its own org. The body is
     * untyped, and ownership is checked before validation, so this reaches the authorization path.
     * Now scoped: a non-owned config is refused before any write. */
    it('PUT /providers/:id/configurations/:id denies org B overwriting org A\'s config', async () => {
      const response = await ctx.orgB.api.put(
        `/providers/demo/configurations/${ctx.orgA.providerConfigurationId}`,
        { configuration: { url: 'http://cross-tenant.invalid' } },
      )

      expect([403, 404]).toContain(response.status)
    })
  })
})
