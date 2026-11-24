import { useCallback, useEffect, useRef, useState } from 'react'
import { del, get, set } from 'idb-keyval'
import type { DB, Folder, Note, Stroke, StrokesRecord } from './types'
import { pageCount, renderThumb, uid } from './ink'

const KEY = 'samsung-notes-db-v2'
const OLD_KEY = 'samsung-notes-db-v1' // notes with strokes inline
const PENDING_KEY = 'samsung-notes-pending-v1'
const API = `${import.meta.env.BASE_URL}api`
const PULL_EVERY = 60_000

/**
 * - local: no server (e.g. GitHub Pages); notes stay on this device
 * - synced / syncing: talking to the home server
 * - offline: server unreachable; changes are kept and uploaded later
 * - error: server rejected a change
 */
export type SyncStatus = 'local' | 'syncing' | 'synced' | 'offline' | 'error'

interface Pending {
  notes: string[]
  folders: boolean
}

const strokesKey = (id: string) => `samsung-notes-strokes:${id}`

// Strokes edited in the open note, not yet written to IndexedDB.
const live = new Map<string, StrokesRecord>()
const readStrokes = async (id: string) => live.get(id) ?? (await get<StrokesRecord>(strokesKey(id)))
const flushLive = () => Promise.all([...live].map(([id, rec]) => set(strokesKey(id), rec)))

