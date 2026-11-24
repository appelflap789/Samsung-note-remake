import type { Point } from './types'

type XY = [number, number]

const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1])

function segDist(p: number[], a: number[], b: number[]) {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1])
}

function pathLength(pts: number[][]) {
  let l = 0
  for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i])
  return l
}

function area(pts: number[][]) {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length]
    a += p[0] * q[1] - q[0] * p[1]
  }
  return Math.abs(a / 2)
}

// Ramer–Douglas–Peucker simplification.
function rdp(pts: number[][], eps: number): number[][] {
  if (pts.length < 3) return pts
  let idx = 0, max = 0
  for (let i = 1; i < pts.length - 1; i++) {
    const d = segDist(pts[i], pts[0], pts[pts.length - 1])
    if (d > max) {
      max = d
      idx = i
    }
  }
  if (max <= eps) return [pts[0], pts[pts.length - 1]]
  return rdp(pts.slice(0, idx + 1), eps).slice(0, -1).concat(rdp(pts.slice(idx), eps))
}

/** Evenly sampled points along a polyline, so the stroke renderer keeps sharp corners. */
function densify(corners: XY[], closed: boolean, pressure: number): Point[] {
  const pts = closed ? [...corners, corners[0]] : corners
  const out: Point[] = []
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]
    const n = Math.max(1, Math.ceil(dist(a, b) / 3))
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n, pressure])
  }
  const last = pts[pts.length - 1]
  out.push([last[0], last[1], pressure])
  return out
}

const avgPressure = (pts: Point[]) => pts.reduce((s, p) => s + p[2], 0) / pts.length

/** Straight line from first to last point (snapped to horizontal/vertical when close), or null. */
export function straightLine(pts: Point[]): Point[] | null {
  if (pts.length < 2) return null
  const a = pts[0], b = pts[pts.length - 1]
  const len = dist(a, b)
  if (len < 20 || pathLength(pts) > len * 1.2) return null
  let maxDev = 0
  for (const p of pts) maxDev = Math.max(maxDev, segDist(p, a, b))
  if (maxDev > Math.max(4, len * 0.07)) return null
  const end: XY = [b[0], b[1]]
  const angle = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI
  const off = Math.abs(((angle % 90) + 90) % 90)
  if (off < 4 || off > 86) {
    if (Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1])) end[1] = a[1]
    else end[0] = a[0]
  }
  return densify([[a[0], a[1]], end], false, avgPressure(pts))
}

/** Recognises a line, triangle, rectangle/square or ellipse/circle; null when the stroke isn't one. */
export function recognizeShape(pts: Point[]): Point[] | null {
  const line = straightLine(pts)
  if (line) return line
  if (pts.length < 8) return null

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x)
    y0 = Math.min(y0, y)
    x1 = Math.max(x1, x)
    y1 = Math.max(y1, y)
  }
  const w = x1 - x0, h = y1 - y0, diag = Math.hypot(w, h)
  if (diag < 20 || dist(pts[0], pts[pts.length - 1]) > diag * 0.3) return null // must be (nearly) closed
  const p = avgPressure(pts)

  // Corners: simplify, merge the start/end, drop near-straight vertices.
  const c = rdp(pts, diag * 0.07) as XY[]
  if (c.length > 2 && dist(c[0], c[c.length - 1]) < diag * 0.3) c.pop()
  for (let changed = true; changed && c.length > 3; ) {
    changed = false
    for (let i = 0; i < c.length; i++) {
      const prev = c[(i + c.length - 1) % c.length], cur = c[i], next = c[(i + 1) % c.length]
      const a1 = Math.atan2(cur[1] - prev[1], cur[0] - prev[0])
      const a2 = Math.atan2(next[1] - cur[1], next[0] - cur[0])
      let turn = Math.abs(a2 - a1)
      if (turn > Math.PI) turn = 2 * Math.PI - turn
      if (turn < (28 * Math.PI) / 180) {
        c.splice(i, 1)
        changed = true
        break
      }
    }
  }
  const fit = c.length >= 3 ? area(pts) / area(c) : 0

  if (c.length === 3 && fit > 0.8 && fit < 1.2) return densify(c, true, p)
  if (c.length === 4 && fit > 0.85 && fit < 1.15) {
    const axisAligned = c.every((q, i) => {
      const n = c[(i + 1) % 4]
      const deg = Math.abs((Math.atan2(n[1] - q[1], n[0] - q[0]) * 180) / Math.PI) % 90
      return deg < 12 || deg > 78
    })
    if (!axisAligned) return densify(c, true, p)
    let [l, t, r, b] = [Math.min(...c.map((q) => q[0])), Math.min(...c.map((q) => q[1])), Math.max(...c.map((q) => q[0])), Math.max(...c.map((q) => q[1]))]
    if (Math.abs(r - l - (b - t)) < Math.max(r - l, b - t) * 0.12) {
      const s = (r - l + b - t) / 2, cx = (l + r) / 2, cy = (t + b) / 2
      ;[l, t, r, b] = [cx - s / 2, cy - s / 2, cx + s / 2, cy + s / 2]
    }
    return densify([[l, t], [r, t], [r, b], [l, b]], true, p)
  }

  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
  let rx = w / 2, ry = h / 2
  if (rx < 5 || ry < 5) return null
  let err = 0
  for (const [x, y] of pts) err += Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1)
  if (err / pts.length > 0.15) return null
  if (Math.abs(rx - ry) < Math.max(rx, ry) * 0.12) rx = ry = (rx + ry) / 2
  const n = Math.max(48, Math.ceil((Math.PI * (rx + ry)) / 3))
  const out: Point[] = []
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2
    out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t), p])
  }
  return out
}
