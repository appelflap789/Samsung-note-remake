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

/** A picture placed on the page; the file itself is stored separately under `media`. */
export interface ImageItem {
  kind: 'image'
  id: string
  x: number
  y: number
  w: number
  h: number
  /** Media file name, e.g. "k3j2h1.jpg". */
  media: string
}

/** Typed text (or a link card when `url` is set). Grows downwards to fit its text. */
export interface TextItem {
  kind: 'text'
  id: string
  x: number
  y: number
  w: number
  /** Minimum height. */
  h: number
  text: string
  /** Font size in page units. */
  size: number
  color: string
  /** Line height as a multiple of `size` (default 1.3). */
  lh?: number
  url?: string
}

export type Item = ImageItem | TextItem

/** A note's content is stored and synced separately from the note list, and loaded only when it is opened. */
export interface StrokesRecord {
  sv?: string
  strokes: Stroke[]
  items?: Item[]
}

export interface Content {
  strokes: Stroke[]
  items: Item[]
}

export interface Folder {
  id: string
  name: string
  /** Containing folder; missing/null for top-level folders. */
  parentId?: string | null
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
