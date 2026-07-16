'use strict'

/* Antech (classic) mock vendor for the dmi-e2e full-stack harness. A zero-dependency Node HTTP
 * server that speaks Antech's dialect closely enough for the REAL `dmi-engine-antech-integration`
 * container to drive it: token login, order placement, the JSON status poll / acknowledge pair, the
 * results XML document and the PDF manifest. A separate control plane (`/__control__/*`) lets tests
 * seed results, inspect received orders and inject error scenarios so the order->result->report loop
 * is deterministic and CI-safe.
 *
 * It NEVER talks to real Antech and never authenticates for real: any credentials are accepted and
 * the minted token is a fixed dummy. All canned data is SYNTHETIC — invented values shaped like
 * Antech responses, never captured clinic/patient data.
 *
 * The contract mirrored here was read from the integration's own source (src/antech.service.ts,
 * src/mapper/antech-result.mapper.ts, src/interceptors/antech-api.interceptor.ts), not assumed.
 * Details that are load-bearing and easy to get wrong are called out at each handler. */

const http = require('http')

const PORT = Number(process.env.PORT || 3000)

/* Every vendor route lives under this prefix — the integration builds each URL as
 * `${baseUrl}/api/v1.1/${endpoint}` (antech.service.ts). */
const API = '/api/v1.1'

/* The token the mock mints from Users/login and then accepts on every call. The integration logs in
 * again before EVERY request (antech.service.ts makeGetRequest/makePostRequest both call login()
 * first — there is no token cache), so this endpoint is hit several times per poll. It is a dummy
 * value; the mock never verifies it. */
const ACCESS_TOKEN = 'antech-mock-token'

/* Monotonic lab accession id, seeded from process start so every seeded result gets a GLOBALLY
 * unique LabAccessionID — across control-plane resets and container restarts against a warm dmi-api
 * database. It is the key the integration acks on and the key that joins the status JSON to the
 * results XML. Lives outside the resettable state on purpose: /__control__/reset must not rewind it. */
let nextLabAccession = Date.now()

function log (message) {
  /* One-line, greppable, prefixed like the harness's other services. */
  console.log(`[antech-mock] ${message}`)
}

/* Antech timestamps are local-ish strings, not ISO-8601. Two shapes appear in the dialect: the
 * status JSON uses `YYYY-MM-DDTHH:mm:ss`, the XML uses `MM/DD/YYYY hh:mm AM/PM`. Neither is parsed
 * by the integration (the mapper carries them through or ignores them), so exact formatting is
 * cosmetic — but shaping them right keeps the mock honest. */
function statusStamp (date) {
  return date.toISOString().slice(0, 19)
}

function xmlStamp (date) {
  const pad = (n) => String(n).padStart(2, '0')
  const hours = date.getUTCHours()
  const hour12 = hours % 12 === 0 ? 12 : hours % 12
  return (
    `${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}/${date.getUTCFullYear()} ` +
    `${pad(hour12)}:${pad(date.getUTCMinutes())} ${hours < 12 ? 'AM' : 'PM'}`
  )
}

/* ---- in-memory state (reset via POST /__control__/reset) ---- */

function freshState () {
  return {
    /* ClinicAccessionID (the requisitionId the order was placed with) -> order record. Antech keys
     * everything on this id: it is what OrderPlacement echoes back as the externalId, what the
     * status polls report, and what the results XML carries as its Requisition-ID. */
    orders: new Map(),
    /* Error/edge injection: { [key]: { status, body, once } }. Keys are logical operation names,
     * e.g. 'login', 'orderPlacement', 'getStatus', 'resultsXml'. */
    scenarios: {},
  }
}

let state = freshState()

/* ---- http helpers ---- */

