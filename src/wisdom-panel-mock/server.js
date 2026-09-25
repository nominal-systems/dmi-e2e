'use strict'

/* Wisdom Panel mock provider for the dmi-e2e full-stack harness. A zero-dependency Node HTTP server
 * that speaks Wisdom Panel's API closely enough for the REAL
 * `dmi-engine-wisdom-panel-integration` — hosted, as production hosts it, inside the `dmi-engine`
 * container — to drive it unmodified: the OAuth2 password grant, the two JSON:API polling feeds
 * (kits and result-sets), the simplified genetic results, the binary vet report, both acknowledge
 * channels, and kit ACTIVATION (which is what an "order" is for this provider). A separate control
 * plane (`/__control__/*`) lets tests provision provider-side kits, seed result sets, fail the PDF
 * generator, revoke bearers and inspect what the mock received, so the
 * order -> result -> report loop is deterministic and CI-safe.
 *
 * It NEVER talks to a live Wisdom Panel host and never authenticates for real. Every kit code,
 * hospital, veterinarian, pet, owner and genetic finding here is SYNTHETIC — invented values shaped
 * like the vendor's responses, never captured clinic or patient data. Unlike the other loops there
 * is no vendor CATALOGUE vocabulary to reuse: this provider has no test catalogue at all (its
 * "services" are the unactivated kits a clinic physically holds, so a "service code" is a per-kit
 * identifier), so the kit codes below are invented too. Breed slugs, disease names and the
 * analyte-style vocabulary of the simplified result are reference vocabulary, not identity.
 *
 * ---------------------------------------------------------------------------------------------
 * WHERE THE CONTRACT COMES FROM
 *
 * Two sources, called out separately at every handler because they carry different weight:
 *
 *   (a) The integration's own source — `interfaces/wisdom-panel-api-endpoints.interface.ts`
 *       (the seven endpoints), `wisdom-panel-api/wisdom-panel-api.service.ts` (auth, the filter and
 *       include parameters, the two ack bodies, the arraybuffer PDF read),
 *       `wisdom-panel-api/wisdom-panel-api.interceptor.ts` (what it dereferences on every page),
 *       `services/wisdom-panel.service.ts` (the two polls, the per-result-set fan-out, getServices),
 *       `providers/wisdom-panel-mapper.ts` + `common/mapper-utils.ts` (the activation body, the
 *       status rule and the result mapping), `exceptions/wisdom-api.exception.ts` (which envelope
 *       fields reach the operator).
 *   (b) A live probe of the provider's DEVELOPMENT endpoint, read-only apart from one gated
 *       acknowledge round. Everything marked OBSERVED below was seen there; anything marked
 *       INFERRED (read out of (a), never seen on the wire) or INVENTED (neither — the mock had to
 *       choose something) says so at its own handler.
 *
 * The mock is built from (b) where the two disagree, because (a) is the thing under test.
 *
 * ---------------------------------------------------------------------------------------------
 * THE LOAD-BEARING DETAILS, in the order they will bite someone
 *
 * 1. `included` IS OMITTED, NEVER EMPTY. OBSERVED: JSON:API leaves the key out entirely when no
 *    resource in the page carries the requested relationship — on an empty page AND on a NON-empty
 *    page whose kits are all pet-less (an unactivated kit has no pet, and a clinic that has been
 *    shipped kits it has not used yet is exactly that page). The integration's `getBatchOrders`
 *    does `response.included.find(...)` with no guard, so that page is a TypeError for it. Emitting
 *    `included: []` would prove the integration correct and is the single most important thing this
 *    mock must not do.
 *
 * 2. `meta['record-count']` IS ALWAYS PRESENT. OBSERVED on every page. The integration's audit
 *    interceptor reads `res.data.meta['record-count']` unguarded on both feeds to decide whether to
 *    record the page, so a page without it kills BOTH polls inside the logging interceptor.
 *
 * 3. THE API SPEAKS TWO DIALECTS, and a mock that picks one house style leaves half the
 *    integration's error handling unexercised. JSON:API `{errors: [{title, detail, code, status}]}`
 *    on `/api/v1/*` — where `code` is a NUMBER on the 401 and a STRING on the 400, OBSERVED, and
 *    reproduced here rather than tidied — versus plain `{message}` on `/api/voyager/*`, versus RFC
 *    6749 `{error, error_description}` on `/oauth/token`, versus a bare `text/html` body on the PDF
 *    generator's 404. Only the JSON:API `errors[]` and the voyager `message` reach an operator
 *    (`WisdomApiException` unwinds exactly those two off the raw body).
 *
 * 4. THIS IS A STRICT JSON:API IMPLEMENTATION and the integration only passes by luck. OBSERVED on
 *    `/api/v1/*`: `Accept` absent -> 200; any value containing the total wildcard range (written
 *    `*[/]*` in these comments only because a literal one would close them) -> 200; exactly
 *    `application/vnd.api+json` -> 200; a bare `application/json` -> **406**;
 *    `application/vnd.api+json; charset=utf-8` -> 406 (a media-type parameter is enough). The
 *    integration sets no `Accept` at all, so axios's default `application/json, text/plain, *[/]*`
 *    arrives and is accepted for the wildcard in it. The rule is enforced here precisely so that a
 *    well-meant `Accept: application/json` tidy-up in the integration is a red build rather than a
 *    production outage.
 *
 * 5. THE TOKEN IS CACHED FOR TEN DAYS AND NEVER REFRESHED ON A 401. OBSERVED: `expires_in` is
 *    3456000 s (40 days) and the integration caches the token for `expires_in x 0.25`. It never
 *    re-authenticates on a 401. So (a) this mock honours every token it has ever issued for the
 *    life of the process — an expiring mock token would break the loop for a reason the vendor
 *    would not produce; and (b) "revoking" a credential is a control-plane switch
 *    (`POST /__control__/bearer {"accept": false}`) that makes the mock reject bearers it still
 *    knows, and switching it back ON must make the SAME tokens valid again, because the engine will
 *    never come back for new ones.
 *
 * 6. ACKNOWLEDGE IS A FILTER, NOT A DELETE, AND THE TWO CHANNELS ARE INDEPENDENT. OBSERVED: an
 *    acknowledged kit still answers an unfiltered query; acking a result set does not acknowledge
 *    its kit, nor the reverse. Both channels answer **201** (not 204) with a body that names the
 *    counterpart id, and a DUPLICATE ack is 201 with a byte-identical body — there is NO 409 in
 *    this API. The obvious move when writing this file was to copy the zoetis mock, whose duplicate
 *    ack is a 409; that would have been fiction.
 *
 * 7. THE ACTIVATION BODY IS snake_case WHILE THE READ SIDE IS kebab-case. One API, two casings.
 *    `POST /api/voyager/pet` carries `{data: {organization_unit_id, code, species, name, sex,
 *    intact, voyager_pet_id, ...}}`; the feeds carry `'current-stage'`, `'owner-first-name'` and so
 *    on. Getting either wrong is silent: the mapper reads what it reads.
 *
 * 8. THE SIMPLIFIED RESULT COMES IN THREE SHAPES, ALL OBSERVED, and the mapper treats them very
 *    differently. A key-only scan of the development endpoint's unacknowledged result sets found:
 *      - most carrying `notable_and_at_risk_health_test_results` as a plain STRING;
 *      - one carrying it as an ARRAY with a finding entry;
 *      - a sizeable minority carrying it as an EMPTY ARRAY **together with**
 *        `"ideal_weight_result": {}` — an empty object, not a missing key.
 *    The mapper skips the notable key only when its `.length === 0`, so the empty array is handled;
 *    the empty `ideal_weight_result` is NOT, because the skip is keyed on that one property name.
 *    `mapIdealWeightResult({})` reads `min_size`/`max_size`/`pred_size` off an empty object and
 *    emits three DONE items with an undefined quantity. The mock therefore has to be able to serve
 *    that body exactly (`emptyIdealWeight` / `emptyNotable` on the control plane), or a real share
 *    of the provider's results would be outside what the harness can reproduce.
 *    A contradiction worth recording so nobody "corrects" this file: the NON-empty
 *    `ideal_weight_result` served here carries the bare `min_size` / `max_size` / `pred_size` the
 *    mapper reads, because that is what the live endpoint returned on EVERY non-empty body in the
 *    same scan (OBSERVED). The integration's own `test/examples/` fixtures carry sex/neuter-
 *    qualified keys instead (`female_min_size`, `neutered_pred_size`, …) and no bare ones — an
 *    older shape of the same endpoint, which the current API does not send. Serving the fixtures'
 *    shape would not be fidelity; the scenario's prove-red for it shows what the mapper does with
 *    that shape (three valueless items — the same outcome as the empty object).
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT THIS MOCK DELIBERATELY DOES **NOT** MODEL, because the vendor's behaviour is unverified
 *
 * - **The healthy orders page.** No live call ever returned a kits page with `data` non-empty AND
 *   `included` populated (the probe's account had none to capture), so the pet item's shape here is
 *   INFERRED from the integration's `WisdomPanelPetItem` interface plus JSON:API's own rules. It is
 *   the one shape in this file that the whole orders channel rests on and that nobody has seen.
 * - **The entire write path.** `POST /api/voyager/pet` was never called live (no kit code was
 *   available to burn), so its request validation, its success envelope, its 201 status and every
 *   effect it has on the kit are INFERRED from the integration's mapper and interfaces. The one
 *   piece of evidence is the GET form of the same endpoint, whose `WIS_VOY__105 ... could not be
 *   found.` sentence for an unknown kit code IS observed, and is reused on the POST.
 * - **Re-notification.** Whether a stage change AFTER an acknowledgement puts a kit back on the
 *   unacknowledged feed was not observed. So it does not happen here: once acked, a kit stays
 *   acknowledged whatever the control plane does to its stage. (Contrast the zoetis mock, which
 *   DOES model re-notification because that provider advertises it. Assertion strength does not
 *   transfer between loops — see CLAUDE.md.)
 * - **The 600-row page cap.** OBSERVED (`page[limit]`/`page[offset]`/`page[skip-count]`, with
 *   `page[size]` and a bare `limit` silently ignored), and the integration never pages. The mock
 *   serves every page whole and the harness stays far under 600, so a cap here would model a
 *   timing hazard the harness cannot make deterministic and would hide nothing.
 * - **A CAT's genetic result.** Every live result body scanned was a dog's, so the same simplified
 *   shape is served for the scenario's cat orders (with `breed.species` reading `cat`) as an
 *   INFERENCE. Nothing in the mapper branches on species, but it is a shape nobody has seen.
 * - **Case-insensitive kit codes.** The integration upper-cases and trims the code before sending
 *   it, and the vendor's own tolerance is unknown, so this mock matches codes EXACTLY. That is an
 *   INVENTED strictness, chosen the conservative way: a mock that quietly accepted `wpkit-0001`
 *   would stop being able to tell an integration that upper-cases from one that stopped.
 * - **`voyager_kits`.** What the vendor means by it is unknown; OBSERVED only that
 *   `filter[activated]=false&filter[voyager_kits]=true` returns a clinic's unused inventory. Here it
 *   is a per-kit flag, enforced like every other filter.
 */

