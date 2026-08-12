'use strict'

/* Zoetis (VetSync v1) mock vendor for the dmi-e2e full-stack harness. A zero-dependency Node HTTP
 * server that speaks Zoetis's dialect closely enough for the REAL `dmi-engine-zoetis-integration`
 * container to drive it: Basic auth, single-POST order placement, the orders/results polls and BOTH
 * of its acknowledge channels, plus the reference-data endpoints. A separate control plane
 * (`/__control__/*`) lets tests seed results, inspect received orders and inject error scenarios so
 * the order->result->report loop is deterministic and CI-safe.
 *
 * It NEVER talks to a live Zoetis host and never authenticates for real. All canned data is SYNTHETIC — invented values shaped like Zoetis responses, never
 * captured clinic/patient data. The service and analyte codes are genuine Zoetis catalogue
 * identifiers (vendor codes published to integrators, not clinic or patient data); every name,
 * price, value and range attached to them here is invented.
 *
 * The contract mirrored here was read from the integration's own source (services/zoetis.service.ts,
 * helpers/zoetis-order.helper.ts, helpers/zoetis-responses.helper.ts, mappers/zoetis.mapper.ts,
 * interceptors/zoetis-api.interceptor.ts, providers/zoetis-*.processor.ts), not assumed. Details
 * that are load-bearing and easy to get wrong are called out at each handler.
 *
 * How Zoetis differs from the other two mocked vendors, since that is what shaped this file:
 *   - EVERYTHING is XML, in both directions, and the integration parses it with xmlbuilder2's
 *     `{ format: 'object' }`. Element MULTIPLICITY is therefore load-bearing in several places (see
 *     "the arity traps" below) — a lone child deserialises to an object, not a one-element array.
 *   - Order placement is a SINGLE POST (no login step as with Antech, no confirmOrder handshake as
 *     with IDEXX). The response is the order-status document.
 *   - There are TWO acknowledge channels: results are acked as a batch
 *     (POST /orders/batch/acknowledged), orders are acked one at a time by POSTing to the `href` of
 *     the order-status document's `acknowledged` link.
 *   - Auth is HTTP Basic with a domain-style username, `<partnerId>\<clientId>`.
 *
 * WHERE MULTIPLICITY IS LOAD-BEARING. xmlbuilder2's object format gives an object for a lone child
 * and an array for repeated ones, and the integration consumes these as arrays — so this mock always
 * emits at least two of each (verified against xmlbuilder2 2.4.1, the version the integration
 * resolves):
 *   - order-status `<link>`: read via `.link.find(...)` in acknowledgeOrders and `.link.filter(...)`
 *     in ZoetisMapper.getEditable.
 *   - `<LabResultItem>`: read via `LabResultItems.LabResultItem.filter(...)` in
 *     ZoetisMapper.mapLabResult. Hence >= 2 seeded analytes.
 *   - `<Section>` in the service catalogue: `DirectoryOfService.Section.map(...)`.
 *   - `<specie>` / `<gender>` / `<Device>`: `.map(...)` in getSpecies / getSexes / getDevices.
 * `<LabReport>` and `<LabResult>` need no such care — those two go through the mapper's
 * `objectOrArray` and read the same either way.
 *
 * The mirror image of the same rule: an EMPTY `<LabResults/>` is NOT equivalent to an absent one.
 * ZoetisMapper.getTests branches on `!labResults`, and `<LabResults/>` parses to `{}`, which is
 * truthy — so it goes on to read `LabResult` off it. An order with no results yet therefore omits
 * the element entirely rather than emitting it empty. */

const http = require('http')

const PORT = Number(process.env.PORT || 3000)

/* Every vendor route lives under this prefix — the integration builds each URL as
 * `${baseUrl}/vetsync/v1/...` (zoetis.service.ts). */
const API = '/vetsync/v1'

/* Monotonic vendor-side order id, seeded from process start so every order gets a globally unique
 * `@id` across control-plane resets and container restarts. Lives outside the resettable state on
 * purpose: /__control__/reset must not rewind it. */
let nextOrderId = Date.now()

function log (message) {
  /* One-line, greppable, prefixed like the harness's other services. */
  console.log(`[zoetis-mock] ${message}`)
}

/* ---- Zoetis order statuses ----
 *
 * Every order is born WAITING-FOR-SAMPLE — verified against the live Zoetis sandbox. The vendor
 * never emits a SUBMITTED status; that word exists only on the dmi side of the fence. An order
 * moves to COMPLETED when a final result exists and to PARTIAL-RESULTS when a pending one does
 * (see handleControlSeedResult).
 *
 * How the integration maps this vocabulary, because it maps it TWICE and differently:
 * ZoetisMapper.getOrderStatus (the orders poll) has an explicit case for every value here —
 * WAITING-FOR-SAMPLE -> WAITING_FOR_INPUT, PARTIAL-RESULTS -> PARTIAL, COMPLETED -> COMPLETED,
 * CANCELLED -> CANCELLED — while zoetis-responses.helper.ts mapOrderStatus (the create-order
 * response) has no WAITING-FOR-SAMPLE case and reports it as dmi SUBMITTED via its default. The
 * scenario pins both readings. */
const STATUS_WAITING_FOR_SAMPLE = 'WAITING-FOR-SAMPLE'
const STATUS_PARTIAL = 'PARTIAL-RESULTS'
const STATUS_COMPLETED = 'COMPLETED'
const STATUS_CANCELLED = 'CANCELLED'

/* ---- in-memory state (reset via POST /__control__/reset) ---- */

function freshState () {
  return {
    /* PracticeRef (the requisitionId the order was placed with) -> order record. Zoetis keys
     * everything on this id: it is the order-status document's `client_order_id`, which the
     * integration assigns as BOTH the requisitionId and the externalId, and it is what the result
     * document carries as its `Identification/PracticeRef`. */
    orders: new Map(),
    /* Error/edge injection: { [key]: { status, body, once } }. Keys are logical operation names:
     * 'createOrder', 'batchOrders', 'batchResults', 'orderStatus', 'batchAcknowledge'. */
    scenarios: {},
    /* High-water marks: the most documents this mock has ever served in ONE feed response.
     *
     * They exist so a test can assert that a MULTI-document batch actually happened, rather than
     * inferring it from two orders both having completed — which two separate one-document batches
     * would satisfy just as well. The array-shaped parse paths (`objectOrArray` on `LabReport` and
     * on `orders.order`) only run when a response carries more than one, so without this the
     * difference is invisible from outside. Read-only, exposed through /__control__/feeds. */
    maxLabReportsInOneBatch: 0,
    maxOrdersInOneFeed: 0,
    /* Most DISTINCT client_order_ids ever acknowledged in one batch-acknowledge POST. Distinct, not
     * total, and that is the whole point: it is what separates a multi-document batch whose documents
     * were correctly attributed from one whose documents were cross-wired onto a single order. The
     * latter still produces a two-entry ack — just two copies of the same id. Serving counts alone
     * cannot tell those apart, and this mock self-heals a mis-served batch on the following tick
     * (the leftover order is then the only one pending, so it is served alone and correctly), which
     * would otherwise hide the failure entirely. */
    maxDistinctOrdersInOneAck: 0,
  }
}

let state = freshState()

/* ---- http helpers ---- */

