'use strict'

/* Antech V6 mock provider for the dmi-e2e full-stack harness. A zero-dependency Node HTTP server
 * that speaks Antech's V6 JSON dialect closely enough for the REAL
 * `dmi-engine-antech-v6-integration` — hosted, as production hosts it, inside the `dmi-engine`
 * container — to drive it unmodified: per-request login, the two status feeds, the results feed,
 * both acknowledge channels, the species/breed and test-guide reference endpoints, the TRF
 * document, and BOTH placement endpoints (pre-order and order). A separate control plane
 * (`/__control__/*`) lets tests seed results, promote a draft, inspect what the mock received and
 * inject error scenarios, so the order -> result -> report loop is deterministic and CI-safe.
 *
 * It NEVER talks to a live Antech host and never authenticates for real. All canned patient,
 * client, doctor and clinic data is SYNTHETIC — invented values shaped like Antech responses, never
 * captured clinic or patient data. What IS genuine is Antech's published CATALOGUE vocabulary: the
 * test mnemonics (`HDC-3`, `HHEM-1`, `HTR-1`, `SA804`, `ACTH2`), the species ids (41 Canine,
 * 42 Feline, 49 Other species), the breed ids (130 Labrador Retriever, 370 Other, 648 Giraffe, …)
 * and the CBC analyte names. Those are provider identifiers published to integrators; every price,
 * value, range, name and id attached to a *person* or an *accession* here is invented.
 *
 * ---------------------------------------------------------------------------------------------
 * WHERE THE CONTRACT COMES FROM
 *
 * Two sources, and they are called out separately at every handler because they carry different
 * weight:
 *
 *   (a) The integration's own source — `interfaces/antechV6-api.interface.ts` (endpoints, shapes,
 *       enums), `antechV6-api/antechV6-api.service.ts` (auth placement, params, ack bodies),
 *       `antechV6-api/antechV6-api.interceptor.ts` (what it dereferences),
 *       `services/antechV6.service.ts` (the placement decision, the polling loop, the POC rule),
 *       `providers/antechV6-mapper.ts` + `common/utils/mapper-utils.ts` (what it sends and how it
 *       maps results back), `common/exceptions/antechV6-api.exception.ts` (which envelope fields
 *       the error mapper actually reads).
 *   (b) A live probe of Antech's DEVELOPMENT endpoint, which is where the error envelopes, the
 *       wire value of `OrderStatus`, the token-placement split on `/Tests/v6`, the TRF's 500 and
 *       the one observed placement rejection come from. Anything marked OBSERVED below was seen on
 *       that endpoint; anything marked INFERRED or INVENTED was not, and says so.
 *
 * The mock is built from (b) where the two disagree, because (a) is the thing under test.
 *
 * ---------------------------------------------------------------------------------------------
 * THE LOAD-BEARING DETAILS, in the order they will bite someone
 *
 * 1. `OrderStatus` IS A STRING ON THE WIRE. OBSERVED: `"Submitted"`, `"Received"`, `"Partial"`,
 *    `"Final"`, `"In Progress"`. The integration's `AntechV6OrderStatus` is a *bare* TypeScript
 *    enum, so its members are NUMBERS, and `mapOrderStatus` switches on those numbers — which no
 *    wire value ever equals. Every status therefore falls to the switch default and reaches dmi as
 *    SUBMITTED. This mock serves the STRINGS. Emitting the integers would make the integration's
 *    status mapping appear to work and would hide a real defect (the scenario has a tripwire for
 *    exactly this), so the strings are not a stylistic choice: they are the contract.
 *
 * 2. `GET /LabResults/v6/GetStatus` ALWAYS answers with BOTH `LabOrders` and `LabResults`, the
 *    irrelevant one an empty array. OBSERVED on every captured response. The interceptor's
 *    `extractAccessionIds` does `body.LabOrders.map(...)` AND `body.LabResults.map(...)`
 *    unguarded, so a response missing either key throws a TypeError inside the logging interceptor
 *    and kills the poll.
 *
 * 3. `GET /LabResults/v6/GetAllResults` is a BARE JSON ARRAY, not an envelope. OBSERVED. The
 *    interceptor does `body.map(...)` on it.
 *
 * 4. The acknowledge body's plural is IRREGULAR on the result channel: orders ack with
 *    `clinicAccessionIds`, results with **`labAccessionsIds`** (note the extra `s`). Read from
 *    `antechV6-api.service.ts`. The mock validates the exact key rather than accepting either — a
 *    permissive mock would leave the integration free to drift onto the regular spelling while the
 *    gate stayed green.
 *
 * 5. Token placement is ENDPOINT-SPECIFIC, and only one way round (OBSERVED). Every call carries
 *    the token as an `accessToken` REQUEST HEADER — except `GET /Tests/v6`, which takes it as the
 *    lowercase `accesstoken` QUERY parameter plus a `userId`, and answers the header form with
 *    **404**, not 401. So a mock that accepted either form on `/Tests/v6` would let the
 *    integration's deliberate split rot.
 *
 * 6. A PRE-ORDER IS A DRAFT. OBSERVED: it appears in none of the four status views (both
 *    serviceTypes x both overrideAck values) and its TRF is a 500. There is no provider-visible
 *    draft -> order transition for the engine to poll; the clinic completes the draft in Antech's
 *    own UI. The control plane's `promote` action models that completion — see it for what is and
 *    is not claimed.
 *
 * 7. The species/breed tree is SELF-CONSISTENT, deliberately. The integration's own fallback
 *    constants are `SpeciesID: 49` + `BreedID: 370`, and species 49's ONLY breed is 648 while 370
 *    belongs to species 41 — so the live endpoint REJECTS that pair with
 *    `Invalid BreedId 370`. This mock refuses it for the same reason, from the same tree, so a
 *    fully unmapped patient fails here exactly as it fails at Antech. Trimming the tree so that 49
 *    contained 370 would make the mock green on the one payload the vendor refuses.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT THIS MOCK DELIBERATELY DOES **NOT** MODEL
 *
 * - **The status feed's visibility window.** OBSERVED: a freshly placed order is returned by
 *   `overrideAck=false` for something under a minute and then stops being returned, with nothing
 *   acknowledged — and separately, records age out of the feed entirely after ~2 weeks. Both are
 *   real and both are provider quirks that make the engine's poll race a window shorter than its
 *   own interval. Modelling either would make this harness non-deterministic and would test the
 *   clock rather than the loop, so the mock's `overrideAck=false` feed is governed purely by
 *   acknowledgement. Stated here because it is the single biggest difference between this mock and
 *   the live endpoint.
 * - **Re-notification on status change.** OBSERVED: an order whose status changed
 *   `Submitted -> Received` did NOT come back on the `overrideAck=false` feed. So an acknowledged
 *   record stays acknowledged here, and a status change alone does not replay it. (Contrast the
 *   zoetis mock, which does model re-notification — its provider advertises the acknowledged
 *   status in the link it hands back. Assertion strength does not transfer between loops; see
 *   CLAUDE.md.) A test that needs a record re-offered asks for it explicitly, through the control
 *   plane's `replay` flag, which is labelled as a harness action rather than a provider rule.
 * - **Whether `POC_FLAG=N` is accepted.** Only `Y` (accepted) and `Z` (rejected) were observed. The
 *   integration only ever sends `Y`. The mock therefore treats any value other than `Y` as invalid,
 *   which is the conservative reading of one data point, not a verified rule.
 * - **What a wrong `ClinicID` does at login.** Not observed — the probe only ever logged in to the
 *   clinic it owned. The mock refuses it with the 401 bare-text body the endpoint OBSERVABLY
 *   returns for a bad password, because both are "these credentials do not open this clinic". A
 *   mock that accepted any clinic could not tell an integration that lost `clinicId` from one that
 *   kept it.
 * - **The response bodies of `AckStatus` and the exact rejection messages for anything except
 *   `Invalid BreedId <n>`.** Never observed; see the INVENTED markers at each site.
 */

const http = require('http')
const { randomUUID } = require('crypto')

const PORT = Number(process.env.PORT || 3000)

/* The clinic this mock is provisioned for. Every call the integration makes carries the clinic id
 * from its integration options, and the mock refuses a mismatch rather than serving whatever it is
 * asked about — so an integration that stopped forwarding `clinicId` fails loudly here instead of
 * quietly reading an empty feed. The default matches the harness's own default
 * (HARNESS_ANTECH_V6_CLINIC_ID); the scenario asserts the two agree through /__control__/config, so
 * overriding one without the other is a named failure at setup rather than a mystery later. */
const CLINIC_ID = String(process.env.ANTECH_V6_MOCK_CLINIC_ID || '900001')
const LAB_ID = Number(process.env.ANTECH_V6_MOCK_LAB_ID || 1)

/* Synthetic. `ClinicExtId` is a short clinic mnemonic at the provider; this one is invented, and so
 * is the user id the login hands back (the live one is account data and is not reproduced). */
const CLINIC_EXT_ID = 'HRNCLINIC'
const USER_ID = 7700001

/* Lab accession ids are minted by the provider at placement. Real ones are a prefix plus a
 * monotonic counter; this prefix is deliberately harness-shaped so no value here can be mistaken
 * for a captured accession. Lives outside the resettable state so /__control__/reset cannot rewind
 * it into a collision with an id dmi-api already holds. */
const LAB_ACCESSION_PREFIX = 'HRNS'
let nextLabAccessionSeq = 1

/* The provider's own numeric order id, returned by both placement endpoints (`Value` on a
 * pre-order, `payload.requisitionId` on an order) and — OBSERVED — thrown away by the integration,
 * which keys everything on the ClinicAccessionID it sent. Seeded from process start so it is
 * unique across resets. */
let nextVendorId = 900000000 + (Date.now() % 1000000)

function log (message) {
  console.log(`[antech-v6-mock] ${message}`)
}

/* A W3C `traceparent`-shaped id, as the validation-error envelope carries. Synthetic and random. */
function traceId () {
  const hex = () => randomUUID().replace(/-/g, '')
  return `00-${hex()}-${hex().slice(0, 16)}-00`
}

/* ---- Antech V6 order-status vocabulary ----
 *
 * STRINGS on the wire (see load-bearing detail 1). These five were OBSERVED; the enum in the
 * integration's interface declares three more (`Draft`, `Expired`, `Canceled`) that have never been
 * seen. The control plane accepts any of the eight so a test can drive an unobserved one
 * deliberately, but the mock only ever *produces* `Submitted` (at placement) and whatever a test
 * sets. */
