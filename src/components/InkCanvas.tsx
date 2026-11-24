import { useEffect, useRef } from 'react'
import type { Paper, PenType, Point, Stroke, Tool } from '../types'
import { PAGE_H, PAGE_W, drawPaper, hitStroke, outlineD, paintPath, strokeBounds, strokePath, uid } from '../ink'
import { recognizeShape, straightLine } from '../shapes'

interface Props {
  strokes: Stroke[]
  paper: Paper
  tool: Tool
  pen: PenType
  color: string
  size: number
  eraserSize: number
  penOnly: boolean
  straighten: boolean
  selection: string[]
  onAdd: (s: Stroke) => void
  onErase: (ids: string[]) => void
  onSelect: (ids: string[]) => void
  onMoveSelection: (dx: number, dy: number) => void
  /** S Pen side button clicked while not writing (Android only reports it as a click). */
  onPenButton: () => void
  /** A draw/erase gesture finished (pen lifted). */
  onGestureEnd: () => void
}

const TOP = 24 // screen px gap above the first page
const HOLD_MS = 600 // keep the pen still this long to snap the stroke into a shape

type Mode = 'none' | 'draw' | 'erase' | 'pan' | 'lasso' | 'move'

function inPolygon(x: number, y: number, poly: number[][]) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function unionBounds(strokes: Stroke[]): [number, number, number, number] | null {
  if (!strokes.length) return null
  const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const st of strokes) {
    const [x0, y0, x1, y1] = strokeBounds(st)
    b[0] = Math.min(b[0], x0)
    b[1] = Math.min(b[1], y0)
    b[2] = Math.max(b[2], x1)
    b[3] = Math.max(b[3], y1)
  }
  return b
}

/**
 * Low-latency ink surface.
 *  - One opaque, `desynchronized` canvas (front-buffer rendering in Chromium/Edge) that we present to.
 *  - An offscreen canvas holding the committed strokes; each present = blit + live stroke.
 *  - Input via `pointerrawupdate` (raw digitizer rate) + coalesced events (no dropped samples)
 *    + predicted events (draws slightly ahead of the pen to hide display latency).
 */