function sendXml (res, status, xml) {
  /* application/xml is load-bearing twice over: the integration reads the response body as raw text
   * and parses it itself (axios only auto-parses JSON, so any other content-type keeps the body a
   * string), and its interceptor keys its empty-payload filter off this content-type
   * (zoetis-api.interceptor.ts filter()). */
  res.writeHead(status, {
    'content-type': 'application/xml; charset=utf-8',
    'content-length': Buffer.byteLength(xml),
  })
  res.end(xml)
}

function sendJson (res, status, body) {
  const payload = JSON.stringify(body ?? {})
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/* A status-only response with an EMPTY body — what the vendor's acknowledge endpoints answer
 * (verified against the live Zoetis sandbox). The integration treats any 2xx as success and
 * discards acknowledge response bodies (makePostRequest returns data both ack call sites ignore),
 * so nothing downstream reads what is deliberately not there. */
function sendEmpty (res, status) {
  res.writeHead(status)
  res.end()
}

/* The vendor's error dialect: an <error> root whose <message> carries the failure context as an
 * ATTRIBUTE and the human-readable reason as element text, served as application/xml. Verified
 * against the live Zoetis sandbox for a duplicate-acknowledge 409 and a 404. One builder for every
 * error the mock serves, so no two handlers can drift onto different shapes. */
function vendorErrorXml (context, message) {
  return `<error><message context="${escapeXml(context)}">${escapeXml(message)}</message></error>`
}

/* Vendor ERRORS are XML like every success — the vendorErrorXml dialect above, served as
 * application/xml. Verified against the live Zoetis sandbox for a duplicate-acknowledge 409 and a
 * 404; a validation 400's exact body was not separately captured, so the mock's rejections
 * extrapolate the same form.
 *
 * What this dialect means for the integration's error surface, mechanically: providerErrorMapper
 * reads `error.response.data.error.context` / `.message`, properties that only exist when axios
 * parsed a JSON body into an object. An XML error body keeps `error.response.data` a string, so the
 * mapper's structured branch never runs and every vendor error surfaces through its generic
 * "A request to <path> failed with <status> status code." branch — which the rejection scenario
 * pins as the vendor-real surface. (An earlier revision of this mock answered errors in JSON
 * precisely to reach the structured branch; that exercised more mapper code at the price of a wire
 * shape the vendor never produces.)
 *
 * `context` names the offending field where one exists, using the request document's own element
 * path (`AnimalDetails/Species`) — the only naming the integration and this mock can agree on. */
function sendVendorError (res, status, context, message) {
  log(`rejected: ${context} — ${message}`)
  sendXml(res, status, vendorErrorXml(context, message))
}

/* Short-circuit an injected failure scenario. The default body is the vendor's XML error dialect —
 * an injected 500 must look like a real vendor 500, or the retry paths it exists to exercise would
 * be retrying against a fiction. A custom `body` is a control-plane escape hatch and goes out as
 * JSON, exactly as given. */
function sendScenario (res, scenario, context, message) {
  if (scenario.body != null) {
    sendJson(res, scenario.status, scenario.body)
    return
  }
  sendVendorError(res, scenario.status, context, message)
}

function readRaw (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function readJson (req) {
  const raw = await readRaw(req)
  if (raw.length === 0) return {}
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`invalid JSON body: ${error.message}`)
  }
}

/* An injected scenario for `key` short-circuits the handler with a canned status/body. Cleared once
 * consumed when `once` is set, so a test can inject a single transient failure. */
function takeScenario (key) {
  const scenario = state.scenarios[key]
  if (scenario == null) return null
  if (scenario.once) delete state.scenarios[key]
  return scenario
}

/* The base URL to advertise in the order-status `<link href>` elements. Read from the request's Host
 * header rather than configured, because the integration POSTs to that href VERBATIM
 * (zoetis.service.ts acknowledgeOrders) — so it must resolve from wherever the caller reached us.
 * Inside the compose network that is `zoetis-mock:3000`; from the host it is `127.0.0.1:3014`. A
 * hard-coded absolute URL here would be the one way this mock could send traffic somewhere real. */
function selfBaseUrl (req) {
  return `http://${req.headers.host || `localhost:${PORT}`}`
}

