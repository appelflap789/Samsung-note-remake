import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Eraser, Hand, Highlighter, PenLine, Redo2, SquareDashed, Star, Trash2, Undo2, X } from 'lucide-react'
import InkCanvas from './InkCanvas'
import ToolMenu from './ToolMenu'
import { HL_PALETTE } from '../palettes'
import type { Folder, Note, Paper, PenType, Stroke, Tool } from '../types'

type Op =
  | { t: 'add'; stroke: Stroke }
  | { t: 'erase'; items: { stroke: Stroke; index: number }[] }
  | { t: 'replace'; before: Stroke[]; after: Stroke[] }

interface Settings {
  penType: PenType
  pen: { color: string; size: number }
  hl: { color: string; size: number }
  eraserSize: number
  straighten: boolean
  recentPen: string[]
  recentHl: string[]
}

const SETTINGS_KEY = 'notes-tool-settings-v1'
const DEFAULTS: Settings = {
  penType: 'fountain',
  pen: { color: '#000000', size: 4 },
  hl: { color: HL_PALETTE[0], size: 22 },
  eraserSize: 20,
  straighten: false,
  recentPen: ['#000000', '#2b5fd9', '#e0453a', '#3d8c7f', '#a0612b'],
  recentHl: HL_PALETTE.slice(0, 5),
}

function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') }
  } catch {
    return DEFAULTS
  }
}

const pushRecent = (list: string[], c: string) => [c, ...list.filter((x) => x !== c)].slice(0, 5)

interface Props {
  note: Note
  folders: Folder[]
  onBack: () => void
  onUpdate: (patch: Partial<Note>, touch?: boolean) => void
}

