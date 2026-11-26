'use strict'

/* Transport faults for the dmi-e2e provider mocks: a held answer, a reset connection, a stalled
 * body. One implementation, shared by every mock that wires it, so each fault behaves the same
 * whichever provider the loop stands in for. Zero-dependency CommonJS, like the mocks. Each mock
 * image copies this directory beside its own server (docker-compose.yml: `additional_contexts`
 * `mock-faults`, then `COPY --from=mock-faults`), and the server requires it as `../mock-faults`,
 * which resolves the same way in the repo and in the image.
 *
 * A fault is armed on one ROUTE KEY, the mock's own name for one logical call (the keys its status
 * scenarios use, plus any the mock adds), for the next `times` requests to that route (default 1).
 * After those it takes no more requests and the route answers as usual. It keeps what it took until
 * it is disarmed, so a test can assert that the fault really fired. The model is the harness's Mongo
 * failpoint (src/mongo.ts): one target, a number of attempts, and a hit count read back.
 *
 *   hold   { delayMs }               The route's handler runs on arrival, so its answer and whatever
 *                                    else it does (an order created, a scenario consumed) are fixed
 *                                    then. The answer is sent `delayMs` later. A client that gives up
 *                                    first gets nothing more.
 *   reset  { close }                 The route never runs. Once the request has arrived whole, the
 *                                    connection is closed with no response. `close: 'rst'` (the
 *                                    default) aborts it with a TCP RST (`socket.resetAndDestroy()`);
 *                                    Node's http client, and axios on it, report ECONNRESET with
 *                                    "read ECONNRESET". `close: 'fin'` ends it with a plain FIN
 *                                    (`socket.destroy()`); the same client reports ECONNRESET with
 *                                    "socket hang up". Measured on Node 20, GET and POST, with and
 *                                    without keep-alive.
 *   stall  { bytes, capMs }          The route's handler runs on arrival. Its status line and headers
 *                                    are sent, then the first `bytes` bytes of its body (default 0;
 *                                    never the whole body, whose length the headers still announce),
 *                                    and then nothing. The client has a response whose body never
 *                                    completes. The connection stays open until the client gives
 *                                    up, the fault is disarmed, or `capMs` passes (default 120 s),
 *                                    when it is closed with a FIN: the client then sees its body cut
 *                                    short.
 *
 * Nothing outlives the test that armed it. disarm(key) and reset() destroy every connection the key's
 * fault still holds or stalls (a FIN; the client sees its request fail, never a late answer), and
 * every hold and every stall has its own end: `delayMs`, and `capMs`, each at most 10 minutes. A held
 * answer is destroyed, not released early, on purpose: a test that failed midway must not have its
 * answer arrive in the next one.
 *
 * What a fault records, per request it took, in arrival order (`requests`): its `outcome` and the
 * milliseconds from its arrival to that outcome (`ms`, null while still open).
 *   held, stalled    still open
 *   answered         a hold whose answer went out
 *   client-closed    the client closed the connection first (it gave up, e.g. on its timeout)
 *   capped           a stall that reached `capMs`
 *   destroyed        disarmed, or the mock reset, while still open
 *   reset            a reset
 *
 * Every arming gets an `id`. disarm(key, id) disarms the key's fault only while it is that arming,
 * so a test whose cleanup runs late (after a jest timeout, say) cannot disarm the next test's fault
 * on the same key.
 *
 * A mock wires it in three places:
 *   const faults = createFaults({ keys: ['createOrder', …], log })
 *   in a route handler, first:   if (faults.intercept('createOrder', req, res)) return
 *   in its control plane:        faults.arm(spec), faults.list(), faults.disarm(key, id), faults.reset()
 * intercept() answers true only for a reset, which has taken the request: the handler must not
 * answer it. For a hold or a stall it answers false, and the handler answers as it always does: its
 * writes are captured and sent late, or in part. */

const FAULTS = ['hold', 'reset', 'stall']
const CLOSES = ['rst', 'fin']
/* The longest any fault may hold a connection: a hold's `delayMs`, a stall's `capMs`. */
const MAX_OPEN_MS = 10 * 60 * 1000
const DEFAULT_STALL_CAP_MS = 120 * 1000
const MAX_TIMES = 1000

/* The options each fault takes, beside `key`, `fault` and `times`. Anything else is refused, so a
 * misspelt option cannot fall back to a default the test did not ask for. */
