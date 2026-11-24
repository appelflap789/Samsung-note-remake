import { useEffect, useRef } from 'react'
import type { Item, Paper, PenType, Point, Stroke, TextItem, Tool } from '../types'
import { PAGE_H, PAGE_W, drawPaper, hitStroke, outlineD, paintPath, strokeBounds, strokePath, uid } from '../ink'
import { TEXT_PAD, drawItem, itemBounds, lineHeight } from '../items'
import { recognizeShape, straightLine } from '../shapes'

export interface CanvasApi {
  /** Page point in the middle of what is on screen. */
  center: () => [number, number]
}

interface Props {
  strokes: Stroke[]
  items: Item[]
  /** Text item being typed in. */
  editing: string | null
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
  onResizeItem: (id: string, w: number, h: number) => void
  /** Tapped a selected text item. */
  onEditItem: (id: string) => void
  onTextChange: (id: string, text: string) => void
  onEditEnd: () => void
  api: React.MutableRefObject<CanvasApi | null>
  /** S Pen side button clicked while not writing (Android only reports it as a click). */
  onPenButton: () => void
  /** A draw/erase gesture finished (pen lifted). */
  onGestureEnd: () => void
}

const TOP = 24 // screen px gap above the first page
const HOLD_MS = 600 // keep the pen still this long to snap the stroke into a shape

type Mode = 'none' | 'draw' | 'erase' | 'pan' | 'lasso' | 'move' | 'resize'
type Box = [number, number, number, number]

