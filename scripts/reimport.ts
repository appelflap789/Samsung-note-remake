/**
 * Add images, text, link cards and shapes from the original `.sdocx` files to
 * notes that were imported before the importer supported them.
 *
 * Build: npx esbuild scripts/reimport.ts --bundle --platform=node --format=esm \
 *          --define:import.meta.env.BASE_URL='"/"' --outfile=reimport.mjs
 * Run:   node reimport.mjs <data dir> <originals dir>   (stop the server first)
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pageCount, uid } from '../src/ink'
import { importSdocx, titleFromFileName } from '../src/sdocx'
import type { Note, Stroke } from '../src/types'

// Text layout measures with a canvas; Node has none, so approximate glyph widths (only used for the page count).
const ctx = { font: '', measureText(t: string) { return { width: t.length * 0.55 * parseFloat(this.font.match(/([\d.]+)px/)?.[1] ?? '16') } } }
Object.assign(globalThis, { document: { createElement: () => ({ getContext: () => ctx }) } })

const [data, originals] = process.argv.slice(2)
if (!data || !originals) throw new Error('usage: reimport <data dir> <originals dir>')
const json = (f: string) => JSON.parse(readFileSync(f, 'utf8'))
const strokesOf = (raw: unknown): Stroke[] => (Array.isArray(raw) ? raw : (raw as { strokes: Stroke[] }).strokes)
const strokesFile = (n: Note) => join(data, 'strokes', `${n.id}.json`)
mkdirSync(join(data, 'media'), { recursive: true })

const notes: Note[] = readdirSync(join(data, 'notes')).map((f) => json(join(data, 'notes', f)))
const used = new Set<string>()
let updated = 0

for (const file of readdirSync(originals).filter((f) => f.endsWith('.sdocx')).sort()) {
  const b = readFileSync(join(originals, file))
  const r = await importSdocx(b.buffer.slice(b.byteOffset, b.byteOffset + b.length), file)
  const fresh = r.strokes.filter((s) => !s.shape)
  const candidates = notes
    .filter((n) => !n.trashed && !used.has(n.id) && n.title === titleFromFileName(file))
    .map((n) => ({ n, strokes: strokesOf(json(strokesFile(n))) }))
  // Same title more than once: pick the note whose stroke count is closest.
  candidates.sort((a, b) => Math.abs(a.strokes.length - fresh.length) - Math.abs(b.strokes.length - fresh.length))
  const match = candidates[0]
  if (!match) { console.log('no match:', file); continue }
  used.add(match.n.id)
  if (!r.items.length && r.strokes.length === fresh.length) continue

  // Unedited notes get the full fresh import; edited ones keep their strokes and gain the shapes.
  const strokes = match.strokes.length === fresh.length ? r.strokes : [...match.strokes, ...r.strokes.filter((s) => s.shape)]
  for (const [name, blob] of r.media) writeFileSync(join(data, 'media', name), Buffer.from(await blob.arrayBuffer()))
  writeFileSync(strokesFile(match.n), JSON.stringify({ strokes, items: r.items }))
  const { thumb: _old, ...meta } = match.n
  writeFileSync(join(data, 'notes', `${match.n.id}.json`), JSON.stringify({ ...meta, sv: uid(), pages: pageCount(strokes, r.items) }))
  updated++
  console.log(`${match.n.title}: +${r.items.length} items, ${r.media.size} images, ${strokes.length - match.strokes.length} shapes`)
}
console.log(`updated ${updated} notes`)
