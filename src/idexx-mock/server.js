'use strict'

/* VetConnect Plus (IDEXX) mock provider for the dmi-e2e full-stack harness. A zero-dependency Node
 * HTTP server that speaks IDEXX's public, documented dialect closely enough for the REAL
 * `dmi-engine-idexx-integration` container to drive it: ordering (`/api/v1/*`), the confirmOrder
 * browser handshake (`/ui` -> HTML+cookie -> XHR PUT), and results (`/api/v3/*`, latest-batch poll
 * + confirm/ack + search). A separate control plane (`/__control__/*`) lets tests seed results,
 * inspect received orders and inject error scenarios so the order->result->report loop is
 * deterministic and CI-safe. It NEVER talks to real IDEXX and never authenticates for real; the
 * integration's dummy Basic credentials and X-Pims-* headers are accepted as-is.
 *
 * Data: every patient, client, veterinarian and clinic identifier here is INVENTED — no captured
 * clinic or patient data, ever. Provider vocabulary (analyte numbers, analyzer and test codes,
 * species-level reference ranges) is taken from IDEXX's own catalogue and specs so the payloads are
 * shaped like the real thing; that is product/catalogue data, not anyone's record.
 *
 * The contract mirrored here was read from the integration's own source (endpoints, header names,
 * the confirmOrder transform, and the poll/ack shapes), not assumed. */

const http = require('http')
const crypto = require('crypto')

const PORT = Number(process.env.PORT || 3000)
/* Origin baked into the uiURL and pdf/result links the mock hands back. The integration fetches
 * these from inside the compose network, so it must resolve there; we derive it from the incoming
 * request's Host header by default (whatever host the integration used to reach us), and allow an
 * explicit override for odd setups. */
const ORIGIN_OVERRIDE = process.env.IDEXX_MOCK_ORIGIN || ''

/* Monotonic idexx order id, seeded from process start time so every order gets a GLOBALLY-unique
 * externalId — even across control-plane resets and across container restarts against a warm dmi-api
 * database. dmi-api correlates results to orders by externalId; if two runs reused the same id, a
 * result could reconcile into a stale prior-run order. It stays a valid numeric-string id (< 2^53).
 * This lives outside the resettable state on purpose: /__control__/reset must not rewind it. */
let nextOrderId = Date.now()

/* The one IVLS analyzer this clinic owns. Advertised by `/api/v1/ivls/devices`, required on every
 * in-house order (see validateCreateOrder), and stamped on every result's run summary — one constant
 * so the device an order names, the device the provider lists and the device a result came from are the
 * same serial by construction. Invented; not a real analyzer's serial. */
const IVLS_DEVICE_SERIAL = 'VCPMOCK0001'

function log (message) {
  /* One-line, greppable, prefixed like the harness's other services. */
  console.log(`[idexx-mock] ${message}`)
}

function uuid () {
  return crypto.randomUUID()
}

function nowIso () {
  return new Date().toISOString()
}

/* ---- in-memory state (reset via POST /__control__/reset) ---- */

function freshState () {
  return {
    /* idexxOrderId (string) -> order record. */
    orders: new Map(),
    /* corporateRequisitionId -> idexxOrderId, so tests can seed a result by the requisitionId they
     * placed the order with (without first reading dmi-api's stored externalId). */
    requisitionToOrderId: new Map(),
    /* Every result seeded through the control plane, in arrival order. `confirmed` flips once the
     * integration acks the batch it was served in, after which /api/v3/results/latest omits it. */
    results: [],
    /* The batch currently being served by /api/v3/results/latest, cached so repeated polls before
     * the ack return a stable batchId (the integration acks exactly that id). */
    activeBatch: null,
    /* Error/edge injection: { [key]: { status, body } }. Keys are logical operation names, e.g.
     * 'createOrder', 'resultsLatest', 'authValidate'. */
    scenarios: {},
  }
}

let state = freshState()

/* ---- http helpers ---- */

function sendJson (res, status, body, extraHeaders) {
  const payload = JSON.stringify(body ?? {})
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...(extraHeaders || {}),
  })
  res.end(payload)
}

function sendHtml (res, status, html, extraHeaders) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    ...(extraHeaders || {}),
  })
  res.end(html)
}

