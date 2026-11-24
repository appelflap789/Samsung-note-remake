import { useEffect, useRef } from 'react'
import type { Paper, Point, Stroke, Tool } from '../types'
import { PAGE_H, PAGE_W, drawPaper, hitStroke, outlineD, paintPath, strokeBounds, strokePath, uid } from '../ink'

interface Props {
  strokes: Stroke[]
  paper: Paper
  tool: Tool
  color: string
  size: number
  eraserSize: number
  penOnly: boolean
  onAdd: (s: Stroke) => void
  onErase: (ids: string[]) => void
}

const TOP = 24 // screen px gap above the first page

type Mode = 'none' | 'draw' | 'erase' | 'pan'

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
      for (const st of propsRef.current.strokes) {
        if (s.erasing.has(st.id)) continue
        const b = strokeBounds(st)
        if (b[3] < top || b[1] > bottom) continue
        paintPath(ctx, st, strokePath(st))
      }
    }

    const present = () => {
      const ctx = s.ctx!
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.drawImage(s.committed, 0, 0)
      if (s.live) {
        pageTransform(ctx)
        const pts = s.predicted.length ? s.live.points.concat(s.predicted) : s.live.points
        paintPath(ctx, s.live, new Path2D(outlineD(pts, s.live, false)))
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
          if (!s.erasing.has(st.id) && hitStroke(st, ex, ey, r)) {
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

    const finish = (cancel: boolean) => {
      const p = propsRef.current
      if (s.mode === 'draw' && s.live) {
        const done = s.live
        s.live = null
        s.predicted = []
        if (!cancel) {
          // Bake into the committed layer right away so there is no flicker before React re-renders.
          pageTransform(s.committed.getContext('2d')!)
          paintPath(s.committed.getContext('2d')!, done, strokePath(done))
          p.onAdd(done)
        }
        present()
      } else if (s.mode === 'erase') {
        const ids = [...s.erasing]
        s.lastErase = null
        if (cancel || !ids.length) {
          s.erasing.clear()
          renderCommitted()
          present()
        } else p.onErase(ids)
      }
      s.mode = 'none'
      s.pointerId = -1
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
      // S Pen side button (barrel = 2) or eraser end (32) temporarily switches to eraser, like on Galaxy devices.
      const penEraser = e.pointerType === 'pen' && (e.buttons & 2 || e.buttons & 32)
      if (p.tool === 'eraser' || penEraser || (e.pointerType === 'mouse' && e.button === 2)) {
        s.mode = 'erase'
        const [x, y] = toPage(e)
        eraseAt(x, y)
        return
      }
      if (e.pointerType === 'mouse' && e.button !== 0) return finish(true)
      s.mode = 'draw'
      s.live = {
        id: uid(),
        tool: p.tool === 'highlighter' ? 'highlighter' : 'pen',
        color: p.color,
        size: p.size,
        pressure: e.pointerType === 'pen',
        points: [toPage(e)],
      }
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
        for (const ev of samples) {
          const [x, y] = toPage(ev)
          eraseAt(x, y)
        }
        return
      }
      const pts = s.live!.points
      for (const ev of samples) {
        const pt = toPage(ev)
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

    // pointerrawupdate fires at the digitizer's native rate, ahead of the frame-aligned pointermove.
    const moveEvent = 'onpointerrawupdate' in window ? 'pointerrawupdate' : 'pointermove'
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener(moveEvent as 'pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onCancel)
    canvas.addEventListener('lostpointercapture', onCancel)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('contextmenu', noMenu)

    const ro = new ResizeObserver(layout)
    ro.observe(wrap)
    const dark = matchMedia('(prefers-color-scheme: dark)')
    dark.addEventListener('change', layout)

    // Exposed so the strokes effect below can re-render.
    rerender.current = () => {
      computeContent()
      s.erasing.clear()
      clampScroll()
      renderCommitted()
      present()
    }
    computeContent()
    layout()

    return () => {
      ro.disconnect()
      dark.removeEventListener('change', layout)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener(moveEvent as 'pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onCancel)
      canvas.removeEventListener('lostpointercapture', onCancel)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('contextmenu', noMenu)
    }
  }, [s])

  useEffect(() => rerender.current(), [props.strokes, props.paper])

  return (
    <div ref={wrapRef} className="ink-wrap">
      <canvas ref={canvasRef} className={`ink-canvas tool-${props.tool}`} />
    </div>
  )
}
