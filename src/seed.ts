import { randomUUID } from 'crypto'
import { ApiClient, expectOk } from './api-client'
import { env } from './env'
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

/* The fast suite's provider is dmi-api's own `demo` provider, which dmi-api's migrations seed (a
 * `url` configuration option, an `apiKey` integration option). Its lab is never contacted: dmi-api
 * runs under NODE_ENV=seed, which returns from createOrder before the engine round-trip. `.invalid`
 * is reserved by RFC 2606 and guarantees a DNS failure rather than a surprise request if that ever
 * stops being true. */
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

/* Mint an admin JWT via POST /auth/admin/login (admin/admin by default). dmi-api's AdminGuard uses
 * the `admin-jwt` strategy, which only verifies the signature against JWT_SECRET_KEY and does no
 * role check, so this token authorizes the admin routes. The full-stack idexx scenario needs it to
 * POST /admin/integrations/:id/start — creating an integration leaves it status NEW and does not
 * schedule polling; the admin start is what emits `<provider>/integration/create` to the engine. */
export async function adminLogin (root: ApiClient = ApiClient.create()): Promise<ApiClient> {
  const { token } = expectOk<{ token: string }>(
    await root.post('/auth/admin/login', {
      username: env.admin.username,
      password: env.admin.password,
    }),
    'admin login',
  )
  return root.withBearer(token)
}

export interface SeedOrgOptions {
  /* Provider id in the POST /providers/:id/configurations path. Default 'demo'. */
  providerId?: string
  /* The `configuration` body posted to POST /providers/:id/configurations. Defaults to the demo
   * provider's `{ url }` shape, pointed at the unreachable DEMO_LAB_URL — fast mode never contacts
   * the provider; idexx passes `{ orderingBaseUrl, resultBaseUrl, 'X-Pims-Id', 'X-Pims-Version' }`. */
  configuration?: Record<string, unknown>
  /* integrationOptions merged into the create-integration body. Default is a dummy apiKey for the
   * demo provider; each full-stack loop passes its own provider's options (idexx's
   * username/password/locale, for example). */
  integrationOptions?: Record<string, unknown>
}

export async function seedOrganization (
  root: ApiClient,
  label: string,
  options: SeedOrgOptions = {},
): Promise<SeededOrg> {
  const suffix = unique(label)
  const email = `harness-${suffix}@example.test`
  const providerId = options.providerId ?? 'demo'
  const configuration = options.configuration ?? { url: DEMO_LAB_URL }
  const integrationOptions = options.integrationOptions ?? { apiKey: `demo-key-${suffix}` }

  /* dmi-api's POST /users is broken (dmi-api#379; see sql.insertUser). Insert the user row
   * directly; the rest of the flow below is real HTTP. */
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
    await api.post(`/providers/${providerId}/configurations`, { configuration }),
    `configure the ${providerId} provider`,
  )

  const practice = expectOk<{ id: string }>(
    await api.post('/practices', { name: `practice-${suffix}` }),
    'create practice',
  )

  const integration = expectOk<{ id: string }>(
    await api.post('/integrations', {
      practiceId: practice.id,
      providerConfigurationId: providerConfiguration.id,
      integrationOptions,
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

export interface OrderPayloadOverrides extends Record<string, unknown> {
  /* Required, and deliberately not defaulted. There is no provider-agnostic test code: every provider
   * has its own catalogue and rejects anything outside it, so a shared default is a code that is
   * wrong for every provider but the one it was written for. This used to default to `SA`, an
   * invented code that no IDEXX catalogue contains — and each new provider loop inherited it. */
  testCodes: Array<{ code: string }>
  /* Provider-specific requisition parameters, forwarded as the order's `labRequisitionInfo` and
   * checked by dmi-api against the parameters the provider declares (a required one missing is a
   * 400 before the engine is involved). No current loop needs one; a provider whose orders carry a
   * kit or requisition code (wisdom-panel's `KitCode`) supplies it here. */
  labRequisitionInfo?: Record<string, unknown>
}

export function orderPayload (
  integrationId: string,
  overrides: OrderPayloadOverrides,
): Record<string, unknown> {
  return {
    integrationId,
    requisitionId: unique('req'),
    patient: {
      name: 'Rex',
      sex: 'MALE',
      species: 'DOG',
      breed: 'LABRADOR',
      /* A caller-supplied PIMS patient id. dmi-api reconciles a provider result into its order only
       * when their `pims:patient:id` matches (ProviderResultUtils.isMatchingOrder); without one, the
       * result lands as a duplicate orphan order while the original stays SUBMITTED — a dmi-api
       * reconciliation bug tracked as nominal-systems/dmi-api#334. Supplying one (the mock echoes it
       * back in the result) is the workaround so the loop closes; it can be dropped once #334 lands.
       * The tripwires at the bottom of the idexx and antech-v3 scenarios pin the fix, one from each
       * side: an idexx order without the identifier, an antech-v3 order with it. */
      identifier: [{ system: 'pims:patient:id', value: unique('pat') }],
    },
    client: { firstName: 'Jane', lastName: 'Doe' },
    veterinarian: { firstName: 'Ann', lastName: 'Vet' },
    ...overrides,
  }
}