function readBody (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error.message}`))
      }
    })
    req.on('error', reject)
  })
}

function originFor (req) {
  if (ORIGIN_OVERRIDE !== '') return ORIGIN_OVERRIDE.replace(/\/+$/, '')
  const host = req.headers.host || `localhost:${PORT}`
  return `http://${host}`
}

/* An injected scenario for `key` short-circuits the handler with a canned status/body. Cleared once
 * consumed when `once` is set, so a test can inject a single transient failure. */
function takeScenario (key) {
  const scenario = state.scenarios[key]
  if (scenario == null) return null
  if (scenario.once) delete state.scenarios[key]
  return scenario
}

/* ---- IDEXX response builders (SYNTHETIC data) ---- */

/* The create-order response the integration expects (`IdexxOrder`). `uiURL` points back at this
 * mock so the confirmOrder browser flow lands here; `pdfURL` is intentionally omitted so the
 * integration skips the binary manifest fetch (kept simple — the loop doesn't need a PDF). */
function buildOrderResponse (order, origin) {
  return {
    idexxOrderId: order.idexxOrderId,
    corporateRequisitionId: order.corporateRequisitionId,
    editable: true,
    status: order.status,
    uiURL: `${origin}/ui?token=${order.uiToken}&orderId=${order.idexxOrderId}`,
    veterinarian: order.veterinarian,
    patients: order.patients,
    tests: order.tests,
    /* Echoed from the request, never invented: an in-house order that arrived without a device was
     * already rejected, so this is only ever what the integration actually sent. */
    ivls: order.ivls,
    prevRefNum: null,
    notes: order.notes ?? '',
    technician: order.technician ?? null,
  }
}

/* Default synthetic result for an order: one Chemistry panel with NUMERIC analytes that exercise
 * every branch the scenario asserts — a value + units (valueQuantity), reference ranges, and an
 * out-of-range interpretation. Invented values; not captured from any clinic. */
function defaultCategories () {
  const runSummaryId = uuid()
  return [
    {
      categoryId: 2,
      code: 'Chemistry',
      name: 'Chemistry',
      notes: [],
      tests: [
        {
          runSummaryId,
          analyte: '8058',
          code: 'GLU',
          name: 'Glucose',
          result: '150',
          resultType: 'NUMERIC',
          status: 'COMPLETE',
          qualifier: '',
          outOfRange: true,
          outOfRangeCode: 'H',
          referenceRange: '74 - 143 mg/dL',
          low: 74,
          high: 143,
          criticalLow: 15,
          criticalHigh: 700,
          units: 'mg/dL',
          notes: [],
        },
        {
          runSummaryId,
          analyte: '8072',
          code: 'CREA',
          name: 'Creatinine',
          result: '1.2',
          resultType: 'NUMERIC',
          status: 'COMPLETE',
          qualifier: '',
          outOfRange: false,
          referenceRange: '0.5 - 1.8 mg/dL',
          low: 0.5,
          high: 1.8,
          criticalLow: 0,
          criticalHigh: 5,
          units: 'mg/dL',
          notes: [],
        },
      ],
    },
  ]
}

/* Assemble an `IdexxResult` (the shape inside /api/v3/results/latest `results[]`). `orderId` is the
 * numeric idexx order id assigned at create time; the integration stringifies it and dmi-api
 * correlates it to the order's stored externalId. `requisitionId` carries the harness's original id
 * as a second correlation key. Patient/vet fields echo the placed order so the report reads
 * coherently. */
