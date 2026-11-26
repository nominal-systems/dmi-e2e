import { createHash } from 'crypto'
import { ApiClient, ApiResponse, expectOk } from '../src/api-client'
import { appPortInUse, DmiApiScriptRun, runDmiApiScript, runningDmiApi } from '../src/dmi-api'
import { appEnv, env } from '../src/env'
import { clearFailPoints, closeMongo, failInserts } from '../src/mongo'
import { pollUntil } from '../src/poll'
import { lookupRefCode } from '../src/refs'
import { adminLogin, orderPayload, OrderPayloadOverrides, seedOrganization, SeededOrg } from '../src/seed'
import {
  assertStackWhole,
  BROKER,
  Disruption,
  DMI_API,
  REDIS,
  redisAnswers,
  repeatableJobsNaming,
  restoreServices,
  serviceFaults,
  sleep,
} from '../src/services'
import { closePool, countOrdersForOrganization } from '../src/sql'

/* Full-system gate for IDEXX (HARNESS_FULL_STACK=1, HARNESS_STACK=idexx — the default):
 * dmi-api under a NORMAL NODE_ENV, wired over real MQTT/Bull/HTTP to the REAL
 * `dmi-engine-idexx-integration` container and a VetConnect Plus mock provider (src/idexx-mock). It
 * drives the whole loop as an integrator would — configure the idexx provider pointed at the mock,
 * create an integration, start it, place an order over HTTP, let the mock produce a result, and
 * watch the order->result->report loop close — with every hop real except the provider, which is the
 * mock so the run is deterministic and never touches live IDEXX.
 *
 * The order flows: POST /orders -> dmi-api RPCs `idexx/orders/create` to the integration -> the
 * integration POSTs the order to the mock's /api/v1/order and (autoSubmitOrder) runs the confirmOrder
 * browser handshake against the mock -> dmi-api stores the order with the mock's idexxOrderId as its
 * externalId. Then the integration's Bull results poll hits the mock's /api/v3/results/latest; once a
 * test seeds a result there, the integration maps it and emits `external_results` (-> report) and
 * `external_order_results` (-> order COMPLETED) back to dmi-api, then acks the batch. */

/* The three patient fields dmi-api ref-maps on the way to the provider, as (canonical dmi ref name ->
 * the IDEXX code it must arrive as). idexx maps all three: species and sex to IDEXX's upper-case
 * mnemonics, breed to a breed mnemonic.
 *
 * dmi's canonical codes are opaque UUIDs, so each is looked up BY NAME over `GET /refs/*`
 * (src/refs.ts) and sent as the order's species/sex/breed; what must arrive at the mock is IDEXX's
 * vocabulary, pinned as literals here. Input and expected output are deliberately different values:
 * if the idexx provider_ref rows stopped resolving, mapPatientRefs falls back to forwarding the raw
 * code, the mock — which echoes species/breed/sex and does not validate them — stores the raw code,
 * and the value assertion below goes red naming it, instead of a well-formed order the real provider
 * would reject.
 *
 * Which rows exist is a property of dmi-api's migrations, not of anything synced from the provider —
 * the harness never runs the ref sync. They seed idexx species (CANINE, FELINE, ...), sex codes
 * (Male Sterilized -> MALE_NEUTERED, Female Sterilized -> FEMALE_SPAYED, ...) and ~1,100 dog-breed
 * mappings keyed by the canonical breed's UUID: Labrador Retriever -> LABRADOR_RETRIEVER. */
const SPECIES_REF_NAME = 'Canis familiaris'
const EXPECTED_IDEXX_SPECIES = 'CANINE'
const SEX_REF_NAME = 'Male Sterilized'
const EXPECTED_IDEXX_SEX = 'MALE_NEUTERED'
const BREED_REF_NAME = 'Labrador Retriever'
const EXPECTED_IDEXX_BREED = 'LABRADOR_RETRIEVER'

