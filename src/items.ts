import { del, get, set } from 'idb-keyval'
import type { Item, TextItem } from './types'

export const API = `${import.meta.env.BASE_URL}api`
export const TEXT_PAD = 8
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'

// ---- media files (images), stored once per file name; names never change content ----

const mediaKey = (name: string) => `samsung-notes-media:${name}`
const PENDING_MEDIA = 'samsung-notes-media-pending-v1'
const bitmaps = new Map<string, Promise<ImageBitmap | null>>()
const ready = new Map<string, ImageBitmap>()

export async function saveMedia(name: string, blob: Blob) {
  await set(mediaKey(name), blob)
  const pending = (await get<string[]>(PENDING_MEDIA)) ?? []
  await set(PENDING_MEDIA, [...pending, name])
}

/** Upload media added on this device; the server must have them before content that points at them. */
export async function uploadMedia() {
  const pending = (await get<string[]>(PENDING_MEDIA)) ?? []
  for (const name of pending) {
    const blob = await get<Blob>(mediaKey(name))
    if (blob) {
      const res = await fetch(`${API}/media/${name}`, { method: 'PUT', body: blob })
      if (!res.ok) throw new Error(`Saving image failed (${res.status})`)
    }
    const now = (await get<string[]>(PENDING_MEDIA)) ?? []
    await set(PENDING_MEDIA, now.filter((n) => n !== name))
  }
}

async function loadMedia(name: string): Promise<Blob | null> {
  const local = await get<Blob>(mediaKey(name))
  if (local) return local
  try {
    const res = await fetch(`${API}/media/${name}`)
    if (!res.ok || res.headers.get('content-type')?.includes('text/html')) return null
    const blob = await res.blob()
    await set(mediaKey(name), blob)
    return blob
  } catch {
    return null
  }
}

/** Decoded image, downscaled so big photos don't eat the tablet's memory. Cached per file. */
export function imageBitmap(name: string): Promise<ImageBitmap | null> {
  let p = bitmaps.get(name)
  if (!p) {
    p = loadMedia(name).then(async (blob) => {
      if (!blob) return null
      try {
        const full = await createImageBitmap(blob)
        if (full.width <= 2000) return full
        const small = await createImageBitmap(blob, { resizeWidth: 2000, resizeQuality: 'high' })
        full.close()
        return small
      } catch {
        return null
      }
    })
    bitmaps.set(name, p)
    p.then((b) => (b ? ready.set(name, b) : bitmaps.delete(name))) // failed: retry later (e.g. when back online)
  }
  return p
}

/** Synchronous peek for rendering: the bitmap if it has finished loading (else `onLoad` runs once it has). */
export function readyBitmap(name: string, onLoad: () => void): ImageBitmap | null {
  const b = ready.get(name)
  if (b) return b
  imageBitmap(name).then((bm) => bm && onLoad())
  return null
}

export const forgetMedia = (name: string) => del(mediaKey(name))

// ---- text layout ----

export const font = (t: TextItem) => `${t.url ? '600 ' : ''}${t.size}px ${FONT}`
export const lineHeight = (t: TextItem) => t.size * (t.lh ?? 1.3)

/** Word-wrapped lines for the box's inner width. */
export function wrapText(ctx: CanvasRenderingContext2D, t: TextItem): string[] {
  ctx.font = font(t)
  const max = Math.max(10, t.w - TEXT_PAD * 2)
  const out: string[] = []
  for (const para of t.text.split('\n')) {
    let line = ''
    for (const word of para.split(/(?<=\s)/)) {
      const tryLine = line + word
      if (line && ctx.measureText(tryLine.trimEnd()).width > max) {
        out.push(line.trimEnd())
        line = word
      } else line = tryLine
      // A single word wider than the box: break it by characters.
      while (ctx.measureText(line.trimEnd()).width > max && line.length > 1) {
        let i = line.length - 1
        while (i > 1 && ctx.measureText(line.slice(0, i)).width > max) i--
        out.push(line.slice(0, i))
        line = line.slice(i)
      }
    }
    out.push(line.trimEnd())
  }
  return out
}

let measureCtx: CanvasRenderingContext2D | null = null
const mctx = () => (measureCtx ??= document.createElement('canvas').getContext('2d')!)

/** Bounds [x0, y0, x1, y1] of an item, including text that grows past its box. */
export function itemBounds(it: Item): [number, number, number, number] {
  if (it.kind === 'image') return [it.x, it.y, it.x + it.w, it.y + it.h]
  const h = it.url ? it.h : Math.max(it.h, wrapText(mctx(), it).length * lineHeight(it) + TEXT_PAD * 2)
  return [it.x, it.y, it.x + it.w, it.y + h]
}

export function drawItem(ctx: CanvasRenderingContext2D, it: Item, onLoad: () => void) {
  if (it.kind === 'image') {
    const bm = readyBitmap(it.media, onLoad)
    if (bm) ctx.drawImage(bm, it.x, it.y, it.w, it.h)
    else {
      ctx.fillStyle = '#eef0f3'
      ctx.fillRect(it.x, it.y, it.w, it.h)
    }
    return
  }
  const [, , , y1] = itemBounds(it)
  if (it.url) {
    ctx.fillStyle = '#f4f6fa'
    ctx.strokeStyle = '#d5dae3'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.roundRect(it.x, it.y, it.w, y1 - it.y, 12)
    ctx.fill()
    ctx.stroke()
  }
  ctx.fillStyle = it.color
  ctx.textBaseline = 'top'
  const lh = lineHeight(it)
  const lines = wrapText(ctx, it)
  const inset = it.url ? TEXT_PAD * 2 : TEXT_PAD
  lines.forEach((line, i) => {
    const y = it.y + inset + i * lh + (lh - it.size) / 2
    if (!it.url || y + lh < y1 - lh) ctx.fillText(line, it.x + inset, y)
  })
  if (it.url) {
    ctx.font = `${it.size * 0.8}px ${FONT}`
    ctx.fillStyle = '#2b5fd9'
    let url = it.url
    while (url.length > 8 && ctx.measureText(url).width > it.w - inset * 2) url = url.slice(0, -2)
    ctx.fillText(url === it.url ? url : url + '…', it.x + inset, y1 - inset - it.size * 0.8)
  }
}