function buildResult (order, overrides) {
  const opts = overrides || {}
  const patient = order.patients[0] || {}
  const client = patient.client || {}
  return {
    resultId: `vcp.${uuid()}`,
    orderId: Number(order.idexxOrderId),
    requisitionId: order.corporateRequisitionId,
    diagnosticSetId: `${order.idexxOrderId}-set`,
    accessionId: order.idexxOrderId,
    modality: 'REFLAB',
    status: opts.status || 'COMPLETE',
    orderReceivedDate: order.receivedAt,
    specimenCollectionDate: order.receivedAt,
    updatedDate: nowIso(),
    updatedAuditDate: nowIso(),
    veterinarian: order.veterinarian || '',
    /* Echoed straight back from the placed order, never defaulted: dmi-api reconciles the result to
     * its order on these fields, so inventing one here would let a broken integration reconcile
     * against the mock's imagination. handleCreateOrder rejects an order that omits them. */
    patient: {
      patientId: patient.patientId || '',
      name: patient.name,
      clientId: client.id || '',
      clientFirstName: client.firstName,
      clientLastName: client.lastName,
      /* IDEXX results carry NAMES for sex/species/breed where the order carried CODES. The codes
       * arrive as whatever dmi-api's idexx ref mapping produced (IDEXX's own vocabulary when mapped,
       * the raw dmi code when not); the names are IDEXX's labels for the codes this mock knows, so
       * the result document agrees with the order it answers. A code outside the maps is echoed as
       * its own label — never invented, never rejected: the SCENARIO pins the mapped values. */
      genderName: GENDER_NAMES[patient.genderCode] ?? String(patient.genderCode ?? ''),
      speciesCode: patient.speciesCode,
      speciesName: SPECIES_NAMES[patient.speciesCode] ?? String(patient.speciesCode),
      breedName: BREED_NAMES[patient.breedCode] ?? String(patient.breedCode ?? ''),
      age: 3,
      yearOfBirth: '2021',
    },
    categories: opts.categories || defaultCategories(),
    runSummaries: [
      {
        id: uuid(),
        code: 'Catalyst_Dx',
        name: 'Catalyst Dx Chemistry Analyzer',
        runDate: nowIso(),
        sampleType: 'Serum',
        ivlsSerialNumber: IVLS_DEVICE_SERIAL,
      },
    ],
    notes: {},
    delayStatus: { delayed: false, notificationPdfUrl: '' },
  }
}

/* Minimal reference-data list wrapper (`getBreeds`/`getSpecies`/`getSexes`/`getServices` read
 * `{ list, version }`). Synthetic entries; only exercised if dmi-api requests a ref sync. */
function refList (items) {
  return { version: '1', list: items }
}

/* IDEXX's own reference vocabulary for the codes the harness's orders carry — the same codes
 * dmi-api's migrations map its canonical refs to for this provider. Served by `/api/v1/ref/*` and
 * used to label results (see buildResult). Genuine catalogue identifiers, not anyone's data. */
const SPECIES_NAMES = { CANINE: 'Canine', FELINE: 'Feline' }
const GENDER_NAMES = {
  MALE_INTACT: 'Male',
  MALE_NEUTERED: 'Male Neutered',
  FEMALE_INTACT: 'Female',
  FEMALE_SPAYED: 'Female Spayed',
  UNKNOWN: 'Unknown',
}
const BREED_NAMES = { LABRADOR_RETRIEVER: 'Labrador Retriever' }

/* The orderable-test catalogue, and the ONLY definition of it: `/api/v1/ref/tests` advertises this
 * list and order placement enforces it, the way live IDEXX does (an unknown code is rejected with
 * INVALID_LAB_SERVICE_ID). A mock that advertises a catalogue but accepts anything cannot catch an
 * integration that sends a malformed or stale code.
 *
 * `IHD_DHP` is a real IDEXX in-house code from the provider's own reference-data catalogue. Shape
 * matters: the placeholder here used to be `SA`, which is not an IDEXX code in any form.
 *
 * `inHouse` is load-bearing since the integration started reading this catalogue to decide device
 * inclusion (its issue #76): an order containing any `inHouse: true` code must carry an IVLS device,
 * and an order of only reference-lab codes must not. The integration fetches this list once per
 * integration and caches it in Redis, so the flag here is what it classifies the harness's orders
 * by — and placement below enforces the same rule the real provider does, so the two cannot drift
 * apart silently.
 *
 * `2212` is a real IDEXX reference-lab code: an order for it was placed and confirmed on IDEXX's
 * development endpoint while this harness was being built, and the name is the one that catalogue
 * returned (the list price here is illustrative). It is here so the OTHER half of the rule executes:
 * an order of only reference-lab codes has its devices stripped by the integration before placement.
 * The scenario picks each code by its flag, never by position. */
const SERVICE_CATALOGUE = [
  {
    code: 'IHD_DHP',
    name: 'IDEXX VetLab Station Diagnostic Health Profile',
    listPrice: '45.00',
    currencyCode: 'USD',
    inHouse: true,
  },
  {
    code: '2212',
    name: 'Chemistry Panel 1—Canine',
    listPrice: '100.00',
    currencyCode: 'USD',
    inHouse: false,
  },
]
const SERVICE_CODES = new Set(SERVICE_CATALOGUE.map((service) => service.code))

function isBlank (value) {
  return value === undefined || value === null || String(value).trim() === ''
}