export default function InkCanvas(props: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const propsRef = useRef(props)
  propsRef.current = props
  const rerender = useRef<() => void>(() => {})

  const s = useRef({
    ctx: null as CanvasRenderingContext2D | null,
    committed: document.createElement('canvas'),
    dpr: 1,
    bg: '#ececec',
    w: 0,
    h: 0,
    zoom: 1,
    offX: 0,
    scrollY: 0,
    rect: null as DOMRect | null,
    mode: 'none' as Mode,
    pointerId: -1,
    live: null as Stroke | null,
    predicted: [] as Point[],
    erasing: new Set<string>(),
    lastErase: null as [number, number] | null,
    keep: null as string | null, // stroke committed by a mid-stroke button press; never erased by that same gesture
    holdAnchor: [0, 0] as [number, number],
    holdTimer: 0,
    lasso: [] as [number, number][],
    moveFrom: [0, 0] as [number, number],
    moveDelta: [0, 0] as [number, number], // kept after release until the moved strokes arrive via props
    lastMenu: -1e9,
    panLastY: 0,
    contentBottom: 0,
  }).current

  useEffect(() => {
    const canvas = canvasRef.current!
    const wrap = wrapRef.current!
    s.ctx = canvas.getContext('2d', { desynchronized: true, alpha: false })!

    const pages = () => Math.max(1, Math.floor(s.contentBottom / PAGE_H) + 2)
    const maxScroll = () => Math.max(0, TOP * 2 + pages() * PAGE_H * s.zoom - s.h)
    const clampScroll = () => (s.scrollY = Math.max(0, Math.min(maxScroll(), s.scrollY)))

    const pageTransform = (ctx: CanvasRenderingContext2D) =>
      ctx.setTransform(s.dpr * s.zoom, 0, 0, s.dpr * s.zoom, s.dpr * s.offX, s.dpr * (TOP - s.scrollY))

    const selected = () => {
      const ids = new Set(propsRef.current.selection)
      return propsRef.current.strokes.filter((st) => ids.has(st.id))
    }
    const moving = () => s.moveDelta[0] !== 0 || s.moveDelta[1] !== 0

    const renderCommitted = () => {
      const ctx = s.committed.getContext('2d', { alpha: false })!
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.fillStyle = s.bg
      ctx.fillRect(0, 0, s.committed.width, s.committed.height)
      pageTransform(ctx)
      const n = pages()
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, PAGE_W, n * PAGE_H)
      const top = s.scrollY / s.zoom - TOP
      const bottom = top + s.h / s.zoom + TOP
      drawPaper(ctx, propsRef.current.paper, top, Math.min(bottom, n * PAGE_H), s.zoom)
      ctx.strokeStyle = '#d6d6d6'
      ctx.lineWidth = 1 / s.zoom
      for (let i = 1; i < n; i++) {
        ctx.beginPath()
        ctx.moveTo(0, i * PAGE_H)
        ctx.lineTo(PAGE_W, i * PAGE_H)
        ctx.stroke()
      }
      // Strokes being dragged are drawn by present() at their offset instead.
      const skip = moving() ? new Set(propsRef.current.selection) : null
      for (const st of propsRef.current.strokes) {
        if (s.erasing.has(st.id) || skip?.has(st.id)) continue
        const b = strokeBounds(st)
        if (b[3] < top || b[1] > bottom) continue
        paintPath(ctx, st, strokePath(st))
      }
    }

    const present = () => {
      const ctx = s.ctx!
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.drawImage(s.committed, 0, 0)
      pageTransform(ctx)
      if (s.live) {
        const pts = s.predicted.length ? s.live.points.concat(s.predicted) : s.live.points
        paintPath(ctx, s.live, new Path2D(outlineD(pts, s.live, false)))
      }
      const sel = selected()
      if (sel.length) {
        const [dx, dy] = s.moveDelta
        if (moving()) {
          ctx.translate(dx, dy)
          for (const st of sel) paintPath(ctx, st, strokePath(st))
          ctx.translate(-dx, -dy)
        }
        const b = unionBounds(sel)!
        const pad = 8
        ctx.strokeStyle = '#3d7cf2'
        ctx.lineWidth = 1.5 / s.zoom
        ctx.setLineDash([6 / s.zoom, 4 / s.zoom])
        ctx.strokeRect(b[0] - pad + dx, b[1] - pad + dy, b[2] - b[0] + pad * 2, b[3] - b[1] + pad * 2)
        ctx.setLineDash([])
      }
      if (s.mode === 'lasso' && s.lasso.length > 1) {
        ctx.strokeStyle = '#3d7cf2'
        ctx.lineWidth = 1.5 / s.zoom
        ctx.setLineDash([6 / s.zoom, 4 / s.zoom])
        ctx.beginPath()
        s.lasso.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
        ctx.stroke()
        ctx.setLineDash([])
      }
    }

    const computeContent = () => {
      let m = 0
      for (const st of propsRef.current.strokes) m = Math.max(m, strokeBounds(st)[3])
      s.contentBottom = m
    }

    const layout = () => {
      const r = wrap.getBoundingClientRect()
      s.dpr = window.devicePixelRatio || 1
      s.bg = getComputedStyle(wrap).getPropertyValue('--canvas-bg').trim() || s.bg
      s.w = r.width
      s.h = r.height
      s.zoom = Math.min(1.6, Math.max(0.3, (r.width - 48) / PAGE_W))
      s.offX = (r.width - PAGE_W * s.zoom) / 2
      for (const c of [canvas, s.committed]) {
        c.width = Math.round(r.width * s.dpr)
        c.height = Math.round(r.height * s.dpr)
      }
      canvas.style.width = r.width + 'px'
      canvas.style.height = r.height + 'px'
      clampScroll()
      renderCommitted()
      present()
    }

    const toPage = (e: PointerEvent): Point => {
      const r = s.rect!
      const x = (e.clientX - r.left - s.offX) / s.zoom
      const y = (e.clientY - r.top - TOP + s.scrollY) / s.zoom
      return [Math.round(x * 100) / 100, Math.round(y * 100) / 100, Math.max(0.05, e.pressure || 0.5)]
    }

    const scrollBy = (dy: number) => {
      const before = s.scrollY
      s.scrollY += dy
      clampScroll()
      if (s.scrollY !== before) {
        renderCommitted()
        present()
      }
    }

    const eraseAt = (x: number, y: number) => {
      const p = propsRef.current
      const r = p.eraserSize / 2
      const from = s.lastErase ?? [x, y]
      // Sample along the eraser's path so fast swipes don't skip strokes.
      const steps = Math.max(1, Math.ceil(Math.hypot(x - from[0], y - from[1]) / Math.max(2, r / 2)))
      let changed = false
      for (let i = 1; i <= steps; i++) {
        const ex = from[0] + ((x - from[0]) * i) / steps
        const ey = from[1] + ((y - from[1]) * i) / steps
        for (const st of p.strokes) {
          if (st.id !== s.keep && !s.erasing.has(st.id) && hitStroke(st, ex, ey, r)) {
            s.erasing.add(st.id)
            changed = true
          }
        }
      }
      s.lastErase = [x, y]
      if (changed) {
        renderCommitted()
        present()
      }
    }

    const endStroke = (cancel: boolean) => {
      clearTimeout(s.holdTimer)
      let done = s.live!
      s.live = null
      s.predicted = []
      if (!cancel) {
        if (propsRef.current.straighten && !done.shape) {
          const line = straightLine(done.points)
          if (line) done = { ...done, points: line, shape: true }
        }
        // Bake into the committed layer right away so there is no flicker before React re-renders.
        pageTransform(s.committed.getContext('2d')!)
        paintPath(s.committed.getContext('2d')!, done, strokePath(done))
        propsRef.current.onAdd(done)
      }
      present()
    }

    // Holding the pen still at the end of a stroke snaps it to a line / circle / rectangle / triangle.
    const armHold = () => {
      clearTimeout(s.holdTimer)
      s.holdTimer = window.setTimeout(() => {
        if (s.mode !== 'draw' || !s.live || s.live.shape) return
        const shape = recognizeShape(s.live.points)
        if (!shape) return
        s.live = { ...s.live, points: shape, shape: true }
        s.predicted = []
        present()
      }, HOLD_MS)
    }

    // Windows reports the S Pen side button (barrel = 2) or eraser end (32) in `buttons`.
    const penEraser = (e: PointerEvent) => e.pointerType === 'pen' && (e.buttons & 34) !== 0

    // Erase only while the nib touches the screen; a barrel press while hovering also starts a pointer session.
    const eraseSample = (ev: PointerEvent) => {
      if (ev.pointerType === 'pen' && ev.pressure === 0) {
        s.lastErase = null
        return
      }
      const [x, y] = toPage(ev)
      eraseAt(x, y)
    }

    const switchToEraser = () => {
      s.keep = s.live!.id
      endStroke(false)
      s.mode = 'erase'
      s.lastErase = null
    }

    const finish = (cancel: boolean) => {
      const p = propsRef.current
      const was = s.mode
      if (s.mode === 'draw' && s.live) {
        endStroke(cancel)
      } else if (s.mode === 'erase') {
        const ids = [...s.erasing]
        s.lastErase = null
        if (cancel || !ids.length) {
          s.erasing.clear()
          renderCommitted()
          present()
        } else p.onErase(ids)
      } else if (s.mode === 'lasso') {
        const poly = s.lasso
        s.lasso = []
        const ids =
          cancel || poly.length < 3
            ? []
            : p.strokes
                .filter((st) => st.points.filter(([x, y]) => inPolygon(x, y, poly)).length >= st.points.length * 0.6)
                .map((st) => st.id)
        p.onSelect(ids)
        present()
      } else if (s.mode === 'move') {
        if (cancel || !moving()) {
          s.moveDelta = [0, 0]
          renderCommitted()
          present()
        } else p.onMoveSelection(s.moveDelta[0], s.moveDelta[1])
      }
      s.mode = 'none'
      s.pointerId = -1
      s.keep = null
      if (was === 'draw' || was === 'erase') p.onGestureEnd()
    }

    const onDown = (e: PointerEvent) => {
      const p = propsRef.current
      if (s.mode === 'pan' && e.pointerType === 'pen') finish(true) // pen wins over palm/finger
      if (s.mode !== 'none') return
      e.preventDefault()
      ;(document.activeElement as HTMLElement | null)?.blur?.()
      s.rect = canvas.getBoundingClientRect()
      s.pointerId = e.pointerId
      canvas.setPointerCapture(e.pointerId)

      if (e.pointerType === 'touch' && p.penOnly) {
        s.mode = 'pan'
        s.panLastY = e.clientY
        return
      }
      if (p.tool === 'eraser' || penEraser(e) || (e.pointerType === 'mouse' && e.button === 2)) {
        s.mode = 'erase'
        eraseSample(e)
        return
      }
      if (e.pointerType === 'mouse' && e.button !== 0) return finish(true)
      const pt = toPage(e)
      if (p.tool === 'lasso') {
        const b = unionBounds(selected())
        if (b && pt[0] > b[0] - 12 && pt[0] < b[2] + 12 && pt[1] > b[1] - 12 && pt[1] < b[3] + 12) {
          s.mode = 'move'
          s.moveFrom = [pt[0], pt[1]]
          s.moveDelta = [0, 0]
          return
        }
        if (p.selection.length) p.onSelect([])
        s.mode = 'lasso'
        s.lasso = [[pt[0], pt[1]]]
        return
      }
      s.mode = 'draw'
      s.live = {
        id: uid(),
        tool: p.tool === 'highlighter' ? 'highlighter' : 'pen',
        pen: p.tool === 'pen' ? p.pen : undefined,
        color: p.color,
        size: p.size,
        pressure: e.pointerType === 'pen',
        points: [pt],
      }
      s.holdAnchor = [pt[0], pt[1]]
      armHold()
      present()
    }

    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== s.pointerId || s.mode === 'none') return
      const evs = e.getCoalescedEvents?.() ?? []
      const samples = evs.length ? evs : [e]
      if (s.mode === 'pan') {
        const y = samples[samples.length - 1].clientY
        scrollBy(s.panLastY - y)
        s.panLastY = y
        return
      }
      if (s.mode === 'erase') {
        for (const ev of samples) eraseSample(ev)
        return
      }
      if (s.mode === 'lasso') {
        for (const ev of samples) {
          const [x, y] = toPage(ev)
          s.lasso.push([x, y])
        }
        present()
        return
      }
      if (s.mode === 'move') {
        const [x, y] = toPage(samples[samples.length - 1])
        const first = !moving()
        s.moveDelta = [x - s.moveFrom[0], y - s.moveFrom[1]]
        if (first) renderCommitted() // lift the selection off the committed layer
        present()
        return
      }
      if (s.live!.shape) return // snapped: ignore the rest of the gesture
      const pts = s.live!.points
      const moveTol = 5 / s.zoom
      for (const ev of samples) {
        if (penEraser(ev)) {
          // Side button pressed mid-stroke: keep what was drawn so far and continue as eraser.
          switchToEraser()
          for (const rest of samples.slice(samples.indexOf(ev))) eraseSample(rest)
          return
        }
        const pt = toPage(ev)
        if (Math.hypot(pt[0] - s.holdAnchor[0], pt[1] - s.holdAnchor[1]) > moveTol) {
          s.holdAnchor = [pt[0], pt[1]]
          armHold()
        }
        const last = pts[pts.length - 1]
        if (last[0] === pt[0] && last[1] === pt[1]) {
          last[2] = pt[2]
          continue
        }
        pts.push(pt)
      }
      s.predicted = (e.getPredictedEvents?.() ?? []).slice(0, 2).map(toPage)
      present()
    }

    const onUp = (e: PointerEvent) => {
      if (e.pointerId === s.pointerId) finish(false)
    }
    const onCancel = (e: PointerEvent) => {
      if (e.pointerId === s.pointerId) finish(true)
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      scrollBy(e.deltaY)
    }
    const noMenu = (e: Event) => e.preventDefault()

    // Android Chrome doesn't report the S Pen side button in pointer events; pressing it fires a
    // `contextmenu` (button -1). Mid-stroke it switches this gesture to erasing, otherwise the editor
    // arms the eraser for the next stroke. Mouse right-click (button 2) is ignored.
    const onPenMenu = (e: MouseEvent) => {
      const pen = (e as PointerEvent).pointerType === 'pen' || e.button === -1
      if (!pen || e.button === 2) return
      e.preventDefault()
      if (e.timeStamp - s.lastMenu < 300) return
      s.lastMenu = e.timeStamp
      if (s.mode === 'draw' && s.live) switchToEraser()
      else if (s.mode === 'none') propsRef.current.onPenButton()
    }

    // pointerrawupdate fires at the digitizer's native rate, ahead of the frame-aligned pointermove.
    const moveEvent = 'onpointerrawupdate' in window ? 'pointerrawupdate' : 'pointermove'
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener(moveEvent as 'pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onCancel)
    canvas.addEventListener('lostpointercapture', onCancel)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('contextmenu', noMenu)
    window.addEventListener('contextmenu', onPenMenu)

    const ro = new ResizeObserver(layout)
    ro.observe(wrap)
    const dark = matchMedia('(prefers-color-scheme: dark)')
    dark.addEventListener('change', layout)

    // Exposed so the props effect below can re-render.
    rerender.current = () => {
      computeContent()
      if (s.mode !== 'erase') s.erasing.clear()
      if (s.mode !== 'move') s.moveDelta = [0, 0]
      clampScroll()
      renderCommitted()
      present()
    }
    computeContent()
    layout()

    return () => {
      clearTimeout(s.holdTimer)
      ro.disconnect()
      dark.removeEventListener('change', layout)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener(moveEvent as 'pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onCancel)
      canvas.removeEventListener('lostpointercapture', onCancel)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('contextmenu', noMenu)
      window.removeEventListener('contextmenu', onPenMenu)
    }
  }, [s])

  useEffect(() => rerender.current(), [props.strokes, props.paper, props.selection])

  return (
    <div ref={wrapRef} className="ink-wrap">
      <canvas ref={canvasRef} className={`ink-canvas tool-${props.tool}`} />
    </div>
  )
}