function escapeXml (value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function decodeXml (value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&')
}

/* ---- a very small XML reader ----
 *
 * The mock has to READ two documents the integration sends: the `<LabReport>` order request and the
 * `<orders>` batch-acknowledge body. Both are machine-generated by xmlbuilder2 and shallow, so a
 * dependency-free reader is enough — and staying zero-dependency is what lets the mock image build
 * from a one-line Dockerfile with no registry token. It is deliberately not a general XML parser:
 * it handles elements, attributes, text and CDATA, and ignores the prolog and comments. */
function parseXml (xml) {
  const root = { name: '#root', attrs: {}, children: [], text: '' }
  const stack = [root]
  const token =
    /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<\/([A-Za-z_][\w.:-]*)\s*>|<([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g

  let cursor = 0
  let match
  const addText = (raw) => {
    if (raw.trim() !== '') stack[stack.length - 1].text += decodeXml(raw).trim()
  }

  while ((match = token.exec(xml)) !== null) {
    addText(xml.slice(cursor, match.index))
    cursor = token.lastIndex

    if (match[1] !== undefined) {
      stack[stack.length - 1].text += match[1]
      continue
    }
    if (match[0].startsWith('<!--') || match[0].startsWith('<?')) continue
    if (match[2] !== undefined) {
      if (stack.length > 1) stack.pop()
      continue
    }

    const attrs = {}
    const attrToken = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
    let attr
    while ((attr = attrToken.exec(match[4] ?? '')) !== null) {
      attrs[attr[1]] = decodeXml(attr[2] ?? attr[3] ?? '')
    }

    const node = { name: match[3], attrs, children: [], text: '' }
    stack[stack.length - 1].children.push(node)
    if (match[5] !== '/') stack.push(node)
  }
  addText(xml.slice(cursor))

  return root.children[0] ?? null
}

function childrenNamed (node, name) {
  return node == null ? [] : node.children.filter((child) => child.name === name)
}

function childNamed (node, name) {
  return childrenNamed(node, name)[0] ?? null
}

/* Text of `a/b/c` under `node`, or '' if any hop is missing. */
function textAt (node, path) {
  let current = node
  for (const segment of path.split('/')) {
    current = childNamed(current, segment)
    if (current == null) return ''
  }
  return current.text
}

/* ---- SYNTHETIC canned data ---- */

/* The service catalogue: what `GET /vetsync/v1/services` advertises AND what order placement
 * enforces, so the two cannot drift apart. Serving one list and accepting another is how a scenario
 * ends up ordering a code the real vendor would refuse.
 *
 * `CDP`, `HEM` and `T4` are genuine Zoetis catalogue codes (vendor test identifiers), and the section
 * names, the test names for those three, and the fixed `Replicate` / `ValidFrom` / `Currency` /
 * `NonDiscountable` fields follow the vendor's own catalogue shape. The `Includes` lists, the
 * `sampleType`s and the fourth entry (`TSH`) are invented. None of it is clinic or patient data.
 *
 * Three sections, not one: `mapTestArrays` calls `DirectoryOfService.Section.map(...)`, so a single
 * `<Section>` deserialises to an object and getServices throws. The `Test` child is safe either way
 * (mapTestArrays branches on `instanceof Array`), and the Hematology section deliberately carries
 * two tests so both branches are exercised. */
const CATALOGUE = [
  {
    section: 'Chemistry',
    tests: [
      {
        code: 'CDP',
        name: 'Comprehensive Diagnostic',
        includes: 'ALB, ALT, CRE, GLU',
        sampleType: 'Serum',
      },
    ],
  },
  {
    section: 'Hematology',
    tests: [
      { code: 'HEM', name: 'Hematology', includes: 'HCT, HGB, PLT, RBC, WBC', sampleType: 'Whole Blood' },
      { code: 'T4', name: 'Total T4', includes: 'T4', sampleType: 'Serum' },
    ],
  },
  {
    section: 'Endocrinology',
    tests: [
      { code: 'TSH', name: 'Thyroid Stimulating Hormone', includes: 'TSH', sampleType: 'Serum' },
    ],
  },
]

const SERVICES = CATALOGUE.flatMap((section) =>
  section.tests.map((test) => ({ ...test, category: section.section })),
)

/* The code the harness orders by default. Exposed through /__control__ so the scenario asserts
 * against the same catalogue the mock enforces, rather than a literal duplicated on both sides. */
const DEFAULT_SERVICE_CODE = 'CDP'

/* Reference data. Both are consumed by the integration's ref-sync (getSpecies / getSexes) and both
 * must carry >= 2 children — those two map over the array without normalising.
 *
 * SPECIES are the vendor's own uppercase codes and go into `<Species>` verbatim: getSpecies maps
 * each to `{ code: specie }`, and dmi-api's zoetis provider_ref rows carry exactly these codes
 * (DOG, CAT), so this is the vocabulary an order's mapped species arrives in.
 *
 * GENDERS are DISPLAY names, and the shape difference is deliberate: getSexes derives the code as
 * `gender.toUpperCase().replace(' ', '_')`, so `Male Neutered` here is the code `MALE_NEUTERED` —
 * which is what dmi-api's zoetis sex provider_ref rows hold and therefore what arrives in
 * `<Gender>`. Serving the codes here instead would quietly make the mock agree with itself. */
const SPECIES = ['DOG', 'CAT']
const GENDERS = ['Male', 'Male Neutered', 'Female', 'Female Spayed', 'Unknown']

/* What `<Species>` / `<Gender>` on an incoming order are checked against — derived from the two
 * lists above by the same rule the integration uses, so advertising and enforcement stay in step. */
const SPECIES_CODES = new Set(SPECIES)
const GENDER_CODES = new Set(GENDERS.map((gender) => gender.toUpperCase().replace(/ /g, '_')))

/* Devices are not part of the order->result loop, but the integration exposes getDevices and it does
 * `Devices.Device.map(...)` — so if a ref sync ever reaches here, two entries keep it from throwing.
 * A mock that 404s (or serves one device) would be a trap for the next scenario. */
const DEVICES = [
  { id: 'VS-CHEM-1', name: 'Harness Chemistry Analyzer', model: 'VETSCAN-SIM', serial: 'HRN-0001' },
  { id: 'VS-HEM-1', name: 'Harness Hematology Analyzer', model: 'VETSCAN-SIM', serial: 'HRN-0002' },
]

/* Invented analyte values on genuine Zoetis analyte codes, chosen to exercise all three branches of
 * ZoetisMapper.getValueX plus the mapper's interpretation, reference-range and filter paths:
 *   - GLU: numeric `Result` + units + both range bounds + Notes 'H' -> valueQuantity, a bounded
 *          referenceRange, and specifically a HIGH interpretation.
 *   - CRE: numeric `Result`, in range, no flag -> valueQuantity + referenceRange, no interpretation.
 *   - ALT: `resultText` and NO `Result`, text that is not numeric -> getValueX's valueString branch.
 *          It carries units because that branch APPENDS them ("<text> <units>"), which nothing else
 *          covers; it carries no range because getReferenceRange requires a numeric Result.
 *   - ALB: `resultText` and NO `Result`, text that IS a flagged numeric -> getValueX's third branch,
 *          where the regex /^(-?\d+(\.\d+)?)(?=\s\*)/ pulls the number back out and emits a
 *          valueQuantity with NO units. Note the space before the asterisk is required by that
 *          lookahead ('0.4 *' matches, '0.4*' does not).
 *   - GLU_HIST_IMG64 / GLU_HIST_DATA: the two suffixes ZoetisMapper.mapLabResult FILTERS OUT. They
 *          are seeded on purpose so the scenario can assert they do NOT reach the report — that is
 *          the only way that filter is covered, and without them a broken filter would be invisible.
 *          Their ResultText stands in for the base64 image payload the real vendor sends.
 *
 * None of these values contain an XML-special character, and that is deliberate rather than
 * incidental. xmlbuilder2 2.4.1 (the version the integration resolves) DOUBLE-escapes text nodes in
 * `{ format: 'object' }`: `<a>&gt;1000</a>` parses to the string `&amp;gt;1000`, so the mapper's
 * single `he.decode()` yields `&gt;1000` — the entity, not the character. A seeded value like
 * '>1000' would therefore reach the report mis-encoded, and asserting on it would bake an upstream
 * encoding quirk into this gate as if it were the contract. Entity-free values keep the assertions
 * about the mapping. */
function defaultAnalytes () {
  return [
    {
      code: 'GLU',
      name: 'Glucose',
      result: '150',
      units: 'mg/dL',
      lowRange: '74',
      highRange: '143',
      /* 'H' is NormalizedFlag.HIGH; 'L' is LOW. The mapper switches on this exact value. */
      notes: 'H',
    },
    {
      code: 'CRE',
      name: 'Creatinine',
      result: '1.2',
      units: 'mg/dL',
      lowRange: '0.5',
      highRange: '1.8',
    },
    {
      code: 'ALT',
      name: 'Alanine Aminotransferase',
      resultText: 'HEMOLYZED',
      units: 'U/L',
    },
    {
      code: 'ALB',
      name: 'Albumin',
      resultText: '0.4 *',
    },
    {
      code: 'GLU_HIST_IMG64',
      name: 'Glucose histogram',
      resultText: 'c3ludGhldGljLWhpc3RvZ3JhbS1wbGFjZWhvbGRlcg==',
    },
    {
      code: 'GLU_HIST_DATA',
      name: 'Glucose histogram data',
      resultText: '0,1,4,9,16,25',
    },
  ]
}

/* ---- response builders ---- */

/* Which link rels an order-status document carries, BY STATE. Verified against the live Zoetis
 * sandbox for the two states the loop always visits:
 *
 *   WAITING-FOR-SAMPLE -> self, poll, acknowledged, cancel     (no `results` link yet)
 *   COMPLETED          -> self, poll, acknowledged, results    (no `cancel`)
 *
 * `results` appears only once results exist, and `cancel` only while the order is still editable —
 * so ZoetisMapper.getEditable (cancel present <-> editable) now tracks the vendor's actual state
 * machine rather than a constant. The other two states were NOT captured live; their sets are
 * assumptions, stated as such:
 *
 *   PARTIAL-RESULTS    -> self, poll, acknowledged, results    (assumed: results exist, and a
 *                         partially-resulted order is presumed no longer editable)
 *   CANCELLED          -> self, poll, acknowledged             (assumed: no results, not editable)
 *
 * The integration builds its results URLs itself and only ever FOLLOWS the `acknowledged` href, so
 * none of this changes its behaviour — it is fidelity, plus getEditable becoming state-true. Every
 * state still carries >= 3 links, so the >=2 arity rule at the top of this file holds untouched.
 *
 * A single source of truth on purpose: buildOrderElement emits exactly these rels, and the control
 * plane exposes them (publicOrder.linkRels), so a scenario asserting the set can never drift from
 * what the vendor dialect actually serves. */
function linkRelsFor (status) {
  const rels = ['self', 'poll', 'acknowledged']
  if (status === STATUS_COMPLETED || status === STATUS_PARTIAL) rels.push('results')
  if (status === STATUS_WAITING_FOR_SAMPLE) rels.push('cancel')
  return rels
}

/* The order-status document, returned by order placement and by GET /orders/:id/status, and the
 * `<order>` entries of the orders poll.
 *
 * `client_order_id` is the load-bearing attribute: getOrderFromZoetisOrderResponse assigns it as
 * BOTH the requisitionId and the externalId of the created order, and the result document carries
 * the same value as `Identification/PracticeRef`. That agreement is the whole of Zoetis
 * reconciliation — dmi-api matches a polled result to its order on externalId, and the zoetis result
 * mapper attaches no order to a result at all, so nothing else is consulted.
 *
 * The links are not decoration. `acknowledged` is POSTed to VERBATIM by acknowledgeOrders, and
 * `cancel` is what ZoetisMapper.getEditable looks for. There must be at least two of them or both
 * `.find` and `.filter` are called on a plain object and the orders poll dies (silently — the
 * processor swallows it). Which rels appear is linkRelsFor's business — see the state table there. */
function buildOrderElement (req, order, indent) {
  const base = `${selfBaseUrl(req)}${API}/orders/${encodeURIComponent(order.practiceRef)}`
  const pad = ' '.repeat(indent)
  const hrefFor = {
    self: { href: `${base}/status`, method: 'GET' },
    poll: { href: `${selfBaseUrl(req)}${API}/orders`, method: 'GET' },
    acknowledged: { href: `${base}/acknowledged/${encodeURIComponent(order.status)}`, method: 'POST' },
    results: { href: `${base}/results`, method: 'GET' },
    cancel: { href: base, method: 'DELETE' },
  }
  const links = linkRelsFor(order.status).map((rel) => ({ rel, ...hrefFor[rel] }))

  return (
    `${pad}<order id="${escapeXml(order.id)}" client_order_id="${escapeXml(order.practiceRef)}">\n` +
    `${pad}    <status>${escapeXml(order.status)}</status>\n` +
    `${pad}    <timestamp>${escapeXml(order.updatedAt.toISOString())}</timestamp>\n` +
    `${pad}    <clientId>${escapeXml(order.clientId)}</clientId>\n` +
    links
      .map(
        (link) =>
          `${pad}    <link href="${escapeXml(link.href)}" method="${link.method}" rel="${link.rel}" type="application/xml"/>`,
      )
      .join('\n') +
    `\n${pad}</order>`
  )
}

function buildOrderStatusXml (req, order) {
  return `<?xml version="1.0" encoding="utf-8"?>\n${buildOrderElement(req, order, 0)}`
}

/* The orders poll. An empty feed MUST be `<orders/>` and not an absent document: getBatchOrders
 * reads `responseJson?.orders?.order`, which needs the root element to exist, and the interceptor's
 * filter suppresses logging for exactly this shape. */
function buildOrdersXml (req, orders) {
  if (orders.length === 0) return '<?xml version="1.0" encoding="utf-8"?>\n<orders/>'
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n<orders>\n' +
    orders.map((order) => buildOrderElement(req, order, 4)).join('\n') +
    '\n</orders>'
  )
}

function buildAnalyteXml (analyte, indent) {
  const pad = ' '.repeat(indent)
  const line = (tag, value) =>
    value === undefined || value === null ? null : `${pad}    <${tag}>${escapeXml(value)}</${tag}>`

  return (
    `${pad}<LabResultItem>\n` +
    [
      line('AnalyteCode', analyte.code),
      line('AnalyteName', analyte.name),
      line('Result', analyte.result),
      line('ResultText', analyte.resultText),
      line('Units', analyte.units),
      line('LowRange', analyte.lowRange),
      line('HighRange', analyte.highRange),
      line('Notes', analyte.notes),
    ]
      .filter((entry) => entry !== null)
      .join('\n') +
    `\n${pad}</LabResultItem>`
  )
}

/* One `<LabReport>`: the identification/animal block echoed from the placed order, plus the seeded
 * results when there are any.
 *
 * `withResults` is not a convenience flag — it is the empty-`<LabResults/>` trap described at the top
 * of this file. An order that has no result yet must omit the element entirely, or
 * ZoetisMapper.getTests maps over `[undefined]` and throws inside the orders poll.
 *
 * `ResultStatus` must be exactly `Done` (LabResultStatus.DONE, case-sensitive): ZoetisMapper
 * .getResultStatus only reports COMPLETED when every LabResult carries it, and anything else — a
 * lowercased 'done' included — silently degrades the result to PENDING and the order never
 * completes. */
function buildLabReportXml (order, { withResults, indent = 0 }) {
  const pad = ' '.repeat(indent)
  const result = order.result
  const identification = [
    ['ReportType', withResults && result != null ? 'Result' : 'Request'],
    ['PracticeID', order.practiceId],
    ['ClientId', order.clientId],
    ['PracticeRef', order.practiceRef],
    ['LaboratoryRef', order.laboratoryRef],
    ['OwnerName', order.ownerName],
    ['OwnerID', order.ownerId],
    ['VetName', order.vetName],
    ['VetID', order.vetId],
  ]
  const animal = [
    ['AnimalID', order.animalId],
    ['AnimalName', order.animalName],
    ['Gender', order.gender],
    ['Species', order.species],
    ['Breed', order.breed],
    ['DateOfBirth', order.dateOfBirth],
  ]
  const block = (name, entries, depth) =>
    `${' '.repeat(depth)}<${name}>\n` +
    entries
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([tag, value]) => `${' '.repeat(depth + 4)}<${tag}>${escapeXml(value)}</${tag}>`)
      .join('\n') +
    `\n${' '.repeat(depth)}</${name}>`

  let results = ''
  if (withResults && result != null) {
    results =
      `\n${pad}    <LabResults>\n` +
      `${pad}        <LabResult>\n` +
      `${pad}            <LabResultHeader>\n` +
      `${pad}                <TestCode>${escapeXml(result.testCode)}</TestCode>\n` +
      `${pad}                <TestName>${escapeXml(result.testName)}</TestName>\n` +
      `${pad}                <TestType>${escapeXml(result.testType)}</TestType>\n` +
      `${pad}                <ResultDate>${escapeXml(result.seededAt.toISOString())}</ResultDate>\n` +
      `${pad}                <ResultStatus>${escapeXml(result.resultStatus)}</ResultStatus>\n` +
      `${pad}                <ResultNotes>${escapeXml(result.resultNotes)}</ResultNotes>\n` +
      `${pad}            </LabResultHeader>\n` +
      `${pad}            <LabResultItems>\n` +
      result.analytes.map((analyte) => buildAnalyteXml(analyte, indent + 16)).join('\n') +
      `\n${pad}            </LabResultItems>\n` +
      `${pad}        </LabResult>\n` +
      `${pad}    </LabResults>`
  }

  return (
    `${pad}<LabReport>\n` +
    block('Identification', identification, indent + 4) +
    '\n' +
    block('AnimalDetails', animal, indent + 4) +
    results +
    `\n${pad}</LabReport>`
  )
}

/* The results batch poll. `<LabReports/>` when empty, for the same reason `<orders/>` is:
 * getBatchResults reads `responseJson.LabReports.LabReport`. */
function buildLabReportsXml (orders) {
  if (orders.length === 0) return '<?xml version="1.0" encoding="utf-8"?>\n<LabReports/>'
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n<LabReports>\n' +
    orders.map((order) => buildLabReportXml(order, { withResults: true, indent: 4 })).join('\n') +
    '\n</LabReports>'
  )
}