/* IDEXX's error envelope (`ErrorResponse` -> `{ errors: [{ errorCode, message, index? }] }`). The
 * field is `errorCode`, not `code`: the integration's own providerErrorMapper reads
 * `providerError.errorCode` (and its IDEXX-captured fixtures carry that name), so emitting `code`
 * here renders every rejection as "undefined error in idexx: ..." — legible enough to debug by
 * accident, but it leaves the mapper's real branch unexercised by the gate.
 *
 * A refused order is answered the way the live endpoint answers one — observed on IDEXX's
 * development endpoint and in the integration's captured fixtures: a leading INVALID_ORDER entry
 * ("see data for field level details"), then one entry per problem, the field-level ones carrying
 * `index` (the position in the array the field belongs to). The mapper branches on `index`, so the
 * shape, not just the codes, is what it gets exercised against. */
const INVALID_ORDER = { errorCode: 'INVALID_ORDER', message: 'Invalid order, see data for field level details' }

function sendInvalidOrder (res, problems) {
  for (const { errorCode, message } of problems) log(`rejected: ${errorCode} — ${message}`)
  sendJson(res, 400, { errors: [INVALID_ORDER, ...problems] })
}

/* What a create-order payload must carry for the mock to accept it. Returns the field-level
 * problems (empty when the order is acceptable).
 *
 * This mock VALIDATES rather than defaults, on purpose. Silently filling in a missing field is the
 * most dangerous thing a provider mock can do: dmi-api reconciles a provider result back to its order
 * on patient name (+ PIMS patient id, + client last name), so a mock that invents the patient it was
 * not sent will also satisfy reconciliation — and an integration that stopped forwarding the patient
 * would leave this gate permanently green. Age and weight are genuinely optional on an IDEXX order
 * and keep their fallbacks.
 *
 * The codes are IDEXX's own: its PIMS Ordering API spec enumerates a per-field MISSING_* family
 * (MISSING_PATIENT, MISSING_VETERINARIAN, MISSING_TESTS, MISSING_IVLS_SERIAL_NUMBER, ...) and has no
 * generic "required field" code, so a refusal here names the field the way the provider would. The
 * spec's enum stops at the patient as a whole — it lists no code for a patient that arrived without
 * a name or species, though the provider's live vocabulary is broader than the spec's list — so an
 * incomplete patient is MISSING_PATIENT with the message naming what is absent. `index` is carried
 * where the live endpoint was seen to carry it (an offending test, by its position) and, by the same
 * convention, on the other array-member problems; the scalar ones carry none. dmi-api validates
 * every required field itself before the order reaches the engine, so the MISSING_* refusals are
 * only ever reached by an integration that dropped a field it was given; the catalogue refusal is
 * reachable end to end and the scenario exercises it. */