export function useNotesDB() {
  const [db, setDb] = useState<DB | null>(null)
  const [status, setStatus] = useState<SyncStatus>('syncing')
  const latest = useRef<DB | null>(null)

  // The note/folder objects as last confirmed by the server. Immutable updates mean
  // "object differs from synced" == "changed locally since last sync".
  const synced = useRef(new Map<string, Note>())
  const syncedFolders = useRef<Folder[] | null>(null)
  const pending = useRef({ notes: new Set<string>(), folders: false })
  const serverless = useRef(false)
  const busy = useRef<Promise<void> | null>(null)
  const again = useRef<'push' | 'pull' | null>(null)
  const etag = useRef<string | null>(null)
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const savePending = () =>
    set(PENDING_KEY, { notes: [...pending.current.notes], folders: pending.current.folders } satisfies Pending)

  /** Mark every note/folder that differs from the last synced version as pending. */
  function collectChanges(d: DB) {
    const p = pending.current
    const ids = new Set(d.notes.map((n) => n.id))
    let changed = false
    for (const n of d.notes) {
      if (synced.current.get(n.id) !== n && !p.notes.has(n.id)) {
        p.notes.add(n.id)
        changed = true
      }
    }
    for (const id of synced.current.keys()) {
      if (!ids.has(id) && !p.notes.has(id)) {
        p.notes.add(id)
        changed = true
      }
    }
    if (d.folders !== syncedFolders.current && !p.folders) {
      p.folders = true
      changed = true
    }
    return changed
  }

  /** Upload pending changes, then optionally download the server state. */
  const sync = useCallback(async (pull: boolean) => {
    if (serverless.current) return
    if (busy.current) {
      // Run once more after the current round, so changes made meanwhile are included.
      again.current = again.current === 'pull' || pull ? 'pull' : 'push'
      return busy.current
    }
    const run = async () => {
      let doPull = pull
      do {
        again.current = null
        setStatus('syncing')
        try {
          if (doPull) await pullFromServer()
          await push()
          setStatus('synced')
        } catch (e) {
          if (serverless.current) setStatus('local')
          else if (e instanceof TypeError) setStatus('offline')
          else {
            setStatus('error')
            console.error('sync failed', e)
          }
          return
        }
        doPull = again.current === 'pull'
      } while (again.current)
    }
    busy.current = run()
    await busy.current
    busy.current = null
  }, [])

  async function push() {
    const p = pending.current
    for (const id of [...p.notes]) {
      if (timers.current.has(id)) continue // still being written in; uploaded once the pen rests
      const note = latest.current?.notes.find((n) => n.id === id)
      if (note && synced.current.get(id)?.sv !== note.sv) {
        // Strokes changed (or the server may not have them): upload them before the note that points at them.
        const rec = await readStrokes(id)
        if (rec && rec.sv === note.sv) {
          const res = await fetch(`${API}/notes/${id}/strokes`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rec.strokes) })
          if (!res.ok) throw new Error(`Saving strokes failed (${res.status})`)
        }
      }
      const res = note
        ? await fetch(`${API}/notes/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(note) })
        : await fetch(`${API}/notes/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`Saving note failed (${res.status})`)
      // Only clear when nothing changed while the request was in flight.
      const now = latest.current?.notes.find((n) => n.id === id)
      if (now === note) {
        p.notes.delete(id)
        if (note) synced.current.set(id, note)
        else synced.current.delete(id)
      }
    }
    if (p.folders) {
      const folders = latest.current?.folders ?? []
      const res = await fetch(`${API}/folders`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(folders) })
      if (!res.ok) throw new Error(`Saving folders failed (${res.status})`)
      if (latest.current?.folders === folders) {
        p.folders = false
        syncedFolders.current = folders
      }
    }
    await savePending()
  }

  async function pullFromServer() {
    const res = await fetch(`${API}/db`, { cache: 'no-store', headers: etag.current ? { 'if-none-match': etag.current } : {} })
    if (res.status === 304) return
    if (res.status === 404 || !res.headers.get('content-type')?.includes('json')) {
      serverless.current = true
      throw new Error('serverless')
    }
    if (!res.ok) throw new Error(`Loading notes failed (${res.status})`)
    const server: DB = await res.json()
    etag.current = res.headers.get('etag')
    const local = latest.current ?? { notes: [], folders: [] }
    // Capture edits made since the last debounce tick before the server copy replaces them.
    if (collectChanges(local)) await savePending()
    const p = pending.current
    synced.current = new Map(server.notes.map((n) => [n.id, n]))
    syncedFolders.current = server.folders
    // Server wins, except for things changed here that haven't been uploaded yet.
    const notes = server.notes.filter((n) => !p.notes.has(n.id))
    for (const n of local.notes) {
      if (p.notes.has(n.id)) notes.push(n)
      else if (!synced.current.has(n.id)) del(strokesKey(n.id)) // deleted elsewhere
    }
    notes.sort((a, b) => b.updatedAt - a.updatedAt)
    const next = { notes, folders: p.folders ? local.folders : server.folders }
    latest.current = next
    setDb(next)
  }

  useEffect(() => {
    const load = async () => {
      const [d, pend] = await Promise.all([get<DB>(KEY), get<Pending>(PENDING_KEY)])
      pending.current = { notes: new Set(pend?.notes ?? []), folders: pend?.folders ?? false }
      const local = d ?? (await migrate(pending.current))
      for (const n of local.notes) if (!pending.current.notes.has(n.id)) synced.current.set(n.id, n)
      syncedFolders.current = pending.current.folders ? null : local.folders
      latest.current = local
      setDb(local)
      sync(true).catch(() => {})
    }
    load()
  }, [sync])

  // Debounced: persist locally, record what changed, upload it.
  useEffect(() => {
    if (!db) return
    latest.current = db
    const t = setTimeout(() => {
      set(KEY, db)
      const changed = collectChanges(db)
      const p = pending.current
      if (changed || p.notes.size || p.folders) {
        savePending()
        sync(false)
      }
    }, 400)
    return () => clearTimeout(t)
  }, [db, sync])

  useEffect(() => {
    const flush = () => {
      flushLive()
      if (latest.current) set(KEY, latest.current)
    }
    const onVisible = () => {
      if (document.visibilityState === 'hidden') flush()
      else sync(true)
    }
    const onOnline = () => sync(true)
    const timer = setInterval(() => document.visibilityState === 'visible' && sync(true), PULL_EVERY)
    window.addEventListener('pagehide', flush)
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [sync])

  const updateNote = useCallback((id: string, patch: Partial<Note>, touch = true) => {
    setDb((d) =>
      d && {
        ...d,
        notes: d.notes.map((n) => (n.id === id ? { ...n, ...patch, ...(touch ? { updatedAt: Date.now() } : {}) } : n)),
      },
    )
  }, [])

  const createNote = useCallback((folderId: string | null): string => {
    const now = Date.now()
    const note: Note = { id: uid(), title: '', folderId, favorite: false, trashed: false, createdAt: now, updatedAt: now, paper: 'plain', sv: uid() }
    live.set(note.id, { sv: note.sv, strokes: [] })
    setDb((d) => d && { ...d, notes: [note, ...d.notes] })
    return note.id
  }, [])

  /** Add a finished note (e.g. imported); its strokes go straight to storage. */
  const addNote = useCallback(async (note: Omit<Note, 'sv' | 'thumb' | 'pages'>, strokes: Stroke[]) => {
    const full: Note = { ...note, sv: uid(), thumb: renderThumb(strokes), pages: pageCount(strokes) }
    await set(strokesKey(full.id), { sv: full.sv, strokes } satisfies StrokesRecord)
    setDb((d) => d && { ...d, notes: [full, ...d.notes] })
  }, [])

  /** Strokes of one note, from this device or else downloaded from the server. */
  const loadStrokes = useCallback(async (id: string): Promise<Stroke[]> => {
    const note = latest.current?.notes.find((n) => n.id === id)
    const rec = await readStrokes(id)
    if (rec && (!note || rec.sv === note.sv || serverless.current)) return rec.strokes
    let strokes: Stroke[]
    try {
      const res = await fetch(`${API}/notes/${id}/strokes`, { cache: 'no-store' })
      if (res.status === 404 || !res.headers.get('content-type')?.includes('json')) return rec?.strokes ?? []
      if (!res.ok) throw new Error(`Loading note failed (${res.status})`)
      strokes = await res.json()
    } catch (e) {
      if (rec) return rec.strokes
      throw e instanceof TypeError ? new Error("This note isn't on this device yet. Connect to your home server to open it.") : e
    }
    await set(strokesKey(id), { sv: note?.sv, strokes } satisfies StrokesRecord)
    if (note && !note.thumb) {
      const thumb = renderThumb(strokes)
      const pages = pageCount(strokes)
      setDb((d) => d && { ...d, notes: d.notes.map((n) => (n.id === id ? { ...n, thumb, pages } : n)) })
    }
    return strokes
  }, [])

  /** Called on every edit in the open note; storage and thumbnail are updated shortly after. */
  const updateStrokes = useCallback((id: string, strokes: Stroke[]) => {
    const sv = uid()
    const rec: StrokesRecord = { sv, strokes }
    live.set(id, rec)
    setDb((d) => d && { ...d, notes: d.notes.map((n) => (n.id === id ? { ...n, sv, updatedAt: Date.now() } : n)) })
    clearTimeout(timers.current.get(id))
    timers.current.set(
      id,
      setTimeout(async () => {
        timers.current.delete(id)
        const thumb = renderThumb(strokes)
        const pages = pageCount(strokes)
        setDb((d) => d && { ...d, notes: d.notes.map((n) => (n.id === id && n.sv === sv ? { ...n, thumb, pages } : n)) })
        await set(strokesKey(id), rec)
        if (live.get(id) === rec) live.delete(id)
      }, 1500),
    )
  }, [])

  const deleteNoteForever = useCallback((id: string) => {
    del(strokesKey(id))
    setDb((d) => d && { ...d, notes: d.notes.filter((n) => n.id !== id) })
  }, [])

  const emptyTrash = useCallback(() => {
    for (const n of latest.current?.notes ?? []) if (n.trashed) del(strokesKey(n.id))
    setDb((d) => d && { ...d, notes: d.notes.filter((n) => !n.trashed) })
  }, [])

  const createFolder = useCallback((name: string) => {
    const f: Folder = { id: uid(), name }
    setDb((d) => d && { ...d, folders: [...d.folders, f] })
  }, [])

  const deleteFolder = useCallback((id: string) => {
    setDb(
      (d) =>
        d && {
          folders: d.folders.filter((f) => f.id !== id),
          notes: d.notes.map((n) => (n.folderId === id ? { ...n, folderId: null } : n)),
        },
    )
  }, [])

  return { db, status, updateNote, createNote, addNote, loadStrokes, updateStrokes, deleteNoteForever, emptyTrash, createFolder, deleteFolder }
}

/** Move notes saved by older versions (strokes inside each note) to per-note stroke records. */
async function migrate(pending: { notes: Set<string> }): Promise<DB> {
  const old = await get<{ notes: (Note & { strokes?: Stroke[] })[]; folders: Folder[] }>(OLD_KEY)
  const db: DB = { notes: [], folders: old?.folders ?? [] }
  for (const { strokes = [], ...note } of old?.notes ?? []) {
    const sv = uid()
    await set(strokesKey(note.id), { sv, strokes } satisfies StrokesRecord)
    db.notes.push({ ...note, sv, thumb: renderThumb(strokes), pages: pageCount(strokes) })
    pending.notes.add(note.id) // upload the new thumbnail (and strokes, if the server lacks them)
  }
  await set(KEY, db)
  if (old) {
    await set(PENDING_KEY, { notes: [...pending.notes], folders: false } satisfies Pending)
    await del(OLD_KEY)
  }
  return db
}
