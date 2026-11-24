export type Tool = 'pen' | 'highlighter' | 'eraser' | 'lasso'

export type PenType = 'fountain' | 'calligraphy' | 'ballpoint' | 'pencil' | 'brush'

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
  /** Pen nib; missing on older strokes (= fountain). */
  pen?: PenType
  /** Snapped geometric shape: rendered without smoothing/thinning so corners stay crisp. */
  shape?: boolean
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
  /** Missing on notes created before paper templates existed. */
  paper?: Paper
  /** Changes whenever the strokes change; tells devices their stored copy is stale. */
  sv?: string
  /** Small image of the first page (data URL). */
  thumb?: string
  pages?: number
}

/** Strokes are stored and synced separately from the note list, and loaded only when a note is opened. */
export interface StrokesRecord {
  sv?: string
  strokes: Stroke[]
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
  | { kind: 'folders' }
  | { kind: 'folder'; id: string }
