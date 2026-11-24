/**
 * Import handwriting from Samsung Notes `.sdocx` files.
 *
 * Format facts from the public write-ups at
 * https://github.com/bxff/samsung-notes-format (RESEARCH.md) and the
 * twangodev/sdocx file-format notes. Imports pen strokes, shapes, images, text
 * boxes, typed body text and web link cards. PDFs and text styling are skipped.
 */
import { PAGE_H, PAGE_W, uid } from './ink'
import { TEXT_PAD } from './items'
import type { Item, Point, Stroke } from './types'

export interface ImportedNote {
  title: string
  strokes: Stroke[]
  items: Item[]
  /** Image files referenced by `items`, by media name. */
  media: Map<string, Blob>
  pages: number
  skipped: number
}

/** Samsung sizes text and margins in dp; a page is 360 dp wide. */
const DP = PAGE_W / 360
/** Font sizes in page units per Samsung size unit: fitted so typed body text fills each page like Samsung's page breaks. */
const PT = DP * 0.85
const IMAGE_TYPES: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }

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
  utf16(o: number, chars: number) {
    return new TextDecoder('utf-16le').decode(new Uint8Array(this.dv.buffer, this.dv.byteOffset + o, chars * 2))
  }
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
  /** Geometric shape outline (no pressure). */
  shape?: boolean
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

interface Frame {
  at: number
  size: number
  type: number
  flex: number
  fields: number
  fixed: number
}

/** An object's payload is a chain of frames (base, shape-base, shape, …). */
function frames(r: Reader, start: number, end: number): Frame[] {
  const out: Frame[] = []
  for (let p = start; p + 11 <= end; ) {
    const size = r.u32(p)
    const propLen = r.u8(p + 10)
    const fieldLen = r.u8(p + 11 + propLen)
    out.push({ at: p, size, type: r.i16(p + 4), flex: r.u32(p + 6), fields: r.mask(p + 12 + propLen, fieldLen), fixed: p + 12 + propLen + fieldLen })
    if (size < 11) break
    p += size
  }
  return out
}

/** Bounding box [left, top, right, bottom] from the base frame. */
function baseBounds(r: Reader, f: Frame): [number, number, number, number] {
  const q = f.fixed + 6 + r.u16(f.fixed + 4) + 8
  return [r.f64(q), r.f64(q + 8), r.f64(q + 16), r.f64(q + 24)]
}

export interface RawText {
  text: string
  /** Font size in dp. */
  size: number
  color: number
  lineSpacing: number
  margins: [number, number, number, number]
  /** Per-page [start, length] ranges of body text. */
  sections: [number, number][]
}

/** Text with its style runs. `q` points at the u32 size in front of it. */
function textCommon(r: Reader, q: number): RawText {
  const end = q + 4 + r.u32(q)
  let p = q + 4
  const len = r.u32(p)
  const text = r.utf16(p + 4, len)
  p += 4 + len * 2
  // Style runs: [type, start, end, value]; keep the widest font size (3) and colour (1).
  let size = 15, color = 0xff252525, lineSpacing = 1.3
  let sizeRange = -1, colorRange = -1
  const runs = (onRun: (type: number, from: number, to: number, value: number) => void) => {
    const n = r.u32(p)
    p += 4
    for (let i = 0; i < n; i++) {
      const rs = r.u16(p)
      if (rs >= 20) onRun(r.u32(p + 2), r.u32(p + 6), r.u32(p + 10), p + 18)
      p += 2 + rs
    }
  }
  runs((type, from, to, v) => {
    if (type === 3 && to - from > sizeRange) [size, sizeRange] = [r.f32(v), to - from]
    if (type === 1 && to - from > colorRange) [color, colorRange] = [r.u32(v), to - from]
  })
  runs((type, _from, _to, v) => {
    if (type === 4 && r.u32(v - 4) === 1) lineSpacing = r.f32(v) // proportional spacing
  })
  const margins: [number, number, number, number] = [r.f32(p), r.f32(p + 4), r.f32(p + 8), r.f32(p + 12)]
  p += 17
  const sections: [number, number][] = []
  if (p + 2 <= end) {
    const n = r.u16(p)
    for (let i = 0; i < n && p + 10 + i * 8 <= end; i++) sections.push([r.u32(p + 2 + i * 8), r.u32(p + 6 + i * 8)])
  }
  if (!(size > 0 && size < 500)) size = 15
  return { text, size, color, lineSpacing, margins, sections }
}

