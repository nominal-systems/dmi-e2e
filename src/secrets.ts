import { ApiClient, expectOk } from './api-client'
import { env } from './env'

/* The credential scan: does a provider credential outlive the request that used it?
 *
 * The engines authenticate to each provider with a password and then a token, and both are meant to
 * live only in the engine's memory and on the wire to the provider. Three places can keep them
 * longer: dmi-api's provider request store (`GET /admin/external-requests`, which stores whatever
 * an engine's logging interceptor emits), the DMI order record (URIs the engine string-builds), and
 * the engine containers' own output. The full-stack scenarios read all three back once their loop
 * has run its course and assert that no credential is in any of them.
 *
 * A needle is either a LITERAL — a value the harness configured (the integration's dummy password)
 * or one the mock mints in a fixed form — or a PATTERN for the shape a credential takes on the wire
 * whatever its value: a query parameter, a JSON member, a bearer header. Every pattern is written so
 * that the masked form `***`, which is what a redacting fix writes, does not match: a fix must turn
 * the scan green, not swap one red for another.
 *
 * What a hit prints is safe to put in a CI log: the excerpt around it has every secret the needles
 * know masked, so a failure names where the credential was without republishing it. */

/* A literal shorter than this would match benign text (an admin password of `admin`, a database
 * password of `harness`), and a scan that is red for the wrong reason is as useless as one that
 * cannot go red. */
const MIN_LITERAL_LENGTH = 8

/* Characters of context on each side of a hit. */
const EXCERPT_CONTEXT = 30

/* What an excerpt shows in place of a secret. Deliberately not `***`: that is what a fix writes,
 * and a failure message should not look like the fixed output. */
const MASK = '[masked]'

export interface SecretNeedle {
  /* What the needle looks for, for a failure message. Never the secret itself. */
  name: string
  pattern: RegExp
  /* The capture group that is the secret itself, which an excerpt masks; 0 is the whole match. */
  secretGroup?: number
}

export interface SecretHit {
  needle: string
  excerpt: string
  /* How many places in the text produced this same masked excerpt — a log repeats one line per
   * poll, and the message should say so once. */
  occurrences: number
}

/* The loops whose stacks are scanned. Narrower than the registry's keys on purpose: a loop is
 * added here when its scenario gains the scan, with the credentials its own engine handles. */
export type ScannedStack = 'wisdom-panel' | 'antech-v6' | 'antech-v3'