const http = require('http')
const { randomUUID } = require('crypto')

const PORT = Number(process.env.PORT || 3000)

/* Dummy credentials, the organization unit every activation is filed under, and the hospital the
 * control plane provisions for by default. All four come from the harness's own env
 * (HARNESS_WISDOM_PANEL_*), passed through by docker-compose.yml, so overriding one on the harness
 * side reaches the mock too. The hospital number is an IDENTITY, not a credential: the mock accepts
 * an activation for any hospital number and scopes its feeds by whatever it was told, exactly as
 * the live server does (the filter scoping was probed and is real). */
const USERNAME = String(process.env.WISDOM_PANEL_MOCK_USERNAME || 'harness-user')
const PASSWORD = String(process.env.WISDOM_PANEL_MOCK_PASSWORD || 'harness-pass')
const ORGANIZATION_UNIT_ID = String(process.env.WISDOM_PANEL_MOCK_ORGANIZATION_UNIT_ID || 'harness-org-unit')
const HOSPITAL_NUMBER = String(process.env.WISDOM_PANEL_MOCK_HOSPITAL_NUMBER || '700001')

/* OBSERVED: 3456000 seconds, i.e. 40 days. It is not decoration — the integration caches the token
 * for `expires_in * 0.25`, so a missing or non-numeric value makes that TTL NaN. */
const TOKEN_EXPIRES_IN = 3456000

/* OBSERVED live, paging through every kit of a development organization unit: these six strings —
 * and `null`, on a small but real minority of them, even though the integration's `KitStage` type
 * declares six strings and no null. `mapKitStatus` sends null to its `default:` branch, i.e. dmi
 * SUBMITTED, so those kits report a status that is a guess. */
const KIT_STAGES = [null, 'shipped', 'waiting', 'processing', 'analyzing', 'generating-report', 'report-ready']

/* OBSERVED: exactly one non-null value across that same sweep. A non-empty `current-failure` is
 * what `mapKitStatus` turns into dmi ERROR, whatever the stage says. */
const KIT_FAILURES = [null, 'sample-failed']

const PET_SPECIES = ['dog', 'cat']
const PET_SEXES = ['male', 'female']

/* How the PDF generator can fail. `text` and `json` are two 500s whose BODIES were both OBSERVED
 * live, on a sizeable minority of the development endpoint's result sets — the same endpoint
 * answering two different 500s — which is why the control plane picks between them rather than the
 * mock choosing one. `not-generated` is the 404 production answers for a released kit whose report
 * has not been generated yet: the STATUS is OBSERVED (production, 2026-09) and the body is the one
 * the development endpoint gives every kit that has no report-ready result set (OBSERVED there
 * 2026-09-25, INFERRED for the released-but-pending state; see handleVetReport). */
const PDF_FAILURE_MODES = [null, 'text', 'json', 'not-generated']

/* The clinic's unactivated kit inventory: the physical kits it holds and has not used. This is the
 * whole of this provider's "service catalogue" — `getServices` is
 * `filter[activated]=false&filter[voyager_kits]=true` mapped to `{code, name}` — so these codes are
 * what a POST /orders must name in `labRequisitionInfo.KitCode`.
 *
 * Every code is INVENTED, and unavoidably so: unlike the Antech/Zoetis/IDEXX loops there is no
 * published catalogue vocabulary to reuse, because a Wisdom Panel "service code" identifies one
 * physical kit rather than an assay. The `organization-identity` split is OBSERVED, not cosmetic:
 * live inventory kits carry `null` there, and `getServices` maps it straight to the service NAME —
 * so an operator's service list really can be nameless. Half the inventory keeps that null and half
 * carries an identity, so the scenario pins both and a mock that invented a name for every kit
 * could not hide behind either. The `current-stage` split (`null` vs `shipped`) is OBSERVED on the
 * same pages. */
const INVENTORY = [
  { code: 'WPKIT-0001', organizationIdentity: 'HARNESS-KIT-0001', currentStage: 'shipped' },
  { code: 'WPKIT-0002', organizationIdentity: 'HARNESS-KIT-0002', currentStage: 'shipped' },
  { code: 'WPKIT-0003', organizationIdentity: null, currentStage: null },
  { code: 'WPKIT-0004', organizationIdentity: null, currentStage: null },
  { code: 'WPKIT-0005', organizationIdentity: 'HARNESS-KIT-0005', currentStage: 'shipped' },
  { code: 'WPKIT-0006', organizationIdentity: 'HARNESS-KIT-0006', currentStage: 'shipped' },
  { code: 'WPKIT-0007', organizationIdentity: null, currentStage: 'shipped' },
  { code: 'WPKIT-0008', organizationIdentity: 'HARNESS-KIT-0008', currentStage: null },
]

/* The filter vocabulary each feed accepts. OBSERVED: an unknown key is a 400 naming it, not a
 * silently ignored parameter — a misspelled `hospital_numbr` was probed and refused — and the
 * scoping the known keys do is real. Both lists are exactly what the integration sends
 * (`WisdomPanelKitFiler` / `WisdomPanelResultSetsFilter`); anything else must be refused, or a
 * typo in the integration would read as an empty clinic rather than as an error. */
const KIT_FILTERS = ['unacknowledged', 'activated', 'hospital_number', 'voyager_kits', 'code']
const RESULT_SET_FILTERS = ['unacknowledged', 'hospital_number']

/* Kept in the call log so a scenario can prove what the integration sent; capped so a long run
 * cannot grow the mock's heap without bound. The early tests read the head of the log, so dropping
 * the oldest entries is the right end to lose. */
const MAX_CALL_LOG = 4000

function log (message) {
  console.log(`[wisdom-panel-mock] ${message}`)
}

function nowIso () {
  return new Date().toISOString()
}

/* ---- in-memory state (reset via POST /__control__/reset) ---- */

function freshState () {
  return {
    /* Every token the mock has ever issued, token -> {username, issuedAt}. Nothing expires them:
     * load-bearing detail 5. */
    tokens: new Map(),
    /* kit id -> kit record. The kit id is the whole of reconciliation for this provider: the
     * integration reports it as the dmi order's externalId at activation, and a result's `orderId`
     * is the kit id again. `mapWisdomPanelResult` attaches no `.order` to a result, so dmi-api's
     * patient-matching guard is never consulted and the match is purely on externalId. */
    kits: new Map(),
    /* pet id -> pet record. A pet exists only for an activated kit. */
    pets: new Map(),
    /* result set id -> result set record, including the simplified body the scenario seeded. */
    resultSets: new Map(),
    /* The control-plane revocation switch (load-bearing detail 5). When false every bearer is
     * refused, in each dialect's own shape, and the tokens stay valid for when it is switched back. */
    acceptBearers: true,
    /* One entry per provider-endpoint call, so a scenario asserts on what the integration DID. */
    calls: [],
    nextCallSeq: 0,
    counters: {
      login: 0,
      loginRefused: 0,
      kits: 0,
      resultSets: 0,
      createPet: 0,
      getPet: 0,
      simplified: 0,
      pdf: 0,
      ackKits: 0,
      ackResultSets: 0,
      notAcceptable: 0,
      unauthorized: 0,
      badFilter: 0,
    },
    /* Per-kit fetch counts for the two per-result-set calls, so "fetched exactly once, and not
     * again after the ack" is assertable rather than inferred from the report being right. */
    fetches: { simplified: {}, pdf: {} },
  }
}

let state = freshState()

function seedInventory () {
  for (const entry of INVENTORY) {
    const id = randomUUID()
    state.kits.set(id, {
      id,
      code: entry.code,
      organizationIdentity: entry.organizationIdentity,
      active: true,
      enabled: true,
      activated: false,
      currentStage: entry.currentStage,
      currentFailure: null,
      createdAt: nowIso(),
      stageUpdatedAt: nowIso(),
      activatedOn: null,
      acknowledgedAt: null,
      veterinarianName: null,
      hospitalName: null,
      hospitalNumber: null,
      labOrderNumber: null,
      inboundTrackingCode: null,
      outboundTrackingCode: null,
      reportReadyOn: null,
      sampleReceivedOn: null,
      profilingResultPresent: false,
      petId: null,
      voyagerPetId: null,
      voyagerKit: true,
      pdfFailure: null,
    })
  }
}

seedInventory()

