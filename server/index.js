/* eslint-disable no-console */
const http = require('http')
const crypto = require('crypto')
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const { URL } = require('url')

const PORT = Number(process.env.PORT || 8080)
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, '..', 'public')
const STATS_FILE = process.env.STATS_FILE || '/data/stats.json'
const MAX_BODY_BYTES = 256 * 1024

const ADMIN_LOGIN = process.env.ADMIN_LOGIN || 'admin'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''
const ADMIN_TOKEN_TTL_MS = Number(process.env.ADMIN_TOKEN_TTL_MS || 12 * 60 * 60 * 1000)

const adminTokens = new Map() // token -> expiresAt (ms)

function defaultStore() {
  return { version: 2, users: {} }
}

function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

async function readJsonFile(filePath) {
  try {
    const raw = await fsp.readFile(filePath, 'utf8')
    return JSON.parse(raw)
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null
    return null
  }
}

async function writeJsonAtomic(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`
  const payload = JSON.stringify(value)
  await fsp.writeFile(tmp, payload, 'utf8')
  await fsp.rename(tmp, filePath)
}

async function loadStore() {
  const parsed = await readJsonFile(STATS_FILE)
  if (!parsed || !isObject(parsed)) return defaultStore()
  if (parsed.version !== 2 || !isObject(parsed.users)) return defaultStore()
  return parsed
}

function defaultUser(now) {
  return {
    testsCompleted: 0,
    questionsAnswered: 0,
    questionsCorrect: 0,
    blocks: {},
    timeMsTotal: 0,
    timeMsByBlock: {},
    updatedAt: now,
  }
}

function safeInt(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0
  return Math.trunc(n)
}

function safeNonNegInt(n) {
  const v = safeInt(n)
  return v > 0 ? v : 0
}

function applyDelta(store, delta, now) {
  const nick = typeof delta.nick === 'string' ? delta.nick.trim() : ''
  if (!nick) return store

  const user = store.users[nick] && isObject(store.users[nick]) ? store.users[nick] : defaultUser(now)

  user.testsCompleted = safeNonNegInt(user.testsCompleted) + safeNonNegInt(delta.testsCompleted)
  user.questionsAnswered = safeNonNegInt(user.questionsAnswered) + safeNonNegInt(delta.questionsAnswered)
  user.questionsCorrect = safeNonNegInt(user.questionsCorrect) + safeNonNegInt(delta.questionsCorrect)
  user.timeMsTotal = safeNonNegInt(user.timeMsTotal) + safeNonNegInt(delta.timeMsTotal)

  if (!isObject(user.blocks)) user.blocks = {}
  if (!isObject(user.timeMsByBlock)) user.timeMsByBlock = {}

  if (isObject(delta.blocks)) {
    for (const [block, bs] of Object.entries(delta.blocks)) {
      if (typeof block !== 'string' || !block) continue
      const prev = isObject(user.blocks[block]) ? user.blocks[block] : { answered: 0, correct: 0 }
      const addAnswered = safeNonNegInt(bs && bs.answered)
      const addCorrect = safeNonNegInt(bs && bs.correct)
      user.blocks[block] = {
        answered: safeNonNegInt(prev.answered) + addAnswered,
        correct: safeNonNegInt(prev.correct) + addCorrect,
      }
    }
  }

  if (isObject(delta.timeMsByBlock)) {
    for (const [block, ms] of Object.entries(delta.timeMsByBlock)) {
      if (typeof block !== 'string' || !block) continue
      user.timeMsByBlock[block] = safeNonNegInt(user.timeMsByBlock[block]) + safeNonNegInt(ms)
    }
  }

  user.updatedAt = now
  store.users[nick] = user
  return store
}

function sendJson(res, status, obj) {
  const payload = JSON.stringify(obj)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(payload)
}

function sendText(res, status, text) {
  res.statusCode = status
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(text)
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  try {
    return crypto.timingSafeEqual(ab, bb)
  } catch {
    return false
  }
}

function issueAdminToken(now = Date.now()) {
  const token = crypto.randomBytes(24).toString('base64url')
  const ttl = Number.isFinite(ADMIN_TOKEN_TTL_MS) ? ADMIN_TOKEN_TTL_MS : 12 * 60 * 60 * 1000
  const expiresAt = now + ttl
  adminTokens.set(token, expiresAt)
  return { token, expiresAt }
}

function readBearerToken(req) {
  const h = req.headers.authorization
  if (typeof h !== 'string') return null
  const m = /^Bearer\s+(.+)$/.exec(h)
  if (!m) return null
  return m[1] || null
}

function isAdminAuthed(req, now = Date.now()) {
  const token = readBearerToken(req)
  if (!token) return false
  const exp = adminTokens.get(token)
  if (!exp || exp <= now) {
    adminTokens.delete(token)
    return false
  }
  return true
}

function requireAdmin(req, res) {
  if (!ADMIN_PASSWORD) {
    sendText(res, 503, 'Admin is not configured')
    return false
  }
  if (!isAdminAuthed(req)) {
    sendText(res, 401, 'Unauthorized')
    return false
  }
  return true
}

function guessContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8'
    case '.js':
      return 'text/javascript; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.svg':
      return 'image/svg+xml'
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.ico':
      return 'image/x-icon'
    case '.woff':
      return 'font/woff'
    case '.woff2':
      return 'font/woff2'
    default:
      return 'application/octet-stream'
  }
}

async function readBodyJson(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('Body too large')
    chunks.push(chunk)
  }
  if (!chunks.length) return null
  const raw = Buffer.concat(chunks).toString('utf8')
  return JSON.parse(raw)
}

let writeQueue = Promise.resolve()
function enqueueWrite(fn) {
  writeQueue = writeQueue.then(fn, fn)
  return writeQueue
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true })
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/login') {
    if (!ADMIN_PASSWORD) return sendText(res, 503, 'Admin is not configured')

    let body
    try {
      body = await readBodyJson(req)
    } catch {
      return sendText(res, 400, 'Invalid JSON')
    }
    if (!body || !isObject(body) || body.version !== 1) return sendText(res, 400, 'Bad request')
    const login = typeof body.login === 'string' ? body.login.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    if (!safeEqual(login, ADMIN_LOGIN) || !safeEqual(password, ADMIN_PASSWORD)) return sendText(res, 401, 'Unauthorized')

    const now = Date.now()
    const { token, expiresAt } = issueAdminToken(now)
    return sendJson(res, 200, { ok: true, token, expiresAt })
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/verify') {
    if (!ADMIN_PASSWORD) return sendText(res, 503, 'Admin is not configured')
    if (!isAdminAuthed(req)) return sendJson(res, 200, { ok: false })
    return sendJson(res, 200, { ok: true })
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/stats') {
    if (!requireAdmin(req, res)) return
    const store = await loadStore()
    return sendJson(res, 200, store)
  }

  // Public: returns stats for one nickname (so users can restore progress after localStorage resets).
  if (req.method === 'GET' && url.pathname === '/api/stats/user') {
    const nick = (url.searchParams.get('nick') || '').trim()
    if (!nick) return sendText(res, 400, 'Missing nick')
    const store = await loadStore()
    const user = store.users && store.users[nick] ? store.users[nick] : null
    return sendJson(res, 200, { ok: true, version: 1, nick, user })
  }

  if (req.method === 'POST' && url.pathname === '/api/stats/delta') {
    let body
    try {
      body = await readBodyJson(req)
    } catch {
      return sendText(res, 400, 'Invalid JSON')
    }
    if (!body || !isObject(body) || body.version !== 1) return sendText(res, 400, 'Bad delta')

    return enqueueWrite(async () => {
      const now = Date.now()
      const store = await loadStore()
      applyDelta(store, body, now)
      await writeJsonAtomic(STATS_FILE, store)
      return sendJson(res, 200, { ok: true, updatedAt: now })
    })
  }

  if (req.method === 'POST' && url.pathname === '/api/stats/users/delete') {
    if (!requireAdmin(req, res)) return
    let body
    try {
      body = await readBodyJson(req)
    } catch {
      return sendText(res, 400, 'Invalid JSON')
    }
    if (!body || !isObject(body) || body.version !== 1 || !Array.isArray(body.nicks)) return sendText(res, 400, 'Bad request')

    const nicks = body.nicks
      .filter((n) => typeof n === 'string')
      .map((n) => n.trim())
      .filter(Boolean)
    if (!nicks.length) return sendJson(res, 200, { ok: true, deleted: 0 })

    return enqueueWrite(async () => {
      const now = Date.now()
      const store = await loadStore()
      let deleted = 0
      for (const nick of nicks) {
        if (store.users && Object.prototype.hasOwnProperty.call(store.users, nick)) {
          delete store.users[nick]
          deleted += 1
        }
      }
      await writeJsonAtomic(STATS_FILE, store)
      return sendJson(res, 200, { ok: true, deleted, updatedAt: now })
    })
  }

  return sendText(res, 404, 'Not found')
}

async function serveStatic(req, res, url) {
  // Prevent path traversal.
  let decodedPath = url.pathname
  try {
    decodedPath = decodeURIComponent(url.pathname)
  } catch {
    return sendText(res, 400, 'Bad path')
  }

  const normalized = path.normalize(decodedPath).replace(/^(\.\.(\/|\\|$))+/, '')
  const relPath = normalized.replace(/^[/\\]+/, '')
  let filePath = path.join(STATIC_DIR, relPath)

  try {
    const st = await fsp.stat(filePath)
    if (st.isDirectory()) filePath = path.join(filePath, 'index.html')
  } catch {
    // SPA fallback: always serve index.html for non-API paths.
    filePath = path.join(STATIC_DIR, 'index.html')
  }

  try {
    const st = await fsp.stat(filePath)
    if (!st.isFile()) throw new Error('not a file')
    res.statusCode = 200
    res.setHeader('Content-Type', guessContentType(filePath))
    if (/\.(?:js|css|png|jpg|jpeg|gif|svg|ico|woff2?)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=604800')
    } else {
      res.setHeader('Cache-Control', 'no-cache')
    }
    fs.createReadStream(filePath).pipe(res)
  } catch {
    sendText(res, 404, 'Not found')
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url)
    return await serveStatic(req, res, url)
  } catch (e) {
    console.error(e)
    return sendText(res, 500, 'Internal error')
  }
})

server.listen(PORT, () => {
  const hasStatic = fs.existsSync(STATIC_DIR)
  console.log(`listening on :${PORT}`)
  console.log(`static dir: ${STATIC_DIR} (${hasStatic ? 'ok' : 'missing'})`)
  console.log(`stats file: ${STATS_FILE}`)
})
