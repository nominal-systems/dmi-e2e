import { randomUUID } from 'crypto'
import { ApiClient, expectOk } from '../src/api-client'
import { env } from '../src/env'
import { pollUntil } from '../src/poll'
import { lookupRefCode } from '../src/refs'
import { adminLogin, orderPayload, seedOrganization, SeededOrg } from '../src/seed'
import { closePool, query } from '../src/sql'

/* Full-system gate for Antech V6 (HARNESS_FULL_STACK=1, HARNESS_STACK=antech-v6): dmi-api under a
 * NORMAL NODE_ENV, wired over real MQTT/Bull/HTTP to the REAL `dmi-engine` container — which is
 * what hosts the antech-v6 integration in production, as an npm module rather than a container of
 * its own — and an Antech V6 mock provider (src/antech-v6-mock). Every hop is real except the
 * provider, which is the mock, so the run is deterministic and never touches a live Antech host.
 *
 * THE LOOP IS SHAPED DIFFERENTLY FROM THE OTHER THREE, in three ways that decide what the
 * assertions below can and cannot claim.
 *
 * 1. THE ENGINE IS SPLIT INTO TWO PROCESSES, as production runs it. `dmi-engine-api` attaches the
 *    MQTT handlers dmi-api RPCs (order create; integration create, which SCHEDULES the repeatable
 *    Bull jobs) and `dmi-engine-worker` runs those jobs against the mock. So an order is enqueued
 *    by one process and polled by another, through Redis. A loop that closes here has exercised
 *    that handoff; a single-role container would have hidden it.
 *
 * 2. THERE ARE TWO PLACEMENT PATHS, and the integration chooses between them. A real order
 *    (`POST /LabOrders/v6/Order`) only when the request asked for `autoSubmitOrder`, the
 *    integration option `autoSubmitEnabled` allows it, AND every ordered code is point-of-care per
 *    Antech's own test guide. Otherwise a PRE-ORDER (`.../PreOrderPlacement`) — a draft, which dmi
 *    reports as WAITING_FOR_INPUT with a `submissionUri` for a human to finish in Antech's UI.
 *    Both paths are driven below, and the POC catalogue flag is what selects between them, so the
 *    scenario picks its test codes BY FLAG (from the mock's control plane) and never by position.
 *
 * 3. ONLY THE RESULTS CHANNEL CAN COMPLETE AN ORDER TODAY, and that is not a property of this
 *    harness — it is a defect in the integration, tracked privately. `OrderStatus` is a STRING on
 *    the wire (`"Submitted"`, `"Received"`, `"Final"`, …) while the integration's status enum is a
 *    bare numeric one, so its `mapOrderStatus` switch never matches a wire value and every polled
 *    status falls to its default, dmi SUBMITTED. The orders channel can therefore move an order
 *    WAITING_FOR_INPUT -> SUBMITTED (that transition is asserted, on the promoted draft) and
 *    nothing further. A tripwire at the bottom of this file asserts the CORRECT behaviour and is
 *    marked `failing` while the defect stands.
 *
 * RECONCILIATION. dmi-api matches a polled result to its order on `externalId`, and for antech-v6
 * that is the whole of it: `mapAntechV6Result` attaches a `.order` to a result ONLY when the result
 * is an orphan (empty ClinicAccessionID), and this harness seeds no orphans — so dmi-api's
 * patient-matching guard (`ProviderResultUtils.isMatchingOrder`) is never consulted and the
 * `pims:patient:id` identifier is a FREE CHOICE, as with zoetis rather than with idexx (which must
 * supply one) or antech-v3 (which must omit one). The orders here keep the harness's default
 * patient identifier, which becomes the provider's `PetID`, because carrying it costs nothing and
 * makes the forwarded patient assertable. The id that matters is
 * `requisitionId == ClinicAccessionID == externalId`.
 *
 * POLL CADENCE. The engine exposes ANTECH_V6_POLLING_INTERVAL_MS and the compose profile dials it
 * to ~3s (the engine's own default is 60s), so the waits below are short — but they still budget
 * several ticks, because the repeatable jobs are only scheduled once the integration's start event
 * has been handled. A slow pass is the poll cadence, not a hang.
 *
 * WHAT MAKES THESE ASSERTIONS WORTH ANYTHING is that the mock VALIDATES rather than defaults: it
 * refuses an order missing a required field, an order carrying a code outside the catalogue it
 * advertises, a call without an access token, a foreign clinic, and — verbatim, as the live
 * endpoint does — a BreedID that does not belong to its SpeciesID. A mock that substituted its own
 * values would make the forwarding assertions below pass against its own invention. */

/* The compose profile's ANTECH_V6_POLLING_INTERVAL_MS. */
const POLL_MS = 3_000

/* Generous multiples of the poll interval rather than tight ones: the first tick only happens once
 * the integration's start event has been handled and the repeatable jobs scheduled, and the orders
 * poll does a login + status + per-order result-status + (sometimes) a TRF fetch per tick. */
const COMPLETION_WAIT_MS = 60_000
const ORDER_ACK_WAIT_MS = 45_000
/* How long to wait before concluding that something did NOT happen. Used only by the tripwires and
 * by the "the draft is invisible" assertion, where a short budget is the point. */
const NEGATIVE_WAIT_MS = 20_000

/* ---- ref mapping ----
 *
 * dmi-api seeds NO antech-v6 `provider_ref` rows, so this scenario does what an operator does: it
 * syncs the provider's reference data (the engine reads the mock's `Master/v6/GetSpeciesBreed` and
 * its own local sex enum) and then maps three canonical dmi refs onto three provider refs.
 *
 * The pairing below is the whole point of the mapping assertions. dmi's canonical codes are opaque
 * UUIDs, so the scenario looks each one up BY NAME over `GET /refs/*` rather than hard-coding a
 * UUID that would rot silently, and what must come out the other end is ANTECH's vocabulary —
 * numeric species and breed ids, and a two-letter sex code. Input and expected output are
 * deliberately different: if the mapping stopped resolving, the integration would fall back to its
 * own defaults (SpeciesID 49 + BreedID 370) and the mock would REFUSE the placement, because 370 is
 * species 41's breed and species 49's only breed is 648. That is a loud red, and it is the same
 * refusal the live endpoint gives. */
const SPECIES_REF_NAME = 'Canis familiaris'
const EXPECTED_SPECIES_ID = 41
const BREED_REF_NAME = 'Labrador Retriever'
const EXPECTED_BREED_ID = 130
const SEX_REF_NAME = 'Male Sterilized'
const EXPECTED_PET_SEX = 'CM'

/* Deliberately left UNMAPPED, for the fully-unmapped-patient tripwire at the bottom. `Felidae` is
 * the canonical dmi species ref for cats; nothing below maps it to antech-v6. */
const UNMAPPED_SPECIES_REF_NAME = 'Felidae'
/* A plain descriptive string, not a ref code: it resolves to nothing for any provider, so the
 * integration's breed fallback (370) is what reaches the mock. */
const UNMAPPED_BREED = 'Ragdoll'

/* The integration's own fallback pair, and the reason the tripwire exists. */
const DEFAULT_PET_SPECIES = 49
const DEFAULT_PET_BREED = 370

/* A clinic the seeded account does not own. The mock refuses the login, and the refusal surfaces
 * end to end as the provider's own bare-text body. */
const FOREIGN_CLINIC_ID = '999000'

/* ---- catalogue codes ----
 *
 * Genuine Antech mnemonics, named here because the panels differ in what they can demonstrate: the
 * Kidney Panel carries the chemistry analytes the value assertions pin, the CBC is the one profile
 * the integration RE-SEQUENCES, and the heartworm test is a single qualitative assay. They are
 * resolved against the mock's catalogue at setup and their POC flag is ASSERTED rather than assumed
 * — the flag is what selects between the two placement paths and what decides whether a TRF is
 * fetched, so a code whose flag changed would silently move three tests onto the other path.
 * `referenceLabCode` is picked by flag alone, since any non-POC code will do. */
const KIDNEY_PANEL_CODE = 'HDC-3'
const CBC_CODE = 'HHEM-1'
const HEARTWORM_CODE = 'HTR-1'

/* ---- seeded result content ----
 *
 * Every value, unit and reference range here is INVENTED within plausible veterinary limits. The
 * analyte names are the panels' own (and, for the CBC, exactly the names the integration's
 * re-sequencing table keys on — which is what makes the ordering assertion possible at all). */

/* Kidney Panel: an in-range numeric, an out-of-range numeric flagged HIGH, and a numeric sitting
 * exactly on its upper bound with no flag. Three distinct mapper branches. */
const KIDNEY_PANEL = [
  { test: 'BUN', testCodeExtID: 'BUN', result: '24.3', unit: 'mg/dl', range: '9.0-29.0' },
  {
    test: 'CREA',
    testCodeExtID: 'CREA',
    result: '2.4',
    unit: 'mg/dl',
    range: '0.5-1.8',
    abnormalFlag: 'H',
    comments: 'Repeat with a fasted sample.',
  },
  { test: 'GLOB', testCodeExtID: 'GLOB', result: '3.6', unit: 'g/dl', range: '2.0-3.6' },
]

/* The CBC, seeded DELIBERATELY OUT OF the integration's sequence. `TEST_RESULT_SEQUENCING_MAP`
 * re-orders the items of any unit code result whose OrderCode is `HHEM-1`, so the report must come
 * back in the map's order, not this one. `PLT Histogram` carries a non-numeric result, which is
 * both faithful (a histogram row has no number) and the one item here that takes the mapper's
 * valueString branch. */
const CBC_SEEDED_ORDER = [
  { test: 'PLT Histogram', testCodeExtID: 'PLTHIST', result: 'see attached' },
  { test: 'HCT', testCodeExtID: 'HCT', result: '44.5', unit: '%', range: '37.3-61.7' },
  { test: 'WBC', testCodeExtID: 'WBC', result: '11.2', unit: 'K/uL', range: '5.7-16.3' },
  { test: 'MPV', testCodeExtID: 'MPV', result: '11.4', unit: 'fL', range: '8.7-13.2' },
  { test: 'NEU', testCodeExtID: 'NEU', result: '7.8', unit: 'K/uL', range: '3.0-11.5' },
  { test: 'PLT', testCodeExtID: 'PLT', result: '320', unit: 'K/uL', range: '143-448' },
  { test: 'LYM', testCodeExtID: 'LYM', result: '2.1', unit: 'K/uL', range: '1.0-4.9' },
]

