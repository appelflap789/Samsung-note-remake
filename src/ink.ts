import { getStroke, type StrokeOptions } from 'perfect-freehand'
import type { Paper, Point, Stroke } from './types'

export const PAGE_W = 1000
export const PAGE_H = 1414
export const PAPER_GAP = 40
const PAPER_LINE = '#dfe3ea'

/** Draws the paper template between page-unit rows y0..y1. */
export function drawPaper(ctx: CanvasRenderingContext2D, paper: Paper, y0: number, y1: number, zoom: number) {
  if (paper === 'plain') return
  const g = PAPER_GAP
  const start = Math.max(g, Math.ceil(y0 / g) * g)
  if (paper === 'dotted') {
    ctx.fillStyle = '#c9ced8'
    const r = 1.6
    for (let y = start; y <= y1; y += g) for (let x = g; x < PAGE_W; x += g) ctx.fillRect(x - r, y - r, r * 2, r * 2)
    return
  }
  ctx.strokeStyle = PAPER_LINE
  ctx.lineWidth = 1 / zoom
  ctx.beginPath()
  for (let y = start; y <= y1; y += g) {
    ctx.moveTo(0, y)
    ctx.lineTo(PAGE_W, y)
  }
  if (paper === 'grid') {
    for (let x = g; x < PAGE_W; x += g) {
      ctx.moveTo(x, Math.max(0, y0))
      ctx.lineTo(x, y1)
    }
  }
  ctx.stroke()
}

export function pageCount(strokes: Stroke[]): number {
  let m = 0
  for (const s of strokes) m = Math.max(m, strokeBounds(s)[3] - s.size)
  return Math.max(1, Math.floor(m / PAGE_H) + 1)
}

export function strokeOptions(s: Pick<Stroke, 'tool' | 'size' | 'pressure'>, last = true): StrokeOptions {
  if (s.tool === 'highlighter') {
    return { size: s.size, thinning: 0, smoothing: 0.6, streamline: 0.3, simulatePressure: false, last }
  }
  return {
    size: s.size,
    thinning: 0.6,
    smoothing: 0.55,
    streamline: 0.25,
    simulatePressure: !s.pressure,
    last,
  }
}

const avg = (a: number, b: number) => ((a + b) / 2).toFixed(2)

// From perfect-freehand's README: outline points -> smooth SVG path.
export function svgPathFromOutline(pts: number[][]): string {
  const len = pts.length
  if (len < 4) return ''
  let a = pts[0]
  let b = pts[1]
  const c = pts[2]
  let d = `M${a[0].toFixed(2)},${a[1].toFixed(2)} Q${b[0].toFixed(2)},${b[1].toFixed(2)} ${avg(b[0], c[0])},${avg(b[1], c[1])} T`
  for (let i = 2; i < len - 1; i++) {
    a = pts[i]
    b = pts[i + 1]
    d += `${avg(a[0], b[0])},${avg(a[1], b[1])} `
  }
  return d + 'Z'
}

export function outlineD(points: Point[], s: Pick<Stroke, 'tool' | 'size' | 'pressure'>, last = true) {
  return svgPathFromOutline(getStroke(points, strokeOptions(s, last)))
}

// Strokes are immutable once committed, so cache derived geometry per object.
const dCache = new WeakMap<Stroke, string>()
const pathCache = new WeakMap<Stroke, Path2D>()
const boundsCache = new WeakMap<Stroke, [number, number, number, number]>()

export function strokeD(s: Stroke): string {
  let d = dCache.get(s)
  if (d === undefined) {
    d = outlineD(s.points, s)
    dCache.set(s, d)
  }
  return d
}

export function strokePath(s: Stroke): Path2D {
  let p = pathCache.get(s)
  if (!p) {
    p = new Path2D(strokeD(s))
    pathCache.set(s, p)
  }
  return p
}

export function strokeBounds(s: Stroke): [number, number, number, number] {
  let b = boundsCache.get(s)
  if (!b) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const [x, y] of s.points) {
      if (x < x0) x0 = x
      if (y < y0) y0 = y
      if (x > x1) x1 = x
      if (y > y1) y1 = y
    }
    const r = s.size
    b = [x0 - r, y0 - r, x1 + r, y1 + r]
    boundsCache.set(s, b)
  }
  return b
}

export function paintPath(ctx: CanvasRenderingContext2D, s: Pick<Stroke, 'tool' | 'color'>, path: Path2D) {
  ctx.fillStyle = s.color
  if (s.tool === 'highlighter') {
    ctx.globalAlpha = 0.45
    ctx.globalCompositeOperation = 'multiply'
    ctx.fill(path)
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
  } else {
    ctx.fill(path)
  }
}

function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay
  const len2 = dx * dx + dy * dy
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0
  t = Math.max(0, Math.min(1, t))
  const cx = ax + t * dx - px, cy = ay + t * dy - py
  return cx * cx + cy * cy
}

/** Does an eraser circle of radius r at (x, y) touch stroke s? */
export function hitStroke(s: Stroke, x: number, y: number, r: number): boolean {
  const [x0, y0, x1, y1] = strokeBounds(s)
  if (x < x0 - r || x > x1 + r || y < y0 - r || y > y1 + r) return false
  const rr = (r + s.size / 2) ** 2
  const p = s.points
  if (p.length === 1) return (p[0][0] - x) ** 2 + (p[0][1] - y) ** 2 <= rr
  for (let i = 1; i < p.length; i++) {
    if (segDist2(x, y, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]) <= rr) return true
  }
  return false
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
