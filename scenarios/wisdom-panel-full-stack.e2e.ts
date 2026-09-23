import { randomUUID } from 'crypto'
import { ApiClient, expectOk } from '../src/api-client'
import { env } from '../src/env'
import { pollUntil } from '../src/poll'
import { lookupRefCode } from '../src/refs'
import { adminLogin, orderPayload, seedOrganization, SeededOrg } from '../src/seed'
import { closePool, query } from '../src/sql'

/* Full-system gate for Wisdom Panel (HARNESS_FULL_STACK=1, HARNESS_STACK=wisdom-panel): dmi-api
 * under a NORMAL NODE_ENV, wired over real MQTT/Bull/HTTP to the REAL `dmi-engine` container —
 * which is what hosts the wisdom-panel integration in production, as an npm module rather than a
 * container of its own — and a Wisdom Panel mock provider (src/wisdom-panel-mock). Every hop is
 * real except the provider, which is the mock, so the run is deterministic and never touches a live
 * Wisdom Panel host.
 *
 * WHAT IS DIFFERENT ABOUT THIS PROVIDER, and what it means for every assertion below.
 *
 * 1. AN ORDER IS A KIT ACTIVATION. Wisdom Panel is pet DNA: the clinic already holds the physical
 *    kits, and `POST /orders` activates one of them for a patient. There is no test catalogue —
 *    the provider's "services" ARE its unactivated kits, so a service code identifies one kit
 *    rather than an assay — there is no cancel, and the result is breed percentages, an ideal-weight
 *    estimate, genetic health findings and a PDF. The kit code travels as a lab-requisition
 *    parameter (`labRequisitionInfo.KitCode`, the only one dmi-api declares for this provider), and
 *    the ORDER's requisitionId is OVERWRITTEN by the provider's kit code on the way back.
 *
 * 2. THE ENGINE IS SPLIT INTO TWO PROCESSES, as production runs it, and this loop shares them with
 *    the antech-v6 loop. `dmi-engine-api` attaches the MQTT handlers dmi-api RPCs (order create,
 *    the reference-data lookups, and integration create — which SCHEDULES the repeatable Bull jobs)
 *    and `dmi-engine-worker` runs those jobs against the mock. So a kit is activated by one process
 *    and polled by the other, through Redis. The token-count test below is the sharpest proof that
 *    both are live: the mock issues exactly one token per process, because the integration caches a
 *    token in-process for ten days.
 *
 * 3. RECONCILIATION IS externalId-ONLY, the zoetis shape. `mapWisdomPanelResult` attaches no
 *    `.order` to a result, so dmi-api's patient-matching guard
 *    (`ProviderResultUtils.isMatchingOrder`) is never consulted and the `pims:patient:id`
 *    identifier is a FREE choice for reconciliation. The orders here keep the harness's default
 *    identifier anyway, because the integration sends its value as the provider's `voyager_pet_id`
 *    — so carrying it is what makes that field assertable. The id that matters is
 *    `kit id == externalId == result.orderId`.
 *
 * 4. WHICH CHANNEL CAN SATISFY A COMPLETION ASSERTION? Both, here — which is why the completion
 *    tests wait on the REPORT reaching FINAL rather than on the order reaching COMPLETED. A kit
 *    whose report is ready reads `current-stage: 'report-ready'`, and `mapKitStatus` sends that to
 *    dmi COMPLETED, so the ORDERS poll could move the order on its own. It does not in fact get the
 *    chance (the mock does not model re-notification, so a kit acknowledged at activation never
 *    returns to the unacknowledged feed), but "does not get the chance" is a weaker claim than "the
 *    report can only be written by the results channel", which is true unconditionally: dmi-api
 *    sets a report FINAL in exactly one place, on the `external_results` path. So FINAL is the
 *    assertion that means what it says, and the order's COMPLETED is checked after it.
 *
 * 5. REF MAPPING IS THE ONLY TRANSFORMATION ON THE WAY OUT, and it is silently defaulting. The
 *    integration's `mapPetSpecies`/`mapPetSex` fall back to `'dog'`/`'male'` for anything they do
 *    not recognise, so an order for a DOG or a MALE would reach the mock correctly with the mapping
 *    completely broken. Every order placed below is therefore for a CAT and a FEMALE, placed with
 *    dmi's canonical ref codes, and the assertion is that `'cat'` and `'female'` arrived at the
 *    provider. A broken mapping goes red naming `dog` or `male`.
 *
 * WHAT MAKES THESE ASSERTIONS WORTH ANYTHING is that the mock VALIDATES rather than defaults: it
 * refuses an activation missing any required field, an unknown or already-activated kit code, a
 * species or sex outside the enums, an organization unit that is not its own, a call with no bearer,
 * an unknown `filter[...]` key, and — as the live server does — an `Accept` header a strict JSON:API
 * implementation would refuse. A mock that substituted its own values would make the forwarding
 * assertions below pass against its own invention. */

/* The compose profile's WISDOM_PANEL_POLLING_INTERVAL_MS (the engine's own default is 10 minutes). */
const POLL_MS = 3_000

/* Generous multiples of the poll interval rather than tight ones: the first tick only happens once
 * the integration's start event has been handled and the repeatable jobs scheduled, and a failed
 * job is retried three times with exponential backoff before the next repeat takes over. */
const COMPLETION_WAIT_MS = 60_000
const ORDER_WAIT_MS = 45_000
/* How long to wait before concluding that something did NOT happen. Used by the tripwires and by
 * the foreign-hospital negative, where a short budget is the point. */
const NEGATIVE_WAIT_MS = 25_000

/* ---- ref mapping ----
 *
 * dmi-api seeds NO wisdom-panel `provider_ref` rows, so this scenario does what an operator does:
 * it reads the provider's reference data through the engine, stores it, and maps canonical dmi refs
 * onto provider refs. For this provider the "reference data" never leaves the integration — species
 * and sexes are LOCAL enums in `wisdom-panel.service.ts` and `getBreeds` is `[]` — so the mock is
 * not consulted at all and the round trip is dmi-api -> MQTT -> the engine -> the integration.
 *
 * The pairing is the whole point. dmi's canonical codes are opaque UUIDs, looked up BY NAME so no
 * UUID rots in this file; what must come out the other end is the provider's own `'cat'` and
 * `'female'`. `Canis familiaris` and `Male` are deliberately left UNMAPPED, because they are what
 * the integration's silent defaults would produce — so mapping them would make the assertions
 * unfalsifiable. */
const SPECIES_REF_NAME = 'Felidae'
const EXPECTED_SPECIES = 'cat'
const SEX_REF_NAME = 'Female'
const EXPECTED_SEX = 'female'
/* Left unmapped on purpose: these are exactly the integration's own fallbacks. */
const UNMAPPED_SPECIES_REF_NAME = 'Canis familiaris'
const UNMAPPED_SEX_REF_NAME = 'Male'

/* The provider's reference data, which lives in the integration rather than at the provider. */
const PROVIDER_SPECIES = [
  { code: 'dog', name: 'CANINE' },
  { code: 'cat', name: 'FELINE' },
]
const PROVIDER_SEXES = [
  { code: 'male', name: 'MALE' },
  { code: 'female', name: 'FEMALE' },
]

/* ---- kit codes ----
 *
 * The mock's unactivated inventory. Unlike every other loop these are INVENTED rather than genuine
 * catalogue identifiers, and unavoidably so: a Wisdom Panel service code names one physical kit,
 * not an assay, so there is no published vocabulary to reuse. Each is used by exactly one test, so
 * a red run names the test that burned it. */
const KIT_ACTIVATION = 'WPKIT-0001'
const KIT_ARRAY_FINDINGS = 'WPKIT-0002'
const KIT_DUPLICATE = 'WPKIT-0003'
const KIT_CANCEL = 'WPKIT-0004'
const KIT_BATCH_HEALTHY = 'WPKIT-0005'
const KIT_BATCH_PDF_FAILS = 'WPKIT-0006'
const KIT_EMPTY_SECTIONS = 'WPKIT-0007'

/* Provider-side kits, provisioned through the mock's control plane rather than activated through
 * dmi — the clinic activating a kit in the vendor's own UI, which is what the integration's status
 * mapping exists to serve. */
const KIT_PROVIDER_PARTIAL = 'WPKIT-P001'
const KIT_PROVIDER_FAILED = 'WPKIT-P002'
const KIT_PROVIDER_FOREIGN = 'WPKIT-P003'
const KIT_PROVIDER_RESUMED = 'WPKIT-P004'
const KIT_PETLESS = 'WPKIT-P005'

/* A hospital the seeded integration is not configured for. The mock holds its kits and its feeds
 * scope them away, which is what the negative below proves. */
const FOREIGN_HOSPITAL_NUMBER = '700002'
/* A third hospital, used only for a direct probe of the pet-less page shape, so that page can never
 * reach the engine's own poll. */
const PROBE_HOSPITAL_NUMBER = '700003'

/* ---- seeded result content ----
 *
 * Every breed, disease, value and sentence here is INVENTED. Breed slugs and disease names are
 * reference vocabulary rather than identity, but nothing below is copied from a captured result.
 *
 * Four breeds with DISTINCT integer percentages summing to 100 (the shape the live bodies carry),
 * so a mapper that mixed two of them up cannot pass; three distinct ideal-weight numbers for the
 * same reason. The mock's control plane enforces both, with an explanatory error. */
const BREEDS = [
  { percentage: 52, slug: 'harness-shorthair', name: 'Harness Shorthair', internalName: 'HarnessShorthair' },
  { percentage: 27, slug: 'harness-longhair', name: 'Harness Longhair', internalName: 'HarnessLonghair' },
  { percentage: 13, slug: 'harness-rex', name: 'Harness Rex', internalName: 'HarnessRex' },
  { percentage: 8, slug: 'harness-bobtail', name: 'Harness Bobtail', internalName: 'HarnessBobtail' },
]
const IDEAL_WEIGHT = { min: 3.4, max: 5.9, pred: 4.6 }
/* The STRING form of the health findings, which 40 of the 51 live result sets carry. Written here
 * rather than copied: the vendor's own sentence names a patient. */
const NOTABLE_NONE = 'No notable or at-risk health test results were found for this patient.'

/* The ARRAY form, which the live data also carries. Two entries, so the mapper's per-entry
 * `seq: i*2` / `seq: i*2 + 1` pairing is exercised over more than a singleton. */
const NOTABLE_FINDINGS = [
  {
    copies: 1,
    resultValue: 'Carrier',
    testName: 'Harness Myopathy Panel',
    diseaseName: 'Harness Myopathy',
    slug: 'harness-myopathy',
    uiDescription: 'One copy of the variant was detected. Carriers are not expected to be affected.',
  },
  {
    copies: 2,
    resultValue: 'At Risk',
    testName: 'Harness Retinal Panel',
    diseaseName: 'Harness Retinal Atrophy',
    slug: 'harness-retinal-atrophy',
    uiDescription: 'Two copies of the variant were detected. Discuss monitoring with the owner.',
  },
]

/* The breed list for the empty-sections body: normal percentages alongside the empty ideal weight
 * and empty findings, which is what the live kits with that body look like. */
const BREEDS_SINGLE = [
  { percentage: 100, slug: 'harness-domestic', name: 'Harness Domestic', internalName: 'HarnessDomestic' },
]

interface Observation {
  code: string
  name?: string
  status?: string
  valueQuantity?: { value?: number, units?: string | null } | null
  valueString?: string | null
  interpretation?: { code?: string, text?: string } | null
  notes?: string | null
}

interface TestResultSet {
  code: string
  name?: string
  observations?: Observation[]
}

