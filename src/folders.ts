import type { Folder, Note } from './types'

export const childFolders = (folders: Folder[], parent: string | null) => folders.filter((f) => (f.parentId ?? null) === parent)

/** All folders depth-first, each with its nesting depth. */
export function folderTree(folders: Folder[], parent: string | null = null, depth = 0): { folder: Folder; depth: number }[] {
  return childFolders(folders, parent).flatMap((folder) => [{ folder, depth }, ...folderTree(folders, folder.id, depth + 1)])
}

/** The folder and everything inside it. */
export function subtreeIds(folders: Folder[], id: string): Set<string> {
  return new Set([id, ...folderTree(folders, id).map((t) => t.folder.id)])
}

/** Live notes in the folder, including its subfolders. */
export function noteCount(folders: Folder[], notes: Note[], id: string) {
  const ids = subtreeIds(folders, id)
  return notes.filter((n) => !n.trashed && n.folderId && ids.has(n.folderId)).length
}

export function folderPath(folders: Folder[], id: string): string {
  const f = folders.find((x) => x.id === id)
  if (!f) return 'Folder'
  return f.parentId ? `${folderPath(folders, f.parentId)} / ${f.name}` : f.name
}