function escapeRegExp (value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function literal (name: string, value: string, variable: string): SecretNeedle {
  if (value.length < MIN_LITERAL_LENGTH) {
    throw new Error(
      `${variable} is ${value.length} characters long; the credential scan needs at least ${MIN_LITERAL_LENGTH} ` +
        'to tell it from benign text — give the harness a longer dummy credential',
    )
  }
  /* Bounded on both sides, so `harness-pass` is not found inside `harness-password`. */
  return { name, pattern: new RegExp(`(?<![\\w-])${escapeRegExp(value)}(?![\\w-])`, 'g') }
}

/* The shapes, shared by every loop. Each value class excludes `*`, so `***` never matches, and stops
 * at whatever ends a value in a URL, a JSON string or a log line. A JSON member is matched with up to
 * three backslashes before each quote, because a request payload is stored as a JSON-encoded STRING
 * and so reaches the scan escaped once more (`\"password\":\"…\"`). */
const SHAPES: SecretNeedle[] = [
  {
    /* `?accesstoken=…`: Antech V6's test guide takes its token in the query string, and classic
     * Antech every call's. `%2A` is an escaped `*`, in case a fix masks before encoding. */
    name: 'a credential query parameter (accesstoken / access_token / token / password)',
    pattern: /[?&](accesstoken|access_token|token|password)=(?!%2[aA])([^\s&#"'<>\\*]+)/gi,
    secretGroup: 2,
  },
  {
    /* `"accessToken": "…"` as HTTP_DEBUG prints a request's headers, `"access_token": "…"` as a
     * token grant answers, and `"password": "…"` / `"Password": "…"` as a login body carries it. */
    name: 'a credential JSON member (accessToken / access_token / password)',
    pattern: /\\{0,3}"(accesstoken|access_token|password)\\{0,3}"\s*:\s*\\{0,3}"([^"\\*][^"\\]*)/gi,
    secretGroup: 2,
  },
  {
    /* An Authorization header as JSON, whatever its scheme — or none. The lookahead stops a masked
     * `Bearer ***` from matching by backtracking onto the scheme word itself. */
    name: 'an Authorization JSON member',
    pattern: /\\{0,3}"(?:proxy-)?authorization\\{0,3}"\s*:\s*\\{0,3}"(?:(?:Bearer|Basic|Token)\s+)?(?!(?:Bearer|Basic|Token)\b)([^"\\*\s][^"\\\s]*)/gi,
    secretGroup: 1,
  },
  {
    /* A bearer token anywhere. It must contain a digit, which every minted token does and the
     * English that follows the word in a log message ("bearer authentication") does not. */
    name: 'a bearer token',
    pattern: /\bBearer\s+(?=[A-Za-z0-9._~+/=-]*\d)([A-Za-z0-9._~+/=-]{8,})/gi,
    secretGroup: 1,
  },
  {
    /* A header as a log line or `util.inspect` prints it — `accessToken: 0123…`,
     * `authorization: 'Bearer …'` — unquoted key, so the JSON forms above are left to their own
     * needles. */
    name: 'a credential header line (accessToken / authorization)',
    pattern: /(?<![\w"'\\])(accesstoken|access_token|authorization)\s*:\s*['"]?(?:(?:Bearer|Basic)\s+)?(?!(?:Bearer|Basic)\b)([A-Za-z0-9._~+/=-]{8,})/gi,
    secretGroup: 2,
  },
]

/* The needles for one loop: the shapes, then the literal credentials its engine is handed and the
 * tokens its mock mints. The shapes come first so that, where two needles find the same secret,
 * the message names the shape — which says where it was — rather than the literal. */
export function secretNeedles (stack: ScannedStack): SecretNeedle[] {
  switch (stack) {
    case 'wisdom-panel':
      return [
        ...SHAPES,
        literal('the wisdom-panel password (provider configuration)', env.wisdomPanel.password, 'HARNESS_WISDOM_PANEL_PASSWORD'),
        /* `wp-mock-` + a UUID, minted per grant (src/wisdom-panel-mock). */
        {
          name: 'a token the wisdom-panel mock mints',
          pattern: /wp-mock-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
        },
      ]
    case 'antech-v6':
      return [
        ...SHAPES,
        literal('the antech-v6 password (integration options)', env.antechV6.password, 'HARNESS_ANTECH_V6_PASSWORD'),
        /* 32 lowercase hex characters, random per login (src/antech-v6-mock, as observed live). Not
         * part of a longer word or a hyphenated id: the same mock writes 32 hex characters inside
         * the `00-<32>-<16>-00` trace id of its validation errors, which is not a credential. */
        {
          name: 'a token the antech-v6 mock mints',
          pattern: /(?<![0-9A-Za-z_-])[0-9a-f]{32}(?![0-9A-Za-z_-])/g,
        },
      ]
    case 'antech-v3':
      return [
        ...SHAPES,
        literal('the antech-v3 password (integration options)', env.antechV3.password, 'HARNESS_ANTECH_V3_PASSWORD'),
        /* The one fixed token the antech-v3 mock mints at every login. */
        literal('the token the antech-v3 mock mints', 'antech-v3-mock-token', 'the antech-v3 mock token'),
      ]
  }
}

/* Every hit of every needle, as masked excerpts, de-duplicated. Where needles overlap — a token in
 * a query parameter is also a minted token — the first needle in the list names the hit. */
export function findSecrets (text: string, needles: SecretNeedle[]): SecretHit[] {
  const spans: Array<{ start: number, end: number, needle: string, order: number }> = []
  needles.forEach((needle, order) => {
    const flags = new Set(needle.pattern.flags.split(''))
    flags.add('g')
    flags.add('d')
    const pattern = new RegExp(needle.pattern.source, [...flags].join(''))
    for (const match of text.matchAll(pattern)) {
      const at = match.indices?.[needle.secretGroup ?? 0]
      if (at == null || at[1] <= at[0]) continue
      spans.push({ start: at[0], end: at[1], needle: needle.name, order })
    }
  })
  spans.sort((a, b) => a.start - b.start || a.order - b.order)

  /* The union of the spans, for masking, and the first span at each place, for reporting. */
  const masked: Array<{ start: number, end: number }> = []
  const reported: typeof spans = []
  for (const span of spans) {
    const last = masked[masked.length - 1]
    if (last != null && span.start < last.end) {
      last.end = Math.max(last.end, span.end)
      continue
    }
    masked.push({ start: span.start, end: span.end })
    reported.push(span)
  }

  const hits = new Map<string, SecretHit>()
  for (const span of reported) {
    const from = Math.max(0, span.start - EXCERPT_CONTEXT)
    const to = Math.min(text.length, span.end + EXCERPT_CONTEXT)
    let excerpt = ''
    let cursor = from
    for (const secret of masked) {
      if (secret.end <= from || secret.start >= to) continue
      excerpt += text.slice(cursor, Math.max(cursor, secret.start)) + MASK
      cursor = Math.min(to, secret.end)
    }
    excerpt += text.slice(cursor, to)
    excerpt = `${from > 0 ? '…' : ''}${excerpt.replace(/\s+/g, ' ')}${to < text.length ? '…' : ''}`

    const key = `${span.needle}\u0000${excerpt}`
    const hit = hits.get(key)
    if (hit != null) {
      hit.occurrences += 1
    } else {
      hits.set(key, { needle: span.needle, excerpt, occurrences: 1 })
    }
  }
  return [...hits.values()]
}

/* The assertion. Its message names the place, the count and the first few excerpts. A longer list
 * is logged as well, because an `it.failing` tripwire swallows its message and the log is then the
 * only place that says WHAT tripped it. */
export function expectNoSecrets (text: string, needles: SecretNeedle[], where: string): void {
  const hits = findSecrets(text, needles)
  if (hits.length === 0) return
  const occurrences = hits.reduce((sum, hit) => sum + hit.occurrences, 0)
  const describe = (shown: number): string =>
    `credential found in ${where}: ${hits.length} distinct excerpt(s), ${occurrences} occurrence(s) in all (secrets masked):\n` +
    hits.slice(0, shown).map((hit) => `  - ${hit.needle} (x${hit.occurrences}): ${hit.excerpt}`).join('\n') +
    (hits.length > shown ? `\n  … and ${hits.length - shown} more` : '')
  console.log(`[credential-scan] ${describe(20)}`)
  throw new Error(describe(5))
}

/* ---- the three places a credential can outlive its request ---- */

export interface StoredRequest {
  _id: string
  provider: string
  url: string
  method: string
  status: number
  integrationId?: string
  accessionIds?: string[]
  headers?: unknown
}

export interface StoredRequestDetail extends StoredRequest {
  body?: unknown
  payload?: unknown
}

export interface RequestStoreRead {
  /* The list rows, which carry `url` — and `headers`, were an engine to emit them; today's
   * records have none — but not `body` or `payload`. */
  records: StoredRequest[]
  /* `GET /admin/external-requests/:id` for every row, which carries everything. */
  details: StoredRequestDetail[]
  /* What was scanned, one record per line, kept apart because different defects put a credential
   * in each: the URLs (a token in a query string), the request headers, and the bodies and
   * payloads (a login exchange, stored whole). */
  urls: string
  headers: string
  bodies: string
}

const STORE_PAGE = 200
const STORE_MAX_PAGES = 50

/* Everything dmi-api's request store holds for the integrations a scenario made — all of them, so
 * that one made to provoke a failure is scanned too. The list is paged until it runs out — the
 * engine is still polling while it is read, so rows can shift a page and are de-duplicated by id —
 * and every row's detail is fetched, because only the detail carries the body and the payload. */
export async function readRequestStore (
  admin: ApiClient,
  { provider, integrationIds }: { provider: string, integrationIds: string[] },
): Promise<RequestStoreRead> {
  if (integrationIds.length === 0) throw new Error('readRequestStore: name at least one integration')
  const byId = new Map<string, StoredRequest>()
  for (let page = 1; ; page += 1) {
    if (page > STORE_MAX_PAGES) {
      throw new Error(`the ${provider} request store has more than ${STORE_MAX_PAGES * STORE_PAGE} records for these integrations; raise the scan's page cap`)
    }
    const listing = expectOk<{ total: number, data: StoredRequest[] }>(
      /* The route splits `integrationId` on commas and matches any of them. */
      await admin.get('/admin/external-requests', { providers: provider, integrationId: integrationIds.join(','), page, limit: STORE_PAGE }),
      `list the ${provider} request store, page ${page}`,
    )
    for (const record of listing.data) byId.set(record._id, record)
    if (listing.data.length < STORE_PAGE) break
  }
  const records = [...byId.values()]

  const details: StoredRequestDetail[] = []
  for (let i = 0; i < records.length; i += 20) {
    details.push(...await Promise.all(records.slice(i, i + 20).map(async (record) => expectOk<StoredRequestDetail>(
      await admin.get(`/admin/external-requests/${encodeURIComponent(record._id)}`),
      `read ${provider} request record ${record._id}`,
    ))))
  }

  return {
    records,
    details,
    urls: records.map((record) => JSON.stringify(record.url)).join('\n'),
    headers: records.map((record) => JSON.stringify(record.headers ?? null)).join('\n'),
    bodies: details.map((detail) => JSON.stringify({ body: detail.body ?? null, payload: detail.payload ?? null })).join('\n'),
  }
}

export interface OrderRecordRead {
  orders: any[]
  manifests: any[]
  /* The organization's events that concern these orders: each embeds the order as it stood. */
  events: any[]
  text: string
}

/* An attachment's `data` is the base64 PDF itself: kilobytes of noise to the scan, and nothing an
 * engine string-builds. Dropped wherever an attachment appears — a manifest, an order's embedded
 * manifest, an event's embedded order. */
function withoutAttachmentData (value: any): any {
  if (Array.isArray(value)) return value.map(withoutAttachmentData)
  if (value == null || typeof value !== 'object') return value
  const isAttachment = typeof value.contentType === 'string' && 'data' in value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !(isAttachment && key === 'data'))
      .map(([key, entry]) => [key, withoutAttachmentData(entry)]),
  )
}

const EVENTS_PAGE = 200
const EVENTS_MAX_PAGES = 50

/* The DMI order records as the PIMS reads them: `GET /orders/:id`, unless told otherwise
 * `GET /orders/:id/manifest`, and the events of `GET /events` that concern these orders. */
export async function readOrderRecords (
  api: ApiClient,
  orderIds: string[],
  { manifests = true }: { manifests?: boolean } = {},
): Promise<OrderRecordRead> {
  const read: OrderRecordRead = { orders: [], manifests: [], events: [], text: '' }
  for (const id of orderIds) {
    read.orders.push(withoutAttachmentData(expectOk<any>(await api.get(`/orders/${encodeURIComponent(id)}`), `read order ${id}`)))
    if (manifests) {
      read.manifests.push(withoutAttachmentData(expectOk<any>(await api.get(`/orders/${encodeURIComponent(id)}/manifest`), `read the manifest of order ${id}`)))
    }
  }
  for (let page = 1; ; page += 1) {
    if (page > EVENTS_MAX_PAGES) throw new Error(`more than ${EVENTS_MAX_PAGES * EVENTS_PAGE} events; raise the scan's page cap`)
    const listing = expectOk<{ data: any[] }>(
      await api.get('/events', { start_seq: 0, page, limit: EVENTS_PAGE }),
      `list the organization's events, page ${page}`,
    )
    for (const event of listing.data) {
      const text = JSON.stringify(event)
      if (orderIds.some((id) => text.includes(id))) read.events.push(withoutAttachmentData(event))
    }
    if (listing.data.length < EVENTS_PAGE) break
  }
  read.text = [...read.orders, ...read.manifests, ...read.events].map((record) => JSON.stringify(record)).join('\n')
  return read
}
