# Samsung Notes rebuild

Samsung Notes–style handwriting app (React + Vite + TypeScript), tuned for Galaxy Book + S Pen in Edge/Chrome.

```
npm install
npm run dev
```

Open http://localhost:5173 in **Edge or Chrome** (the low-latency drawing APIs it relies on are Chromium-only).

## Install as an app
```
npm run build
npm run preview
```
Open http://localhost:4173 in Edge → **⋯ → Apps → Install this site as an app**. It gets its own window and taskbar icon, and works offline.

## Pen
- Pressure-sensitive strokes ([perfect-freehand](https://github.com/steveruizok/perfect-freehand)).
- Hold the **S Pen side button** to erase (stroke eraser), release to keep writing.
- Hand toggle on: fingers scroll, pen draws (palm-friendly). Off: fingers draw too.
- Ctrl+Z / Ctrl+Y undo/redo. Mouse wheel scrolls; right-drag with a mouse erases.

## Why it feels smooth
- `desynchronized` canvas → front-buffer rendering, skips the compositor queue.
- `pointerrawupdate` + `getCoalescedEvents()` → every digitizer sample, not one per frame.
- `getPredictedEvents()` → ink drawn slightly ahead of the nib to hide display lag.

Paper templates: plain, lined, dotted, grid. Follows the Windows light/dark theme (paper stays white).

Notes are stored offline in IndexedDB (per browser profile and origin — the installed app on :4173 and the dev server on :5173 have separate libraries).
