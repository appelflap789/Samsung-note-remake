/**
 * Import handwriting from Samsung Notes `.sdocx` files.
 *
 * Format facts from the public write-ups at
 * https://github.com/bxff/samsung-notes-format (RESEARCH.md) and the
 * twangodev/sdocx file-format notes. Only pen strokes are imported; typed text,
 * images and PDFs are skipped.
 */
import { PAGE_H, PAGE_W, uid } from './ink'
import type { Point, Stroke } from './types'

export interface ImportedNote {
  title: string
  strokes: Stroke[]
  pages: number
  skipped: number
}

// ---- minimal ZIP reader (stored + deflate, via the browser's DecompressionStream) ----

async function unzip(buf: Uint8Array, want: (name: string) => boolean): Promise<Map<string, Uint8Array>> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('Not a Samsung Notes file (no ZIP directory found).')
  const count = dv.getUint16(eocd + 10, true)
  let p = dv.getUint32(eocd + 16, true)
  const files = new Map<string, Uint8Array>()
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break
    const method = dv.getUint16(p + 10, true)
    const size = dv.getUint32(p + 20, true)
    const nameLen = dv.getUint16(p + 28, true)
    const skip = nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true)
    const local = dv.getUint32(p + 42, true)
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen))
    p += 46 + skip
    if (!want(name)) continue // skip images, PDFs, etc.
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true)
    const raw = buf.subarray(start, start + size)
    if (method === 0) files.set(name, raw)
    else if (method === 8) {
      const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
      files.set(name, new Uint8Array(await new Response(stream).arrayBuffer()))
    }
  }
  return files
}

// ---- binary helpers ----

class Reader {
  dv: DataView
  constructor(b: Uint8Array) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  }
  u8 = (o: number) => this.dv.getUint8(o)
  u16 = (o: number) => this.dv.getUint16(o, true)
  i16 = (o: number) => this.dv.getInt16(o, true)
  u32 = (o: number) => this.dv.getUint32(o, true)
  f32 = (o: number) => this.dv.getFloat32(o, true)
  f64 = (o: number) => this.dv.getFloat64(o, true)
  /** Little-endian bitmask of `len` bytes (masks are length-prefixed). */
  mask(o: number, len: number) {
    let m = 0
    for (let i = 0; i < Math.min(len, 4); i++) m += this.u8(o + i) * 2 ** (8 * i)
    return m
  }
}

/** Sign bit 15 + 15-bit magnitude, divided by `scale` (32 for coords, 4096 for pressure). */
const delta = (w: number, scale: number) => ((w & 0x8000 ? -1 : 1) * (w & 0x7fff)) / scale

interface RawStroke {
  points: Point[]
  color: number | null
  size: number | null
}

/** Decode one stroke object: base frame (type 0) followed by a stroke frame (type 1). */
function parseStroke(r: Reader, at: number, end: number): RawStroke | null {
  const baseSize = r.u32(at)
  const f = at + baseSize
  if (baseSize < 20 || f + 16 > end || r.i16(f + 4) !== 1) return null
  const flexOff = r.u32(f + 6)
  const propLen = r.u8(f + 10)
  const props = r.mask(f + 11, propLen)
  const fieldLen = r.u8(f + 11 + propLen)
  const fields = r.mask(f + 12 + propLen, fieldLen)
  let p = f + 12 + propLen + fieldLen
  if (props & 0x08) return null // eraser stroke
  const n = r.u16(p)
  p += 2
  if (n < 1) return null

  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  const pr = new Float32Array(n)
  if (props & 0x01) {
    if (p + 16 + (n - 1) * 4 + 4 + (n - 1) * 2 > end) return null
    xs[0] = r.f64(p)
    ys[0] = r.f64(p + 8)
    p += 16
    for (let i = 1; i < n; i++, p += 4) {
      xs[i] = xs[i - 1] + delta(r.u16(p), 32)
      ys[i] = ys[i - 1] + delta(r.u16(p + 2), 32)
    }
    pr[0] = r.f32(p)
    p += 4
    for (let i = 1; i < n; i++, p += 2) pr[i] = pr[i - 1] + delta(r.u16(p), 4096)
  } else {
    if (p + n * 20 > end) return null
    for (let i = 0; i < n; i++, p += 16) {
      xs[i] = r.f64(p)
      ys[i] = r.f64(p + 8)
    }
    for (let i = 0; i < n; i++, p += 4) pr[i] = r.f32(p)
  }

  // Flexible fields in mask-bit order; bits 0..3 are all 4 bytes wide.
  let q = f + flexOff
  let color: number | null = null
  let size: number | null = null
  for (let bit = 0; bit < 4; bit++) {
    if (!(fields & (1 << bit))) continue
    if (q + 4 > end) break
    if (bit === 2) color = r.u32(q)
    if (bit === 3) size = r.f32(q)
    q += 4
  }

  const points: Point[] = []
  for (let i = 0; i < n; i++) {
    const v = pr[i]
    points.push([xs[i], ys[i], Number.isFinite(v) ? Math.min(1, Math.max(0.05, v)) : 0.5])
  }
  return { points, color, size: size !== null && Number.isFinite(size) && size > 0 ? size : null }
}