const OPTIONS = { hold: ['delayMs'], reset: ['close'], stall: ['bytes', 'capMs'] }

function isWholeNumber (value, min, max) {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

/* The spec, checked: { error } naming what is wrong, or { fault } with every option resolved. */
function validate (spec, keys) {
  if (spec == null || typeof spec !== 'object') return { error: 'a fault is a JSON object' }
  const { key, fault } = spec
  if (typeof key !== 'string' || key === '') return { error: 'a fault requires a string "key"' }
  if (keys != null && !keys.includes(key)) {
    return { error: `unknown key '${key}': this mock's fault keys are ${keys.join(', ')}` }
  }
  if (!FAULTS.includes(fault)) return { error: `"fault" must be one of ${FAULTS.join(', ')}` }
  const unknown = Object.keys(spec).filter((name) => !['key', 'fault', 'times', ...OPTIONS[fault]].includes(name))
  if (unknown.length > 0) {
    return { error: `a ${fault} takes ${['times', ...OPTIONS[fault]].join(', ')}; not ${unknown.join(', ')}` }
  }
  const times = spec.times ?? 1
  if (!isWholeNumber(times, 1, MAX_TIMES)) return { error: `"times" must be a whole number from 1 to ${MAX_TIMES}` }

  if (fault === 'hold') {
    if (!isWholeNumber(spec.delayMs, 1, MAX_OPEN_MS)) {
      return { error: `a hold requires "delayMs", a whole number of milliseconds from 1 to ${MAX_OPEN_MS}` }
    }
    return { fault: { key, fault, times, delayMs: spec.delayMs } }
  }
  if (fault === 'reset') {
    const close = spec.close ?? 'rst'
    if (!CLOSES.includes(close)) return { error: `"close" must be one of ${CLOSES.join(', ')}` }
    return { fault: { key, fault, times, close } }
  }
  const bytes = spec.bytes ?? 0
  if (!isWholeNumber(bytes, 0, Number.MAX_SAFE_INTEGER)) return { error: '"bytes" must be a whole number, 0 or more' }
  const capMs = spec.capMs ?? DEFAULT_STALL_CAP_MS
  if (!isWholeNumber(capMs, 1, MAX_OPEN_MS)) {
    return { error: `"capMs" must be a whole number of milliseconds from 1 to ${MAX_OPEN_MS}` }
  }
  return { fault: { key, fault, times, bytes, capMs } }
}

/* Replace the methods that put bytes on the wire with recorders, so a handler can answer as usual
 * while the fault decides when, and how much of it, goes out. `restore()` puts them back. `body()` is
 * everything the handler wrote, as one Buffer. */
function capture (res, onEnd) {
  const calls = []
  const originals = { writeHead: res.writeHead, write: res.write, end: res.end }
  let ended = false
  res.writeHead = function (...args) {
    calls.push(['writeHead', args])
    return res
  }
  res.write = function (...args) {
    calls.push(['write', args])
    return true
  }
  res.end = function (...args) {
    calls.push(['end', args])
    if (!ended) {
      ended = true
      onEnd()
    }
    return res
  }
  const chunkOf = (args) => (typeof args[0] === 'function' || args[0] == null ? null : args[0])
  return {
    calls,
    originals,
    get ended () {
      return ended
    },
    restore () {
      Object.assign(res, originals)
    },
    body () {
      const chunks = calls
        .filter(([name]) => name === 'write' || name === 'end')
        .map(([, args]) => chunkOf(args))
        .filter((chunk) => chunk != null)
        .map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))))
      return Buffer.concat(chunks)
    },
  }
}