/* ---- http helpers ---- */

function sendJson (res, status, body, contentType = 'application/json; charset=utf-8') {
  const payload = JSON.stringify(body === undefined ? null : body)
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/* `/api/v1/*` is JSON:API. The content type was never recorded by the probe, so the vendor media
 * type is used here as the faithful reading; nothing in the integration depends on it (axios parses
 * a JSON body whatever the content type says, because its responseType is unset). */
function sendJsonApi (res, status, body) {
  sendJson(res, status, body, 'application/vnd.api+json; charset=utf-8')
}

function sendText (res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sendPdf (res, buffer) {
  res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': buffer.length })
  res.end(buffer)
}

function readRaw (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/* The router drains the body once (it has to, in order to record what the integration sent), so the
 * stream is already consumed by the time a handler asks for it. Handlers read the parsed value the
 * router parked on the request rather than a stream that would now resolve empty. */
async function readJson (req) {
  if (req.parsedBody !== undefined) {
    return typeof req.parsedBody === 'object' && req.parsedBody !== null ? req.parsedBody : {}
  }
  const raw = await readRaw(req)
  if (raw.length === 0) return {}
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`invalid JSON body: ${error.message}`)
  }
}

/* Every URL this mock hands back is built from the request's own Host header, so nothing here can
 * resolve anywhere real even if a link were followed. */
function externalBase (req) {
  return `http://${req.headers.host || `localhost:${PORT}`}`
}

/* ---- the provider's error envelopes ----
 *
 * FOUR distinct shapes, and the variety is the contract: `WisdomApiException` collects
 * `options.message` (the voyager dialect) and `options.errors[].{title, detail}` (the JSON:API
 * dialect) and nothing else, so which shape an endpoint answers with decides whether the vendor's
 * explanation reaches an operator through POST /orders or is replaced by a bare
 * `Failed to POST <url>`. Each builder is used only where its shape was observed. */

/* OBSERVED VERBATIM on `/api/v1/*` for a missing or unknown bearer. Note the asymmetry that a
 * tidier mock would have ironed out: `code` is a NUMBER here and `status` a STRING. */
function sendJsonApiUnauthorized (res, why) {
  state.counters.unauthorized += 1
  log(`401 on /api/v1: ${why}`)
  sendJsonApi(res, 401, {
    errors: [
      { title: 'Permission Denied', detail: 'The access token is invalid', code: 401, status: '401' },
    ],
  })
}

/* OBSERVED VERBATIM for an unknown `filter[...]` key on either feed — a misspelled
 * `filter[hospital_numbr]` was probed and answered with exactly this. Note that `code` is a STRING
 * here where the 401 above makes it a number; both are reproduced as seen. */
function sendFilterNotAllowed (res, key) {
  state.counters.badFilter += 1
  log(`400 filter not allowed: ${key}`)
  sendJsonApi(res, 400, {
    errors: [
      { title: 'Filter not allowed', detail: `${key} is not allowed.`, code: '102', status: '400' },
    ],
  })
}

/* 406. The STATUS is OBSERVED (a bare `application/json`, and a vendor media type carrying a
 * charset parameter, are both refused); the BODY was never captured, so this JSON:API `errors`
 * entry is INVENTED. Nothing in the integration reads it — it surfaces as a generic
 * `Failed to GET <url>` — so the invention is confined to wording. */
function sendNotAcceptable (res, accept) {
  state.counters.notAcceptable += 1
  log(`406: Accept '${accept}' is not acceptable to a JSON:API endpoint`)
  sendJsonApi(res, 406, {
    errors: [
      {
        title: 'Not Acceptable',
        detail: 'The Accept header must be */* or application/vnd.api+json with no media type parameters.',
        code: '406',
        status: '406',
      },
    ],
  })
}

/* The voyager dialect: a plain `{message}`. OBSERVED for the 422s of `GET /api/voyager/pet`
 * (`WIS_VOY__105: Failed: Kit <code> could not be found.`); the status/shape of a voyager call made
 * with a bad bearer was NOT observed, so that use below is INVENTED and says so at its call site.
 * `WisdomApiException` reads `options.message`, so everything sent through here reaches an operator
 * verbatim through POST /orders — which is the point of using the vendor's own `WIS_VOY__nnn:
 * Failed: ...` house style rather than a message of the mock's own devising. */
function sendVoyagerError (res, status, message, why) {
  if (why !== undefined) log(`${status} on a voyager endpoint: ${why}`)
  sendJson(res, status, { message })
}

/* RFC 6749, and OBSERVED: the grant endpoint answers bad credentials with **400**, not 401, and the
 * `error_description` below is the spec's own sentence, returned verbatim by the live server. The
 * integration throws this body away (`authenticate` rethrows `[HTTP 400] Failed to POST ...`), so
 * it never reaches an operator — reproduced anyway, because a mock that answered 401 would let an
 * integration that started refreshing on 401 loop for ever against the real thing. */
function sendOauthError (res, error, description, why) {
  state.counters.loginRefused += 1
  log(`400 on /oauth/token: ${why}`)
  sendJson(res, 400, { error, error_description: description })
}

/* ---- a small, byte-valid PDF ----
 *
 * The vet report is a real PDF on the wire (OBSERVED: `%PDF-1.7`, about half a megabyte) and the
 * integration base64s the raw bytes onto the result. An HTML error page labelled
 * `application/pdf` is the trap that bit another loop; here the unknown-kit case really is a 404
 * with a text/html body (OBSERVED), so the trap does not apply — but the happy path still has to be
 * a genuine PDF, or the scenario's `%PDF` assertion would be asserting the mock's opinion of one.
 * Built rather than embedded so no captured document is carried in this repo. */
function buildPdf (title) {
  const content = `BT /F1 12 Tf 24 96 Td (${title.replace(/[()\\]/g, '')}) Tj ET\n`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 144] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]

  let pdf = '%PDF-1.7\n'
  const offsets = []
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xrefOffset = Buffer.byteLength(pdf, 'latin1')
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

/* ---- content negotiation and auth ---- */

/* Load-bearing detail 4, enforced exactly as probed. Absent is fine; a list containing the total
 * wildcard range `*[/]*` is fine (which is why axios's default works); the bare vendor media type
 * is fine; anything else, including a bare `application/json` and the vendor type carrying a
 * charset parameter, is a 406. */
function acceptableToJsonApi (req) {
  const raw = req.headers.accept
  if (raw === undefined || raw === '') return true
  return String(raw)
    .split(',')
    .map((value) => value.trim())
    .some((value) => value === '*/*' || value === 'application/vnd.api+json')
}

function bearerOf (req) {
  const header = req.headers.authorization
  if (typeof header !== 'string') return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match === null ? null : match[1]
}

/* A bearer is good when the mock issued it AND the revocation switch is on. The switch never
 * forgets a token: see load-bearing detail 5. */
function bearerIsValid (req) {
  const token = bearerOf(req)
  return token !== null && state.acceptBearers && state.tokens.has(token)
}

function requireJsonApiAuth (req, res) {
  if (!acceptableToJsonApi(req)) {
    sendNotAcceptable(res, req.headers.accept)
    return false
  }
  if (!bearerIsValid(req)) {
    sendJsonApiUnauthorized(res, bearerOf(req) === null ? 'no bearer' : 'unknown or revoked bearer')
    return false
  }
  return true
}

/* The voyager and pdf-generator endpoints' answer to a bad bearer was NOT observed. 401 with the
 * voyager dialect's `{message}` is INVENTED — chosen because every other voyager refusal observed
 * (the 422s) is shaped that way, which is a smaller invention than importing the JSON:API envelope
 * across a dialect boundary. */
function requireVoyagerAuth (req, res) {
  if (bearerIsValid(req)) return true
  state.counters.unauthorized += 1
  sendVoyagerError(res, 401, 'Unauthorized: the access token is invalid.', 'bad bearer on a voyager endpoint')
  return false
}

/* ---- JSON:API serialisation ---- */

function kitItem (req, kit) {
  const self = `${externalBase(req)}/api/v1/kits/${kit.id}`
  const related = (name) => ({
    links: { self: `${self}/relationships/${name}`, related: `${self}/${name}` },
  })
  return {
    id: kit.id,
    type: 'kits',
    links: { self },
    /* The attribute set is a deliberate TRIM of the live one (which carries about fifty keys,
     * several of them deprecated aliases): every key the integration's `WisdomPanelKitItem`
     * declares and reads, plus the handful the probe showed are always present. Keys are kebab-case
     * — load-bearing detail 7. */
    attributes: {
      code: kit.code,
      'organization-identity': kit.organizationIdentity,
      active: kit.active,
      enabled: kit.enabled,
      activated: kit.activated,
      'current-stage': kit.currentStage,
      'current-failure': kit.currentFailure,
      'created-at': kit.createdAt,
      'activated-on': kit.activatedOn,
      'acknowledged-at': kit.acknowledgedAt,
      'veterinarian-name': kit.veterinarianName,
      'hospital-name': kit.hospitalName,
      'hospital-number': kit.hospitalNumber,
      'lab-order-number': kit.labOrderNumber,
      'inbound-tracking-code': kit.inboundTrackingCode,
      'outbound-tracking-code': kit.outboundTrackingCode,
      'stage-updated-at': kit.stageUpdatedAt,
      'report-ready-on': kit.reportReadyOn,
      'sample-received-on': kit.sampleReceivedOn,
      'relative-counts': {},
      'profiling-result-present': kit.profilingResultPresent,
    },
    relationships: {
      /* `data: null` for a kit with no pet — OBSERVED, and NOT the same thing as omitting the
       * relationship. `included` is what goes missing, not this. */
      pet: {
        links: { self: `${self}/relationships/pet`, related: `${self}/pet` },
        data: kit.petId === null ? null : { type: 'pets', id: kit.petId },
      },
      statuses: related('statuses'),
      'result-sets': related('result-sets'),
      'active-result-set': related('active-result-set'),
      organization: related('organization'),
    },
  }
}