interface ReportBody {
  id: string
  status: string
  testResultsSet?: TestResultSet[]
}

interface MockPet {
  id: string
  name: string
  sex: string
  species: string
  ownerFirstName: string | null
  ownerLastName: string
}

interface MockKit {
  id: string
  code: string
  organizationIdentity: string | null
  activated: boolean
  currentStage: string | null
  currentFailure: string | null
  acknowledged: boolean
  hospitalNumber: string | null
  hospitalName: string | null
  veterinarianName: string | null
  voyagerPetId: string | null
  pdfFailure: string | null
  pet: MockPet | null
  resultSetId: string | null
  simplifiedFetches: number
  pdfFetches: number
}

interface MockCall {
  seq: number
  method: string
  path: string
  query: Record<string, string>
  accept: string | null
  authorization: string | null
  body: any
}

interface MockCallLog {
  counters: Record<string, number>
  fetches: { simplified: Record<string, number>, pdf: Record<string, number> }
  tokens: string[]
  acceptBearers: boolean
  lastSeq: number
  calls: MockCall[]
}

/* dmi-api's ref types, as the `ref`/`provider_ref` tables spell them: SINGULAR. The public
 * `GET /refs/<kind>` routes use the plural; the admin ones pass the path value straight into the
 * query, so they need the singular. */
type RefType = 'species' | 'sex'

