import { useEffect, useState } from 'react'

// Diagnostic overlay (open the app with ?pendebug) showing what the browser receives from the pen.
export default function PenDebug() {
  const [live, setLive] = useState('move the pen over the screen')
  const [log, setLog] = useState<string[]>([])

  useEffect(() => {
    let lastButtons = -1
    const add = (line: string) => setLog((l) => [`${new Date().toLocaleTimeString()} ${line}`, ...l].slice(0, 14))
    const fmt = (e: PointerEvent) =>
      `${e.type} ${e.pointerType} button=${e.button} buttons=${e.buttons} pressure=${e.pressure.toFixed(2)}`

    const onPointer = (e: PointerEvent) => {
      setLive(fmt(e))
      const isMove = e.type === 'pointermove'
      if (!isMove || e.buttons !== lastButtons) add(fmt(e))
      lastButtons = e.buttons
    }
    const onOther = (e: Event) => {
      if (e instanceof KeyboardEvent) add(`${e.type} key=${e.key} code=${e.code}`)
      else if (e instanceof MouseEvent) add(`${e.type} button=${e.button} buttons=${e.buttons}`)
      else add(e.type)
    }

    const pointerTypes = ['pointerdown', 'pointerup', 'pointercancel', 'pointermove', 'pointerover', 'pointerleave']
    const otherTypes = ['contextmenu', 'auxclick', 'mousedown', 'keydown', 'keyup']
    const opts = { capture: true, passive: true }
    for (const t of pointerTypes) window.addEventListener(t, onPointer as EventListener, opts)
    for (const t of otherTypes) window.addEventListener(t, onOther, opts)
    return () => {
      for (const t of pointerTypes) window.removeEventListener(t, onPointer as EventListener, opts)
      for (const t of otherTypes) window.removeEventListener(t, onOther, opts)
    }
  }, [])

  return (
    <div className="pen-debug">
      <b>{live}</b>
      {log.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
    </div>
  )
}