function buildServicesXml () {
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n<DirectoryOfService>\n' +
    CATALOGUE.map(
      (section) =>
        `    <Section Name="${escapeXml(section.section)}">\n` +
        section.tests
          .map(
            (test) =>
              '        <Test>\n' +
              `            <Name>${escapeXml(test.name)}</Name>\n` +
              `            <Code>${escapeXml(test.code)}</Code>\n` +
              '            <Replicate>0</Replicate>\n' +
              '            <ValidFrom>2016-06-30</ValidFrom>\n' +
              `            <Includes>${escapeXml(test.includes)}</Includes>\n` +
              '            <Currency>None</Currency>\n' +
              '            <NonDiscountable>false</NonDiscountable>\n' +
              '        </Test>',
          )
          .join('\n') +
        '\n    </Section>',
    ).join('\n') +
    '\n</DirectoryOfService>'
  )
}

function buildListXml (root, item, values) {
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n<${root}>\n` +
    values.map((value) => `    <${item}>${escapeXml(value)}</${item}>`).join('\n') +
    `\n</${root}>`
  )
}

function buildDevicesXml () {
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n<Devices>\n' +
    DEVICES.map(
      (device) =>
        '    <Device>\n' +
        `        <DeviceID>${escapeXml(device.id)}</DeviceID>\n` +
        `        <DeviceName>${escapeXml(device.name)}</DeviceName>\n` +
        `        <Model>${escapeXml(device.model)}</Model>\n` +
        `        <SerialNumber>${escapeXml(device.serial)}</SerialNumber>\n` +
        '    </Device>',
    ).join('\n') +
    '\n</Devices>'
  )
}

/* ---- auth ---- */

/* The credential VALUES are deliberately not checked — they are dummy by design and checking them
 * would test nothing. Their PRESENCE and SHAPE are checked, because both are real contract: the
 * integration builds the username as `${partnerId}\${clientId}` (zoetis.service.ts connectionParams)
 * from a provider-configuration field and an integration option that live in different places in
 * dmi-api. An integration that stopped sending either would still authenticate against a mock that
 * accepted anything, and every downstream call would keep working — while real Zoetis rejected the
 * lot. So: a missing header is a 401, and so is a username without the `\` that proves both halves
 * were joined.
 *
 * Returns the decoded `{ partnerId, clientId }` so handlers can echo the client id back. */
function requireBasicAuth (req, res) {
  const header = req.headers.authorization ?? ''
  if (!header.startsWith('Basic ')) {
    sendVendorError(res, 401, 'Authorization', 'missing HTTP Basic credentials')
    return null
  }

  const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8')
  const separator = decoded.indexOf(':')
  const username = separator === -1 ? decoded : decoded.slice(0, separator)
  const password = separator === -1 ? '' : decoded.slice(separator + 1)

  if (username === '' || password === '') {
    sendVendorError(res, 401, 'Authorization', 'HTTP Basic credentials must carry a username and a password')
    return null
  }
  /* One literal backslash, `<partnerId>\<clientId>`. */
  const parts = username.split('\\')
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    sendVendorError(
      res,
      401,
      'Authorization',
      `username must be '<partnerId>\\<clientId>', got '${username}'`,
    )
    return null
  }

  return { partnerId: parts[0], clientId: parts[1] }
}

/* ---- vendor handlers ---- */

/* testAuth pings the API root. Any 2xx is success (the integration only checks that it did not
 * throw), but the auth check above still runs, so a credential-less integration fails its own
 * connection test — which is the point of having one. */
function handlePing (req, res) {
  if (requireBasicAuth(req, res) == null) return
  sendXml(res, 200, '<?xml version="1.0" encoding="utf-8"?>\n<vetsync version="1"/>')
}

async function handleCreateOrder (req, res) {
  const credentials = requireBasicAuth(req, res)
  if (credentials == null) return

  const scenario = takeScenario('createOrder')
  if (scenario != null) {
    sendScenario(res, scenario, 'order', 'order placement failed')
    return
  }

  const raw = await readRaw(req)
  const document = parseXml(raw)
  if (document == null || document.name !== 'LabReport') {
    sendVendorError(res, 400, 'LabReport', 'body must be a <LabReport> document')
    return
  }

  /* Validate rather than default — but validate what the VENDOR requires, not everything the
   * harness happens to send. Every field below is one the real vendor refuses an order without, and
   * the scenario later asserts on, so substituting a fallback here would make the mock AGREE with an
   * integration that had stopped sending it — the order-forwarding assertions would then pass
   * against the mock's own invented values and could never fail. The converse discipline is why
   * AnimalDetails/Breed is NOT in the list: an order without a Breed element is accepted (verified
   * against the live Zoetis sandbox), so requiring it would gold-plate the contract and reject
   * orders the real vendor takes. It is still echoed verbatim when present, and the scenario still
   * pins that forwarding.
   *
   * The species/gender checks matter most of all, and for a reason specific to this loop: those two
   * are the only order fields that go through a real dmi-api ref-mapping transformation on the way
   * here (zoetis has provider_ref rows for species and sex, and none with a code for breed). If the
   * mock accepted anything, a mapping that silently stopped resolving would still produce a
   * well-formed order, this endpoint would answer 200, and the gate would stay green while the
   * vendor received a code it had never heard of. */
  const identification = childNamed(document, 'Identification')
  const animal = childNamed(document, 'AnimalDetails')
  const required = [
    ['Identification/ReportType', textAt(document, 'Identification/ReportType')],
    ['Identification/PracticeID', textAt(document, 'Identification/PracticeID')],
    ['Identification/ClientId', textAt(document, 'Identification/ClientId')],
    ['Identification/PracticeRef', textAt(document, 'Identification/PracticeRef')],
    ['Identification/OwnerName', textAt(document, 'Identification/OwnerName')],
    ['Identification/VetName', textAt(document, 'Identification/VetName')],
    ['AnimalDetails/AnimalName', textAt(document, 'AnimalDetails/AnimalName')],
    ['AnimalDetails/Species', textAt(document, 'AnimalDetails/Species')],
    ['AnimalDetails/Gender', textAt(document, 'AnimalDetails/Gender')],
  ]
  const missing = required.filter(([, value]) => value === '')
  if (missing.length > 0) {
    sendVendorError(
      res,
      400,
      missing[0][0],
      `missing required field(s): ${missing.map(([field]) => field).join(', ')}`,
    )
    return
  }

  const practiceRef = textAt(document, 'Identification/PracticeRef')
  if (state.orders.has(practiceRef)) {
    /* PracticeRef is the practice's own unique reference; the vendor refuses a duplicate rather than
     * silently overwriting an order that already has results. */
    sendVendorError(res, 409, 'Identification/PracticeRef', `order '${practiceRef}' already exists`)
    return
  }

  const species = textAt(document, 'AnimalDetails/Species')
  if (!SPECIES_CODES.has(species)) {
    sendVendorError(
      res,
      400,
      'AnimalDetails/Species',
      `'${species}' is not a Zoetis species code (expected one of: ${[...SPECIES_CODES].join(', ')})`,
    )
    return
  }

  const gender = textAt(document, 'AnimalDetails/Gender')
  if (!GENDER_CODES.has(gender)) {
    sendVendorError(
      res,
      400,
      'AnimalDetails/Gender',
      `'${gender}' is not a Zoetis gender code (expected one of: ${[...GENDER_CODES].join(', ')})`,
    )
    return
  }

  const testCodes = childrenNamed(childNamed(document, 'LabRequests'), 'LabRequest')
    .map((request) => textAt(request, 'TestCode'))
    .filter((code) => code !== '')
  if (testCodes.length === 0) {
    sendVendorError(res, 400, 'LabRequests/LabRequest', 'an order must request at least one test')
    return
  }
  /* The vendor only accepts codes from its own catalogue. Rejecting an unknown one is what stops the
   * harness drifting onto a plausible-looking code real Zoetis would refuse. */
  const unknown = testCodes.filter((code) => !SERVICES.some((service) => service.code === code))
  if (unknown.length > 0) {
    sendVendorError(
      res,
      400,
      'LabRequests/LabRequest/TestCode',
      `unknown test code(s) ${unknown.join(', ')} — not in this lab's directory of service`,
    )
    return
  }

  const now = new Date()
  const order = {
    id: String(nextOrderId++),
    practiceRef,
    /* Fresh orders are WAITING-FOR-SAMPLE, never anything else — verified against the live Zoetis
     * sandbox. The practice has ordered; the lab has no sample yet. */
    status: STATUS_WAITING_FOR_SAMPLE,
    placedAt: now,
    updatedAt: now,
    /* Zoetis's acknowledge model, for the ORDERS channel: the poll hands back orders whose current
     * status the practice has not acknowledged yet, and the integration acks each one by POSTing to
     * the `acknowledged` link href — which carries that status. Tracking the acknowledged status
     * (rather than a bare boolean) is what makes the feed self-quieting AND still report the later
     * WAITING-FOR-SAMPLE -> COMPLETED transition, instead of replaying the same order every 30s
     * forever. */
    acknowledgedStatus: null,
    /* Echoed straight back from the request. Everything here was validated above, so none of it is
     * a mock-invented value the scenario could accidentally be asserting against itself. */
    reportType: textAt(document, 'Identification/ReportType'),
    practiceId: textAt(document, 'Identification/PracticeID'),
    clientId: textAt(document, 'Identification/ClientId'),
    laboratoryRef: textAt(document, 'Identification/LaboratoryRef') || '1',
    ownerName: textAt(document, 'Identification/OwnerName'),
    ownerId: textAt(identification, 'OwnerID') || null,
    vetName: textAt(document, 'Identification/VetName'),
    vetId: textAt(identification, 'VetID') || null,
    animalId: textAt(animal, 'AnimalID') || null,
    animalName: textAt(document, 'AnimalDetails/AnimalName'),
    /* The ref-mapped pair. Surfaced through the control plane so the scenario can pin the exact
     * values dmi-api's mapping produced. */
    species,
    gender,
    /* Optional at the vendor (see the required-list note): stored verbatim when present, null when
     * the order carried no Breed element. */
    breed: textAt(animal, 'Breed') || null,
    dateOfBirth: textAt(animal, 'DateOfBirth') || null,
    testCodes,
    /* Set by POST /__control__/orders/:practiceRef/results. Until then the order has no result and
     * the results poll stays empty, which is what makes the loop deterministic. */
    result: null,
    resultAcknowledged: false,
  }
  state.orders.set(practiceRef, order)
  log(
    `placed order client_order_id=${practiceRef} id=${order.id} tests=${testCodes.join(',')} ` +
      `species=${species} gender=${gender} breed=${order.breed}`,
  )

  sendXml(res, 201, buildOrderStatusXml(req, order))
}