function validateCreateOrder (payload) {
  const patient = Array.isArray(payload.patients) ? payload.patients[0] : undefined
  const problems = []
  if (patient === undefined) {
    problems.push({ errorCode: 'MISSING_PATIENT', message: 'patients[0] is required' })
  } else {
    const absent = []
    if (isBlank(patient.name)) absent.push('name')
    if (isBlank(patient.speciesCode)) absent.push('speciesCode')
    if (isBlank(patient.client?.lastName)) absent.push('client.lastName')
    if (absent.length > 0) {
      problems.push({ errorCode: 'MISSING_PATIENT', message: `patients[0] is incomplete: missing ${absent.join(', ')}`, index: 0 })
    }
  }
  if (isBlank(payload.veterinarian)) {
    problems.push({ errorCode: 'MISSING_VETERINARIAN', message: 'veterinarian is required' })
  }
  if (!Array.isArray(payload.tests) || payload.tests.length === 0) {
    problems.push({ errorCode: 'MISSING_TESTS', message: 'tests is required and must not be empty' })
  }
  if (problems.length > 0) return problems

  const unknownAt = payload.tests.findIndex((code) => !SERVICE_CODES.has(String(code)))
  if (unknownAt !== -1) {
    const unknown = payload.tests.filter((code) => !SERVICE_CODES.has(String(code)))
    return [{ errorCode: 'INVALID_LAB_SERVICE_ID', message: `unknown test code(s): ${unknown.join(', ')}`, index: unknownAt }]
  }

  /* The device rule, from the provider's side. Live IDEXX cannot run an in-house test without knowing
   * which analyzer to run it on, so an in-house order without an `ivls` device is refused. The
   * integration now enforces the same rule before the request ever leaves it (issue #76) — which is
   * exactly why the mock must enforce it too: a mock that accepted a device-less in-house order would
   * let a regression in the integration's rule (or someone flipping IDEXX_DEVICE_RULE_ENABLED off in
   * the compose file) leave this gate green. The serial must also be one this clinic owns: the only
   * proof that the device dmi-api was given is the device the provider received. The device-less
   * refusal uses MISSING_IVLS_SERIAL_NUMBER, straight from the errorCode list in IDEXX's own PIMS
   * Ordering API spec (the per-field family above); the foreign-serial code has no counterpart in
   * that list and is extrapolated — the refusals themselves, not the codes, are the contract there.
   *
   * The OTHER half of the rule is deliberately NOT enforced here: whether live IDEXX tolerates a
   * device on an all-reference-lab order has never been probed, so a refusal would be the mock's
   * invention. A device on a reference-lab order is accepted and echoed, and the scenario pins at
   * the control plane that none arrived — the integration is supposed to have stripped it. */
  const inHouse = payload.tests.filter(
    (code) => SERVICE_CATALOGUE.find((service) => service.code === String(code))?.inHouse === true,
  )
  const serials = (Array.isArray(payload.ivls) ? payload.ivls : [])
    .map((device) => device?.serialNumber)
    .filter((serial) => !isBlank(serial))
  if (inHouse.length > 0 && serials.length === 0) {
    return [{
      errorCode: 'MISSING_IVLS_SERIAL_NUMBER',
      message: `in-house test(s) ${inHouse.join(', ')} require an ivls device, and none was sent`,
    }]
  }
  const foreignAt = serials.findIndex((serial) => serial !== IVLS_DEVICE_SERIAL)
  if (foreignAt !== -1) {
    const foreign = serials.filter((serial) => serial !== IVLS_DEVICE_SERIAL)
    return [{
      errorCode: 'INVALID_IVLS_DEVICE',
      message: `unknown ivls serial number(s): ${foreign.join(', ')} (this clinic owns ${IVLS_DEVICE_SERIAL})`,
      index: foreignAt,
    }]
  }

  return []
}

/* ---- ordering handlers (/api/v1) ---- */

async function handleAuthValidate (req, res) {
  const scenario = takeScenario('authValidate')
  if (scenario != null) {
    sendJson(res, scenario.status, scenario.body ?? { message: 'auth failed' })
    return
  }
  /* The integration sends HTTP Basic + X-Pims-Id/X-Pims-Version; we accept any non-empty Basic
   * header rather than verifying credentials (the harness's creds are deliberately dummy). */
  const hasBasic = String(req.headers.authorization || '').toLowerCase().startsWith('basic ')
  if (!hasBasic) {
    sendJson(res, 401, { valid: false, message: 'missing Basic credentials' })
    return
  }
  sendJson(res, 200, { valid: true })
}

async function handleCreateOrder (req, res) {
  const scenario = takeScenario('createOrder')
  if (scenario != null) {
    sendJson(res, scenario.status, scenario.body ?? { message: 'create order failed' })
    return
  }

  const payload = await readBody(req)

  const problems = validateCreateOrder(payload)
  if (problems.length > 0) {
    sendInvalidOrder(res, problems)
    return
  }

  const idexxOrderId = String(nextOrderId++)
  const corporateRequisitionId =
    payload.corporateRequisitionId != null && payload.corporateRequisitionId !== ''
      ? String(payload.corporateRequisitionId)
      : `VCP-${idexxOrderId}`

  const order = {
    idexxOrderId,
    corporateRequisitionId,
    uiToken: uuid().replace(/-/g, ''),
    /* CREATED maps to WAITING_FOR_INPUT in the integration until confirmOrder submits it; the
     * confirmOrder PUT flips this to SUBMITTED. */
    status: 'CREATED',
    patients: Array.isArray(payload.patients) ? payload.patients : [],
    tests: Array.isArray(payload.tests) ? payload.tests : [],
    veterinarian: payload.veterinarian || '',
    /* Validated above; stored verbatim (serial only, the way the integration sends it). */
    ivls: Array.isArray(payload.ivls) ? payload.ivls.map((device) => ({ serialNumber: device.serialNumber })) : null,
    technician: payload.technician || null,
    notes: payload.notes || '',
    receivedAt: nowIso(),
    confirmedAt: null,
  }
  state.orders.set(idexxOrderId, order)
  state.requisitionToOrderId.set(corporateRequisitionId, idexxOrderId)
  log(`created order idexxOrderId=${idexxOrderId} corporateRequisitionId=${corporateRequisitionId}`)

  sendJson(res, 200, buildOrderResponse(order, originFor(req)))
}

