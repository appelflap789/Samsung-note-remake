import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Eraser, Hand, Highlighter, PenLine, Redo2, Star, Undo2 } from 'lucide-react'
import InkCanvas from './InkCanvas'
import type { Folder, Note, Paper, Stroke, Tool } from '../types'

const PEN_COLORS = ['#1f1f1f', '#2b5fd9', '#d93a3a', '#1f9d55', '#8a3ffc', '#f08c00']
const HL_COLORS = ['#ffe600', '#7dff6b', '#ff7ad9', '#6bd8ff', '#ffa94d']

type Op = { t: 'add'; stroke: Stroke } | { t: 'erase'; items: { stroke: Stroke; index: number }[] }

interface Props {
  note: Note
  folders: Folder[]
  onBack: () => void
  onUpdate: (patch: Partial<Note>, touch?: boolean) => void
}

export default function Editor({ note, folders, onBack, onUpdate }: Props) {
  const [strokes, setStrokes] = useState(note.strokes)
  const [tool, setTool] = useState<Tool>('pen')
  const [pen, setPen] = useState({ color: PEN_COLORS[0], size: 4 })
  const [hl, setHl] = useState({ color: HL_COLORS[0], size: 22 })
  const [eraserSize, setEraserSize] = useState(20)
  const [penOnly, setPenOnly] = useState(true)
  const undo = useRef<Op[]>([])
  const redo = useRef<Op[]>([])
  const [, force] = useState(0)

  const strokesRef = useRef(strokes)
  strokesRef.current = strokes

  const commit = useCallback(
    (next: Stroke[]) => {
      strokesRef.current = next
      setStrokes(next)
      onUpdate({ strokes: next })
      force((n) => n + 1)
    },
    [onUpdate],
  )

  const onAdd = useCallback(
    (s: Stroke) => {
      undo.current.push({ t: 'add', stroke: s })
      redo.current = []
      commit([...strokesRef.current, s])
    },
    [commit],
  )

  const onErase = useCallback(
    (ids: string[]) => {
      const set = new Set(ids)
      const items: { stroke: Stroke; index: number }[] = []
      strokesRef.current.forEach((stroke, index) => set.has(stroke.id) && items.push({ stroke, index }))
      undo.current.push({ t: 'erase', items })
      redo.current = []
      commit(strokesRef.current.filter((s) => !set.has(s.id)))
    },
    [commit],
  )

  const apply = useCallback(
    (op: Op, reverse: boolean) => {
      let next = strokesRef.current
      const removing = (op.t === 'add') === reverse
      if (op.t === 'add') {
        next = removing ? next.filter((s) => s.id !== op.stroke.id) : [...next, op.stroke]
      } else if (removing) {
        const ids = new Set(op.items.map((i) => i.stroke.id))
        next = next.filter((s) => !ids.has(s.id))
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
  }, [doUndo, doRedo])

  const cur = tool === 'highlighter' ? hl : pen
  const setCur = tool === 'highlighter' ? setHl : setPen
  const colors = tool === 'highlighter' ? HL_COLORS : PEN_COLORS

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

      <div className="toolbar">
        <div className="tool-group">
          <button className={`tool ${tool === 'pen' ? 'on' : ''}`} onClick={() => setTool('pen')} title="Pen">
            <PenLine size={20} />
          </button>
          <button
            className={`tool ${tool === 'highlighter' ? 'on' : ''}`}
            onClick={() => setTool('highlighter')}
            title="Highlighter"
          >
            <Highlighter size={20} />
          </button>
          <button
            className={`tool ${tool === 'eraser' ? 'on' : ''}`}
            onClick={() => setTool('eraser')}
            title="Eraser (or hold the S Pen side button)"
          >
            <Eraser size={20} />
          </button>
        </div>
        <span className="sep" />
        {tool !== 'eraser' ? (
          <div className="tool-group">
            {colors.map((c) => (
              <button
                key={c}
                className={`swatch ${cur.color === c ? 'on' : ''}`}
                style={{ background: c }}
                onClick={() => setCur((v) => ({ ...v, color: c }))}
                title={c}
              />
            ))}
            <input
              type="range"
              min={tool === 'highlighter' ? 8 : 1}
              max={tool === 'highlighter' ? 48 : 20}
              step={0.5}
              value={cur.size}
              onChange={(e) => setCur((v) => ({ ...v, size: +e.target.value }))}
              title="Size"
            />
          </div>
        ) : (
          <div className="tool-group">
            <span className="muted">Stroke eraser</span>
            <input
              type="range"
              min={6}
              max={80}
              value={eraserSize}
              onChange={(e) => setEraserSize(+e.target.value)}
              title="Eraser size"
            />
          </div>
        )}
        <span className="sep" />
        <div className="tool-group">
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
        </div>
      </div>

      <InkCanvas
        strokes={strokes}
        paper={note.paper ?? 'plain'}
        tool={tool}
        color={cur.color}
        size={cur.size}
        eraserSize={eraserSize}
        penOnly={penOnly}
        onAdd={onAdd}
        onErase={onErase}
      />
    </div>
  )
}