/* INFERRED, and the one shape in this file nobody has seen on the wire: no live call returned a
 * populated `included`. Every key here is one the integration's `WisdomPanelPetItem` declares;
 * `mapPatient` reads name/sex/species and `mapClient` reads the two owner names. */
function petItem (req, pet) {
  const self = `${externalBase(req)}/api/v1/pets/${pet.id}`
  return {
    id: pet.id,
    type: 'pets',
    links: { self },
    attributes: {
      name: pet.name,
      sex: pet.sex,
      species: pet.species,
      intact: pet.intact,
      'organization-identity': pet.organizationIdentity,
      'owner-first-name': pet.ownerFirstName,
      'owner-last-name': pet.ownerLastName,
      'created-at': pet.createdAt,
      'birth-year': pet.birthYear,
      'birth-month': pet.birthMonth,
      'birth-day': pet.birthDay,
    },
    relationships: {
      owner: { links: { self: `${self}/relationships/owner`, related: `${self}/owner` } },
      kits: { links: { self: `${self}/relationships/kits`, related: `${self}/kits` } },
    },
  }
}

function resultSetItem (req, resultSet) {
  const self = `${externalBase(req)}/api/v1/result-sets/${resultSet.id}`
  const related = (name) => ({
    links: { self: `${self}/relationships/${name}`, related: `${self}/${name}` },
  })
  return {
    id: resultSet.id,
    type: 'result-sets',
    links: { self },
    attributes: {
      'created-at': resultSet.createdAt,
      'genotype-chip-version': resultSet.genotypeChipVersion,
      'acknowledged-at': resultSet.acknowledgedAt,
      'rgs-call-rate': null,
    },
    relationships: {
      kit: {
        links: { self: `${self}/relationships/kit`, related: `${self}/kit` },
        data: { type: 'kits', id: resultSet.kitId },
      },
      'health-result': related('health-result'),
      'trait-result': related('trait-result'),
      'ideal-weight-result': related('ideal-weight-result'),
    },
  }
}

/* The page envelope. THREE rules, all load-bearing:
 *   - `meta['record-count']` is ALWAYS present (detail 2);
 *   - `included` is OMITTED, never `[]`, when there is nothing to include (detail 1);
 *   - `links` are built from the request's Host header, so nothing resolves anywhere real. The
 *     vendor's own links also carry its `page[...]` parameters; this mock never pages and does not
 *     pretend to. */
function sendPage (req, res, data, included) {
  const body = { data }
  if (included !== undefined && included.length > 0) body.included = included
  body.meta = { 'record-count': data.length }
  const self = `${externalBase(req)}${req.url}`
  body.links = { first: self, last: self }
  sendJsonApi(res, 200, body)
}

/* ---- filters ---- */

/* Returns the parsed `filter[...]` map, or null having already answered a 400. Both the
 * bracket-encoded (`filter%5Bx%5D`) and the literal (`filter[x]`) forms arrive depending on which
 * axios version the engine resolves; URL parsing makes them identical here, which is exactly what
 * was OBSERVED of the live server (both encodings returned the same record count). Anything that is
 * not a `filter[...]` key — `include`, the vendor's own `page[...]` — is ignored rather than
 * refused, as observed. */
function parseFilters (res, query, allowed) {
  const filters = {}
  for (const [key, value] of query) {
    const match = /^filter\[(.+)\]$/.exec(key)
    if (match === null) continue
    const name = match[1]
    if (!allowed.includes(name)) {
      sendFilterNotAllowed(res, name)
      return null
    }
    filters[name] = value
  }
  return filters
}

function matchesBoolean (value, actual) {
  if (value === undefined) return true
  return (value === 'true') === actual
}

/* ---- provider handlers ---- */

/* OBSERVED shape. The token string is the mock's own; `expires_in` and `scope` are the live values.
 * Validation is deliberate rather than permissive: the integration sends a fixed
 * `grant_type: 'password'` / `scope: 'organization'` pair, and a mock that accepted anything could
 * not tell an integration that still sends them from one that stopped. */
async function handleTokenGrant (req, res) {
  const body = await readJson(req)

  if (typeof body.username !== 'string' || typeof body.password !== 'string') {
    /* INVENTED wording; the vendor's answer to a malformed grant request was not probed. */
    return sendOauthError(res, 'invalid_request', 'The request is missing a required parameter.', 'no username or password')
  }
  if (body.grant_type !== 'password') {
    /* INVENTED wording, RFC 6749 error code. */
    return sendOauthError(res, 'unsupported_grant_type', 'The authorization grant type is not supported by the authorization server.', `grant_type '${body.grant_type}'`)
  }
  if (body.scope !== 'organization') {
    /* INVENTED wording, RFC 6749 error code. */
    return sendOauthError(res, 'invalid_scope', 'The requested scope is invalid, unknown, or malformed.', `scope '${body.scope}'`)
  }
  if (body.username !== USERNAME || body.password !== PASSWORD) {
    /* OBSERVED VERBATIM, including the 400 status and the RFC's full sentence. */
    return sendOauthError(
      res,
      'invalid_grant',
      'The provided authorization grant is invalid, expired, revoked, does not match the redirection URI used in the authorization request, or was issued to another client.',
      `credentials for '${body.username}'`,
    )
  }

  const token = `wp-mock-${randomUUID()}`
  state.tokens.set(token, { username: body.username, issuedAt: nowIso() })
  state.counters.login += 1
  log(`issued token #${state.tokens.size} to '${body.username}'`)

  sendJson(res, 200, {
    access_token: token,
    token_type: 'Bearer',
    expires_in: TOKEN_EXPIRES_IN,
    scope: 'organization',
    created_at: Math.floor(Date.now() / 1000),
  })
}

/* `GET /api/v1/kits`. The integration makes three different calls here:
 *   - the orders poll: filter[unacknowledged]=true & filter[hospital_number]=<n> & include=pet,pet.owner
 *   - getServices:     filter[activated]=false & filter[voyager_kits]=true, no include
 *   - the 422-recovery lookup (feature-flagged off in this harness): filter[code] & filter[hospital_number]
 * Every filter is enforced, never ignored: the hospital scoping was probed live and is real, and a
 * mock that ignored it would let an integration that stopped sending `hospital_number` read every
 * clinic's kits while the gate stayed green. */
function handleKits (req, res, params, query) {
  if (!requireJsonApiAuth(req, res)) return
  const filters = parseFilters(res, query, KIT_FILTERS)
  if (filters === null) return
  state.counters.kits += 1

  const kits = [...state.kits.values()].filter((kit) => {
    if (!matchesBoolean(filters.unacknowledged, kit.acknowledgedAt === null)) return false
    if (!matchesBoolean(filters.activated, kit.activated)) return false
    if (!matchesBoolean(filters.voyager_kits, kit.voyagerKit)) return false
    if (filters.hospital_number !== undefined && String(kit.hospitalNumber) !== filters.hospital_number) return false
    if (filters.code !== undefined && kit.code !== filters.code) return false
    return true
  })

  /* Load-bearing detail 1. `include` is what the client asked to be given; `included` only appears
   * when at least one kit in the page actually carries a pet. An all-pet-less page — the ordinary
   * state of a clinic holding unused kits — has `data` non-empty and NO `included` key. */
  const includeAsked = String(query.get('include') || '').split(',').includes('pet')
  const included = includeAsked
    ? kits.map((kit) => state.pets.get(kit.petId)).filter((pet) => pet !== undefined).map((pet) => petItem(req, pet))
    : []

  sendPage(req, res, kits.map((kit) => kitItem(req, kit)), included)
}

/* `GET /api/v1/result-sets`. The integration always asks `include=kit` and resolves each set's kit
 * out of `included` by `relationships.kit.data.id`; its audit interceptor ALSO does
 * `body.included.forEach(...)` on every non-empty page here, so an `included` missing from a
 * non-empty page kills the results poll inside the logging interceptor, one layer earlier than the
 * orders side. A result set's hospital is its kit's. */
function handleResultSets (req, res, params, query) {
  if (!requireJsonApiAuth(req, res)) return
  const filters = parseFilters(res, query, RESULT_SET_FILTERS)
  if (filters === null) return
  state.counters.resultSets += 1

  const sets = [...state.resultSets.values()].filter((resultSet) => {
    if (!matchesBoolean(filters.unacknowledged, resultSet.acknowledgedAt === null)) return false
    if (filters.hospital_number !== undefined) {
      const kit = state.kits.get(resultSet.kitId)
      if (kit === undefined || String(kit.hospitalNumber) !== filters.hospital_number) return false
    }
    return true
  })

  const includeAsked = String(query.get('include') || '').split(',').includes('kit')
  const included = includeAsked
    ? sets.map((resultSet) => state.kits.get(resultSet.kitId)).filter((kit) => kit !== undefined).map((kit) => kitItem(req, kit))
    : []

  sendPage(req, res, sets.map((resultSet) => resultSetItem(req, resultSet)), included)
}

/* `GET /api/voyager/banfield-results-retrieval/{kitId}` — the simplified genetic result, keyed by
 * KIT id rather than by result set. OBSERVED for the string form of the health findings; the key
 * set (`breed_percentages`, `ideal_weight_result`, `notable_and_at_risk_health_test_results`) was
 * stable across all 49 sampled kits and is exactly the three the mapper has cases for.
 *
 * KEY ORDER IS LOAD-BEARING: the mapper walks `Object.keys(...)` and uses the index as the test
 * result's `seq`, so the order below is what decides which panel is seq 0, 1 and 2. */