/** Flexible fields of the shape frame: text (bit 0) and an image fill (bit 5, kind 2 → media bind id). */
function shapeFields(r: Reader, f: Frame) {
  let q = f.at + f.flex
  let text: RawText | null = null
  let media: number | null = null
  if (f.fields & 1) {
    text = textCommon(r, q)
    q += 4 + r.u32(q)
  }
  if (f.fields & 0b10) q += 1
  if (f.fields & 0b100) q += 4
  if (f.fields & 0b1000) return { text, media } // unknown width
  if (f.fields & 0b10000) q += 4
  if (f.fields & 0b100000 && r.u8(q + 4) === 2) media = r.u32(q + 6)
  return { text, media }
}

/** Shape outline (frame 7 fixed part) as polylines, in page coordinates. */
function shapePath(r: Reader, f: Frame): [number, number][][] {
  let p = f.fixed + 4 + 32 + 4
  const pathEnd = p + 4 + r.u32(p)
  const n = r.u32(p + 4)
  p += 8
  const lines: [number, number][][] = []
  let cur: [number, number][] = []
  const at = () => cur[cur.length - 1] ?? [0, 0]
  for (let i = 0; i < n && p < pathEnd; i++) {
    const verb = r.u8(p++)
    const c = (k: number) => r.f64(p + k * 8)
    if (verb === 1) {
      if (cur.length > 1) lines.push(cur)
      cur = [[c(0), c(1)]]
      p += 16
    } else if (verb === 2) {
      cur.push([c(0), c(1)])
      p += 16
    } else if (verb === 3) {
      const [x0, y0] = at()
      for (let t = 1; t <= 8; t++) {
        const u = t / 8, v = 1 - u
        cur.push([v * v * x0 + 2 * v * u * c(0) + u * u * c(2), v * v * y0 + 2 * v * u * c(1) + u * u * c(3)])
      }
      p += 32
    } else if (verb === 4) {
      const [x0, y0] = at()
      for (let t = 1; t <= 12; t++) {
        const u = t / 12, v = 1 - u
        const bz = (a: number, b: number, cc: number, d: number) => v * v * v * a + 3 * v * v * u * b + 3 * v * u * u * cc + u * u * u * d
        cur.push([bz(x0, c(0), c(2), c(4)), bz(y0, c(1), c(3), c(5))])
      }
      p += 48
    } else if (verb === 0 || verb === 5) {
      if (cur.length) cur.push(cur[0])
    } else break // unknown command
  }
  if (cur.length > 1) lines.push(cur)
  return lines
}

/** Outline colour and width from the shape-base frame (bits 2 and 3). */
function lineStyle(r: Reader, f: Frame) {
  let q = f.at + f.flex
  let color: number | null = null
  let width = 4
  if (f.fields & 0b100) {
    color = r.u32(q + 7)
    q += 4 + r.u32(q)
  }
  if (f.fields & 0b1000) width = r.f32(q + 4)
  return { color, width: Number.isFinite(width) && width > 0 ? width : 4 }
}