async function handleGetOrder (req, res, params) {
  const order = state.orders.get(params.id)
  if (order == null) {
    sendJson(res, 404, { code: '404', message: 'Order not found' })
    return
  }
  sendJson(res, 200, buildOrderResponse(order, originFor(req)))
}

async function handleDeleteOrder (req, res, params) {
  const order = state.orders.get(params.id)
  if (order != null) order.status = 'CANCELLED'
  sendJson(res, 200, { idexxOrderId: params.id, status: 'CANCELLED' })
}

async function handleExternalOrders (req, res) {
  /* PIMS-initiated orders the integration would pull in. The harness places orders through dmi-api,
   * not through the provider UI, so this poll is intentionally empty (the integration treats an empty
   * `orders` array as "nothing new"). */
  const now = nowIso()
  sendJson(res, 200, { timestamp: now, startDate: now, endDate: now, orders: [] })
}

/* ---- confirmOrder browser handshake (/ui) ---- */

function handleUiPage (req, res) {
  /* Step 1 of confirmOrder: the integration GETs uiURL and harvests Set-Cookie. The body is
   * irrelevant to it; the cookie is what matters (it replays it on the XHR GET/PUT). */
  const session = uuid().replace(/-/g, '')
  sendHtml(res, 200, '<!doctype html><title>VetConnect Plus (mock)</title><body>order setup</body>', {
    'set-cookie': `VCPSESSION=${session}; Path=/`,
  })
}

async function handleUiOrderGet (req, res, params) {
  /* Step 2: the integration GETs the order-setup payload it will transform and PUT back. It mutates
   * `notes.collectionDate` (so `notes` must be an object) and maps over `tests` (so `tests` must be
   * an array of `{ code, sd }`); the other fields it simply deletes. */
  const order = state.orders.get(params.orderId)
  const tests = (order?.tests || []).map((code) => ({ code: String(code), sd: 'ALL' }))
  sendJson(res, 200, {
    orderId: params.orderId,
    requisitionId: order?.corporateRequisitionId ?? '',
    labAccountId: 'VCPMOCK',
    status: 'CREATED',
    editable: true,
    webOrder: true,
    dosOrder: false,
    petOwnerBilling: false,
    requestModality: 'REFLAB',
    notes: { collectionDate: '' },
    /* The order's own tests, never a stand-in: a fabricated entry here would hide an integration
     * that dropped the test list between placement and confirmation. */
    tests,
    ivls: [],
  })
}

async function handleUiOrderPut (req, res, params) {
  /* Step 3: the integration PUTs the transformed order to submit it. We record the submission and
   * return an empty confirm response (no pdfURL, so the integration skips a manifest fetch). */
  await readBody(req)
  const order = state.orders.get(params.orderId)
  if (order != null) {
    order.status = 'SUBMITTED'
    order.confirmedAt = nowIso()
    log(`confirmed (submitted) order idexxOrderId=${params.orderId}`)
  }
  sendJson(res, 200, {})
}

/* ---- results handlers (/api/v3) ---- */

async function handleResultsLatest (req, res) {
  const scenario = takeScenario('resultsLatest')
  if (scenario != null) {
    sendJson(res, scenario.status, scenario.body ?? { message: 'results latest failed' })
    return
  }

  const pending = state.results.filter((entry) => !entry.confirmed)
  if (pending.length === 0) {
    /* No batchId + count 0 is the integration's "nothing to do" signal. */
    state.activeBatch = null
    sendJson(res, 200, { count: 0, hasMoreResults: false, results: [], timestamp: nowIso() })
    return
  }
  /* Cache the batch so repeat polls before the ack return the same id the integration will confirm. */
  if (state.activeBatch == null) {
    state.activeBatch = { batchId: crypto.randomBytes(16).toString('base64url'), entries: pending }
  }
  const batch = state.activeBatch
  sendJson(res, 200, {
    batchId: batch.batchId,
    count: batch.entries.length,
    hasMoreResults: false,
    timestamp: nowIso(),
    results: batch.entries.map((entry) => entry.idexx),
  })
}