/* The orders poll. Returns orders whose current status has not been acknowledged; the integration
 * then calls getOrder for each (status + results) and acks them one at a time. */
function handleBatchOrders (req, res) {
  if (requireBasicAuth(req, res) == null) return

  const scenario = takeScenario('batchOrders')
  if (scenario != null) {
    sendScenario(res, scenario, 'orders', 'orders poll failed')
    return
  }

  const pending = [...state.orders.values()].filter((order) => order.acknowledgedStatus !== order.status)
  state.maxOrdersInOneFeed = Math.max(state.maxOrdersInOneFeed, pending.length)
  sendXml(res, 200, buildOrdersXml(req, pending))
}

function handleOrderStatus (req, res, params) {
  if (requireBasicAuth(req, res) == null) return

  const scenario = takeScenario('orderStatus')
  if (scenario != null) {
    sendScenario(res, scenario, 'order', 'order status failed')
    return
  }

  const order = state.orders.get(params.practiceRef)
  if (order == null) {
    sendVendorError(res, 404, 'order', `no order for client_order_id '${params.practiceRef}'`)
    return
  }
  sendXml(res, 200, buildOrderStatusXml(req, order))
}

/* Single-order results, fetched by getOrder on every orders-poll tick (and by getOrderResult). It
 * answers for an order with no result yet by omitting `<LabResults>` — see the note on
 * ZoetisMapper.getTests at the top of this file. */
