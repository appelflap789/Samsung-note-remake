// Serves the built app and stores notes as JSON files in DATA_DIR.
// No dependencies: run with `node server.mjs` after `npm run build`.
import { createServer } from 'node:http'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

const PORT = Number(process.env.PORT ?? 8080)
const DATA = process.env.DATA_DIR ?? './data'
const DIST = new URL('./dist/', import.meta.url).pathname
const NOTES = join(DATA, 'notes')
const FOLDERS = join(DATA, 'folders.json')
const MAX_BODY = 50 * 1024 * 1024

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

await mkdir(NOTES, { recursive: true })

/** Write via a temp file + rename so a crash never leaves a half-written note. */
async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, data)
  await rename(tmp, file)
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > MAX_BODY) throw Object.assign(new Error('Body too large'), { status: 413 })
    chunks.push(c)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(body === undefined ? '' : JSON.stringify(body))
}

async function api(req, res, path) {
  if (path === '/api/db' && req.method === 'GET') {
    const notes = []
    for (const f of await readdir(NOTES)) {
      if (f.endsWith('.json')) notes.push(JSON.parse(await readFile(join(NOTES, f), 'utf8')))
    }
    const folders = JSON.parse(await readFile(FOLDERS, 'utf8').catch(() => '[]'))
    return send(res, 200, { notes, folders })
  }
  if (path === '/api/folders' && req.method === 'PUT') {
    const folders = await readBody(req)
    if (!Array.isArray(folders)) return send(res, 400, { error: 'Expected an array' })
    await writeAtomic(FOLDERS, JSON.stringify(folders))
    return send(res, 204)
  }
  const m = /^\/api\/notes\/([\w-]{1,64})$/.exec(path)
  if (m) {
    const file = join(NOTES, `${m[1]}.json`)
    if (req.method === 'PUT') {
      const note = await readBody(req)
      if (note?.id !== m[1]) return send(res, 400, { error: 'Note id mismatch' })
      await writeAtomic(file, JSON.stringify(note))
      return send(res, 204)
    }
    if (req.method === 'DELETE') {
      await rm(file, { force: true })
      return send(res, 204)
    }
  }
  send(res, 404, { error: 'Not found' })
}

async function serveStatic(res, path) {
  let rel = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, '')
  if (rel.endsWith('/')) rel += 'index.html'
  let file = join(DIST, rel)
  let body = await readFile(file).catch(() => null)
  if (!body) {
    // SPA fallback
    file = join(DIST, 'index.html')
    body = await readFile(file)
  }
  const hashed = rel.startsWith('/assets/')
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  res.end(body)
}

createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname
  try {
    if (path.startsWith('/api/')) await api(req, res, path)
    else await serveStatic(res, path)
  } catch (e) {
    console.error(req.method, path, e)
    if (!res.headersSent) send(res, e.status ?? 500, { error: e.message })
    else res.end()
  }
}).listen(PORT, () => console.log(`Notes server on :${PORT}, data in ${DATA}`))