describe('idexx full-stack (VetConnect Plus mock)', () => {
  let org: SeededOrg
  let admin: ApiClient
  let orderId: string
  let externalId: string
  let requisitionId: string
  let reportId: string
  /* Read from the mock's own /api/v1/ref/tests rather than hard-coded, so the codes the harness
   * orders are by construction ones the provider advertises — and the mock rejects anything else. One
   * in-house code (the loop's order) and one reference-lab code (the device rule's Exclude branch),
   * each picked by its `inHouse` flag rather than by position: the flag is what the integration
   * classifies the order by, so the scenario must not assume which entry is which. */
  let serviceCode: string
  let referenceLabCode: string
  /* The IVLS analyzer serial the mock's clinic owns, read from its device list. */
  let deviceSerial: string
  /* Canonical dmi ref codes for the order's species/sex/breed, resolved by name at setup — see the
   * ref-mapping constants above. */
  let speciesRefCode: string
  let sexRefCode: string
  let breedRefCode: string
  /* Client for the mock's host-facing control plane (/__control__/*, /status). */
  const mock = ApiClient.create(env.idexx.mockBaseUrl)

  /* An order payload whose patient carries the canonical dmi ref codes. The default patient is kept
   * and only its species/sex/breed replaced — NOT a `patient:` override, which would replace the
   * whole default and silently drop its `pims:patient:id` (see orderPayload). The order would still
   * reconcile, but IDEXX would then be sent dmi-api's internal patient id instead of one the
   * scenario chose, so the patient id the integration forwards would no longer be a known value.
   * The dmi-api#334 guard at the bottom of this file places an order without the identifier on
   * purpose. */
  function refMappedOrderPayload (overrides: OrderPayloadOverrides): Record<string, unknown> {
    const payload = orderPayload(org.integrationId, overrides)
    payload.patient = {
      ...(payload.patient as Record<string, unknown>),
      sex: sexRefCode,
      species: speciesRefCode,
      breed: breedRefCode,
    }
    return payload
  }

  beforeAll(async () => {
    /* A fresh container starts clean; reset is only load-bearing for warm reruns (HARNESS_KEEP_UP),
     * where it clears the previous run's seeded orders/results. Harmless on a cold start. */
    await mock.post('/__control__/reset').catch(() => undefined)

    const catalogue = expectOk<{ list: Array<{ code: string, inHouse: boolean }> }>(
      await mock.get('/api/v1/ref/tests'),
      'read the mock orderable-test catalogue',
    )
    const codeWhere = (inHouse: boolean): string => {
      const entry = catalogue.list.find((service) => service.inHouse === inHouse)
      if (entry == null) {
        throw new Error(`the mock catalogue advertises no ${inHouse ? 'in-house' : 'reference-lab'} test code; both halves of the device rule need one`)
      }
      return entry.code
    }
    serviceCode = codeWhere(true)
    referenceLabCode = codeWhere(false)

    /* The loop's ordered test is in-house (the catalogue says so), and since dmi-engine-idexx-integration
     * issue #76 the integration reads that catalogue and REFUSES an in-house order that carries no IVLS
     * device — as live IDEXX would. The order therefore names the analyzer, and the serial comes from
     * the mock's own device list rather than a literal, so the scenario cannot drift from the mock. */
    const devices = expectOk<{ ivlsDeviceList: Array<{ deviceSerialNumber: string }> }>(
      await mock.get('/api/v1/ivls/devices'),
      'read the mock IVLS device list',
    )
    deviceSerial = devices.ivlsDeviceList[0].deviceSerialNumber

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

    /* Resolve the canonical ref codes the order will carry, over HTTP with the org's own API key —
     * the same route an integrator would use to discover them (src/refs.ts). */
    speciesRefCode = await lookupRefCode(org.api, 'species', SPECIES_REF_NAME)
    sexRefCode = await lookupRefCode(org.api, 'sexes', SEX_REF_NAME)
    breedRefCode = await lookupRefCode(org.api, 'breeds', BREED_REF_NAME)

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
      expect(response.body.service).toBe('idexx-mock')
    })

    it('the quickstart bootstrap completed (org, idexx provider config, integration)', () => {
      expect(org.organizationId).toBeTruthy()
      expect(org.providerConfigurationId).toBeTruthy()
      expect(org.integrationId).toBeTruthy()
    })

    /* Guards the mapping assertions below against passing for the wrong reason: the codes the order
     * is placed with must resolve, and must not already BE the IDEXX codes — otherwise "the IDEXX
     * code arrived" would hold with the mapping switched off. */
    it('the dmi refs the order will be placed with resolve, and are not already the IDEXX codes', () => {
      expect(speciesRefCode).toBeTruthy()
      expect(sexRefCode).toBeTruthy()
      expect(breedRefCode).toBeTruthy()
      expect(speciesRefCode).not.toBe(EXPECTED_IDEXX_SPECIES)
      expect(sexRefCode).not.toBe(EXPECTED_IDEXX_SEX)
      expect(breedRefCode).not.toBe(EXPECTED_IDEXX_BREED)
    })
  })

  describe('an order round-trips through the real integration and the mock, and the loop closes', () => {
    it('POST /orders creates the order via the real idexx integration (externalId assigned)', async () => {
      /* `devices` is dmi-api's list of device serial numbers; the integration maps each to an IDEXX
       * `ivls` entry, and its device rule (see beforeAll) requires one for an in-house code.
       *
       * species/sex/breed are canonical dmi ref codes, NOT IDEXX codes: dmi-api maps all three to
       * the IDEXX vocabulary on the way to the engine, and a test below asserts the mapped values
       * arrived. */
      const payload = refMappedOrderPayload({
        testCodes: [{ code: serviceCode }],
        devices: [deviceSerial],
      })
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
      const received = expectOk<{
        status: string
        corporateRequisitionId: string
        tests: string[]
        ivls: string[]
      }>(
        await mock.get(`/__control__/orders/${requisitionId}`),
        'read order from mock control plane',
      )

      expect(received.corporateRequisitionId).toBe(requisitionId)
      expect(received.status).toBe('SUBMITTED')
      /* The ordered test survived the mapping into IDEXX's dialect. The mock rejects an order whose
       * codes are outside its catalogue, so this also pins that the integration forwards them. */
      expect(received.tests).toEqual([serviceCode])
      /* The device dmi-api was given is the device the provider received: the integration's include
       * branch kept it and mapped the serial into IDEXX's `ivls` shape. A dropped or renamed device is
       * already a 400 at placement (the mock refuses a device-less in-house order); this pins the
       * value that got through. */
      expect(received.ivls).toEqual([deviceSerial])
    })

    it('the mock received the order with the REF-MAPPED species, breed and sex, not the raw dmi codes', async () => {
      const received = expectOk<{ speciesCode: string, breedCode: string, genderCode: string }>(
        await mock.get(`/__control__/orders/${requisitionId}`),
        'read order from mock control plane',
      )

      /* THE POINT OF THIS TEST. species, breed and sex are the only order fields dmi-api transforms
       * on the way to the provider, and they must arrive in IDEXX's vocabulary. Asserting the exact
       * mapped values is what makes a silently broken ref mapping fail here, naming the raw code
       * that got through, instead of producing a well-formed order the real provider would reject.
       * The mock echoes these and never validates them, so this assertion is the only thing between
       * a mapping regression and a green run. */
      expect(received.speciesCode).toBe(EXPECTED_IDEXX_SPECIES)
      expect(received.breedCode).toBe(EXPECTED_IDEXX_BREED)
      expect(received.genderCode).toBe(EXPECTED_IDEXX_SEX)
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

      /* Exactly FINAL: the single seeded result is COMPLETE, so this is deterministic, and
       * accepting PARTIAL as well would hide a downgrade. */
      expect(report.status).toBe('FINAL')
      expect(Array.isArray(report.testResultsSet)).toBe(true)
      expect(report.testResultsSet.length).toBeGreaterThan(0)

      /* Flatten the panel to its observations and assert the seeded analytes survived the whole
       * mapping chain (mock -> integration IdexxResultMapper -> dmi-api Observation). */
      const observations = report.testResultsSet.flatMap((testResult) => testResult.observations ?? [])
      expect(observations.length).toBeGreaterThan(0)

      /* The WHOLE seeded analyte set, so a dropped observation fails rather than being ignored. */
      expect(observations.map((observation) => observation.code).sort()).toEqual(['CREA', 'GLU'])

      /* Glucose was seeded NUMERIC, out-of-range-high, with a reference range. */
      const glucose = observations.find((observation) => observation.code === 'GLU')
      expect(glucose).toBeDefined()
      expect(glucose?.valueQuantity?.value).toBe(150)
      expect(glucose?.valueQuantity?.units).toBe('mg/dL')
      /* Bounds, not merely presence: the mapper emits a range entry for any low/high pair, so the
       * numbers can drift silently while `length > 0` stays true. */
      expect(glucose?.referenceRange).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'NORMAL', low: 74, high: 143 }),
        ]),
      )
      /* The interpretation CODE, not merely its presence: `toBeDefined()` was as true of LOW as of
       * HIGH. dmi-api persists the wire value, so this is 'H' (not 'HIGH'). */
      expect(glucose?.interpretation).toMatchObject({ code: 'H' })

      /* Creatinine was seeded in range: it must carry its value and NO interpretation. */
      const creatinine = observations.find((observation) => observation.code === 'CREA')
      expect(creatinine?.valueQuantity?.value).toBe(1.2)
      expect(creatinine?.valueQuantity?.units).toBe('mg/dL')
      /* dmi-api deletes the interpretation when the item is in range; it serialises as null. */
      expect(creatinine?.interpretation ?? null).toBeNull()
    })

    it('Mongo events show the order and report lifecycle', async () => {
      const events = expectOk<{ data: Array<{ type: string, data?: { orderId?: string, reportId?: string } }> }>(
        await org.api.get('/events', { start_seq: 0, limit: 1000 }),
        'list events',
      )

      /* Scope to this order/report: a cold run has just this one, but filter explicitly rather than
       * assume the stream is ours alone (/events was once unscoped across tenants, dmi-api#339). */
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

  describe('the device rule, Exclude branch: a reference-lab-only order reaches the provider without a device', () => {
    /* The loop above executes the rule's Include half (an in-house order must carry a device), and
     * there the mock enforces the provider's side too. This is the OTHER half: the integration reads the
     * catalogue, classifies an all-reference-lab order as Exclude, and STRIPS whatever devices the
     * PIMS sent before placement. Nothing enforces that half at the mock — whether live IDEXX would
     * even object to a device on a reference-lab order has never been probed, so a mock refusal would
     * be invention — which makes this assertion the only detector of the branch being skipped: by a
     * regression, or by someone flipping the integration's IDEXX_DEVICE_RULE_ENABLED kill switch off.
     *
     * So the order DELIBERATELY sends the device (input ≠ expected output, the same falsifiability
     * pattern as the ref-mapping test) and pins that none arrived. Placement-scoped: no result is
     * seeded — the mock stamps every result with an IVLS run summary, which a reference-lab result
     * would not carry — and it is a separate order (its own requisitionId), so it does not perturb
     * the loop asserted above. */
    let referenceLabRequisitionId: string

    it('POST /orders with a reference-lab code AND a device is accepted', async () => {
      const payload = refMappedOrderPayload({
        testCodes: [{ code: referenceLabCode }],
        devices: [deviceSerial],
      })
      referenceLabRequisitionId = payload.requisitionId as string

      const created = expectOk<{ id: string, externalId: string }>(
        await org.api.post('/orders', payload, { autoSubmitOrder: true }),
        'place idexx reference-lab order',
      )

      expect(created.id).toBeTruthy()
      expect(created.externalId).toBeTruthy()
    }, 30_000)

    it('the mock received the reference-lab test and NO device: the integration stripped the one it was given', async () => {
      const received = expectOk<{ status: string, tests: string[], ivls: string[] }>(
        await mock.get(`/__control__/orders/${referenceLabRequisitionId}`),
        'read reference-lab order from mock control plane',
      )

      expect(received.status).toBe('SUBMITTED')
      expect(received.tests).toEqual([referenceLabCode])
      /* THE POINT OF THIS TEST: the device dmi-api was given must NOT reach the provider. `[]`, not
       * "falsy": a mock that fabricated a device here, or an integration that forwarded the one it
       * should have dropped, both fail naming the serial. */
      expect(received.ivls).toEqual([])
    })
  })

  describe("a refused order surfaces the provider's error, not a generic fallback", () => {
    /* The happy path never touches the integration's error path. The mock answers a refused order
     * the way the live endpoint does — an INVALID_ORDER entry, then the field-level entries under
     * IDEXX's own codes — and the integration's providerErrorMapper reads that envelope's
     * `errorCode`/`message`/`index` and renders each entry into dmi-api's `errors[]`. These two tests
     * are what make the envelope's codes and shape non-decorative: renaming a code goes red here and
     * nowhere else. */

    it('an order for a code outside the catalogue is refused end to end, naming the code', async () => {
      /* An unknown code takes the device rule's Passthrough branch (the integration forwards whatever
       * devices the PIMS sent), reaches the mock, and is refused there as INVALID_LAB_SERVICE_ID with
       * the code in the message — the one refusal dmi-api cannot intercept first, since it does not
       * know the provider's catalogue. A separate order (its own requisitionId) that lands ERROR in
       * dmi-api, so it does not perturb the loop asserted above. */
      const payload = refMappedOrderPayload({
        testCodes: [{ code: 'NOT-A-REAL-IDEXX-CODE' }],
        devices: [deviceSerial],
      })

      const response = await org.api.post('/orders', payload, { autoSubmitOrder: true })
      console.log(
        `[idexx-scenario] refused-order response -> HTTP ${response.status}: ${response.text.slice(0, 300)}`,
      )

      expect(response.ok).toBe(false)
      /* The provider's code and the mock's message both reach dmi-api's errors[], which proves the
       * mapper read the envelope. Its fallback must NOT fire: "… failed with <status> status code"
       * appears when the envelope is unreadable. */
      expect(response.text).toMatch(/INVALID_LAB_SERVICE_ID/)
      expect(response.text).toMatch(/NOT-A-REAL-IDEXX-CODE/)
      expect(response.text).not.toMatch(/failed with \d+ status code/)
      /* And each entry is worded from its code's family: an INVALID_* code is a value the provider
       * refused, not a missing one. The field-level entry carries `index` (the offending test's
       * position), which the mapper used to read as "required" — telling the operator that a test code
       * they supplied was missing (dmi-engine-idexx-integration#85); it is reported as a position. The
       * whole array, so an entry the mapper drops goes red too, not only a mislabelled one. */
      expect(response.body.errors).toEqual([
        'INVALID_ORDER is invalid for idexx: Invalid order, see data for field level details',
        'INVALID_LAB_SERVICE_ID is invalid for idexx (index 0): unknown test code(s): NOT-A-REAL-IDEXX-CODE',
      ])
    }, 30_000)

    it("the mock refuses an empty order with IDEXX's per-field codes, under its INVALID_ORDER entry", async () => {
      /* Driven at the mock's provider-facing API directly, the way the tests above read its catalogue
       * and device list: dmi-api validates every required field itself before an order reaches the
       * engine, so no path through the stack can make the integration send an empty order — these
       * refusals exist for an integration that drops a field it was given. This pins the vocabulary
       * and shape they would surface with, so a drift from the provider's codes is visible somewhere. */
      const response = await mock.post('/api/v1/order', {})

      expect(response.status).toBe(400)
      const errors = response.body.errors as Array<{ errorCode: string, index?: number }>
      expect(errors.map((error) => error.errorCode)).toEqual([
        'INVALID_ORDER',
        'MISSING_PATIENT',
        'MISSING_VETERINARIAN',
        'MISSING_TESTS',
      ])
    })
  })

  describe('a device lookup reports what failed, not a 404 (dmi-api#364)', () => {
    /* `GET /providers/idexx/devices` is how a PIMS lists the clinic's IVLS analyzers: dmi-api RPCs
     * `idexx/devices/list`, and the integration GETs the provider's /api/v1/ivls/devices and maps
     * each entry. The first test proves that path is live, so the failure after it is the provider's
     * and not a route that never worked. */
    it("GET /providers/idexx/devices lists the clinic's analyzer through the real integration", async () => {
      const response = await org.api.get(`/providers/idexx/devices?integrationId=${org.integrationId}`)

      expect(response.status).toBe(200)
      /* In dmi's device shape, not IDEXX's (`deviceSerialNumber`, `displayName`, `vcpActivatedStatus`):
       * the integration's device mapper ran. Its status enum spells ACTIVE as IDEXX does. */
      expect(response.body).toEqual([
        { serialNumber: deviceSerial, status: 'ACTIVE', name: 'VetLab Station (mock)' },
      ])
    }, 30_000)

    /* Regression guard (dmi-api#364): dmi-api wrapped every failure of the devices round trip in a
     * 404, so a provider failing looked like a clinic with no analyzers, and alerting that counts 5xx
     * saw nothing. The mock fails one lookup with IDEXX's 500 envelope; the integration replies with
     * its ProviderError; dmi-api must answer 502 and say who failed, with what status and why. */
    it("a provider failure is a 502 naming IDEXX, its status and its error", async () => {
      expectOk(
        await mock.post('/__control__/scenarios', {
          key: 'ivlsDevices',
          status: 500,
          body: { errors: [{ errorCode: 'UNKNOWN_ERROR', message: 'device registry unavailable' }] },
          once: true,
        }),
        'inject a failed device lookup at the mock',
      )

      const response = await org.api.get(`/providers/idexx/devices?integrationId=${org.integrationId}`)
      console.log(
        `[idexx-scenario] failed device lookup -> HTTP ${response.status}: ${response.text.slice(0, 300)}`,
      )

      expect(response.status).toBe(502)
      expect(response.body.message).toBe(
        'The provider idexx failed to list devices with status 500: UNKNOWN_ERROR error in idexx: device registry unavailable',
      )
    }, 30_000)

    /* The engine failing rather than the provider: a 200 without `ivlsDeviceList` breaks the
     * integration's mapper, the handler throws a plain TypeError, and Nest replies with its generic
     * `{ status: 'error', message: 'Internal server error' }` — the shape an engine crash has on the
     * wire (the zoetis device mapper fails this way on a single-test device). It must be a 502 too. */
    it('an engine that fails on the provider\'s answer is a 502 naming the engine', async () => {
      expectOk(
        await mock.post('/__control__/scenarios', { key: 'ivlsDevices', status: 200, body: {}, once: true }),
        'inject a device list the integration cannot map',
      )

      const response = await org.api.get(`/providers/idexx/devices?integrationId=${org.integrationId}`)

      expect(response.status).toBe(502)
      expect(response.body.message).toBe('The engine failed to list devices: Internal server error')
    }, 30_000)
  })

  /* ---- dmi-api#334 guards ----
   *
   * These tests guard the dmi-api#334 fix (dmi-api#384): an order whose `pims:patient:id` is on one
   * side only — here the result's — is completed by its own result. The guard's precondition runs as
   * a plain test in front of it, chained through the describe's own `let`s as the loop's tests are. */
  describe('reconciliation with a pims:patient:id on the result side only (dmi-api#334)', () => {
    let noIdentifierOrderId: string
    let ordersBefore: number

    it('the result for an order placed without a pims:patient:id echoes a patient id the stored order does not carry', async () => {
      /* The setup half of the guard below, kept as a test of its own so that a red names which half
       * broke. A red here means the asymmetry the guard depends on has gone — and without it the
       * guard would pass without exercising the fix, since an order and a result with no patient id
       * on either side reconcile anyway. A red below means the fix itself has regressed.
       *
       * The asymmetry, asserted from both ends: the order dmi-api stores carries no `pims:patient:id`,
       * while the result the provider returns for it carries a patient id — dmi-api's own internal
       * patient id, which the integration sent IDEXX in place of the missing identifier, and which the
       * integration's result mapper reports back as the result's `pims:patient:id`. */
      const payload = orderPayload(org.integrationId, {
        /* A `patient:` override replaces the default patient WHOLE, identifier included — the very
         * thing refMappedOrderPayload exists to avoid, and here the point of the test. */
        patient: { name: 'Bramble', sex: sexRefCode, species: speciesRefCode, breed: breedRefCode },
        testCodes: [{ code: serviceCode }],
        devices: [deviceSerial],
      })
      const noIdentifierRequisitionId = payload.requisitionId as string

      const created = expectOk<{ id: string }>(
        await org.api.post('/orders', payload, { autoSubmitOrder: true }),
        'place an idexx order whose patient carries no identifier',
      )
      noIdentifierOrderId = created.id

      const stored = expectOk<{ patient: { id: string, identifier: Array<{ system: string, value: string }> } }>(
        await org.api.get(`/orders/${noIdentifierOrderId}`),
        'read the stored order',
      )
      ordersBefore = await countOrdersForOrganization(org.organizationId)

      const seeded = expectOk<{ result: { patient: { patientId: string } } }>(
        await mock.post(`/__control__/orders/${noIdentifierRequisitionId}/results`, {}),
        'seed a result at the mock for the order without an identifier',
      )

      /* The order's side: no `pims:patient:id`. */
      expect(stored.patient.identifier.filter((identifier) => identifier.system === 'pims:patient:id')).toEqual([])
      /* The result's side: a patient id, and specifically dmi-api's internal one (a UUID). */
      expect(stored.patient.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      expect(seeded.result.patient.patientId).toBe(stored.patient.id)
    }, 60_000)

    it('an order placed without a pims:patient:id is completed by its own result, with no duplicate order', async () => {
      /* An order whose patient carries no `identifier` at all — which dmi-api's contract allows,
       * `patient.identifier` being optional — is completed by its result like any other: the order
       * reaches COMPLETED, its own report is filled, and the organization holds no more orders after
       * the result than before it.
       *
       * The shape is the point: the identifier is on the RESULT's side only. The integration always
       * sends IDEXX a patient id — the order's `pims:patient:id` when it has one, otherwise dmi-api's
       * own internal patient id — and the result mapper reports the echoed id as the result's
       * `pims:patient:id`, while the stored order carries none. Until dmi-api#384, dmi-api's matching
       * guard (ProviderResultUtils.isMatchingOrder) refused a `pims:patient:id` present on one side
       * only: the order stayed SUBMITTED and its result was filed under a new orphan order
       * (nominal-systems/dmi-api#334). This test guards that fix; the antech-v3 scenario guards the
       * mirror shape, with the identifier on the order's side only.
       *
       * The positive twin is the loop's own completion test above: an order of the same shape placed
       * WITH the identifier, completed by the same kind of seeded result — so a red here alone points
       * at the one-sided identifier, not at the results channel. The order is the one the test above
       * placed and seeded a result for; nothing after this test reads what it leaves behind. */
      const response = await pollUntil(
        async () => await org.api.get(`/orders/${noIdentifierOrderId}`),
        (r) => r.body?.status === 'COMPLETED',
        90_000,
        2_000,
      )
      expect(response.body.status).toBe('COMPLETED')

      /* The result reaches dmi-api as two messages: the one that completes the order, and — sent
       * after it — the one that files the report, which is where a duplicate order would be created.
       * Count only once that second one has run (this order's report is FINAL, or a new order has
       * appeared), so that the first handler alone matching the order cannot pass here on timing. */
      const settled = await pollUntil(
        async () => ({
          orders: await countOrdersForOrganization(org.organizationId),
          reportStatus: (await org.api.get(`/orders/${noIdentifierOrderId}/report`)).body?.status,
        }),
        (state) => state.orders !== ordersBefore || state.reportStatus === 'FINAL',
        30_000,
        1_000,
      )
      expect(settled.reportStatus).toBe('FINAL')
      expect({ newOrdersForTheResult: settled.orders - ordersBefore }).toEqual({ newOrdersForTheResult: 0 })
    }, 90_000 + 30_000 + 20_000)
  })

  /* ---- dmi-api#371 guard ----
   *
   * The fast suite's event-store throttling scenario proves dmi-api retries a throttled event write
   * and no longer fails the request when the event store keeps refusing it. It runs dmi-api under
   * NODE_ENV=seed, though, where `createOrder` returns before the engine call, so it cannot prove the
   * outcome that matters to the clinic: the order is still sent to the provider. This proves it,
   * here after the loop so that its main flow above is untouched. */
  describe('an order survives its event store throttling every event write (dmi-api#371)', () => {
    /* dmi-api's event collection, as its Event schema names it. */
    const EVENTS = 'events_v2'

    /* What dmi-api records for an order placed with autoSubmitOrder once the integration's
     * confirmOrder handshake has run: the integration answers a confirmed order as SUBMITTED, and
     * dmi-api stores the status it answers with. (The mock-side test above pins the same status at
     * the provider.) */
    const SUBMITTED = 'SUBMITTED'

    afterAll(async () => {
      /* A test that fails midway must not leave inserts failing: disarm before closing. */
      try {
        await clearFailPoints()
      } finally {
        await closeMongo()
      }
    })

    it('an order placed while every events_v2 insert is throttled is still sent to the provider', async () => {
      /* Every insert into `events_v2` fails with 16500, the code the production event store (Azure
       * Cosmos DB's Mongo API) throttles a write with, for as long as the failpoint is armed: 1000 is
       * far more than the request can use (src/mongo.ts). `createOrder` writes three events on the
       * way — order:created before the engine call, order:updated and report:created after it — and
       * dmi-api tries each three times, waiting its 1 s no-hint fallback between tries, before it logs
       * the event as lost and carries on: two 1 s waits per event, which is why the test's timeout is
       * the loop's placement budget plus 3 × 2 s. Before the fix the first refusal escaped as a 500,
       * and the order was never sent. */
      await failInserts(EVENTS, 1000)

      /* The same order as the loop's own: an in-house code with the clinic's analyzer, ref-mapped
       * patient fields, autoSubmitOrder so the integration runs confirmOrder. */
      const payload = refMappedOrderPayload({
        testCodes: [{ code: serviceCode }],
        devices: [deviceSerial],
      })
      const throttledRequisitionId = payload.requisitionId as string
      const response = await org.api.post('/orders', payload, { autoSubmitOrder: true })
      /* Disarmed at once, before any assertion, so that a red below cannot leave the event store
       * refusing writes; the count is what the failpoint refused while it was armed. */
      const refused = await clearFailPoints()

      /* HTTP status, error message and order status compared together, so a refusal goes red naming
       * dmi-api's status and the error behind it, not a bare "expected 201". */
      expect({
        httpStatus: response.status,
        message: response.ok ? undefined : response.body?.message,
        status: response.body?.status,
      }).toEqual({ httpStatus: 201, message: undefined, status: SUBMITTED })
      const created = response.body as { id: string, externalId: string }
      expect(created.externalId).toBeTruthy()

      /* dmi-api recorded the provider's answer: the order reads back SUBMITTED, with the externalId
       * results are later correlated on. */
      const stored = expectOk<{ id: string, status: string, externalId: string }>(
        await org.api.get(`/orders/${created.id}`),
        'read the throttled order back',
      )
      expect({ id: stored.id, status: stored.status, externalId: stored.externalId })
        .toEqual({ id: created.id, status: SUBMITTED, externalId: created.externalId })

      /* THE POINT OF THIS TEST: the provider has the order, confirmed, as the loop's own order
       * reached it — and it is the order dmi-api holds, since the mock's idexxOrderId is the
       * externalId dmi-api stored. */
      const received = expectOk<{
        idexxOrderId: string
        corporateRequisitionId: string
        status: string
        tests: string[]
        ivls: string[]
      }>(
        await mock.get(`/__control__/orders/${throttledRequisitionId}`),
        'read the throttled order from the mock control plane',
      )
      expect({
        idexxOrderId: received.idexxOrderId,
        corporateRequisitionId: received.corporateRequisitionId,
        status: received.status,
        tests: received.tests,
        ivls: received.ivls,
      }).toEqual({
        idexxOrderId: created.externalId,
        corporateRequisitionId: throttledRequisitionId,
        status: 'SUBMITTED',
        tests: [serviceCode],
        ivls: [deviceSerial],
      })

      /* The event really was refused, not written: the org's feed, which the lifecycle test above
       * shows carrying the loop's own order:created, has none for this order. */
      const events = expectOk<{ data: Array<{ type: string, data?: { orderId?: string } }> }>(
        await org.api.get('/events', { start_seq: 0, limit: 1000 }),
        'list events',
      )
      expect(
        events.data
          .filter((event) => event.type === 'order:created' && event.data?.orderId === created.id)
          .map((event) => ({ type: event.type, orderId: event.data?.orderId })),
      ).toEqual([])

      /* 9 is createOrder's three event writes (order:created, order:updated, report:created) × three
       * attempts each. At least, not exactly: the integration's own polls keep running while the
       * failpoint is armed, and an event dmi-api writes for one of them in that window is refused and
       * counted too, so an exact count would depend on timing. */
      expect(refused).toBeGreaterThanOrEqual(9)
    }, 30_000 + 3 * 2_000)
  })

  /* ---- transport faults and the steps of a placement: dmi-engine-idexx-integration#81, #83, #93 ----
   *
   * Past the test catalogue (cached), a placement is up to six IDEXX calls in a row: the create
   * POST, the manifest PDF its answer points at, and with autoSubmitOrder the three steps of the
   * confirm handshake (the UI page, the order setup, the submission) and the manifest once
   * more. The tests here fail one of those calls at a time, by its route key at the mock, with a transport fault (src/mock-faults; the
   * README's "Transport faults in the mocks"): an answer held, a connection reset, a body stalled.
   * Each test arms one fault and disarms it in a `finally` (withFault), and asserts from the count the
   * disarm returns that the fault fired. The describe checks that nothing is armed when it starts,
   * and after each test that the test left nothing armed. Each test places an order of its own, so
   * the loop above sees none of it; the one test that seeds a result waits for its batch to be
   * confirmed, so the overlapping-polls test below starts on an empty feed. */
  describe('IDEXX calls that time out, reset or stall, and the steps of a placement (dmi-engine-idexx-integration#81, #83, #93)', () => {
    /* How long dmi-api waits for the engine's answer here, and the integration's timeouts for the
     * create POST and for every other call. The two integration values are read as
     * docker-compose.yml reads them, from the environment with compose's default
     * (HARNESS_IDEXX_CREATE_ORDER_TIMEOUT_MS, 5000; HARNESS_IDEXX_HTTP_TIMEOUT_MS, 30000), like the
     * overlapping-polls test's below; dmi-api's from the environment the harness starts it with. */
    const engineTimeoutMs = Number(appEnv().ENGINE_RESPONSE_TIMEOUT)
    const createOrderTimeoutMs = Number(process.env.HARNESS_IDEXX_CREATE_ORDER_TIMEOUT_MS || 5_000)
    const httpTimeoutMs = Number(process.env.HARNESS_IDEXX_HTTP_TIMEOUT_MS || 30_000)
    /* What dmi-api answers POST /orders with when the integration replies with a ProviderError: 400,
     * this message, and the integration's description of what failed as the one error. */
    const PLACEMENT_REFUSED = 'Error while trying to place an order with idexx'

    /* A fault as the mock reports it (GET /__control__/scenarios, and the answer to its disarm). */
    type Fault = {
      id: number
      fault: string
      times: number
      hits: number
      remaining: number
      open: number
      requests: Array<{ outcome: string, ms: number | null }>
    }
    type Armed = { scenarios: Record<string, unknown>, faults: Record<string, Fault> }
    /* A dmi order as dmi-api reads it back, and the same order as the mock holds it. */
    type StoredOrder = {
      id: string
      status: string
      externalId: string
      manifest: { uri: string, contentType: string, data: string } | null
    }
    type AtIdexx = {
      idexxOrderId: string
      status: string
      pdfURL: string
      manifestFetches: string[]
      pdfSha256: string
    }

    async function armedAtMock (): Promise<Armed> {
      return expectOk<Armed>(await mock.get('/__control__/scenarios'), 'list what is armed at the mock')
    }

    /* Arm one fault, run the test's step, and disarm the fault whatever the step did: by its id, so a
     * disarm that runs late cannot take a later test's fault. Returns the step's result and the fault
     * as its disarm left it, with every request it took. */
    async function withFault<T> (
      spec: { key: string, fault: string } & Record<string, unknown>,
      step: () => Promise<T>,
    ): Promise<{ result: T, fault: Fault }> {
      const armed = expectOk<{ fault: Fault }>(
        await mock.post('/__control__/scenarios', spec),
        `arm a ${spec.fault} on ${spec.key} at the mock`,
      )
      let result: T | undefined
      let fault: Fault | null = null
      try {
        result = await step()
      } finally {
        fault = expectOk<{ fault: Fault | null }>(
          await mock.delete(`/__control__/scenarios/${spec.key}?id=${armed.fault.id}`),
          `disarm the ${spec.fault} on ${spec.key}`,
        ).fault
      }
      if (fault == null) {
        throw new Error(`the ${spec.fault} armed on ${spec.key} (id ${armed.fault.id}) was gone before the test disarmed it`)
      }
      return { result: result as T, fault }
    }

    /* What a fault did, for one assertion: how many requests it took, and what became of each. */
    function fired (fault: Fault): { hits: number, outcomes: string[] } {
      return { hits: fault.hits, outcomes: fault.requests.map((request) => request.outcome) }
    }

    /* A refused placement as one value, so a red names status, message and errors together. */
    function refusal (response: ApiResponse): { status: number, message: unknown, errors: unknown } {
      return { status: response.status, message: response.body?.message, errors: response.body?.errors }
    }

    /* The loop's own order: the in-house code with the clinic's analyzer and the ref-mapped patient. */
    function placement (): { payload: Record<string, unknown>, requisitionId: string } {
      const payload = refMappedOrderPayload({ testCodes: [{ code: serviceCode }], devices: [deviceSerial] })
      return { payload, requisitionId: payload.requisitionId as string }
    }

    async function storedOrder (id: string): Promise<StoredOrder> {
      return expectOk<StoredOrder>(await org.api.get(`/orders/${id}`), 'read the dmi order back')
    }

    async function atIdexx (requisitionId: string): Promise<AtIdexx> {
      return expectOk<AtIdexx>(
        await mock.get(`/__control__/orders/${requisitionId}`),
        'read the order from the mock control plane',
      )
    }

    /* The manifest dmi-api stored, as what a test compares: its uri, its type, the digest of the
     * bytes its base64 data decodes to, and whether those begin as a PDF does. */
    function manifestOf (order: StoredOrder): { uri: string, contentType: string, sha256: string, isPdf: boolean } | null {
      if (order.manifest == null) return null
      const bytes = Buffer.from(order.manifest.data, 'base64')
      return {
        uri: order.manifest.uri,
        contentType: order.manifest.contentType,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        isPdf: bytes.subarray(0, 5).toString('latin1') === '%PDF-',
      }
    }

    afterEach(async () => {
      /* A test that failed before its `finally` ran, or timed out inside it, must not leave anything
       * armed for the next: disarm whatever is left, then fail the test that left it. */
      const left = await armedAtMock()
      for (const key of new Set([...Object.keys(left.scenarios), ...Object.keys(left.faults)])) {
        await mock.delete(`/__control__/scenarios/${key}`)
      }
      expect({ leftArmed: left }).toEqual({ leftArmed: { scenarios: {}, faults: {} } })
    })

    it('nothing is armed at the mock when these tests start', async () => {
      expect(await armedAtMock()).toEqual({ scenarios: {}, faults: {} })
    })

    /* Regression guard (dmi-engine-idexx-integration#81): the create POST has a timeout of its own,
     * IDEXX_CREATE_ORDER_TIMEOUT_MS, and a create held past it fails at the integration, which tells
     * the caller it timed out and that IDEXX may still have the order. Before #81 the integration
     * waited on a held create for as long as it was held, and dmi-api gave up on the RPC with its own
     * 504, naming nobody. The answer is held past dmi-api's timeout too, so a create that waited for
     * anything longer than its own timeout shows as that 504. The hold runs the create at the mock
     * on arrival, as IDEXX would: the order exists at the provider, never confirmed, which is what
     * "may still have processed it" warns of. */
    it('a create held past IDEXX_CREATE_ORDER_TIMEOUT_MS fails naming that timeout, and the order is at IDEXX unconfirmed', async () => {
      /* Refused at once, saying why, when the stack cannot show it: only a create timeout that dmi-api
       * outwaits reaches the caller as the integration's error, and only one that differs from the
       * HTTP timeout says which of the two the create waited for. */
      if (!(createOrderTimeoutMs > 0 && createOrderTimeoutMs < engineTimeoutMs && createOrderTimeoutMs !== httpTimeoutMs)) {
        throw new Error(
          `HARNESS_IDEXX_CREATE_ORDER_TIMEOUT_MS is ${createOrderTimeoutMs}: this test needs a create timeout under dmi-api's ` +
            `ENGINE_RESPONSE_TIMEOUT (${engineTimeoutMs} ms), or dmi-api gives up first, and other than ` +
            `HARNESS_IDEXX_HTTP_TIMEOUT_MS (${httpTimeoutMs} ms), or the error cannot say which timeout the create had`,
        )
      }
      const { payload, requisitionId } = placement()

      const { result: response, fault } = await withFault(
        { key: 'createOrder', fault: 'hold', delayMs: engineTimeoutMs + 5_000 },
        async () => await org.api.post('/orders', payload, { autoSubmitOrder: true }),
      )
      console.log(`[idexx-scenario] held create -> HTTP ${response.status}: ${response.text.slice(0, 300)}; fault ${JSON.stringify(fault)}`)

      expect(refusal(response)).toEqual({
        status: 400,
        message: PLACEMENT_REFUSED,
        errors: [`idexx did not respond within ${createOrderTimeoutMs} ms: POST /api/v1/order. idexx may still have processed it.`],
      })
      /* The integration gave up on the held create, not the mock on the integration. */
      expect(fired(fault)).toEqual({ hits: 1, outcomes: ['client-closed'] })
      expect((await atIdexx(requisitionId)).status).toBe('CREATED')
    }, engineTimeoutMs + 20_000)

    /* Regression guard (dmi-engine-idexx-integration#83, merged into #81's branch): a connection reset
     * on an IDEXX call reaches dmi-api as a ProviderError naming the cause, ECONNRESET, and the call.
     * Before #83 the cause was lost on the way: dmi-api answered 500 with a TypeError's message
     * ("Cannot read properties of undefined …") and no errors, naming neither the reset nor the call.
     * Both ways a connection can close with no answer, a TCP RST and a FIN, since a Node client words
     * them differently. The reset comes before the route runs, so the mock never has the order. */
    it.each([
      ['rst', 'read ECONNRESET'],
      ['fin', 'socket hang up'],
    ])('a create whose connection is reset (%s) fails naming ECONNRESET, not as an internal server error', async (close, cause) => {
      const { payload, requisitionId } = placement()

      const { result: response, fault } = await withFault(
        { key: 'createOrder', fault: 'reset', close },
        async () => await org.api.post('/orders', payload, { autoSubmitOrder: true }),
      )
      console.log(`[idexx-scenario] reset (${close}) create -> HTTP ${response.status}: ${response.text.slice(0, 300)}`)

      expect(refusal(response)).toEqual({
        status: 400,
        message: PLACEMENT_REFUSED,
        errors: [`A request to idexx failed without a response (ECONNRESET: ${cause}): POST /api/v1/order. idexx may still have processed it.`],
      })
      expect(fired(fault)).toEqual({ hits: 1, outcomes: ['reset'] })
      expect((await mock.get(`/__control__/orders/${requisitionId}`)).status).toBe(404)
    }, engineTimeoutMs + 10_000)

    /* Regression guard (dmi-engine-idexx-integration#83): the headers of the create's answer arrive,
     * then part of its body, then nothing, until the create timeout ends the wait. That reaches
     * dmi-api as a ProviderError saying IDEXX answered but its body did not arrive. Before #83 it
     * reached the caller as the same 500 with a TypeError's message as the reset above did. The cause
     * it names is in the HTTP client's words, as the client reports a timeout that fires once the
     * response has begun: the body's stream aborted, the same words as a body cut short (the
     * device-list test below), not the timeout. The stall runs the route, so the order exists at
     * IDEXX. */
    it('a create whose answer stalls after its headers fails naming the body that did not arrive, not as an internal server error', async () => {
      const { payload, requisitionId } = placement()

      const { result: response, fault } = await withFault(
        { key: 'createOrder', fault: 'stall', bytes: 16 },
        async () => await org.api.post('/orders', payload, { autoSubmitOrder: true }),
      )
      console.log(`[idexx-scenario] stalled create -> HTTP ${response.status}: ${response.text.slice(0, 300)}; fault ${JSON.stringify(fault)}`)

      expect(refusal(response)).toEqual({
        status: 400,
        message: PLACEMENT_REFUSED,
        errors: [`idexx answered 200 but the body did not arrive (ERR_BAD_RESPONSE: stream has been aborted): POST /api/v1/order. idexx may still have processed it.`],
      })
      expect(fired(fault)).toEqual({ hits: 1, outcomes: ['client-closed'] })
      expect((await atIdexx(requisitionId)).status).toBe('CREATED')
    }, engineTimeoutMs + 10_000)

    /* Regression guard (dmi-engine-idexx-integration#83), on a GET: the device list's headers arrive,
     * then part of its body, and then the connection closes (the stall's cap, at 2 s, well inside the
     * integration's 30 s timeout). dmi-api's devices route names the provider's failure since
     * dmi-api#364, so the caller reads what the integration made of it: IDEXX answered, the body did
     * not arrive. No "may still have processed it": a GET changes nothing at IDEXX. */
    it('a device list cut short after its headers is a 502 naming the body that did not arrive', async () => {
      const { result: response, fault } = await withFault(
        { key: 'ivlsDevices', fault: 'stall', bytes: 16, capMs: 2_000 },
        async () => await org.api.get(`/providers/idexx/devices?integrationId=${org.integrationId}`),
      )
      console.log(`[idexx-scenario] cut-short device list -> HTTP ${response.status}: ${response.text.slice(0, 300)}`)

      expect({ status: response.status, message: response.body?.message }).toEqual({
        status: 502,
        message: 'The provider idexx failed to list devices with status 502: idexx answered 200 but the body did not arrive (ERR_BAD_RESPONSE: stream has been aborted): GET /api/v1/ivls/devices.',
      })
      expect(fired(fault)).toEqual({ hits: 1, outcomes: ['capped'] })
    }, engineTimeoutMs + 10_000)

    /* What every test here leans on when it fails midway: disarming a key ends what its fault still
     * holds, there and then, and a disarm by any other arming's id leaves the fault alone. A device
     * list is held for far longer than dmi-api waits, and disarmed once the mock holds it: the
     * integration's call fails at once, its connection closed, instead of being answered late. */
    it('disarming a held call ends it at once, and a disarm by another id leaves the fault armed', async () => {
      const armed = expectOk<{ fault: Fault }>(
        await mock.post('/__control__/scenarios', { key: 'ivlsDevices', fault: 'hold', delayMs: 120_000 }),
        'hold the device list at the mock',
      )
      try {
        const pending = org.api.get(`/providers/idexx/devices?integrationId=${org.integrationId}`)
        await pollUntil(armedAtMock, (now) => now.faults.ivlsDevices?.open === 1, engineTimeoutMs, 200)

        const byAnotherId = expectOk<{ fault: Fault | null }>(
          await mock.delete(`/__control__/scenarios/ivlsDevices?id=${armed.fault.id + 1}`),
          'disarm the hold by an id it does not have',
        )
        const stillArmed = (await armedAtMock()).faults.ivlsDevices
        const cleared = expectOk<{ fault: Fault }>(
          await mock.delete(`/__control__/scenarios/ivlsDevices?id=${armed.fault.id}`),
          'disarm the hold',
        )
        const response = await pending
        console.log(`[idexx-scenario] disarmed held device list -> HTTP ${response.status}: ${response.text.slice(0, 300)}`)

        expect({ byAnotherId: byAnotherId.fault, stillArmed: stillArmed?.id }).toEqual({ byAnotherId: null, stillArmed: armed.fault.id })
        expect(fired(cleared.fault)).toEqual({ hits: 1, outcomes: ['destroyed'] })
        /* Closed by the mock's disarm, with a FIN, long before dmi-api's own timeout: a hold left to
         * run would have been dmi-api's 504 instead. */
        expect({ status: response.status, message: response.body?.message }).toEqual({
          status: 502,
          message: 'The provider idexx failed to list devices with status 502: A request to idexx failed without a response (ECONNRESET: socket hang up): GET /api/v1/ivls/devices.',
        })
      } finally {
        /* By its id, like every other cleanup here: a late one must not disarm a later test's fault. */
        await mock.delete(`/__control__/scenarios/ivlsDevices?id=${armed.fault.id}`)
      }
    }, engineTimeoutMs + 10_000)

    /* The positive twin of the manifest test below: an order placed without autoSubmitOrder is
     * created, waiting for input, and dmi-api stores the PDF its create answer points at — the
     * bytes the mock served, fetched once, before any confirm. */
    it('an order placed without autoSubmitOrder is created with the manifest IDEXX serves for it', async () => {
      const { payload, requisitionId } = placement()

      const created = expectOk<{ id: string, status: string, externalId: string }>(
        await org.api.post('/orders', payload),
        'place an idexx order without autoSubmitOrder',
      )
      const stored = await storedOrder(created.id)
      const provider = await atIdexx(requisitionId)

      expect({ status: created.status, externalId: created.externalId }).toEqual({ status: 'WAITING_FOR_INPUT', externalId: provider.idexxOrderId })
      expect(provider.manifestFetches).toEqual(['CREATED'])
      expect(manifestOf(stored)).toEqual({ uri: provider.pdfURL, contentType: 'application/pdf', sha256: provider.pdfSha256, isPdf: true })
    }, 30_000)

    /* Regression guard (dmi-engine-idexx-integration#81): once IDEXX has created an order, a manifest
     * fetch that fails no longer fails the create. Before #81 it did: the caller got an error for an
     * order that existed at IDEXX, and lost its id. Now the order is reported as created, with IDEXX's
     * id and without a manifest. Without autoSubmitOrder, so the fetch after the create is the only
     * one. */
    it('an order whose manifest fetch fails is still created, with IDEXX\'s id and no manifest', async () => {
      const { payload, requisitionId } = placement()

      const { result: response, fault } = await withFault(
        { key: 'manifest', fault: 'reset' },
        async () => await org.api.post('/orders', payload),
      )
      console.log(`[idexx-scenario] create with a failed manifest -> HTTP ${response.status}: ${response.text.slice(0, 300)}`)
      const provider = await atIdexx(requisitionId)

      expect({ status: response.status, orderStatus: response.body?.status, externalId: response.body?.externalId })
        .toEqual({ status: 201, orderStatus: 'WAITING_FOR_INPUT', externalId: provider.idexxOrderId })
      expect(fired(fault)).toEqual({ hits: 1, outcomes: ['reset'] })
      const stored = await storedOrder(response.body.id)
      expect({ externalId: stored.externalId, manifest: manifestOf(stored) }).toEqual({ externalId: provider.idexxOrderId, manifest: null })
    }, 30_000)

    /* A failed step of the confirm handshake does not fail the create: the order exists at IDEXX
     * by then, and failing would lose its id. dmi-engine-idexx-integration#93 calls that much right
     * and leaves the rest open — what status the caller gets, and how the failure is made visible —
     * so this asserts only the settled part: 201, with IDEXX's id stored. Each of the three steps in
     * turn, each failing with a reset. */
    it.each([
      ['uiPage', 'the UI page'],
      ['uiOrderGet', 'the order setup'],
      ['uiOrderPut', 'the submission'],
    ])('an auto-submitted order whose confirm step %s (%s) fails is still created, with IDEXX\'s id', async (key) => {
      const { payload, requisitionId } = placement()

      const { result: response, fault } = await withFault(
        { key, fault: 'reset' },
        async () => await org.api.post('/orders', payload, { autoSubmitOrder: true }),
      )
      console.log(`[idexx-scenario] create with a failed ${key} -> HTTP ${response.status}: ${response.text.slice(0, 200)}`)
      const provider = await atIdexx(requisitionId)

      expect({ status: response.status, externalId: response.body?.externalId }).toEqual({ status: 201, externalId: provider.idexxOrderId })
      expect(fired(fault)).toEqual({ hits: 1, outcomes: ['reset'] })
      expect((await storedOrder(response.body.id)).externalId).toBe(provider.idexxOrderId)
    }, 30_000)

    /* Regression guard (dmi-api#409, fixed in dmi-api#410), through IDEXX's results confirm: a
     * confirm that fails leaves the batch at IDEXX, the next poll fetches it again and delivers it
     * again, and confirms it. The second delivery is identical to the first, and since dmi-api#410
     * dmi-api leaves a report alone when a result arrives again unchanged, so the PIMS sees one
     * `report:updated`. Before it, every delivery was another `report:updated` for a report that had
     * not changed. The mock's ledger shows the redelivery from the provider's side: the batch served
     * at least twice, and confirmed once, by the route, after the fault took the first confirm. This
     * test seeds a result, and waits for its batch's confirm, so the overlapping-polls test below
     * starts on an empty feed. */
    it('a results confirm that fails is delivered again and confirmed by a later poll, and the PIMS sees one report:updated', async () => {
      const { payload, requisitionId } = placement()
      const created = expectOk<{ id: string }>(
        await org.api.post('/orders', payload, { autoSubmitOrder: true }),
        'place the idexx order whose results confirm will fail',
      )
      type LedgerBatch = { batchId: string, requisitionIds: string[], served: number, confirms: number[] }
      const batchesFor = async (): Promise<LedgerBatch[]> =>
        expectOk<{ batches: LedgerBatch[] }>(await mock.get('/__control__/batches'), 'read the mock results-batch ledger')
          .batches.filter((batch) => batch.requisitionIds.includes(requisitionId))

      const { result: batches, fault } = await withFault(
        { key: 'resultsConfirm', fault: 'reset' },
        async () => {
          expectOk(await mock.post(`/__control__/orders/${requisitionId}/results`, {}), 'seed the result whose confirm will fail')
          return await pollUntil(batchesFor, (now) => now.some((batch) => batch.confirms.includes(200)), 60_000, 500)
        },
      )
      console.log(`[idexx-scenario] results-batch ledger after a failed confirm -> ${JSON.stringify(batches)}; fault ${JSON.stringify(fault)}`)

      expect(fired(fault)).toEqual({ hits: 1, outcomes: ['reset'] })
      expect(batches.map((batch) => ({ fetchedAgain: batch.served >= 2, confirms: batch.confirms })))
        .toEqual([{ fetchedAgain: true, confirms: [200] }])

      const completed = await pollUntil(async () => await storedOrder(created.id), (order) => order.status === 'COMPLETED', 30_000, 1_000)
      expect(completed.status).toBe('COMPLETED')
      const report = expectOk<{ id: string }>(await org.api.get(`/orders/${created.id}/report`), 'read the order report')
      /* Polled until the first `report:updated` is in; the second delivery came before the confirm
       * the ledger shows, so a second one would be in by then too. */
      const types = await pollUntil(
        async () => expectOk<{ data: Array<{ type: string, data?: { orderId?: string, reportId?: string } }> }>(
          await org.api.get('/events', { start_seq: 0, limit: 1000 }),
          'list events',
        ).data
          .filter((event) => event.data?.orderId === created.id || event.data?.reportId === report.id)
          .map((event) => event.type),
        (now) => now.includes('report:updated'),
        30_000,
        1_000,
      )
      expect({ reportUpdatedEvents: types.filter((type) => type === 'report:updated').length }).toEqual({ reportUpdatedEvents: 1 })
    }, 30_000 + 60_000 + 30_000 + 30_000 + 10_000)

    /* dmi-engine-idexx-integration#93's second case: the confirm succeeds, and the manifest fetch
     * after it fails. The positive twin first: with both succeeding, an auto-submitted order is
     * SUBMITTED, and dmi-api stores the PDF fetched after the confirm — the mock answered two
     * fetches, one before the submission and one after. */
    it('an auto-submitted order is SUBMITTED, with the manifest fetched after its confirm', async () => {
      const { payload, requisitionId } = placement()

      const created = expectOk<{ id: string, status: string, externalId: string }>(
        await org.api.post('/orders', payload, { autoSubmitOrder: true }),
        'place an auto-submitted idexx order',
      )
      const stored = await storedOrder(created.id)
      const provider = await atIdexx(requisitionId)

      expect({ status: created.status, stored: stored.status, atIdexx: provider.status }).toEqual({ status: 'SUBMITTED', stored: 'SUBMITTED', atIdexx: 'SUBMITTED' })
      expect(provider.manifestFetches).toEqual(['CREATED', 'SUBMITTED'])
      expect(manifestOf(stored)).toEqual({ uri: provider.pdfURL, contentType: 'application/pdf', sha256: provider.pdfSha256, isPdf: true })
    }, 30_000)

    describe('a confirm that succeeds and a manifest fetch after it that fails (dmi-engine-idexx-integration#93)', () => {
      /* The order the plain test places; the tripwire reads how dmi-api recorded it. */
      let submittedOrderId: string

      /* The setup half of the tripwire below, a test of its own so that a red names which half broke:
       * both manifest fetches fail (the one after the create, which the integration tolerates, and
       * the one after the confirm), the confirm itself succeeds, and the order is submitted at IDEXX.
       * A red here means the state the tripwire reads was never reached. */
      it('with both manifest fetches failing, an auto-submitted order is still created and submitted at IDEXX', async () => {
        const { payload, requisitionId } = placement()

        const { result: response, fault } = await withFault(
          { key: 'manifest', fault: 'reset', times: 2 },
          async () => await org.api.post('/orders', payload, { autoSubmitOrder: true }),
        )
        console.log(`[idexx-scenario] confirmed order with failed manifests -> HTTP ${response.status}: ${response.text.slice(0, 200)}`)
        const provider = await atIdexx(requisitionId)

        expect({ status: response.status, externalId: response.body?.externalId }).toEqual({ status: 201, externalId: provider.idexxOrderId })
        expect(fired(fault)).toEqual({ hits: 2, outcomes: ['reset', 'reset'] })
        expect(provider.status).toBe('SUBMITTED')
        submittedOrderId = response.body.id
      }, 30_000)

      /* TRIPWIRE (dmi-engine-idexx-integration#93). Expected: an order the confirm submitted is
       * reported SUBMITTED, whatever becomes of the manifest fetch after it. Today the loop sees it
       * reported WAITING_FOR_INPUT, the status it had before the confirm, while the mock has it
       * submitted: a failed fetch after the confirm leaves the order as if the confirm had not run.
       * The order sits at IDEXX submitted while dmi-api, and the PIMS, wait for input that is not
       * needed. The positive twin is the test above this describe; the plain test just above reaches
       * the state this reads. */
      it.failing('the order is reported SUBMITTED', async () => {
        expect((await storedOrder(submittedOrderId)).status).toBe('SUBMITTED')
      })
    })
  })

  /* ---- dmi-engine-idexx-integration#88 guard ----
   *
   * The integration polls IDEXX's results with one Bull repeat job per integration. Each run GETs
   * the latest batch — which stays at IDEXX until it is confirmed — emits its results to dmi-api, then
   * confirms the batch. Bull schedules a repeat job's next run when the current one STARTS, so when
   * the integration runs as more than one replica, two results polls of one integration can be in
   * flight at once: a run still waiting for its answer, and the next tick on another replica. Both
   * get the same unconfirmed batch and both emit it: dmi-api applies it twice and the PIMS gets a
   * second `report:updated` for a report that did not change. The first confirm is answered 200; the
   * second is IDEXX's 404 INVALID_BATCH_ID, and that job fails. The fix lets one results poll per
   * integration run at a time: a tick that finds one in flight skips, and the next tick fetches.
   *
   * The loop reproduces the overlap across replicas: compose runs the integration as two replicas
   * with one results worker each, and the mock's `resultsLatestDelay` scenario holds one poll's
   * answer in flight while the next ticks fall due. The held poll occupies its replica's only
   * worker, so the next tick can only be taken by the other replica: a guard that held within one
   * process only would let it through. Compose also gives the integration's results poll lock a
   * lifetime shorter than the hold, so the lock as first taken runs out under the held poll: a lock
   * that is not extended while its poll runs would let the other replica through as well. Last in
   * the file, and with an order of its own, so that nothing above sees the held answer. */
  describe('two results polls in flight deliver one batch once (dmi-engine-idexx-integration#88)', () => {
    /* The integration's results poll interval, its replica count, the lifetime of its results poll
     * lock and its HTTP timeout. src/env.ts carries none of them, so each is read the way
     * docker-compose.yml reads it: from the environment, with compose's default when it is unset or
     * empty (HARNESS_IDEXX_POLL_MS, 3000; HARNESS_IDEXX_REPLICAS, 2; HARNESS_IDEXX_RESULTS_LOCK_TTL_MS,
     * 5000; HARNESS_IDEXX_HTTP_TIMEOUT_MS, 30000). Compose also reads a slot tree's .env, which the
     * harness does not load into this process (src/slots.js only checks the project name there), so a
     * value set in that file alone is not seen here. */
    const pollMs = Number(process.env.HARNESS_IDEXX_POLL_MS || 3_000)
    const replicas = Number(process.env.HARNESS_IDEXX_REPLICAS || 2)
    const lockTtlMs = Number(process.env.HARNESS_IDEXX_RESULTS_LOCK_TTL_MS || 5_000)
    /* Three intervals, so at least two later ticks fall due while the first poll's answer is held. */
    const delayMs = 3 * pollMs
    /* The integration's HTTP timeout, as compose sets it. The integration must still be waiting for
     * the held answer when it comes, so the hold has to stay under this. */
    const integrationHttpTimeoutMs = Number(process.env.HARNESS_IDEXX_HTTP_TIMEOUT_MS || 30_000)

    /* One batch as the mock's ledger records it (GET /__control__/batches). */
    type LedgerBatch = {
      batchId: string
      requisitionIds: string[]
      served: number
      confirms: number[]
      holds: Array<{ delayMs: number, requestsWhileHeld: number, sent: boolean }>
    }

    it('a batch held in flight past the next ticks is fetched once, confirmed once and reported once', async () => {
      /* Refused at once, saying why, when the stack cannot show the defect: with one replica the next
       * tick waits for the held poll and this test would pass on a build that lets polls overlap; a
       * hold that outlasts the integration's HTTP timeout fails the held poll instead; and a lock that
       * lasts until the last tick inside the hold would pass without ever being extended, as would a
       * lifetime the integration does not keep. */
      if (!(replicas >= 2)) {
        throw new Error(
          `HARNESS_IDEXX_REPLICAS is ${process.env.HARNESS_IDEXX_REPLICAS}: this test needs at least two integration ` +
            'replicas, because with one the next tick waits for the held poll and two polls can never be in flight at once',
        )
      }
      if (!(delayMs < integrationHttpTimeoutMs)) {
        throw new Error(
          `the held answer would last ${delayMs} ms (3 × HARNESS_IDEXX_POLL_MS=${pollMs}), but the integration gives up on ` +
            `an answer after ${integrationHttpTimeoutMs} ms (HARNESS_IDEXX_HTTP_TIMEOUT_MS): this test needs a poll interval ` +
            `under ${integrationHttpTimeoutMs / 3} ms`,
        )
      }
      /* The ticks one and two intervals after the held poll started fall due inside the hold; the one
       * after three races its end. So the lock as first taken has to be gone by the second. It also
       * has to be a lifetime the integration keeps: one that is not a positive number of milliseconds
       * (0, a negative one) is replaced there by the integration's own default, which outlasts the
       * hold. */
      if (!(Number.isFinite(lockTtlMs) && lockTtlMs > 0 && lockTtlMs <= 2 ** 31 - 1 && lockTtlMs < delayMs - pollMs)) {
        throw new Error(
          `HARNESS_IDEXX_RESULTS_LOCK_TTL_MS is ${lockTtlMs}: this test needs a lock lifetime that is a positive number of ` +
            `milliseconds under ${delayMs - pollMs}. A longer one lasts past the last tick sure to fall due while the answer ` +
            `is held (${delayMs - pollMs} ms after the held poll started, 2 × HARNESS_IDEXX_POLL_MS=${pollMs}), and one that ` +
            `is not a positive number is replaced by the integration's own, longer default: either way this test would ` +
            `pass on a lock that is never extended`,
        )
      }

      /* Its own order, never part of the loop above: the same in-house code, device and ref-mapped
       * patient as the loop's own order. */
      const payload = refMappedOrderPayload({
        testCodes: [{ code: serviceCode }],
        devices: [deviceSerial],
      })
      const overlapRequisitionId = payload.requisitionId as string
      const created = expectOk<{ id: string }>(
        await org.api.post('/orders', payload, { autoSubmitOrder: true }),
        'place the idexx order whose results batch will be held',
      )
      const overlapOrderId = created.id

      /* Armed first, then the result seeded: the hold takes the first answer that carries a batch,
       * and the polls in between find nothing and pass through untouched. */
      expectOk(
        await mock.post('/__control__/scenarios', { key: 'resultsLatestDelay', delayMs, once: true }),
        'hold the next results answer that carries a batch at the mock',
      )
      expectOk(
        await mock.post(`/__control__/orders/${overlapRequisitionId}/results`, {}),
        'seed the result whose batch will be held',
      )

      const completed = await pollUntil(
        async () => await org.api.get(`/orders/${overlapOrderId}`),
        (r) => r.body?.status === 'COMPLETED',
        90_000,
        2_000,
      )
      expect(completed.body.status).toBe('COMPLETED')

      /* The held answer has been sent and the batch confirmed at least once. Then two more poll
       * intervals, so that a second poll's confirm, racing the first, would have landed too. */
      const batchesFor = async (): Promise<LedgerBatch[]> => {
        const ledger = expectOk<{ batches: LedgerBatch[] }>(
          await mock.get('/__control__/batches'),
          'read the mock results-batch ledger',
        )
        return ledger.batches.filter((batch) => batch.requisitionIds.includes(overlapRequisitionId))
      }
      await pollUntil(
        batchesFor,
        (batches) => batches.some((batch) => batch.holds.some((hold) => hold.sent) && batch.confirms.length > 0),
        delayMs + 30_000,
        500,
      )
      await new Promise((resolve) => setTimeout(resolve, 2 * pollMs))
      const batches = await batchesFor()
      console.log(`[idexx-scenario] results-batch ledger for the held order -> ${JSON.stringify(batches)}`)

      /* THE POINT OF THIS TEST, read from the provider's side. With two polls in flight, both fetch
       * the batch (served 2) and both confirm it, and the second confirm is IDEXX's 404
       * INVALID_BATCH_ID (confirms [200, 404]); the poll that reached the provider while the first
       * was held is counted too. One poll at a time: served once, confirmed once with a 200, and no
       * results poll reached the provider while the held one was in flight, because each tick
       * meanwhile skipped.
       *
       * That last count is of every results poll that reaches the mock during the hold, whichever
       * integration sent it: every integration here uses the same harness credentials, so the mock
       * cannot tell them apart. It is 0 because this file has one idexx integration polling. A second
       * one would break all three values with the fix in place: the mock serves its one active batch
       * to any integration, and its lock has a different key. */
      expect(batches.map((batch) => ({
        pollsThatFetchedTheBatch: batch.served,
        confirmsOfTheBatch: batch.confirms,
        pollsThatReachedTheProviderWhileItWasHeld: batch.holds.map((hold) => hold.requestsWhileHeld),
      }))).toEqual([{
        pollsThatFetchedTheBatch: 1,
        confirmsOfTheBatch: [200],
        pollsThatReachedTheProviderWhileItWasHeld: [0],
      }])

      /* And from the PIMS's side: the report was updated once. A second delivery of the batch is a
       * second `report:updated` for an unchanged report, which is what the PIMS saw in production. */
      const report = expectOk<{ id: string }>(
        await org.api.get(`/orders/${overlapOrderId}/report`),
        'read the held order report',
      )
      /* Polled until the first `report:updated` is in, so that the count below does not race
       * dmi-api's own write; a second delivery would have been emitted two intervals ago. */
      const eventTypesFor = async (): Promise<string[]> => {
        const events = expectOk<{ data: Array<{ type: string, data?: { orderId?: string, reportId?: string } }> }>(
          await org.api.get('/events', { start_seq: 0, limit: 1000 }),
          'list events',
        )
        return events.data
          .filter((event) => event.data?.orderId === overlapOrderId || event.data?.reportId === report.id)
          .map((event) => event.type)
      }
      const forTheOrder = await pollUntil(
        eventTypesFor,
        (types) => types.includes('report:updated'),
        30_000,
        1_000,
      )
      console.log(`[idexx-scenario] events for the held order -> ${JSON.stringify(forTheOrder)}`)
      expect({
        reportUpdatedEvents: forTheOrder.filter((type) => type === 'report:updated').length,
      }).toEqual({ reportUpdatedEvents: 1 })
    }, 30_000 + 90_000 + (delayMs + 30_000) + 2 * pollMs + 30_000 + 10_000)
  })
})

/* ---- service control: the broker, Redis and the engine taken away under the loop ----
 *
 * Merged changes that make the stack survive losing one of its services, each pinned end to end:
 * Redis frozen and resumed (dmi-engine-idexx-integration#74), Redis emptied and the operator's
 * repair pass (dmi-api#346), the broker restarted (dmi-api#367). The faults come from src/services.ts,
 * scoped to this slot's compose project, each restored in the test's `finally` and again by
 * `afterEach`, so that a test that fails or times out midway still hands the next one a whole stack.
 *
 * Self-contained, and after the loop's own describe: an organization and an integration of its own,
 * started here and stopped in afterAll. It must be the only idexx integration polling while it runs:
 * the mock serves its one active results batch to whichever integration polls first (every one uses
 * the harness's credentials), so another one polling would take this describe's results. The faults
 * run least disruptive first: the Redis pause, then the flush, whose pass re-registers the polling
 * jobs whatever the pause left behind, then the broker restart, which needs no polling at all. */
describe('the loop outlives its broker, Redis and engine going away (service control)', () => {
  /* The integration's compose service: two replicas (HARNESS_IDEXX_REPLICAS). */
  const ENGINE = 'dmi-engine-idexx-integration'
  /* The integration's poll interval, as docker-compose.yml reads it (see the #88 describe above). */
  const pollMs = Number(process.env.HARNESS_IDEXX_POLL_MS || 3_000)

  const mock = ApiClient.create(env.idexx.mockBaseUrl)
  let org: SeededOrg
  let admin: ApiClient
  let serviceCode: string
  let deviceSerial: string

  /* An order with this describe's integration, its in-house code and the clinic's analyzer. */
  async function placeOrder (): Promise<{ orderId: string, requisitionId: string }> {
    const payload = orderPayload(org.integrationId, { testCodes: [{ code: serviceCode }], devices: [deviceSerial] })
    const created = expectOk<{ id: string, status: string }>(
      await org.api.post('/orders', payload, { autoSubmitOrder: true }),
      'place an idexx order for the service-control tests',
    )
    expect(created.status).toBe('SUBMITTED')
    return { orderId: created.id, requisitionId: payload.requisitionId as string }
  }

  async function orderStatus (orderId: string): Promise<string | undefined> {
    return (await org.api.get(`/orders/${orderId}`)).body?.status
  }

  beforeAll(async () => {
    /* A run starts with nothing stopped or paused, by this harness or anything else. */
    await assertStackWhole()
    /* As in the loop's own beforeAll: only load-bearing for warm reruns (HARNESS_KEEP_UP). */
    await mock.post('/__control__/reset').catch(() => undefined)

    const catalogue = expectOk<{ list: Array<{ code: string, inHouse: boolean }> }>(
      await mock.get('/api/v1/ref/tests'),
      'read the mock orderable-test catalogue',
    )
    const inHouse = catalogue.list.find((service) => service.inHouse)
    if (inHouse == null) throw new Error('the mock catalogue advertises no in-house test code')
    serviceCode = inHouse.code
    deviceSerial = expectOk<{ ivlsDeviceList: Array<{ deviceSerialNumber: string }> }>(
      await mock.get('/api/v1/ivls/devices'),
      'read the mock IVLS device list',
    ).ivlsDeviceList[0].deviceSerialNumber

    const root = ApiClient.create()
    org = await seedOrganization(root, 'idexx-services', {
      providerId: 'idexx',
      configuration: {
        orderingBaseUrl: env.idexx.orderingBaseUrl,
        resultBaseUrl: env.idexx.resultBaseUrl,
        'X-Pims-Id': env.idexx.pimsId,
        'X-Pims-Version': env.idexx.pimsVersion,
      },
      integrationOptions: { username: env.idexx.username, password: env.idexx.password, locale: env.idexx.locale },
    })
    admin = await adminLogin(root)
    expectOk(await admin.post(`/admin/integrations/${org.integrationId}/start`), 'start the service-control integration')
  }, 120_000)

  /* The backstop: whatever a test left stopped or paused, even one jest abandoned on its timeout, is
   * restored before the next test starts, and the stack is checked whole. */
  afterEach(async () => {
    await restoreServices()
  }, 180_000)

  /* ---- dmi-engine-idexx-integration#74 guard ----
   *
   * Since dmi-engine-idexx-integration#74, an integration restart sent while Redis does not answer is
   * answered, with its failure, within a bound of the integration's own (10 s unless configured
   * otherwise; the harness leaves it there). Before #74 such a restart got no answer from the
   * integration at all, and the caller learned nothing until its own engine timeout: in production
   * 90 s, after which the restart that should have repaired polling had failed without a word from
   * the engine. Redis is paused, which freezes it with every connection left open, as a Redis that
   * stops answering does. The restart is asked for by the operator's pass
   * (`ensure-integration-status`, one attempt, this integration only), run with an engine timeout of
   * its own well above the integration's bound: the loop's dmi-api waits 10 s, which would race it.
   * Then Redis resumes, and the next restart must bring polling back.
   *
   * Pausing Redis alone, and resuming it, proves nothing here: polling resumes once Redis answers
   * again, with #74 or without it (that staging passed against the integration with #74's change
   * taken out). How soon the restart is answered is what #74 changes. */
  it('with Redis frozen, a restart fails within 20 s instead of hanging, and polling resumes once Redis answers (dmi-engine-idexx-integration#74)', async () => {
    const faults = serviceFaults()
    const { orderId, requisitionId } = await placeOrder()

    const passEngineTimeoutMs = 30_000
    let paused: Disruption
    let answeredWhilePaused: boolean
    let frozenPass: DmiApiScriptRun
    let askedAt: number | undefined
    let failedAt: number | undefined
    try {
      paused = await faults.pause(REDIS)
      answeredWhilePaused = await redisAnswers(2_000)
      frozenPass = await runDmiApiScript('ensure-integration-status', [`--integration-id=${org.integrationId}`, '--attempts=1'], {
        timeoutMs: passEngineTimeoutMs + 60_000,
        environment: { ENGINE_RESPONSE_TIMEOUT: String(passEngineTimeoutMs) },
        onLine: (line) => {
          /* The pass logs what it found just before it sends the first engine request. */
          if (askedAt == null && /Found .*integration/.test(line)) askedAt = Date.now()
          if (failedAt == null && line.includes(org.integrationId) && /fail|error/i.test(line)) failedAt = Date.now()
        },
      })
    } finally {
      await faults.restore(REDIS)
    }
    console.log(`[idexx-scenario] restart while Redis was frozen -> exit ${frozenPass.code}, failed ${failedAt == null || askedAt == null ? '(never)' : `${failedAt - askedAt} ms`} after the request:\n${frozenPass.output.filter((line) => /IntegrationsService|ensuring/.test(line)).join('\n')}`)
    /* The fault fired: the project's one Redis was paused, and it did not answer while it was. */
    expect({ containers: paused.containers, answeredWhilePaused }).toEqual({
      containers: [`${env.composeProject}-redis-1`],
      answeredWhilePaused: false,
    })
    /* THE POINT OF THIS TEST: the engine answered the restart, with its failure, inside its 10 s
     * bound plus slack, and not at the pass's own timeout at 30 s. */
    expect({
      exitCode: frozenPass.code,
      restartFailed: failedAt != null,
      answeredWithin20s: failedAt != null && askedAt != null && failedAt - askedAt < 20_000,
    }).toEqual({ exitCode: 1, restartFailed: true, answeredWithin20s: true })

    /* Redis answers again: the next restart succeeds, and polling resumes — a result seeded now is
     * delivered. */
    expect(await redisAnswers(2_000)).toBe(true)
    const pass = await runDmiApiScript('ensure-integration-status', [`--integration-id=${org.integrationId}`], { timeoutMs: 120_000 })
    expect({ exitCode: pass.code, pollingJobs: (await repeatableJobsNaming(org.integrationId)).length }).toEqual({ exitCode: 0, pollingJobs: 2 })
    expectOk(await mock.post(`/__control__/orders/${requisitionId}/results`, {}), 'seed a result after Redis resumed')
    const completed = await pollUntil(async () => await orderStatus(orderId), (status) => status === 'COMPLETED', 60_000, 1_000)
    expect(completed).toBe('COMPLETED')
  }, 30_000 + 90_000 + 120_000 + 60_000 + 30_000)

  /* ---- dmi-api#346 guard ----
   *
   * An integration's polling jobs live only in Redis: after a cutover to an empty Redis (or a flush,
   * or an eviction) the integration stays RUNNING in dmi-api with nothing polling, and nothing
   * re-creates the jobs. `npm run ensure-integration-status` is the operator's repair: it restarts
   * each integration, so the engine registers its jobs again. dmi-api#346 made it usable for that:
   * an integration whose restart fails is retried with a backoff, and the pass carries on and reports
   * it, where before the first failure was the last word. Here the engine misses the pass's first
   * attempt: both replicas are paused until the pass reports that attempt failed, as an engine that
   * stops answering for a while (a pod restarted for the cutover) would. The pass must still bring
   * polling back. Against the pass before dmi-api#346 the attempt that failed is the last one, the
   * pass exits 0, and nothing polls. */
  it('after Redis is flushed, ensure-integration-status brings polling back, though the engine misses its first attempt (dmi-api#346)', async () => {
    const faults = serviceFaults()

    /* The integration's two polling jobs (results and orders), as Bull registers them. */
    const registered = await repeatableJobsNaming(org.integrationId)
    const flushed = await faults.flushRedis()
    const registeredAfter = await repeatableJobsNaming(org.integrationId)
    expect({ registered: registered.length, keysAfter: flushed.keysAfter, registeredAfter }).toEqual({
      registered: 2,
      keysAfter: 0,
      registeredAfter: [],
    })

    /* Polling is dead: a result seeded now is not delivered over four poll intervals. */
    const { orderId, requisitionId } = await placeOrder()
    expectOk(await mock.post(`/__control__/orders/${requisitionId}/results`, {}), 'seed a result after the flush')
    await sleep(4 * pollMs)
    expect(await orderStatus(orderId)).toBe('SUBMITTED')

    /* The pass, for this integration only, with the engine unable to answer until the pass reports
     * a failed attempt for it. */
    let unpausing: Promise<void> | undefined
    let pass: DmiApiScriptRun
    try {
      await faults.pause(ENGINE)
      pass = await runDmiApiScript('ensure-integration-status', [`--integration-id=${org.integrationId}`], {
        timeoutMs: 120_000,
        onLine: (line) => {
          if (unpausing == null && line.includes(org.integrationId) && /fail|error/i.test(line)) unpausing = faults.restore(ENGINE)
        },
      })
    } finally {
      await unpausing
      await faults.restore(ENGINE)
    }
    const sawFailedAttempt = unpausing != null
    console.log(`[idexx-scenario] ensure-integration-status -> exit ${pass.code}:\n${pass.output.join('\n')}`)
    expect({ exitCode: pass.code, sawFailedAttempt }).toEqual({ exitCode: 0, sawFailedAttempt: true })
    expect({ pollingJobsAfterThePass: (await repeatableJobsNaming(org.integrationId)).length }).toEqual({ pollingJobsAfterThePass: 2 })

    const completed = await pollUntil(async () => await orderStatus(orderId), (status) => status === 'COMPLETED', 60_000, 1_000)
    expect(completed).toBe('COMPLETED')
  }, 30_000 + 4 * 3_000 + 120_000 + 60_000 + 30_000)

  /* ---- dmi-api#367 guard ----
   *
   * dmi-api's MQTT client subscribes to a pattern's reply channel (`<pattern>/reply`) on demand and
   * counts the requests in flight on it. Before dmi-api#367 it unsubscribed the channel whenever that
   * count fell to zero, and subscribed again only when a request found it at zero. A broker outage
   * breaks the count: a request made while the broker is down never gets its subscription (mqtt.js
   * fails it with the connection), yet its timeout still counts it out, so from then on the count
   * runs one below the requests in flight. When the first of two overlapping requests completes,
   * the channel is unsubscribed under the other, whose reply is lost: dmi-api answers it 504 after
   * its 10 s. Since dmi-api#367 the client never unsubscribes a reply channel, and subscribes it
   * again after a timeout.
   *
   * So the test sends two device lookups at once, one of them held for 3 s, before the restart: both
   * are answered, which shows the probe itself works. A lookup made while the broker is stopped is
   * the one timeout the outage costs. Afterwards a lookup may time out once more, if it is published
   * before the engine's replicas are back on the broker, and then the overlapping pair is sent again
   * and both must be answered. Last, an order is placed (placeOrder asserts SUBMITTED, which is the
   * engine's reply). Against dmi-api before #367 the pair after the restart loses the held lookup. */
  it('a broker restart leaves the device and order round trips answering, at worst after one timeout (dmi-api#367)', async () => {
    const faults = serviceFaults()
    const lookup = async (): Promise<{ status: number, ms: number }> => {
      const started = Date.now()
      const response = await org.api.get(`/providers/idexx/devices?integrationId=${org.integrationId}`)
      return { status: response.status, ms: Date.now() - started }
    }
    /* Two lookups in flight at once, one held: replica 1 of the integration is paused for holdMs, and
     * the broker hands a shared subscription's messages to its subscribers in turn, so one lookup
     * waits on the paused replica while the other is answered. */
    const holdMs = 3_000
    const overlapping = async (): Promise<Array<{ status: number, ms: number }>> => {
      let answers: Promise<Array<{ status: number, ms: number }>>
      try {
        await faults.pause(ENGINE, { replica: 1 })
        answers = Promise.all([lookup(), lookup()])
        await sleep(holdMs)
      } finally {
        await faults.restore(ENGINE, { replica: 1 })
      }
      return (await answers).sort((a, b) => a.ms - b.ms)
    }

    const before = await overlapping()
    console.log(`[idexx-scenario] overlapping lookups before the broker restart -> ${JSON.stringify(before)}`)

    let duringOutage: { status: number, ms: number }
    try {
      await faults.stop(BROKER)
      duringOutage = await lookup()
    } finally {
      await faults.restore(BROKER)
    }
    /* Afterwards, at worst one more timeout: a request published before the engine's replicas are
     * back on the broker reaches nobody (they reconnect shortly after dmi-api does). */
    const after = [await lookup()]
    if (after[0].status !== 200) after.push(await lookup())
    const overlappingAfter = await overlapping()
    console.log(`[idexx-scenario] broker restart -> during ${JSON.stringify(duringOutage)}, after ${JSON.stringify(after)}, overlapping after ${JSON.stringify(overlappingAfter)}`)
    await placeOrder()

    expect({ before: before.map(({ status }) => status), held: before[1].ms >= holdMs && before[0].ms < holdMs }).toEqual({ before: [200, 200], held: true })
    expect(duringOutage.status).toBe(504)
    expect(after.map(({ status }) => status)).toEqual(after.length === 1 ? [200] : [504, 200])
    expect({ overlappingAfter: overlappingAfter.map(({ status }) => status), held: overlappingAfter[1].ms >= holdMs && overlappingAfter[0].ms < holdMs })
      .toEqual({ overlappingAfter: [200, 200], held: true })
  }, 120_000)

  /* ---- dmi-api#399 guard ----
   *
   * Before dmi-api#399 a SIGTERM (what every pod stop sends) ended dmi-api at once, and a request in
   * flight lost its connection. Since, dmi-api handles SIGTERM: it goes on accepting requests for
   * SHUTDOWN_DELAY_MS (4 s by default) while Kubernetes takes the pod out of the Service, then stops
   * listening and waits for the requests in flight to be answered, and closes its MQTT clients and
   * databases only after them, so a request waiting on the engine still gets the engine's reply. A
   * shutdown still running SHUTDOWN_TIMEOUT_MS (10 s) after the signal exits with code 1. The harness
   * sets neither variable, so dmi-api runs with both defaults (its src/config/configuration.ts).
   *
   * What this asserts is that the answer arrives during the drain, and that dmi-api exits within the
   * bound dmi-api#399 promises, SHUTDOWN_TIMEOUT_MS after the signal; not whether it exits by the
   * signal or by the deadline.
   *
   * The request held in flight is a device lookup: one provider call, which the integration gives
   * IDEXX_HTTP_TIMEOUT_MS (30 s) and dmi-api ENGINE_RESPONSE_TIMEOUT (10 s here). A placement would
   * not do: its create is capped at IDEXX_CREATE_ORDER_TIMEOUT_MS (5 s, docker-compose.yml), and its
   * other calls share dmi-api's 10 s with the hold. The mock holds the device list for 7 s, so the
   * answer comes after dmi-api has stopped listening (about 4 s after the signal, which is sent once
   * the held call is at the mock) and inside both timeouts.
   *
   * Last in the describe: it stops dmi-api, which the restore (in the test's `finally`, and again in
   * afterEach) starts again before anything else runs. */
  it('a SIGTERM lets a device lookup in flight finish with its answer, and dmi-api exits within SHUTDOWN_TIMEOUT_MS (dmi-api#399)', async () => {
    const faults = serviceFaults()
    const app = appEnv()
    const engineTimeoutMs = Number(app.ENGINE_RESPONSE_TIMEOUT)
    const shutdownDelayMs = Number(app.SHUTDOWN_DELAY_MS ?? 4_000)
    const shutdownTimeoutMs = Number(app.SHUTDOWN_TIMEOUT_MS ?? 10_000)
    const httpTimeoutMs = Number(process.env.HARNESS_IDEXX_HTTP_TIMEOUT_MS || 30_000)
    const holdMs = 7_000
    /* Refused at once, saying why, when the numbers cannot show the drain: the answer must come at
     * least a second after dmi-api stops listening, and a second before any timeout. */
    if (!(holdMs >= shutdownDelayMs + 2_000 && holdMs + 1_000 <= Math.min(engineTimeoutMs, shutdownTimeoutMs, httpTimeoutMs))) {
      throw new Error(
        `a ${holdMs} ms hold cannot show the drain with SHUTDOWN_DELAY_MS=${shutdownDelayMs}, SHUTDOWN_TIMEOUT_MS=${shutdownTimeoutMs}, ` +
          `ENGINE_RESPONSE_TIMEOUT=${engineTimeoutMs} and IDEXX_HTTP_TIMEOUT_MS=${httpTimeoutMs}`,
      )
    }
    type Hold = { hits: number, open: number, requests: Array<{ outcome: string, ms: number | null }> }
    const dmiApiBefore = runningDmiApi()

    const armed = expectOk<{ fault: { id: number } }>(
      await mock.post('/__control__/scenarios', { key: 'ivlsDevices', fault: 'hold', delayMs: holdMs }),
      'hold the next device list at the mock',
    )
    let hold: Hold | null = null
    let answer: { status?: number, body?: unknown, error?: string, at: number } | undefined
    let probe: { listening: boolean, answeredYet: boolean } | undefined
    let exit: Awaited<ReturnType<typeof faults.stopDmiApi>> | undefined
    let signalledAt = 0
    try {
      const inFlight = org.api.get(`/providers/idexx/devices?integrationId=${org.integrationId}`).then(
        (response) => ({ status: response.status, body: response.body, at: Date.now() }),
        (error) => ({ error: `${String(error)}${error?.cause != null ? ` (${String(error.cause)})` : ''}`, at: Date.now() }),
      )
      /* In flight: the integration's call has reached the mock, which holds it. */
      const open = await pollUntil(
        async () => expectOk<{ faults: Record<string, Hold> }>(await mock.get('/__control__/scenarios'), 'list what is armed at the mock').faults.ivlsDevices?.open,
        (count) => count === 1,
        engineTimeoutMs,
        100,
      )
      if (open !== 1) throw new Error('the hold at the mock never took the device lookup')

      signalledAt = Date.now()
      const exiting = faults.stopDmiApi('SIGTERM')
      let settled = false
      void inFlight.then(() => { settled = true })
      /* A second after the delay, whether dmi-api still takes new connections, and whether the held
       * lookup has been answered yet. */
      probe = await sleep(shutdownDelayMs + 1_000).then(async () => ({ listening: await appPortInUse(), answeredYet: settled }))
      answer = await inFlight
      exit = await exiting
    } finally {
      hold = expectOk<{ fault: Hold | null }>(
        await mock.delete(`/__control__/scenarios/ivlsDevices?id=${armed.fault.id}`),
        'disarm the device-list hold',
      ).fault
      await faults.restore(DMI_API)
    }
    console.log(`[idexx-scenario] SIGTERM with a lookup in flight -> answer ${JSON.stringify({ ...answer, at: (answer?.at ?? 0) - signalledAt })}, probe ${JSON.stringify(probe)}, exit ${JSON.stringify(exit)}, hold ${JSON.stringify(hold)}`)

    /* THE POINT OF THIS TEST: the lookup in flight got its normal answer, the clinic's analyzer. */
    expect({ status: answer?.status, error: answer?.error, devices: answer?.body }).toEqual({
      status: 200,
      error: undefined,
      devices: [{ serialNumber: deviceSerial, status: 'ACTIVE', name: 'VetLab Station (mock)' }],
    })
    /* The hold fired: it took the one lookup, and its answer went out (a hold still open when the
     * test disarms it is destroyed instead). */
    expect({ hits: hold?.hits, outcomes: hold?.requests.map((request) => request.outcome) }).toEqual({ hits: 1, outcomes: ['answered'] })
    /* And it was still in flight when dmi-api had stopped taking connections: the answer came during
     * the drain, not during the delay. */
    expect(probe).toEqual({ listening: false, answeredYet: false })
    /* dmi-api exited after the answer, and within SHUTDOWN_TIMEOUT_MS of the signal: the second
     * allowed past it is for an exit at the deadline to reach this process (which way it exits is
     * not asserted; see above). */
    expect({
      exited: exit != null,
      withinShutdownTimeout: exit != null && exit.exitedAfterMs <= shutdownTimeoutMs + 1_000,
      afterTheAnswer: exit != null && answer != null && signalledAt + exit.exitedAfterMs >= answer.at - 50,
    }).toEqual({ exited: true, withinShutdownTimeout: true, afterTheAnswer: true })

    /* Started again, and healthy, before anything else runs. */
    const dmiApiAfter = runningDmiApi()
    const health = await ApiClient.create().get('/health').then((response) => response.status, (error) => String(error))
    expect({ restarted: dmiApiAfter != null && dmiApiAfter.pid !== dmiApiBefore?.pid, health }).toEqual({ restarted: true, health: 200 })
  }, 60_000 + 30_000)

  afterAll(async () => {
    try {
      await restoreServices()
    } finally {
      if (admin != null && org?.integrationId != null) {
        await admin.post(`/admin/integrations/${org.integrationId}/stop`).catch(() => undefined)
      }
      await closePool()
    }
  }, 180_000)
})
