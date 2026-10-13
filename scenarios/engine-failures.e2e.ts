import { randomUUID } from 'crypto'
import { ApiClient } from '../src/api-client'
import { seedOrganization, SeededOrg } from '../src/seed'
import { closePool } from '../src/sql'

/* What dmi-api tells the caller when the engine behind a provider route does not answer. The fast
 * suite runs no engine — the demo provider's integration RPCs a topic nobody serves — and starts
 * dmi-api with ENGINE_RESPONSE_TIMEOUT=2000, so every engine round trip here times out in 2s. That is
 * the shape of a real outage: on 2026-09-16 the IDEXX engine stopped answering within dmi-api's 90s
 * budget while IDEXX's ordering API degraded, and on 2026-09-21 one pod stopped receiving replies.
 *
 * A timeout is a 504, whichever route asked. Only a lookup that fails before the round trip — an
 * integration that does not exist — is a 404. */

describe('engine failures', () => {
  let org: SeededOrg

  beforeAll(async () => {
    org = await seedOrganization(ApiClient.create(), 'engine')
  }, 120_000)

  afterAll(async () => {
    await closePool()
  })

  /* Regression guard (dmi-api#364): `getDevices` wrapped every failure of the engine round trip in a
   * NotFoundException, so the timeout below came back as 404 — 335 times during the 2026-09-16
   * outage, each logged as `404 GET /providers/idexx/devices - "The engine did not respond in time"`.
   * The PIMS was told the devices were not found, and alerting that counts 5xx saw a healthy service.
   * The body must name the timeout, not only carry its status. */
  it('GET /providers/:id/devices reports an engine that does not answer as 504, naming the timeout', async () => {
    const response = await org.api.get(`/providers/demo/devices?integrationId=${org.integrationId}`)

    expect(response.status).toBe(504)
    expect(response.body.message).toBe('The engine did not respond in time')
  }, 30_000)

  /* The same absent engine, through a route that never had the wrapper: the two must agree. This is
   * the answer every other provider read path gave during the outage the devices route hid. */
  it('GET /providers/:id/refs reports the same absent engine as 504', async () => {
    const response = await org.api.get(`/providers/demo/refs?integrationId=${org.integrationId}`)

    expect(response.status).toBe(504)
    expect(response.body.message).toBe('The engine did not respond in time')
  }, 30_000)

  /* The one 404 the devices route keeps: the integration lookup fails before any engine is asked. A
   * well-formed id (the query must be a UUID) that names no integration. */
  it('GET /providers/:id/devices still answers 404 for an integration that does not exist', async () => {
    const response = await org.api.get(`/providers/demo/devices?integrationId=${randomUUID()}`)

    expect(response.status).toBe(404)
    expect(response.body.message).toBe('The integration was not found')
  })
})