describe('wisdom-panel full-stack (Wisdom Panel mock)', () => {
  let root: ApiClient
  let org: SeededOrg
  let admin: ApiClient

  /* Host-facing client for the mock's control plane (/__control__/*). The provider endpoints are
   * probed with plain `fetch` instead, because they need an `Accept` this client does not send and
   * a bearer rather than one of dmi-api's auth schemes. */
  const mock = ApiClient.create(env.wisdomPanel.mockBaseUrl)

  /* The provider's reference data, read through the engine at setup. */
  let liveSpecies: Array<{ code: string, name: string }> = []
  let liveSexes: Array<{ code: string, name: string }> = []
  let liveBreeds: Array<{ code: string, name: string }> = []
  /* What the admin ref sync did, recorded rather than asserted — the tripwire reports it. */
  let syncResponse: { status: number, ok: boolean, text: string } = { status: 0, ok: false, text: '' }
  let speciesRefsAfterSync = -1
  let providerRefsWereSeededDirectly = false

  /* Canonical dmi ref codes (opaque UUIDs), resolved by name at setup. */
  let speciesRefCode = ''
  let sexRefCode = ''
  let unmappedSpeciesRefCode = ''
  let unmappedSexRefCode = ''

  /* The mock's inventory as it stood before any activation, used by the services assertion. */
  let inventoryAtSetup: Array<{ code: string, name: string | null }> = []

  /* The headline activation. */
  let activationOrderId = ''
  let activationKitId = ''
  let activationPatientId = ''
  let activationReportId = ''

  /* The empty-sections result set, seeded by a test in the results section and read back by its
   * tripwire at the bottom of the file. */
  let emptySectionsOrderId = ''
  /* The PDF-failure batch pair, placed by the tripwire that poisons the results poll and read back
   * by the positive twin that follows it. */
  const batchOrderIds: { healthy: string, broken: string } = { healthy: '', broken: '' }

  /* A bearer the scenario mints for itself, so the direct provider probes below look like the
   * integration rather than like the control plane. */
  let probeToken = ''

  function patientFor (overrides: Record<string, unknown> = {}): Record<string, unknown> {
    /* NOTE the shape: `orderPayload`'s `patient:` override REPLACES the whole default patient,
     * identifier included, so everything that must survive is merged in here rather than assumed.
     * The identifier matters twice over for this provider: it becomes the provider's
     * `voyager_pet_id`, which is the only patient id the vendor ever sees. */
    return {
      name: 'Nutmeg',
      sex: sexRefCode,
      species: speciesRefCode,
      /* The integration never sends a breed (`getBreeds` is `[]` and the mapper has no breed
       * field), so this is forwarding only — it exists so the order is a realistic one. */
      breed: 'Domestic Shorthair',
      birthdate: '2019-05-07',
      identifier: [{ system: 'pims:patient:id', value: `pat-${randomUUID().slice(0, 8)}` }],
      ...overrides,
    }
  }

  function payloadFor (kitCode: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return orderPayload(org.integrationId, {
      patient: patientFor(),
      /* dmi's own service code for this provider is the kit code: `getServices` maps each
       * unactivated kit to `{code: <kit code>, name: <organization-identity>}`. */
      testCodes: [{ code: kitCode.trim().toUpperCase() }],
      labRequisitionInfo: { KitCode: kitCode },
      ...overrides,
    })
  }

  async function mockKit (key: string): Promise<MockKit> {
    return expectOk<MockKit>(
      await mock.get(`/__control__/kits/${encodeURIComponent(key)}`),
      `read kit ${key} from the mock control plane`,
    )
  }

  async function mockCalls (options: { path?: string, method?: string, since?: number } = {}): Promise<MockCallLog> {
    return expectOk<MockCallLog>(
      await mock.get('/__control__/calls', {
        path: options.path,
        method: options.method,
        since: options.since,
      }),
      'read the mock call log',
    )
  }

  async function provisionKit (body: Record<string, unknown>): Promise<MockKit> {
    return expectOk<MockKit>(
      await mock.post('/__control__/kits', body),
      `provision kit ${String(body.code)} at the mock`,
    )
  }

  async function seedResultSet (kitCode: string, body: Record<string, unknown>): Promise<{ id: string }> {
    return expectOk<{ id: string }>(
      await mock.post(`/__control__/kits/${encodeURIComponent(kitCode)}/result-sets`, body),
      `seed a result set for kit ${kitCode}`,
    )
  }

  async function reportFor (orderId: string): Promise<ReportBody> {
    return expectOk<ReportBody>(await org.api.get(`/orders/${orderId}/report`), `read the report for order ${orderId}`)
  }

  async function panelsFor (orderId: string): Promise<TestResultSet[]> {
    return (await reportFor(orderId)).testResultsSet ?? []
  }

  async function orderByExternalId (externalId: string): Promise<{ id: string, externalId: string, status: string } | undefined> {
    const orders = expectOk<Array<{ id: string, externalId: string, status: string }>>(
      await org.api.get('/orders'),
      'list the organization\'s orders',
    )
    return orders.find((order) => order.externalId === externalId)
  }

  async function services (): Promise<Array<{ code: string, name: string | null }>> {
    return expectOk<Array<{ code: string, name: string | null }>>(
      await org.api.get('/providers/wisdom-panel/services', { integrationId: org.integrationId }),
      'read the wisdom-panel service list',
    )
  }

  /* Admin helpers for the ref sync + mapping, the same shape the antech-v6 scenario uses. Both
   * admin listings need an explicit `page` (their query is typed as an intersection rather than a
   * DTO class, so the validation pipe never applies the `page = 1` default and omitting it is a
   * 500), and `GET /admin/refs/:type` uses the path value verbatim as `ref.type = :type`, where the
   * column holds the SINGULAR. */
  async function canonicalRefId (type: RefType, name: string): Promise<number> {
    const listing = expectOk<{ data: Array<{ id: number, name: string, code: string }> }>(
      await admin.get(`/admin/refs/${type}`, { search: name, page: 1, limit: 200 }),
      `list dmi ${type} refs matching '${name}'`,
    )
    const matches = listing.data.filter((ref) => ref.name === name)
    if (matches.length !== 1) {
      throw new Error(
        `expected exactly one dmi ${type} ref named '${name}', found ${matches.length}. ` +
          "dmi-api's ref seed has changed; pick a ref with a unique name.",
      )
    }
    return matches[0].id
  }

  async function providerRefs (type: RefType): Promise<Array<{ id: number, code: string, name: string }>> {
    const listing = expectOk<{ data: Array<{ id: number, code: string, name: string }> }>(
      await admin.get(`/admin/providers/wisdom-panel/refs/${type}`, { page: 1, limit: 200 }),
      `list wisdom-panel ${type} provider refs`,
    )
    return listing.data
  }

  /* Write provider_ref rows straight into MySQL. The one sanctioned crack in the black box (see
   * src/sql.ts): no HTTP route creates a provider_ref, and the admin route that should is broken
   * (the tripwire at the bottom pins it). The rows are built from the lists the ENGINE returned
   * this run, never from literals here, so what dmi-api ends up holding is still the provider's own
   * data rather than this file's opinion of it. */
  async function insertProviderRefs (type: RefType, items: Array<{ code: string, name: string }>): Promise<void> {
    for (const item of items) {
      await query(
        'INSERT INTO `provider_ref` (`code`, `name`, `species`, `type`, `provider`) VALUES (?, ?, ?, ?, ?)',
        [item.code, item.name, null, type, 'wisdom-panel'],
      )
    }
  }

  async function mapRef (type: RefType, refName: string, providerCode: string): Promise<void> {
    const refId = await canonicalRefId(type, refName)
    const providerRef = (await providerRefs(type)).find((entry) => entry.code === providerCode)
    if (providerRef === undefined) {
      throw new Error(
        `dmi-api holds no wisdom-panel ${type} provider ref with code '${providerCode}' — ` +
          'either the reference data never reached it or the integration\'s enum changed',
      )
    }
    expectOk(
      await admin.post(`/admin/refs/${refId}/mapping`, {
        providerId: 'wisdom-panel',
        providerRefId: providerRef.id,
      }),
      `map dmi ${type} '${refName}' to wisdom-panel ${type} '${providerCode}'`,
    )
  }

  /* The provider endpoints need a bearer and an `Accept` the mock's JSON:API half will take, so
   * the direct probes below go out over plain fetch rather than through the harness's ApiClient
   * (which always sends `Accept: application/json` — a 406 here, deliberately). */
  async function mintProbeToken (): Promise<string> {
    const response = await fetch(`${env.wisdomPanel.mockBaseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: env.wisdomPanel.username,
        password: env.wisdomPanel.password,
        grant_type: 'password',
        scope: 'organization',
      }),
    })
    const body = (await response.json()) as { access_token: string }
    if (response.status !== 200 || typeof body.access_token !== 'string') {
      throw new Error(`could not mint a probe token at the mock: HTTP ${response.status}`)
    }
    return body.access_token
  }

  beforeAll(async () => {
    /* A fresh container starts clean; the reset only matters for warm reruns (HARNESS_KEEP_UP),
     * where it clears the previous run's activations and result sets. */
    await mock.post('/__control__/reset').catch(() => undefined)

    inventoryAtSetup = expectOk<{ kits: Array<{ code: string, name: string | null }> }>(
      await mock.get('/__control__/inventory'),
      'read the mock kit inventory',
    ).kits

    root = ApiClient.create()
    org = await seedOrganization(root, 'wisdom-panel', {
      providerId: 'wisdom-panel',
      /* Note the inverted split: for this provider the CREDENTIALS are provider configuration
       * (org-level) and the integration options carry only the clinic's identity. Every other loop
       * is the other way round. */
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

    admin = await adminLogin(root)

    /* Start the integration FIRST: the reference-data lookups RPC the engine, and the engine only
     * answers for a running integration once its module is up. Starting also schedules the
     * repeatable Bull jobs, which is what makes the loop below run at all. */
    const startResponse = await admin.post(`/admin/integrations/${org.integrationId}/start`)
    console.log(
      `[wisdom-panel-scenario] integration start -> HTTP ${startResponse.status}: ${startResponse.text.slice(0, 200)}`,
    )
    expectOk(startResponse, 'start integration')

    /* Read the provider's reference data through the engine — the same RPC dmi-api's admin sync
     * makes, answered and handed straight back without being stored. For this provider the answer
     * comes from the integration's own local enums rather than from the mock, which is the only
     * place that is visible from outside. */
    liveSpecies = expectOk<{ items: Array<{ code: string, name: string }> }>(
      await org.api.get('/refs/species/wisdom-panel', { integrationId: org.integrationId }),
      'read the wisdom-panel species list through the engine',
    ).items
    liveSexes = expectOk<{ items: Array<{ code: string, name: string }> }>(
      await org.api.get('/refs/sexes/wisdom-panel', { integrationId: org.integrationId }),
      'read the wisdom-panel sex list through the engine',
    ).items
    liveBreeds = expectOk<{ items: Array<{ code: string, name: string }> }>(
      await org.api.get('/refs/breeds/wisdom-panel', { integrationId: org.integrationId }),
      'read the wisdom-panel breed list through the engine',
    ).items

    /* The operator's real path: dmi-api asks the engine for those lists and UPSERTS them as
     * `provider_ref` rows, which is the only thing that makes a canonical ref mappable to a
     * provider code. Attempted here rather than asserted, because it does not work — see the
     * tripwire below, which pins the correct behaviour and reports what actually happened. */
    syncResponse = await admin.post('/admin/refs/sync/wisdom-panel', undefined, {
      integrationId: org.integrationId,
    })
    console.log(
      `[wisdom-panel-scenario] refs sync -> HTTP ${syncResponse.status}: ${syncResponse.text.slice(0, 300)}`,
    )
    speciesRefsAfterSync = (await providerRefs('species')).length

    if (speciesRefsAfterSync === 0) {
      /* Fallback, so the ref-MAPPING coverage below is not lost to the sync defect. Species and
       * sexes only: this provider publishes no breeds, so there is nothing to insert and a breed
       * row here would be the test inventing provider data. */
      await insertProviderRefs('species', liveSpecies)
      await insertProviderRefs('sex', liveSexes)
      providerRefsWereSeededDirectly = true
      console.log(
        '[wisdom-panel-scenario] the admin ref sync stored nothing; provider refs seeded directly from ' +
          'the lists the engine returned (see the ref-sync tripwire)',
      )
    }

    speciesRefCode = await lookupRefCode(org.api, 'species', SPECIES_REF_NAME)
    sexRefCode = await lookupRefCode(org.api, 'sexes', SEX_REF_NAME)
    unmappedSpeciesRefCode = await lookupRefCode(org.api, 'species', UNMAPPED_SPECIES_REF_NAME)
    unmappedSexRefCode = await lookupRefCode(org.api, 'sexes', UNMAPPED_SEX_REF_NAME)

    await mapRef('species', SPECIES_REF_NAME, EXPECTED_SPECIES)
    await mapRef('sex', SEX_REF_NAME, EXPECTED_SEX)

    probeToken = await mintProbeToken()
  }, 180_000)

  afterAll(async () => {
    /* Stop this integration so its Bull jobs are removed. They live in the shared Redis, which
     * survives between runs under HARNESS_KEEP_UP; leaving them scheduled would let a prior run's
     * engine keep polling the mock and race a later run for its results. */
    if (admin != null && org?.integrationId != null) {
      await admin.post(`/admin/integrations/${org.integrationId}/stop`).catch(() => undefined)
    }
    await closePool()
  })

  describe('the full stack booted and is wired', () => {
    it('dmi-api is healthy under a normal NODE_ENV', async () => {
      const response = await root.get('/health')

      expect(response.status).toBe(200)
      expect(response.body.status).toBe('ok')
      expect(response.body.info).toMatchObject({
        database: { status: 'up' },
        mongo: { status: 'up' },
        activemq: { status: 'up' },
      })
    })

    it('the wisdom-panel mock is reachable', async () => {
      const response = await mock.get('/status')

      expect(response.status).toBe(200)
      expect(response.body.status).toBe('ok')
      expect(response.body.service).toBe('wisdom-panel-mock')
    })

    it('the quickstart bootstrap completed (org, wisdom-panel provider config, integration)', async () => {
      expect(org.organizationId).toBeTruthy()
      expect(org.providerConfigurationId).toBeTruthy()
      expect(org.integrationId).toBeTruthy()

      /* The mock and the harness must agree about the organization unit and the hospital, or the
       * activation below would be refused and the feeds would read empty for reasons no later test
       * could name. Pinning them against each other here turns that into a named failure now. */
      const config = expectOk<{ username: string, organizationUnitId: string, hospitalNumber: string, tokenExpiresIn: number }>(
        await mock.get('/__control__/config'),
        'read the mock configuration',
      )
      expect(config.username).toBe(env.wisdomPanel.username)
      expect(config.organizationUnitId).toBe(env.wisdomPanel.organizationUnitId)
      expect(config.hospitalNumber).toBe(env.wisdomPanel.hospitalNumber)
      /* 40 days, as OBSERVED. Not decoration: the integration caches the token for
       * `expires_in * 0.25`, so a missing or non-numeric value makes that TTL NaN. */
      expect(config.tokenExpiresIn).toBe(3_456_000)
    })

    it('the worker polls both feeds at the mock, as a bearer, scoped to the hospital, with an Accept the server accepts', async () => {
      const log = await pollUntil(
        async () => await mockCalls(),
        (value) =>
          value.calls.some((call) => call.path === '/api/v1/kits') &&
          value.calls.some((call) => call.path === '/api/v1/result-sets'),
        POLL_MS * 15,
        1_000,
      )
      const kits = log.calls.find((call) => call.method === 'GET' && call.path === '/api/v1/kits')
      const resultSets = log.calls.find((call) => call.method === 'GET' && call.path === '/api/v1/result-sets')
      if (kits === undefined || resultSets === undefined) {
        throw new Error(
          `no poll reached the wisdom-panel mock within ${POLL_MS * 15}ms ` +
            `(kits: ${kits !== undefined}, result-sets: ${resultSets !== undefined})`,
        )
      }

      /* The exact queries `getUnacknowledgedKitsForHospital` and
       * `getUnacknowledgedResultSetsForHospital` build. The hospital number is an INTEGRATION
       * option, so a poll carrying it is proof the option reached the engine. */
      expect(kits.query).toEqual({
        'filter[unacknowledged]': 'true',
        'filter[hospital_number]': env.wisdomPanel.hospitalNumber,
        include: 'pet,pet.owner',
      })
      expect(resultSets.query).toEqual({
        'filter[unacknowledged]': 'true',
        'filter[hospital_number]': env.wisdomPanel.hospitalNumber,
        include: 'kit',
      })

      /* The polls carry a bearer the mock issued, not an invented string. */
      expect(log.tokens).toContain(String(kits.authorization).replace('Bearer ', ''))
      expect(log.tokens).toContain(String(resultSets.authorization).replace('Bearer ', ''))

      /* THE ACCEPT HEADER IS LOAD-BEARING and the integration only passes by luck: it sets no
       * `Accept` at all, so axios's default arrives — and the only reason a strict JSON:API server
       * takes it is the total wildcard at the end of that list. The mock answers a bare
       * `Accept: application/json` with a 406, exactly as the live server does (pinned directly in
       * "the mock refuses, in the provider's own dialects, ..." below), so a well-meant tidy-up in
       * the integration would go red here rather than in production. */
      expect(kits.accept).toContain('*/*')
      expect(resultSets.accept).toContain('*/*')
    }, POLL_MS * 15 + 30_000)

    it('the engine reports the provider\'s species, sexes and (empty) breeds from its own local enums', () => {
      /* The round trip itself: dmi-api -> MQTT -> the engine -> the integration, fetched at setup
       * through `GET /refs/<kind>/wisdom-panel`. Unlike every other loop the provider is NOT
       * consulted — `getSpecies`, `getSexes` and `getBreeds` are local enums in the integration —
       * so these three lists are the only place that code is observable from outside.
       *
       * The exact values matter twice: they are what the provider_ref rows are built from, and the
       * `code` side of each pair is the vocabulary the mock enforces at activation. */
      expect(liveSpecies).toEqual(PROVIDER_SPECIES)
      expect(liveSexes).toEqual(PROVIDER_SEXES)
      /* Genuinely empty, and asserted as such: `getBreeds` returns `[]`, so a breed can never be
       * ref-mapped for this provider and the mapper never sends one. */
      expect(liveBreeds).toEqual([])
    })

    it('dmi-api holds wisdom-panel provider refs matching those lists, with the canonical refs mapped onto them', async () => {
      /* dmi-api ships no wisdom-panel provider_ref rows: everything here was produced this run,
       * from the lists the engine returned above (by the admin sync when it works — see the
       * tripwire — and otherwise by the setup's direct insert of those same lists). A canonical ref
       * can only be mapped to a provider code that exists as a row, so this is the precondition for
       * every mapping assertion below. */
      const species = await providerRefs('species')
      const sexes = await providerRefs('sex')

      expect(species.map((ref) => ({ code: ref.code, name: ref.name })).sort((a, b) => a.code.localeCompare(b.code)))
        .toEqual([...PROVIDER_SPECIES].sort((a, b) => a.code.localeCompare(b.code)))
      expect(sexes.map((ref) => ({ code: ref.code, name: ref.name })).sort((a, b) => a.code.localeCompare(b.code)))
        .toEqual([...PROVIDER_SEXES].sort((a, b) => a.code.localeCompare(b.code)))

      /* The mapping itself, read back from the admin listing: the canonical ref must carry a
       * wisdom-panel provider ref with the expected code. Without this the order below would still
       * be placed — with the dmi UUID forwarded raw, which the integration would silently default
       * to `dog`/`male`. */
      const mappingFor = async (type: RefType, name: string): Promise<string | undefined> => {
        const listing = expectOk<{ data: Array<{ name: string, providerRef?: Array<{ code: string, provider?: { id: string } }> }> }>(
          await admin.get(`/admin/refs/${type}`, { search: name, page: 1, limit: 200 }),
          `list dmi ${type} refs matching '${name}'`,
        )
        const ref = listing.data.find((entry) => entry.name === name)
        return (ref?.providerRef ?? []).find((entry) => entry.provider?.id === 'wisdom-panel')?.code
      }
      expect(await mappingFor('species', SPECIES_REF_NAME)).toBe(EXPECTED_SPECIES)
      expect(await mappingFor('sex', SEX_REF_NAME)).toBe(EXPECTED_SEX)

      /* Guards the falsifiability of every mapping assertion below. `mapPetSpecies` and
       * `mapPetSex` default SILENTLY to `dog` and `male`, so the two refs the orders are placed
       * with must be the ones that are NOT those defaults, and their canonical codes must not
       * already read like the provider's. */
      expect(speciesRefCode).toBeTruthy()
      expect(sexRefCode).toBeTruthy()
      expect(speciesRefCode).not.toBe(EXPECTED_SPECIES)
      expect(sexRefCode).not.toBe(EXPECTED_SEX)
      expect(unmappedSpeciesRefCode).not.toBe(speciesRefCode)
      expect(unmappedSexRefCode).not.toBe(sexRefCode)
      expect(await mappingFor('species', UNMAPPED_SPECIES_REF_NAME)).toBeUndefined()
      expect(await mappingFor('sex', UNMAPPED_SEX_REF_NAME)).toBeUndefined()
    })

    it('GET /providers/wisdom-panel/services is the mock\'s unactivated kit inventory, nameless kits included', async () => {
      /* This provider has no test catalogue: `getServices` is
       * `filter[activated]=false&filter[voyager_kits]=true` mapped to
       * `{code: <kit code>, name: <organization-identity>}`. So the "service list" is the physical
       * kits the clinic is holding, and a kit the organization has not labelled has a NULL name —
       * OBSERVED live, and reproduced by the mock rather than smoothed over, because an operator
       * really does see nameless services. A mock that invented a name for every kit would hide
       * that, and would also make this assertion unable to notice `organization-identity` being
       * dropped. */
      const list = await services()

      expect(list).toEqual(inventoryAtSetup)
      expect(list.length).toBeGreaterThanOrEqual(4)
      expect(list.map((service) => service.code)).toContain(KIT_ACTIVATION)
      expect(list.some((service) => service.name === null)).toBe(true)
      expect(list.some((service) => typeof service.name === 'string' && service.name !== '')).toBe(true)
    }, 30_000)

    it('the mock issued exactly one token per engine process, and every later call bore one of them', async () => {
      /* The integration caches its token per username IN PROCESS for `expires_in * 0.25` — ten days
       * at the vendor's 40-day expiry — and never re-authenticates. So the login count is a direct
       * read of how many engine processes have talked to the provider: the `worker` logged in for
       * its polls, and the `api` process logged in for the services call in the previous test. Two
       * is therefore the shape of a healthy two-process engine; one would mean the split collapsed,
       * and three or more would mean the cache stopped working (or a container restarted). */
      const log = await mockCalls()

      expect(log.counters.login).toBe(2)
      expect(log.tokens).toHaveLength(2)

      /* And no request after those two logins went out with anything else. The token strings are
       * the mock's own, minted this run. */
      const bearers = new Set(
        log.calls
          .filter((call) => call.path !== '/oauth/token')
          .map((call) => String(call.authorization ?? '').replace('Bearer ', '')),
      )
      expect([...bearers].every((token) => log.tokens.includes(token))).toBe(true)
      expect(bearers.size).toBeGreaterThan(0)
    })
  })

  describe('activation: an order is a kit activation', () => {
    it('POST /orders activates the kit: SUBMITTED, externalId is the kit id, requisitionId OVERWRITTEN to the kit code', async () => {
      const kitBefore = await mockKit(KIT_ACTIVATION)
      expect(kitBefore.activated).toBe(false)
      activationKitId = kitBefore.id

      /* Lower case and padded on purpose: the integration does
       * `labRequisitionInfo.KitCode.toUpperCase().trim()` before sending it, and the mock's
       * inventory holds the upper-case form and matches EXACTLY — so an integration that stopped
       * normalising is refused here rather than quietly accepted. */
      const payload = payloadFor(` ${KIT_ACTIVATION.toLowerCase()} `)
      const sentRequisitionId = payload.requisitionId as string
      activationPatientId = (payload.patient as any).identifier[0].value

      const created = expectOk<{ id: string, externalId: string, requisitionId: string, status: string }>(
        await org.api.post('/orders', payload),
        'activate a Wisdom Panel kit through POST /orders',
      )
      activationOrderId = created.id

      expect(activationOrderId).toBeTruthy()
      expect(created.status).toBe('SUBMITTED')
      /* The kit id, minted by the provider, is the whole of reconciliation here. */
      expect(created.externalId).toBe(activationKitId)
      /* And the requisitionId the caller sent is REPLACED by the provider's kit code —
       * `OrderCreatedResponse.requisitionId` is `Object.assign`ed over the order. Pinned both ways
       * so a change in either direction is named. */
      expect(created.requisitionId).toBe(KIT_ACTIVATION)
      expect(created.requisitionId).not.toBe(sentRequisitionId)
    }, 60_000)

    it('the mock received the exact snake_case activation body, with the ref-mapped species and sex', async () => {
      const log = await mockCalls({ path: '/api/voyager/pet', method: 'POST' })
      const activation = log.calls[log.calls.length - 1]
      expect(activation).toBeDefined()

      const placed = expectOk<{ client: { id: string } }>(
        await org.api.get(`/orders/${activationOrderId}`),
        'read the placed order back',
      )

      /* The WHOLE body, not a subset: `toEqual` pins that nothing extra is sent either. The write
       * side is snake_case while the read side is kebab-case — one API, two casings — so a mapper
       * that drifted onto the read casing would fail here rather than at the provider.
       *
       * THE POINT OF THIS TEST is `species: 'cat'` and `sex: 'female'`. They are the only order
       * fields dmi-api transforms on the way to the provider, and the integration's own
       * `mapPetSpecies`/`mapPetSex` default SILENTLY to `dog`/`male` — so a mapping that stopped
       * resolving would produce a perfectly well-formed activation for the wrong animal. The order
       * was placed with dmi's canonical `Felidae`/`Female` UUIDs, which are deliberately nothing
       * like these two strings. */
      expect(activation.body.data).toEqual({
        organization_unit_id: env.wisdomPanel.organizationUnitId,
        code: KIT_ACTIVATION,
        species: EXPECTED_SPECIES,
        name: 'Nutmeg',
        sex: EXPECTED_SEX,
        /* Hard-coded `true` by the mapper: there is no neuter status in dmi's sex refs that the
         * integration consults. Pinned so a change is a named failure. */
        intact: true,
        voyager_pet_id: activationPatientId,
        /* `patient.birthdate` split on '-', as STRINGS, day first in the payload. */
        birth_day: '07',
        birth_month: '05',
        birth_year: '2019',
        client_first_name: 'Jane',
        client_last_name: 'Doe',
        /* The harness sends no `pims:client:id` identifier, so the mapper falls back to the dmi
         * client's own id. Asserted against the order dmi-api holds rather than against a literal:
         * it is a uuid minted at order creation. */
        client_pet_id: placed.client.id,
        hospital_name: env.wisdomPanel.hospitalName,
        hospital_number: env.wisdomPanel.hospitalNumber,
        hospital_phone_number: env.wisdomPanel.hospitalPhone,
        veterinarian_name: 'Ann Vet',
      })

      /* The provider's own record of what the activation did. `waiting` is the first post-activation
       * stage, which `mapKitStatus` sends to dmi SUBMITTED. */
      const kit = await mockKit(KIT_ACTIVATION)
      expect(kit.activated).toBe(true)
      expect(kit.currentStage).toBe('waiting')
      expect(kit.hospitalNumber).toBe(env.wisdomPanel.hospitalNumber)
      expect(kit.veterinarianName).toBe('Ann Vet')
      expect(kit.voyagerPetId).toBe(activationPatientId)
      expect(kit.pet).toMatchObject({ name: 'Nutmeg', species: EXPECTED_SPECIES, sex: EXPECTED_SEX })
    })

    it('the requisition form comes back as the order\'s manifest and decodes to a PDF', async () => {
      const manifest = expectOk<{ contentType: string, data: string }>(
        await org.api.get(`/orders/${activationOrderId}/manifest`),
        'read the order manifest',
      )

      expect(manifest.contentType).toBe('application/pdf')
      /* Decoded, not merely present: the integration base64s `data.requisition_form` straight
       * through, so a mock that answered with an HTML page would still produce a well-formed
       * attachment. */
      expect(Buffer.from(manifest.data, 'base64').subarray(0, 5).toString('latin1')).toBe('%PDF-')
    }, 30_000)

    it('the orders poll delivered the activated kit and acknowledged it, and the order stayed SUBMITTED', async () => {
      /* Waiting on the ACKNOWLEDGEMENT is what makes everything else here mean something: a kit is
       * only acked after a full orders-poll cycle (poll -> resolve each kit's pet out of `included`
       * -> emit `external_orders` -> ack), so once the ack lands, the poll has provably run to
       * completion rather than dying midway. This provider's failing polls are otherwise silent. */
      const kit = await pollUntil(
        async () => await mockKit(KIT_ACTIVATION),
        (entry) => entry.acknowledged,
        ORDER_WAIT_MS,
        1_000,
      )
      expect(kit.acknowledged).toBe(true)

      /* One id per call, and the KIT id space rather than the result-set one — the two channels are
       * independent at this provider and acking into the wrong one would silently do nothing. */
      const log = await mockCalls({ path: '/api/voyager/acknowledge-kits', method: 'POST' })
      expect(log.calls.length).toBeGreaterThanOrEqual(1)
      expect(log.calls[log.calls.length - 1].body).toEqual({ data: { kit_ids: [activationKitId] } })

      /* Acknowledging is a FILTER, not a delete: the kit is off the unacknowledged feed but the
       * mock still holds it. */
      expect((await mockCalls()).counters.ackKits).toBeGreaterThanOrEqual(1)

      /* The order does NOT move. The polled kit maps to SUBMITTED and dmi-api correctly refuses
       * SUBMITTED -> SUBMITTED as a non-change, so a status that had moved would mean the orders
       * channel had started writing something it should not. */
      const order = await org.api.get(`/orders/${activationOrderId}`)
      expect(order.body.status).toBe('SUBMITTED')

      /* And the kit is gone from the service list, because it is no longer unactivated. Depletion
       * is what makes this provider's "catalogue" different from every other loop's. */
      const list = await services()
      expect(list.map((service) => service.code)).not.toContain(KIT_ACTIVATION)
      expect(list.length).toBe(inventoryAtSetup.length - 1)
    }, ORDER_WAIT_MS + 30_000)

    it('the audit trail holds the activation and the non-empty kits page, each with the kit code', async () => {
      /* Every provider response the integration's interceptor does not filter is emitted as
       * `raw_data` and stored by dmi-api. Asserting BOTH records is a positive check on three
       * things at once: the interceptor ran, its `extractAccessionIds` found the kit code on each
       * path (the request body on the pet POST, `data[].attributes.code` on the kits page), and the
       * integration id travelled with the call. It is also the positive twin of the audit tripwire
       * at the bottom of this file, which shows the same interceptor dropping an ERROR response. */
      const records = await pollUntil(
        async () =>
          expectOk<{ data: Array<{ url: string, status: number, method: string, accessionIds?: string[], provider: string }> }>(
            await admin.get('/admin/external-requests', {
              providers: 'wisdom-panel',
              integrationId: org.integrationId,
              page: 1,
              limit: 200,
            }),
            'read the wisdom-panel audit trail',
          ).data,
        (data) =>
          data.some((record) => record.url.includes('/api/voyager/pet')) &&
          data.some((record) => record.url.includes('/api/v1/kits') && record.status === 200),
        ORDER_WAIT_MS,
        1_000,
      )

      const activation = records.find((record) => record.url.includes('/api/voyager/pet'))
      expect(activation).toBeDefined()
      expect(activation?.provider).toBe('wisdom-panel')
      expect(activation?.method).toBe('POST')
      expect(activation?.status).toBe(201)
      expect(activation?.accessionIds).toEqual([KIT_ACTIVATION])

      /* The kits page. `filter()` drops a page whose `record-count` is 0, so the only pages stored
       * are ones that carried kits — and this one carried the activated kit. */
      const page = records.find(
        (record) => record.url.includes('/api/v1/kits') && (record.accessionIds ?? []).includes(KIT_ACTIVATION),
      )
      expect(page).toBeDefined()
      expect(page?.status).toBe(200)
      expect(page?.method).toBe('GET')
    }, ORDER_WAIT_MS + 30_000)
  })

  describe('results: a kit\'s genetic report closes the loop', () => {
    it('seeding a result set closes the loop: the report reaches FINAL and the order COMPLETED', async () => {
      await seedResultSet(KIT_ACTIVATION, {
        breeds: BREEDS,
        idealWeight: IDEAL_WEIGHT,
        notable: NOTABLE_NONE,
      })

      /* Wait on the REPORT, not on the order — the question CLAUDE.md insists on asking is which
       * channels could satisfy this assertion. Seeding a result set advances the kit to
       * `report-ready`, which `mapKitStatus` maps to dmi COMPLETED, so the ORDERS channel could in
       * principle move the order too. It cannot in practice (the kit was acknowledged in the
       * previous test and this mock does not model re-notification, faithfully — the vendor's
       * behaviour there was never observed), but that is a weaker claim than the one that holds
       * unconditionally: dmi-api sets a report FINAL in exactly ONE place, on the `external_results`
       * path. So FINAL is the results channel's, full stop, and the order's COMPLETED is read after
       * it rather than waited on. */
      const report = await pollUntil(
        async () => await org.api.get(`/orders/${activationOrderId}/report`),
        (response) => response.body?.status === 'FINAL',
        COMPLETION_WAIT_MS,
        1_000,
      )
      expect(report.body.status).toBe('FINAL')
      activationReportId = report.body.id

      const order = await org.api.get(`/orders/${activationOrderId}`)
      expect(order.body.status).toBe('COMPLETED')
    }, COMPLETION_WAIT_MS + 30_000)

    it('the report carries the exact panels, codes, names, values, units and notes', async () => {
      const panels = await panelsFor(activationOrderId)

      /* THREE panels, in the order of the simplified body's own keys: the mapper walks
       * `Object.keys(...)` and uses the index as `seq`, and dmi-api orders a report's test result
       * sets by it. So this pins the wire order of the provider's document, not just its content. */
      expect(panels.map((panel) => panel.code)).toEqual([
        'breed_percentages',
        'ideal_weight_result',
        'notable_and_at_risk_health_test_results',
      ])
      expect(panels.map((panel) => panel.name)).toEqual([
        'Breed Percentages',
        'Ideal Weight Result',
        'Notable and At Risk Health Test Results',
      ])

      /* Breeds: one observation per breed, in the document's order, coded by SLUG and named by the
       * English name. The percentages are distinct, so a mapper that paired the wrong slug with the
       * wrong number cannot pass. `notes` is synthesised by the integration from both fields. */
      const breeds = panels[0].observations ?? []
      expect(breeds.map((observation) => observation.code)).toEqual(BREEDS.map((breed) => breed.slug))
      expect(breeds.map((observation) => observation.name)).toEqual(BREEDS.map((breed) => breed.name))
      expect(breeds.map((observation) => observation.valueQuantity?.value)).toEqual(BREEDS.map((breed) => breed.percentage))
      expect(breeds.every((observation) => observation.valueQuantity?.units === '%')).toBe(true)
      expect(breeds.every((observation) => observation.status === 'DONE')).toBe(true)
      expect(breeds.map((observation) => observation.notes)).toEqual(
        BREEDS.map((breed) => `${breed.percentage}% ${breed.name}`),
      )

      /* Ideal weight: EXACTLY three items, synthesised by the integration from one object — so
       * their codes and names are the integration's constants, not the provider's vocabulary, and
       * the three numbers are distinct so a transposition is visible. The units are `kg`. */
      const weight = panels[1].observations ?? []
      expect(weight.map((observation) => observation.code)).toEqual([
        'ideal_weight_result_min_size',
        'ideal_weight_result_max_size',
        'ideal_weight_result_pred_size',
      ])
      expect(weight.map((observation) => observation.name)).toEqual([
        'Minimal Ideal Weight Result',
        'Maximum Ideal Weight Result',
        'Predicted Ideal Weight Result',
      ])
      expect(weight.map((observation) => observation.valueQuantity?.value)).toEqual([
        IDEAL_WEIGHT.min,
        IDEAL_WEIGHT.max,
        IDEAL_WEIGHT.pred,
      ])
      expect(weight.every((observation) => observation.valueQuantity?.units === 'kg')).toBe(true)
      /* No notes on these three. dmi-api's Observation.notes is a nullable column, so an absent
       * one comes back as an explicit null rather than as a missing key — normalise before
       * asserting. */
      expect(weight.map((observation) => observation.notes ?? null)).toEqual([null, null, null])

      /* The STRING form of the health findings — 40 of the 51 live result sets carry it — becomes
       * ONE item whose code is the raw key and whose value is the sentence verbatim. */
      const findings = panels[2].observations ?? []
      expect(findings).toHaveLength(1)
      expect(findings[0].code).toBe('notable_and_at_risk_health_test_results')
      expect(findings[0].name).toBe('Notable and At Risk Health Test Results')
      expect(findings[0].valueString).toBe(NOTABLE_NONE)
      expect(findings[0].valueQuantity ?? null).toBeNull()
      /* No interpretation: the integration only hard-codes one on the ARRAY branch. An absent
       * interpretation serialises as an explicit null. */
      expect(findings[0].interpretation ?? null).toBeNull()
    })

    it('the vet report PDF is attached to the report and decodes to a PDF', async () => {
      const attachments = expectOk<Array<{ contentType: string, data: string }>>(
        await org.api.get(`/reports/${activationReportId}/presentedForm`),
        'read the report\'s presented form',
      )

      expect(attachments).toHaveLength(1)
      expect(attachments[0].contentType).toBe('application/pdf')
      /* The integration reads this endpoint with `responseType: 'arraybuffer'` and base64s the raw
       * bytes, so decoding is the only way to tell a real document from an error page wearing a
       * PDF content type. */
      expect(Buffer.from(attachments[0].data, 'base64').subarray(0, 8).toString('latin1')).toBe('%PDF-1.7')
    })

    it('the result set was acknowledged once, left the feed, and neither per-kit endpoint was called again', async () => {
      /* Waited out over several poll intervals first, so "once" means "and not again", not "not
       * yet". Without the ack the same result set would come back every tick for ever, dmi-api
       * would merge the redeliveries, and every assertion above would stay green — exactly once is
       * the only thing that catches it. */
      await new Promise((resolve) => setTimeout(resolve, POLL_MS * 4))

      const log = await mockCalls({ path: '/api/voyager/acknowledge-result-sets', method: 'POST' })
      const kit = await mockKit(KIT_ACTIVATION)
      expect(kit.resultSetId).toBeTruthy()
      expect(log.calls.length).toBeGreaterThanOrEqual(1)
      expect(log.calls[log.calls.length - 1].body).toEqual({ data: { result_set_ids: [kit.resultSetId] } })

      const sets = expectOk<{ resultSets: Array<{ id: string, acknowledged: boolean }> }>(
        await mock.get('/__control__/result-sets'),
        'read the mock result sets',
      ).resultSets
      expect(sets.find((set) => set.id === kit.resultSetId)?.acknowledged).toBe(true)

      /* The two per-result-set fetches the integration makes inside its loop. Exactly one each: an
       * acknowledged set leaves the feed, so a second fetch would mean the ack did not take. */
      expect(kit.simplifiedFetches).toBe(1)
      expect(kit.pdfFetches).toBe(1)
    }, 60_000)

    it('the ARRAY form of the health findings maps to two items per entry, with the integration\'s hard-coded interpretation', async () => {
      /* A second cat, a second kit. The live data carries the health findings BOTH as a plain
       * string and as an array, and the mapper branches on which — so covering only one form leaves
       * half of `mapNotableAndAtRiskHealthTestResults` untested. */
      const kit = await mockKit(KIT_ARRAY_FINDINGS)
      const created = expectOk<{ id: string, externalId: string, status: string }>(
        await org.api.post('/orders', payloadFor(KIT_ARRAY_FINDINGS, { patient: patientFor({ name: 'Saffron' }) })),
        'activate a second kit',
      )
      expect(created.status).toBe('SUBMITTED')
      expect(created.externalId).toBe(kit.id)

      await seedResultSet(KIT_ARRAY_FINDINGS, {
        breeds: BREEDS,
        idealWeight: IDEAL_WEIGHT,
        notable: NOTABLE_FINDINGS,
      })

      const report = await pollUntil(
        async () => await org.api.get(`/orders/${created.id}/report`),
        (response) => response.body?.status === 'FINAL',
        COMPLETION_WAIT_MS,
        1_000,
      )
      expect(report.body.status).toBe('FINAL')

      const panels = await panelsFor(created.id)
      const findings = panels.find((panel) => panel.code === 'notable_and_at_risk_health_test_results')?.observations ?? []

      /* TWO items per entry, interleaved: the finding itself at `seq: 2i` and its copy count at
       * `seq: 2i + 1`. dmi-api orders observations by seq, so the interleaving is what the array
       * below pins. */
      expect(findings.map((observation) => observation.code)).toEqual([
        NOTABLE_FINDINGS[0].slug,
        `${NOTABLE_FINDINGS[0].slug}_copies`,
        NOTABLE_FINDINGS[1].slug,
        `${NOTABLE_FINDINGS[1].slug}_copies`,
      ])
      expect(findings.map((observation) => observation.name)).toEqual([
        NOTABLE_FINDINGS[0].diseaseName,
        `${NOTABLE_FINDINGS[0].diseaseName} Copies`,
        NOTABLE_FINDINGS[1].diseaseName,
        `${NOTABLE_FINDINGS[1].diseaseName} Copies`,
      ])

      /* The finding items carry the vendor's `result_value` as a string value, and an
       * interpretation the INTEGRATION hard-codes — every array entry is reported Positive,
       * whatever the vendor said. That is the integration's constant, not a mapped value, and it is
       * pinned here so that a change to it is a named failure rather than a silent one.
       *
       * WIRE-VALUE TRAP: `TestResultItemInterpretationCode.POSITIVE` is the string `'P'`, not
       * `'POSITIVE'`, and dmi-api persists what it is sent. Asserting `'POSITIVE'` would have
       * failed; asserting merely that an interpretation exists would have been true of every code
       * in the enum. */
      expect(findings[0].valueString).toBe(NOTABLE_FINDINGS[0].resultValue)
      expect(findings[2].valueString).toBe(NOTABLE_FINDINGS[1].resultValue)
      expect(findings[0].interpretation).toEqual({ code: 'P', text: 'Positive' })
      expect(findings[2].interpretation).toEqual({ code: 'P', text: 'Positive' })

      /* The copy-count items: a QUANTITY whose units are the empty string (the integration sends
       * `units: ''`), and the vendor's `ui_description` as notes. dmi-api stores valueQuantity as
       * JSON, so the empty string survives as an empty string rather than becoming null. */
      expect(findings[1].valueQuantity).toEqual({ value: NOTABLE_FINDINGS[0].copies, units: '' })
      expect(findings[3].valueQuantity).toEqual({ value: NOTABLE_FINDINGS[1].copies, units: '' })
      expect(findings[1].notes).toBe(NOTABLE_FINDINGS[0].uiDescription)
      expect(findings[3].notes).toBe(NOTABLE_FINDINGS[1].uiDescription)
      /* The copies items carry no interpretation — only the finding items do. */
      expect(findings[1].interpretation ?? null).toBeNull()
      expect(findings[3].interpretation ?? null).toBeNull()
    }, COMPLETION_WAIT_MS + 60_000)

    it('a result whose ideal-weight and findings sections are empty still completes, and the findings panel is dropped', async () => {
      /* The THIRD observed shape of the simplified body, and not a rare one: 10 of the 51 live
       * result sets carry `"ideal_weight_result": {}` — an empty OBJECT, not a missing key —
       * together with `"notable_and_at_risk_health_test_results": []`. A fifth of the account.
       *
       * The two halves are handled very differently by the mapper, which is why this shape earns
       * its own test: the empty findings ARRAY is skipped correctly (`extractTestResults` skips the
       * notable key when its `.length === 0`), while the empty ideal-weight OBJECT is not — it is
       * handed to `mapIdealWeightResult`, which reads `min_size`/`max_size`/`pred_size` off it
       * unguarded. This test pins the half that works; the tripwire at the bottom of the file pins
       * the half that does not. */
      const kit = await mockKit(KIT_EMPTY_SECTIONS)
      const created = expectOk<{ id: string, externalId: string, status: string }>(
        await org.api.post('/orders', payloadFor(KIT_EMPTY_SECTIONS, { patient: patientFor({ name: 'Clover' }) })),
        'activate a third kit',
      )
      emptySectionsOrderId = created.id
      expect(created.externalId).toBe(kit.id)

      await seedResultSet(KIT_EMPTY_SECTIONS, {
        breeds: BREEDS_SINGLE,
        emptyIdealWeight: true,
        emptyNotable: true,
      })

      const report = await pollUntil(
        async () => await org.api.get(`/orders/${created.id}/report`),
        (response) => response.body?.status === 'FINAL',
        COMPLETION_WAIT_MS,
        1_000,
      )
      expect(report.body.status).toBe('FINAL')

      const panels = await panelsFor(created.id)
      /* The breed half is ordinary and still exact. */
      const breeds = panels.find((panel) => panel.code === 'breed_percentages')?.observations ?? []
      expect(breeds.map((observation) => observation.code)).toEqual(BREEDS_SINGLE.map((breed) => breed.slug))
      expect(breeds.map((observation) => observation.valueQuantity?.value)).toEqual(BREEDS_SINGLE.map((breed) => breed.percentage))

      /* The empty findings array produced NO panel at all — the mapper's `.length === 0` skip. */
      expect(panels.map((panel) => panel.code)).not.toContain('notable_and_at_risk_health_test_results')
    }, COMPLETION_WAIT_MS + 60_000)
  })

  describe('the orders channel: kits activated at the provider become orders', () => {
    /* What the integration's status mapping is actually for. A clinic can activate a kit in the
     * vendor's own UI, and the kit then arrives on the unacknowledged feed with a pet attached and
     * no dmi order behind it — so dmi-api creates one (`handleExternalOrders`, the orphan path).
     * These three kits are provisioned through the mock's control plane, never through dmi. */

    it('a kit at `generating-report` becomes a PARTIAL order carrying the pet, the owner and the vet', async () => {
      const kit = await provisionKit({
        code: KIT_PROVIDER_PARTIAL,
        hospitalNumber: env.wisdomPanel.hospitalNumber,
        hospitalName: env.wisdomPanel.hospitalName,
        veterinarianName: 'Kim Vet',
        activated: true,
        stage: 'generating-report',
        acknowledged: false,
        pet: {
          name: 'Ollie',
          sex: 'male',
          species: 'dog',
          ownerFirstName: 'Sam',
          ownerLastName: 'Poe',
        },
      })

      const found = await pollUntil(
        async () => await orderByExternalId(kit.id),
        (order) => order !== undefined,
        ORDER_WAIT_MS,
        1_000,
      )
      if (found === undefined) {
        throw new Error(`no dmi order appeared for provider-side kit ${KIT_PROVIDER_PARTIAL} (${kit.id}) within ${ORDER_WAIT_MS}ms`)
      }

      const order = expectOk<any>(await org.api.get(`/orders/${found.id}`), 'read the orphan order')

      /* `generating-report` -> PARTIAL. Three of the six live stages map to PARTIAL and only one to
       * COMPLETED, so pinning the value rather than "it is not SUBMITTED" is what distinguishes a
       * working mapping from a switch that fell through to its default. */
      expect(order.status).toBe('PARTIAL')
      expect(order.externalId).toBe(kit.id)

      /* The patient and client the integration extracted from the pet, forwarded RAW: the mapper
       * copies `sex` and `species` straight off the pet's attributes (it carries a `TODO` where the
       * reverse ref mapping would go), so a dmi order created this way carries the PROVIDER's
       * vocabulary rather than dmi's canonical codes. Asserted as it is, not as it ought to be. */
      expect(order.patient).toMatchObject({ name: 'Ollie', species: 'dog', sex: 'male' })
      expect(order.client).toMatchObject({ firstName: 'Sam', lastName: 'Poe' })
      /* The kit code becomes the order's single test — this provider's only notion of a test. */
      expect((order.tests ?? []).map((test: { code: string }) => test.code)).toEqual([KIT_PROVIDER_PARTIAL])
      /* The whole veterinarian name lands in `firstName`: the provider sends one string and the
       * mapper does not split it. */
      expect(order.veterinarian).toMatchObject({ firstName: 'Kim Vet' })
    }, ORDER_WAIT_MS + 30_000)

    it('a kit carrying a failure becomes an ERROR order whose notes name the failure', async () => {
      const kit = await provisionKit({
        code: KIT_PROVIDER_FAILED,
        hospitalNumber: env.wisdomPanel.hospitalNumber,
        hospitalName: env.wisdomPanel.hospitalName,
        veterinarianName: 'Kim Vet',
        activated: true,
        /* A stage that would otherwise map to PARTIAL, so this test proves the FAILURE wins rather
         * than merely that some ERROR appeared. `sample-failed` is the one failure value OBSERVED
         * live, on 22 kits. */
        stage: 'analyzing',
        failure: 'sample-failed',
        acknowledged: false,
        pet: {
          name: 'Bramble',
          sex: 'female',
          species: 'dog',
          ownerFirstName: 'Sam',
          ownerLastName: 'Poe',
        },
      })

      const found = await pollUntil(
        async () => await orderByExternalId(kit.id),
        (order) => order !== undefined,
        ORDER_WAIT_MS,
        1_000,
      )
      if (found === undefined) {
        throw new Error(`no dmi order appeared for failed kit ${KIT_PROVIDER_FAILED} (${kit.id}) within ${ORDER_WAIT_MS}ms`)
      }

      const order = expectOk<any>(await org.api.get(`/orders/${found.id}`), 'read the failed orphan order')
      expect(order.status).toBe('ERROR')
      /* The vendor's own failure value, reformatted by the integration into the order's notes —
       * the only place an operator sees WHY. Pinned verbatim. */
      expect(order.notes).toBe('Failure reason: sample-failed')
    }, ORDER_WAIT_MS + 30_000)

    it('a kit for another hospital never becomes an order, though the mock holds it', async () => {
      /* The negative, run AFTER the two positives so that "no order appeared" cannot be confused
       * with "the poll has not run yet" — the previous two tests proved the channel is live within
       * this budget. */
      const kit = await provisionKit({
        code: KIT_PROVIDER_FOREIGN,
        hospitalNumber: FOREIGN_HOSPITAL_NUMBER,
        hospitalName: 'Another Animal Hospital',
        veterinarianName: 'Lee Vet',
        activated: true,
        stage: 'report-ready',
        acknowledged: false,
        pet: {
          name: 'Juniper',
          sex: 'male',
          species: 'dog',
          ownerFirstName: 'Robin',
          ownerLastName: 'Vale',
        },
      })

      const found = await pollUntil(
        async () => await orderByExternalId(kit.id),
        (order) => order !== undefined,
        NEGATIVE_WAIT_MS,
        1_000,
      )
      expect(found).toBeUndefined()

      /* And the mock really does hold it, unacknowledged: so it is the provider's hospital FILTER
       * that hid it, not a provisioning that silently failed. Without this half the test would pass
       * just as well against a mock that never created the kit. */
      const held = expectOk<{ kits: MockKit[] }>(await mock.get('/__control__/kits'), 'list every kit the mock holds').kits
      const foreign = held.find((entry) => entry.code === KIT_PROVIDER_FOREIGN)
      expect(foreign).toBeDefined()
      expect(foreign?.hospitalNumber).toBe(FOREIGN_HOSPITAL_NUMBER)
      expect(foreign?.acknowledged).toBe(false)
      expect(foreign?.activated).toBe(true)
      expect(foreign?.pet?.name).toBe('Juniper')
    }, NEGATIVE_WAIT_MS + 30_000)
  })

  describe('refusals surface end to end', () => {
    it('an unknown kit code fails POST /orders, carrying the vendor\'s own WIS_VOY__105 sentence', async () => {
      /* The ORDERS path is the only one whose failures reach an operator: `createPet` and
       * `getKits` wrap theirs in `WisdomApiException`, which collects `options.message` off the raw
       * body — so the voyager dialect's `{message}` survives all the way to POST /orders. (The
       * whole RESULTS path throws a plain `Error('[HTTP n] Failed to GET ...')` instead, which is
       * why no test in this file asserts a vendor sentence on that side.)
       *
       * Pinning the exact sentence rather than merely "it failed" is what distinguishes the real
       * branch from the generic `Failed to POST <url>` every unreadable envelope degrades to. */
      const unknownCode = 'WPKIT-NOSUCH'
      const payload = payloadFor(unknownCode)

      const response = await org.api.post('/orders', payload)
      console.log(
        `[wisdom-panel-scenario] unknown-kit response -> HTTP ${response.status}: ${response.text.slice(0, 400)}`,
      )

      expect(response.ok).toBe(false)
      expect(response.text).toContain(`WIS_VOY__105: Failed: Kit ${unknownCode} could not be found.`)
      /* And the generic fallback is present too, so this also pins that the vendor's explanation is
       * ADDITIONAL to it rather than instead of it. */
      expect(response.text).toContain('/api/voyager/pet')

      /* dmi-api still commits the order row and marks it ERROR in its catch, so the failure is
       * visible to the operator as an order rather than vanishing. */
      const stored = expectOk<Array<{ requisitionId: string, status: string }>>(
        await org.api.get('/orders'),
        'list orders after the refused activation',
      ).find((order) => order.requisitionId === payload.requisitionId)
      expect(stored?.status).toBe('ERROR')
    }, 60_000)

    it('the same kit code twice: the second activation is refused and the first order is untouched', async () => {
      const first = expectOk<{ id: string, externalId: string, requisitionId: string, status: string }>(
        await org.api.post('/orders', payloadFor(KIT_DUPLICATE)),
        'activate a kit for the duplicate test',
      )
      expect(first.status).toBe('SUBMITTED')
      expect(first.requisitionId).toBe(KIT_DUPLICATE)

      const second = await org.api.post('/orders', payloadFor(KIT_DUPLICATE, { patient: patientFor({ name: 'Thistle' }) }))
      console.log(
        `[wisdom-panel-scenario] duplicate-activation response -> HTTP ${second.status}: ${second.text.slice(0, 400)}`,
      )
      expect(second.ok).toBe(false)
      /* The message is INVENTED by the mock (the vendor's wording for this case was never
       * captured), but the CODE path is the real one: a 422 from the voyager dialect, carried by
       * `WisdomApiException`. The test asserts the mock's sentence so a change to it is deliberate. */
      expect(second.text).toContain(`WIS_VOY__106: Failed: Kit ${KIT_DUPLICATE} has already been activated.`)

      /* The first order is untouched — a refused second activation must not disturb the patient
       * already on the kit at the provider, nor the dmi order that owns it. */
      const order = await org.api.get(`/orders/${first.id}`)
      expect(order.body.status).toBe('SUBMITTED')
      const kit = await mockKit(KIT_DUPLICATE)
      expect(kit.activated).toBe(true)
      expect(kit.pet?.name).toBe('Nutmeg')
    }, 60_000)

    it('a labRequisitionInfo without KitCode is refused by dmi-api before the engine, and the mock saw no activation', async () => {
      /* dmi-api validates `labRequisitionInfo` against the parameters the provider declares —
       * `KitCode`, required, the only one — and answers 400 naming what is wrong, before the engine
       * is involved at all. Both halves are asserted: the 400, and that no pet POST reached the
       * provider, which is what proves the check really is upstream of the RPC. */
      const before = (await mockCalls()).counters.createPet

      const missing = await org.api.post('/orders', payloadFor(KIT_ACTIVATION, { labRequisitionInfo: {} }))
      expect(missing.status).toBe(400)
      expect(missing.text).toContain('KitCode')

      const unknown = await org.api.post('/orders', payloadFor(KIT_ACTIVATION, { labRequisitionInfo: { KitCode: KIT_CANCEL, KitBatch: 'B-1' } }))
      expect(unknown.status).toBe(400)
      expect(unknown.text).toContain('KitBatch')

      const after = (await mockCalls()).counters.createPet
      expect(after).toBe(before)
    }, 30_000)

    it('the mock refuses, in the provider\'s own dialects, every call the loop never makes', async () => {
      /* Direct probes with a bearer the scenario minted for itself. Each of these is a shape the
       * integration can produce but this loop does not, and each is a DIFFERENT envelope — the
       * variety is itself the contract, because which shape an endpoint returns decides whether the
       * vendor's explanation reaches an operator or is replaced by a generic message. */
      const base = env.wisdomPanel.mockBaseUrl
      const auth = { authorization: `Bearer ${probeToken}` }

      /* 1. Content negotiation, OBSERVED exactly this way on the live server. The bare
       *    `application/json` a tidy-up would add is a 406; the wildcard axios sends by default is
       *    not. This is the pin behind the Accept assertion in the poll test above. */
      const bareJson = await fetch(`${base}/api/v1/kits`, { headers: { ...auth, accept: 'application/json' } })
      expect(bareJson.status).toBe(406)
      expect(((await bareJson.json()) as { errors: Array<{ title: string }> }).errors[0].title).toBe('Not Acceptable')

      const vendorType = await fetch(`${base}/api/v1/kits`, { headers: { ...auth, accept: 'application/vnd.api+json' } })
      expect(vendorType.status).toBe(200)

      /* ...and the SAME media type with a parameter is refused, which is the part that makes the
       * rule a real content negotiation rather than a substring check. */
      const parameterised = await fetch(`${base}/api/v1/kits`, { headers: { ...auth, accept: 'application/vnd.api+json; charset=utf-8' } })
      expect(parameterised.status).toBe(406)

      /* 2. A missing bearer on the JSON:API half: 401, OBSERVED verbatim — note `code` is a NUMBER
       *    here and `status` a STRING, an asymmetry a tidier mock would have ironed out. */
      const noBearer = await fetch(`${base}/api/v1/kits`, { headers: { accept: '*/*' } })
      expect(noBearer.status).toBe(401)
      expect(await noBearer.json()).toEqual({
        errors: [{ title: 'Permission Denied', detail: 'The access token is invalid', code: 401, status: '401' }],
      })

      /* 3. An unknown filter key: 400, OBSERVED verbatim for a misspelled `hospital_numbr`. Here
       *    `code` is a STRING, where the 401 above makes it a number. The filters are enforced for
       *    real, which is what the foreign-hospital negative above rests on. */
      const badFilter = await fetch(`${base}/api/v1/kits?filter%5Bhospital_numbr%5D=700001`, { headers: { ...auth, accept: '*/*' } })
      expect(badFilter.status).toBe(400)
      expect(await badFilter.json()).toEqual({
        errors: [{ title: 'Filter not allowed', detail: 'hospital_numbr is not allowed.', code: '102', status: '400' }],
      })

      /* 4. The PDF generator's 404 for an unknown kit: `text/html`, body exactly `Kit not found.`
       *    — NOT a 200 carrying an error page, which is the trap that bit another loop. */
      const missingPdf = await fetch(`${base}/pdf-generator/vet-report/00000000-0000-4000-8000-000000000000`, { headers: auth })
      expect(missingPdf.status).toBe(404)
      expect(missingPdf.headers.get('content-type')).toContain('text/html')
      expect(await missingPdf.text()).toBe('Kit not found.')

      /* 5. The OAuth grant's refusal: **400**, not 401, in RFC 6749's own dialect. The integration
       *    discards this body entirely (`authenticate` rethrows `[HTTP 400] Failed to POST ...`),
       *    so an operator never sees `invalid_grant` — which is why it is pinned here rather than
       *    through dmi-api. */
      const badGrant = await fetch(`${base}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: env.wisdomPanel.username, password: 'not-the-password', grant_type: 'password', scope: 'organization' }),
      })
      expect(badGrant.status).toBe(400)
      expect(((await badGrant.json()) as { error: string }).error).toBe('invalid_grant')
    }, 60_000)

    it('a kits page whose kits are all pet-less omits `included` entirely', async () => {
      /* The single most important shape in this mock, and the state the integration cannot survive:
       * JSON:API leaves `included` OUT when nothing in the page carries the requested relationship,
       * and an unactivated kit has no pet — so a clinic that has been shipped kits it has not used
       * yet gets `data` non-empty and NO `included` key. `getBatchOrders` does
       * `response.included.find(...)` with no guard and throws a TypeError on it, inside a `catch`
       * that reports neither a status nor a cause.
       *
       * Probed DIRECTLY, at a hospital the engine's own poll is not scoped to, rather than as a
       * tripwire: any kit that would produce an order also carries a pet, and one pet anywhere on
       * the page brings `included` back — so the crash can be reproduced but its consequence cannot
       * be made visible through dmi-api without also removing the thing the assertion would look
       * for. What IS assertable, and is what a mock can get wrong, is the page shape itself. */
      const kit = await provisionKit({
        code: KIT_PETLESS,
        hospitalNumber: PROBE_HOSPITAL_NUMBER,
        activated: false,
        stage: 'shipped',
        acknowledged: false,
      })

      try {
        const response = await fetch(
          `${env.wisdomPanel.mockBaseUrl}/api/v1/kits` +
            `?filter%5Bunacknowledged%5D=true&filter%5Bhospital_number%5D=${PROBE_HOSPITAL_NUMBER}&include=pet%2Cpet.owner`,
          { headers: { authorization: `Bearer ${probeToken}`, accept: '*/*' } },
        )
        expect(response.status).toBe(200)
        const body = (await response.json()) as Record<string, unknown>

        expect((body.data as unknown[]).length).toBe(1)
        expect((body.data as Array<{ id: string }>)[0].id).toBe(kit.id)
        /* NOT `included: []` — the key is absent. `Object.keys` rather than a truthiness check,
         * because an empty array and a missing key are both falsy in the places that matter and
         * only one of them is what the vendor sends. */
        expect(Object.keys(body)).not.toContain('included')
        /* `meta['record-count']` is present on every page, including this one: the integration's
         * audit interceptor reads it unguarded before anything else does. */
        expect(body.meta).toEqual({ 'record-count': 1 })
        /* And the kit really is pet-less, with the relationship present and its data null — which
         * is a different thing from the relationship being absent. */
        expect((body.data as Array<any>)[0].relationships.pet.data).toBeNull()
      } finally {
        await mock.delete(`/__control__/kits/${KIT_PETLESS}`)
      }
    }, 30_000)
  })

  describe('cancel: this provider has no cancel path at all', () => {
    it('DELETE /orders/:id is refused, the order keeps its status, and the mock sees no call', async () => {
      /* Wisdom Panel has no cancel surface, and the integration reflects that twice over: its
       * `cancelOrder` throws `Method not implemented` — and, more to the point, its controller
       * declares NO message pattern for `wisdom-panel/orders/cancel` at all, so the RPC dmi-api
       * sends has no subscriber and times out at `ENGINE_RESPONSE_TIMEOUT` instead.
       *
       * What this pins is dmi-api's side of that: `cancelOrder` marks the local order CANCELLED
       * only AFTER the engine RPC resolves, so an unanswered RPC must leave the order exactly as it
       * was — at the provider and in dmi. An implementation that marked it CANCELLED optimistically
       * would show a cancelled order for a kit that is still activated and still on its way to the
       * lab. */
      const created = expectOk<{ id: string, status: string }>(
        await org.api.post('/orders', payloadFor(KIT_CANCEL, { patient: patientFor({ name: 'Marigold' }) })),
        'activate a kit to attempt cancelling',
      )
      expect(created.status).toBe('SUBMITTED')

      const before = (await mockCalls()).lastSeq
      const response = await org.api.delete(`/orders/${created.id}`)
      console.log(
        `[wisdom-panel-scenario] cancel response -> HTTP ${response.status}: ${response.text.slice(0, 400)}`,
      )
      expect(response.ok).toBe(false)

      const order = await org.api.get(`/orders/${created.id}`)
      expect(order.body.status).toBe('SUBMITTED')

      /* Nothing that could be a cancel reached the provider: there is no endpoint to reach, and the
       * integration never got as far as looking for one. Scoped to "no path outside the ordinary
       * polling traffic" rather than "no calls at all", because the RPC times out over several poll
       * ticks and the kit this test just activated is delivered and acknowledged in the meantime —
       * which is the loop working, not a cancel. A cancel attempt would show here either as a
       * request to a path the mock does not route (logged, and answered 404) or as a write to one
       * it does. */
      const after = await mockCalls({ since: before })
      const pollingPaths = [
        '/api/v1/kits',
        '/api/v1/result-sets',
        '/api/voyager/acknowledge-kits',
        '/api/voyager/acknowledge-result-sets',
        '/api/voyager/banfield-results-retrieval',
        '/pdf-generator/vet-report',
      ]
      const unexpected = after.calls.filter(
        (call) => !pollingPaths.some((path) => call.path === path || call.path.startsWith(`${path}/`)),
      )
      expect(unexpected.map((call) => `${call.method} ${call.path}`)).toEqual([])

      const kit = await mockKit(KIT_CANCEL)
      expect(kit.activated).toBe(true)
      expect(kit.currentStage).toBe('waiting')
    }, 60_000)
  })

  /* ---- tripwires ----
   *
   * Each asserts the CORRECT behaviour and is marked `failing` while the platform does not have it.
   * That keeps CI green while the defect stands, and turns the test red the moment someone fixes it
   * — at which point the `.failing` marker comes off in the same commit and the test stays on as a
   * plain regression guard. A tripwire that PASSES is a red run: jest reports "Failing test passed
   * even though it was supposed to fail", and the only correct response is to delete the marker,
   * not to relax the assertion.
   *
   * Each is paired with a positive that proves the mechanism is live, and each cleans up in a
   * `finally` so the tests after it are unaffected. The two that POISON A POLL come last, and in
   * that order, because a failed Bull job is retried three times with exponential backoff and the
   * backlog has to drain before anything else can be believed. */
  describe('tripwires: behaviours the loop should have and does not', () => {
    it.failing('POST /admin/refs/sync/<provider> stores the reference data it fetched', async () => {
      /* EXPECTED: the admin ref sync fetches the provider's species/breeds/sexes (it does — the
       * reference-data test above reads exactly those lists over the same RPC) and upserts them as
       * provider_ref rows, which is the only way a canonical dmi ref becomes mappable to a provider
       * code. ACTUAL: HTTP 400 from the route's own database query, and nothing is stored — for
       * every provider and every ref type. The RPC to the engine runs and the data comes back; the
       * upsert then fails because the route loads the Provider with `ProvidersService.findOneById`,
       * which decorates the entity with two computed, non-column properties (`integrationOptions`,
       * `configurationOptions`), and `RefsService.syncProviderRefs` passes that whole entity as a
       * relation condition — `findOne({ where: { code, type, provider } })` — which TypeORM expands
       * over the entity's properties and refuses at the first computed one:
       * `Property "integrationOptions" was not found in "Provider"`.
       *
       * It is why this scenario seeds the provider_ref rows itself, from the lists the engine
       * returned, rather than through the route that exists to do it. This test carries no fallback
       * of its own: it reports what the setup observed. The same tripwire stands in the antech-v6
       * scenario, because the defect is dmi-api's rather than any provider's. */
      expect({
        status: syncResponse.status,
        speciesRefsStoredBySync: speciesRefsAfterSync,
        neededTheDirectSeed: providerRefsWereSeededDirectly,
      }).toEqual({
        status: 201,
        speciesRefsStoredBySync: liveSpecies.length,
        neededTheDirectSeed: false,
      })
    })

    it.failing('a result whose ideal-weight section is empty yields no ideal-weight items', async () => {
      /* EXPECTED: `"ideal_weight_result": {}` — a fifth of the live account's result sets carry it
       * — carries no ideal weight, so the report should carry no ideal-weight panel (or an empty
       * one). ACTUAL: three DONE observations with no value at all.
       *
       * `extractTestResults` skips a section only when its `.length === 0`, and that test is
       * hard-coded to the `notable_and_at_risk_health_test_results` key — so the empty findings
       * array beside it IS skipped (asserted, positively, in the results section above) while the
       * empty ideal-weight OBJECT is passed straight to `mapIdealWeightResult`, which reads
       * `min_size` / `max_size` / `pred_size` off it unguarded and emits three items whose
       * `valueQuantity.value` is `undefined`. JSON drops the undefined on the way to dmi-api, which
       * stores the quantity as `{units: 'kg'}` and shows the operator three ideal weights with no
       * numbers in them.
       *
       * The positive twin is the test that seeded this result set: the report reached FINAL and its
       * breed percentages are exact, so the batch itself is demonstrably healthy. */
      const panels = await panelsFor(emptySectionsOrderId)
      expect(panels.map((panel) => panel.code)).toEqual(['breed_percentages'])
    }, 30_000)

    it.failing('a provider error on the orders poll is recorded in the audit trail', async () => {
      /* EXPECTED: when the provider answers a poll with an error, the failure is stored as an
       * external request with that status, so an operator can see what the provider said. ACTUAL:
       * no record appears at all, and the vendor's own `Permission Denied / The access token is
       * invalid` is destroyed before anything can read it.
       *
       * `dmi-engine-common`'s `AxiosInterceptor` calls `handleResponse` on its REJECTION path with
       * no `filter()` and no try/catch, so `extractAccessionIds` is handed the error body — and the
       * wisdom-panel implementation does `body.data.forEach(...)` on the kits branch, unguarded, on
       * a body whose only key is `errors`. The TypeError is thrown from inside the LOGGING
       * interceptor, so the audit record is never written and the exception that finally reaches
       * `getKits`' catch is the TypeError rather than the provider's 401. Same family as
       * nominal-systems/dmi-engine-common#29.
       *
       * The positive twin is the audit test in the activation section, which finds the 200 kits
       * page recorded with its accession id — so the interceptor demonstrably works on the success
       * path and it is the error path alone that loses the record. */
      const failedRecords = async (): Promise<Array<{ url: string, status: number }>> =>
        expectOk<{ data: Array<{ url: string, status: number, createdAt: string }> }>(
          await admin.get('/admin/external-requests', {
            providers: 'wisdom-panel',
            integrationId: org.integrationId,
            page: 1,
            limit: 200,
          }),
          'read the audit trail around the poisoned poll',
        ).data.filter((record) => record.url.includes('/api/v1/kits') && record.status >= 400)

      expect(await failedRecords()).toHaveLength(0)

      try {
        /* "Revocation" is a control-plane switch rather than a new credential, because the
         * integration caches its token for ten days and never re-authenticates: the mock keeps the
         * tokens it issued and simply stops accepting them. */
        expectOk(await mock.post('/__control__/bearer', { accept: false }), 'revoke bearer acceptance at the mock')

        const records = await pollUntil(failedRecords, (data) => data.length > 0, NEGATIVE_WAIT_MS, 1_000)
        expect(records.length).toBeGreaterThan(0)
      } finally {
        expectOk(await mock.post('/__control__/bearer', { accept: true }), 'restore bearer acceptance at the mock')
      }
    }, NEGATIVE_WAIT_MS + 60_000)

    it('the polls resume once the provider accepts its tokens again, with no new login', async () => {
      /* The cleanup of the tripwire above, asserted rather than assumed — and the proof that the
       * mock's revocation switch models the vendor rather than breaking the loop. The SAME tokens
       * have to start working again, because the engine will never come back for new ones: an
       * integration that had to re-authenticate would be stuck for ten days against the real
       * server. A fresh provider-side kit is delivered as an order, which can only happen if the
       * kits poll is running end to end again. */
      const loginsBefore = (await mockCalls()).counters.login

      const kit = await provisionKit({
        code: KIT_PROVIDER_RESUMED,
        hospitalNumber: env.wisdomPanel.hospitalNumber,
        hospitalName: env.wisdomPanel.hospitalName,
        veterinarianName: 'Kim Vet',
        activated: true,
        stage: 'processing',
        acknowledged: false,
        pet: { name: 'Sorrel', sex: 'female', species: 'dog', ownerFirstName: 'Sam', ownerLastName: 'Poe' },
      })

      const found = await pollUntil(
        async () => await orderByExternalId(kit.id),
        (order) => order !== undefined,
        ORDER_WAIT_MS,
        1_000,
      )
      if (found === undefined) {
        throw new Error(`the orders poll did not resume within ${ORDER_WAIT_MS}ms after bearers were accepted again`)
      }
      /* `processing` is the third of the three stages that map to PARTIAL. */
      expect(found.status).toBe('PARTIAL')

      expect((await mockCalls()).counters.login).toBe(loginsBefore)
    }, ORDER_WAIT_MS + 60_000)

    it.failing('a result set whose PDF fails does not take the rest of the batch with it', async () => {
      /* EXPECTED: one result set whose vet report the provider cannot generate should cost that one
       * result set, not the batch. ACTUAL: the healthy result set that came before it in the feed
       * is discarded too, and nothing is acknowledged — so the identical batch comes back every
       * tick and fails at the same place for ever.
       *
       * `getBatchResults` loops the unacknowledged result sets and makes TWO calls per set inside
       * ONE `try`: the simplified results and the PDF. `getReportPdfBase64` rethrows on any
       * non-2xx, the throw escapes the `for`, and the outer catch replaces the whole return value.
       * This is not a hypothetical shape: the provider's PDF generator answered 500 for 10 of 52
       * live result sets, in two different bodies, and the first failure sat at position 4 of 52.
       *
       * A is placed first so it is first in the feed, and its report is what the assertion waits
       * for — if the batch survived B, A would complete. The positive twin follows: clearing B's
       * flag completes both, which shows the machinery is live and that only the failure was
       * blocking it. */
      const healthy = await mockKit(KIT_BATCH_HEALTHY)
      const broken = await mockKit(KIT_BATCH_PDF_FAILS)

      const orderA = expectOk<{ id: string, externalId: string }>(
        await org.api.post('/orders', payloadFor(KIT_BATCH_HEALTHY, { patient: patientFor({ name: 'Cedar' }) })),
        'activate the healthy kit of the batch pair',
      )
      const orderB = expectOk<{ id: string, externalId: string }>(
        await org.api.post('/orders', payloadFor(KIT_BATCH_PDF_FAILS, { patient: patientFor({ name: 'Hazel' }) })),
        'activate the PDF-failing kit of the batch pair',
      )
      expect(orderA.externalId).toBe(healthy.id)
      expect(orderB.externalId).toBe(broken.id)
      batchOrderIds.healthy = orderA.id
      batchOrderIds.broken = orderB.id

      try {
        /* A first, then B: `getBatchResults` walks the feed in order, maps A, and throws on B. */
        await seedResultSet(KIT_BATCH_HEALTHY, { breeds: BREEDS, idealWeight: IDEAL_WEIGHT, notable: NOTABLE_NONE })
        await seedResultSet(KIT_BATCH_PDF_FAILS, {
          breeds: BREEDS,
          idealWeight: IDEAL_WEIGHT,
          notable: NOTABLE_NONE,
          /* One of the two 500 bodies OBSERVED live; the other is `text`. */
          pdfFailure: 'json',
        })

        const report = await pollUntil(
          async () => await org.api.get(`/orders/${orderA.id}/report`),
          (response) => response.body?.status === 'FINAL',
          NEGATIVE_WAIT_MS,
          1_000,
        )
        expect(report.body.status).toBe('FINAL')
      } finally {
        expectOk(
          await mock.post(`/__control__/kits/${KIT_BATCH_PDF_FAILS}/pdf`, { pdfFailure: null }),
          'clear the PDF failure flag',
        )
      }
    }, NEGATIVE_WAIT_MS + 90_000)

    it('with the PDF failure cleared, both result sets of that batch complete', async () => {
      /* The positive twin of the tripwire above, and the proof that nothing else was wrong with
       * either result set: the same two sets, still unacknowledged because the batch never got as
       * far as acking anything, complete on the next healthy tick. */
      for (const [label, orderId] of [['healthy', batchOrderIds.healthy], ['pdf-failing', batchOrderIds.broken]] as const) {
        const report = await pollUntil(
          async () => await org.api.get(`/orders/${orderId}/report`),
          (response) => response.body?.status === 'FINAL',
          COMPLETION_WAIT_MS,
          1_000,
        )
        expect({ label, status: report.body?.status }).toEqual({ label, status: 'FINAL' })
      }

      /* Both acknowledged, so the feed really drained rather than the reports arriving by some
       * other route. */
      const sets = expectOk<{ resultSets: Array<{ kitCode: string, acknowledged: boolean }> }>(
        await mock.get('/__control__/result-sets'),
        'read the mock result sets after the batch recovered',
      ).resultSets
      expect(sets.find((set) => set.kitCode === KIT_BATCH_HEALTHY)?.acknowledged).toBe(true)
      expect(sets.find((set) => set.kitCode === KIT_BATCH_PDF_FAILS)?.acknowledged).toBe(true)
    }, COMPLETION_WAIT_MS + 60_000)

    it.failing('the integration re-authenticates when the provider stops accepting its token', async () => {
      /* EXPECTED: a 401 from the provider makes the integration fetch a new token. ACTUAL: it never
       * does — so a credential that is rotated or revoked at the vendor fails every call for up to
       * TEN DAYS rather than recovering.
       *
       * `authenticate` caches the token per username for `expires_in * 0.25`, and the vendor's
       * `expires_in` is 3 456 000 seconds — 40 days OBSERVED, so a 10-day cache — and nothing
       * anywhere invalidates that entry on a 401. The mock reproduces the vendor's half faithfully:
       * its revocation switch keeps the tokens it issued and simply stops accepting them, exactly
       * as a revoked credential would, so a re-authentication would succeed and the loop would
       * recover within one poll.
       *
       * Measured at the grant endpoint rather than in dmi-api, because the results path throws a
       * plain `Error` that never reaches dmi-api as a provider error: the only observable is
       * whether a new token was ever asked for. LAST, because the failing polls it provokes are
       * retried three times each with exponential backoff and the backlog has to drain. */
      const before = (await mockCalls()).counters.login

      try {
        expectOk(await mock.post('/__control__/bearer', { accept: false }), 'revoke bearer acceptance at the mock')

        const logins = await pollUntil(
          async () => (await mockCalls()).counters.login,
          (count) => count > before,
          NEGATIVE_WAIT_MS,
          1_000,
        )
        expect(logins).toBeGreaterThan(before)
      } finally {
        expectOk(await mock.post('/__control__/bearer', { accept: true }), 'restore bearer acceptance at the mock')
      }
    }, NEGATIVE_WAIT_MS + 60_000)
  })
})