function handleOrderResults (req, res, params) {
  if (requireBasicAuth(req, res) == null) return

  const order = state.orders.get(params.practiceRef)
  if (order == null) {
    sendVendorError(res, 404, 'order', `no order for client_order_id '${params.practiceRef}'`)
    return
  }
  sendXml(
    res,
    200,
    '<?xml version="1.0" encoding="utf-8"?>\n' + buildLabReportXml(order, { withResults: true }),
  )
}

/* The results poll. Returns every seeded result not yet acknowledged through the BATCH channel. */
function handleBatchResults (req, res) {
  if (requireBasicAuth(req, res) == null) return

  const scenario = takeScenario('batchResults')
  if (scenario != null) {
    sendScenario(res, scenario, 'results', 'results poll failed')
    return
  }

  const pending = [...state.orders.values()].filter(
    (order) => order.result != null && !order.resultAcknowledged,
  )
  state.maxLabReportsInOneBatch = Math.max(state.maxLabReportsInOneBatch, pending.length)
  sendXml(res, 200, buildLabReportsXml(pending))
}

/* Batch acknowledge, the RESULTS channel. Body is `<orders><order client_order_id="..."/></orders>`
 * (zoetis.service.ts acknowledgeBatchOrdersOrResults). Acknowledging an id the mock never issued is
 * answered 200 rather than 4xx — ack is idempotent-by-nature at the vendor and a retried batch must
 * not fail — but it IS logged, so an integration acking phantom ids is visible in the container logs
 * rather than silently absorbed. */
async function handleBatchAcknowledge (req, res) {
  if (requireBasicAuth(req, res) == null) return

  /* Injectable, and this is the one endpoint where that matters most: a FAILING acknowledge is the
   * entire reason the vendor's at-least-once model exists. The integration emits results to dmi-api
   * BEFORE acking them (ZoetisResultsProcessor), so an ack that fails leaves the batch unacked at
   * the vendor and it is re-served on the next tick — dmi-api therefore receives the same result
   * twice, and must merge rather than duplicate. Without a way to stage the failure that path is
   * unreachable from the harness. Honours `once: true`, so a test can stage exactly one miss. */
  const scenario = takeScenario('batchAcknowledge')
  if (scenario != null) {
    sendScenario(res, scenario, 'orders', 'batch acknowledge failed')
    return
  }

  const document = parseXml(await readRaw(req))
  const ids = childrenNamed(document, 'order')
    .map((node) => node.attrs.client_order_id)
    .filter((id) => id != null && id !== '')

  state.maxDistinctOrdersInOneAck = Math.max(state.maxDistinctOrdersInOneAck, new Set(ids).size)

  const unknown = []
  for (const id of ids) {
    const order = state.orders.get(id)
    if (order != null && order.result != null) order.resultAcknowledged = true
    else unknown.push(id)
  }
  log(`acknowledged results: ${ids.join(', ') || '(none)'}`)
  if (unknown.length > 0) log(`WARNING: acknowledged unknown/result-less client_order_id(s): ${unknown.join(', ')}`)

  /* HTTP 201 with an empty body — verified against the live Zoetis sandbox. The previous
   * `200 + <acknowledged/>` was invented. */
  sendEmpty(res, 201)
}