const ORDER_STATUS_SUBMITTED = 'Submitted'
const ORDER_STATUS_VALUES = [
  'Draft',
  'Expired',
  'Canceled',
  'Submitted',
  'Received',
  'In Progress',
  'Resulted',
  'Partial',
  'Final',
]

/* `ResultStatus` on the labResult status feed: 'I' in progress, 'P' partial, 'F' final,
 * 'C' updated/corrected (AntechV6ResultStatus, and OBSERVED as 'F' live). */
const RESULT_STATUS_IN_PROGRESS = 'I'
const RESULT_STATUS_VALUES = ['I', 'P', 'F', 'C']

/* AbnormalFlag, as the mapper switches on it: H high, L low, '*' abnormal, P positive. Anything
 * else (including the empty string, which is how the wire says "no flag") maps to NORMAL — and the
 * integration only emits an interpretation at all when the flag is non-empty. */
const ABNORMAL_FLAG_VALUES = ['H', 'L', '*', 'P', '']

/* ---- SYNTHETIC / CATALOGUE data ---- */

/* Antech's species and breed catalogue, as `Master/v6/GetSpeciesBreed` serves it. The ids and names
 * are GENUINE Antech catalogue identifiers; the tree is trimmed to three species (the live one has
 * 42 species and 758 breeds) and to a handful of breeds each.
 *
 * Species 41 and 49 are kept WHOLE in the sense that matters: 41 contains 370 "Other", and 49's
 * ONLY breed is 648. That pairing is load-bearing — it is what makes the mock refuse the
 * integration's own `49 + 370` fallback pair exactly as the live endpoint does (load-bearing
 * detail 7). Do not add 370 to species 49 to "make the defaults work".
 *
 * `breedExtId`/`speciesExtId` are the provider's short mnemonics. The canine and "other species"
 * ones are catalogue values; the three FELINE mnemonics are INVENTED, because the trimmed capture
 * this tree is derived from carried no feline branch — the feline breed ids and names themselves
 * (23, 24, 33) are genuine Antech catalogue identifiers. Nothing in the integration reads either
 * ext id: `getSpecies` reads `value.data[].{id,name}` and `getBreeds` flattens
 * `value.data[].breed[]` as `{code: String(breed.id), name, species: String(species.id)}`. They are
 * here so the document has the provider's shape rather than the parser's. */
const SPECIES_TREE = [
  {
    id: 41,
    name: 'Canine',
    breed: [
      { id: 55, name: 'Beagle', breedExtId: 'BEA', speciesExtId: 'C' },
      { id: 106, name: 'German Shepherd', breedExtId: 'GSD', speciesExtId: 'C' },
      { id: 110, name: 'Golden Retriever', breedExtId: 'GRET', speciesExtId: 'C' },
      { id: 130, name: 'Labrador Retriever', breedExtId: 'LAB', speciesExtId: 'C' },
      { id: 154, name: 'Poodle', breedExtId: 'POO', speciesExtId: 'C' },
      { id: 370, name: 'Other', breedExtId: 'MIX', speciesExtId: 'C' },
    ],
  },
  {
    id: 42,
    name: 'Feline',
    breed: [
      { id: 23, name: 'Maine Coon', breedExtId: 'MCO', speciesExtId: 'F' },
      { id: 24, name: 'Manx', breedExtId: 'MNX', speciesExtId: 'F' },
      { id: 33, name: 'Siamese', breedExtId: 'SIA', speciesExtId: 'F' },
    ],
  },
  {
    /* "Other species", and its one breed. The integration's DEFAULT_PET_SPECIES. */
    id: 49,
    name: 'Other species',
    breed: [{ id: 648, name: 'Giraffe', breedExtId: 'GIR', speciesExtId: 'O' }],
  },
]

const SPECIES_BY_ID = new Map(SPECIES_TREE.map((species) => [species.id, species]))

/* The test guide (`GET /Tests/v6`). ~40 fields per row in the real dialect; the load-bearing ones
 * are `Code`, `ReportingTitle`, `ClientFacingDescription`, `Category`, `Price`, `LabID`, `POC_Flag`
 * and `Status` — `mapAntechV6TestGuide` reads the first five, `getPocCodes` reads `Code` where
 * `POC_Flag` is `Y`. The rest are filled with the empty/zero values the wire uses so the row has
 * the provider's shape.
 *
 * The wire also carries two fields the integration's `AntechV6Test` interface omits — `Species_Id`
 * and `TRFFlag` — so they are here too (OBSERVED). `TRFFlag` in particular is worth having present
 * and unread: the engine decides TRF fetching from POC_Flag instead, and the two are not the same
 * partition at the provider. */
function testGuideRow (overrides) {
  return {
    CodeID: '',
    ExtensionID: '',
    Description: '',
    MnemonicType: 'U',
    Alias: '',
    Category: '',
    ClientFacingDescription: '',
    StiboMnemonics: '',
    Code: '',
    ReportingTitle: '',
    Schedule: '',
    LabID: LAB_ID,
    SDFlag: '',
    TRFFlag: '',
    AOLFlag: '',
    Price: 0,
    IdexxCode: '',
    FavoriteMnemonic: '',
    FavDisplayName: '',
    FavCustomID: 0,
    OrderCount: 0,
    ClinicID: CLINIC_ID,
    Container: '',
    Specimen: '',
    SubTestCodeIDList: '',
    SubTestCodeExtIDList: '',
    SubTestCodeList: '',
    Status: 'Active',
    HTEnabled: 'N',
    POC_Mnemonic: '',
    AnalyzerID: '',
    Common: 'N',
    POC_Flag: 'N',
    AcceptableSpecies: '',
    PreferredSpecimenRequirements: '',
    AcceptableSpecimenRequirements: '',
    RetentionStability: '',
    SpecimenDefinition: '',
    POC_Id: '',
    Species_Id: '',
    ...overrides,
  }
}

/* Five GENUINE Antech catalogue mnemonics, three point-of-care and two reference-lab, and the split
 * is what makes the integration's two POC-driven decisions observable:
 *
 *   - `createOrder` places a REAL order (rather than a draft) only when autoSubmitOrder is asked
 *     for, the integration option allows it, AND every ordered code is POC per this guide.
 *   - `getBatchOrders` skips the TRF fetch for an order whose every mnemonic is POC.
 *
 * So a scenario picks its code BY FLAG, never by position. `CodeID`/`ExtensionID` are genuine where
 * the capture carried them (HHEM-1, HTR-1, ACTH2) and INVENTED for HDC-3 and SA804, which it did
 * not; nothing reads them. Prices for the two reference-lab codes are the catalogue's own; the POC
 * codes really are priced 0 there. `Category` is the provider's, including HTR-1's genuinely empty
 * one. */
const TEST_GUIDE = [
  testGuideRow({
    CodeID: '22940',
    ExtensionID: '591300',
    Code: 'HDC-3',
    Description: 'Kidney Panel',
    ReportingTitle: 'Kidney Panel',
    ClientFacingDescription: 'KIDNEY PANEL',
    Alias: 'KIDNEY PANEL',
    StiboMnemonics: 'HDC-3',
    Category: 'Element Chemistry',
    Price: 0,
    POC_Flag: 'Y',
    POC_Id: 'HDC-3',
    POC_Mnemonic: 'HDC-3',
    AnalyzerID: 'Element DCX',
    AcceptableSpecies: 'Canine\nFeline\nEquine',
    Species_Id: '0',
  }),
  testGuideRow({
    CodeID: '22931',
    ExtensionID: '591601',
    Code: 'HHEM-1',
    Description: 'CBC',
    ReportingTitle: 'CBC',
    ClientFacingDescription: 'COMPLETE BLOOD COUNT',
    Alias: 'COMPLETE BLOOD COUNT',
    StiboMnemonics: 'HHEM-1',
    Category: 'Element Hematology',
    Price: 0,
    POC_Flag: 'Y',
    POC_Id: 'HHEM-1',
    POC_Mnemonic: 'HHEM-1',
    AnalyzerID: 'Element HT5',
    AcceptableSpecies: 'Canine\nFeline',
    Species_Id: '0',
  }),
  testGuideRow({
    CodeID: '23052',
    ExtensionID: '591701',
    Code: 'HTR-1',
    Description: 'truRapid Heartworm',
    ReportingTitle: 'truRapid Heartworm',
    ClientFacingDescription: 'truRapid Heartworm',
    Alias: 'HEARTWORM ANTIGEN',
    StiboMnemonics: 'HTR-1',
    /* Genuinely empty at the provider — not an oversight here. */
    Category: '',
    Price: 0,
    POC_Flag: 'Y',
    POC_Mnemonic: 'HTR-1',
    AnalyzerID: 'TruRapid',
    SubTestCodeIDList: '26325',
    SubTestCodeExtIDList: '51701',
    SubTestCodeList: 'Heartworm Antigen',
  }),
  testGuideRow({
    CodeID: '13350',
    ExtensionID: '550804',
    Code: 'SA804',
    Description: 'Chemistry Panel w/SDMA',
    ReportingTitle: 'Chemistry Panel w/SDMA',
    ClientFacingDescription: 'CHEMISTRY PANEL WITH SDMA',
    Alias: 'CHEM PANEL SDMA',
    StiboMnemonics: 'SA804',
    Category: 'Chemistry',
    Price: 49.51,
    POC_Flag: 'N',
    TRFFlag: 'Y',
    Common: 'Y',
  }),
  testGuideRow({
    CodeID: '12091',
    ExtensionID: '550091',
    Code: 'ACTH2',
    Description: 'Cortisol Serial 2 ACTH',
    ReportingTitle: 'Cortisol Serial 2 ACTH',
    ClientFacingDescription: 'CORTISOL SERIAL 2 ACTH',
    Alias: 'CORTISOL SERIAL 2 ACTH',
    StiboMnemonics: 'ACTH2',
    Category: 'Endocrinology',
    Price: 150.97,
    POC_Flag: 'N',
    TRFFlag: 'Y',
  }),
]

const TEST_BY_CODE = new Map(TEST_GUIDE.map((test) => [test.Code, test]))
const POC_CODES = TEST_GUIDE.filter((test) => test.POC_Flag === 'Y').map((test) => test.Code)
const REFERENCE_LAB_CODES = TEST_GUIDE.filter((test) => test.POC_Flag !== 'Y').map((test) => test.Code)

/* The default result the control plane seeds when a test does not spell one out: a Kidney Panel
 * with three analytes chosen to exercise three distinct mapper branches — an in-range numeric, an
 * out-of-range numeric carrying `H`, and a numeric at the top of its range. Every value, unit and
 * range here is INVENTED within plausible veterinary limits; the analyte names are the panel's
 * own. Tests that assert on values pass their own analytes rather than relying on these. */
