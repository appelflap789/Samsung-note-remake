import { useMemo } from 'react'
import { PAGE_H, PAGE_W, PAPER_GAP as G, strokeBounds, strokeD } from '../ink'
import type { Note } from '../types'

export default function Thumbnail({ note }: { note: Note }) {
  const paths = useMemo(
    () =>
      note.strokes
        .filter((s) => strokeBounds(s)[1] < PAGE_H)
        .map((s) => (
          <path
            key={s.id}
            d={strokeD(s)}
            fill={s.color}
            style={s.tool === 'highlighter' ? { opacity: 0.45, mixBlendMode: 'multiply' } : undefined}
          />
        )),
    [note.strokes],
  )
  const paper = note.paper ?? 'plain'
  return (
    <svg className="thumb-svg" viewBox={`0 0 ${PAGE_W} ${PAGE_H}`} preserveAspectRatio="xMidYMin slice">
      {paper !== 'plain' && (
        <>
          <defs>
            <pattern id={`p-${note.id}`} width={G} height={G} patternUnits="userSpaceOnUse">
              {paper === 'dotted' ? (
                <circle cx={G - 4} cy={G - 4} r={4} fill="#c9ced8" />
              ) : (
                <path d={paper === 'grid' ? `M${G - 1} 0V${G}M0 ${G - 1}H${G}` : `M0 ${G - 1}H${G}`} stroke="#dfe3ea" strokeWidth={2} />
              )}
            </pattern>
          </defs>
          <rect width={PAGE_W} height={PAGE_H} fill={`url(#p-${note.id})`} />
        </>
      )}
      {paths}
    </svg>
  )
}