function sendJson (res, status, body) {
  const payload = JSON.stringify(body ?? {})
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function sendXml (res, status, xml) {
  /* application/xml (not JSON): the integration reads `resultsXml.data` as raw text and parses it
   * itself with xmlbuilder2. Axios only auto-parses JSON, so an XML content-type keeps the body a
   * string. The integration's interceptor ignores non-JSON/non-octet-stream responses. */
  res.writeHead(status, {
    'content-type': 'application/xml; charset=utf-8',
    'content-length': Buffer.byteLength(xml),
  })
  res.end(xml)
}

function sendPdf (res, status, buffer) {
  /* application/octet-stream is deliberate: the integration's interceptor only forwards json and
   * octet-stream responses (antech-api.interceptor.ts filter()). */
  res.writeHead(status, {
    'content-type': 'application/octet-stream',
    'content-length': buffer.length,
  })
  res.end(buffer)
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

/* An injected scenario for `key` short-circuits the handler with a canned status/body. Cleared once
 * consumed when `once` is set, so a test can inject a single transient failure. */
function takeScenario (key) {
  const scenario = state.scenarios[key]
  if (scenario == null) return null
  if (scenario.once) delete state.scenarios[key]
  return scenario
}

function escapeXml (value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/* ---- SYNTHETIC canned data ---- */

/* Antech's numeric order statuses (antech-order.mapper.ts mapOrderStatus): 1 SUBMITTED,
 * 2 PARTIAL, 7 COMPLETED, anything else ACCEPTED. An order is SUBMITTED when placed and flips to
 * COMPLETED once a result is seeded — the poller keys off `OrderStatus > 1` to decide whether to
 * fetch results (antech.service.ts getBatchOrders). */
const ORDER_STATUS_SUBMITTED = 1
const ORDER_STATUS_COMPLETED = 7

/* The one panel this mock reports on. `displayName` is load-bearing in a way that is easy to miss:
 * the integration joins the status JSON to the results XML by matching LabTests[].DisplayName
 * against the XML's <UnitCode><Name> BYTE-FOR-BYTE (antech.service.ts getBatchResults), so both are
 * generated from this single constant rather than written out twice. `mnemonic` becomes the report's
 * testResultsSet[].code; it defaults to the code the order was actually placed with. */
const PANEL = {
  codeId: 8001,
  codeType: 'U',
  unitCodeExtId: '8001',
  displayName: 'Small Animal Chemistry Panel',
}

/* Invented analytes chosen to exercise every branch of the result mapper the scenario asserts on:
 *   - Glucose:   numeric + units + a parseable range + Abnormal=H -> valueQuantity, referenceRange,
 *                a HIGH interpretation.
 *   - Creatinine: numeric, in range, with a comment -> valueQuantity + referenceRange + notes.
 *   - Hemolysis Index: non-numeric -> valueString (isStringANumber() is false), no units/range.
 * Ext-ID is the analyte id and becomes the observation's `code` (mapper: TestCodeID <- @Ext-ID);
 * Antech's real ids are opaque numeric strings, so these are invented numeric strings too. */
function defaultAnalytes () {
  return [
    {
      extId: '1001',
      name: 'Glucose',
      value: '150',
      units: 'mg/dL',
      range: '74-143',
      abnormal: 'H',
      status: 'F',
    },
    {
      extId: '1002',
      name: 'Creatinine',
      value: '1.2',
      units: 'mg/dL',
      range: '0.5-1.8',
      status: 'F',
      comment: 'Within normal limits.',
    },
    {
      extId: '1003',
      name: 'Hemolysis Index',
      value: 'NEGATIVE',
      status: 'F',
    },
  ]
}

/* ---- response builders ---- */

/* A LabOrders[] entry (AntechLabOrder). LabTests[] mirrors what the order was placed with. */
function buildLabOrder (order) {
  return {
    ClinicAccessionID: order.clinicAccessionId,
    OrderDate: statusStamp(order.placedAt),
    CreatedDate: statusStamp(order.placedAt),
    OrderStatus: order.orderStatus,
    LabTests: [
      {
        CodeID: PANEL.codeId,
        CodeType: PANEL.codeType,
        Mnemonic: order.mnemonic,
        DisplayName: PANEL.displayName,
      },
    ],
  }
}

/* A LabResults[] entry (AntechLabResult). Every field here is echoed from the placed order so the
 * report reads coherently and so dmi-api's reconciliation guard passes: it compares the order it
 * already holds against the one the integration extracts from this payload + the XML
 * (ProviderResultUtils.isMatchingOrder — patient name and client last name must agree).
 *
 * PetID/ClientID are echoed only when the order carried them. Note the integration tags them with
 * its own identifier systems ('antech:pet:id' / 'antech:client:id'), NOT the PIMS ones — see the
 * scenario's note on why the harness's order deliberately carries no pims:patient:id. */
function buildLabResult (order) {
  const result = order.result
  const entry = {
    ClinicAccessionID: order.clinicAccessionId,
    LabAccessionID: order.labAccessionId,
    LatestResultReceivedDate: statusStamp(result.seededAt),
    ResultStatus: result.resultStatus,
    DoctorName: `${order.doctorLastName}, ${order.doctorFirstName}`,
    PetName: order.petName,
    ClientName: `${order.clientLastName} ${order.clientFirstName}`,
    SpeciesID: order.speciesId,
    BreedID: order.breedId,
    OrderDate: statusStamp(order.placedAt),
    LabTests: [
      {
        CodeID: PANEL.codeId,
        Mnemonic: order.mnemonic,
        DisplayName: PANEL.displayName,
      },
    ],
  }
  if (order.petId != null) entry.PetID = order.petId
  if (order.clientId != null) entry.ClientID = order.clientId
  return entry
}

/* The results document served by LabResults/XML, assembled for the given orders.
 *
 * The exact XML shape matters more than it looks, because the integration parses it with
 * xmlbuilder2's object format (attributes -> '@name', CDATA -> '$', element text -> '#' only when
 * the element also has an attribute) and the mapper reads specific keys:
 *   - <Species>/<Breed> MUST carry an attribute: the mapper reads Species['#'], which only exists
 *     when the element has attributes. Without one, xmlbuilder2 collapses it to a bare string.
 *   - <Name>/<Owner>/<Doctor>/<Sex> MUST NOT carry attributes: they are read as plain strings.
 *   - <Units>/<Comment> MUST be CDATA: the mapper reads Units['$'] / Comment['$'], and plain text
 *     would parse to a string, silently dropping the units.
 *   - <Accession-ID> must be a repeated element (an array), and must include both Type="Lab-AccID"
 *     (-> LabAccessionID, the join key to the status JSON) and Type="Requisition-ID" (-> the
 *     ClinicAccessionID, which becomes dmi-api's externalId). Type="Clinic-AccID" is a decoy: it
 *     carries the clinic number, not the order's id.
 *   - <Owner> is parsed as "<last> <first>" and <Doctor> as "<last>, <first>" (result mapper's
 *     parseName / extractVeterinarianFromResult), hence the differing separators below.
 *   - <Range> is matched against /^([<>])?(\d+(\.\d+)?)(-(\d+(\.\d+)?))?$/, so "74-143" yields
 *     low/high; an empty <Range/> parses to {} and is skipped.
 * Verified against xmlbuilder2 3.1.1, the version the integration resolves. */
function buildLabReportXml (orders) {
  const accessions = orders.map((order) => {
    const analytes = order.result.analytes
      .map((analyte) => {
        const attributes = [
          analyte.abnormal != null ? ` Abnormal="${escapeXml(analyte.abnormal)}"` : '',
          ` Ext-ID="${escapeXml(analyte.extId)}"`,
          ` Status="${escapeXml(analyte.status)}"`,
        ].join('')
        const units =
          analyte.units != null
            ? `<Units><![CDATA[${analyte.units}]]></Units>`
            : '<Units/>'
        const range = analyte.range != null ? `<Range>${escapeXml(analyte.range)}</Range>` : '<Range/>'
        const comment =
          analyte.comment != null ? `\n                <Comment><![CDATA[${analyte.comment}]]></Comment>` : ''
        return (
          `            <TestCode${attributes}>\n` +
          `                <Name>${escapeXml(analyte.name)}</Name>\n` +
          `                <Value>${escapeXml(analyte.value)}</Value>\n` +
          `                ${units}\n` +
          `                ${range}${comment}\n` +
          `            </TestCode>`
        )
      })
      .join('\n')

    return (
      `    <Accession Acc-Result-ID="${escapeXml(order.accResultId)}" Lab-ID="${escapeXml(order.labId)}"` +
      ` LabClinicExt-ID="${escapeXml(order.clinicId)}" Location-ID="1"` +
      ` Order-Status="${escapeXml(order.result.resultStatus)}">\n` +
      '        <AccessionHeader>\n' +
      `            <Accession-ID ID="${escapeXml(order.clinicId)}" Type="Clinic-AccID"/>\n` +
      `            <Accession-ID ID="${escapeXml(order.accResultId)}" Type="Chart-ID"/>\n` +
      `            <Accession-ID ID="${escapeXml(order.clinicAccessionId)}" Type="Requisition-ID"/>\n` +
      `            <Accession-ID ID="${escapeXml(order.labAccessionId)}" Type="Lab-AccID"/>\n` +
      `            <TimeStamp Type="Order Received DateTime" Value="${xmlStamp(order.placedAt)}"/>\n` +
      '            <Pet>\n' +
      `                <Name>${escapeXml(order.petName)}</Name>\n` +
      `                <Age>${escapeXml(order.petAge)}${escapeXml(order.petAgeUnits)}</Age>\n` +
      `                <Sex>${escapeXml(order.petSex)}</Sex>\n` +
      `                <Species Ext-ID="${escapeXml(order.speciesId)}">${escapeXml(order.speciesName)}</Species>\n` +
      `                <Breed Ext-ID="${escapeXml(order.breedId)}">${escapeXml(order.breedName)}</Breed>\n` +
      `                <Owner>${escapeXml(order.clientLastName)} ${escapeXml(order.clientFirstName)}</Owner>\n` +
      `                <Doctor>${escapeXml(order.doctorLastName)}, ${escapeXml(order.doctorFirstName)}</Doctor>\n` +
      '            </Pet>\n' +
      '        </AccessionHeader>\n' +
      `        <UnitCode Ext-ID="${escapeXml(PANEL.unitCodeExtId)}" OrderCode="${escapeXml(order.mnemonic)}"` +
      ` Order-Control-Status="RE" Status="${escapeXml(order.result.resultStatus)}">\n` +
      `            <Name>${escapeXml(PANEL.displayName)}</Name>\n` +
      `            <TimeStamp Type="Released Datetime" Value="${xmlStamp(order.result.seededAt)}"/>\n` +
      `${analytes}\n` +
      '        </UnitCode>\n' +
      '    </Accession>'
    )
  })

  return (
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<LabReport>\n' +
    '    <ReportHeader>\n' +
    '        <Requested-By/>\n' +
    `        <Requested-On>${xmlStamp(new Date())}</Requested-On>\n` +
    '    </ReportHeader>\n' +
    '    <Clinic AccountNumber="900001" Ext-ID="900001" Status="Active">\n' +
    '        <Name>DMI E2E HARNESS CLINIC</Name>\n' +
    '    </Clinic>\n' +
    '    <LabLocation LabId="1" LabLocationId="1">\n' +
    '        <LocationCode>HRN</LocationCode>\n' +
    '        <LocationName>Harness Mock Lab</LocationName>\n' +
    '    </LabLocation>\n' +
    `${accessions.join('\n')}\n` +
    '</LabReport>'
  )
}

/* A minimal syntactically-valid PDF. The integration base64-encodes whatever LabOrders/PDFPIMS
 * returns into the order's manifest; nothing renders it, so this just needs to be non-empty bytes
 * that look like a PDF. */
function buildManifestPdf (clinicAccessionId) {
  return Buffer.from(
    `%PDF-1.4\n% dmi-e2e antech mock manifest for ${clinicAccessionId}\n` +
      '1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
    'utf8',
  )
}

/* ---- vendor handlers ---- */

async function handleLogin (req, res) {
  const scenario = takeScenario('login')
  if (scenario != null) {
    sendJson(res, scenario.status, scenario.body ?? { Message: 'login failed' })
    return
  }
  /* The integration POSTs its integrationOptions verbatim ({ UserName, Password, ClinicID, LabId })
   * and reads only `Token` off the response. Credentials are dummy and deliberately not checked. */
  await readBody(req)
  sendJson(res, 200, { Token: ACCESS_TOKEN })
}

async function handleOrderPlacement (req, res) {
  const scenario = takeScenario('orderPlacement')
  if (scenario != null) {
    sendJson(res, scenario.status, scenario.body ?? { Message: 'order placement failed' })
    return
  }

  const payload = await readBody(req)
  const clinicAccessionId = String(payload.ClinicAccessionID ?? '')
  if (clinicAccessionId === '') {
    sendJson(res, 400, { Message: 'ClinicAccessionID is required' })
    return
  }

  const firstTest = Array.isArray(payload.Tests) && payload.Tests.length > 0 ? payload.Tests[0] : {}
  const order = {
    clinicAccessionId,
    /* Lab-side ids the vendor assigns. `labAccessionId` is the ack key and the XML join key. */
    labAccessionId: `HRN${nextLabAccession++}`,
    accResultId: String(nextLabAccession),
    clinicId: String(payload.ClinicID ?? '900001'),
    labId: String(payload.LabID ?? '1'),
    placedAt: new Date(),
    orderStatus: ORDER_STATUS_SUBMITTED,
    /* Antech's acknowledge model: GetStatus hands back only items still pending acknowledgement,
     * and the integration acks each batch after processing it. Tracking that here keeps the polls
     * self-quieting, so a placed order doesn't replay on every 30s tick for the rest of the run. */
    orderAcked: false,
    /* The ordered test code doubles as the result panel's Mnemonic and the XML's OrderCode. */
    mnemonic: String(firstTest.Code ?? 'SA'),
    petId: payload.PetID != null ? String(payload.PetID) : null,
    petName: String(payload.PetName ?? 'Rex'),
    petSex: String(payload.PetSex ?? 'M'),
    petAge: payload.PetAge ?? 0,
    petAgeUnits: String(payload.PetAgeUnits ?? 'Y'),
    /* Species/Breed arrive as whatever dmi-api's antech ref mapping produced for the order's
     * species/breed (a numeric antech code when mapped, the raw code when not). Echoed back
     * unchanged; the names below are cosmetic labels for the XML. */
    speciesId: payload.SpeciesID ?? 'C',
    breedId: payload.BreedID ?? 'LAB',
    speciesName: 'Canine',
    breedName: 'Labrador Retriever',
    clientId: payload.ClientID != null ? String(payload.ClientID) : null,
    clientFirstName: String(payload.ClientFirstName ?? 'Jane'),
    clientLastName: String(payload.ClientLastName ?? 'Doe'),
    doctorFirstName: String(payload.DoctorFirstName ?? 'Ann'),
    doctorLastName: String(payload.DoctorLastName ?? 'Vet'),
    /* Set by POST /__control__/orders/:id/results. Until then the order has no result and the
     * labResult poll stays empty, which is what makes the loop deterministic. */
    result: null,
    resultAcked: false,
  }
  state.orders.set(clinicAccessionId, order)
  log(`placed order ClinicAccessionID=${clinicAccessionId} LabAccessionID=${order.labAccessionId} tests=${order.mnemonic}`)

  /* The response BODY IS the externalId: the integration assigns `externalId: placeOrderResponse.data`
   * with no field access (antech.service.ts createOrder), and results are later correlated by
   * ClinicAccessionID — so returning the ClinicAccessionID here is what lets dmi-api match a polled
   * result back to this order. A bare JSON string, not an object. */
  sendJson(res, 200, clinicAccessionId)
}

function handleGetStatus (req, res, _params, query) {
  const scenario = takeScenario('getStatus')
  if (scenario != null) {
    sendJson(res, scenario.status, scenario.body ?? { Message: 'get status failed' })
    return
  }

  const serviceType = query.get('serviceType')
  const clinicAccessionId = query.get('ClinicAccessionID')
  /* overrideAck=true means "return it even if already acknowledged". The integration sets it on the
   * single-order lookups (createOrder's status check, and getOrder), never on the batch polls. */
  const overrideAck = query.get('overrideAck') === 'true'

  const candidates =
    clinicAccessionId != null
      ? [state.orders.get(clinicAccessionId)].filter(Boolean)
      : [...state.orders.values()]

  /* BOTH keys must always be present, even when empty: the integration's interceptor reads
   * body.LabOrders.length and body.LabResults.length unguarded (antech-api.interceptor.ts filter()),
   * so omitting either throws inside the engine. */
  const body = { LabOrders: [], LabResults: [] }

  if (serviceType === 'labOrder') {
    body.LabOrders = candidates
      .filter((order) => overrideAck || !order.orderAcked)
      .map(buildLabOrder)
  } else if (serviceType === 'labResult') {
    body.LabResults = candidates
      .filter((order) => order.result != null && (overrideAck || !order.resultAcked))
      .map(buildLabResult)
  } else {
    sendJson(res, 400, { Message: `unsupported serviceType '${String(serviceType)}'` })
    return
  }

  sendJson(res, 200, body)
}

function handleResultsXml (req, res, _params, query) {
  const scenario = takeScenario('resultsXml')
  if (scenario != null) {
    sendJson(res, scenario.status, scenario.body ?? { Message: 'results xml failed' })
    return
  }

  /* accessionIDs is a comma-joined list of LAB accession ids (not clinic ones). */
  const requested = String(query.get('accessionIDs') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '')

  const orders = [...state.orders.values()].filter(
    (order) => order.result != null && requested.includes(order.labAccessionId),
  )

  sendXml(res, 200, buildLabReportXml(orders))
}

function handleManifest (req, res, _params, query) {
  /* Fetched on EVERY order creation and for every order extracted from results. It must always
   * answer: the integration's error path reads `error.response.status` unguarded, so a dropped
   * connection would surface as an unrelated TypeError. */
  const clinicAccessionId = String(query.get('ClinicAccessionID') ?? 'unknown')
  sendPdf(res, 200, buildManifestPdf(clinicAccessionId))
}

async function handleAckStatus (req, res) {
  const body = await readBody(req)
  /* Note the shapes differ between the two channels (antech.service.ts): orders ack with
   * `ClinicAccessionIds`, results with `LabAccessionsIds` (plural "Accessions" — not a typo here).
   * The response body is ignored by the integration. */
  if (body.ServiceType === 'labOrder') {
    for (const id of body.ClinicAccessionIds ?? []) {
      const order = state.orders.get(String(id))
      if (order != null) order.orderAcked = true
    }
    log(`acknowledged orders: ${(body.ClinicAccessionIds ?? []).join(', ')}`)
  } else if (body.ServiceType === 'labResult') {
    const ids = (body.LabAccessionsIds ?? []).map(String)
    for (const order of state.orders.values()) {
      if (order.result != null && ids.includes(order.labAccessionId)) order.resultAcked = true
    }
    log(`acknowledged results: ${ids.join(', ')}`)
  }
  sendJson(res, 200, {})
}

/* ---- control plane (/__control__) ---- */

async function handleControlSeedResult (req, res, params) {
  /* Seed a (synthetic) result for the order placed under `clinicAccessionId`, making the next
   * labResult poll deliver it and flipping the order to COMPLETED on the labOrder channel. Body may
   * override `resultStatus` ('F' final, 'P' partial) or `analytes`. Returns what was assembled so a
   * test can assert on exactly what it injected. */
  const body = await readBody(req)
  const order = state.orders.get(params.clinicAccessionId)
  if (order == null) {
    sendJson(res, 404, { message: `no order for ClinicAccessionID ${params.clinicAccessionId}` })
    return
  }

  const resultStatus = body.resultStatus ?? 'F'
  order.result = {
    resultStatus,
    seededAt: new Date(),
    analytes: Array.isArray(body.analytes) && body.analytes.length > 0 ? body.analytes : defaultAnalytes(),
  }
  order.resultAcked = false
  /* 'F' (final) completes the order; a partial result leaves it in progress. Either way it is now
   * > 1, which is what makes the orders poll fetch results for it. */
  order.orderStatus = resultStatus === 'F' ? ORDER_STATUS_COMPLETED : 2
  log(
    `seeded ${resultStatus} result for ClinicAccessionID=${params.clinicAccessionId} ` +
      `(LabAccessionID=${order.labAccessionId}, ${order.result.analytes.length} analytes)`,
  )

  sendJson(res, 201, {
    seeded: true,
    clinicAccessionId: order.clinicAccessionId,
    labAccessionId: order.labAccessionId,
    resultStatus,
    analytes: order.result.analytes,
  })
}

function publicOrder (order) {
  return {
    clinicAccessionId: order.clinicAccessionId,
    labAccessionId: order.labAccessionId,
    orderStatus: order.orderStatus,
    orderAcked: order.orderAcked,
    resultAcked: order.resultAcked,
    hasResult: order.result != null,
    mnemonic: order.mnemonic,
    petName: order.petName,
    petId: order.petId,
    clientLastName: order.clientLastName,
    placedAt: order.placedAt.toISOString(),
  }
}

function handleControlListOrders (req, res) {
  const orders = [...state.orders.values()].map(publicOrder)
  sendJson(res, 200, { count: orders.length, orders })
}

function handleControlGetOrder (req, res, params) {
  const order = state.orders.get(params.clinicAccessionId)
  if (order == null) {
    sendJson(res, 404, { message: `no order for ClinicAccessionID ${params.clinicAccessionId}` })
    return
  }
  sendJson(res, 200, publicOrder(order))
}

async function handleControlScenario (req, res) {
  /* Inject a canned failure for a logical operation, e.g.
   * { "key": "orderPlacement", "status": 500, "body": {...}, "once": true }. */
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
 * groups in the RegExp become `params`. The accessToken query param every vendor route carries is
 * deliberately not validated — the harness's credentials are dummy by design. */
const routes = [
  ['GET', /^\/status$/, (req, res) => sendJson(res, 200, { status: 'ok', service: 'antech-mock' })],
  ['GET', /^\/health$/, (req, res) => sendJson(res, 200, { status: 'ok' })],

  ['POST', new RegExp(`^${API}/Users/login$`), handleLogin],
  ['POST', new RegExp(`^${API}/External/OrderPlacement$`), handleOrderPlacement],
  ['GET', new RegExp(`^${API}/External/GetStatus$`), handleGetStatus],
  ['POST', new RegExp(`^${API}/External/AckStatus$`), handleAckStatus],
  ['GET', new RegExp(`^${API}/LabResults/XML$`), handleResultsXml],
  ['GET', new RegExp(`^${API}/LabOrders/PDFPIMS$`), handleManifest],

  /* Reference data. The harness never triggers a ref sync, but the integration exposes these and a
   * mock that 404s on them would be a trap for the next scenario. Synthetic single entries. */
  ['GET', new RegExp(`^${API}/External/ServiceList$`), (req, res) =>
    sendJson(res, 200, [
      {
        CodeID: PANEL.codeId,
        LabID: 1,
        CodeType: PANEL.codeType,
        Mnemonic: 'SA',
        Description: PANEL.displayName,
        Price: 45.0,
        Category: 'Chemistry',
      },
    ])],
  ['GET', new RegExp(`^${API}/Pets/Breeds$`), (req, res) =>
    sendJson(res, 200, [{ ID: 124, Name: 'Labrador Retriever', SpeciesId: 41 }])],
  ['GET', new RegExp(`^${API}/Pets/Species$`), (req, res) =>
    sendJson(res, 200, [{ ID: 41, Name: 'Canine', Breed: { ID: 124, Name: 'Labrador Retriever' } }])],

  ['POST', /^\/__control__\/orders\/(?<clinicAccessionId>[^/]+)\/results$/, handleControlSeedResult],
  ['GET', /^\/__control__\/orders$/, handleControlListOrders],
  ['GET', /^\/__control__\/orders\/(?<clinicAccessionId>[^/]+)$/, handleControlGetOrder],
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