function defaultUnitCodeResults () {
  return [
    {
      orderCode: 'HDC-3',
      unitCodeDisplayName: 'Kidney Panel',
      profileDisplayName: 'Kidney Panel',
      unitCodeExtID: '591300',
      category: 'Element Chemistry',
      analyzerName: 'Element DCX',
      resultStatus: 'F',
      testCodeResults: [
        { test: 'BUN', testCodeExtID: 'BUN', result: '24.3', unit: 'mg/dl', range: '9.0-29.0' },
        { test: 'CREA', testCodeExtID: 'CREA', result: '2.4', unit: 'mg/dl', range: '0.5-1.8', abnormalFlag: 'H' },
        { test: 'GLOB', testCodeExtID: 'GLOB', result: '3.6', unit: 'g/dl', range: '2.0-3.6' },
      ],
    },
  ]
}

/* ---- in-memory state (reset via POST /__control__/reset) ---- */

function freshState () {
  return {
    /* Tokens the mock has issued, token -> { userId, issuedAt }. A fresh token per login (the
     * integration logs in before EVERY request — there is no token cache upstream), and a second
     * login does NOT invalidate the first: OBSERVED, and the reason a token string-built into a
     * pre-order's submissionUri stays usable. */
    tokens: new Map(),
    /* ClinicAccessionID -> order record. Antech keys everything on this id: the integration sends
     * it at placement, assigns it as BOTH requisitionId and externalId, and dmi-api reconciles a
     * polled result to its order purely on it (the antech-v6 result mapper attaches no `.order` to
     * a non-orphan result, so dmi-api's patient-matching guard is never consulted). */
    orders: new Map(),
    /* LabAccessionID -> { clinicAccessionId, document, acknowledged, servedCount, ackCount }. The
     * GetAllResults feed. */
    results: new Map(),
    /* Error/edge injection: { [key]: { status, body, once } }. Keys are logical operation names —
     * 'login', 'getStatus', 'getAllResults', 'ackStatus', 'testGuide', 'placeOrder',
     * 'placePreOrder', 'trf'. */
    scenarios: {},
    /* Per-endpoint call counts, so a scenario can assert on what the integration DID (a TRF that
     * was never fetched, a test guide that was), not only on what it ended up with. */
    calls: {
      login: 0,
      getStatusLabOrder: 0,
      getStatusLabResult: 0,
      getAllResults: 0,
      orphanResults: 0,
      ackLabOrder: 0,
      ackLabResult: 0,
      speciesBreed: 0,
      testGuide: 0,
      testGuidePoc: 0,
      trf: 0,
      preOrderPlacement: 0,
      orderPlacement: 0,
    },
    /* Most distinct lab accession ids ever acknowledged in one AckStatus POST, so a test can prove
     * a multi-result batch was acked as one rather than inferring it from two reports. */
    maxLabAccessionIdsInOneAck: 0,
  }
}

let state = freshState()

/* ---- http helpers ---- */

