import { ApiClient } from '../src/api-client'
import { env } from '../src/env'

/* Proves the harness can reach a real, fully-wired dmi-api: the app booted, all migrations
 * applied, and MySQL/Mongo/ActiveMQ are all reachable from it. If this fails, nothing else in the
 * suite is meaningful. */

describe('smoke', () => {
  const api = ApiClient.create()

  it('is pointed at the harness database, not a developer database', () => {
    /* Guard against a mis-set HARNESS_* pointing this suite, which writes freely, at someone's
     * dev stack. 'diagnostic-modality-integration' is the name dmi-api's .env.example ships. */
    expect(env.mysql.database).not.toBe('diagnostic-modality-integration')
  })

  it('GET /health reports every dependency up', async () => {
    const response = await api.get('/health')

    expect(response.status).toBe(200)
    expect(response.body.status).toBe('ok')
    /* dmi-api's health controller pings all three, so a green smoke test really does mean "the
     * stack is wired", not merely "Fastify answered". */
    expect(response.body.info).toMatchObject({
      database: { status: 'up' },
      mongo: { status: 'up' },
      activemq: { status: 'up' },
    })
  })

  it('serves the OpenAPI document', async () => {
    const response = await api.get('/swagger-json')

    expect(response.status).toBe(200)
    expect(response.body.paths['/orders']).toBeDefined()
  })

  it('rejects an unauthenticated request to the data plane', async () => {
    const response = await api.get('/orders')
    expect([401, 403]).toContain(response.status)
  })

  it('rejects a bogus API key', async () => {
    const response = await api.withApiKey('not-a-real-key').get('/orders')
    expect([401, 403]).toContain(response.status)
  })

  /* DEFECT F6 — dmi-api's HTTP Basic auth is non-functional. `BasicStrategy`
   * (src/common/auth/basic.strategy.ts) is defined but appears in no module's `providers`, so
   * `@nestjs/passport` never registers it and every `POST /users` / `GET /users` throws
   * 500 "Unknown authentication strategy 'basic'" before any auth logic runs. A correct app
   * rejects an unauthenticated create with 401. This blocks the documented user-provisioning
   * flow; the seeder works around it with a direct SQL insert (see src/sql.ts). The existing
   * dmi-api "e2e" specs stub the guard, which is why this went unnoticed. Remove `.failing`
   * once Basic auth is registered. */
  it.failing('rejects an unauthenticated POST /users', async () => {
    const response = await api.post('/users', { email: 'nobody@example.test', password: 'nope' })
    expect(response.status).toBe(401)
  })

  /* DEFECT F6 (same root cause) — with the strategy unregistered, even a well-formed Basic header
   * carrying the wrong password 500s instead of a clean 401. */
  it.failing('rejects the wrong admin password on POST /users', async () => {
    const response = await api
      .withBasicAuth(env.admin.username, 'definitely-not-the-password')
      .post('/users', { email: 'nobody@example.test', password: 'nope' })
    expect(response.status).toBe(401)
  })
})