async function handleResultsConfirm (req, res, params) {
  await readBody(req)
  const batch = state.activeBatch
  if (batch != null && batch.batchId === params.batchId) {
    for (const entry of batch.entries) entry.confirmed = true
    state.activeBatch = null
    log(`confirmed results batch ${params.batchId} (${batch.entries.length} result(s))`)
  }
  sendJson(res, 200, { batchId: params.batchId, confirmed: true })
}

async function handleResultsSearch (req, res, query) {
  const requisitionId = query.get('requisitionId')
  const matches = state.results
    .filter((entry) => entry.idexx.requisitionId === requisitionId)
    .map((entry) => entry.idexx)
  sendJson(res, 200, {
    start: 1,
    count: matches.length,
    hasMoreResults: false,
    results: matches,
  })
}

/* ---- control plane (/__control__) ---- */

async function handleControlSeedResult (req, res, params) {
  /* Seed a (synthetic) result for the order placed under `requisitionId`, making the next
   * results-latest poll deliver it. Body may override `status` or `categories`. Returns the
   * assembled IDEXX result so a test can assert on what it injected. */
  const body = await readBody(req)
  const requisitionId = params.requisitionId
  const idexxOrderId = state.requisitionToOrderId.get(requisitionId)
  if (idexxOrderId == null) {
    sendJson(res, 404, { message: `no order for requisitionId ${requisitionId}` })
    return
  }
  const order = state.orders.get(idexxOrderId)
  const idexx = buildResult(order, { status: body.status, categories: body.categories })
  state.results.push({ idexx, confirmed: false })
  /* A newly-seeded result forms a fresh batch on the next poll. */
  state.activeBatch = null
  log(`seeded result for requisitionId=${requisitionId} (idexxOrderId=${idexxOrderId})`)
  sendJson(res, 201, { seeded: true, requisitionId, idexxOrderId, result: idexx })
}

/* The control plane's view of a received order — the same shape from the list and the by-requisition
 * lookup. */
function controlOrderView (order) {
  const patient = order.patients[0] || {}
  return {
    idexxOrderId: order.idexxOrderId,
    corporateRequisitionId: order.corporateRequisitionId,
    status: order.status,
    receivedAt: order.receivedAt,
    confirmedAt: order.confirmedAt,
    tests: order.tests,
    /* The IVLS serial(s) the integration attached — or none, when it stripped them from an
     * all-reference-lab order — so the scenario can pin that the device the provider received is
     * exactly the one the rule says it should. */
    ivls: (order.ivls ?? []).map((device) => device.serialNumber),
    /* The patient's species/breed/sex codes exactly as the integration sent them, so the scenario
     * can pin that dmi-api's idexx ref mapping produced IDEXX's vocabulary and not the raw dmi codes. */
    speciesCode: patient.speciesCode,
    breedCode: patient.breedCode,
    genderCode: patient.genderCode,
  }
}

function handleControlListOrders (req, res) {
  const orders = [...state.orders.values()].map(controlOrderView)
  sendJson(res, 200, { count: orders.length, orders })
}

function handleControlGetOrder (req, res, params) {
  const idexxOrderId = state.requisitionToOrderId.get(params.requisitionId)
  const order = idexxOrderId != null ? state.orders.get(idexxOrderId) : undefined
  if (order == null) {
    sendJson(res, 404, { message: `no order for requisitionId ${params.requisitionId}` })
    return
  }
  sendJson(res, 200, controlOrderView(order))
}

async function handleControlScenario (req, res) {
  /* Inject a canned failure for a logical operation, e.g.
   * { "key": "createOrder", "status": 500, "body": {...}, "once": true }. */
  const body = await readBody(req)
  if (typeof body.key !== 'string') {
    sendJson(res, 400, { message: 'scenario requires a string "key"' })
    return
  }
  state.scenarios[body.key] = { status: body.status || 500, body: body.body, once: body.once === true }
  sendJson(res, 200, { ok: true, scenarios: Object.keys(state.scenarios) })
}

function handleControlReset (req, res) {
  state = freshState()
  log('state reset')
  sendJson(res, 200, { ok: true })
}

/* ---- router ---- */