function handleSimplifiedResults (req, res, params) {
  if (!requireVoyagerAuth(req, res)) return
  state.counters.simplified += 1
  const kitId = params.kitId
  state.fetches.simplified[kitId] = (state.fetches.simplified[kitId] || 0) + 1

  const kit = state.kits.get(kitId)
  if (kit === undefined) {
    /* INVENTED: the vendor's answer for an unknown kit on THIS endpoint was not probed (all 52
     * sampled result sets returned 200). The status and dialect follow the observed voyager 422s;
     * only the code and sentence are the mock's. */
    return sendVoyagerError(res, 404, `WIS_VOY__140: Failed: Kit ${kitId} could not be found.`, `simplified results for unknown kit ${kitId}`)
  }
  const resultSet = [...state.resultSets.values()].find((entry) => entry.kitId === kitId)
  if (resultSet === undefined) {
    /* INVENTED, same reasoning: a kit with no result set was never asked for live. */
    return sendVoyagerError(res, 404, `WIS_VOY__141: Failed: No results are available for kit ${kit.code}.`, `no result set for kit ${kit.code}`)
  }

  sendJson(res, 200, { message: 'success', data: resultSet.simplified })
}

/* `GET /pdf-generator/vet-report/{kitId}`. Three OBSERVED behaviours, all reproduced:
 *   - a real kit with a report: 200, `application/pdf`, a `%PDF-1.7` document;
 *   - an unknown kit: **404** with a `text/html` body of exactly `Kit not found.` (14 bytes) —
 *     NOT a 200 carrying an error page, so the "HTML base64'd as a PDF" trap does not apply here;
 *   - a failure: **500**, on a sizeable minority of real result sets, in TWO different bodies — a bare
 *     `An unknown error occurred.` and a JSON `{"error": "Internal Server Error"}`. Which one a
 *     given kit gets is a control-plane flag, because the live endpoint produced both and nothing
 *     was found that predicts which.
 * And a fourth, half observed: a released kit whose report has not been generated yet (the
 * `not-generated` flag). The **404** STATUS is OBSERVED in production (2026-09), where it lasts for
 * hours after release; its BODY is INFERRED from the development endpoint, which answers exactly
 * `Result set not found.` (`text/html`, 21 bytes, OBSERVED 2026-09-25) for every kit without a
 * report-ready result set, in any stage — the one state not seen there is a released set whose
 * report is still pending, which is the production case. Nothing in the integration reads the body.
 * The integration reads this with `responseType: 'arraybuffer'`. A non-2xx costs that one result
 * set, which it leaves unacknowledged and asks for again on every poll; the rest of the batch is
 * delivered. Its HTTP layer retries a 5xx once inside the same request and never a 4xx, so a poll
 * makes two requests here for a 500 and one for a 404. */
function handleVetReport (req, res, params) {
  if (!requireVoyagerAuth(req, res)) return
  state.counters.pdf += 1
  const kitId = params.kitId
  state.fetches.pdf[kitId] = (state.fetches.pdf[kitId] || 0) + 1

  const kit = state.kits.get(kitId)
  if (kit === undefined) {
    log(`404 vet report: unknown kit ${kitId}`)
    return sendText(res, 404, 'Kit not found.', 'text/html; charset=utf-8')
  }
  if (kit.pdfFailure === 'text') {
    log(`500 vet report (text) for kit ${kit.code}`)
    return sendText(res, 500, 'An unknown error occurred.')
  }
  if (kit.pdfFailure === 'json') {
    log(`500 vet report (json) for kit ${kit.code}`)
    return sendJson(res, 500, { error: 'Internal Server Error' })
  }
  if (kit.pdfFailure === 'not-generated') {
    /* Status OBSERVED (production, 2026-09); body OBSERVED on dev for the no-report case, INFERRED
     * for the pending one — see above. */
    log(`404 vet report (not generated yet) for kit ${kit.code}`)
    return sendText(res, 404, 'Result set not found.', 'text/html; charset=utf-8')
  }

  sendPdf(res, buildPdf(`Wisdom Panel harness vet report - kit ${kit.code}`))
}

/* `POST /api/voyager/acknowledge-kits` and `POST /api/voyager/acknowledge-result-sets`. OBSERVED
 * VERBATIM, down to the 201 (not 204) and the fact that each side names its COUNTERPART id — which
 * the integration then throws away, both acks returning `Promise<void>`. A duplicate ack is 201
 * with a byte-identical body: there is no 409 in this API, and inventing one (as a mock copied from
 * the zoetis one would) would be fiction. Acknowledging is a FILTER, not a delete: the kit or set
 * stays queryable, it just leaves the `unacknowledged` view. */
async function handleAcknowledgeKits (req, res) {
  if (!requireVoyagerAuth(req, res)) return
  const body = await readJson(req)
  state.counters.ackKits += 1

  const ids = body?.data?.kit_ids
  if (!Array.isArray(ids) || ids.length === 0) {
    /* INVENTED: a malformed ack body was never sent live. */
    return sendVoyagerError(res, 422, 'WIS_VOY__120: Failed: data.kit_ids must be a non-empty array.', 'malformed acknowledge-kits body')
  }

  const acknowledged = []
  for (const id of ids) {
    const kit = state.kits.get(id)
    if (kit === undefined) {
      /* INVENTED: an unknown id was never acked live. Refusing rather than silently succeeding is
       * the conservative choice — an integration that started acking the wrong id space (a kit code
       * instead of a kit id, say) must go red rather than appear to drain the feed. */
      return sendVoyagerError(res, 422, `WIS_VOY__121: Failed: Kit ${id} could not be found.`, `acknowledge-kits for unknown id ${id}`)
    }
    if (kit.acknowledgedAt === null) kit.acknowledgedAt = nowIso()
    const resultSet = [...state.resultSets.values()].find((entry) => entry.kitId === kit.id)
    acknowledged.push({ acknowledged_kit_id: kit.id, related_result_set_id: resultSet?.id ?? null })
  }
  log(`acknowledged ${acknowledged.length} kit(s): ${ids.join(', ')}`)

  sendJson(res, 201, { message: 'success', data: { acknowledged_kits: acknowledged } })
}

async function handleAcknowledgeResultSets (req, res) {
  if (!requireVoyagerAuth(req, res)) return
  const body = await readJson(req)
  state.counters.ackResultSets += 1

  const ids = body?.data?.result_set_ids
  if (!Array.isArray(ids) || ids.length === 0) {
    return sendVoyagerError(res, 422, 'WIS_VOY__122: Failed: data.result_set_ids must be a non-empty array.', 'malformed acknowledge-result-sets body')
  }

  const acknowledged = []
  for (const id of ids) {
    const resultSet = state.resultSets.get(id)
    if (resultSet === undefined) {
      return sendVoyagerError(res, 422, `WIS_VOY__123: Failed: Result set ${id} could not be found.`, `acknowledge-result-sets for unknown id ${id}`)
    }
    if (resultSet.acknowledgedAt === null) resultSet.acknowledgedAt = nowIso()
    acknowledged.push({ acknowledged_result_set_id: resultSet.id, related_kit_id: resultSet.kitId })
  }
  log(`acknowledged ${acknowledged.length} result set(s): ${ids.join(', ')}`)

  sendJson(res, 201, { message: 'success', data: { acknowledged_result_sets: acknowledged } })
}

/* ---- activation: POST /api/voyager/pet ----
 *
 * An "order" for this provider is the ACTIVATION of a physical kit the clinic already holds. The
 * WRITE PATH WAS NEVER PROBED (no kit code was available to burn), so everything here except the
 * `WIS_VOY__105 ... could not be found.` sentence — OBSERVED on the GET form of this same endpoint
 * — is INFERRED from `WisdomPanelMapper.mapCreateOrderPayload` and the entity interfaces.
 *
 * It VALIDATES rather than defaults, and that is the whole reason the scenario's assertions mean
 * anything: a mock that filled in a missing `name`, `sex` or `voyager_pet_id` would hand the
 * scenario exactly the value it then asserts, and an integration that stopped forwarding the field
 * would ship a permanently green gate. Note what is NOT required, on purpose: `client_pet_id`
 * (which the integration derives from a `pims:client:id` the harness does not send), `client_email`,
 * `client_phone`, the birth fields, and a BREED — `getBreeds` is `[]` for this provider and the
 * mapper never sends one, so requiring one would be the mock inventing a contract. */