/* The order `TEST_RESULT_SEQUENCING_MAP['HHEM-1']` puts those seven in. Written out rather than
 * derived from the seed, so the assertion is a pin rather than a restatement of the input. */
const CBC_EXPECTED_ORDER = ['WBC', 'NEU', 'LYM', 'HCT', 'PLT', 'MPV', 'PLT Histogram']

interface Observation {
  code: string
  name?: string
  valueQuantity?: { value: number, units?: string | null } | null
  valueString?: string | null
  referenceRange?: Array<{ low?: number, high?: number, text?: string }> | null
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

/* dmi-api's ref types, as the `ref`/`provider_ref` tables spell them: SINGULAR. The public
 * `GET /refs/<kind>` routes use the plural; the admin ones take a `:type` they pass straight into
 * the query, so they need the singular. */
type RefType = 'species' | 'breed' | 'sex'

interface ProviderRefItem {
  code: string
  name: string
  species?: string
}

interface CatalogueEntry {
  code: string
  name: string
  category: string
  price: number
  pointOfCare: boolean
  labId: number
}

interface MockOrder {
  clinicAccessionId: string
  vendorId: string
  kind: string
  labAccessionId: string | null
  orderStatus: string | null
  resultStatus: string | null
  orderAcked: boolean
  orderAckedStatus: string | null
  resultStatusAcked: boolean
  trfFetches: number
  clinicId: string
  labId: number | null
  petId: string | null
  petName: string
  petSex: string
  petAge: number | null
  petAgeUnits: string | null
  speciesId: number
  breedId: number
  clientFirstName: string
  clientLastName: string
  doctorFirstName: string
  doctorLastName: string
  orderCodes: string[]
  hasResult: boolean
}

describe('antech-v6 full-stack (Antech V6 mock)', () => {
  let root: ApiClient
  let org: SeededOrg
  let admin: ApiClient

  /* Host-facing client for the mock's control plane (/__control__/*) and its provider endpoints,
   * which a few tests probe directly to pin the error envelopes the loop never provokes. */
  const mock = ApiClient.create(env.antechV6.mockBaseUrl)

  /* The mock's catalogue, read from its control plane at setup. */
  let catalogue: CatalogueEntry[] = []
  let pocCodes: string[] = []
  let referenceLabCode = ''

  /* The provider's own reference data, read through the engine at setup (see beforeAll). */
  let liveSpecies: ProviderRefItem[] = []
  let liveBreeds: ProviderRefItem[] = []
  let liveSexes: ProviderRefItem[] = []
  /* What the admin ref sync did, recorded rather than asserted — the tripwire reports it. */
  let syncResponse: { status: number, ok: boolean, text: string } = { status: 0, ok: false, text: '' }
  let speciesRefsAfterSync = -1
  let providerRefsWereSeededDirectly = false

  /* Canonical dmi ref codes (opaque UUIDs), resolved by name at setup. */
  let speciesRefCode = ''
  let breedRefCode = ''
  let sexRefCode = ''
  let unmappedSpeciesRefCode = ''

  /* The headline POC order. */
  let pocOrderId = ''
  let pocRequisitionId = ''
  let pocReportId = ''
  let pocLabAccessionId = ''
  /* Highest event seq observed before the headline result was seeded, so the /events assertion can
   * prove which events the RESULT loop produced rather than counting ones order creation emitted. */
  let seqBeforeSeed = 0

  /* The pre-order (draft) path. */
  let draftOrderId = ''
  let draftRequisitionId = ''

  let orderSeq = 0

  /* A patient built on the harness's defaults, with the ref codes the mapping will transform and a
   * unique PIMS identifier per order.
   *
   * NOTE the shape: `orderPayload`'s `patient:` override REPLACES the whole default patient,
   * identifier included, so anything that must survive is merged in here rather than assumed. */
  function patientFor (overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      name: 'Rex',
      sex: sexRefCode,
      species: speciesRefCode,
      breed: breedRefCode,
      identifier: [{ system: 'pims:patient:id', value: `pat-${randomUUID().slice(0, 8)}` }],
      ...overrides,
    }
  }

  function payloadFor (
    testCodes: string[],
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    orderSeq += 1
    const base = orderPayload(org.integrationId, {
      patient: patientFor(),
      testCodes: testCodes.map((code) => ({ code })),
    })
    /* A readable, unique requisitionId. It becomes the provider's ClinicAccessionID, the dmi
     * order's externalId, and the key the mock's control plane is addressed by — so making it
     * greppable per test pays for itself the first time a run goes red. */
    return { ...base, requisitionId: `hrn-v6-${orderSeq}-${randomUUID().slice(0, 8)}`, ...overrides }
  }

  async function mockOrder (clinicAccessionId: string): Promise<MockOrder> {
    return expectOk<MockOrder>(
      await mock.get(`/__control__/orders/${encodeURIComponent(clinicAccessionId)}`),
      `read order ${clinicAccessionId} from the mock control plane`,
    )
  }

  async function observationsFor (orderId: string): Promise<Observation[]> {
    const response = await org.api.get(`/orders/${orderId}/report`)
    const panels = (response.body?.testResultsSet ?? []) as TestResultSet[]
    return panels.flatMap((panel) => panel.observations ?? [])
  }

  /* Admin helpers for the ref sync + mapping. dmi ref ids are numeric row ids (the CODES are the
   * UUIDs), so both halves of a mapping have to be looked up rather than known. */
  /* NOTE the explicit `page`: both admin listings declare their query as an INTERSECTION TYPE
   * (`PaginationDto & { search?: string }`) rather than a DTO class, so Nest's ValidationPipe never
   * instantiates PaginationDto and its `page = 1` default never applies — a caller that omits it
   * gets a 500 ("Provided \"skip\" value is not a number"). Supplying it is the workaround, not a
   * preference. */
  async function canonicalRefId (type: RefType, name: string): Promise<number> {
    /* SINGULAR, and that is not a typo. `GET /admin/refs/:type` declares its parameter as
     * 'species' | 'breeds' | 'sexes' but uses it verbatim as `ref.type = :type`, and the column
     * holds the singular ('species', 'breed', 'sex') — so the two plural values the signature
     * advertises match no rows at all and the route answers an empty page. `species` works only
     * because it is spelled the same either way. */
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
      await admin.get(`/admin/providers/antech-v6/refs/${type}`, { page: 1, limit: 500 }),
      `list antech-v6 ${type} provider refs`,
    )
    return listing.data
  }

  /* Write provider_ref rows straight into MySQL. The one sanctioned crack in the black box (see
   * src/sql.ts): no HTTP route creates a provider_ref, and the admin route that should is broken.
   * The table is part of dmi-api's migration-defined schema, so a schema change breaks this loudly
   * — which is the point of doing it in raw SQL rather than through an ORM. */
  async function insertProviderRefs (
    type: 'species' | 'breed' | 'sex',
    items: ProviderRefItem[],
  ): Promise<void> {
    for (const item of items) {
      await query(
        'INSERT INTO `provider_ref` (`code`, `name`, `species`, `type`, `provider`) VALUES (?, ?, ?, ?, ?)',
        [item.code, item.name, item.species ?? null, type, 'antech-v6'],
      )
    }
  }

  async function mapRef (type: RefType, refName: string, providerCode: string): Promise<void> {
    const refId = await canonicalRefId(type, refName)
    const providerRef = (await providerRefs(type)).find((entry) => entry.code === providerCode)
    if (providerRef === undefined) {
      throw new Error(
        `dmi-api holds no antech-v6 ${type} provider ref with code '${providerCode}' — ` +
          'either the reference data never reached it or the mock catalogue changed',
      )
    }
    expectOk(
      await admin.post(`/admin/refs/${refId}/mapping`, {
        providerId: 'antech-v6',
        providerRefId: providerRef.id,
      }),
      `map dmi ${type} '${refName}' to antech-v6 ${type} '${providerCode}'`,
    )
  }