/* Per-order acknowledge, the ORDERS channel. This is the endpoint the order-status document's
 * `acknowledged` link points at, and acknowledgeOrders POSTs to that href verbatim — so the URL
 * shape here has to match what buildOrderElement advertises, status segment included. */
function handleOrderAcknowledge (req, res, params) {
  if (requireBasicAuth(req, res) == null) return

  const order = state.orders.get(params.practiceRef)
  if (order == null) {
    sendVendorError(res, 404, 'order', `no order for client_order_id '${params.practiceRef}'`)
    return
  }
  /* Re-acknowledging a status that is already acknowledged is a 409 at the real vendor, in its XML
   * error dialect — context and message shape observed live (an OrderAlreadyAcknowledgedException
   * naming the client_order_id, context "POLL LIST"). The integration cannot reach this branch from
   * the harness today: the orders feed only re-lists an order once its status has CHANGED since the
   * last acknowledgement, so the normal flow never double-acks (and acknowledgeOrders carries a
   * TODO for 409 support). The branch exists so the mock refuses a duplicate the way the vendor
   * would, instead of silently absorbing one. */
  if (order.acknowledgedStatus === params.status) {
    log(`refused duplicate acknowledge of order ${order.practiceRef} at status ${params.status}`)
    sendXml(
      res,
      409,
      vendorErrorXml('POLL LIST', `OrderAlreadyAcknowledgedException - Order ${order.practiceRef} already acknowledged`),
    )
    return
  }
  order.acknowledgedStatus = params.status
  log(`acknowledged order ${order.practiceRef} at status ${params.status}`)
  /* HTTP 204 with an empty body — verified against the live Zoetis sandbox. The previous
   * `200 + <acknowledged/>` was invented. */
  sendEmpty(res, 204)
}

function handleCancelOrder (req, res, params) {
  if (requireBasicAuth(req, res) == null) return

  const order = state.orders.get(params.practiceRef)
  if (order == null) {
    sendVendorError(res, 404, 'order', `no order for client_order_id '${params.practiceRef}'`)
    return
  }
  order.status = STATUS_CANCELLED
  order.updatedAt = new Date()
  log(`cancelled order ${order.practiceRef}`)
  /* The cancel RESPONSE shape was not captured live; a status-only 204 is the minimal
   * extrapolation, and the integration discards cancel response bodies anyway (makeDeleteRequest
   * returns nothing to its callers). What IS contract here is the state change: the order flips to
   * CANCELLED, the orders feed re-lists it (status != acknowledgedStatus), and its link set loses
   * `cancel` (see linkRelsFor). */
  sendEmpty(res, 204)
}

/* Test-level cancel: DELETE /vetsync/v1/orders/:practiceRef/:testCode. NOTE the wire shape — the
 * test code is a bare second path segment, with NO /tests/ between; that segment exists only on
 * dmi-api's public route (DELETE /orders/:id/tests/:testCode). cancelOrderTest in zoetis.service.ts
 * builds exactly `${baseUrl}/vetsync/v1/orders/${id}/${tests.pop().code}` — one test per call. */
function handleCancelOrderTest (req, res, params) {
  if (requireBasicAuth(req, res) == null) return

  const order = state.orders.get(params.practiceRef)
  if (order == null) {
    sendVendorError(res, 404, 'order', `no order for client_order_id '${params.practiceRef}'`)
    return
  }
  /* Validate rather than absorb: cancelling a test the order never requested is an error at a real
   * lab, not a no-op. (The status and body shape for this case were not captured live; the 404 and
   * the field-path context extrapolate the vendor's error dialect.) */
  if (!order.testCodes.includes(params.testCode)) {
    sendVendorError(
      res,
      404,
      'LabRequests/LabRequest/TestCode',
      `order '${order.practiceRef}' has no test '${params.testCode}'`,
    )
    return
  }
  order.testCodes = order.testCodes.filter((code) => code !== params.testCode)
  order.updatedAt = new Date()
  log(`cancelled test ${params.testCode} on order ${order.practiceRef} (remaining: ${order.testCodes.join(',') || '(none)'})`)
  /* Response shape extrapolated like the order-level cancel above; the integration discards it. */
  sendEmpty(res, 204)
}

/* ---- control plane (/__control__) ---- */

async function handleControlSeedResult (req, res, params) {
  /* Seed a (synthetic) result for the order placed under `practiceRef`, making the next results poll
   * deliver it and flipping the order's status. Body may override `resultStatus` ('Done' final,
   * 'Pending' in progress) or `analytes`. Returns what was assembled so a test can assert on exactly
   * what it injected. */
  const body = await readJson(req)
  const order = state.orders.get(params.practiceRef)
  if (order == null) {
    sendJson(res, 404, { message: `no order for client_order_id ${params.practiceRef}` })
    return
  }

  /* 'Done' is LabResultStatus.DONE and the ONLY value that produces a COMPLETED result — see
   * ZoetisMapper.getResultStatus. */
  const resultStatus = body.resultStatus ?? 'Done'
  const testCode = body.testCode ?? order.testCodes[0]
  const service = SERVICES.find((entry) => entry.code === testCode)
  const analytes =
    Array.isArray(body.analytes) && body.analytes.length > 0 ? body.analytes : defaultAnalytes()

  /* Enforce the >= 2 rule the file header states, rather than trusting the caller to have read it.
   * A single analyte emits one <LabResultItem>, which deserialises to an object, and the mapper
   * calls `.filter` on it directly — inside the results poll, which swallows the throw. The next
   * author to seed a one-analyte result would get a silent 120s timeout and nothing in the harness
   * output to explain it. Refusing here turns that into an immediate, legible 400.
   *
   * This is the control plane, not the vendor dialect: a real Zoetis lab would happily return a
   * one-analyte panel. The guard documents an integration constraint the harness cannot exercise,
   * which is why it says so rather than pretending to be vendor validation. */
  if (analytes.length < 2) {
    sendJson(res, 400, {
      message:
        `seed at least 2 analytes (got ${analytes.length}): a lone <LabResultItem> deserialises to ` +
        'an object and ZoetisMapper.mapLabResult calls .filter on it, which throws inside the ' +
        'results poll and is swallowed there',
    })
    return
  }

  order.result = {
    /* Echoed from the ORDER, not invented: the report's testResultsSet[].code is this value, so
     * sourcing it from what was ordered is what lets the scenario assert the two agree. */
    testCode,
    testName: service?.name ?? testCode,
    testType: service?.sampleType ?? 'Serum',
    resultStatus,
    resultNotes: body.resultNotes ?? 'Synthetic harness result.',
    seededAt: new Date(),
    analytes,
  }
  order.resultAcknowledged = false
  order.status = resultStatus === 'Done' ? STATUS_COMPLETED : STATUS_PARTIAL
  order.updatedAt = new Date()
  log(
    `seeded ${resultStatus} result for client_order_id=${params.practiceRef} ` +
      `(${order.result.analytes.length} analytes, test ${testCode})`,
  )

  sendJson(res, 201, {
    seeded: true,
    practiceRef: order.practiceRef,
    status: order.status,
    resultStatus,
    testCode,
    analytes: order.result.analytes,
  })
}