async function handleCreatePet (req, res) {
  if (!requireVoyagerAuth(req, res)) return
  const body = await readJson(req)
  state.counters.createPet += 1
  const data = body?.data

  const refuse = (message, why) => sendVoyagerError(res, 422, message, why)

  if (data === null || typeof data !== 'object') {
    return refuse('WIS_VOY__100: Failed: data is required.', 'activation with no data object')
  }
  if (data.organization_unit_id !== ORGANIZATION_UNIT_ID) {
    /* INVENTED wording. The organization unit is a provider-CONFIGURATION field for this provider
     * (the inverse of every other loop, where credentials are integration options), so pinning it
     * here is what proves the configuration reached the wire at all. */
    return refuse(
      `WIS_VOY__101: Failed: Organization unit ${String(data.organization_unit_id)} could not be found.`,
      `activation for organization unit '${String(data.organization_unit_id)}'`,
    )
  }
  if (typeof data.code !== 'string' || data.code === '') {
    return refuse('WIS_VOY__102: Failed: code is required.', 'activation with no kit code')
  }

  /* Matched EXACTLY, not case-insensitively — see the header. The integration upper-cases and trims
   * (`labRequisitionInfo.KitCode.toUpperCase().trim()`), so the strictness costs it nothing and
   * keeps the mock able to notice if it stopped. */
  const kit = [...state.kits.values()].find((entry) => entry.code === data.code)
  if (kit === undefined) {
    /* The dialect, the `WIS_VOY__105` code and this exact sentence are OBSERVED — on the GET form
     * of this endpoint, for a kit code that does not exist. Reusing them on the POST is INFERRED,
     * and it is the one vendor sentence this loop can prove reaches an operator end to end. */
    return refuse(`WIS_VOY__105: Failed: Kit ${data.code} could not be found.`, `activation of unknown kit '${data.code}'`)
  }
  if (kit.activated) {
    /* A second activation of the same code is KNOWN to 422 live; the message was not captured, so
     * this sentence is INVENTED in the vendor's own `WIS_VOY__nnn: Failed: ...` house style. */
    return refuse(`WIS_VOY__106: Failed: Kit ${kit.code} has already been activated.`, `re-activation of kit '${kit.code}'`)
  }
  if (!PET_SPECIES.includes(data.species)) {
    return refuse(`WIS_VOY__110: Failed: species ${String(data.species)} is not valid.`, `species '${String(data.species)}'`)
  }
  if (!PET_SEXES.includes(data.sex)) {
    return refuse(`WIS_VOY__111: Failed: sex ${String(data.sex)} is not valid.`, `sex '${String(data.sex)}'`)
  }
  if (typeof data.intact !== 'boolean') {
    return refuse('WIS_VOY__112: Failed: intact is required.', 'activation with no intact flag')
  }
  for (const field of ['name', 'voyager_pet_id', 'client_last_name', 'hospital_name', 'hospital_number', 'veterinarian_name']) {
    if (typeof data[field] !== 'string' || data[field].trim() === '') {
      return refuse(`WIS_VOY__113: Failed: ${field} is required.`, `activation with no ${field}`)
    }
  }

  const pet = {
    id: randomUUID(),
    name: data.name,
    sex: data.sex,
    species: data.species,
    intact: data.intact,
    /* Unobserved after an activation; left null rather than invented. */
    organizationIdentity: null,
    ownerFirstName: typeof data.client_first_name === 'string' ? data.client_first_name : null,
    ownerLastName: data.client_last_name,
    createdAt: nowIso(),
    birthYear: data.birth_year ?? null,
    birthMonth: data.birth_month ?? null,
    birthDay: data.birth_day ?? null,
  }
  state.pets.set(pet.id, pet)

  /* The effects an activation has on the kit. INFERRED: `waiting` is the first post-activation
   * stage (`shipped` and `waiting` are the two pre-lab stages seen live), the kit leaves the
   * unactivated inventory so `getServices` stops advertising it, and it joins the UNACKNOWLEDGED
   * feed so the orders poll sees it once. `organization-identity` is left as it was — its value
   * after an activation was not observed. */
  kit.activated = true
  kit.activatedOn = nowIso()
  kit.currentStage = 'waiting'
  kit.stageUpdatedAt = nowIso()
  kit.acknowledgedAt = null
  kit.hospitalName = data.hospital_name
  kit.hospitalNumber = String(data.hospital_number)
  kit.veterinarianName = data.veterinarian_name
  kit.petId = pet.id
  kit.voyagerPetId = data.voyager_pet_id
  log(`activated kit ${kit.code} (${kit.id}) for pet '${pet.name}' at hospital ${kit.hospitalNumber}`)

  /* INFERRED envelope, and an INVENTED 201 — the integration reads only the body, taking
   * `data.kit.id` as the dmi externalId, `data.kit.code` as the requisitionId (overwriting the one
   * the caller sent) and `data.requisition_form` as the order's manifest. */
  sendJson(res, 201, {
    message: 'success',
    data: {
      pet: {
        id: pet.id,
        species: pet.species,
        name: pet.name,
        sex: pet.sex,
        intact: pet.intact,
        voyager_pet_id: kit.voyagerPetId,
        birth_day: pet.birthDay,
        birth_month: pet.birthMonth,
        birth_year: pet.birthYear,
      },
      kit: { id: kit.id, code: kit.code },
      requisition_form: buildPdf(`Wisdom Panel harness requisition form - kit ${kit.code}`).toString('base64'),
    },
  })
}

/* `GET /api/voyager/pet?kit_code=&voyager_pet_id=` — the feature-flagged 422-recovery lookup.
 * `STATSIG_ENABLED=false` in this harness and no override is set, so the integration never reaches
 * it; it is served because the endpoint exists and its 422 is the one voyager refusal OBSERVED
 * verbatim. The 200 form is INFERRED (the §E envelope again). */
function handleGetPet (req, res, params, query) {
  if (!requireVoyagerAuth(req, res)) return
  state.counters.getPet += 1
  const kitCode = query.get('kit_code')
  const voyagerPetId = query.get('voyager_pet_id')

  const kit = [...state.kits.values()].find((entry) => entry.code === kitCode)
  if (kit === undefined || !kit.activated) {
    /* OBSERVED VERBATIM for a kit code that does not exist. */
    return sendVoyagerError(res, 422, `WIS_VOY__105: Failed: Kit ${kitCode} could not be found.`, `pet lookup for '${kitCode}'`)
  }
  if (kit.voyagerPetId !== voyagerPetId) {
    /* INVENTED: the "activated for a different patient" refusal was never captured. */
    return sendVoyagerError(res, 422, `WIS_VOY__107: Failed: Kit ${kitCode} is activated for a different pet.`, `pet lookup mismatch for '${kitCode}'`)
  }

  const pet = state.pets.get(kit.petId)
  sendJson(res, 200, {
    message: 'success',
    data: {
      pet: {
        id: pet.id,
        species: pet.species,
        name: pet.name,
        sex: pet.sex,
        intact: pet.intact,
        voyager_pet_id: kit.voyagerPetId,
        birth_day: pet.birthDay,
        birth_month: pet.birthMonth,
        birth_year: pet.birthYear,
      },
      kit: { id: kit.id, code: kit.code },
      requisition_form: buildPdf(`Wisdom Panel harness requisition form - kit ${kit.code}`).toString('base64'),
    },
  })
}

/* ---- control plane (/__control__) ----
 *
 * Host-facing only; the integration never sees these paths, and they are exempt from the JSON:API
 * content negotiation and the bearer check (the harness's own client speaks neither). Requirements
 * the scenario has to satisfy are ENFORCED here with explanatory errors rather than stated in a
 * comment: a shape rule that lives only in prose leaves the next author a silent poll timeout. */

function publicKit (kit) {
  const pet = kit.petId === null ? null : state.pets.get(kit.petId)
  const resultSet = [...state.resultSets.values()].find((entry) => entry.kitId === kit.id)
  return {
    id: kit.id,
    code: kit.code,
    organizationIdentity: kit.organizationIdentity,
    active: kit.active,
    enabled: kit.enabled,
    activated: kit.activated,
    currentStage: kit.currentStage,
    currentFailure: kit.currentFailure,
    acknowledged: kit.acknowledgedAt !== null,
    acknowledgedAt: kit.acknowledgedAt,
    hospitalNumber: kit.hospitalNumber,
    hospitalName: kit.hospitalName,
    veterinarianName: kit.veterinarianName,
    voyagerKit: kit.voyagerKit,
    voyagerPetId: kit.voyagerPetId,
    pdfFailure: kit.pdfFailure,
    pet: pet === null || pet === undefined
      ? null
      : {
          id: pet.id,
          name: pet.name,
          sex: pet.sex,
          species: pet.species,
          intact: pet.intact,
          ownerFirstName: pet.ownerFirstName,
          ownerLastName: pet.ownerLastName,
          birthYear: pet.birthYear,
          birthMonth: pet.birthMonth,
          birthDay: pet.birthDay,
        },
    resultSetId: resultSet?.id ?? null,
    simplifiedFetches: state.fetches.simplified[kit.id] || 0,
    pdfFetches: state.fetches.pdf[kit.id] || 0,
  }
}

function findKit (key) {
  return state.kits.get(key) ?? [...state.kits.values()].find((kit) => kit.code === key)
}

function controlError (res, message) {
  log(`control plane refused: ${message}`)
  sendJson(res, 400, { error: message })
}

