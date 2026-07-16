'use strict'

/* VetConnect Plus (IDEXX) mock vendor for the dmi-e2e full-stack harness. A zero-dependency Node
 * HTTP server that speaks IDEXX's public, documented dialect closely enough for the REAL
 * `dmi-engine-idexx-integration` container to drive it: ordering (`/api/v1/*`), the confirmOrder
 * browser handshake (`/ui` -> HTML+cookie -> XHR PUT), and results (`/api/v3/*`, latest-batch poll
 * + confirm/ack + search). A separate control plane (`/__control__/*`) lets tests seed results,
 * inspect received orders and inject error scenarios so the order->result->report loop is
 * deterministic and CI-safe. It NEVER talks to real IDEXX and never authenticates for real; the
 * integration's dummy Basic credentials and X-Pims-* headers are accepted as-is. All canned data is
 * SYNTHETIC — invented values shaped like IDEXX responses, never captured clinic/patient data. The
 * contract mirrored here was read from the integration's own source (endpoints, header names, the
 * confirmOrder transform, and the poll/ack shapes), not assumed. */

const http = require('http')
const crypto = require('crypto')

const PORT = Number(process.env.PORT || 3000)
/* Origin baked into the uiURL and pdf/result links the mock hands back. The integration fetches
 * these from inside the compose network, so it must resolve there; we derive it from the incoming
 * request's Host header by default (whatever host the integration used to reach us), and allow an
 * explicit override for odd setups. */
const ORIGIN_OVERRIDE = process.env.VCP_MOCK_ORIGIN || ''

/* Monotonic idexx order id, seeded from process start time so every order gets a GLOBALLY-unique
 * externalId — even across control-plane resets and across container restarts against a warm dmi-api
 * database. dmi-api correlates results to orders by externalId; if two runs reused the same id, a
 * result could reconcile into a stale prior-run order. It stays a valid numeric-string id (< 2^53).
 * This lives outside the resettable state on purpose: /__control__/reset must not rewind it. */
let nextOrderId = Date.now()

function log (message) {
  /* One-line, greppable, prefixed like the harness's other services. */
  console.log(`[vcp-mock] ${message}`)
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
    ivls: null,
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
    patient: {
      patientId: patient.patientId || '',
      name: patient.name || 'Rex',
      clientId: client.id || '',
      clientFirstName: client.firstName || '',
      clientLastName: client.lastName || '',
      genderName: 'Male',
      speciesCode: patient.speciesCode || 'CANINE',
      speciesName: 'Canine',
      breedName: patient.breedCode || 'Labrador Retriever',
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
        ivlsSerialNumber: 'VCPMOCK0001',
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
   * not through the vendor UI, so this poll is intentionally empty (the integration treats an empty
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
    tests: tests.length > 0 ? tests : [{ code: 'SA', sd: 'ALL' }],
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

function handleControlListOrders (req, res) {
  const orders = [...state.orders.values()].map((order) => ({
    idexxOrderId: order.idexxOrderId,
    corporateRequisitionId: order.corporateRequisitionId,
    status: order.status,
    receivedAt: order.receivedAt,
    confirmedAt: order.confirmedAt,
    tests: order.tests,
  }))
  sendJson(res, 200, { count: orders.length, orders })
}

function handleControlGetOrder (req, res, params) {
  const idexxOrderId = state.requisitionToOrderId.get(params.requisitionId)
  const order = idexxOrderId != null ? state.orders.get(idexxOrderId) : undefined
  if (order == null) {
    sendJson(res, 404, { message: `no order for requisitionId ${params.requisitionId}` })
    return
  }
  sendJson(res, 200, {
    idexxOrderId: order.idexxOrderId,
    corporateRequisitionId: order.corporateRequisitionId,
    status: order.status,
    receivedAt: order.receivedAt,
    confirmedAt: order.confirmedAt,
    tests: order.tests,
  })
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
  ['GET', /^\/status$/, (req, res) => sendJson(res, 200, { status: 'ok', service: 'vcp-mock' })],
  ['GET', /^\/health$/, (req, res) => sendJson(res, 200, { status: 'ok' })],

  ['GET', /^\/api\/v1\/auth\/validate$/, handleAuthValidate],
  ['POST', /^\/api\/v1\/order$/, handleCreateOrder],
  ['GET', /^\/api\/v1\/order\/(?<id>[^/]+)$/, handleGetOrder],
  ['DELETE', /^\/api\/v1\/order\/(?<id>[^/]+)$/, handleDeleteOrder],
  ['GET', /^\/api\/v1\/orders\/external$/, handleExternalOrders],
  ['GET', /^\/api\/v1\/ref\/breeds$/, (req, res) =>
    sendJson(res, 200, refList([{ code: 'LABRADOR', name: 'Labrador Retriever', speciesCode: 'CANINE' }]))],
  ['GET', /^\/api\/v1\/ref\/genders$/, (req, res) =>
    sendJson(res, 200, refList([{ code: 'MALE', name: 'Male' }, { code: 'FEMALE', name: 'Female' }]))],
  ['GET', /^\/api\/v1\/ref\/species$/, (req, res) =>
    sendJson(res, 200, refList([{ code: 'CANINE', name: 'Canine' }, { code: 'FELINE', name: 'Feline' }]))],
  ['GET', /^\/api\/v1\/ref\/tests$/, (req, res) =>
    sendJson(res, 200, refList([{ code: 'SA', name: 'Small Animal Panel', listPrice: '45.00', currencyCode: 'USD', inHouse: false }]))],
  ['GET', /^\/api\/v1\/ivls\/devices$/, (req, res) => sendJson(res, 200, { ivlsDeviceList: [] })],

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
