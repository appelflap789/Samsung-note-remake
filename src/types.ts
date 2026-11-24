export type Tool = 'pen' | 'highlighter' | 'eraser'

export type Paper = 'plain' | 'lined' | 'dotted' | 'grid'

/** A point in page units: [x, y, pressure 0..1] */
export type Point = [number, number, number]

export interface Stroke {
  id: string
  tool: 'pen' | 'highlighter'
  color: string
  size: number
  /** true when the points carry real stylus pressure */
  pressure: boolean
  points: Point[]
}

export interface Note {
  id: string
  title: string
  folderId: string | null
  favorite: boolean
  trashed: boolean
  createdAt: number
  updatedAt: number
  strokes: Stroke[]
  /** Missing on notes created before paper templates existed. */
  paper?: Paper
}

export interface Folder {
  id: string
  name: string
}

export interface DB {
  notes: Note[]
  folders: Folder[]
}

export type View =
  | { kind: 'all' }
  | { kind: 'favorites' }
  | { kind: 'trash' }
  | { kind: 'folder'; id: string }