/* Each route is [method, RegExp over the pathname, handler(req,res,params,query)]. Named capture
 * groups in the RegExp become `params`. Ordering-vs-results is by path prefix (/api/v1 vs /api/v3),
 * so a single origin serves both the orderingBaseUrl and resultBaseUrl the integration is given. */
const routes = [
  ['GET', /^\/status$/, (req, res) => sendJson(res, 200, { status: 'ok', service: 'idexx-mock' })],
  ['GET', /^\/health$/, (req, res) => sendJson(res, 200, { status: 'ok' })],

  ['GET', /^\/api\/v1\/auth\/validate$/, handleAuthValidate],
  ['POST', /^\/api\/v1\/order$/, handleCreateOrder],
  ['GET', /^\/api\/v1\/order\/(?<id>[^/]+)$/, handleGetOrder],
  ['DELETE', /^\/api\/v1\/order\/(?<id>[^/]+)$/, handleDeleteOrder],
  ['GET', /^\/api\/v1\/orders\/external$/, handleExternalOrders],
  ['GET', /^\/api\/v1\/ref\/breeds$/, (req, res) =>
    sendJson(res, 200, refList(Object.entries(BREED_NAMES).map(([code, name]) => ({ code, name, speciesCode: 'CANINE' }))))],
  ['GET', /^\/api\/v1\/ref\/genders$/, (req, res) =>
    sendJson(res, 200, refList(Object.entries(GENDER_NAMES).map(([code, name]) => ({ code, name }))))],
  ['GET', /^\/api\/v1\/ref\/species$/, (req, res) =>
    sendJson(res, 200, refList(Object.entries(SPECIES_NAMES).map(([code, name]) => ({ code, name }))))],
  ['GET', /^\/api\/v1\/ref\/tests$/, (req, res) => sendJson(res, 200, refList(SERVICE_CATALOGUE))],
  /* `IdexxIvlsDevice` as the integration's device mapper reads it (deviceSerialNumber,
   * vcpActivatedStatus, displayName). Nothing in the harness syncs devices yet; the list exists so
   * the clinic's one analyzer is advertised where the provider would advertise it. */
  ['GET', /^\/api\/v1\/ivls\/devices$/, (req, res) =>
    sendJson(res, 200, {
      ivlsDeviceList: [
        {
          deviceSerialNumber: IVLS_DEVICE_SERIAL,
          displayName: 'VetLab Station (mock)',
          lastPolledCloudTime: nowIso(),
          vcpActivatedStatus: 'ACTIVE',
        },
      ],
    })],

  ['GET', /^\/ui$/, handleUiPage],
  ['GET', /^\/ui\/order\/(?<orderId>[^/]+)$/, handleUiOrderGet],
  ['PUT', /^\/ui\/order\/(?<orderId>[^/]+)$/, handleUiOrderPut],

  ['GET', /^\/api\/v3\/results\/latest$/, handleResultsLatest],
  ['POST', /^\/api\/v3\/results\/latest\/confirm\/(?<batchId>[^/]+)$/, handleResultsConfirm],
  ['GET', /^\/api\/v3\/results\/search$/, (req, res, _params, query) => handleResultsSearch(req, res, query)],

  ['POST', /^\/__control__\/orders\/(?<requisitionId>[^/]+)\/results$/, handleControlSeedResult],
  ['GET', /^\/__control__\/orders$/, handleControlListOrders],
  ['GET', /^\/__control__\/orders\/(?<requisitionId>[^/]+)$/, handleControlGetOrder],
  ['POST', /^\/__control__\/scenarios$/, handleControlScenario],
  ['POST', /^\/__control__\/reset$/, handleControlReset],
]

const server = http.createServer(async (req, res) => {
  let url
  try {
    url = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`)
  } catch {
    sendJson(res, 400, { message: 'bad request URL' })
    return
  }
  const pathname = url.pathname.replace(/\/+$/, '') || '/'

  for (const [method, pattern, handler] of routes) {
    if (req.method !== method) continue
    const match = pattern.exec(pathname)
    if (match == null) continue
    try {
      await handler(req, res, match.groups || {}, url.searchParams)
    } catch (error) {
      log(`handler error on ${req.method} ${pathname}: ${error.stack || error}`)
      if (!res.headersSent) sendJson(res, 500, { message: String(error.message || error) })
    }
    return
  }
  sendJson(res, 404, { message: `no route for ${req.method} ${pathname}` })
})

server.listen(PORT, () => log(`listening on :${PORT}`))