/** A web link card: the URL and the title in front of it, both stored as length-prefixed UTF-16. */
function webLink(r: Reader, f: Frame) {
  const end = f.at + f.size
  const strings = new Map<number, string>() // end offset -> text
  let url: string | null = null
  let urlAt = 0
  for (let p = f.fixed; p + 2 < end; p++) {
    const n = r.u16(p)
    if (n < 2 || p + 2 + n * 2 > end) continue
    const t = r.utf16(p + 2, n)
    if ([...t].some((ch) => ch < ' ' && ch !== '\n' || ch === '\ufffd')) continue
    strings.set(p + 2 + n * 2, t)
    if (!url && /^https?:\/\/\S+$/.test(t)) [url, urlAt] = [t, p]
  }
  return url ? { url, title: strings.get(urlAt) ?? url } : null
}

export interface RawItem {
  kind: 'image' | 'text' | 'link'
  bounds: [number, number, number, number]
  media?: number
  text?: RawText
  url?: string
}

/** Walk a `.page` file and return its size and all objects (including those inside groups). */
export function parsePage(b: Uint8Array) {
  const r = new Reader(b)
  const propLen = r.u8(8)
  const fieldLen = r.u8(9 + propLen)
  const fixed = 10 + propLen + fieldLen
  const width = r.u32(fixed + 4)
  const height = r.u32(fixed + 8)
  const strokes: RawStroke[] = []
  const items: RawItem[] = []
  let skipped = 0

  const parseObject = (type: number, start: number, end: number): boolean => {
    const fr = frames(r, start, end)
    if (!fr.length) return false
    const bounds = baseBounds(r, fr[0])
    if (type === 13) {
      const f = fr.find((x) => x.type === 13)
      const link = f && webLink(r, f)
      if (link) items.push({ kind: 'link', bounds, url: link.url, text: { text: link.title, size: 14, color: 0xff1f1f1f, lineSpacing: 1.3, margins: [0, 0, 0, 0], sections: [] } })
      return !!link
    }
    const shape = fr.find((x) => x.type === 7)
    if (!shape) return false
    const { text, media } = shapeFields(r, shape)
    if (media !== null) {
      items.push({ kind: 'image', bounds, media })
      return true
    }
    let used = false
    if (type === 7) {
      const base = fr.find((x) => x.type === 6)
      const style = base ? lineStyle(r, base) : null
      if (style?.color != null) {
        for (const line of shapePath(r, shape))
          strokes.push({ points: line.map(([x, y]) => [x, y, 0.5]), color: style.color, size: style.width, shape: true })
        used = true
      }
    }
    if (text && text.text.trim()) {
      items.push({ kind: 'text', bounds, text })
      used = true
    }
    return used
  }

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
    } else if (type === 2 || type === 3 || type === 7 || type === 13) {
      let ok = false
      try {
        ok = parseObject(type, start, end)
      } catch {
        // malformed object
      }
      if (!ok) skipped++
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
  return { width, height, strokes, items, skipped }
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

/** Typed body text of the note (in `note.note`), split per page. */
function bodyText(b: Uint8Array): RawText | null {
  const r = new Reader(b)
  const propLen = r.u8(4)
  let p = 6 + propLen + r.u8(5 + propLen) + 4
  p += 2 + r.u16(p) * 2 + 20 + 20 // note id; revision + times; size + paddings + min version
  p += 4 + r.u32(p) // title object
  const size = r.u32(p)
  const shape = frames(r, p + 4, p + 4 + size).find((f) => f.type === 7)
  return shape && shape.fields & 1 ? textCommon(r, shape.at + shape.flex) : null
}

const argbHex = (argb: number) => `#${hex((argb >>> 16) & 0xff)}${hex((argb >>> 8) & 0xff)}${hex(argb & 0xff)}`

export async function importSdocx(data: ArrayBuffer, fileName: string): Promise<ImportedNote> {
  const files = await unzip(
    new Uint8Array(data),
    (n) => n.endsWith('.page') || n === 'pageIdInfo.dat' || n === 'note.note' || /^media\/\d+@.+\.(jpe?g|png|webp|gif)$/i.test(n),
  )
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

  let body: RawText | null = null
  try {
    const nn = files.get('note.note')
    body = nn ? bodyText(nn) : null
  } catch {
    // older note header layout: no typed text
  }
  if (body && !body.sections.length) body.sections = [[0, body.text.length]]

  const media = new Map<string, Blob>()
  const mediaName = new Map<number, string>()
  const imageFile = (bind: number) => {
    if (!mediaName.has(bind)) {
      const file = [...files.keys()].find((k) => k.startsWith(`media/${bind}@`))
      if (!file) return null
      const ext = file.split('.').pop()!.toLowerCase()
      const name = `${uid()}.${ext}`
      media.set(name, new Blob([files.get(file) as BlobPart], { type: IMAGE_TYPES[ext] }))
      mediaName.set(bind, name)
    }
    return mediaName.get(bind)!
  }

  const strokes: Stroke[] = []
  const items: Item[] = []
  let top = 0
  let skipped = 0
  for (const [index, name] of order.entries()) {
    const page = parsePage(files.get(name)!)
    skipped += page.skipped
    const scale = PAGE_W / (page.width || 1440)
    let bottom = top

    const pageItems: Item[] = []
    for (const it of page.items) {
      const [x0, y0, x1, y1] = it.bounds
      const box = { id: uid(), x: x0 * scale, y: top + y0 * scale, w: (x1 - x0) * scale, h: (y1 - y0) * scale }
      if (!(box.w > 1 && box.h > 1)) continue
      if (it.kind === 'image') {
        const file = imageFile(it.media!)
        if (file) items.push({ kind: 'image', ...box, media: file })
        else skipped++
      } else {
        const t = it.text!
        pageItems.push({ kind: 'text', ...box, text: t.text.trimEnd(), size: t.size * PT, color: argbHex(t.color), url: it.url })
      }
    }
    const section = body?.sections[index]
    let text = section && body!.text.slice(section[0], section[0] + section[1]).trimEnd()
    if (text && text.trim()) {
      const [ml, mt, mr] = body!.margins
      const size = body!.size * PT
      const lh = body!.lineSpacing * 1.17 // Android's proportional spacing multiplies the font's own line height
      let y = top + mt * DP - TEXT_PAD
      // Text flows below a link card at the top of the page; its blank lines are the card's room.
      const card = pageItems.find((it) => it.kind === 'text' && it.url && it.y < y + size * lh * 2)
      if (card) {
        const lead = text.length - text.replace(/^\n+/, '').length
        text = text.slice(Math.min(lead, Math.round((card.y + card.h - y) / (size * lh))))
        y = card.y + card.h
      }
      items.push({ kind: 'text', id: uid(), x: ml * DP - TEXT_PAD, y, w: PAGE_W - (ml + mr) * DP + TEXT_PAD * 2, h: 0, text, size, color: argbHex(body!.color), lh })
    }
    items.push(...pageItems)
    for (const s of page.strokes) {
      const argb = s.color ?? 0xff000000
      const alpha = (argb >>> 24) & 0xff
      // Rounded: far below a pixel, but keeps big notes several times smaller.
      const pts: Point[] = s.points.map(([x, y, p]) => [round(x * scale, 100), round(top + y * scale, 100), round(p, 1000)])
      for (const pt of pts) bottom = Math.max(bottom, pt[1])
      strokes.push({
        id: uid(),
        tool: alpha < 200 ? 'highlighter' : 'pen',
        color: argbHex(argb),
        // Samsung's stored size renders at ~0.6x as our ballpoint diameter (measured against a screenshot).
        size: Math.max(1, (s.size ?? 7) * scale * 0.6),
        pressure: !s.shape,
        pen: 'ballpoint',
        ...(s.shape ? { shape: true } : {}),
        points: pts,
      })
    }
    // Each Samsung page starts on a fresh page here.
    const pageEnd = Math.max(bottom, top + (page.height || 0) * scale)
    top = Math.ceil(pageEnd / PAGE_H - 0.02) * PAGE_H
  }

  return { title: titleFromFileName(fileName), strokes, items, media, pages: order.length, skipped }
}