function sendJson (res, status, body) {
  const payload = JSON.stringify(body === undefined ? null : body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/* A bare text body. OBSERVED: the login endpoint answers bad credentials with `text/plain`, not
 * JSON — which is why the integration's error mapper has a `typeof options === 'string'` branch at
 * all. Serving this as JSON would leave that branch unexercised. */
function sendText (res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sendPdf (res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/pdf',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
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

/* ---- the provider's error envelopes ----
 *
 * SEVEN distinct shapes, and that variety is itself part of the contract: the integration's
 * `AntechV6ApiException` unwinds a fixed list of fields off the raw response body, so which shape
 * an endpoint returns decides whether Antech's own explanation reaches the operator or is replaced
 * by a generic `Failed to POST <url>`. Each builder below is used only where it was OBSERVED. */

/* 401, bare text. OBSERVED for a bad password on /Users/v6/Login. */
function sendBadCredentials (res, why) {
  log(`login refused: ${why}`)
  sendText(res, 401, 'Invalid User or Password')
}

/* 404 JSON. OBSERVED for an unknown path, and (load-bearing detail 5) for /Tests/v6 reached with
 * header auth instead of query auth. */
function sendNotFound (res, why) {
  if (why !== undefined) log(`404: ${why}`)
  sendJson(res, 404, { statusCode: 404, message: 'Resource not found' })
}

/* 401 RFC 9110 problem-ish envelope. OBSERVED for a missing accessToken. Note the key is
 * `message`, lowercase — which the integration's error mapper does NOT read (it looks for
 * `Message`), so this surfaces to an operator as the generic `Failed to GET <url>`. That is the
 * provider-real behaviour and the mock reproduces it rather than "helpfully" using a key the
 * mapper happens to understand. */
function sendMissingAccessToken (res) {
  sendJson(res, 401, {
    type: 'https://www.rfc-editor.org/rfc/rfc9110.html#status.401',
    message: 'Access token is missing.',
    status: 401,
    errorDetails: {},
    isSuccess: false,
    requestId: randomUUID(),
  })
}

/* 400 RFC 9110 validation problem+json. OBSERVED verbatim for a malformed `serviceType`; the
 * `errors` map is keyed by the offending field. The integration's error mapper DOES read `title`
 * and `errors`, so a rejection in this shape reaches the operator with the provider's wording.
 * Reused — INVENTED, clearly marked at each call site — for the other GetStatus/AckStatus
 * validation refusals the probe never provoked, because extrapolating the endpoint's own
 * validation dialect is a smaller invention than minting a new one. */
function sendValidationProblem (res, field, message) {
  log(`400 validation: ${field} — ${message}`)
  sendJson(res, 400, {
    type: 'https://tools.ietf.org/html/rfc9110#section-15.5.1',
    title: 'One or more validation errors occurred.',
    status: 400,
    errors: { [field]: [message] },
    traceId: traceId(),
  })
}

/* 400 with a BARE JSON STRING body. OBSERVED for `POC_FLAG=Z` on /Tests/v6 — not an object, a
 * JSON-encoded string. The integration's `typeof options === 'string'` branch handles it. */
function sendBarePocFlagError (res, value) {
  log(`400 bare string: POC_Flag:${value} is not valid`)
  sendJson(res, 400, `POC_Flag:${value} is not valid`)
}

/* 500 on the TRF endpoint. OBSERVED for an unknown ClinicAccessionID (and, separately, for a
 * pre-order, which has no TRF) — a 500, NOT a 404. `getOrderTrf` catches everything and returns
 * undefined, so this degrades cleanly; a mock that answered 404 would not be reproducing the
 * endpoint. Neither key (`StatusCode`, `ErrorMessage`) is one the error mapper reads. */
function sendTrfUnavailable (res, why) {
  log(`TRF unavailable: ${why}`)
  sendJson(res, 500, { StatusCode: 500, ErrorMessage: 'Internal server error' })
}

/* 400 placement rejection — the ONE placement refusal OBSERVED live, and its shape verbatim:
 * `{value: {Data, StatusCode, HttpStatusCode, Message, InnerExceptionMessage, Error, ClientData},
 *   statusCode, contentType}`. The integration's error mapper reads `.value.Message`, so this is
 * the one provider envelope whose wording actually reaches the operator through POST /orders.
 *
 * Only ONE message was observed: `Invalid BreedId <n>`, for a breed that does not belong to the
 * species. Every other message this mock sends through this envelope is INVENTED — the ENVELOPE is
 * evidence, the WORDING beyond `Invalid BreedId` is not, and each call site says so. */
function sendPlacementRejection (res, message) {
  log(`placement rejected: ${message}`)
  sendJson(res, 400, {
    value: {
      Data: null,
      StatusCode: 0,
      HttpStatusCode: 400,
      Message: message,
      InnerExceptionMessage: '',
      Error: null,
      ClientData: null,
    },
    statusCode: 400,
    contentType: 'application/json',
  })
}

/* An injected scenario short-circuits a handler with a canned status/body. `once: true` consumes
 * it, so a test can stage exactly one transient failure. The default body is whatever the endpoint
 * really returns for that class of failure — an injected error must look like a real provider
 * error or the paths it exists to exercise are being exercised against a fiction. */
function takeScenario (key) {
  const scenario = state.scenarios[key]
  if (scenario == null) return null
  if (scenario.once) delete state.scenarios[key]
  return scenario
}

function sendScenario (res, scenario, fallback) {
  if (scenario.body != null) {
    sendJson(res, scenario.status, scenario.body)
    return
  }
  fallback(scenario.status)
}

/* ---- auth ----
 *
 * Credential VALUES are dummy by design and are not checked. Their PRESENCE is contract, and so is
 * the clinic they name. */

function issueToken () {
  /* 32 characters, matching the shape OBSERVED live. Random per login. */
  const token = (randomUUID() + randomUUID()).replace(/-/g, '').slice(0, 32)
  state.tokens.set(token, { userId: USER_ID, issuedAt: new Date().toISOString() })
  return token
}

/* The `accessToken` REQUEST HEADER, required on every endpoint except /Users/v6/Login and
 * /Tests/v6 (which takes query auth — load-bearing detail 5). Returns the token string, or null
 * having already answered. */
function requireHeaderToken (req, res) {
  const token = req.headers.accesstoken
  if (typeof token !== 'string' || token === '') {
    sendMissingAccessToken(res)
    return null
  }
  if (!state.tokens.has(token)) {
    /* INVENTED: the live endpoint was never asked about an unknown (as opposed to absent) token.
     * Refusing it keeps the mock from accepting a token the integration never obtained — a
     * permissive check here would let a broken login path stay green, since every call would carry
     * *something*. Same envelope, different wording, so the difference is legible in a log. */
    sendJson(res, 401, {
      type: 'https://www.rfc-editor.org/rfc/rfc9110.html#status.401',
      message: 'Access token is invalid.',
      status: 401,
      errorDetails: {},
      isSuccess: false,
      requestId: randomUUID(),
    })
    return null
  }
  return token
}

/* `ClinicID` is a query/body parameter on most calls and the integration always sends it from its
 * integration options. Validating it (rather than serving whatever is asked about) is INVENTED
 * enforcement with a stated purpose: an integration that stopped forwarding the clinic would
 * otherwise read an empty feed forever and look merely idle. */
function requireClinicId (res, value, field) {
  if (value === undefined || value === null || value === '') {
    sendValidationProblem(res, field, `The ${field} is required.`)
    return false
  }
  if (String(value) !== CLINIC_ID) {
    sendValidationProblem(res, field, `The ${field} is invalid. Please update and try again.`)
    return false
  }
  return true
}

/* ---- provider handlers ---- */

/* POST /Users/v6/Login
 *
 * The integration authenticates before EVERY request (no token cache), so this is the most-hit
 * endpoint in the loop. The response's two load-bearing fields are `Token` and `UserInfo.ID` — the
 * latter is what /Tests/v6 wants as its `userId` query parameter. OBSERVED: the live body carries
 * six top-level keys, not the two the integration's interface declares, and `UserInfo` carries 18
 * fields; a representative handful of INVENTED ones is included so a mock-built integration cannot
 * quietly come to depend on the interface's trimmed shape. */
async function handleLogin (req, res) {
  state.calls.login += 1

  const scenario = takeScenario('login')
  if (scenario != null) {
    sendScenario(res, scenario, () => sendBadCredentials(res, 'injected scenario'))
    return
  }

  const body = await readJson(req)
  /* Presence, not value: all three fields are contract. `ClinicID` in particular travels from
   * dmi-api's integration options through the engine, so an integration that dropped it must fail
   * here rather than be handed a clinic by default. */
  for (const field of ['UserName', 'Password', 'ClinicID']) {
    if (typeof body[field] !== 'string' || body[field] === '') {
      sendBadCredentials(res, `login body is missing ${field}`)
      return
    }
  }
  if (String(body.ClinicID) !== CLINIC_ID) {
    /* NOT OBSERVED: the probe only ever logged in to the clinic the account owns, so what the live
     * endpoint does with a foreign clinic id is unverified. The bare-text 401 is the shape it
     * OBSERVABLY returns when credentials do not open a session, and this is the same class of
     * failure. Recorded as an extrapolation, not a capture. */
    sendBadCredentials(res, `clinic ${body.ClinicID} is not this account's clinic`)
    return
  }

  const token = issueToken()
  sendJson(res, 200, {
    Token: token,
    /* OBSERVED: `Identity` duplicates `UserInfo`. Both are synthetic here. */
    Identity: { ID: USER_ID, UserName: body.UserName },
    UserInfo: {
      ID: USER_ID,
      UserName: body.UserName,
      ClinicID: CLINIC_ID,
      ClinicExtId: CLINIC_EXT_ID,
      LabID: LAB_ID,
      IsPOC: true,
      CultureCode: 'en-US',
      Status: 'Active',
    },
    ValidSession: true,
    IsWhiteListEntry: false,
    UniqueID: randomUUID(),
  })
}

/* GET /LabResults/v6/GetStatus?serviceType=labOrder|labResult&ClinicID=&overrideAck=[&ClinicAccessionID=]
 *
 * ALWAYS both keys (load-bearing detail 2). `overrideAck=false` returns only records the practice
 * has not acknowledged; `overrideAck=true` returns them regardless; an omitted parameter behaves
 * as `false` (OBSERVED: omitting it returned the same empty list `false` did). An unknown
 * `ClinicAccessionID` filter is a 200 with both arrays empty — NOT an error (OBSERVED). */
function handleGetStatus (req, res, params, query) {
  if (requireHeaderToken(req, res) == null) return

  const serviceType = query.get('serviceType')
  if (serviceType !== 'labOrder' && serviceType !== 'labResult') {
    /* OBSERVED verbatim, including the `ServiceType` key and the wording. */
    sendValidationProblem(res, 'ServiceType', 'The Service Type is invalid. Please update and try again.')
    return
  }

  if (!requireClinicId(res, query.get('ClinicID'), 'ClinicID')) return

  /* Injected AFTER validation so a test can stage a provider-side failure on an otherwise
   * well-formed call — which is the only way to reach the integration's error path on this
   * endpoint. Falls back to the endpoint's own 400 dialect. */
  const scenario = takeScenario('getStatus')
  if (scenario != null) {
    sendScenario(res, scenario, (status) =>
      sendJson(res, status, {
        type: 'https://tools.ietf.org/html/rfc9110#section-15.5.1',
        title: 'One or more validation errors occurred.',
        status,
        errors: { ServiceType: ['The Service Type is invalid. Please update and try again.'] },
        traceId: traceId(),
      }),
    )
    return
  }

  const overrideAck = String(query.get('overrideAck') ?? 'false').toLowerCase() === 'true'
  const accessionFilter = query.get('ClinicAccessionID')

  let records = [...state.orders.values()].filter((order) => order.kind === 'order')
  if (accessionFilter != null && accessionFilter !== '') {
    records = records.filter((order) => order.clinicAccessionId === accessionFilter)
  }

  if (serviceType === 'labOrder') {
    state.calls.getStatusLabOrder += 1
    const entries = records
      .filter((order) => overrideAck || !order.orderAcked)
      .map(buildLabOrderStatus)
    sendJson(res, 200, { LabOrders: entries, LabResults: [] })
    return
  }

  state.calls.getStatusLabResult += 1
  const entries = records
    .filter((order) => overrideAck || !order.resultStatusAcked)
    .map(buildLabResultStatus)
  sendJson(res, 200, { LabOrders: [], LabResults: entries })
}

/* One `LabOrders[]` entry.
 *
 * `LabTests` must be present on every entry: `mapAntechV6OrderStatus` does
 * `orderStatus.LabTests.map(...)` unguarded, and `getBatchOrders` reads the mnemonics off it again
 * to decide whether the order is in-house-only. `Pet`/`Client`/`Doctor` are OBSERVED on the wire
 * even though the integration's `AntechV6LabOrderStatus` interface omits all three — a mock built
 * from the interface alone would be missing three objects the real endpoint sends. `AddOnTests` is
 * always present, usually empty. */
function buildLabOrderStatus (order) {
  return {
    ClinicAccessionID: order.clinicAccessionId,
    OrderDate: order.orderDate,
    CreatedDate: order.createdDate,
    Pet: { Id: order.pet.id, Name: order.pet.name },
    Client: { Id: order.client.id, FirstName: order.client.firstName, LastName: order.client.lastName },
    Doctor: { Id: order.doctor.id, FirstName: order.doctor.firstName, LastName: order.doctor.lastName },
    /* A STRING. See load-bearing detail 1. */
    OrderStatus: order.orderStatus,
    LabAccessionID: order.labAccessionId,
    LabTests: order.orderCodes.map((code) => {
      const test = TEST_BY_CODE.get(code)
      return {
        CodeType: test.MnemonicType,
        CodeID: Number(test.CodeID),
        Mnemonic: test.Code,
        DisplayName: test.ReportingTitle,
        Price: test.Price,
      }
    }),
    AddOnTests: [],
  }
}

/* One `LabResults[]` entry — the labRESULT status feed, which is a different document from the
 * result itself (that is GetAllResults).
 *
 * `getBatchOrders` fetches this per order and merges it into the order it emits, so this is where
 * dmi-api gets the polled order's patient/client/veterinarian and its species/breed:
 * `mapAntechV6ResultStatus` reads `resultStatus.Pet.Name` and `.Client`/`.Doctor` UNGUARDED, and
 * `String(resultStatus.SpeciesID)` / `String(resultStatus.BreedID)`. Hence nested objects, and
 * hence numeric SpeciesID/BreedID.
 *
 * `CodeType` is deliberately absent: the captured wire records carry it on `LabOrders[].LabTests`
 * but not on the `LabResults[]` entry, even though the interface declares one. Nothing reads it. */
function buildLabResultStatus (order) {
  const firstTest = TEST_BY_CODE.get(order.orderCodes[0])
  return {
    ClinicAccessionID: order.clinicAccessionId,
    LabAccessionID: order.labAccessionId,
    LatestResultReceivedDate: order.latestResultReceivedDate ?? order.createdDate,
    ResultStatus: order.resultStatus,
    Pet: { Id: order.pet.id, Name: order.pet.name },
    Client: { Id: order.client.id, FirstName: order.client.firstName, LastName: order.client.lastName },
    Doctor: { Id: order.doctor.id, FirstName: order.doctor.firstName, LastName: order.doctor.lastName },
    SpeciesID: order.pet.speciesId,
    BreedID: order.pet.breedId,
    OrderDate: order.orderDate,
    CreatedDate: order.createdDate,
    CodeID: Number(firstTest.CodeID),
    Mnemonic: firstTest.Code,
    DisplayName: firstTest.ReportingTitle,
    LabTests: order.orderCodes.map((code) => {
      const test = TEST_BY_CODE.get(code)
      return { CodeID: Number(test.CodeID), Mnemonic: test.Code, DisplayName: test.ReportingTitle }
    }),
  }
}

/* GET /LabResults/v6/GetAllResults
 *
 * No query parameters at all — not even ClinicID (OBSERVED; the token is the whole of the scoping).
 * A BARE ARRAY of result documents not yet acknowledged on the labResult channel. Modelling the
 * acknowledge semantics here is the point: a mock that served results unconditionally forever
 * would leave the integration's ack path untested and would hide a redelivery loop. */
function handleGetAllResults (req, res) {
  if (requireHeaderToken(req, res) == null) return
  state.calls.getAllResults += 1

  const scenario = takeScenario('getAllResults')
  if (scenario != null) {
    sendScenario(res, scenario, (status) => sendJson(res, status, { StatusCode: status, ErrorMessage: 'Internal server error' }))
    return
  }

  const pending = [...state.results.values()].filter((result) => !result.acknowledged)
  for (const result of pending) result.servedCount += 1
  sendJson(res, 200, pending.map((result) => result.document))
}

/* GET /LabResults/v6/OrphanResults
 *
 * Has no call site in the integration and returned `[]` live on every call; orphans are detected
 * inside GetAllResults instead (a result whose ClinicAccessionID is empty). Served as an empty
 * bare array so that a mock-driven ref/diagnostic sweep does not 404 here, and deliberately never
 * populated — this harness seeds no orphans, so nothing asserts on them. */
function handleOrphanResults (req, res) {
  if (requireHeaderToken(req, res) == null) return
  state.calls.orphanResults += 1
  sendJson(res, 200, [])
}

/* POST /LabResults/v6/AckStatus
 *
 * Two channels, two bodies, and the result channel's plural is IRREGULAR:
 *   orders  -> { serviceType: 'labOrder',  clinicId, clinicAccessionIds: [...] }
 *   results -> { serviceType: 'labResult', clinicId, labAccessionsIds:  [...] }
 * Read from the integration's api service. The mock requires the exact key for the channel
 * (load-bearing detail 4).
 *
 * Acking an order removes it from the `overrideAck=false` order feed; acking a result removes it
 * from GetAllResults (and from the `overrideAck=false` result feed). That is the whole of the
 * self-quieting behaviour that keeps the loop from replaying every tick. */
async function handleAckStatus (req, res) {
  if (requireHeaderToken(req, res) == null) return

  const scenario = takeScenario('ackStatus')
  if (scenario != null) {
    sendScenario(res, scenario, (status) => sendJson(res, status, { StatusCode: status, ErrorMessage: 'Internal server error' }))
    return
  }

  const body = await readJson(req)
  if (body.serviceType !== 'labOrder' && body.serviceType !== 'labResult') {
    sendValidationProblem(res, 'ServiceType', 'The Service Type is invalid. Please update and try again.')
    return
  }
  if (!requireClinicId(res, body.clinicId, 'ClinicId')) return

  if (body.serviceType === 'labOrder') {
    const ids = body.clinicAccessionIds
    if (!Array.isArray(ids)) {
      /* INVENTED wording, OBSERVED envelope. Validating the key rather than hunting for "whatever
       * array is in the body" is what keeps the integration honest about which one it sends. */
      sendValidationProblem(res, 'ClinicAccessionIds', 'The ClinicAccessionIds field is required.')
      return
    }
    state.calls.ackLabOrder += 1
    const unknown = []
    for (const id of ids) {
      const order = state.orders.get(id)
      if (order != null && order.kind === 'order') {
        order.orderAcked = true
        order.orderAckedAt = new Date().toISOString()
        order.orderAckedStatus = order.orderStatus
        order.orderAckCount += 1
      } else {
        unknown.push(id)
      }
    }
    log(`acknowledged orders: ${ids.join(', ') || '(none)'}`)
    if (unknown.length > 0) log(`WARNING: acknowledged unknown ClinicAccessionID(s): ${unknown.join(', ')}`)
  } else {
    const ids = body.labAccessionsIds
    if (!Array.isArray(ids)) {
      /* The irregular plural, enforced. `labAccessionIds` (the regular spelling) is named in the
       * message so that a future integration change lands as a legible red rather than a silent
       * redelivery loop. INVENTED wording, OBSERVED envelope. */
      sendValidationProblem(
        res,
        'LabAccessionsIds',
        'The LabAccessionsIds field is required (note the irregular plural; labAccessionIds is not accepted).',
      )
      return
    }
    state.calls.ackLabResult += 1
    state.maxLabAccessionIdsInOneAck = Math.max(state.maxLabAccessionIdsInOneAck, new Set(ids).size)
    const unknown = []
    for (const id of ids) {
      const result = state.results.get(id)
      if (result != null) {
        result.acknowledged = true
        result.acknowledgedAt = new Date().toISOString()
        result.ackCount += 1
        const order = state.orders.get(result.clinicAccessionId)
        if (order != null) {
          order.resultStatusAcked = true
          order.resultAckCount += 1
        }
      } else {
        unknown.push(id)
      }
    }
    log(`acknowledged results: ${ids.join(', ') || '(none)'}`)
    if (unknown.length > 0) log(`WARNING: acknowledged unknown LabAccessionID(s): ${unknown.join(', ')}`)
  }

  /* Response body shape NOT OBSERVED — AckStatus was never called against the live endpoint. Kept
   * minimal and success-shaped; the integration discards it entirely (`acknowledgeOrders` and
   * `acknowledgeResults` both await a `doPost` whose return value is thrown away), so nothing
   * downstream reads what is deliberately not there. */
  sendJson(res, 200, { status: 200, isSuccess: true })
}

/* GET /Master/v6/GetSpeciesBreed?ClinicID=
 *
 * The envelope OBSERVED live carries two keys the integration's interface omits (top-level
 * `statusCode`, and `value.error`); both are here. `getSpecies` reads `value.data[].{id,name}` and
 * `getBreeds` flattens `value.data[].breed[]`, so a missing `breed` array on any species would
 * throw inside dmi-api's ref sync. */
function handleSpeciesBreed (req, res, params, query) {
  if (requireHeaderToken(req, res) == null) return
  if (!requireClinicId(res, query.get('ClinicID'), 'ClinicID')) return
  state.calls.speciesBreed += 1
  sendJson(res, 200, {
    value: { data: SPECIES_TREE, message: '', error: null },
    statusCode: 200,
  })
}

/* GET /Tests/v6?accesstoken=&userId=&pageSize=[&POC_FLAG=][&LabID=][&pageNumber=]
 *
 * QUERY auth, lowercase `accesstoken`, plus `userId` — and the header form is answered 404 rather
 * than 401 (load-bearing detail 5, OBSERVED). Everything about that is reproduced here, including
 * the 404, because it is the reason the integration's `getTestGuide` is written differently from
 * every other call it makes. */
function handleTestGuide (req, res, params, query) {
  const token = query.get('accesstoken')
  if (token == null || token === '') {
    /* Covers the header-auth case exactly: the caller sent `accessToken` as a header and no query
     * token, and gets a 404 that looks like a bad path rather than a bad credential. */
    sendNotFound(res, '/Tests/v6 requires query auth (accesstoken + userId), not the accessToken header')
    return
  }
  if (!state.tokens.has(token)) {
    sendNotFound(res, '/Tests/v6 called with a token this mock never issued')
    return
  }
  const userId = query.get('userId')
  if (userId == null || userId === '' || userId !== String(state.tokens.get(token).userId)) {
    /* INVENTED enforcement, with a purpose: `getTestGuide` sends
     * `userId: String(accessToken?.UserInfo?.ID)`, where the optional chain guards the READ but not
     * the RESULT — a login response without `UserInfo` sends the literal string "undefined". A mock
     * that ignored `userId` would let that ship. 404 rather than 401 to match the endpoint's own
     * habit of answering query-auth problems as a bad path. */
    sendNotFound(res, `/Tests/v6 called with userId='${userId}', which is not this token's user`)
    return
  }

  const scenario = takeScenario('testGuide')
  if (scenario != null) {
    sendScenario(res, scenario, (status) => sendJson(res, status, { StatusCode: status, ErrorMessage: 'Internal server error' }))
    return
  }

  const pocFlag = query.get('POC_FLAG')
  if (pocFlag != null && pocFlag !== 'Y') {
    /* OBSERVED for `Z`. Whether `N` would be accepted is unverified — see the "does not model"
     * list in the header. */
    sendBarePocFlagError(res, pocFlag)
    return
  }

  let rows = TEST_GUIDE
  if (pocFlag === 'Y') {
    state.calls.testGuidePoc += 1
    rows = rows.filter((row) => row.POC_Flag === 'Y')
  } else {
    state.calls.testGuide += 1
  }

  const labId = query.get('LabID')
  if (labId != null && labId !== '') {
    rows = rows.filter((row) => String(row.LabID) === String(labId))
  }

  /* `pageNumber` is the paging parameter (OBSERVED: `page` and `offset` are ignored), and the
   * integration never sends it — it asks for pageSize=2500 once. Implemented anyway so the
   * endpoint tells the truth about itself. `TotalCount` is the size of the FILTERED set, which is
   * what the live endpoint reports for the POC filter. */
  const totalCount = rows.length
  const pageSize = Number(query.get('pageSize') ?? 0)
  const pageNumber = Number(query.get('pageNumber') ?? 1)
  if (Number.isInteger(pageSize) && pageSize > 0) {
    const start = (Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber - 1 : 0) * pageSize
    rows = rows.slice(start, start + pageSize)
  }

  /* Unknown parameters are ignored (OBSERVED). */
  sendJson(res, 200, { TotalCount: totalCount, LabResults: rows })
}

/* GET /HTPDF/trf/pims/{ClinicAccessionID}
 *
 * The requisition form that accompanies the physical sample to the reference lab. Header auth. The
 * integration fetches it as an arraybuffer, swallows any failure, and attaches it to the polled
 * order as a base64 `manifest` — but ONLY for orders that are not POC-only, so whether this
 * endpoint is hit at all is a live assertion about the integration's POC rule.
 *
 * OBSERVED: a real order's accession returns 200 `application/pdf` beginning `%PDF-1.7`; anything
 * else — an unknown accession, or a PRE-ORDER, which is a draft and has no form — returns 500,
 * not 404. */
function handleTrf (req, res, params) {
  if (requireHeaderToken(req, res) == null) return
  state.calls.trf += 1

  const order = state.orders.get(params.clinicAccessionId)
  if (order != null) order.trfFetches += 1

  const scenario = takeScenario('trf')
  if (scenario != null) {
    sendScenario(res, scenario, () => sendTrfUnavailable(res, 'injected scenario'))
    return
  }

  if (order == null) {
    sendTrfUnavailable(res, `no order for ClinicAccessionID '${params.clinicAccessionId}'`)
    return
  }
  if (order.kind !== 'order') {
    sendTrfUnavailable(res, `'${params.clinicAccessionId}' is a pre-order (a draft); drafts have no TRF`)
    return
  }

  /* A minimal, structurally valid PDF. Synthetic: it carries the accession id and nothing else, so
   * no captured document is reproduced. The `%PDF-1.7` prefix and the application/pdf content type
   * are what matter — the latter is also what makes the integration's interceptor replace the
   * binary body with a stub in the audit record instead of storing it inline. */
  const pdf =
    '%PDF-1.7\n' +
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
    '2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n' +
    `% synthetic harness TRF for ${params.clinicAccessionId}\n` +
    'trailer\n<< /Root 1 0 R >>\n%%EOF\n'
  sendPdf(res, 200, pdf)
}

/* ---- placement ----
 *
 * Both endpoints take the SAME body (`AntechV6PreOrder`, with the order variant adding weight
 * fields), and the integration chooses between them: a real order only when the request asked for
 * autoSubmitOrder, the integration option allows it, AND every ordered code is POC per the test
 * guide. Otherwise a pre-order (a draft).
 *
 * VALIDATE, NEVER DEFAULT. Every field below is one the scenario later asserts on or one the
 * provider genuinely needs; filling in a missing one would make this mock agree with an
 * integration that had stopped sending it, and the assertion downstream would then pass against
 * the mock's own invention. */
function validatePlacement (res, body) {
  if (!requireClinicId(res, body.ClinicID, 'ClinicID')) return null

  /* INVENTED wording (the envelope is OBSERVED): only `Invalid BreedId <n>` was ever seen. */
  const missing = []
  for (const field of ['ClinicAccessionID', 'PetName', 'ClientLastName']) {
    if (typeof body[field] !== 'string' || body[field].trim() === '') missing.push(field)
  }
  for (const field of ['SpeciesID', 'BreedID']) {
    if (typeof body[field] !== 'number' || !Number.isFinite(body[field])) missing.push(field)
  }
  if (!Array.isArray(body.OrderCodes) || body.OrderCodes.length === 0) missing.push('OrderCodes')
  if (missing.length > 0) {
    sendPlacementRejection(res, `Missing or invalid required field(s): ${missing.join(', ')}`)
    return null
  }

  if (state.orders.has(body.ClinicAccessionID)) {
    /* INVENTED. The practice's own accession id is its unique reference; refusing a duplicate stops
     * the mock silently overwriting an order that may already carry results. Whether the live
     * endpoint refuses or overwrites is unverified. */
    sendPlacementRejection(res, `Duplicate ClinicAccessionID ${body.ClinicAccessionID}`)
    return null
  }

  const species = SPECIES_BY_ID.get(body.SpeciesID)
  if (species === undefined) {
    /* INVENTED wording, mirroring the observed BreedId message. */
    sendPlacementRejection(res, `Invalid SpeciesId ${body.SpeciesID}`)
    return null
  }
  const breed = species.breed.find((entry) => entry.id === body.BreedID)
  if (breed === undefined) {
    /* OBSERVED VERBATIM, and the reason the species tree above is kept self-consistent: the
     * integration's own fallback pair is 49 + 370, and 370 is species 41's breed, so a fully
     * unmapped patient is refused here exactly as it is refused live. */
    sendPlacementRejection(res, `Invalid BreedId ${body.BreedID}`)
    return null
  }

  /* The sex vocabulary the integration's `AntechV6PetSex` declares and `mapPatientSex` produces.
   * INVENTED enforcement: an unmapped sex becomes `U` rather than garbage, so this can only fire on
   * a genuine regression — which is the point of having it. */
  if (!['M', 'F', 'CM', 'SF', 'U'].includes(body.PetSex)) {
    sendPlacementRejection(res, `Invalid PetSex ${body.PetSex}`)
    return null
  }
  if (!['Y', 'M', 'W', 'D'].includes(body.PetAgeUnits)) {
    sendPlacementRejection(res, `Invalid PetAgeUnits ${body.PetAgeUnits}`)
    return null
  }
  if (body.LabID !== undefined && Number(body.LabID) !== LAB_ID) {
    sendPlacementRejection(res, `Invalid LabId ${body.LabID}`)
    return null
  }

  /* The catalogue, enforced. An invented code that both the mock and the scenario agreed on would
   * be evidence about the author, not about Antech — so the codes an order may carry are exactly
   * the ones `/Tests/v6` advertises. INVENTED wording. */
  const unknownCodes = body.OrderCodes.filter((code) => !TEST_BY_CODE.has(code))
  if (unknownCodes.length > 0) {
    sendPlacementRejection(res, `Invalid OrderCode ${unknownCodes.join(', ')}`)
    return null
  }

  return { species, breed }
}

function recordPlacement (body, kind) {
  const now = new Date()
  const iso = now.toISOString().replace(/\.\d{3}Z$/, '')
  const order = {
    clinicAccessionId: body.ClinicAccessionID,
    vendorId: String(nextVendorId++),
    kind,
    labAccessionId: kind === 'order' ? mintLabAccessionId() : null,
    orderStatus: kind === 'order' ? ORDER_STATUS_SUBMITTED : null,
    resultStatus: kind === 'order' ? RESULT_STATUS_IN_PROGRESS : null,
    orderDate: iso,
    createdDate: iso,
    placedAt: now.toISOString(),
    promotedAt: null,
    latestResultReceivedDate: null,
    orderAcked: false,
    orderAckedAt: null,
    orderAckedStatus: null,
    orderAckCount: 0,
    resultStatusAcked: false,
    resultAckCount: 0,
    trfFetches: 0,
    clinicId: String(body.ClinicID),
    labId: body.LabID === undefined ? null : Number(body.LabID),
    /* Echoed straight back from the request — every one of these was validated above, so none is a
     * mock-invented value a scenario could accidentally be asserting against itself. The
     * species/breed/sex trio matters most: those are the only order fields dmi-api TRANSFORMS on
     * the way to the provider (canonical dmi ref -> antech-v6 provider_ref code), so what arrived
     * here is the only evidence that the mapping ran. */
    pet: {
      id: body.PetID ?? null,
      name: body.PetName,
      sex: body.PetSex,
      age: body.PetAge ?? null,
      ageUnits: body.PetAgeUnits ?? null,
      weight: body.PetWeight ?? null,
      weightUnits: body.PetWeightUnits ?? null,
      speciesId: body.SpeciesID,
      breedId: body.BreedID,
    },
    client: {
      id: body.ClientID ?? null,
      firstName: body.ClientFirstName ?? '',
      lastName: body.ClientLastName,
    },
    doctor: {
      id: body.DoctorID ?? null,
      firstName: body.DoctorFirstName ?? '',
      lastName: body.DoctorLastName ?? '',
    },
    orderCodes: [...body.OrderCodes],
    resultLabAccessionId: null,
  }
  state.orders.set(order.clinicAccessionId, order)
  return order
}

function mintLabAccessionId () {
  return `${LAB_ACCESSION_PREFIX}${String(nextLabAccessionSeq++).padStart(8, '0')}`
}

/* POST /LabOrders/v6/PreOrderPlacement — the DRAFT path.
 *
 * Response OBSERVED: `{ Value: '<numeric id string>', StatusCode: 200 }`. The integration uses the
 * response only for the `Token` it already holds (string-built into the order's `submissionUri`)
 * and discards `Value` — it keys everything on the ClinicAccessionID it sent. The resulting dmi
 * order is WAITING_FOR_INPUT.
 *
 * A draft enters NEITHER status feed and has NO TRF (load-bearing detail 6). */
async function handlePreOrderPlacement (req, res) {
  if (requireHeaderToken(req, res) == null) return
  state.calls.preOrderPlacement += 1

  const scenario = takeScenario('placePreOrder')
  if (scenario != null) {
    sendScenario(res, scenario, () => sendPlacementRejection(res, 'Injected pre-order placement failure'))
    return
  }

  const body = await readJson(req)
  if (validatePlacement(res, body) == null) return

  const order = recordPlacement(body, 'preorder')
  log(
    `pre-order placed ClinicAccessionID=${order.clinicAccessionId} Value=${order.vendorId} ` +
      `codes=${order.orderCodes.join(',')} SpeciesID=${order.pet.speciesId} BreedID=${order.pet.breedId} PetSex=${order.pet.sex}`,
  )
  sendJson(res, 200, { Value: order.vendorId, StatusCode: 200 })
}

/* POST /LabOrders/v6/Order — the REAL order path, taken only for an auto-submitted POC-only order.
 *
 * Response OBSERVED: `{payload: {requisitionId}, status, message, isSuccess, requestId}`. Note
 * `payload` is an OBJECT while the integration's interface declares it a `string`; nothing breaks
 * because nothing reads it — `createOrder` throws the placement response away and maps the REQUEST
 * instead. Reproduced as the wire sends it rather than as the interface declares it. */
async function handleOrderPlacement (req, res) {
  if (requireHeaderToken(req, res) == null) return
  state.calls.orderPlacement += 1

  const scenario = takeScenario('placeOrder')
  if (scenario != null) {
    sendScenario(res, scenario, () => sendPlacementRejection(res, 'Injected order placement failure'))
    return
  }

  const body = await readJson(req)
  if (validatePlacement(res, body) == null) return

  const order = recordPlacement(body, 'order')
  log(
    `order placed ClinicAccessionID=${order.clinicAccessionId} LabAccessionID=${order.labAccessionId} ` +
      `requisitionId=${order.vendorId} codes=${order.orderCodes.join(',')} ` +
      `SpeciesID=${order.pet.speciesId} BreedID=${order.pet.breedId} PetSex=${order.pet.sex}`,
  )
  sendJson(res, 200, {
    payload: { requisitionId: order.vendorId },
    status: 200,
    message: 'Lab requisition submitted successfully',
    isSuccess: true,
    requestId: randomUUID(),
  })
}

/* ---- control plane (/__control__) ---- */

function publicOrder (order) {
  return {
    clinicAccessionId: order.clinicAccessionId,
    vendorId: order.vendorId,
    kind: order.kind,
    labAccessionId: order.labAccessionId,
    orderStatus: order.orderStatus,
    resultStatus: order.resultStatus,
    orderAcked: order.orderAcked,
    orderAckedStatus: order.orderAckedStatus,
    orderAckCount: order.orderAckCount,
    resultStatusAcked: order.resultStatusAcked,
    resultAckCount: order.resultAckCount,
    /* How many times the integration fetched this order's TRF. Zero is the assertion for a
     * POC-only order; >= 1 is the assertion for a reference-lab one. */
    trfFetches: order.trfFetches,
    clinicId: order.clinicId,
    labId: order.labId,
    petId: order.pet.id,
    petName: order.pet.name,
    petSex: order.pet.sex,
    petAge: order.pet.age,
    petAgeUnits: order.pet.ageUnits,
    petWeight: order.pet.weight,
    petWeightUnits: order.pet.weightUnits,
    /* NUMBERS, as they arrived. `toBe(41)` on a stringified '41' fails, which is deliberate: the
     * integration parseInts the mapped provider code, and a mock that stringified it on the way
     * back out would make that unobservable. */
    speciesId: order.pet.speciesId,
    breedId: order.pet.breedId,
    clientId: order.client.id,
    clientFirstName: order.client.firstName,
    clientLastName: order.client.lastName,
    doctorId: order.doctor.id,
    doctorFirstName: order.doctor.firstName,
    doctorLastName: order.doctor.lastName,
    orderCodes: order.orderCodes,
    hasResult: order.resultLabAccessionId != null,
    resultServedCount: order.resultLabAccessionId != null ? state.results.get(order.resultLabAccessionId)?.servedCount ?? 0 : 0,
    resultAcknowledged: order.resultLabAccessionId != null ? state.results.get(order.resultLabAccessionId)?.acknowledged ?? false : false,
    placedAt: order.placedAt,
    promotedAt: order.promotedAt,
  }
}

function handleControlGetOrder (req, res, params) {
  const order = state.orders.get(params.clinicAccessionId)
  if (order == null) {
    sendJson(res, 404, { message: `no order for ClinicAccessionID ${params.clinicAccessionId}` })
    return
  }
  sendJson(res, 200, publicOrder(order))
}

function handleControlListOrders (req, res) {
  const orders = [...state.orders.values()].map(publicOrder)
  sendJson(res, 200, { count: orders.length, orders })
}

/* Promote a DRAFT to a real order — the clinic finishing, in Antech's own UI, the pre-order the
 * engine created.
 *
 * This is a CONTROL-PLANE action, not a provider endpoint, and it is labelled so on purpose: the
 * engine has no observable signal for the draft -> order transition (OBSERVED — a pre-order appears
 * in none of the four status views), so the transition genuinely happens out of band. What the mock
 * claims is only what was observed on either side of it: a draft is invisible and has no TRF; a
 * real order is in the feed as `Submitted`, carries a LabAccessionID, and has a TRF. */
async function handleControlPromote (req, res, params) {
  const body = await readJson(req)
  const order = state.orders.get(params.clinicAccessionId)
  if (order == null) {
    sendJson(res, 404, { message: `no order for ClinicAccessionID ${params.clinicAccessionId}` })
    return
  }
  if (order.kind !== 'preorder') {
    sendJson(res, 400, { message: `${params.clinicAccessionId} is already a placed order, not a draft` })
    return
  }

  const orderStatus = body.orderStatus ?? ORDER_STATUS_SUBMITTED
  if (!ORDER_STATUS_VALUES.includes(orderStatus)) {
    sendJson(res, 400, { message: `orderStatus must be one of ${ORDER_STATUS_VALUES.join(', ')}` })
    return
  }

  order.kind = 'order'
  order.labAccessionId = mintLabAccessionId()
  order.orderStatus = orderStatus
  order.resultStatus = RESULT_STATUS_IN_PROGRESS
  order.promotedAt = new Date().toISOString()
  order.createdDate = new Date().toISOString().replace(/\.\d{3}Z$/, '')
  log(`promoted draft ${order.clinicAccessionId} to an order (LabAccessionID=${order.labAccessionId}, OrderStatus=${order.orderStatus})`)
  sendJson(res, 200, publicOrder(order))
}

/* Set an order's `OrderStatus`, optionally re-offering it on the `overrideAck=false` feed.
 *
 * `replay` is a HARNESS action and is not a claim about the provider: OBSERVED, an order whose
 * status changed did NOT return to the `overrideAck=false` feed, so this mock does not re-notify on
 * its own. A test that needs the orders channel to carry a later status has to ask for the record
 * to be offered again, explicitly, and that explicitness is the point — it keeps the mock's normal
 * behaviour faithful while still letting a scenario reach the integration's status mapping. */
async function handleControlSetStatus (req, res, params) {
  const body = await readJson(req)
  const order = state.orders.get(params.clinicAccessionId)
  if (order == null) {
    sendJson(res, 404, { message: `no order for ClinicAccessionID ${params.clinicAccessionId}` })
    return
  }
  if (order.kind !== 'order') {
    sendJson(res, 400, { message: `${params.clinicAccessionId} is a draft; promote it before setting a status` })
    return
  }
  if (!ORDER_STATUS_VALUES.includes(body.orderStatus)) {
    sendJson(res, 400, {
      message: `orderStatus must be one of ${ORDER_STATUS_VALUES.join(', ')} (they are STRINGS on the wire — see the mock's header)`,
    })
    return
  }
  if (body.resultStatus !== undefined && !RESULT_STATUS_VALUES.includes(body.resultStatus)) {
    sendJson(res, 400, { message: `resultStatus must be one of ${RESULT_STATUS_VALUES.join(', ')}` })
    return
  }

  order.orderStatus = body.orderStatus
  if (body.resultStatus !== undefined) order.resultStatus = body.resultStatus
  if (body.replay !== false) {
    order.orderAcked = false
    order.orderAckedStatus = null
  }
  /* Keep any already-served result document's OrderStatus in step: it is the same order. */
  if (order.resultLabAccessionId != null) {
    const result = state.results.get(order.resultLabAccessionId)
    if (result != null) result.document.OrderStatus = order.orderStatus
  }
  log(`control: ${order.clinicAccessionId} OrderStatus=${order.orderStatus} replay=${body.replay !== false}`)
  sendJson(res, 200, publicOrder(order))
}

/* Seed (or amend) the result document the GetAllResults feed will serve for an order.
 *
 * The mock holds NO results until a test seeds one, which is what makes the loop deterministic.
 * Body:
 *   unitCodeResults: [{ orderCode, unitCodeDisplayName, profileDisplayName, unitCodeExtID,
 *                       resultStatus, category, analyzerName,
 *                       testCodeResults: [{ test, testCodeExtID, result, unit, range,
 *                                           abnormalFlag, comments }] }]
 *   pendingTestCount, totalTestCount   -> drive the mapper's result status
 *   corrected                          -> non-empty means REVISED
 *   orderStatus, resultStatus          -> the order's provider-side status after the result lands
 *
 * The `pendingTestCount`/`totalTestCount`/`corrected` trio is the WHOLE of the integration's result
 * status decision (`extractResultStatus`): 0 pending -> COMPLETED, some pending -> PARTIAL,
 * `Corrected` non-empty -> REVISED. Nothing else is consulted, including the per-unit
 * `ResultStatus`. */
async function handleControlSeedResult (req, res, params) {
  const body = await readJson(req)
  const order = state.orders.get(params.clinicAccessionId)
  if (order == null) {
    sendJson(res, 404, { message: `no order for ClinicAccessionID ${params.clinicAccessionId}` })
    return
  }
  if (order.kind !== 'order') {
    sendJson(res, 400, {
      message: `${params.clinicAccessionId} is a pre-order (a draft). A draft produces no results at the provider; promote it first.`,
    })
    return
  }

  const seeds = Array.isArray(body.unitCodeResults) && body.unitCodeResults.length > 0
    ? body.unitCodeResults
    : defaultUnitCodeResults()

  /* Control-plane validation, with explanations. These are HARNESS rules, not provider ones — they
   * exist because breaking one produces a silent poll timeout or a silently thinner report rather
   * than anything legible, and the next author should not have to rediscover that. */
  const codes = new Set()
  for (const seed of seeds) {
    if (typeof seed.orderCode !== 'string' || !TEST_BY_CODE.has(seed.orderCode)) {
      sendJson(res, 400, {
        message:
          `unitCodeResults[].orderCode must be a catalogue mnemonic (got '${seed.orderCode}'; ` +
          `known: ${[...TEST_BY_CODE.keys()].join(', ')}). The integration keys each mapped test ` +
          'result on OrderCode, and it also selects the CBC re-sequencing table by it.',
      })
      return
    }
    const items = seed.testCodeResults ?? []
    if (!Array.isArray(items)) {
      sendJson(res, 400, { message: 'unitCodeResults[].testCodeResults must be an array' })
      return
    }
    for (const item of items) {
      if (typeof item.test !== 'string' || item.test === '') {
        sendJson(res, 400, { message: 'testCodeResults[].test (the analyte name) is required' })
        return
      }
      if (typeof item.testCodeExtID !== 'string' || item.testCodeExtID === '') {
        sendJson(res, 400, { message: 'testCodeResults[].testCodeExtID (the analyte code) is required' })
        return
      }
      if (item.abnormalFlag !== undefined && !ABNORMAL_FLAG_VALUES.includes(item.abnormalFlag)) {
        sendJson(res, 400, {
          message: `testCodeResults[].abnormalFlag must be one of ${ABNORMAL_FLAG_VALUES.map((flag) => `'${flag}'`).join(', ')}`,
        })
        return
      }
      const key = `${seed.orderCode}/${item.testCodeExtID}`
      if (codes.has(key)) {
        sendJson(res, 400, {
          message:
            `duplicate testCodeExtID '${item.testCodeExtID}' under OrderCode '${seed.orderCode}'. ` +
            'dmi-api keys a report observation on the item code and updates matches IN PLACE, so a ' +
            'duplicate silently collapses into one observation instead of failing.',
        })
        return
      }
      codes.add(key)
    }
  }

  const now = new Date()
  const iso = now.toISOString().replace(/\.\d{3}Z$/, '')
  const pendingTestCount = body.pendingTestCount ?? 0
  const totalTestCount = body.totalTestCount ?? seeds.length
  const corrected = body.corrected ?? ''

  /* A result that lands moves the order's provider-side status. Faithful: a real Antech order with
   * final results reports `Final`. It does NOT clear the order acknowledgement, so a record the
   * orders channel has already acked stays out of the `overrideAck=false` feed — which is why the
   * scenario can claim that only the RESULTS channel can have completed the order. */
  const orderStatus = body.orderStatus ?? (pendingTestCount > 0 ? 'Partial' : 'Final')
  if (!ORDER_STATUS_VALUES.includes(orderStatus)) {
    sendJson(res, 400, { message: `orderStatus must be one of ${ORDER_STATUS_VALUES.join(', ')}` })
    return
  }
  const resultStatus = body.resultStatus ?? (corrected !== '' ? 'C' : pendingTestCount > 0 ? 'P' : 'F')
  if (!RESULT_STATUS_VALUES.includes(resultStatus)) {
    sendJson(res, 400, { message: `resultStatus must be one of ${RESULT_STATUS_VALUES.join(', ')}` })
    return
  }

  order.orderStatus = orderStatus
  order.resultStatus = resultStatus
  order.latestResultReceivedDate = iso

  const existing = order.resultLabAccessionId != null ? state.results.get(order.resultLabAccessionId) : null
  const resultId = existing?.document?.ID ?? Number(String(Date.now()).slice(-9))

  const document = {
    ID: resultId,
    Clinic: {
      ClinicID: Number(CLINIC_ID),
      LabId: LAB_ID,
      ClinicExtId: CLINIC_EXT_ID,
      HasUsers: true,
    },
    LabAccessionID: order.labAccessionId,
    /* Non-empty, so `isOrphanResult` is false and the mapper attaches no `.order` — which is what
     * keeps antech-v6 reconciliation purely `externalId == ClinicAccessionID` and out of dmi-api's
     * patient-matching guard entirely. */
    ClinicAccessionID: order.clinicAccessionId,
    ReportedDateTime: iso,
    LatestAccessionUpdate: iso,
    CorrectedTestCount: corrected !== '' ? seeds.length : 0,
    ReceivedDateTime: order.createdDate,
    ProfileDisplay: seeds.map((seed) => seed.profileDisplayName ?? seed.unitCodeDisplayName ?? seed.orderCode).join(', '),
    TestDescription: seeds.map((seed) => seed.unitCodeDisplayName ?? seed.orderCode).join(', '),
    /* A STRING, like every other OrderStatus on this wire. */
    OrderStatus: order.orderStatus,
    /* '' normally; a non-empty string means the result is a correction, and the mapper reports
     * REVISED for it regardless of the counts. */
    Corrected: corrected,
    PendingTestCount: pendingTestCount,
    TotalTestCount: totalTestCount,
    ViewedDateTime: '',
    ReleasedDateTime: iso,
    UnitCodeResults: seeds.map((seed, index) => ({
      UnitCodeResultID: `${order.labAccessionId}-${index + 1}`,
      UnitCodeID: 590000 + index,
      ProfileExtID: seed.profileExtID ?? seed.unitCodeExtID ?? TEST_BY_CODE.get(seed.orderCode).ExtensionID,
      UnitCodeExtID: seed.unitCodeExtID ?? TEST_BY_CODE.get(seed.orderCode).ExtensionID,
      ReleasedDateTime: iso,
      ViewedDateTime: '',
      /* Typed as an object in the integration's interface and sent as a STRING on the wire; the
       * mapper works around its own type with `.toString() === 'F'`. Serving the string is what the
       * provider does. */
      ResultStatus: seed.resultStatus ?? 'F',
      OrderControlStatus: 'RE',
      /* The key the integration uses for the mapped test result — and the key it looks up in its
       * CBC re-sequencing table. `UnitCodeExtID` is the fallback when this is absent. */
      OrderCode: seed.orderCode,
      UnitCodeDisplayName: seed.unitCodeDisplayName ?? TEST_BY_CODE.get(seed.orderCode).ReportingTitle,
      ProfileDisplayName: seed.profileDisplayName ?? TEST_BY_CODE.get(seed.orderCode).ReportingTitle,
      UnitCodeType: 'U',
      UCType: 'P',
      AnalyzerName: seed.analyzerName ?? TEST_BY_CODE.get(seed.orderCode).AnalyzerID,
      Category: seed.category ?? TEST_BY_CODE.get(seed.orderCode).Category,
      AccessionResultID: resultId + index,
      TestCodeResults: (seed.testCodeResults ?? []).map((item, itemIndex) => {
        const testCodeResult = {
          TestCodeID: String(591000 + itemIndex),
          TestCodeResultID: `${order.labAccessionId}-${index + 1}-${itemIndex + 1}`,
          /* The mapper branches on whether this parses as a number: numeric -> a valueQuantity
           * with `Unit`, anything else -> a valueString. */
          Result: String(item.result ?? ''),
          TestCodeExtID: item.testCodeExtID,
          Test: item.test,
          UnitCodeID: String(590000 + index),
          SortOrder: itemIndex + 1,
          TestType: item.testType ?? 'N',
          ReportComments: item.reportComments ?? [],
        }
        /* Absent rather than empty when there is nothing to say — which is how the wire does it,
         * and it matters: the mapper only emits a reference range when `Range` is not undefined,
         * and only an interpretation when `AbnormalFlag` is non-empty. */
        if (item.unit !== undefined) testCodeResult.Unit = item.unit
        if (item.range !== undefined) testCodeResult.Range = item.range
        if (item.abnormalFlag !== undefined) testCodeResult.AbnormalFlag = item.abnormalFlag
        if (item.comments !== undefined) testCodeResult.Comments = item.comments
        if (item.min !== undefined) testCodeResult.Min = item.min
        if (item.max !== undefined) testCodeResult.Max = item.max
        return testCodeResult
      }),
    })),
    Doctor: { Id: order.doctor.id, FirstName: order.doctor.firstName, LastName: order.doctor.lastName },
    Pet: { Id: order.pet.id, Name: order.pet.name },
    Client: { Id: order.client.id, FirstName: order.client.firstName, LastName: order.client.lastName },
  }

  /* Re-seeding an order amends its result in place and makes it PENDING AGAIN on the feed, which is
   * how a lab delivers a correction or completes a partial panel. The served/ack counters carry
   * over so a test can still prove how many times the document was delivered. */
  state.results.set(order.labAccessionId, {
    clinicAccessionId: order.clinicAccessionId,
    labAccessionId: order.labAccessionId,
    document,
    acknowledged: false,
    acknowledgedAt: null,
    servedCount: existing?.servedCount ?? 0,
    ackCount: existing?.ackCount ?? 0,
  })
  order.resultLabAccessionId = order.labAccessionId
  order.resultStatusAcked = false

  log(
    `seeded result for ClinicAccessionID=${order.clinicAccessionId} LabAccessionID=${order.labAccessionId} ` +
      `units=${seeds.length} pending=${pendingTestCount}/${totalTestCount} corrected='${corrected}' OrderStatus=${order.orderStatus}`,
  )
  sendJson(res, 201, {
    seeded: true,
    clinicAccessionId: order.clinicAccessionId,
    labAccessionId: order.labAccessionId,
    orderStatus: order.orderStatus,
    resultStatus: order.resultStatus,
    pendingTestCount,
    totalTestCount,
    corrected,
    unitCodeResults: document.UnitCodeResults.map((unit) => ({
      orderCode: unit.OrderCode,
      analytes: unit.TestCodeResults.map((item) => item.Test),
    })),
  })
}

function handleControlResultState (req, res, params) {
  const order = state.orders.get(params.clinicAccessionId)
  if (order == null || order.resultLabAccessionId == null) {
    sendJson(res, 404, { message: `no seeded result for ClinicAccessionID ${params.clinicAccessionId}` })
    return
  }
  const result = state.results.get(order.resultLabAccessionId)
  sendJson(res, 200, {
    clinicAccessionId: result.clinicAccessionId,
    labAccessionId: result.labAccessionId,
    acknowledged: result.acknowledged,
    acknowledgedAt: result.acknowledgedAt,
    /* How many GetAllResults responses carried this document, and how many AckStatus calls named
     * it. With the acknowledge semantics working, both settle at exactly 1 — which is the
     * assertion that catches a mock (or an integration) that stopped draining the feed. */
    servedCount: result.servedCount,
    ackCount: result.ackCount,
  })
}

async function handleControlScenario (req, res) {
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

const routes = [
  ['GET', /^\/status$/, (req, res) => sendJson(res, 200, { status: 'ok', service: 'antech-v6-mock' })],
  ['GET', /^\/health$/, (req, res) => sendJson(res, 200, { status: 'ok' })],

  /* Provider endpoints, at the paths `AntechV6Endpoints` declares — appended to the provider
   * configuration's baseUrl with no prefix of their own. */
  ['POST', /^\/Users\/v6\/Login$/, handleLogin],
  ['GET', /^\/LabResults\/v6\/GetStatus$/, handleGetStatus],
  ['GET', /^\/LabResults\/v6\/GetAllResults$/, handleGetAllResults],
  ['GET', /^\/LabResults\/v6\/OrphanResults$/, handleOrphanResults],
  ['POST', /^\/LabResults\/v6\/AckStatus$/, handleAckStatus],
  ['GET', /^\/Master\/v6\/GetSpeciesBreed$/, handleSpeciesBreed],
  ['GET', /^\/Tests\/v6$/, handleTestGuide],
  ['GET', /^\/HTPDF\/trf\/pims\/(?<clinicAccessionId>[^/]+)$/, handleTrf],
  ['POST', /^\/LabOrders\/v6\/PreOrderPlacement$/, handlePreOrderPlacement],
  ['POST', /^\/LabOrders\/v6\/Order$/, handleOrderPlacement],

  /* Control plane. Host-facing only; the integration never sees these. */
  [
    'GET',
    /^\/__control__\/config$/,
    (req, res) =>
      sendJson(res, 200, {
        /* The clinic and lab this mock is provisioned for. The scenario asserts these against the
         * provider configuration it seeds, so a harness whose two halves drifted apart fails at
         * setup with a name rather than as an empty feed an hour later. */
        clinicId: CLINIC_ID,
        labId: LAB_ID,
        userId: USER_ID,
        pocCodes: POC_CODES,
        referenceLabCodes: REFERENCE_LAB_CODES,
        species: SPECIES_TREE.map((species) => ({
          id: species.id,
          name: species.name,
          breedIds: species.breed.map((breed) => breed.id),
        })),
        orderStatusValues: ORDER_STATUS_VALUES,
      }),
  ],
  [
    'GET',
    /^\/__control__\/catalogue$/,
    (req, res) =>
      sendJson(res, 200, {
        tests: TEST_GUIDE.map((test) => ({
          code: test.Code,
          name: test.ReportingTitle,
          description: test.ClientFacingDescription,
          category: test.Category,
          price: test.Price,
          pointOfCare: test.POC_Flag === 'Y',
          labId: test.LabID,
        })),
      }),
  ],
  ['GET', /^\/__control__\/calls$/, (req, res) => sendJson(res, 200, { ...state.calls, maxLabAccessionIdsInOneAck: state.maxLabAccessionIdsInOneAck })],
  [
    'GET',
    /^\/__control__\/tokens\/(?<token>[^/]+)$/,
    (req, res, params) =>
      sendJson(res, 200, {
        issued: state.tokens.has(params.token),
        /* So a scenario can prove the token string-built into a pre-order's submissionUri came out
         * of a real login rather than being invented somewhere in the chain. */
        userId: state.tokens.get(params.token)?.userId ?? null,
      }),
  ],
  ['GET', /^\/__control__\/tokens$/, (req, res) => sendJson(res, 200, { count: state.tokens.size })],

  ['POST', /^\/__control__\/orders\/(?<clinicAccessionId>[^/]+)\/results$/, handleControlSeedResult],
  ['GET', /^\/__control__\/orders\/(?<clinicAccessionId>[^/]+)\/result$/, handleControlResultState],
  ['POST', /^\/__control__\/orders\/(?<clinicAccessionId>[^/]+)\/promote$/, handleControlPromote],
  ['POST', /^\/__control__\/orders\/(?<clinicAccessionId>[^/]+)\/status$/, handleControlSetStatus],
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
    const params = Object.fromEntries(
      Object.entries(match.groups || {}).map(([key, value]) => [key, decodeURIComponent(value)]),
    )
    try {
      await handler(req, res, params, url.searchParams)
    } catch (error) {
      log(`handler error on ${req.method} ${pathname}: ${error.stack || error}`)
      if (!res.headersSent) sendJson(res, 500, { StatusCode: 500, ErrorMessage: 'Internal server error' })
    }
    return
  }

  /* OBSERVED: an unknown path is `{statusCode, message}` — neither key one the integration's error
   * mapper reads, so a typo'd endpoint surfaces to an operator as a bare `Failed to GET <url>`. */
  sendNotFound(res, `no route for ${req.method} ${pathname}`)
})

server.listen(PORT, () => log(`listening on :${PORT} (clinic ${CLINIC_ID}, lab ${LAB_ID})`))
