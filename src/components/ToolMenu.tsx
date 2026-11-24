import { Minus, Plus, X } from 'lucide-react'
import type { PenType } from '../types'
import { HL_PALETTE, PEN_PALETTE } from '../palettes'

const PEN_TYPES: { type: PenType; label: string }[] = [
  { type: 'fountain', label: 'Fountain pen' },
  { type: 'calligraphy', label: 'Calligraphy pen' },
  { type: 'ballpoint', label: 'Ballpoint pen' },
  { type: 'pencil', label: 'Pencil' },
  { type: 'brush', label: 'Brush' },
]

const TIPS: Record<PenType, string> = {
  fountain: 'M20 2 L29 34 H11 Z',
  calligraphy: 'M13 6 L27 2 L29 34 H11 Z',
  ballpoint: 'M20 8 L27 34 H13 Z',
  pencil: 'M20 4 L28 34 H12 Z',
  brush: 'M20 0 C25 10 28 22 28 34 H12 C12 22 15 10 20 0 Z',
}

function PenGlyph({ type, color, on }: { type: PenType; color: string; on: boolean }) {
  return (
    <svg viewBox="0 0 40 100" className={`pen-glyph ${on ? 'on' : ''}`}>
      <path d={TIPS[type]} fill={type === 'pencil' ? '#f1d3a6' : color} />
      {type === 'pencil' && <path d="M20 4 L22.7 14 H17.3 Z" fill={color} />}
      {type === 'fountain' && <path d="M20 14 V30" stroke="#fff" strokeWidth={1.4} />}
      <rect x={10} y={34} width={20} height={70} rx={3} fill={on ? color : '#ececec'} />
      <rect x={10} y={34} width={20} height={9} fill={on ? 'rgba(255,255,255,.35)' : color} />
    </svg>
  )
}

interface Props {
  left: number
  kind: 'pen' | 'highlighter' | 'eraser'
  penType: PenType
  color: string
  size: number
  min: number
  max: number
  straighten: boolean
  onPenType: (t: PenType) => void
  onColor: (c: string) => void
  onSize: (n: number) => void
  onStraighten: (v: boolean) => void
  onEraseAll: () => void
  onClose: () => void
}

export default function ToolMenu(p: Props) {
  const palette = p.kind === 'highlighter' ? HL_PALETTE : PEN_PALETTE
  const step = (d: number) => p.onSize(Math.max(p.min, Math.min(p.max, Math.round(p.size) + d)))
  return (
    <div className="tool-menu" style={{ left: p.left }}>
      <div className="tool-menu-head">
        <span>{p.kind === 'pen' ? 'Pen' : p.kind === 'highlighter' ? 'Highlighter' : 'Eraser'}</span>
        <button className="icon-btn small" onClick={p.onClose} title="Close">
          <X size={16} />
        </button>
      </div>

      {p.kind === 'pen' && (
        <div className="pen-types">
          {PEN_TYPES.map(({ type, label }) => (
            <button key={type} title={label} onClick={() => p.onPenType(type)}>
              <PenGlyph type={type} color={p.color} on={p.penType === type} />
            </button>
          ))}
        </div>
      )}

      <div className="size-row">
        <button className="icon-btn small" onClick={() => step(-1)} title="Thinner">
          <Minus size={16} />
        </button>
        <input
          type="range"
          min={p.min}
          max={p.max}
          step={0.5}
          value={p.size}
          onChange={(e) => p.onSize(+e.target.value)}
          title="Size"
        />
        <span className="size-value">{Math.round(p.size)}</span>
        <button className="icon-btn small" onClick={() => step(1)} title="Thicker">
          <Plus size={16} />
        </button>
      </div>

      {p.kind !== 'eraser' ? (
        <>
          <label className="switch-row">
            <span>Straighten lines</span>
            <input type="checkbox" className="switch" checked={p.straighten} onChange={(e) => p.onStraighten(e.target.checked)} />
          </label>
          <div className="palette">
            {palette.map((c) => (
              <button
                key={c}
                className={`swatch ${p.color.toLowerCase() === c ? 'on' : ''}`}
                style={{ background: c }}
                onClick={() => p.onColor(c)}
                title={c}
              />
            ))}
            <label className="swatch custom" title="Custom colour">
              <input type="color" value={p.color} onChange={(e) => p.onColor(e.target.value)} />
            </label>
          </div>
        </>
      ) : (
        <button className="erase-all" onClick={p.onEraseAll}>
          Erase all
        </button>
      )}
    </div>
  )
}