/** Walk a `.page` file and return its size and all stroke objects (including those inside groups). */
export function parsePage(b: Uint8Array) {
  const r = new Reader(b)
  const propLen = r.u8(8)
  const fieldLen = r.u8(9 + propLen)
  const fixed = 10 + propLen + fieldLen
  const width = r.u32(fixed + 4)
  const height = r.u32(fixed + 8)
  const strokes: RawStroke[] = []
  let skipped = 0

  const readObject = (pos: number): number => {
    const type = r.u8(pos)
    const children = r.u16(pos + 1)
    const size = r.u32(pos + 3)
    const start = pos + 7
    const end = start + size - 32
    if (type === 1 || type === 15) {
      const s = parseStroke(r, start, end)
      if (s) strokes.push(s)
      else skipped++
    } else if (type !== 4 && type !== 100) skipped++
    pos = start + size
    for (let i = 0; i < children; i++) pos = readObject(pos)
    return pos
  }

  let pos = r.u32(0)
  const layers = r.u16(pos)
  pos += 4
  for (let l = 0; l < layers; l++) {
    pos += r.u32(pos) // layer header
    const objects = r.u32(pos)
    pos += 4
    for (let i = 0; i < objects; i++) pos = readObject(pos)
    pos += 32 // layer hash
  }
  return { width, height, strokes, skipped }
}

/** Page UUIDs in their authoritative order. */
function pageOrder(b: Uint8Array): string[] {
  const r = new Reader(b)
  const n = r.u16(32)
  const ids: string[] = []
  let p = 34
  for (let i = 0; i < n; i++) {
    const len = r.u16(p)
    ids.push(new TextDecoder('utf-16le').decode(b.subarray(p + 2, p + 2 + len * 2)))
    p += 2 + len * 2 + 32
  }
  return ids
}

const round = (v: number, f: number) => Math.round(v * f) / f

const hex = (n: number) => n.toString(16).padStart(2, '0')

/** Samsung exports are named "<title>_<yymmdd>_<hhmmss>.sdocx". */
export const titleFromFileName = (name: string) =>
  name.replace(/\.sdocx$/i, '').replace(/_\d{6}_\d{6}( \(\d+\))?$/, '')

export async function importSdocx(data: ArrayBuffer, fileName: string): Promise<ImportedNote> {
  const files = await unzip(new Uint8Array(data), (n) => n.endsWith('.page') || n === 'pageIdInfo.dat')
  const pageFiles = [...files.keys()].filter((k) => k.endsWith('.page'))
  if (!pageFiles.length) throw new Error('No pages found in this file.')

  let order = pageFiles
  const info = files.get('pageIdInfo.dat')
  if (info) {
    try {
      const ids = pageOrder(info)
      const sorted = ids.map((id) => pageFiles.find((k) => k.endsWith(`${id}.page`))).filter((k): k is string => !!k)
      if (sorted.length === pageFiles.length) order = sorted
    } catch {
      // fall back to ZIP order
    }
  }

  const strokes: Stroke[] = []
  let top = 0
  let skipped = 0
  for (const name of order) {
    const page = parsePage(files.get(name)!)
    skipped += page.skipped
    const scale = PAGE_W / (page.width || 1440)
    let bottom = top
    for (const s of page.strokes) {
      const argb = s.color ?? 0xff000000
      const alpha = (argb >>> 24) & 0xff
      // Rounded: far below a pixel, but keeps big notes several times smaller.
      const pts: Point[] = s.points.map(([x, y, p]) => [round(x * scale, 100), round(top + y * scale, 100), round(p, 1000)])
      for (const pt of pts) bottom = Math.max(bottom, pt[1])
      strokes.push({
        id: uid(),
        tool: alpha < 200 ? 'highlighter' : 'pen',
        color: `#${hex((argb >>> 16) & 0xff)}${hex((argb >>> 8) & 0xff)}${hex(argb & 0xff)}`,
        // Samsung's stored size renders at ~0.6x as our ballpoint diameter (measured against a screenshot).
        size: Math.max(1, (s.size ?? 7) * scale * 0.6),
        pressure: true,
        pen: 'ballpoint',
        points: pts,
      })
    }
    // Each Samsung page starts on a fresh page here.
    const pageEnd = Math.max(bottom, top + (page.height || 0) * scale)
    top = Math.ceil(pageEnd / PAGE_H - 0.02) * PAGE_H
  }

  return { title: titleFromFileName(fileName), strokes, pages: order.length, skipped }
}
