import { useCallback, useEffect, useRef, useState } from 'react'
import { get, set } from 'idb-keyval'
import type { DB, Folder, Note } from './types'
import { uid } from './ink'

const KEY = 'samsung-notes-db-v1'

export function useNotesDB() {
  const [db, setDb] = useState<DB | null>(null)
  const latest = useRef<DB | null>(null)

  useEffect(() => {
    get<DB>(KEY).then((d) => setDb(d ?? { notes: [], folders: [] }))
  }, [])

  // Debounced persistence, plus a flush when the tab is hidden/closed.
  useEffect(() => {
    if (!db) return
    latest.current = db
    const t = setTimeout(() => set(KEY, db), 400)
    return () => clearTimeout(t)
  }, [db])

  useEffect(() => {
    const flush = () => latest.current && set(KEY, latest.current)
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', flush)
    }
  }, [])

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

  return { db, updateNote, createNote, addNotes, deleteNoteForever, emptyTrash, createFolder, deleteFolder }
}