/* What a test can see of a received order. The ref-mapped fields (species, gender, breed) are here
 * deliberately: they are the ones dmi-api transforms on the way through, and without exposing them
 * a scenario can only assert that SOME order arrived, not that it carried the right vocabulary. */
function publicOrder (order) {
  return {
    practiceRef: order.practiceRef,
    id: order.id,
    status: order.status,
    /* The link rels the order-status document advertises in this state — the same linkRelsFor that
     * builds the document, so an asserting scenario and the vendor dialect cannot drift apart. */
    linkRels: linkRelsFor(order.status),
    acknowledgedStatus: order.acknowledgedStatus,
    resultAcknowledged: order.resultAcknowledged,
    hasResult: order.result != null,
    reportType: order.reportType,
    practiceId: order.practiceId,
    clientId: order.clientId,
    laboratoryRef: order.laboratoryRef,
    testCodes: order.testCodes,
    animalId: order.animalId,
    animalName: order.animalName,
    species: order.species,
    gender: order.gender,
    breed: order.breed,
    dateOfBirth: order.dateOfBirth,
    ownerName: order.ownerName,
    ownerId: order.ownerId,
    vetName: order.vetName,
    vetId: order.vetId,
    placedAt: order.placedAt.toISOString(),
  }
}

function handleControlListOrders (req, res) {
  const orders = [...state.orders.values()].map(publicOrder)
  sendJson(res, 200, { count: orders.length, orders })
}

function handleControlGetOrder (req, res, params) {
  const order = state.orders.get(params.practiceRef)
  if (order == null) {
    sendJson(res, 404, { message: `no order for client_order_id ${params.practiceRef}` })
    return
  }
  sendJson(res, 200, publicOrder(order))
}

async function handleControlScenario (req, res) {
  /* Inject a canned failure for a logical operation, e.g.
   * { "key": "createOrder", "status": 500, "body": {...}, "once": true }. */
  const body = await readJson(req)
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
 * groups in the RegExp become `params`. Order matters: the literal `/orders/batch/...` routes are
 * listed before the `/orders/:practiceRef/...` patterns that would otherwise swallow them. */
const routes = [
  ['GET', /^\/status$/, (req, res) => sendJson(res, 200, { status: 'ok', service: 'zoetis-mock' })],
  ['GET', /^\/health$/, (req, res) => sendJson(res, 200, { status: 'ok' })],

  /* The API root, pinged by testAuth. */
  ['GET', new RegExp(`^${API}$`), handlePing],

  /* Results first: `batch` would otherwise match the :practiceRef patterns below. */
  ['GET', new RegExp(`^${API}/orders/batch/results$`), handleBatchResults],
  ['POST', new RegExp(`^${API}/orders/batch/acknowledged$`), handleBatchAcknowledge],

  ['POST', new RegExp(`^${API}/orders$`), handleCreateOrder],
  ['GET', new RegExp(`^${API}/orders$`), handleBatchOrders],
  ['GET', new RegExp(`^${API}/orders/(?<practiceRef>[^/]+)/status$`), handleOrderStatus],
  ['GET', new RegExp(`^${API}/orders/(?<practiceRef>[^/]+)/results$`), handleOrderResults],
  ['POST', new RegExp(`^${API}/orders/(?<practiceRef>[^/]+)/acknowledged/(?<status>[^/]+)$`), handleOrderAcknowledge],
  ['DELETE', new RegExp(`^${API}/orders/(?<practiceRef>[^/]+)$`), handleCancelOrder],
  /* Test-level cancel — the test code is a bare second segment (no /tests/), see the handler. */
  ['DELETE', new RegExp(`^${API}/orders/(?<practiceRef>[^/]+)/(?<testCode>[^/]+)$`), handleCancelOrderTest],

  /* Reference data. The harness never triggers a ref sync, but the integration exposes all of these
   * and a mock that 404s on them would be a trap for the next scenario. `services` is the same
   * catalogue order placement enforces, so what the vendor advertises and what it accepts cannot
   * drift apart. Note there is deliberately no `/breeds`: the integration's getBreeds is a no-op
   * that returns an empty list without calling the vendor, so an endpoint here would be fiction. */
  [
    'GET',
    new RegExp(`^${API}/services$`),
    (req, res) => {
      if (requireBasicAuth(req, res) == null) return
      sendXml(res, 200, buildServicesXml())
    },
  ],
  [
    'GET',
    new RegExp(`^${API}/species$`),
    (req, res) => {
      if (requireBasicAuth(req, res) == null) return
      sendXml(res, 200, buildListXml('species', 'specie', SPECIES))
    },
  ],
  [
    'GET',
    new RegExp(`^${API}/genders$`),
    (req, res) => {
      if (requireBasicAuth(req, res) == null) return
      sendXml(res, 200, buildListXml('genders', 'gender', GENDERS))
    },
  ],
  [
    'GET',
    new RegExp(`^${API}/devices$`),
    (req, res) => {
      if (requireBasicAuth(req, res) == null) return
      sendXml(res, 200, buildDevicesXml())
    },
  ],

  /* The service catalogue and the reference vocabularies, so a test drives the same lists the mock
   * enforces instead of hard-coding literals that can drift out of step with them. */
  [
    'GET',
    /^\/__control__\/services$/,
    (req, res) =>
      sendJson(res, 200, {
        defaultCode: DEFAULT_SERVICE_CODE,
        services: SERVICES,
        species: SPECIES,
        genders: GENDERS,
        genderCodes: [...GENDER_CODES],
      }),
  ],

  /* Feed high-water marks, so a test can assert a multi-document batch really was served rather
   * than inferring it from two orders both completing (which two single-document batches satisfy
   * equally well). Read-only. */
  [
    'GET',
    /^\/__control__\/feeds$/,
    (req, res) =>
      sendJson(res, 200, {
        maxLabReportsInOneBatch: state.maxLabReportsInOneBatch,
        maxOrdersInOneFeed: state.maxOrdersInOneFeed,
        maxDistinctOrdersInOneAck: state.maxDistinctOrdersInOneAck,
      }),
  ],

  ['POST', /^\/__control__\/orders\/(?<practiceRef>[^/]+)\/results$/, handleControlSeedResult],
  ['GET', /^\/__control__\/orders$/, handleControlListOrders],
  ['GET', /^\/__control__\/orders\/(?<practiceRef>[^/]+)$/, handleControlGetOrder],
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
    const params = Object.fromEntries(
      Object.entries(match.groups || {}).map(([key, value]) => [key, decodeURIComponent(value)]),
    )
    try {
      await handler(req, res, params, url.searchParams)
    } catch (error) {
      log(`handler error on ${req.method} ${pathname}: ${error.stack || error}`)
      if (!res.headersSent) sendJson(res, 500, { message: String(error.message || error) })
    }
    return
  }
  sendJson(res, 404, { message: `no route for ${req.method} ${pathname}` })
})

server.listen(PORT, () => log(`listening on :${PORT}`))