function inPolygon(x: number, y: number, poly: number[][]) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function unionBounds(strokes: Stroke[], items: Item[]): Box | null {
  if (!strokes.length && !items.length) return null
  const b: Box = [Infinity, Infinity, -Infinity, -Infinity]
  for (const [x0, y0, x1, y1] of [...strokes.map(strokeBounds), ...items.map(itemBounds)]) {
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
  const editorRef = useRef<HTMLTextAreaElement>(null)

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
    selIds: new Set<string>(), // selection; set right away on tap-select, before the props catch up
    tapItem: null as string | null, // pressed an already selected text item: a tap (no drag) edits it
    resize: null as { id: string; w: number; h: number } | null,
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

    const selected = () => propsRef.current.strokes.filter((st) => s.selIds.has(st.id))
    const selectedItems = () => propsRef.current.items.filter((it) => s.selIds.has(it.id))
    const moving = () => s.moveDelta[0] !== 0 || s.moveDelta[1] !== 0
    const redraw = () => {
      renderCommitted()
      present()
    }
    const resized = (it: Item): Item => (s.resize?.id === it.id ? { ...it, w: s.resize.w, h: s.resize.h } : it)
    /** Resize handle: bottom-right corner when exactly one item (and nothing else) is selected. */
    const handleItem = () => {
      const its = selectedItems()
      return its.length === 1 && !selected().length ? its[0] : null
    }
    const HANDLE = 14
    const handleAt = (b: Box): [number, number] => [b[2] + 8, b[3] + 8]

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
      // Strokes and items being dragged are drawn by present() at their offset instead.
      const skip = moving() ? s.selIds : null
      for (const it of propsRef.current.items) {
        if (skip?.has(it.id) || it.id === s.resize?.id || it.id === propsRef.current.editing) continue
        const b = itemBounds(it)
        if (b[3] < top || b[1] > bottom) continue
        drawItem(ctx, it, redraw)
      }
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
      const selItems = selectedItems().map(resized)
      if (s.resize) for (const it of selItems) drawItem(ctx, it, redraw)
      if (sel.length || selItems.length) {
        const [dx, dy] = s.moveDelta
        if (moving()) {
          ctx.translate(dx, dy)
          for (const it of selItems) drawItem(ctx, it, redraw)
          for (const st of sel) paintPath(ctx, st, strokePath(st))
          ctx.translate(-dx, -dy)
        }
        const b = unionBounds(sel, selItems)!
        const pad = 8
        ctx.strokeStyle = '#3d7cf2'
        ctx.lineWidth = 1.5 / s.zoom
        ctx.setLineDash([6 / s.zoom, 4 / s.zoom])
        ctx.strokeRect(b[0] - pad + dx, b[1] - pad + dy, b[2] - b[0] + pad * 2, b[3] - b[1] + pad * 2)
        ctx.setLineDash([])
        if (handleItem()) {
          const [hx, hy] = handleAt(b)
          const r = HANDLE / 2 / s.zoom
          ctx.fillStyle = '#fff'
          ctx.beginPath()
          ctx.arc(hx + dx, hy + dy, r, 0, Math.PI * 2)
          ctx.fill()
          ctx.stroke()
        }
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
      for (const it of propsRef.current.items) m = Math.max(m, itemBounds(it)[3])
      s.contentBottom = m
    }

    // The text box being edited is a real <textarea> laid exactly over the item.
    const placeEditor = () => {
      const ta = editorRef.current
      const it = propsRef.current.items.find((x) => x.id === propsRef.current.editing) as TextItem | undefined
      if (!ta || !it) return
      const z = s.zoom
      Object.assign(ta.style, {
        left: `${s.offX + it.x * z}px`,
        top: `${TOP - s.scrollY + it.y * z}px`,
        width: `${it.w * z}px`,
        minHeight: `${it.h * z}px`,
        padding: `${TEXT_PAD * z}px`,
        font: `${it.size * z}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`,
        lineHeight: `${lineHeight(it) * z}px`,
        color: it.color,
      })
      ta.style.height = '0'
      ta.style.height = `${ta.scrollHeight}px`
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
      placeEditor()
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
        placeEditor()
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
            : [
                ...p.items
                  .filter((it) => {
                    const [x0, y0, x1, y1] = itemBounds(it)
                    return inPolygon((x0 + x1) / 2, (y0 + y1) / 2, poly)
                  })
                  .map((it) => it.id),
                ...p.strokes
                  .filter((st) => st.points.filter(([x, y]) => inPolygon(x, y, poly)).length >= st.points.length * 0.6)
                  .map((st) => st.id),
              ]
        s.selIds = new Set(ids)
        p.onSelect(ids)
        present()
      } else if (s.mode === 'move') {
        if (cancel || !moving()) {
          s.moveDelta = [0, 0]
          renderCommitted()
          present()
          if (!cancel && s.tapItem) p.onEditItem(s.tapItem)
        } else p.onMoveSelection(s.moveDelta[0], s.moveDelta[1])
      } else if (s.mode === 'resize') {
        const rz = s.resize
        if (!cancel && rz) p.onResizeItem(rz.id, rz.w, rz.h)
        else {
          s.resize = null
          redraw()
        }
      }
      s.tapItem = null
      s.mode = 'none'
      s.pointerId = -1
      s.keep = null
      if (was === 'draw' || was === 'erase') p.onGestureEnd()
    }

    const p0 = () => propsRef.current
    const onDown = (e: PointerEvent) => {
      const p = propsRef.current
      if (s.mode === 'pan' && e.pointerType === 'pen') finish(true) // pen wins over palm/finger
      if (s.mode !== 'none') return
      if (p.editing && e.pointerType !== 'touch') {
        // Tapping outside the text box being typed in just closes it.
        e.preventDefault()
        p.onEditEnd()
        return
      }
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
        const b = unionBounds(selected(), selectedItems())
        const one = handleItem()
        if (b && one) {
          const [hx, hy] = handleAt(b)
          if (Math.hypot(pt[0] - hx, pt[1] - hy) < 24 / s.zoom) {
            s.mode = 'resize'
            s.moveFrom = [pt[0], pt[1]]
            s.resize = { id: one.id, w: one.w, h: one.h }
            redraw()
            return
          }
        }
        const startMove = () => {
          s.mode = 'move'
          s.moveFrom = [pt[0], pt[1]]
          s.moveDelta = [0, 0]
        }
        if (b && pt[0] > b[0] - 12 && pt[0] < b[2] + 12 && pt[1] > b[1] - 12 && pt[1] < b[3] + 12) {
          if (one?.kind === 'text' && !one.url) s.tapItem = one.id
          return startMove()
        }
        // Press on an item: select it and allow dragging it straight away.
        const hit = [...p.items].reverse().find((it) => {
          const [x0, y0, x1, y1] = itemBounds(it)
          return pt[0] >= x0 && pt[0] <= x1 && pt[1] >= y0 && pt[1] <= y1
        })
        if (hit) {
          s.selIds = new Set([hit.id])
          p.onSelect([hit.id])
          redraw()
          return startMove()
        }
        s.selIds = new Set()
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
      if (s.mode === 'resize') {
        const [x] = toPage(samples[samples.length - 1])
        const it = p0().items.find((i) => i.id === s.resize!.id)!
        const w = Math.max(40, it.w + x - s.moveFrom[0])
        // Images keep their proportions; text boxes only get wider or narrower.
        s.resize = { id: it.id, w, h: it.kind === 'image' ? (it.h * w) / it.w : it.h }
        redraw()
        return
      }
      if (s.mode === 'move') {
        const [x, y] = toPage(samples[samples.length - 1])
        if (s.tapItem && Math.hypot(x - s.moveFrom[0], y - s.moveFrom[1]) < 6 / s.zoom) return // still a tap
        s.tapItem = null
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
      s.selIds = new Set(propsRef.current.selection)
      if (s.mode !== 'erase') s.erasing.clear()
      if (s.mode !== 'move') s.moveDelta = [0, 0]
      if (s.mode !== 'resize') s.resize = null
      clampScroll()
      renderCommitted()
      present()
      placeEditor()
    }
    propsRef.current.api.current = {
      center: () => [PAGE_W / 2, (s.scrollY + s.h / 3 - TOP) / s.zoom],
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

  useEffect(() => rerender.current(), [props.strokes, props.items, props.paper, props.selection, props.editing])

  const editingItem = props.items.find((it) => it.id === props.editing) as TextItem | undefined
  return (
    <div ref={wrapRef} className="ink-wrap">
      <canvas ref={canvasRef} className={`ink-canvas tool-${props.tool}`} />
      {editingItem && (
        <textarea
          key={editingItem.id}
          ref={editorRef}
          className="text-editor"
          autoFocus
          defaultValue={editingItem.text}
          onChange={(e) => {
            props.onTextChange(editingItem.id, e.target.value)
            e.target.style.height = '0'
            e.target.style.height = `${e.target.scrollHeight}px`
          }}
          onKeyDown={(e) => e.key === 'Escape' && props.onEditEnd()}
        />
      )}
    </div>
  )
}
