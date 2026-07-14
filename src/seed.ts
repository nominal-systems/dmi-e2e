import { randomUUID } from 'crypto'
import { ApiClient, expectOk } from './api-client'
import { HARNESS_USER_PASSWORD, insertUser } from './sql'

/* Drives the developer-quickstart flow over plain HTTP, exactly as an integrator would:
 *
 *   admin (Basic) -> POST /users
 *   POST /users/auth -> JWT
 *   JWT   -> POST /organizations -> GET /organizations/:id/keys
 *   key   -> POST /providers/demo/configurations -> POST /practices -> POST /integrations
 *
 * One organization per user is a hard rule in dmi-api ("You already have an organization"), so
 * two tenants means two users. Every name is suffixed uniquely, so repeated runs against a warm
 * database never collide. */

/* The demo lab is never contacted: dmi-api runs under NODE_ENV=seed, which returns from
 * createOrder before the engine round-trip. `.invalid` is reserved by RFC 2606 and guarantees a
 * DNS failure rather than a surprise request if that ever stops being true. */
const DEMO_LAB_URL = 'http://demo-lab.invalid'

export interface SeededOrg {
  label: string
  organizationId: string
  userEmail: string
  prodKey: string
  testKey: string
  providerConfigurationId: string
  practiceId: string
  integrationId: string
  /* A client bound to this organization's production API key. */
  api: ApiClient
  /* A client bound to this organization's owner JWT. */
  jwt: ApiClient
}

export interface SeededContext {
  orgA: SeededOrg
  orgB: SeededOrg
  anonymous: ApiClient
}

function unique (label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}`
}

export async function seedOrganization (root: ApiClient, label: string): Promise<SeededOrg> {
  const suffix = unique(label)
  const email = `harness-${suffix}@example.test`

  /* F6: dmi-api's POST /users is broken (see sql.insertUser). Insert the user row directly; the
   * rest of the flow below is real HTTP. */
  await insertUser(email)

  const auth = expectOk<{ token: string }>(
    await root.post('/users/auth', { email, password: HARNESS_USER_PASSWORD }),
    `authenticate ${email}`,
  )
  const jwt = root.withBearer(auth.token)

  const organization = expectOk<{ id: string }>(
    await jwt.post('/organizations', { name: `org-${suffix}` }),
    'create organization',
  )

  const keys = expectOk<{ prodKey: string, testKey: string }>(
    await jwt.get(`/organizations/${organization.id}/keys`),
    'read organization keys',
  )
  const api = root.withApiKey(keys.prodKey)

  const providerConfiguration = expectOk<{ id: string }>(
    await api.post('/providers/demo/configurations', { configuration: { url: DEMO_LAB_URL } }),
    'configure the demo provider',
  )

  const practice = expectOk<{ id: string }>(
    await api.post('/practices', { name: `practice-${suffix}` }),
    'create practice',
  )

  const integration = expectOk<{ id: string }>(
    await api.post('/integrations', {
      practiceId: practice.id,
      providerConfigurationId: providerConfiguration.id,
      integrationOptions: { apiKey: `demo-key-${suffix}` },
    }),
    'create integration',
  )

  return {
    label,
    organizationId: organization.id,
    userEmail: email,
    prodKey: keys.prodKey,
    testKey: keys.testKey,
    providerConfigurationId: providerConfiguration.id,
    practiceId: practice.id,
    integrationId: integration.id,
    api,
    jwt,
  }
}

/* Two mutually independent tenants. Nothing links them: different owners, different provider
 * configurations, different practices, different integrations. */
export async function seed (): Promise<SeededContext> {
  const root = ApiClient.create()
  const orgA = await seedOrganization(root, 'a')
  const orgB = await seedOrganization(root, 'b')
  return { orgA, orgB, anonymous: root }
}

export function orderPayload (
  integrationId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    integrationId,
    requisitionId: unique('req'),
    patient: {
      name: 'Rex',
      sex: 'MALE',
      species: 'DOG',
      breed: 'LABRADOR',
    },
    client: { firstName: 'Jane', lastName: 'Doe' },
    veterinarian: { firstName: 'Ann', lastName: 'Vet' },
    testCodes: [{ code: 'SA' }],
    ...overrides,
  }
}
