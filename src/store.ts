import { useCallback, useEffect, useRef, useState } from 'react'
import { get, set } from 'idb-keyval'
import type { DB, Folder, Note } from './types'
import { uid } from './ink'

const KEY = 'samsung-notes-db-v1'
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
      const note = latest.current?.notes.find((n) => n.id === id)
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
    const res = await fetch(`${API}/db`, { cache: 'no-store' })
    if (res.status === 404 || !res.headers.get('content-type')?.includes('json')) {
      serverless.current = true
      throw new Error('serverless')
    }
    if (!res.ok) throw new Error(`Loading notes failed (${res.status})`)
    const server: DB = await res.json()
    const local = latest.current ?? { notes: [], folders: [] }
    // Capture edits made since the last debounce tick before the server copy replaces them.
    if (collectChanges(local)) await savePending()
    const p = pending.current
    synced.current = new Map(server.notes.map((n) => [n.id, n]))
    syncedFolders.current = server.folders
    // Server wins, except for things changed here that haven't been uploaded yet.
    const notes = server.notes.filter((n) => !p.notes.has(n.id))
    for (const n of local.notes) if (p.notes.has(n.id)) notes.push(n)
    notes.sort((a, b) => b.updatedAt - a.updatedAt)
    const next = { notes, folders: p.folders ? local.folders : server.folders }
    latest.current = next
    setDb(next)
  }

  useEffect(() => {
    Promise.all([get<DB>(KEY), get<Pending>(PENDING_KEY)]).then(([d, pend]) => {
      const local = d ?? { notes: [], folders: [] }
      pending.current = { notes: new Set(pend?.notes ?? []), folders: pend?.folders ?? false }
      for (const n of local.notes) if (!pending.current.notes.has(n.id)) synced.current.set(n.id, n)
      syncedFolders.current = pending.current.folders ? null : local.folders
      latest.current = local
      setDb(local)
      sync(true).catch(() => {})
    })
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
    const flush = () => latest.current && set(KEY, latest.current)
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
    const note: Note = { id: uid(), title: '', folderId, favorite: false, trashed: false, createdAt: now, updatedAt: now, strokes: [], paper: 'plain' }
    setDb((d) => d && { ...d, notes: [note, ...d.notes] })
    return note.id
  }, [])

  const addNotes = useCallback((notes: Note[]) => {
    setDb((d) => d && { ...d, notes: [...notes, ...d.notes] })
  }, [])

  const deleteNoteForever = useCallback((id: string) => {
    setDb((d) => d && { ...d, notes: d.notes.filter((n) => n.id !== id) })
  }, [])

  const emptyTrash = useCallback(() => {
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

  return { db, status, updateNote, createNote, addNotes, deleteNoteForever, emptyTrash, createFolder, deleteFolder }
}
