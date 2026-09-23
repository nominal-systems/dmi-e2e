import { ApiClient, expectOk } from '../src/api-client'
import { env } from '../src/env'
import { pollUntil } from '../src/poll'
import { adminLogin, seedOrganization, SeededOrg } from '../src/seed'
import { closePool } from '../src/sql'

/* PLACEHOLDER — the wisdom-panel scenario is being built; this skeleton proves the profile boots and
 * the engine's api/worker split takes a wisdom-panel integration: the admin start emits
 * `wisdom-panel/integration/create`, which the api process answers by scheduling the polling jobs
 * the worker process then runs against the mock — and the mock's call log shows both polls
 * arriving with the integration's filters. */

const POLL_MS = 3_000

describe('wisdom-panel full-stack (Wisdom Panel mock)', () => {
  let root: ApiClient
  let org: SeededOrg

  const mock = ApiClient.create(env.wisdomPanel.mockBaseUrl)

  beforeAll(async () => {
    root = ApiClient.create()
    org = await seedOrganization(root, 'wisdom-panel', {
      providerId: 'wisdom-panel',
      configuration: {
        baseUrl: env.wisdomPanel.baseUrl,
        username: env.wisdomPanel.username,
        password: env.wisdomPanel.password,
        organizationUnitId: env.wisdomPanel.organizationUnitId,
      },
      integrationOptions: {
        hospitalName: env.wisdomPanel.hospitalName,
        hospitalNumber: env.wisdomPanel.hospitalNumber,
        hospitalPhone: env.wisdomPanel.hospitalPhone,
      },
    })
    const admin = await adminLogin(root)
    const startResponse = await admin.post(`/admin/integrations/${org.integrationId}/start`)
    console.log(
      `[wisdom-panel-scenario] integration start -> HTTP ${startResponse.status}: ${startResponse.text.slice(0, 200)}`,
    )
    expectOk(startResponse, 'start integration')
  }, 120_000)

  afterAll(async () => {
    await closePool()
  })

  describe('the full stack booted and is wired', () => {
    it('dmi-api is healthy under a normal NODE_ENV', async () => {
      const response = await root.get('/health')
      expect(response.status).toBe(200)
    })

    it('the wisdom-panel mock is reachable', async () => {
      const response = await mock.get('/status')
      expect(response.status).toBe(200)
      expect(response.body.service).toBe('wisdom-panel-mock')
    })

    it('the quickstart bootstrap completed (org, wisdom-panel provider config, integration)', () => {
      expect(org.organizationId).toBeTruthy()
      expect(org.providerConfigurationId).toBeTruthy()
      expect(org.integrationId).toBeTruthy()
    })

    it('the worker polls both feeds at the mock, as a bearer, scoped to the hospital', async () => {
      interface MockCall { method: string, path: string, query: Record<string, string>, headers: Record<string, string | undefined> }
      const calls = await pollUntil(
        async () => {
          const { calls } = expectOk<{ calls: MockCall[] }>(await mock.get('/__control__/calls'), 'read the mock call log')
          return {
            kits: calls.find((call) => call.method === 'GET' && call.path === '/api/v1/kits'),
            resultSets: calls.find((call) => call.method === 'GET' && call.path === '/api/v1/result-sets'),
          }
        },
        (value) => value.kits != null && value.resultSets != null,
        POLL_MS * 15,
        1_000,
      )
      if (calls.kits == null || calls.resultSets == null) {
        throw new Error(`no poll reached the wisdom-panel mock within ${POLL_MS * 15}ms (kits: ${calls.kits != null}, result-sets: ${calls.resultSets != null})`)
      }
      expect(calls.kits.query).toEqual({
        'filter[unacknowledged]': 'true',
        'filter[hospital_number]': env.wisdomPanel.hospitalNumber,
        include: 'pet,pet.owner',
      })
      expect(calls.resultSets.query).toEqual({
        'filter[unacknowledged]': 'true',
        'filter[hospital_number]': env.wisdomPanel.hospitalNumber,
        include: 'kit',
      })
      expect(calls.kits.headers.authorization).toBe('Bearer wisdom-panel-mock-token')
      expect(calls.resultSets.headers.authorization).toBe('Bearer wisdom-panel-mock-token')
    })
  })
})