async function handleControlProvisionKit (req, res) {
  const body = await readJson(req)

  const code = typeof body.code === 'string' && body.code !== '' ? body.code : `WPKIT-${String(state.kits.size + 1).padStart(4, '0')}`
  if (findKit(code) !== undefined) return controlError(res, `a kit with code '${code}' already exists`)
  if (!KIT_STAGES.includes(body.stage ?? null)) {
    return controlError(res, `stage must be one of ${KIT_STAGES.map((stage) => String(stage)).join(', ')}; got '${String(body.stage)}'`)
  }
  if (!KIT_FAILURES.includes(body.failure ?? null)) {
    return controlError(res, `failure must be one of ${KIT_FAILURES.map((failure) => String(failure)).join(', ')}; got '${String(body.failure)}'`)
  }
  if (!PDF_FAILURE_MODES.includes(body.pdfFailure ?? null)) {
    return controlError(res, `pdfFailure must be one of ${PDF_FAILURE_MODES.map((mode) => String(mode)).join(', ')}; got '${String(body.pdfFailure)}'`)
  }

  let petId = null
  if (body.pet !== undefined && body.pet !== null) {
    const pet = body.pet
    if (!PET_SPECIES.includes(pet.species)) return controlError(res, `pet.species must be one of ${PET_SPECIES.join(', ')}`)
    if (!PET_SEXES.includes(pet.sex)) return controlError(res, `pet.sex must be one of ${PET_SEXES.join(', ')}`)
    for (const field of ['name', 'ownerFirstName', 'ownerLastName']) {
      if (typeof pet[field] !== 'string' || pet[field] === '') return controlError(res, `pet.${field} is required`)
    }
    /* The pet exists only because the kit was activated, at the provider or here; provisioning a
     * pet on an unactivated kit would be a state the vendor does not produce. */
    if (body.activated !== true) return controlError(res, 'a kit with a pet must be provisioned as activated')
    petId = randomUUID()
    state.pets.set(petId, {
      id: petId,
      name: pet.name,
      sex: pet.sex,
      species: pet.species,
      intact: pet.intact ?? true,
      organizationIdentity: null,
      ownerFirstName: pet.ownerFirstName,
      ownerLastName: pet.ownerLastName,
      createdAt: nowIso(),
      birthYear: pet.birthYear ?? null,
      birthMonth: pet.birthMonth ?? null,
      birthDay: pet.birthDay ?? null,
    })
  }

  const id = randomUUID()
  state.kits.set(id, {
    id,
    code,
    organizationIdentity: body.organizationIdentity ?? null,
    active: body.active ?? true,
    enabled: body.enabled ?? true,
    activated: body.activated === true,
    currentStage: body.stage ?? null,
    currentFailure: body.failure ?? null,
    createdAt: nowIso(),
    stageUpdatedAt: nowIso(),
    activatedOn: body.activated === true ? nowIso() : null,
    acknowledgedAt: body.acknowledged === true ? nowIso() : null,
    veterinarianName: body.veterinarianName ?? null,
    hospitalName: body.hospitalName ?? null,
    hospitalNumber: body.hospitalNumber === undefined || body.hospitalNumber === null ? null : String(body.hospitalNumber),
    labOrderNumber: body.labOrderNumber ?? null,
    inboundTrackingCode: null,
    outboundTrackingCode: null,
    reportReadyOn: (body.stage ?? null) === 'report-ready' ? nowIso() : null,
    sampleReceivedOn: null,
    profilingResultPresent: body.activated === true,
    petId,
    voyagerPetId: body.voyagerPetId ?? null,
    voyagerKit: body.voyagerKit ?? true,
    pdfFailure: body.pdfFailure ?? null,
  })
  log(`provisioned kit ${code} (${id}): activated=${body.activated === true}, stage=${String(body.stage ?? null)}, hospital=${String(body.hospitalNumber ?? null)}`)

  sendJson(res, 201, publicKit(state.kits.get(id)))
}

function handleControlDeleteKit (req, res, params) {
  const kit = findKit(params.key)
  if (kit === undefined) return controlError(res, `no kit '${params.key}'`)
  for (const [id, resultSet] of [...state.resultSets.entries()]) {
    if (resultSet.kitId === kit.id) state.resultSets.delete(id)
  }
  if (kit.petId !== null) state.pets.delete(kit.petId)
  state.kits.delete(kit.id)
  log(`removed kit ${kit.code} (${kit.id})`)
  sendJson(res, 200, { removed: kit.id })
}

async function handleControlSetPdfFailure (req, res, params) {
  const kit = findKit(params.key)
  if (kit === undefined) return controlError(res, `no kit '${params.key}'`)
  const body = await readJson(req)
  const mode = body.pdfFailure ?? null
  if (!PDF_FAILURE_MODES.includes(mode)) {
    return controlError(res, `pdfFailure must be one of ${PDF_FAILURE_MODES.map((value) => String(value)).join(', ')}; got '${String(mode)}'`)
  }
  kit.pdfFailure = mode
  log(`kit ${kit.code}: pdfFailure=${String(mode)}`)
  sendJson(res, 200, publicKit(kit))
}

/* Seed a result set for a kit. The BODY of the simplified result is supplied by the scenario rather
 * than canned here, so the scenario's value assertions compare against something it chose — but the
 * SHAPE is enforced, and so are the two properties that make those assertions falsifiable:
 * percentages must be distinct integers summing to 100, and the three ideal-weight numbers must be
 * distinct. A seed with two equal percentages would let a mapper that mixed up two breeds pass.
 *
 * `emptyIdealWeight` and `emptyNotable` select the OBSERVED third shape (load-bearing detail 8):
 * `ideal_weight_result: {}` alongside `notable_and_at_risk_health_test_results: []`, which a
 * sizeable minority of the live result sets carry. They were only ever seen together, so the
 * control plane accepts them separately but the scenario uses the pair. */
async function handleControlSeedResultSet (req, res, params) {
  const kit = findKit(params.key)
  if (kit === undefined) return controlError(res, `no kit '${params.key}'`)
  if (!kit.activated || kit.petId === null) return controlError(res, `kit '${kit.code}' is not activated, so it can carry no result set`)
  if ([...state.resultSets.values()].some((entry) => entry.kitId === kit.id)) {
    return controlError(res, `kit '${kit.code}' already has a result set`)
  }
  const body = await readJson(req)
  const pet = state.pets.get(kit.petId)

  const breeds = body.breeds
  if (!Array.isArray(breeds) || breeds.length === 0) return controlError(res, 'breeds must be a non-empty array')
  for (const breed of breeds) {
    if (!Number.isInteger(breed.percentage)) return controlError(res, 'every breed.percentage must be an integer (the vendor sends integers)')
    for (const field of ['slug', 'name', 'internalName']) {
      if (typeof breed[field] !== 'string' || breed[field] === '') return controlError(res, `every breed needs a non-empty ${field}`)
    }
  }
  if (new Set(breeds.map((breed) => breed.percentage)).size !== breeds.length) {
    return controlError(res, 'breed percentages must be distinct, or a mapper that swapped two breeds would still pass')
  }
  if (new Set(breeds.map((breed) => breed.slug)).size !== breeds.length) {
    return controlError(res, 'breed slugs must be distinct: the slug is the observation code')
  }
  if (breeds.reduce((total, breed) => total + breed.percentage, 0) !== 100) {
    return controlError(res, 'breed percentages must sum to 100, as the vendor\'s do')
  }

  /* OBSERVED on a sizeable minority of live result sets: `ideal_weight_result` is an empty OBJECT,
   * not a missing key. Served verbatim, because that is the body whose handling the scenario pins. */
  let idealWeightBody
  if (body.emptyIdealWeight === true) {
    idealWeightBody = {}
  } else {
    const weight = body.idealWeight
    if (weight === undefined || weight === null) return controlError(res, 'idealWeight is required (or set emptyIdealWeight to serve the vendor\'s empty-object form)')
    for (const field of ['min', 'max', 'pred']) {
      if (typeof weight[field] !== 'number') return controlError(res, `idealWeight.${field} must be a number`)
    }
    if (new Set([weight.min, weight.max, weight.pred]).size !== 3) {
      return controlError(res, 'idealWeight.min/max/pred must be three distinct numbers, or the three mapped items are indistinguishable')
    }
    /* The bare keys, as the live endpoint serves them on every non-empty body — NOT the
     * sex-qualified keys of the integration's own example fixtures, which are an older shape (see
     * load-bearing detail 8 in the header before changing these). */
    idealWeightBody = {
      min_size: weight.min,
      max_size: weight.max,
      pred_size: weight.pred,
      id: randomUUID(),
      result_set_id: null,
    }
  }

  const notable = body.notable
  let notableBody
  if (body.emptyNotable === true) {
    /* OBSERVED alongside the empty ideal weight above. The mapper's `.length === 0` skip handles
     * this one correctly, which is exactly why serving it is worth doing: it isolates the empty
     * ideal weight as the half that is NOT handled. */
    notableBody = []
  } else if (typeof notable === 'string') {
    if (notable === '') return controlError(res, 'notable, as a string, must be non-empty (set emptyNotable instead to serve the vendor\'s empty-array form)')
    notableBody = notable
  } else if (Array.isArray(notable)) {
    if (notable.length === 0) return controlError(res, 'notable, as an array, must be non-empty (set emptyNotable instead)')
    for (const entry of notable) {
      if (!Number.isFinite(entry.copies)) return controlError(res, 'every notable entry needs a numeric copies')
      for (const field of ['slug', 'diseaseName', 'testName', 'uiDescription', 'resultValue']) {
        if (typeof entry[field] !== 'string' || entry[field] === '') return controlError(res, `every notable entry needs a non-empty ${field}`)
      }
    }
    if (new Set(notable.map((entry) => entry.slug)).size !== notable.length) {
      return controlError(res, 'notable slugs must be distinct: the slug is the observation code')
    }
    notableBody = notable.map((entry) => {
      /* OBSERVED entry shape (a key-only scan of the one live result set that carried a finding).
       * `ui_description` really is at the ENTRY level, where the mapper reads it, and
       * `disease_name` really is a locale map. `result_value` is the key that was present;
       * `resolved_result`, which the mapper falls back to (`result_value ?? resolved_result`) and
       * which its interface marks optional, was NOT — so it is not served. The five keys after
       * `health_test` are the vendor's own and nothing reads them; they are here so the document
       * has the provider's shape rather than the parser's. */
      return {
        id: randomUUID(),
        health_result_id: randomUUID(),
        health_test_id: randomUUID(),
        copies: entry.copies,
        result_value: entry.resultValue,
        ui_description: entry.uiDescription,
        matches_assigned_breed: entry.matchesAssignedBreed ?? false,
        matches_breeds_detected: entry.matchesBreedsDetected ?? true,
        x_linked_sex: null,
        created_at: nowIso(),
        updated_at: nowIso(),
        health_test: {
          slug: entry.slug,
          test_name: entry.testName,
          disease_name: { en: entry.diseaseName },
        },
      }
    })
  } else {
    return controlError(res, 'notable must be a string or a non-empty array, or emptyNotable must be set — the three forms the vendor sends')
  }

  if (body.pdfFailure !== undefined) {
    if (!PDF_FAILURE_MODES.includes(body.pdfFailure)) {
      return controlError(res, `pdfFailure must be one of ${PDF_FAILURE_MODES.map((value) => String(value)).join(', ')}`)
    }
    kit.pdfFailure = body.pdfFailure
  }

  const id = randomUUID()
  state.resultSets.set(id, {
    id,
    kitId: kit.id,
    createdAt: nowIso(),
    acknowledgedAt: null,
    genotypeChipVersion: 'v5',
    /* KEY ORDER IS THE MAPPER'S seq ORDER — see handleSimplifiedResults. */
    simplified: {
      breed_percentages: breeds.map((breed) => ({
        percentage: breed.percentage,
        breed: {
          slug: breed.slug,
          internal_name: breed.internalName,
          name: { en: breed.name },
          /* Every live result body scanned was a dog's; `cat` here is INFERRED. */
          species: pet.species,
        },
      })),
      ideal_weight_result: idealWeightBody,
      notable_and_at_risk_health_test_results: notableBody,
    },
  })
  if (idealWeightBody.result_set_id === null) idealWeightBody.result_set_id = id

  /* The kit has a report now, so its stage advances the way the vendor's does. `report-ready` maps
   * to dmi COMPLETED through the ORDERS channel too — which is exactly why the scenario waits on
   * the REPORT rather than on the order: see the scenario's header. */
  kit.currentStage = 'report-ready'
  kit.stageUpdatedAt = nowIso()
  kit.reportReadyOn = nowIso()
  kit.profilingResultPresent = true
  log(`seeded result set ${id} for kit ${kit.code}`)

  sendJson(res, 201, { id, kitId: kit.id, kitCode: kit.code })
}

