import { ApiClient, expectOk } from '../src/api-client'
import { env } from '../src/env'
import { pollUntil } from '../src/poll'
import { lookupRefCode } from '../src/refs'
import { adminLogin, orderPayload, OrderPayloadOverrides, seedOrganization, SeededOrg } from '../src/seed'
import { closePool } from '../src/sql'

/* Phase 0 full-system gate for IDEXX (HARNESS_FULL_STACK=1, HARNESS_STACK=idexx — the default):
 * dmi-api under a NORMAL NODE_ENV, wired over real MQTT/Bull/HTTP to the REAL
 * `dmi-engine-idexx-integration` container and a VetConnect Plus mock vendor (src/idexx-mock). It
 * drives the whole loop as an integrator would — configure the idexx provider pointed at the mock,
 * create an integration, start it, place an order over HTTP, let the mock produce a result, and
 * watch the order->result->report loop close — with every hop real except the vendor, which is the
 * mock so the run is deterministic and never touches live IDEXX.
 *
 * The order flows: POST /orders -> dmi-api RPCs `idexx/orders/create` to the integration -> the
 * integration POSTs the order to the mock's /api/v1/order and (autoSubmitOrder) runs the confirmOrder
 * browser handshake against the mock -> dmi-api stores the order with the mock's idexxOrderId as its
 * externalId. Then the integration's Bull results poll hits the mock's /api/v3/results/latest; once a
 * test seeds a result there, the integration maps it and emits `external_results` (-> report) and
 * `external_order_results` (-> order COMPLETED) back to dmi-api, then acks the batch. */

/* The three patient fields dmi-api ref-maps on the way to the vendor, as (canonical dmi ref name ->
 * the IDEXX code it must arrive as). idexx maps all three: species and sex to IDEXX's upper-case
 * mnemonics, breed to a breed mnemonic.
 *
 * dmi's canonical codes are opaque UUIDs, so each is looked up BY NAME over `GET /refs/*`
 * (src/refs.ts) and sent as the order's species/sex/breed; what must arrive at the mock is IDEXX's
 * vocabulary, pinned as literals here. Input and expected output are deliberately different values:
 * if the idexx provider_ref rows stopped resolving, mapPatientRefs falls back to forwarding the raw
 * code, the mock — which echoes species/breed/sex and does not validate them — stores the raw code,
 * and the value assertion below goes red naming it, instead of a well-formed order the real vendor
 * would reject.
 *
 * Which rows exist is a property of dmi-api's migrations, not of anything synced from the vendor —
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
   * orders are by construction ones the vendor advertises — and the mock rejects anything else. One
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
   * whole default and silently drop the `pims:patient:id` identifier this loop's reconciliation
   * depends on (see orderPayload). Without it dmi-api's matching guard sees a different patient id
   * on the result, reconciles it into a fresh orphan order, and this one stays SUBMITTED: a red
   * that looks like a broken result loop but is a broken payload. */
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
      expect(response.body.service).toBe('vcp-mock')
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
      /* The device dmi-api was given is the device the vendor received: the integration's include
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
       * on the way to the vendor, and they must arrive in IDEXX's vocabulary. Asserting the exact
       * mapped values is what makes a silently broken ref mapping fail here, naming the raw code
       * that got through, instead of producing a well-formed order the real vendor would reject.
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

      /* Scope to this order/report (a cold run has just this one; F1 means /events isn't tenant-
       * scoped, so filter explicitly rather than assume). */
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

  describe('the device rule, Exclude branch: a reference-lab-only order reaches the vendor without a device', () => {
    /* The loop above executes the rule's Include half (an in-house order must carry a device), and
     * there the mock enforces the vendor's side too. This is the OTHER half: the integration reads the
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
      /* THE POINT OF THIS TEST: the device dmi-api was given must NOT reach the vendor. `[]`, not
       * "falsy": a mock that fabricated a device here, or an integration that forwarded the one it
       * should have dropped, both fail naming the serial. */
      expect(received.ivls).toEqual([])
    })
  })

  describe("a refused order surfaces the vendor's error, not a generic fallback", () => {
    /* The happy path never touches the integration's error path. The mock answers a refused order
     * the way the live endpoint does — an INVALID_ORDER entry, then the field-level entries under
     * IDEXX's own codes — and the integration's providerErrorMapper reads that envelope's
     * `errorCode`/`message`/`index` and renders each entry into dmi-api's `errors[]`. These two tests
     * are what make the envelope's codes and shape non-decorative: renaming a code, or keying the
     * envelope `code` instead of `errorCode`, goes red here and nowhere else. */

    it('an order for a code outside the catalogue is refused end to end, naming the code', async () => {
      /* An unknown code takes the device rule's Passthrough branch (the integration forwards whatever
       * devices the PIMS sent), reaches the mock, and is refused there as INVALID_LAB_SERVICE_ID with
       * the code in the message — the one refusal dmi-api cannot intercept first, since it does not
       * know the vendor's catalogue. A separate order (its own requisitionId) that lands ERROR in
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
      /* The vendor's code and the mock's message both reach dmi-api's errors[], which proves the
       * mapper read the envelope. Its fallbacks must NOT fire: "… failed with <status> status code"
       * appears when the envelope is unreadable, "undefined error in idexx" when it is keyed `code`
       * instead of `errorCode`. */
      expect(response.text).toMatch(/INVALID_LAB_SERVICE_ID/)
      expect(response.text).toMatch(/NOT-A-REAL-IDEXX-CODE/)
      expect(response.text).not.toMatch(/failed with \d+ status code/)
      expect(response.text).not.toMatch(/undefined error in idexx/)
    }, 30_000)

    it("the mock refuses an empty order with IDEXX's per-field codes, under its INVALID_ORDER entry", async () => {
      /* Driven at the mock's vendor-facing API directly, the way the tests above read its catalogue
       * and device list: dmi-api validates every required field itself before an order reaches the
       * engine, so no path through the stack can make the integration send an empty order — these
       * refusals exist for an integration that drops a field it was given. This pins the vocabulary
       * and shape they would surface with, so a drift from the vendor's codes is visible somewhere. */
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
})
