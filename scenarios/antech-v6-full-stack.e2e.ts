import { ApiClient, expectOk } from '../src/api-client'
import { env } from '../src/env'
import { adminLogin, seedOrganization, SeededOrg } from '../src/seed'
import { closePool } from '../src/sql'

/* PLACEHOLDER — the antech-v6 scenario is being built; this skeleton proves the profile boots and
 * the engine's api/worker split takes an integration: the admin start emits
 * `antech-v6/integration/create`, which the api process answers by scheduling the polling jobs the
 * worker process then runs against the mock. */

describe('antech-v6 full-stack (Antech V6 mock)', () => {
  let root: ApiClient
  let org: SeededOrg

  const mock = ApiClient.create(env.antechV6.mockBaseUrl)

  beforeAll(async () => {
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
        autoSubmitEnabled: true,
      },
    })
    const admin = await adminLogin(root)
    const startResponse = await admin.post(`/admin/integrations/${org.integrationId}/start`)
    console.log(
      `[antech-v6-scenario] integration start -> HTTP ${startResponse.status}: ${startResponse.text.slice(0, 200)}`,
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

    it('the antech-v6 mock is reachable', async () => {
      const response = await mock.get('/status')
      expect(response.status).toBe(200)
      expect(response.body.service).toBe('antech-v6-mock')
    })

    it('the quickstart bootstrap completed (org, antech-v6 provider config, integration)', () => {
      expect(org.organizationId).toBeTruthy()
      expect(org.providerConfigurationId).toBeTruthy()
      expect(org.integrationId).toBeTruthy()
    })
  })
})