async function handleControlBearer (req, res) {
  const body = await readJson(req)
  if (typeof body.accept !== 'boolean') return controlError(res, 'accept must be a boolean')
  state.acceptBearers = body.accept
  /* The tokens are NOT cleared: the integration caches its token for ten days and never
   * re-authenticates, so switching acceptance back on has to make the SAME tokens work again or the
   * loop could never recover. See load-bearing detail 5. */
  log(`bearer acceptance ${body.accept ? 'restored' : 'revoked'} (${state.tokens.size} token(s) still known)`)
  sendJson(res, 200, { accept: state.acceptBearers, knownTokens: state.tokens.size })
}

function handleControlReset (req, res) {
  state = freshState()
  seedInventory()
  log('state reset')
  sendJson(res, 200, { status: 'reset' })
}

/* ---- request recording ---- */

function recordCall (req, url, body) {
  state.nextCallSeq += 1
  state.calls.push({
    seq: state.nextCallSeq,
    at: nowIso(),
    method: req.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    accept: req.headers.accept ?? null,
    authorization: req.headers.authorization ?? null,
    contentType: req.headers['content-type'] ?? null,
    body,
  })
  if (state.calls.length > MAX_CALL_LOG) state.calls.splice(0, state.calls.length - MAX_CALL_LOG)
}

/* ---- router ---- */

const routes = [
  ['GET', /^\/status$/, (req, res) => sendJson(res, 200, { status: 'ok', service: 'wisdom-panel-mock' })],

  /* Provider endpoints, at the paths `WisdomPanelApiEndpoints` declares — appended to the provider
   * configuration's baseUrl with no prefix of their own. */
  ['POST', /^\/oauth\/token$/, handleTokenGrant],
  ['GET', /^\/api\/v1\/kits$/, handleKits],
  ['GET', /^\/api\/v1\/result-sets$/, handleResultSets],
  ['GET', /^\/api\/voyager\/banfield-results-retrieval\/(?<kitId>[^/]+)$/, handleSimplifiedResults],
  ['GET', /^\/pdf-generator\/vet-report\/(?<kitId>[^/]+)$/, handleVetReport],
  ['POST', /^\/api\/voyager\/acknowledge-kits$/, handleAcknowledgeKits],
  ['POST', /^\/api\/voyager\/acknowledge-result-sets$/, handleAcknowledgeResultSets],
  ['POST', /^\/api\/voyager\/pet$/, handleCreatePet],
  ['GET', /^\/api\/voyager\/pet$/, handleGetPet],

  /* Control plane. Host-facing only; the integration never sees these. */
  [
    'GET',
    /^\/__control__\/config$/,
    (req, res) =>
      sendJson(res, 200, {
        username: USERNAME,
        organizationUnitId: ORGANIZATION_UNIT_ID,
        hospitalNumber: HOSPITAL_NUMBER,
        tokenExpiresIn: TOKEN_EXPIRES_IN,
        acceptBearers: state.acceptBearers,
        kitStages: KIT_STAGES,
        kitFailures: KIT_FAILURES,
        kitFilters: KIT_FILTERS,
        resultSetFilters: RESULT_SET_FILTERS,
      }),
  ],
  /* The clinic's unused kits, exactly as `getServices` reads them: `code` from the kit code and
   * `name` from `organization-identity`, which really is null for some of them. */
  [
    'GET',
    /^\/__control__\/inventory$/,
    (req, res) =>
      sendJson(res, 200, {
        kits: [...state.kits.values()]
          .filter((kit) => kit.voyagerKit && !kit.activated && kit.active)
          .map((kit) => ({ code: kit.code, name: kit.organizationIdentity })),
      }),
  ],
  /* The UNFILTERED listing — the mock's whole kit table, whatever any feed filter would hide. A
   * negative assertion ("this kit never became an order") needs it to show that the mock does hold
   * the kit, so that the filter is what hid it rather than the provisioning having failed. */
  ['GET', /^\/__control__\/kits$/, (req, res) => sendJson(res, 200, { kits: [...state.kits.values()].map(publicKit) })],
  [
    'GET',
    /^\/__control__\/kits\/(?<key>[^/]+)$/,
    (req, res, params) => {
      const kit = findKit(params.key)
      if (kit === undefined) return controlError(res, `no kit '${params.key}'`)
      sendJson(res, 200, publicKit(kit))
    },
  ],
  ['POST', /^\/__control__\/kits$/, handleControlProvisionKit],
  ['DELETE', /^\/__control__\/kits\/(?<key>[^/]+)$/, handleControlDeleteKit],
  ['POST', /^\/__control__\/kits\/(?<key>[^/]+)\/pdf$/, handleControlSetPdfFailure],
  ['POST', /^\/__control__\/kits\/(?<key>[^/]+)\/result-sets$/, handleControlSeedResultSet],
  [
    'GET',
    /^\/__control__\/result-sets$/,
    (req, res) =>
      sendJson(res, 200, {
        resultSets: [...state.resultSets.values()].map((resultSet) => ({
          id: resultSet.id,
          kitId: resultSet.kitId,
          kitCode: state.kits.get(resultSet.kitId)?.code ?? null,
          acknowledged: resultSet.acknowledgedAt !== null,
          acknowledgedAt: resultSet.acknowledgedAt,
        })),
      }),
  ],
  [
    'GET',
    /^\/__control__\/calls$/,
    (req, res, params, query) => {
      const since = Number(query.get('since') || 0)
      const path = query.get('path')
      const method = query.get('method')
      const calls = state.calls.filter(
        (call) =>
          call.seq > since &&
          (path === null || call.path === path) &&
          (method === null || call.method === method),
      )
      sendJson(res, 200, {
        counters: state.counters,
        fetches: state.fetches,
        tokens: [...state.tokens.keys()],
        acceptBearers: state.acceptBearers,
        lastSeq: state.nextCallSeq,
        calls,
      })
    },
  ],
  ['POST', /^\/__control__\/bearer$/, handleControlBearer],
  ['POST', /^\/__control__\/reset$/, handleControlReset],
]

const server = http.createServer(async (req, res) => {
  let url
  try {
    url = new URL(req.url, externalBase(req))
  } catch {
    sendJson(res, 400, { message: 'bad request URL' })
    return
  }
  const pathname = url.pathname.replace(/\/+$/, '') || '/'

  for (const [method, pattern, handler] of routes) {
    if (req.method !== method) continue
    const match = pattern.exec(pathname)
    if (match === null) continue
    const params = Object.fromEntries(
      Object.entries(match.groups || {}).map(([key, value]) => [key, decodeURIComponent(value)]),
    )

    /* Provider calls are recorded with their body; the control plane and /status are not, so a test
     * that reads the log never sees its own traffic in it. The body is read here once and handed to
     * the handler, because a request stream can only be consumed once. */
    const isProviderCall = !pathname.startsWith('/__control__') && pathname !== '/status'
    let body
    if (req.method === 'POST' || req.method === 'PUT') {
      const raw = await readRaw(req)
      try {
        body = raw.length === 0 ? {} : JSON.parse(raw)
      } catch {
        body = raw
      }
      /* Hand the parsed body back to the handlers, which call readJson(req) on a stream that is now
       * drained: replace it with a resolved value rather than re-reading. */
      req.parsedBody = body
    }
    if (isProviderCall) recordCall(req, url, body)

    try {
      await handler(req, res, params, url.searchParams)
    } catch (error) {
      log(`handler error on ${req.method} ${pathname}: ${error.stack || error}`)
      if (!res.headersSent) sendJson(res, 500, { message: `mock failure: ${error.message}` })
    }
    return
  }

  /* An unknown path. The vendor's 404 body was not captured, so this JSON:API envelope is INVENTED;
   * nothing in the integration reads it. */
  log(`404: no route for ${req.method} ${pathname}`)
  sendJsonApi(res, 404, {
    errors: [{ title: 'Not Found', detail: `${req.method} ${pathname} is not served`, code: '404', status: '404' }],
  })
})

server.listen(PORT, () =>
  log(`listening on :${PORT} (organization unit ${ORGANIZATION_UNIT_ID}, hospital ${HOSPITAL_NUMBER}, ${state.kits.size} kits in inventory)`),
)
