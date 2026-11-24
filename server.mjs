// Serves the built app and stores notes as JSON files in DATA_DIR.
// No dependencies: run with `node server.mjs` after `npm run build`.
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

const PORT = Number(process.env.PORT ?? 8080)
const DATA = process.env.DATA_DIR ?? './data'
const DIST = new URL('./dist/', import.meta.url).pathname
const NOTES = join(DATA, 'notes') // <id>.json: note without strokes
const STROKES = join(DATA, 'strokes') // <id>.json: the note's content, {strokes, items} (older files: strokes array)
const MEDIA = join(DATA, 'media') // images, named <random id>.<ext>; never change once written
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
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

await mkdir(NOTES, { recursive: true })
await mkdir(STROKES, { recursive: true })
await mkdir(MEDIA, { recursive: true })

/** Write via a temp file + rename so a crash never leaves a half-written note. */
async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, data)
  await rename(tmp, file)
}

// Note list kept in memory; `version` changes on every write so clients can poll cheaply.
const notes = new Map()
let version = Date.now()
const etag = () => `"${version}"`

for (const f of await readdir(NOTES)) {
  if (!f.endsWith('.json')) continue
  const note = JSON.parse(await readFile(join(NOTES, f), 'utf8'))
  if (note.strokes) {
    // Older format kept strokes inside the note file: split them out once.
    const { strokes, ...meta } = note
    await writeAtomic(join(STROKES, f), JSON.stringify(strokes))
    await writeAtomic(join(NOTES, f), JSON.stringify(meta))
    notes.set(meta.id, meta)
  } else notes.set(note.id, note)
}

async function readRaw(req) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > MAX_BODY) throw Object.assign(new Error('Body too large'), { status: 413 })
    chunks.push(c)
  }
  return Buffer.concat(chunks)
}
const readBody = async (req) => JSON.parse((await readRaw(req)).toString('utf8'))

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(body === undefined ? '' : JSON.stringify(body))
}

async function api(req, res, path) {
  if (path === '/api/db' && req.method === 'GET') {
    if (req.headers['if-none-match'] === etag()) {
      res.writeHead(304, { etag: etag(), 'cache-control': 'no-cache' })
      return res.end()
    }
    const folders = JSON.parse(await readFile(FOLDERS, 'utf8').catch(() => '[]'))
    res.writeHead(200, { 'content-type': 'application/json', etag: etag(), 'cache-control': 'no-cache' })
    return res.end(JSON.stringify({ notes: [...notes.values()], folders }))
  }
  if (path === '/api/folders' && req.method === 'PUT') {
    const folders = await readBody(req)
    if (!Array.isArray(folders)) return send(res, 400, { error: 'Expected an array' })
    await writeAtomic(FOLDERS, JSON.stringify(folders))
    version++
    return send(res, 204)
  }
  const media = /^\/api\/media\/([\w-]{1,64}\.(?:jpe?g|png|webp|gif))$/.exec(path)
  if (media) {
    const file = join(MEDIA, media[1])
    if (req.method === 'GET') {
      const body = await readFile(file).catch(() => null)
      if (!body) return send(res, 404, { error: 'Not found' })
      res.writeHead(200, { 'content-type': TYPES[extname(file)], 'cache-control': 'public, max-age=31536000, immutable' })
      return res.end(body)
    }
    if (req.method === 'PUT') {
      await writeAtomic(file, await readRaw(req))
      return send(res, 204)
    }
    return send(res, 405, { error: 'Method not allowed' })
  }
  const m = /^\/api\/notes\/([\w-]{1,64})(\/strokes)?$/.exec(path)
  if (m) {
    const [, id, strokesPath] = m
    const noteFile = join(NOTES, `${id}.json`)
    const strokesFile = join(STROKES, `${id}.json`)
    if (strokesPath && req.method === 'GET') {
      const stream = createReadStream(strokesFile)
      stream.once('open', () => {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        stream.pipe(res)
      })
      stream.once('error', () => send(res, 404, { error: 'Not found' }))
      return
    }
    if (strokesPath && req.method === 'PUT') {
      const content = await readBody(req)
      if (!Array.isArray(content) && !Array.isArray(content?.strokes)) return send(res, 400, { error: 'Expected {strokes, items}' })
      await writeAtomic(strokesFile, JSON.stringify(content))
      return send(res, 204)
    }
    if (strokesPath) return send(res, 405, { error: 'Method not allowed' })
    if (req.method === 'PUT') {
      const note = await readBody(req)
      if (note?.id !== id) return send(res, 400, { error: 'Note id mismatch' })
      delete note.strokes
      await writeAtomic(noteFile, JSON.stringify(note))
      notes.set(id, note)
      version++
      return send(res, 204)
    }
    if (req.method === 'DELETE') {
      await rm(noteFile, { force: true })
      await rm(strokesFile, { force: true })
      notes.delete(id)
      version++
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