export default function Editor({ note, folders, onBack, onUpdate }: Props) {
  const [strokes, setStrokes] = useState(note.strokes)
  const [tool, setToolState] = useState<Tool>('pen')
  const [cfg, setCfg] = useState(loadSettings)
  const [menu, setMenu] = useState(false)
  const [menuLeft, setMenuLeft] = useState(12) // menu sits above the tool button it belongs to
  const [selection, setSelection] = useState<string[]>([])
  const [penOnly, setPenOnly] = useState(true)
  const undo = useRef<Op[]>([])
  const redo = useRef<Op[]>([])
  const [, force] = useState(0)

  useEffect(() => localStorage.setItem(SETTINGS_KEY, JSON.stringify(cfg)), [cfg])

  const strokesRef = useRef(strokes)
  strokesRef.current = strokes
  const toolRef = useRef(tool)
  toolRef.current = tool
  const lastDrawTool = useRef<'pen' | 'highlighter'>('pen') // whose colours the toolbar shows
  const prevTool = useRef<Tool>('pen') // restored after a temporary (side-button) eraser
  const tempEraser = useRef(false)

  const setTool = useCallback((t: Tool) => {
    tempEraser.current = false
    if (t === 'pen' || t === 'highlighter') lastDrawTool.current = t
    setToolState(t)
    if (t !== 'lasso') setSelection([])
  }, [])

  const commit = useCallback(
    (next: Stroke[]) => {
      strokesRef.current = next
      setStrokes(next)
      onUpdate({ strokes: next })
      force((n) => n + 1)
    },
    [onUpdate],
  )

  const push = (op: Op) => {
    undo.current.push(op)
    redo.current = []
  }

  const onAdd = useCallback(
    (s: Stroke) => {
      push({ t: 'add', stroke: s })
      commit([...strokesRef.current, s])
    },
    [commit],
  )

  const onErase = useCallback(
    (ids: string[]) => {
      const set = new Set(ids)
      const items: { stroke: Stroke; index: number }[] = []
      strokesRef.current.forEach((stroke, index) => set.has(stroke.id) && items.push({ stroke, index }))
      if (!items.length) return
      push({ t: 'erase', items })
      commit(strokesRef.current.filter((s) => !set.has(s.id)))
    },
    [commit],
  )

  const replaceStrokes = useCallback(
    (ids: string[], fn: (s: Stroke) => Stroke) => {
      const set = new Set(ids)
      const before: Stroke[] = []
      const after: Stroke[] = []
      const next = strokesRef.current.map((s) => {
        if (!set.has(s.id)) return s
        const n = fn(s)
        before.push(s)
        after.push(n)
        return n
      })
      if (!after.length) return
      push({ t: 'replace', before, after })
      commit(next)
    },
    [commit],
  )

  const onMoveSelection = useCallback(
    (dx: number, dy: number) =>
      replaceStrokes(selection, (s) => ({ ...s, points: s.points.map(([x, y, p]) => [x + dx, y + dy, p]) })),
    [replaceStrokes, selection],
  )

  const apply = useCallback(
    (op: Op, reverse: boolean) => {
      let next = strokesRef.current
      if (op.t === 'replace') {
        const map = new Map((reverse ? op.before : op.after).map((s) => [s.id, s]))
        next = next.map((s) => map.get(s.id) ?? s)
      } else if ((op.t === 'add') === reverse) {
        const ids = new Set(op.t === 'add' ? [op.stroke.id] : op.items.map((i) => i.stroke.id))
        next = next.filter((s) => !ids.has(s.id))
      } else if (op.t === 'add') {
        next = [...next, op.stroke]
      } else {
        next = [...next]
        for (const { stroke, index } of op.items) next.splice(index, 0, stroke)
      }
      commit(next)
    },
    [commit],
  )

  const doUndo = useCallback(() => {
    const op = undo.current.pop()
    if (op) {
      redo.current.push(op)
      apply(op, true)
    }
  }, [apply])

  const doRedo = useCallback(() => {
    const op = redo.current.pop()
    if (op) {
      undo.current.push(op)
      apply(op, false)
    }
  }, [apply])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return
      if ((e.key === 'Delete' || e.key === 'Backspace') && selection.length) {
        onErase(selection)
        setSelection([])
        return
      }
      if (!(e.ctrlKey || e.metaKey)) return
      const k = e.key.toLowerCase()
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault()
        doUndo()
      } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
        e.preventDefault()
        doRedo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [doUndo, doRedo, onErase, selection])

  // S Pen side button: switch to the eraser for the next stroke, then back (a second click also switches back).
  const onPenButton = useCallback(() => {
    const t = toolRef.current
    if (t === 'eraser') {
      tempEraser.current = false
      setToolState(prevTool.current)
      return
    }
    prevTool.current = t
    setSelection([])
    setToolState('eraser')
    tempEraser.current = true
  }, [])

  const onGestureEnd = useCallback(() => {
    if (!tempEraser.current) return
    tempEraser.current = false
    setToolState(prevTool.current)
  }, [])

  // Tapping elsewhere closes the tool menu; a tap on the page only closes it (no stray dot).
  const toolbarRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    const close = (e: PointerEvent) => {
      if (toolbarRef.current?.contains(e.target as Node)) return
      setMenu(false)
      if (e.target instanceof HTMLCanvasElement) e.stopPropagation()
    }
    window.addEventListener('pointerdown', close, true)
    return () => window.removeEventListener('pointerdown', close, true)
  }, [menu])

  const anchor = (btn: HTMLElement) =>
    setMenuLeft(Math.max(12, Math.min(btn.offsetLeft + btn.offsetWidth / 2 - 60, btn.parentElement!.clientWidth - 352)))

  const pickTool = (t: Tool, btn: HTMLElement) => {
    anchor(btn)
    if (t === tool && t !== 'lasso') setMenu((m) => !m)
    else {
      setTool(t)
      setMenu(false)
    }
  }

  const drawTool = tool === 'pen' || tool === 'highlighter' ? tool : lastDrawTool.current
  const cur = drawTool === 'highlighter' ? cfg.hl : cfg.pen
  const recent = drawTool === 'highlighter' ? cfg.recentHl : cfg.recentPen

  const setColor = (kind: 'pen' | 'highlighter', c: string) =>
    setCfg((v) =>
      kind === 'highlighter'
        ? { ...v, hl: { ...v.hl, color: c }, recentHl: pushRecent(v.recentHl, c) }
        : { ...v, pen: { ...v.pen, color: c }, recentPen: pushRecent(v.recentPen, c) },
    )

  const quickColor = (c: string) => {
    if (tool === 'lasso' && selection.length) return replaceStrokes(selection, (s) => ({ ...s, color: c }))
    setColor(drawTool, c)
    if (tool !== drawTool) setTool(drawTool)
  }

  const sizeOf = tool === 'eraser' ? cfg.eraserSize : cur.size
  const toolBtn = (t: Tool, icon: React.ReactNode, title: string) => (
    <button className={`tool ${tool === t ? 'on' : ''}`} onClick={(e) => pickTool(t, e.currentTarget)} title={title}>
      {icon}
    </button>
  )

  return (
    <div className="editor">
      <header className="editor-bar">
        <button className="icon-btn" onClick={onBack} title="Back">
          <ArrowLeft size={20} />
        </button>
        <input
          className="title-input"
          placeholder="Title"
          value={note.title}
          onChange={(e) => onUpdate({ title: e.target.value })}
        />
        <select
          className="folder-select"
          value={note.paper ?? 'plain'}
          onChange={(e) => onUpdate({ paper: e.target.value as Paper })}
          title="Paper"
        >
          <option value="plain">Plain</option>
          <option value="lined">Lined</option>
          <option value="dotted">Dotted</option>
          <option value="grid">Grid</option>
        </select>
        <select
          className="folder-select"
          value={note.folderId ?? ''}
          onChange={(e) => onUpdate({ folderId: e.target.value || null })}
        >
          <option value="">No folder</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        <button
          className={`icon-btn ${note.favorite ? 'fav-on' : ''}`}
          onClick={() => onUpdate({ favorite: !note.favorite }, false)}
          title="Favorite"
        >
          <Star size={20} fill={note.favorite ? 'currentColor' : 'none'} />
        </button>
      </header>

      <div className="ink-area">
        <InkCanvas
          strokes={strokes}
          paper={note.paper ?? 'plain'}
          tool={tool}
          pen={cfg.penType}
          color={cur.color}
          size={cur.size}
          eraserSize={cfg.eraserSize}
          penOnly={penOnly}
          straighten={cfg.straighten}
          selection={selection}
          onAdd={onAdd}
          onErase={onErase}
          onSelect={setSelection}
          onMoveSelection={onMoveSelection}
          onPenButton={onPenButton}
          onGestureEnd={onGestureEnd}
        />
        {selection.length > 0 && (
          <div className="selection-bar">
            <span>{selection.length} selected</span>
            <button
              className="icon-btn small"
              title="Delete"
              onClick={() => {
                onErase(selection)
                setSelection([])
              }}
            >
              <Trash2 size={16} />
            </button>
            <button className="icon-btn small" title="Deselect" onClick={() => setSelection([])}>
              <X size={16} />
            </button>
          </div>
        )}
      </div>

      <div className="toolbar" ref={toolbarRef}>
        {toolBtn('pen', <PenLine size={20} />, 'Pen (tap again for options)')}
        {toolBtn('highlighter', <Highlighter size={20} />, 'Highlighter (tap again for options)')}
        {toolBtn('eraser', <Eraser size={20} />, 'Eraser (tap again for options; S Pen button switches too)')}
        {toolBtn('lasso', <SquareDashed size={20} />, 'Lasso select')}
        <span className="sep" />
        {recent.map((c) => (
          <button
            key={c}
            className={`swatch ${tool === drawTool && cur.color === c ? 'on' : ''}`}
            style={{ background: c }}
            onClick={() => quickColor(c)}
            title={tool === 'lasso' && selection.length ? 'Recolour selection' : c}
          />
        ))}
        <button
          className="tool thickness"
          title="Size"
          onClick={(e) => {
            anchor(e.currentTarget)
            if (tool === 'lasso') setTool(drawTool)
            setMenu((m) => !m || tool === 'lasso')
          }}
        >
          <span style={{ height: Math.max(2, Math.min(12, sizeOf / (tool === 'pen' ? 1.5 : 4))) }} />
        </button>
        <span className="sep" />
        <button className="tool" onClick={doUndo} disabled={!undo.current.length} title="Undo (Ctrl+Z)">
          <Undo2 size={20} />
        </button>
        <button className="tool" onClick={doRedo} disabled={!redo.current.length} title="Redo (Ctrl+Y)">
          <Redo2 size={20} />
        </button>
        <button
          className={`tool ${penOnly ? 'on' : ''}`}
          onClick={() => setPenOnly((v) => !v)}
          title={penOnly ? 'Pen only: fingers scroll (click to draw with fingers)' : 'Fingers draw'}
        >
          <Hand size={20} />
        </button>

        {menu && tool !== 'lasso' && (
          <ToolMenu
            left={menuLeft}
            kind={tool}
            penType={cfg.penType}
            color={cur.color}
            size={sizeOf}
            min={tool === 'highlighter' ? 8 : tool === 'eraser' ? 6 : 1}
            max={tool === 'highlighter' ? 48 : tool === 'eraser' ? 80 : 30}
            straighten={cfg.straighten}
            onPenType={(penType) => setCfg((v) => ({ ...v, penType }))}
            onColor={(c) => setColor(tool === 'highlighter' ? 'highlighter' : 'pen', c)}
            onSize={(n) =>
              setCfg((v) =>
                tool === 'eraser'
                  ? { ...v, eraserSize: n }
                  : tool === 'highlighter'
                    ? { ...v, hl: { ...v.hl, size: n } }
                    : { ...v, pen: { ...v.pen, size: n } },
              )
            }
            onStraighten={(straighten) => setCfg((v) => ({ ...v, straighten }))}
            onEraseAll={() => {
              if (strokesRef.current.length && confirm('Erase everything on this note?')) onErase(strokesRef.current.map((s) => s.id))
              setMenu(false)
            }}
            onClose={() => setMenu(false)}
          />
        )}
      </div>
    </div>
  )
}
