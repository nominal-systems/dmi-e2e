'use strict'

/* PLACEHOLDER — the antech-v6 mock is being built; this stub only proves the profile boots. It
 * answers /status, the login, and the two polling feeds with empty documents in the shapes the
 * integration's interceptor dereferences (both GetStatus keys, a bare array for GetAllResults). */

const http = require('http')

const PORT = Number(process.env.PORT || 3000)

function log (message) {
  console.log(`[antech-v6-mock] ${message}`)
}

function sendJson (res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  let raw = ''
  req.on('data', (chunk) => { raw += chunk })
  req.on('end', () => {
    log(`${req.method} ${url.pathname}${url.search}`)
    if (req.method === 'GET' && url.pathname === '/status') return sendJson(res, 200, { status: 'ok', service: 'antech-v6-mock' })
    if (req.method === 'POST' && url.pathname === '/Users/v6/Login') return sendJson(res, 200, { Token: 'antech-v6-mock-token', UserInfo: { ID: 1 } })
    if (req.method === 'GET' && url.pathname === '/LabResults/v6/GetStatus') return sendJson(res, 200, { LabOrders: [], LabResults: [] })
    if (req.method === 'GET' && url.pathname === '/LabResults/v6/GetAllResults') return sendJson(res, 200, [])
    if (req.method === 'GET' && url.pathname === '/Tests/v6') return sendJson(res, 200, { TotalCount: 0, LabResults: [] })
    sendJson(res, 404, { statusCode: 404, message: 'Resource not found' })
  })
})

server.listen(PORT, () => log(`listening on ${PORT}`))
