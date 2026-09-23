'use strict'

/* PLACEHOLDER — the wisdom-panel mock is being built; this stub only proves the profile boots. It
 * answers /status, the OAuth token grant, and the two JSON:API polling feeds with empty pages in
 * the shape the integration's interceptor dereferences (`meta['record-count']`), and records
 * every request so the placeholder scenario can see the engine polling. */

const http = require('http')

const PORT = Number(process.env.PORT || 3000)
const calls = []

function log (message) {
  console.log(`[wisdom-panel-mock] ${message}`)
}

function sendJson (res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function emptyPage () {
  return { data: [], meta: { 'record-count': 0 }, links: {} }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  let raw = ''
  req.on('data', (chunk) => { raw += chunk })
  req.on('end', () => {
    log(`${req.method} ${url.pathname}${url.search}`)
    if (!url.pathname.startsWith('/__control__') && url.pathname !== '/status') {
      calls.push({
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: { authorization: req.headers.authorization, accept: req.headers.accept },
      })
    }
    if (req.method === 'GET' && url.pathname === '/status') return sendJson(res, 200, { status: 'ok', service: 'wisdom-panel-mock' })
    if (req.method === 'GET' && url.pathname === '/__control__/calls') return sendJson(res, 200, { calls })
    if (req.method === 'POST' && url.pathname === '/oauth/token') {
      return sendJson(res, 200, { access_token: 'wisdom-panel-mock-token', token_type: 'Bearer', expires_in: 3456000, scope: 'organization', created_at: Math.floor(Date.now() / 1000) })
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/kits') return sendJson(res, 200, emptyPage())
    if (req.method === 'GET' && url.pathname === '/api/v1/result-sets') return sendJson(res, 200, emptyPage())
    sendJson(res, 404, { errors: [{ title: 'Not Found', detail: `${req.method} ${url.pathname} is not served`, code: '404', status: '404' }] })
  })
})

server.listen(PORT, () => log(`listening on ${PORT}`))
