import { useEffect, useMemo, useState } from 'react'
import { ArrowDownUp, FileInput, RotateCcw, Search, SquarePen, Star, Trash2 } from 'lucide-react'
import Sidebar from './components/Sidebar'
import Thumbnail from './components/Thumbnail'
import Editor from './components/Editor'
import { useNotesDB } from './store'
import { uid } from './ink'
import { importSdocx } from './sdocx'
import type { Stroke, View } from './types'

type Sort = 'updated' | 'created' | 'title'

const narrow = matchMedia('(max-width: 900px)')

const fmt = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })

export default function App() {
  const { db, status, left, updateNote, createNote, addNote, loadStrokes, updateStrokes, deleteNoteForever, emptyTrash, createFolder, deleteFolder } = useNotesDB()
  const [view, setView] = useState<View>({ kind: 'all' })
  const [opened, setOpened] = useState<{ id: string; strokes: Stroke[] } | null>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>('updated')
  const [collapsed, setCollapsed] = useState(narrow.matches)
  const [importing, setImporting] = useState<string | null>(null)

  useEffect(() => {
    const onChange = () => setCollapsed(narrow.matches)
    narrow.addEventListener('change', onChange)
    return () => narrow.removeEventListener('change', onChange)
  }, [])

  const notes = useMemo(() => {
    if (!db) return []
    const q = query.trim().toLowerCase()
    const list = db.notes.filter((n) => {
      if (view.kind === 'trash' ? !n.trashed : n.trashed) return false
      if (view.kind === 'favorites' && !n.favorite) return false
      if (view.kind === 'folder' && n.folderId !== view.id) return false
      if (view.kind === 'folders' && n.folderId) return false
      return !q || (n.title || 'Untitled').toLowerCase().includes(q)
    })
    return list.sort((a, b) =>
      sort === 'title' ? (a.title || 'Untitled').localeCompare(b.title || 'Untitled') : b[`${sort}At`] - a[`${sort}At`],
    )
  }, [db, view, query, sort])

  if (!db) return null

  const openNote = async (id: string) => {
    try {
      setOpened({ id, strokes: await loadStrokes(id) })
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    }
  }

  // One file at a time, so even hundreds of big notes never sit in memory together.
  const importFiles = async (files: File[]) => {
    if (!files.length) return
    let done = 0
    const failed: string[] = []
    for (const file of files) {
      setImporting(`Importing ${++done}/${files.length}…`)
      await new Promise((r) => setTimeout(r)) // let the page repaint
      try {
        const r = await importSdocx(await file.arrayBuffer(), file.name)
        const now = Date.now()
        await addNote(
          {
            id: uid(),
            title: r.title,
            folderId: view.kind === 'folder' ? view.id : null,
            favorite: false,
            trashed: false,
            createdAt: file.lastModified || now,
            updatedAt: now,
            paper: 'plain',
          },
          r.strokes,
        )
      } catch (e) {
        failed.push(`${file.name}: ${e instanceof Error ? e.message : e}`)
      }
    }
    setImporting(null)
    if (failed.length) alert(`Imported ${files.length - failed.length} note(s). Could not import:\n${failed.join('\n')}`)
  }

  const open = opened && db.notes.find((n) => n.id === opened.id)
  if (open) {
    return (
      <Editor
        key={open.id}
        note={open}
        initialStrokes={opened.strokes}
        folders={db.folders}
        onBack={() => setOpened(null)}
        onUpdate={(patch, touch) => updateNote(open.id, patch, touch)}
        onStrokes={(strokes) => updateStrokes(open.id, strokes)}
      />
    )
  }

  const heading =
    view.kind === 'all'
      ? 'All notes'
      : view.kind === 'favorites'
        ? 'Favorites'
        : view.kind === 'trash'
          ? 'Trash'
          : view.kind === 'folders'
            ? 'Folders'
          : (db.folders.find((f) => f.id === view.id)?.name ?? 'Folder')

  const sortLabel = { updated: 'Date modified', created: 'Date created', title: 'Title' }[sort]
  const nextSort: Record<Sort, Sort> = { updated: 'created', created: 'title', title: 'updated' }

  return (
    <div className="app">
      <Sidebar
        db={db}
        view={view}
        sync={status}
        left={left}
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
        onView={setView}
        onCreateFolder={createFolder}
        onDeleteFolder={(id) => {
          deleteFolder(id)
          if (view.kind === 'folder' && view.id === id) setView({ kind: 'all' })
        }}
      />
      <main className="main">
        <div className="main-top">
          <h1>{heading}</h1>
          <label className="search">
            <input placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
            <Search size={16} />
          </label>
        </div>
        {view.kind === 'folders' && (
          <>
            <div className="folders-summary">
              {db.folders.length} folders, {notes.length} notes
            </div>
            <div className="folder-tiles">
              {db.folders.map((f) => (
                <button key={f.id} className="folder-tile" onClick={() => setView({ kind: 'folder', id: f.id })}>
                  <span className="folder-tile-count">{db.notes.filter((n) => !n.trashed && n.folderId === f.id).length}</span>
                  <span className="folder-tile-name">{f.name}</span>
                </button>
              ))}
            </div>
          </>
        )}
        <div className="main-sub">
          {view.kind === 'trash' && notes.length > 0 && (
            <button className="text-btn danger" onClick={() => confirm('Permanently delete all notes in Trash?') && emptyTrash()}>
              Empty trash
            </button>
          )}
          {view.kind !== 'trash' && (
            <label className="text-btn" title="Import handwriting from Samsung Notes (.sdocx)">
              <FileInput size={14} /> {importing ?? 'Import Samsung Notes'}
              <input
                type="file"
                multiple
                hidden
                disabled={!!importing}
                onChange={(e) => {
                  importFiles([...(e.target.files ?? [])])
                  e.target.value = ''
                }}
              />
            </label>
          )}
          <button className="text-btn" onClick={() => setSort(nextSort[sort])}>
            <ArrowDownUp size={14} /> Sort by: {sortLabel}
          </button>
        </div>

        {notes.length === 0 && view.kind === 'folders' ? null : notes.length === 0 ? (
          <div className="empty">{view.kind === 'trash' ? 'Trash is empty' : 'No notes yet. Tap the pen button to start writing.'}</div>
        ) : (
          <div className="grid">
            {notes.map((n) => (
              <div key={n.id} className="card">
                <button className="thumb" onClick={() => !n.trashed && openNote(n.id)}>
                  <Thumbnail note={n} />
                </button>
                <div className="card-actions">
                  {n.trashed ? (
                    <>
                      <button className="icon-btn small" title="Restore" onClick={() => updateNote(n.id, { trashed: false }, false)}>
                        <RotateCcw size={14} />
                      </button>
                      <button
                        className="icon-btn small"
                        title="Delete permanently"
                        onClick={() => confirm('Delete this note permanently?') && deleteNoteForever(n.id)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </>
                  ) : (
                    <button className="icon-btn small" title="Move to Trash" onClick={() => updateNote(n.id, { trashed: true }, false)}>
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
                <div className="card-title">{n.title || 'Untitled'}</div>
                <div className="card-date">
                  {fmt(n.updatedAt)}
                  {(n.pages ?? 1) > 1 && ` · ${n.pages} pages`}
                  {n.favorite && <Star size={12} className="star" fill="currentColor" />}
                </div>
              </div>
            ))}
          </div>
        )}

        {view.kind !== 'trash' && (
          <button
            className="fab"
            title="New note"
            onClick={() => openNote(createNote(view.kind === 'folder' ? view.id : null))}
          >
            <SquarePen size={22} />
          </button>
        )}
      </main>
    </div>
  )
}
