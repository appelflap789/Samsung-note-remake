import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Eraser, ExternalLink, Hand, Highlighter, ImagePlus, PenLine, Redo2, SquareDashed, Star, Trash2, Type, Undo2, X } from 'lucide-react'
import InkCanvas, { type CanvasApi } from './InkCanvas'
import ToolMenu from './ToolMenu'
import { HL_PALETTE } from '../palettes'
import { uid } from '../ink'
import { saveMedia } from '../items'
import { folderTree } from '../folders'
import type { Content, Folder, Item, Note, Paper, PenType, Stroke, TextItem, Tool } from '../types'

/** `boxes` = the item list before and after, for steps that change images or text. */
type Op = (
  | { t: 'add'; stroke: Stroke }
  | { t: 'erase'; items: { stroke: Stroke; index: number }[] }
  | { t: 'replace'; before: Stroke[]; after: Stroke[] }
) & { boxes?: [Item[], Item[]] }

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
  initial: Content
  folders: Folder[]
  onBack: () => void
  onUpdate: (patch: Partial<Note>, touch?: boolean) => void
  onContent: (content: Content) => void
}

export default function Editor({ note, initial, folders, onBack, onUpdate, onContent }: Props) {
  const [strokes, setStrokes] = useState(initial.strokes)
  const [items, setItems] = useState(initial.items)
  const [editing, setEditing] = useState<string | null>(null)
  const editStart = useRef<Item[] | null>(null) // items before typing started, for a single undo step
  const canvasApi = useRef<CanvasApi | null>(null)
  const imageInput = useRef<HTMLInputElement>(null)
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
  const itemsRef = useRef(items)
  itemsRef.current = items
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
    (next: Stroke[], nextItems = itemsRef.current) => {
      strokesRef.current = next
      itemsRef.current = nextItems
      setStrokes(next)
      setItems(nextItems)
      onContent({ strokes: next, items: nextItems })
      force((n) => n + 1)
    },
    [onContent],
  )

  /** Change only images/text boxes, as one undo step. */
  const commitItems = useCallback(
    (next: Item[], before = itemsRef.current) => {
      undo.current.push({ t: 'replace', before: [], after: [], boxes: [before, next] })
      redo.current = []
      commit(strokesRef.current, next)
    },
    [commit],
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
      const boxes = itemsRef.current.filter((it) => !set.has(it.id))
      const boxesChanged = boxes.length !== itemsRef.current.length
      if (!items.length && !boxesChanged) return
      push({ t: 'erase', items, ...(boxesChanged ? { boxes: [itemsRef.current, boxes] } : {}) })
      commit(
        strokesRef.current.filter((s) => !set.has(s.id)),
        boxes,
      )
    },
    [commit],
  )

  const replaceStrokes = useCallback(
    (ids: string[], fn: (s: Stroke) => Stroke, fnItem?: (it: Item) => Item) => {
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
      const boxes = fnItem && itemsRef.current.some((it) => set.has(it.id)) ? itemsRef.current.map((it) => (set.has(it.id) ? fnItem(it) : it)) : null
      if (!after.length && !boxes) return
      push({ t: 'replace', before, after, ...(boxes ? { boxes: [itemsRef.current, boxes] } : {}) })
      commit(next, boxes ?? itemsRef.current)
    },
    [commit],
  )

  const onMoveSelection = useCallback(
    (dx: number, dy: number) =>
      replaceStrokes(
        selection,
        (s) => ({ ...s, points: s.points.map(([x, y, p]) => [x + dx, y + dy, p]) }),
        (it) => ({ ...it, x: it.x + dx, y: it.y + dy }),
      ),
    [replaceStrokes, selection],
  )

  const onResizeItem = useCallback(
    (id: string, w: number, h: number) => commitItems(itemsRef.current.map((it) => (it.id === id ? { ...it, w, h } : it))),
    [commitItems],
  )

  const startEditing = useCallback((id: string) => {
    editStart.current = itemsRef.current
    setSelection([])
    setEditing(id)
  }, [])

  // Typing updates the item live; the whole edit becomes one undo step when it ends.
  const onTextChange = useCallback(
    (id: string, text: string) => commit(strokesRef.current, itemsRef.current.map((it) => (it.id === id ? { ...it, text } : it))),
    [commit],
  )

  const endEditing = useCallback(() => {
    const id = editing
    setEditing(null)
    const before = editStart.current
    editStart.current = null
    if (!id || !before) return
    const it = itemsRef.current.find((x) => x.id === id) as TextItem | undefined
    const next = it && !it.text.trim() ? itemsRef.current.filter((x) => x.id !== id) : itemsRef.current
    const old = before.find((x) => x.id === id) as TextItem | undefined
    if (next === itemsRef.current && old?.text === it?.text) return
    commitItems(next, before)
  }, [editing, commitItems])

  const addText = () => {
    const [cx, cy] = canvasApi.current?.center() ?? [500, 200]
    const it: TextItem = { kind: 'text', id: uid(), x: cx - 300, y: cy, w: 600, h: 0, text: '', size: 32, color: cfg.pen.color }
    editStart.current = itemsRef.current
    commit(strokesRef.current, [...itemsRef.current, it])
    setTool('lasso')
    setEditing(it.id)
  }

  const addImage = async (file: File) => {
    const ext = (file.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg').replace('svg+xml', 'png')
    if (!/^(jpg|png|webp|gif)$/.test(ext)) return alert('Please pick a JPG, PNG, WebP or GIF image.')
    const bm = await createImageBitmap(file).catch(() => null)
    if (!bm) return alert("This image couldn't be opened.")
    const name = `${uid()}.${ext}`
    await saveMedia(name, file)
    const w = Math.min(600, bm.width)
    const h = (bm.height * w) / bm.width
    bm.close()
    const [cx, cy] = canvasApi.current?.center() ?? [500, 200]
    const it: Item = { kind: 'image', id: uid(), x: cx - w / 2, y: cy, w, h, media: name }
    commitItems([...itemsRef.current, it])
    setTool('lasso')
    setSelection([it.id])
  }

  const apply = useCallback(
    (op: Op, reverse: boolean) => {
      setEditing(null)
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
      commit(next, op.boxes ? op.boxes[reverse ? 0 : 1] : itemsRef.current)
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
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return
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
    if (tool === 'lasso' && selection.length)
      return replaceStrokes(selection, (s) => ({ ...s, color: c }), (it) => (it.kind === 'text' ? { ...it, color: c } : it))
    setColor(drawTool, c)
    if (tool !== drawTool) setTool(drawTool)
  }

  const sizeOf = tool === 'eraser' ? cfg.eraserSize : cur.size
  const selectedText =
    selection.length === 1 ? (items.find((it) => it.id === selection[0] && it.kind === 'text') as TextItem | undefined) : undefined
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
          {folderTree(folders).map(({ folder: f, depth }) => (
            <option key={f.id} value={f.id}>
              {'\u2003'.repeat(depth) + f.name}
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
          items={items}
          editing={editing}
          api={canvasApi}
          onResizeItem={onResizeItem}
          onEditItem={startEditing}
          onTextChange={onTextChange}
          onEditEnd={endEditing}
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
            {selectedText && !selectedText.url && (
              <button className="icon-btn small" title="Edit text" onClick={() => startEditing(selectedText.id)}>
                <Type size={16} />
              </button>
            )}
            {selectedText?.url && (
              <button className="icon-btn small" title={selectedText.url} onClick={() => window.open(selectedText.url, '_blank', 'noopener')}>
                <ExternalLink size={16} />
              </button>
            )}
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
        {toolBtn('lasso', <SquareDashed size={20} />, 'Lasso select (tap an image or text box to select it)')}
        <button className="tool" onClick={addText} title="Add text box">
          <Type size={20} />
        </button>
        <button className="tool" onClick={() => imageInput.current?.click()} title="Add image">
          <ImagePlus size={20} />
        </button>
        <input
          ref={imageInput}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) addImage(f)
          }}
        />
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