  beforeAll(async () => {
    /* A fresh container starts clean; the reset only matters for warm reruns (HARNESS_KEEP_UP),
     * where it clears the previous run's orders and results. */
    await mock.post('/__control__/reset').catch(() => undefined)

    /* Read the catalogue the mock both advertises at /Tests/v6 and enforces at placement, so the
     * scenario and the mock cannot drift onto different code lists. */
    catalogue = expectOk<{ tests: CatalogueEntry[] }>(
      await mock.get('/__control__/catalogue'),
      'read the mock test catalogue',
    ).tests
    pocCodes = catalogue.filter((test) => test.pointOfCare).map((test) => test.code)
    referenceLabCode = catalogue.find((test) => !test.pointOfCare)?.code ?? ''

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
        /* Without this the integration refuses to auto-submit even when asked, and every order
         * below would take the pre-order path. */
        autoSubmitEnabled: true,
      },
    })

    admin = await adminLogin(root)

    /* Start the integration FIRST: the ref sync RPCs the engine, and the engine only answers for a
     * running integration's message pattern once its module is up. Starting also schedules the
     * repeatable Bull jobs, which is what makes the loop below run at all. */
    const startResponse = await admin.post(`/admin/integrations/${org.integrationId}/start`)
    console.log(
      `[antech-v6-scenario] integration start -> HTTP ${startResponse.status}: ${startResponse.text.slice(0, 200)}`,
    )
    expectOk(startResponse, 'start integration')

    /* Read the provider's reference data LIVE, through the engine. `GET /refs/<kind>/<providerId>`
     * does the same RPC dmi-api's ref sync does and hands the answer straight back without storing
     * it — so this is the round trip itself: dmi-api -> MQTT -> the engine -> the integration ->
     * the mock's `Master/v6/GetSpeciesBreed` (species and breeds) or the integration's own local
     * sex enum (sexes), and back. Everything downstream is derived from these three lists. */
    liveSpecies = expectOk<{ items: ProviderRefItem[] }>(
      await org.api.get('/refs/species/antech-v6', { integrationId: org.integrationId }),
      'read the antech-v6 species list through the engine',
    ).items
    liveBreeds = expectOk<{ items: ProviderRefItem[] }>(
      await org.api.get('/refs/breeds/antech-v6', { integrationId: org.integrationId }),
      'read the antech-v6 breed list through the engine',
    ).items
    liveSexes = expectOk<{ items: ProviderRefItem[] }>(
      await org.api.get('/refs/sexes/antech-v6', { integrationId: org.integrationId }),
      'read the antech-v6 sex list through the engine',
    ).items

    /* The operator's real path: dmi-api asks the engine for those same lists and UPSERTS them as
     * `provider_ref` rows, which is the only thing that makes a canonical ref mappable to a
     * provider code. It is attempted here rather than asserted, because it does not work — see the
     * tripwire below, which pins the correct behaviour. The outcome is recorded so that tripwire
     * can report what actually happened rather than re-running it. */
    syncResponse = await admin.post('/admin/refs/sync/antech-v6', undefined, {
      integrationId: org.integrationId,
    })
    console.log(
      `[antech-v6-scenario] refs sync -> HTTP ${syncResponse.status}: ${syncResponse.text.slice(0, 300)}`,
    )
    speciesRefsAfterSync = (await providerRefs('species')).length

    if (speciesRefsAfterSync === 0) {
      /* Fallback, so the ref-MAPPING coverage below is not lost to the sync defect. The rows are
       * built from the three lists fetched above — i.e. from the provider's own catalogue, read
       * over the wire this run — and not from literals in this file, so what dmi-api ends up
       * holding is still the provider's data rather than the test's opinion of it. Inserted
       * straight into MySQL because no other route creates a provider_ref; `POST /admin/refs/:id/
       * mapping`, which does work, then joins them to the canonical refs over HTTP as an operator
       * would. */
      await insertProviderRefs('species', liveSpecies)
      await insertProviderRefs('breed', liveBreeds)
      await insertProviderRefs('sex', liveSexes)
      providerRefsWereSeededDirectly = true
      console.log(
        '[antech-v6-scenario] the admin ref sync stored nothing; provider refs seeded directly from ' +
          'the catalogue the engine returned (see the ref-sync tripwire)',
      )
    }

    speciesRefCode = await lookupRefCode(org.api, 'species', SPECIES_REF_NAME)
    breedRefCode = await lookupRefCode(org.api, 'breeds', BREED_REF_NAME)
    sexRefCode = await lookupRefCode(org.api, 'sexes', SEX_REF_NAME)
    unmappedSpeciesRefCode = await lookupRefCode(org.api, 'species', UNMAPPED_SPECIES_REF_NAME)

    await mapRef('species', SPECIES_REF_NAME, String(EXPECTED_SPECIES_ID))
    await mapRef('breed', BREED_REF_NAME, String(EXPECTED_BREED_ID))
    await mapRef('sex', SEX_REF_NAME, EXPECTED_PET_SEX)
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
      const response = await ApiClient.create().get('/health')

      expect(response.status).toBe(200)
      expect(response.body.status).toBe('ok')
      expect(response.body.info).toMatchObject({
        database: { status: 'up' },
        mongo: { status: 'up' },
        activemq: { status: 'up' },
      })
    })

    it('the antech-v6 mock is reachable', async () => {
      const response = await mock.get('/status')

      expect(response.status).toBe(200)
      expect(response.body.status).toBe('ok')
      expect(response.body.service).toBe('antech-v6-mock')
    })

    it('the quickstart bootstrap completed (org, antech-v6 provider config, integration)', () => {
      expect(org.organizationId).toBeTruthy()
      expect(org.providerConfigurationId).toBeTruthy()
      expect(org.integrationId).toBeTruthy()
    })

    it('the mock is provisioned for the clinic and lab the integration was configured with', async () => {
      /* The mock refuses a login for a clinic it was not provisioned for, and refuses a ClinicID it
       * does not recognise on every other call — so if the harness's two halves were configured
       * with different clinics, nothing would work and the symptom would be an empty feed. Pinning
       * them against each other here turns that into a named failure at the first test instead. */
      const config = expectOk<{ clinicId: string, labId: number, pocCodes: string[], referenceLabCodes: string[] }>(
        await mock.get('/__control__/config'),
        'read the mock configuration',
      )

      expect(config.clinicId).toBe(env.antechV6.clinicId)
      expect(config.labId).toBe(Number(env.antechV6.labId))
      /* Both halves of the catalogue are non-empty, or the POC-driven placement decision would be
       * untestable in one direction. */
      expect(config.pocCodes.length).toBeGreaterThanOrEqual(2)
      expect(config.referenceLabCodes.length).toBeGreaterThanOrEqual(1)
      expect(referenceLabCode).toBeTruthy()
      expect(pocCodes).toEqual(config.pocCodes)

      /* The three named panels the tests below rely on, each asserted to be point-of-care rather
       * than assumed to be: the flag is what routes an order to the real-order endpoint instead of
       * the pre-order one, and what suppresses the TRF fetch. A code whose flag changed would move
       * three tests onto the other path without any of them saying so. And the reference-lab code
       * must NOT be point-of-care, or the pre-order path would never be taken at all. */
      for (const code of [KIDNEY_PANEL_CODE, CBC_CODE, HEARTWORM_CODE]) {
        expect({ code, pointOfCare: catalogue.find((test) => test.code === code)?.pointOfCare }).toEqual({
          code,
          pointOfCare: true,
        })
      }
      expect(catalogue.find((test) => test.code === referenceLabCode)?.pointOfCare).toBe(false)
    })

    it('the engine reads Antech\'s species, breed and sex catalogue over the reference-data RPC', () => {
      /* The round trip itself: dmi-api -> MQTT -> the engine -> the integration -> the mock's
       * `Master/v6/GetSpeciesBreed`, and back, fetched at setup through `GET /refs/<kind>/antech-v6`
       * (which does the RPC and returns the answer without storing it).
       *
       * The exact values matter. `getSpecies` maps each species to `{name, code: String(id)}` and
       * `getBreeds` FLATTENS the tree, tagging each breed with `species: String(species.id)` — so
       * this also pins that the flattening kept the parentage, which is the only thing that makes
       * the 49 + 370 pairing detectable further down. */
      expect(liveSpecies.map((item) => item.code).sort()).toEqual(['41', '42', '49'])
      expect(liveSpecies.find((item) => item.code === '41')?.name).toBe('Canine')
      expect(liveSpecies.find((item) => item.code === '49')?.name).toBe('Other species')

      const labrador = liveBreeds.find((item) => item.code === String(EXPECTED_BREED_ID))
      expect(labrador?.name).toBe(BREED_REF_NAME)
      expect(labrador?.species).toBe(String(EXPECTED_SPECIES_ID))
      /* The pairing the unmapped-patient tripwire rests on, read from the provider rather than
       * asserted from memory: breed 370 belongs to species 41, and species 49's only breed is 648. */
      expect(liveBreeds.find((item) => item.code === String(DEFAULT_PET_BREED))?.species).toBe('41')
      expect(liveBreeds.filter((item) => item.species === String(DEFAULT_PET_SPECIES)).map((item) => item.code)).toEqual(['648'])

      /* Sexes need no provider endpoint at all — the integration derives them from its own local
       * enum, and this is the only place that is visible from outside. */
      expect(liveSexes.map((item) => item.code).sort()).toEqual(['CM', 'F', 'M', 'SF', 'U'])
      expect(liveSexes.find((item) => item.code === EXPECTED_PET_SEX)?.name).toBe('MALE_CASTRATED')
    })

    it('dmi-api holds antech-v6 provider refs matching that catalogue', async () => {
      /* dmi-api ships no antech-v6 provider_ref rows: everything here was produced this run, from
       * the lists the engine returned above. (By the admin sync when it works — see the tripwire —
       * and otherwise by the setup's direct insert of those same lists.) A canonical ref can only
       * be mapped to a provider code that exists as a row, so this is the precondition for every
       * mapping assertion below. */
      const species = await providerRefs('species')
      const breeds = await providerRefs('breed')
      const sexes = await providerRefs('sex')

      expect(species.map((ref) => ref.code).sort()).toEqual(['41', '42', '49'])
      expect(species.find((ref) => ref.code === '41')?.name).toBe('Canine')

      expect(breeds.map((ref) => ref.code)).toContain(String(EXPECTED_BREED_ID))
      expect(breeds.find((ref) => ref.code === String(EXPECTED_BREED_ID))?.name).toBe(BREED_REF_NAME)
      /* Breed 370 belongs to species 41, and species 49 has exactly one breed, 648. That is what
       * makes the integration's own 49 + 370 fallback pair invalid at the provider. */
      expect(breeds.map((ref) => ref.code)).toContain(String(DEFAULT_PET_BREED))
      expect(breeds.map((ref) => ref.code)).toContain('648')

      /* Sexes come from the integration's local enum, not from any endpoint. */
      expect(sexes.map((ref) => ref.code).sort()).toEqual(['CM', 'F', 'M', 'SF', 'U'])
      expect(sexes.find((ref) => ref.code === EXPECTED_PET_SEX)?.name).toBe('MALE_CASTRATED')

      /* And the rows really are this provider's, not another's read by accident: every provider in
       * dmi-api has its own species/breed/sex rows, and antech (V3) uses the same numeric code
       * space as antech-v6. */
      expect(species.every((ref) => ref.code !== '')).toBe(true)
      expect(breeds.length).toBe(liveBreeds.length)
    })

    it('the dmi refs the orders are placed with resolve, and are not already the Antech codes', () => {
      /* Guards the falsifiability of every mapping assertion below. If a canonical code happened to
       * be spelled the same as the Antech code it maps to, "the mock received 41" would be equally
       * true of a working mapping and of no mapping at all. */
      expect(speciesRefCode).toBeTruthy()
      expect(breedRefCode).toBeTruthy()
      expect(sexRefCode).toBeTruthy()
      expect(unmappedSpeciesRefCode).toBeTruthy()

      expect(speciesRefCode).not.toBe(String(EXPECTED_SPECIES_ID))
      expect(breedRefCode).not.toBe(String(EXPECTED_BREED_ID))
      expect(sexRefCode).not.toBe(EXPECTED_PET_SEX)
      expect(unmappedSpeciesRefCode).not.toBe(speciesRefCode)
    })
  })

  describe('the auto-submit path: a point-of-care order is placed for real and the results channel closes it', () => {
    it('POST /orders?autoSubmitOrder=true places a real order, SUBMITTED, with externalId == requisitionId', async () => {
      /* Two POC codes, so the integration's "every ordered code is point-of-care" rule is exercised
       * over a set rather than a singleton — and so the result below can carry one unit that
       * reports analytes and one that reports none. */
      const payload = payloadFor([KIDNEY_PANEL_CODE, HEARTWORM_CODE])
      pocRequisitionId = payload.requisitionId as string

      const created = expectOk<{ id: string, externalId: string, requisitionId: string, status: string }>(
        await org.api.post('/orders', payload, { autoSubmitOrder: true }),
        'place an auto-submitted antech-v6 order',
      )
      pocOrderId = created.id

      expect(pocOrderId).toBeTruthy()
      /* `mapAntechV6Order` reports the ClinicAccessionID it SENT as both ids — the provider's own
       * numeric requisition id, which placement returns, is discarded. All three agreeing is the
       * entire basis of antech-v6 reconciliation: it is what lets a polled result find this order. */
      expect(created.requisitionId).toBe(pocRequisitionId)
      expect(created.externalId).toBe(pocRequisitionId)
      /* SUBMITTED, not WAITING_FOR_INPUT: proof the real-order path was taken rather than the
       * pre-order one, i.e. that the test guide was fetched and both codes were found POC. */
      expect(created.status).toBe('SUBMITTED')
    }, 60_000)

    it('the mock received it at the ORDER endpoint with the ref-mapped species, breed and sex', async () => {
      const received = await mockOrder(pocRequisitionId)

      /* `kind: 'order'` is the mock's record of WHICH endpoint was used. A pre-order would read
       * 'preorder' — so this distinguishes the two placement paths at the provider, not just at
       * dmi-api. */
      expect(received.kind).toBe('order')
      expect(received.clinicAccessionId).toBe(pocRequisitionId)
      expect(received.orderStatus).toBe('Submitted')
      expect(received.labAccessionId).toBeTruthy()
      pocLabAccessionId = received.labAccessionId as string

      /* THE POINT OF THIS TEST. species, breed and sex are the only order fields dmi-api transforms
       * on the way to the provider, and they must arrive in ANTECH's vocabulary. Asserting the
       * exact values — as NUMBERS for the two ids, which is what the integration's parseInt
       * produces — is what makes a silently broken mapping fail here rather than produce a
       * well-formed order carrying a code Antech has never heard of. (Belt and braces: the mock
       * also enforces its own species/breed tree at placement, so a fallback to 49 + 370 would have
       * been refused in the test above. Both checks are deliberate — one proves the provider
       * refuses it, this one proves what was actually sent.) */
      expect(received.speciesId).toBe(EXPECTED_SPECIES_ID)
      expect(received.breedId).toBe(EXPECTED_BREED_ID)
      expect(received.petSex).toBe(EXPECTED_PET_SEX)

      /* The rest of what the integration forwarded. The mock REJECTS an order missing any of these
       * rather than substituting a default, so a regression that dropped one fails at placement —
       * it cannot reach here and quietly match a mock-invented fallback. */
      expect(received.petName).toBe('Rex')
      expect(received.clientFirstName).toBe('Jane')
      expect(received.clientLastName).toBe('Doe')
      expect(received.doctorFirstName).toBe('Ann')
      expect(received.doctorLastName).toBe('Vet')
      expect([...received.orderCodes].sort()).toEqual([KIDNEY_PANEL_CODE, HEARTWORM_CODE].sort())

      /* The integration option and the provider configuration both reached the wire: the clinic id
       * is an integration option, and `LabID` is only sent when the option parses as a positive
       * integer. */
      expect(received.clinicId).toBe(env.antechV6.clinicId)
      expect(received.labId).toBe(Number(env.antechV6.labId))

      /* `extractPetAge`'s default, which fires because the harness order carries no birthdate.
       * Pinned so that a change to the default is a named failure rather than a silent one. */
      expect(received.petAge).toBe(1)
      expect(received.petAgeUnits).toBe('Y')
    })

    it('the orders channel acknowledged the order, and NO TRF was fetched (every code is point-of-care)', async () => {
      /* Waiting on the acknowledgement is what makes the TRF assertion mean anything: an order is
       * only acked after a full orders-poll cycle (poll -> status -> per-order result status ->
       * emit external_orders -> ack), so once the ack lands, the integration has provably decided
       * whether to fetch this order's TRF. Without the ack gate, "no TRF was fetched" would be
       * equally true of a poll that had not run yet. */
      const received = await pollUntil(
        async () => await mockOrder(pocRequisitionId),
        (order) => order.orderAcked,
        ORDER_ACK_WAIT_MS,
        1_000,
      )

      expect(received.orderAcked).toBe(true)
      /* Acknowledged AT the status it was serving — the mock records which one, so this also pins
       * that the ack followed the poll rather than preceding it. */
      expect(received.orderAckedStatus).toBe('Submitted')

      /* The POC rule, observed at the provider. `getBatchOrders` skips the TRF when every mnemonic
       * on the order is point-of-care per the test guide — so a zero here is evidence of three
       * things at once: the test guide was fetched, POC_FLAG=Y really filtered, and the rule ran.
       * If the guide fetch had failed, `getPocCodes` returns undefined, nothing is in-house, and
       * the TRF would have been fetched. */
      expect(received.trfFetches).toBe(0)

      const calls = expectOk<{ testGuidePoc: number, getStatusLabOrder: number, getStatusLabResult: number }>(
        await mock.get('/__control__/calls'),
        'read the mock call counters',
      )
      expect(calls.testGuidePoc).toBeGreaterThanOrEqual(1)
      /* The orders poll fetches the per-order result status inside the same loop; both must have
       * run for the merged order to carry a patient at all. */
      expect(calls.getStatusLabOrder).toBeGreaterThanOrEqual(1)
      expect(calls.getStatusLabResult).toBeGreaterThanOrEqual(1)
    }, ORDER_ACK_WAIT_MS + 30_000)

    it('seeding a result closes the loop: the report reaches FINAL and the order COMPLETED', async () => {
      /* Watermark the event stream before seeding, so the /events test below can distinguish events
       * the RESULT loop produced from the ones order creation already emitted. */
      const before = expectOk<{ data: Array<{ seq: number }> }>(
        await org.api.get('/events', { start_seq: 0, limit: 1000 }),
        'read the event stream before seeding',
      )
      seqBeforeSeed = before.data.reduce((max, event) => Math.max(max, event.seq ?? 0), 0)
      expect(seqBeforeSeed).toBeGreaterThan(0)

      /* Deterministic completion: the mock holds no results until a test seeds one, so the results
       * poll stays empty until this point.
       *
       * TWO unit code results, and the second one is the point of the pair: a unit with
       * ResultStatus 'F' and NO TestCodeResults is FILTERED OUT by the integration (a test that
       * finished with nothing to report). Seeding one is the only way that filter is covered, and
       * without it a filter that stopped working would be invisible. */
      expectOk(
        await mock.post(`/__control__/orders/${encodeURIComponent(pocRequisitionId)}/results`, {
          unitCodeResults: [
            { orderCode: KIDNEY_PANEL_CODE, testCodeResults: KIDNEY_PANEL },
            { orderCode: HEARTWORM_CODE, resultStatus: 'F', testCodeResults: [] },
          ],
          pendingTestCount: 0,
          totalTestCount: 2,
        }),
        'seed a final result at the mock',
      )

      /* Wait on the REPORT reaching FINAL rather than on the order reaching COMPLETED, and ask the
       * question CLAUDE.md insists on: which channels can satisfy this assertion?
       *
       * For antech-v6 the answer is unusually clean, for an unhappy reason. dmi-api sets a report
       * to FINAL in exactly one place (ReportsService, on the `external_results` path); order
       * creation leaves it REGISTERED and no orders-poll path touches it. So FINAL is reachable
       * only through the results channel. And the ORDER's COMPLETED is equally unambiguous here,
       * because the orders channel cannot produce a COMPLETED at all (see the file header: every
       * polled status collapses to SUBMITTED) — and because this order was acknowledged at
       * 'Submitted' in the previous test and the mock does not re-notify on a status change, so it
       * never returns to the unacknowledged feed. Both assertions are the results channel's. */
      const report = await pollUntil(
        async () => await org.api.get(`/orders/${pocOrderId}/report`),
        (response) => response.body?.status === 'FINAL',
        COMPLETION_WAIT_MS,
        1_000,
      )
      expect(report.body.status).toBe('FINAL')
      pocReportId = report.body.id

      const order = await org.api.get(`/orders/${pocOrderId}`)
      expect(order.body.status).toBe('COMPLETED')
    }, COMPLETION_WAIT_MS + 30_000)

    it('the report carries the exact values, units, range bounds and interpretation codes', async () => {
      const report = expectOk<ReportBody>(
        await org.api.get(`/orders/${pocOrderId}/report`),
        'read the order report',
      )

      expect(report.status).toBe('FINAL')
      /* EXACTLY one panel, and it is the one that reported analytes. The second seeded unit —
       * ResultStatus 'F' with no TestCodeResults — must have been dropped by the integration's
       * filter; if it stopped filtering, this is two panels, not zero, so the failure names itself. */
      expect((report.testResultsSet ?? []).map((panel) => panel.code)).toEqual([KIDNEY_PANEL_CODE])
      expect(report.testResultsSet?.[0]?.name).toBe('Kidney Panel')

      const observations = report.testResultsSet?.[0]?.observations ?? []
      expect(observations.map((observation) => observation.code)).toEqual(['BUN', 'CREA', 'GLOB'])

      /* BUN: an in-range numeric with units and both range bounds. The `9.0-29.0` text form is
       * split by the integration into low/high, and both are asserted — a range that stopped
       * parsing would still be "defined". */
      const bun = observations.find((observation) => observation.code === 'BUN')
      expect(bun?.name).toBe('BUN')
      expect(bun?.valueQuantity?.value).toBe(24.3)
      expect(bun?.valueQuantity?.units).toBe('mg/dl')
      expect(bun?.referenceRange).toEqual([
        expect.objectContaining({ low: 9, high: 29, text: '9.0-29.0' }),
      ])
      /* No AbnormalFlag on the wire means no interpretation at all. dmi-api serialises the absent
       * interpretation as an explicit null (a nullable column), so normalise before asserting
       * rather than expecting undefined. */
      expect(bun?.interpretation ?? null).toBeNull()

      /* CREA: out of range and flagged. 'H' is the WIRE value of dmi-engine-common's
       * TestResultItemInterpretationCode.HIGH — 'L' is LOW — so pinning it exactly distinguishes an
       * inverted flag from a missing one, which `toBeDefined()` would not. `text` carries Antech's
       * own flag character. And `Comments` become the observation's notes. */
      const crea = observations.find((observation) => observation.code === 'CREA')
      expect(crea?.valueQuantity?.value).toBe(2.4)
      expect(crea?.valueQuantity?.units).toBe('mg/dl')
      expect(crea?.referenceRange).toEqual([
        expect.objectContaining({ low: 0.5, high: 1.8, text: '0.5-1.8' }),
      ])
      expect(crea?.interpretation).toMatchObject({ code: 'H', text: 'H' })
      expect(crea?.notes).toBe('Repeat with a fasted sample.')

      /* GLOB: sitting exactly on its upper bound, unflagged. Pinned because "on the boundary" is
       * where an off-by-one in a range check would show, and because it is the third distinct
       * shape in this panel. */
      const glob = observations.find((observation) => observation.code === 'GLOB')
      expect(glob?.valueQuantity?.value).toBe(3.6)
      expect(glob?.valueQuantity?.units).toBe('g/dl')
      expect(glob?.referenceRange).toEqual([
        expect.objectContaining({ low: 2, high: 3.6, text: '2.0-3.6' }),
      ])
      expect(glob?.interpretation ?? null).toBeNull()
    })

    it('the result was served once and acknowledged once, on the irregular labAccessionsIds channel', async () => {
      /* Antech's acknowledge model is the reason this assertion exists. The integration emits the
       * results to dmi-api and THEN acks them by LabAccessionID; an acknowledged result leaves the
       * GetAllResults feed. If it did not — if the mock served results unconditionally, or if the
       * ack body's irregular plural (`labAccessionsIds`, note the extra s) stopped matching — the
       * feed would redeliver the same document every tick forever. dmi-api merges redeliveries, so
       * the report would still read FINAL and every assertion above would stay green: exactly once
       * is the only thing that catches it.
       *
       * Waited out over several poll intervals first, so "once" means "and not again", not "not
       * yet". */
      await new Promise((resolve) => setTimeout(resolve, POLL_MS * 4))

      const result = expectOk<{
        labAccessionId: string
        acknowledged: boolean
        servedCount: number
        ackCount: number
      }>(
        await mock.get(`/__control__/orders/${encodeURIComponent(pocRequisitionId)}/result`),
        'read the seeded result state from the mock control plane',
      )

      expect(result.labAccessionId).toBe(pocLabAccessionId)
      expect(result.acknowledged).toBe(true)
      expect(result.servedCount).toBe(1)
      expect(result.ackCount).toBe(1)
    }, 60_000)

    it('Mongo events show the order and report lifecycle, including the result loop', async () => {
      const events = expectOk<{
        data: Array<{ seq: number, type: string, data?: { orderId?: string, reportId?: string } }>
      }>(await org.api.get('/events', { start_seq: 0, limit: 1000 }), 'list events')

      /* Scope to this order/report explicitly: /events is not tenant-scoped (a known dmi-api
       * finding), and this file places several orders. */
      const mine = events.data.filter(
        (event) => event.data?.orderId === pocOrderId || event.data?.reportId === pocReportId,
      )

      expect(Array.from(new Set(mine.map((event) => event.type)))).toEqual(
        expect.arrayContaining(['order:created', 'order:updated', 'report:created', 'report:updated']),
      )

      /* That set is weaker than it looks: order:created, order:updated AND report:created are all
       * emitted while the order is being placed, before any result exists. So assert separately on
       * the events that appeared only AFTER the result was seeded — that is the part the result
       * loop is responsible for, and the part that would go missing if reconciliation broke. */
      const afterSeed = new Set(
        mine.filter((event) => event.seq > seqBeforeSeed).map((event) => event.type),
      )
      expect(Array.from(afterSeed)).toEqual(
        expect.arrayContaining(['order:updated', 'report:updated']),
      )
    })

    it('the audit trail recorded the placement against this integration, with its accession id', async () => {
      /* Every provider response the integration's interceptor does not filter is emitted as
       * `raw_data` and stored by dmi-api. Asserting the PLACEMENT record is a positive check on
       * three separate things: the interceptor ran, its `extractAccessionIds` picked the
       * ClinicAccessionID out of the request body, and the integration id travelled with the call
       * (it comes from the request context the engine's module installs). */
      const records = await pollUntil(
        async () =>
          expectOk<{ data: Array<{ url: string, status: number, method: string, accessionIds?: string[], provider: string }> }>(
            await admin.get('/admin/external-requests', {
              providers: 'antech-v6',
              integrationId: org.integrationId,
              page: 1,
              limit: 200,
            }),
            'read the antech-v6 audit trail',
          ).data,
        (data) => data.some((record) => record.url.includes('/LabOrders/v6/Order')),
        ORDER_ACK_WAIT_MS,
        1_000,
      )

      const placement = records.find((record) => record.url.includes('/LabOrders/v6/Order'))
      expect(placement).toBeDefined()
      expect(placement?.provider).toBe('antech-v6')
      expect(placement?.method).toBe('POST')
      expect(placement?.status).toBe(200)
      expect(placement?.accessionIds).toEqual([pocRequisitionId])

      /* The login is deliberately NOT audited on the success path (the interceptor excludes it), so
       * its absence is a pin too: a change that started storing credentials-adjacent traffic would
       * fail here. */
      expect(records.some((record) => record.url.includes('/Users/v6/Login') && record.status < 400)).toBe(false)
    }, ORDER_ACK_WAIT_MS + 30_000)
  })

  describe('a CBC comes back in the sequence the integration enforces', () => {
    /* The integration carries a per-profile ordering table and applies it to any unit code result
     * whose OrderCode is `HHEM-1` — the analyser reports its channels in acquisition order, and the
     * report has to read in clinical order. Nothing else in this suite covers it, and the
     * transformation is invisible unless the seed is deliberately out of sequence. */
    let cbcOrderId = ''
    let cbcRequisitionId = ''

    it('a CBC panel seeded out of order is re-sequenced by the time it reaches the report', async () => {
      const payload = payloadFor([CBC_CODE])
      cbcRequisitionId = payload.requisitionId as string
      const created = expectOk<{ id: string, status: string }>(
        await org.api.post('/orders', payload, { autoSubmitOrder: true }),
        'place an auto-submitted CBC order',
      )
      cbcOrderId = created.id
      expect(created.status).toBe('SUBMITTED')

      expectOk(
        await mock.post(`/__control__/orders/${encodeURIComponent(cbcRequisitionId)}/results`, {
          unitCodeResults: [{ orderCode: CBC_CODE, testCodeResults: CBC_SEEDED_ORDER }],
          pendingTestCount: 0,
          totalTestCount: 1,
        }),
        'seed a deliberately out-of-sequence CBC result',
      )

      const report = await pollUntil(
        async () => await org.api.get(`/orders/${cbcOrderId}/report`),
        (response) => response.body?.status === 'FINAL',
        COMPLETION_WAIT_MS,
        1_000,
      )
      expect(report.body.status).toBe('FINAL')

      const observations = await observationsFor(cbcOrderId)

      /* The substance: the ORDER, not the set. The seed and the expectation contain the same seven
       * analytes, so a test that compared sorted sets would pass with the sequencing removed
       * entirely. dmi-api stores the integration's per-item seq and orders a report's observations
       * by it, which is what makes the transformation observable from outside at all. */
      expect(observations.map((observation) => observation.name)).toEqual(CBC_EXPECTED_ORDER)
      expect(observations.map((observation) => observation.name)).not.toEqual(
        CBC_SEEDED_ORDER.map((item) => item.test),
      )

      /* And the values survived the re-ordering rather than being shuffled along with the names. */
      const wbc = observations.find((observation) => observation.code === 'WBC')
      expect(wbc?.valueQuantity?.value).toBe(11.2)
      expect(wbc?.valueQuantity?.units).toBe('K/uL')
      /* The histogram row is non-numeric and takes the mapper's valueString branch — no quantity. */
      const histogram = observations.find((observation) => observation.code === 'PLTHIST')
      expect(histogram?.valueString).toBe('see attached')
      expect(histogram?.valueQuantity ?? null).toBeNull()
    }, COMPLETION_WAIT_MS + 60_000)
  })

  describe('the pre-order path: a reference-lab order is a draft until the clinic completes it', () => {
    it('POST /orders pre-orders: WAITING_FOR_INPUT, with a submissionUri carrying a token the mock issued', async () => {
      /* A reference-lab code, so the integration's POC rule sends this down the pre-order path even
       * though auto-submit is requested and enabled. That is the whole reason the catalogue's flags
       * are load-bearing: the same request with a POC code becomes a real order. */
      const payload = payloadFor([referenceLabCode])
      draftRequisitionId = payload.requisitionId as string

      const created = expectOk<{ id: string, externalId: string, requisitionId: string, status: string, submissionUri: string }>(
        await org.api.post('/orders', payload, { autoSubmitOrder: true }),
        'place a reference-lab antech-v6 order',
      )
      draftOrderId = created.id

      expect(created.status).toBe('WAITING_FOR_INPUT')
      expect(created.requisitionId).toBe(draftRequisitionId)
      expect(created.externalId).toBe(draftRequisitionId)

      /* The submissionUri is string-built by the integration from the provider configuration's
       * uiBaseUrl and the token the placement login returned. Pinning its exact shape matters
       * because it is the only thing a human is given to finish the draft with — and because it
       * carries a LIVE access token, which is worth being able to see change. */
      const expectedPrefix = `${env.antechV6.uiBaseUrl}/testGuide?ClinicAccessionID=${draftRequisitionId}&accessToken=`
      expect(created.submissionUri.startsWith(expectedPrefix)).toBe(true)

      const token = created.submissionUri.slice(expectedPrefix.length)
      expect(token).not.toBe('')
      /* Not merely "a non-empty string": the mock confirms it MINTED this token. That is what
       * distinguishes a token that came out of a real login from one invented anywhere in the
       * chain. */
      const tokenState = expectOk<{ issued: boolean, userId: number | null }>(
        await mock.get(`/__control__/tokens/${encodeURIComponent(token)}`),
        'check the submissionUri token against the mock',
      )
      expect(tokenState.issued).toBe(true)
      expect(tokenState.userId).toBeGreaterThan(0)

      /* The mock recorded it at the PRE-ORDER endpoint, with the same ref-mapped patient — the
       * draft path forwards exactly what the order path does. */
      const received = await mockOrder(draftRequisitionId)
      expect(received.kind).toBe('preorder')
      expect(received.speciesId).toBe(EXPECTED_SPECIES_ID)
      expect(received.breedId).toBe(EXPECTED_BREED_ID)
      expect(received.petSex).toBe(EXPECTED_PET_SEX)
      expect(received.orderCodes).toEqual([referenceLabCode])
    }, 60_000)

    it('the draft is invisible to the status feeds and has no TRF, and dmi keeps it WAITING_FOR_INPUT', async () => {
      /* A pre-order enters NEITHER status feed and its requisition form does not exist — the
       * provider's own behaviour, and the reason the engine has no observable signal for the
       * draft -> order transition. Probed directly, because there is no other way to see the
       * absence of something. */
      const login = expectOk<{ Token: string }>(
        await mock.post('/Users/v6/Login', {
          UserName: env.antechV6.username,
          Password: env.antechV6.password,
          ClinicID: env.antechV6.clinicId,
        }),
        'log in to the mock directly',
      )
      /* The harness's ApiClient speaks dmi-api's auth schemes, not Antech's `accessToken` header,
       * so these few provider-side probes go out over plain fetch. */
      const headers = { accessToken: login.Token }
      const views = await Promise.all(
        [
          ['labOrder', 'true'],
          ['labOrder', 'false'],
          ['labResult', 'true'],
          ['labResult', 'false'],
        ].map(async ([serviceType, overrideAck]) => {
          const response = await fetch(
            `${env.antechV6.mockBaseUrl}/LabResults/v6/GetStatus?serviceType=${serviceType}` +
              `&ClinicID=${encodeURIComponent(env.antechV6.clinicId)}&overrideAck=${overrideAck}` +
              `&ClinicAccessionID=${encodeURIComponent(draftRequisitionId)}`,
            { headers },
          )
          return { serviceType, overrideAck, body: (await response.json()) as { LabOrders: unknown[], LabResults: unknown[] } }
        }),
      )

      for (const view of views) {
        /* Both keys always present — the interceptor dereferences both unguarded — and both empty
         * for a draft. */
        expect({
          view: `${view.serviceType}/overrideAck=${view.overrideAck}`,
          orders: view.body.LabOrders.length,
          results: view.body.LabResults.length,
        }).toEqual({ view: `${view.serviceType}/overrideAck=${view.overrideAck}`, orders: 0, results: 0 })
      }

      const trf = await fetch(
        `${env.antechV6.mockBaseUrl}/HTPDF/trf/pims/${encodeURIComponent(draftRequisitionId)}`,
        { headers },
      )
      /* 500, not 404 — the provider's own answer for an accession that has no document. */
      expect(trf.status).toBe(500)
      expect(await trf.json()).toEqual({ StatusCode: 500, ErrorMessage: 'Internal server error' })

      const order = await org.api.get(`/orders/${draftOrderId}`)
      expect(order.body.status).toBe('WAITING_FOR_INPUT')
    }, 60_000)

    it('completing the draft at the provider moves the dmi order to SUBMITTED, and its TRF is fetched', async () => {
      /* The clinic finishes the draft in Antech's own UI. There is no provider endpoint for that —
       * the engine's only polling surface cannot see a draft at all — so the mock's control plane
       * models the completion: the record becomes an order in the feed, as `Submitted`, with a lab
       * accession and a requisition form.
       *
       * This is the ONE assertion in this file that the orders channel can satisfy, and it is worth
       * being precise about why: dmi-api accepts an incoming SUBMITTED only from WAITING_FOR_INPUT
       * or ACCEPTED, and this order is WAITING_FOR_INPUT. The results channel is not involved —
       * nothing is seeded for this order until the next test — so a change here can only have come
       * from `external_orders`. */
      expectOk(
        await mock.post(`/__control__/orders/${encodeURIComponent(draftRequisitionId)}/promote`, {}),
        'promote the draft to a placed order at the mock',
      )

      const order = await pollUntil(
        async () => await org.api.get(`/orders/${draftOrderId}`),
        (response) => response.body?.status === 'SUBMITTED',
        ORDER_ACK_WAIT_MS,
        1_000,
      )
      expect(order.body.status).toBe('SUBMITTED')

      /* And the other half of the POC rule, which the headline order proved in its negative form:
       * this order's only code is a reference-lab one, so the integration MUST have fetched its
       * requisition form. (The mock serves a real `%PDF-1.7` body; the integration base64s it onto
       * the order as a manifest, which dmi-api stores but does not serialise on GET /orders/:id —
       * so the fetch at the provider is the observable half.) */
      const received = await pollUntil(
        async () => await mockOrder(draftRequisitionId),
        (entry) => entry.trfFetches > 0,
        ORDER_ACK_WAIT_MS,
        1_000,
      )
      expect(received.kind).toBe('order')
      expect(received.trfFetches).toBeGreaterThanOrEqual(1)
      expect(received.orderAcked).toBe(true)
    }, ORDER_ACK_WAIT_MS * 2 + 30_000)

    it('seeding a result completes the promoted order too', async () => {
      expectOk(
        await mock.post(`/__control__/orders/${encodeURIComponent(draftRequisitionId)}/results`, {
          unitCodeResults: [
            {
              orderCode: referenceLabCode,
              testCodeResults: [
                { test: 'SDMA', testCodeExtID: 'SDMA', result: '18', unit: 'ug/dl', range: '<14', abnormalFlag: 'H' },
                { test: 'ALB', testCodeExtID: 'ALB', result: '3.1', unit: 'g/dl', range: '2.3-4.0' },
              ],
            },
          ],
          pendingTestCount: 0,
          totalTestCount: 1,
        }),
        'seed a result for the promoted order',
      )

      const report = await pollUntil(
        async () => await org.api.get(`/orders/${draftOrderId}/report`),
        (response) => response.body?.status === 'FINAL',
        COMPLETION_WAIT_MS,
        1_000,
      )
      expect(report.body.status).toBe('FINAL')

      const order = await org.api.get(`/orders/${draftOrderId}`)
      expect(order.body.status).toBe('COMPLETED')

      /* SDMA carries a SINGLE-BOUND range in the `<n` form, which is a different branch of the
       * integration's range parser from the `low-high` form every other analyte here uses: it must
       * produce a `high` and NO `low`. An absent bound may serialise as null or as a missing key,
       * so normalise before asserting. */
      const observations = await observationsFor(draftOrderId)
      const sdma = observations.find((observation) => observation.code === 'SDMA')
      expect(sdma?.valueQuantity?.value).toBe(18)
      expect(sdma?.referenceRange).toEqual([expect.objectContaining({ high: 14, text: '<14' })])
      expect(sdma?.referenceRange?.[0]?.low ?? null).toBeNull()
      expect(sdma?.interpretation).toMatchObject({ code: 'H' })
    }, COMPLETION_WAIT_MS + 30_000)
  })

  describe('a partial result is amended in place', () => {
    /* The clinical norm for a multi-panel order: one panel reports, the other is still running, and
     * the second delivery completes it. dmi-api merges the second delivery into the existing report
     * rather than accumulating a copy, and this is what proves it. Nothing above covers either the
     * PARTIAL branch of the integration's result-status rule or dmi-api's in-place merge. */
    let partialOrderId = ''
    let partialRequisitionId = ''

    const firstDelivery = [
      { test: 'BUN', testCodeExtID: 'BUN', result: '24.3', unit: 'mg/dl', range: '9.0-29.0' },
      { test: 'CREA', testCodeExtID: 'CREA', result: '1.1', unit: 'mg/dl', range: '0.5-1.8' },
    ]
    const AMENDED_BUN = '31.0'

    it('a result with tests still pending reports PARTIAL, and the observations it does carry are readable', async () => {
      const payload = payloadFor([KIDNEY_PANEL_CODE, HEARTWORM_CODE])
      partialRequisitionId = payload.requisitionId as string
      const created = expectOk<{ id: string, status: string }>(
        await org.api.post('/orders', payload, { autoSubmitOrder: true }),
        'place an order that will report partially first',
      )
      partialOrderId = created.id
      expect(created.status).toBe('SUBMITTED')

      /* One of two tests reported. `extractResultStatus` reads ONLY the pending/total counts and
       * `Corrected` — the per-unit ResultStatus is not consulted — so this trio is the whole of the
       * decision: 1 of 2 pending is PARTIAL. */
      expectOk(
        await mock.post(`/__control__/orders/${encodeURIComponent(partialRequisitionId)}/results`, {
          unitCodeResults: [{ orderCode: KIDNEY_PANEL_CODE, resultStatus: 'P', testCodeResults: firstDelivery }],
          pendingTestCount: 1,
          totalTestCount: 2,
        }),
        'seed a partial result',
      )

      const report = await pollUntil(
        async () => await org.api.get(`/orders/${partialOrderId}/report`),
        (response) => response.body?.status === 'PARTIAL',
        COMPLETION_WAIT_MS,
        1_000,
      )
      expect(report.body.status).toBe('PARTIAL')

      /* A partial result moves the ORDER too — `setOrderStatusFromResult` acts on a PARTIAL result
       * status, and dmi-api accepts PARTIAL from SUBMITTED. This is still the results channel: the
       * orders channel cannot produce anything but SUBMITTED. */
      const order = await org.api.get(`/orders/${partialOrderId}`)
      expect(order.body.status).toBe('PARTIAL')

      const observations = await observationsFor(partialOrderId)
      expect(observations.map((observation) => observation.code)).toEqual(['BUN', 'CREA'])
      expect(observations.find((observation) => observation.code === 'BUN')?.valueQuantity?.value).toBe(24.3)
    }, COMPLETION_WAIT_MS + 60_000)

    it('the completing delivery amends in place: FINAL, one copy of each observation, nothing lost', async () => {
      expectOk(
        await mock.post(`/__control__/orders/${encodeURIComponent(partialRequisitionId)}/results`, {
          unitCodeResults: [
            {
              orderCode: KIDNEY_PANEL_CODE,
              testCodeResults: [{ ...firstDelivery[0], result: AMENDED_BUN }, firstDelivery[1]],
            },
            {
              orderCode: HEARTWORM_CODE,
              testCodeResults: [
                { test: 'Heartworm Antigen', testCodeExtID: 'HWAG', result: 'Negative' },
              ],
            },
          ],
          pendingTestCount: 0,
          totalTestCount: 2,
        }),
        'amend the partial result to a complete one',
      )

      const report = await pollUntil(
        async () => await org.api.get(`/orders/${partialOrderId}/report`),
        (response) => response.body?.status === 'FINAL',
        COMPLETION_WAIT_MS,
        1_000,
      )
      expect(report.body.status).toBe('FINAL')

      const panels = (report.body.testResultsSet ?? []) as TestResultSet[]
      expect(panels.map((panel) => panel.code).sort()).toEqual([KIDNEY_PANEL_CODE, HEARTWORM_CODE].sort())

      /* The substance. dmi-api merges a re-delivered result into the existing report by observation
       * CODE, updating matches in place, so an amendment must overwrite rather than accumulate.
       * Asserting one BUN AND its new value AND that the untouched analyte kept its first value is
       * what would catch a merge that started appending — which would otherwise look like a
       * perfectly healthy report with a stale duplicate hiding in it. */
      const observations = await observationsFor(partialOrderId)
      expect(observations.filter((observation) => observation.code === 'BUN')).toHaveLength(1)
      expect(observations.find((observation) => observation.code === 'BUN')?.valueQuantity?.value).toBe(
        Number(AMENDED_BUN),
      )
      expect(observations.find((observation) => observation.code === 'CREA')?.valueQuantity?.value).toBe(1.1)
      /* The second panel's qualitative result: non-numeric, so the valueString branch, and no
       * range. */
      expect(observations.find((observation) => observation.code === 'HWAG')?.valueString).toBe('Negative')
      expect(observations).toHaveLength(3)

      const order = await org.api.get(`/orders/${partialOrderId}`)
      expect(order.body.status).toBe('COMPLETED')
    }, COMPLETION_WAIT_MS + 30_000)
  })

  describe('refusals surface end to end', () => {
    it('an unknown test code fails POST /orders, carrying the provider\'s OWN message', async () => {
      /* Exercises the integration's error path, which the happy path never touches — and
       * specifically the one provider envelope whose wording reaches an operator. The mock rejects
       * a code outside its catalogue with the placement-rejection envelope observed live:
       * `{value: {..., Message: "..."}, statusCode, contentType}`. `AntechV6ApiException` reads
       * `.value.Message`, so the provider's explanation survives; dmi-api re-throws the engine error
       * out of createOrder, and POST /orders answers non-2xx with it in `errors`.
       *
       * Pinning the exact message rather than merely "it failed" is what distinguishes the real
       * branch from the generic `Failed to POST <url>` fallback every other Antech envelope
       * degrades to. A separate order, with its own requisitionId, that never reaches the loop
       * above. */
      const payload = payloadFor(['NOT-A-REAL-ANTECH-CODE'])

      const response = await org.api.post('/orders', payload, { autoSubmitOrder: true })
      console.log(
        `[antech-v6-scenario] unknown-code response -> HTTP ${response.status}: ${response.text.slice(0, 300)}`,
      )

      expect(response.ok).toBe(false)
      expect(response.text).toContain('Invalid OrderCode NOT-A-REAL-ANTECH-CODE')
      /* And the generic fallback is present too, as the LAST-added entry of the error list — so
       * this also pins that the provider message is additional to it, not instead of it. */
      expect(response.text).toContain('/LabOrders/v6/PreOrderPlacement')
    }, 30_000)

    it('an integration pointed at a clinic the account does not own surfaces `Invalid User or Password`', async () => {
      /* The mock accepts any username/password VALUES — they are dummy by design — but refuses a
       * clinic it was not provisioned for, with the bare-text 401 body the live endpoint returns
       * when credentials do not open a session. The interesting part is the surface: that body is a
       * STRING, not JSON, and `AntechV6ApiException`'s `typeof options === 'string'` branch is the
       * only thing that carries it through. A mock that answered credential failures in JSON would
       * leave that branch unexercised.
       *
       * A second practice + integration on the SAME provider configuration, deliberately never
       * started, so it schedules no polling and cannot perturb anything above. */
      const practice = expectOk<{ id: string }>(
        await org.api.post('/practices', { name: `practice-foreign-clinic-${randomUUID().slice(0, 8)}` }),
        'create a practice for the foreign-clinic integration',
      )
      const integration = expectOk<{ id: string }>(
        await org.api.post('/integrations', {
          practiceId: practice.id,
          providerConfigurationId: org.providerConfigurationId,
          integrationOptions: {
            username: env.antechV6.username,
            password: env.antechV6.password,
            clinicId: FOREIGN_CLINIC_ID,
            labId: env.antechV6.labId,
            autoSubmitEnabled: true,
          },
        }),
        'create an integration for a clinic the account does not own',
      )

      const payload = orderPayload(integration.id, {
        patient: patientFor(),
        testCodes: [{ code: KIDNEY_PANEL_CODE }],
      })
      const response = await org.api.post('/orders', payload, { autoSubmitOrder: true })
      console.log(
        `[antech-v6-scenario] foreign-clinic response -> HTTP ${response.status}: ${response.text.slice(0, 300)}`,
      )

      expect(response.ok).toBe(false)
      expect(response.text).toContain('Invalid User or Password')
    }, 30_000)

    it('the mock refuses, in the provider\'s own dialects, every call the loop never makes', async () => {
      /* Direct probes. Each of these is a shape the integration can produce but this loop does not,
       * and each is a DIFFERENT envelope — the variety is itself the contract, because which shape
       * an endpoint returns decides whether Antech's explanation reaches an operator or is replaced
       * by a generic message. Pinning them here keeps the mock from drifting onto one house style. */
      const base = env.antechV6.mockBaseUrl

      /* 1. A missing accessToken header: RFC 9110 401, keyed `message` (lowercase) — which the
       *    integration's error mapper does NOT read. */
      const noToken = await fetch(
        `${base}/LabResults/v6/GetStatus?serviceType=labOrder&ClinicID=${env.antechV6.clinicId}&overrideAck=false`,
      )
      expect(noToken.status).toBe(401)
      expect(await noToken.json()).toMatchObject({
        type: 'https://www.rfc-editor.org/rfc/rfc9110.html#status.401',
        message: 'Access token is missing.',
        status: 401,
        isSuccess: false,
      })

      const login = expectOk<{ Token: string, UserInfo: { ID: number } }>(
        await mock.post('/Users/v6/Login', {
          UserName: env.antechV6.username,
          Password: env.antechV6.password,
          ClinicID: env.antechV6.clinicId,
        }),
        'log in to the mock directly',
      )
      const headers = { accessToken: login.Token }

      /* 2. The test guide reached with HEADER auth: 404, not 401 — the token's placement really is
       *    endpoint-specific, and only one way round. This is why the integration's getTestGuide is
       *    written differently from every other call it makes. */
      const headerAuthGuide = await fetch(`${base}/Tests/v6?pageSize=2500`, { headers })
      expect(headerAuthGuide.status).toBe(404)
      expect(await headerAuthGuide.json()).toEqual({ statusCode: 404, message: 'Resource not found' })

      /* ...and with query auth it works, so the 404 above is about the placement and not about the
       *    path. The lowercase `accesstoken` is load-bearing. */
      const queryAuthGuide = await fetch(
        `${base}/Tests/v6?accesstoken=${login.Token}&userId=${login.UserInfo.ID}&pageSize=2500&POC_FLAG=Y`,
      )
      expect(queryAuthGuide.status).toBe(200)
      const guide = (await queryAuthGuide.json()) as { TotalCount: number, LabResults: Array<{ Code: string, POC_Flag: string }> }
      expect(guide.LabResults.map((row) => row.Code).sort()).toEqual([...pocCodes].sort())
      expect(guide.LabResults.every((row) => row.POC_Flag === 'Y')).toBe(true)
      expect(guide.TotalCount).toBe(pocCodes.length)

      /* 3. A malformed serviceType: RFC 9110 validation problem+json, keyed by the offending field.
       *    The error mapper DOES read `title` and `errors`, so this one reaches an operator. */
      const badServiceType = await fetch(
        `${base}/LabResults/v6/GetStatus?serviceType=notAThing&ClinicID=${env.antechV6.clinicId}`,
        { headers },
      )
      expect(badServiceType.status).toBe(400)
      expect(await badServiceType.json()).toMatchObject({
        title: 'One or more validation errors occurred.',
        status: 400,
        errors: { ServiceType: ['The Service Type is invalid. Please update and try again.'] },
      })

      /* 4. An invalid POC_FLAG: 400 with a BARE JSON STRING body, not an object. */
      const badPocFlag = await fetch(
        `${base}/Tests/v6?accesstoken=${login.Token}&userId=${login.UserInfo.ID}&POC_FLAG=Z`,
      )
      expect(badPocFlag.status).toBe(400)
      expect(await badPocFlag.json()).toBe('POC_Flag:Z is not valid')

      /* 5. The integration's own unmapped-patient fallback pair, refused verbatim as the live
       *    endpoint refuses it. This is the envelope the tripwire at the bottom of this file is
       *    about, probed here in isolation so its shape is pinned independently of the dmi-api
       *    round trip. */
      const badPair = await fetch(`${base}/LabOrders/v6/PreOrderPlacement`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          ClinicID: env.antechV6.clinicId,
          ClinicAccessionID: `probe-${randomUUID().slice(0, 8)}`,
          ClientLastName: 'Doe',
          PetName: 'Rex',
          PetSex: 'U',
          PetAge: 1,
          PetAgeUnits: 'Y',
          SpeciesID: DEFAULT_PET_SPECIES,
          BreedID: DEFAULT_PET_BREED,
          OrderCodes: [KIDNEY_PANEL_CODE],
        }),
      })
      expect(badPair.status).toBe(400)
      expect(await badPair.json()).toEqual({
        value: {
          Data: null,
          StatusCode: 0,
          HttpStatusCode: 400,
          Message: `Invalid BreedId ${DEFAULT_PET_BREED}`,
          InnerExceptionMessage: '',
          Error: null,
          ClientData: null,
        },
        statusCode: 400,
        contentType: 'application/json',
      })

      /* 6. An unknown path: `{statusCode, message}` — a third distinct 4xx shape, and one more the
       *    error mapper cannot read. */
      const unknownPath = await fetch(`${base}/LabResults/v6/NoSuchThing`, { headers })
      expect(unknownPath.status).toBe(404)
      expect(await unknownPath.json()).toEqual({ statusCode: 404, message: 'Resource not found' })
    }, 60_000)
  })

  /* ---- tripwires ----
   *
   * Each asserts the CORRECT behaviour and is marked `failing` while the integration does not have
   * it. That keeps CI green while the defect stands, and turns the test red the moment someone
   * fixes it — at which point the `.failing` marker comes off in the same commit and the test stays
   * on as a plain regression guard. A tripwire that PASSES is a red run: jest reports "Failing test
   * passed even though it was supposed to fail", and the only correct response is to delete the
   * marker, not to relax the assertion.
   *
   * All three are tracked privately; nothing here names an issue. */
  describe('tripwires: behaviours the loop should have and does not', () => {
    it.failing('POST /admin/refs/sync/<provider> stores the reference data it fetched', async () => {
      /* EXPECTED: the admin ref sync fetches the provider's species/breeds/sexes (it does — the
       * reference-data test above reads exactly those lists over the same RPC) and upserts them as
       * provider_ref rows, which is the only way a canonical dmi ref becomes mappable to a provider
       * code. ACTUAL: HTTP 400, and nothing is stored.
       *
       * Mechanically, in dmi-api: the admin route loads the Provider with
       * `ProvidersService.findOneById`, which decorates the entity with two COMPUTED, non-column
       * properties (`integrationOptions`, `configurationOptions`) partitioned out of its `options`
       * relation. `RefsService.syncProviderRefs` then passes that whole decorated entity as a
       * relation condition — `providerRefRepository.findOne({ where: { code, type, provider } })` —
       * and TypeORM expands the object into a nested where over the Provider entity's own
       * properties, hits the first computed one, and refuses the query:
       * `Property "integrationOptions" was not found in "Provider"`.
       *
       * It is not specific to antech-v6: the same path runs for every provider and every ref type,
       * including `POST /admin/refs/sync/:providerId/:type`. It is why this scenario seeds the
       * provider_ref rows itself, from the catalogue the engine returned, rather than through the
       * route that exists to do it. This test carries no fallback of its own: it reports what the
       * setup observed. */
      expect({
        status: syncResponse.status,
        speciesRefsStoredBySync: speciesRefsAfterSync,
        neededTheDirectSeed: providerRefsWereSeededDirectly,
        body: syncResponse.text.slice(0, 200),
      }).toEqual({
        status: 201,
        speciesRefsStoredBySync: liveSpecies.length,
        neededTheDirectSeed: false,
        body: '',
      })
    })

    it.failing('the orders channel completes an order whose provider status has reached Final', async () => {
      /* EXPECTED: a polled order whose provider status is `Final` reaches dmi COMPLETED (or at the
       * very least leaves SUBMITTED). ACTUAL: it stays SUBMITTED.
       *
       * The provider sends `OrderStatus` as a STRING while the integration's status enum is a bare
       * numeric one, so its `mapOrderStatus` switch matches no wire value and every polled status
       * falls to the switch default, SUBMITTED. dmi-api then correctly refuses SUBMITTED -> SUBMITTED
       * as a non-change, and the order never moves.
       *
       * This is why every completion assertion in this file rests on the results channel, and why
       * the mock serves the strings: emitting the integers the enum declares would make this test
       * pass against behaviour the live endpoint does not produce. */
      const payload = payloadFor([KIDNEY_PANEL_CODE])
      const requisitionId = payload.requisitionId as string
      const created = expectOk<{ id: string }>(
        await org.api.post('/orders', payload, { autoSubmitOrder: true }),
        'place an order for the orders-channel tripwire',
      )

      /* Let the orders poll see and acknowledge it once at `Submitted` first, so the status change
       * below is unambiguously a SECOND observation rather than the first. */
      await pollUntil(
        async () => await mockOrder(requisitionId),
        (order) => order.orderAcked,
        ORDER_ACK_WAIT_MS,
        1_000,
      )

      /* Advance the provider status and offer the record again. NO result is ever seeded for this
       * order, so the results channel cannot reach it: whatever happens next is the orders
       * channel's doing, or nothing. */
      expectOk(
        await mock.post(`/__control__/orders/${encodeURIComponent(requisitionId)}/status`, {
          orderStatus: 'Final',
          replay: true,
        }),
        'advance the provider order status to Final and re-offer the record',
      )

      /* Proof the poll actually saw the new status: the mock re-acknowledges it, at `Final`. */
      const reAcked = await pollUntil(
        async () => await mockOrder(requisitionId),
        (order) => order.orderAckedStatus === 'Final',
        ORDER_ACK_WAIT_MS,
        1_000,
      )
      expect(reAcked.orderAckedStatus).toBe('Final')

      const order = await pollUntil(
        async () => await org.api.get(`/orders/${created.id}`),
        (response) => response.body?.status !== 'SUBMITTED',
        NEGATIVE_WAIT_MS,
        1_000,
      )
      expect(order.body.status).toBe('COMPLETED')
    }, ORDER_ACK_WAIT_MS * 2 + NEGATIVE_WAIT_MS + 30_000)

    it.failing('a provider error on the status poll is recorded in the audit trail', async () => {
      /* EXPECTED: when Antech answers a status poll with an error, the failure is stored as an
       * external request with that status, so an operator can see what the provider said. ACTUAL:
       * no record appears at all.
       *
       * The logging interceptor's rejection path calls its response handler with no filter and no
       * guard, and the handler dereferences `body.LabOrders` / `body.LabResults` — keys an error
       * body does not have. It throws a TypeError before emitting anything, so the provider's own
       * explanation is discarded and the audit record is never written. The success path is safe
       * because the endpoint always returns both keys.
       *
       * Scoped to GetStatus specifically: placement rejections elsewhere in this file DO produce
       * 4xx audit records (their accession-id extraction is guarded), so an unscoped "is there a
       * 4xx?" would pass for the wrong reason. */
      const before = expectOk<{ data: Array<{ url: string, status: number }> }>(
        await admin.get('/admin/external-requests', {
          providers: 'antech-v6',
          integrationId: org.integrationId,
          page: 1,
          limit: 200,
        }),
        'read the audit trail before injecting a status-poll failure',
      ).data.filter((record) => record.url.includes('/LabResults/v6/GetStatus') && record.status >= 400)
      expect(before).toHaveLength(0)

      expectOk(
        await mock.post('/__control__/scenarios', { key: 'getStatus', status: 400, once: true }),
        'arm a one-shot 400 on the next status poll',
      )

      const records = await pollUntil(
        async () =>
          expectOk<{ data: Array<{ url: string, status: number }> }>(
            await admin.get('/admin/external-requests', {
              providers: 'antech-v6',
              integrationId: org.integrationId,
              page: 1,
              limit: 200,
            }),
            'read the audit trail after injecting a status-poll failure',
          ).data.filter((record) => record.url.includes('/LabResults/v6/GetStatus') && record.status >= 400),
        (data) => data.length > 0,
        NEGATIVE_WAIT_MS,
        1_000,
      )
      expect(records.length).toBeGreaterThan(0)
    }, NEGATIVE_WAIT_MS + 60_000)

    it.failing('an order for a patient with no species OR breed mapping is still placeable', async () => {
      /* EXPECTED: a patient whose species and breed both fail dmi-api's ref mapping still produces
       * an order — that is precisely the case the integration's fallback constants exist to serve.
       * ACTUAL: the provider refuses it.
       *
       * The two fallbacks are chosen independently: an unmapped species becomes SpeciesID 49 and an
       * unmapped breed becomes BreedID 370. But 370 is a breed of species 41, and species 49 has
       * exactly one breed, 648 — so the pair is invalid at Antech and the placement is rejected
       * before the order exists. A patient whose species resolves but whose breed does not gets
       * 41 + 370, which IS valid, so this is not every order: it is every order for a fully
       * unmapped patient.
       *
       * The mock refuses it from the same species tree the provider publishes, which is why this
       * reproduces rather than merely asserts. The test below pins that the refusal at least
       * reaches the operator legibly. */
      const payload = payloadFor([KIDNEY_PANEL_CODE], {
        patient: patientFor({ species: unmappedSpeciesRefCode, breed: UNMAPPED_BREED }),
      })

      const response = await org.api.post('/orders', payload, { autoSubmitOrder: true })
      console.log(
        `[antech-v6-scenario] unmapped-patient response -> HTTP ${response.status}: ${response.text.slice(0, 300)}`,
      )
      expect(response.ok).toBe(true)
    }, 60_000)

    it('the unmapped-patient refusal reaches the operator with the provider\'s own wording', async () => {
      /* The positive half of the tripwire above, and the reason it is only half-bad: whatever else
       * happens, the operator is told WHY. This is the `.value.Message` branch of the integration's
       * error mapper — the one provider envelope whose wording survives — so an operator sees
       * `Invalid BreedId 370` rather than a bare `Failed to POST`. It is also the assertion that
       * would go red first if the ref mapping for species or breed silently stopped resolving for a
       * patient that IS mapped. */
      const payload = payloadFor([KIDNEY_PANEL_CODE], {
        patient: patientFor({ species: unmappedSpeciesRefCode, breed: UNMAPPED_BREED }),
      })

      const response = await org.api.post('/orders', payload, { autoSubmitOrder: true })

      expect(response.ok).toBe(false)
      expect(response.text).toContain(`Invalid BreedId ${DEFAULT_PET_BREED}`)
      /* Named rather than implied, and worth pinning because the placement path is decided BEFORE
       * the patient is: this order's code is point-of-care and auto-submit was asked for, so the
       * integration went to the real ORDER endpoint and was refused there. The unknown-test-code
       * refusal above names `/LabOrders/v6/PreOrderPlacement` instead — same envelope, different
       * endpoint — because an unknown code is not in the POC set and so routes to the draft path.
       * The pair is what shows the refusal is the provider's, at whichever endpoint it happened. */
      expect(response.text).toContain('/LabOrders/v6/Order')
    }, 60_000)
  })
})
