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
- Tap the active pen/highlighter/eraser again for its menu: pen type (fountain, calligraphy, ballpoint, pencil, brush), size, *Straighten lines*, colours. Settings are remembered.
- **Hold the pen still** at the end of a stroke to snap it into a line, circle/ellipse, rectangle/square or triangle.
- **Lasso**: circle strokes to select; drag to move, tap a colour to recolour, or delete.
- **S Pen side button**: on Android a click arms the eraser for the next stroke (pressed mid-stroke, the rest of that stroke erases); on Windows, hold it while writing. Debug pen input with `?pendebug`.
- Hand toggle on: fingers scroll, pen draws (palm-friendly). Off: fingers draw too.
- Ctrl+Z / Ctrl+Y undo/redo. Mouse wheel scrolls; right-drag with a mouse erases.

## Import from Samsung Notes
In Samsung Notes, share a note as a **Samsung Notes file** (`.sdocx`), then use **Import Samsung Notes** in the note list (multiple files allowed). Handwriting comes in as editable strokes with its colour, thickness and pressure; each Samsung page starts on a new page. Images, typed text, text boxes, link cards and shapes come in as objects: tap one with the lasso to select it, drag to move, use the corner handle to resize, and tap a selected text again to edit it. The **T** and image buttons add new ones. Text styling (bold etc.) and PDFs are not imported. To add these objects to notes imported with an older version, run `scripts/reimport.ts` (instructions in the file) on the server data with the original `.sdocx` files. Format details from [bxff/samsung-notes-format](https://github.com/bxff/samsung-notes-format) and the [twangodev/sdocx](https://github.com/twangodev/sdocx) format notes.

## Home server (sync)
`server.mjs` serves the app and stores notes as JSON files (`data/notes/<id>.json` for title/folder/thumbnail, `data/strokes/<id>.json` for the handwriting and objects, `data/media/` for images, `data/folders.json`). With it, every device syncs through the server and uploads changes when it's back online (last change wins). The note list is always on the device; a note's handwriting is downloaded the first time it is opened there, so large libraries stay fast. Without it (GitHub Pages, `npm run dev`) notes stay on the device. The sidebar shows the sync status.

- Deploy the current working copy: `./deploy.sh` (from PowerShell: `wsl ./deploy.sh`). It copies the code to `~/samsung-notes` on the server and rebuilds the Docker container; `~/samsung-notes/data` is never touched.
- Open `http://<server>:8787` (e.g. via Tailscale: `http://jacob228:8787`). Over plain HTTP the browser won't install it as an app or load it offline; for that, enable Tailscale Serve: `tailscale serve --bg --https=443 http://127.0.0.1:8787`.
- Back up by copying `~/samsung-notes/data`.

## Why it feels smooth
- `desynchronized` canvas → front-buffer rendering, skips the compositor queue.
- `pointerrawupdate` + `getCoalescedEvents()` → every digitizer sample, not one per frame.
- `getPredictedEvents()` → ink drawn slightly ahead of the nib to hide display lag.

Paper templates: plain, lined, dotted, grid. Follows the Windows light/dark theme (paper stays white).

Notes are stored offline in IndexedDB (per browser profile and origin — the installed app on :4173 and the dev server on :5173 have separate libraries).
