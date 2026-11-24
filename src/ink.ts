import { getStroke, type StrokeOptions } from 'perfect-freehand'
import type { Paper, PenType, Point, Stroke } from './types'

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

type StrokeStyle = Pick<Stroke, 'tool' | 'size' | 'pressure' | 'pen' | 'shape'>

const PEN_FEEL: Record<Exclude<PenType, 'calligraphy'>, { thinning: number; smoothing: number; streamline: number }> = {
  fountain: { thinning: 0.6, smoothing: 0.55, streamline: 0.25 },
  ballpoint: { thinning: 0.15, smoothing: 0.5, streamline: 0.3 },
  pencil: { thinning: 0.35, smoothing: 0.45, streamline: 0.2 },
  brush: { thinning: 0.85, smoothing: 0.65, streamline: 0.35 },
}

export function strokeOptions(s: StrokeStyle, last = true): StrokeOptions {
  if (s.shape) return { size: s.size, thinning: 0, smoothing: 0, streamline: 0, simulatePressure: false, last }
  if (s.tool === 'highlighter') {
    return { size: s.size, thinning: 0, smoothing: 0.6, streamline: 0.3, simulatePressure: false, last }
  }
  const pen = s.pen === 'calligraphy' || !s.pen ? 'fountain' : s.pen
  return {
    ...PEN_FEEL[pen],
    size: s.size,
    simulatePressure: !s.pressure,
    ...(pen === 'brush' ? { start: { taper: s.size * 2 }, end: { taper: s.size * 3 } } : {}),
    last,
  }
}

function convexHull(pts: [number, number][]): [number, number][] {
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: [number, number][] = []
  const upper: [number, number][] = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1))
}

/** Calligraphy: a flat 45° nib swept along the path (union of per-segment convex hulls, same winding). */
function calligraphyD(points: Point[], s: StrokeStyle): string {
  const nib = (p: Point): [number, number][] => {
    const a = s.size * 0.75 * (s.pressure ? 0.4 + 0.6 * p[2] : 0.8)
    const b = Math.max(0.6, s.size * 0.08)
    const ux = 0.7071 * a, uy = -0.7071 * a, vx = 0.7071 * b, vy = 0.7071 * b
    return [
      [p[0] + ux + vx, p[1] + uy + vy],
      [p[0] + ux - vx, p[1] + uy - vy],
      [p[0] - ux + vx, p[1] - uy + vy],
      [p[0] - ux - vx, p[1] - uy - vy],
    ]
  }
  // Light smoothing so the sharp nib doesn't amplify digitizer jitter.
  const pts: Point[] = []
  for (const p of points) {
    const q = pts[pts.length - 1]
    pts.push(q && !s.shape ? [q[0] + (p[0] - q[0]) * 0.6, q[1] + (p[1] - q[1]) * 0.6, p[2]] : p)
  }
  const poly = (h: [number, number][]) => 'M' + h.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join('L') + 'Z'
  if (pts.length === 1) return poly(convexHull(nib(pts[0])))
  let d = ''
  for (let i = 1; i < pts.length; i++) d += poly(convexHull([...nib(pts[i - 1]), ...nib(pts[i])]))
  return d
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

export function outlineD(points: Point[], s: StrokeStyle, last = true) {
  if (s.tool === 'pen' && s.pen === 'calligraphy') return calligraphyD(points, s)
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

export const strokeOpacity = (s: Pick<Stroke, 'tool' | 'pen'>) =>
  s.tool === 'highlighter' ? 0.45 : s.pen === 'pencil' ? 0.82 : 1

export function paintPath(ctx: CanvasRenderingContext2D, s: Pick<Stroke, 'tool' | 'color' | 'pen'>, path: Path2D) {
  ctx.fillStyle = s.color
  if (s.tool === 'pen' && s.pen === 'pencil') {
    ctx.globalAlpha = strokeOpacity(s)
    ctx.fill(path)
    ctx.globalAlpha = 1
  } else if (s.tool === 'highlighter') {
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