function createFaults (options) {
  const keys = options?.keys
  const log = options?.log ?? (() => undefined)
  /* key -> the armed fault: its spec, `id`, `hits` and `requests`. A fault stays here once spent, with
   * what it took, until it is disarmed or the mock reset. */
  const armed = new Map()
  /* Every connection a fault still holds or stalls, across keys: { fault, close(outcome) }. */
  const open = new Set()
  let nextId = 1

  function view (fault) {
    const { key, fault: kind, times, hits, id, requests, ...rest } = fault
    return {
      id,
      fault: kind,
      times,
      ...rest,
      hits,
      remaining: times - hits,
      open: requests.filter((request) => request.ms === null).length,
      requests: requests.map((request) => ({ outcome: request.outcome, ms: request.ms })),
    }
  }

  function closeOpen (fault, outcome) {
    for (const connection of [...open]) {
      if (fault == null || connection.fault === fault) connection.close(outcome)
    }
  }

  function arm (spec) {
    const checked = validate(spec, keys)
    if (checked.error != null) return { error: checked.error }
    const previous = armed.get(checked.fault.key)
    if (previous != null) closeOpen(previous, 'destroyed')
    const fault = { ...checked.fault, id: nextId++, hits: 0, requests: [] }
    armed.set(fault.key, fault)
    log(`fault armed on '${fault.key}': ${JSON.stringify(view(fault))}`)
    return { fault: view(fault) }
  }

  function disarm (key, id) {
    const fault = armed.get(key)
    if (fault == null || (id != null && fault.id !== id)) return null
    closeOpen(fault, 'destroyed')
    armed.delete(key)
    log(`fault disarmed on '${key}' after ${fault.hits} hit(s)`)
    return view(fault)
  }

  function reset () {
    closeOpen(null, 'destroyed')
    armed.clear()
  }

  function list () {
    return Object.fromEntries([...armed.values()].map((fault) => [fault.key, view(fault)]))
  }

  /* Take the request for the fault armed on `key`, if one is armed and has requests left. True only
   * for a reset, which has taken the request: the caller must not answer it. */
  function intercept (key, req, res) {
    const fault = armed.get(key)
    if (fault == null || fault.hits >= fault.times) return false
    fault.hits += 1
    const startedAt = Date.now()
    const request = { outcome: null, ms: null }
    fault.requests.push(request)
    const settle = (outcome) => {
      request.outcome = outcome
      request.ms = Date.now() - startedAt
    }
    /* A response whose connection is gone may still be written to by a late timer or handler; with
     * no listener, the error that write raises would end the mock's process. */
    res.on('error', () => undefined)

    if (fault.fault === 'reset') {
      settle('reset')
      const close = () => {
        if (fault.close === 'rst') req.socket.resetAndDestroy()
        else req.socket.destroy()
        log(`fault on '${key}': connection closed with no response (${fault.close})`)
      }
      /* After the whole request has arrived, so the client reads the close as an answer that never
       * came, not as a refused upload. */
      req.once('end', close)
      req.resume()
      return true
    }

    request.outcome = fault.fault === 'hold' ? 'held' : 'stalled'
    let timer = null
    /* Ends the request's fault once: the first of its own end, the client closing, or a disarm. */
    const end = (outcome) => {
      if (request.ms !== null) return false
      settle(outcome)
      clearTimeout(timer)
      open.delete(connection)
      recorder.restore()
      return true
    }
    const connection = {
      fault,
      close (outcome) {
        if (!end(outcome)) return
        res.destroy()
        log(`fault on '${key}': ${fault.fault} ended, ${outcome}`)
      },
    }
    const recorder = fault.fault === 'hold'
      ? capture(res, () => undefined)
      /* A stall: once the handler has answered, its head and the first bytes of its body go out,
       * and nothing after them. */
      : capture(res, () => {
        if (request.ms !== null) return
        recorder.restore()
        const body = recorder.body()
        const head = recorder.calls.find(([name]) => name === 'writeHead')
        if (head != null) recorder.originals.writeHead.apply(res, head[1])
        res.flushHeaders()
        const sent = Math.min(fault.bytes, Math.max(body.length - 1, 0))
        if (sent > 0) res.write(body.subarray(0, sent))
        log(`fault on '${key}': stalled after the headers and ${sent} of ${body.length} body byte(s)`)
        timer = setTimeout(() => connection.close('capped'), fault.capMs)
      })
    open.add(connection)
    res.once('close', () => {
      if (end('client-closed')) log(`fault on '${key}': the client closed the connection during the ${fault.fault}`)
    })

    if (fault.fault === 'hold') {
      timer = setTimeout(() => {
        if (!end('answered')) return
        for (const [name, args] of recorder.calls) recorder.originals[name].apply(res, args)
        log(`fault on '${key}': held answer sent after ${fault.delayMs} ms`)
      }, fault.delayMs)
      log(`fault on '${key}': holding the answer for ${fault.delayMs} ms`)
    }
    return false
  }

  return { arm, disarm, reset, list, intercept }
}

module.exports = { createFaults, FAULTS, MAX_OPEN_MS, DEFAULT_STALL_CAP_MS }
