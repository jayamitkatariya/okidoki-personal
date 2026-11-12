import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { useCover } from '@/shell/media'

/**
 * okidoki's browser page is a native view drawn above the web content, so anything that floats
 * over it has to ask the page to step aside. Put this as the first child of an overlay's Portal:
 * it measures what the portal holds and, while that overlaps the page slot, registers a cover.
 * Portals stay mounted through their exit animation, so the cover lifts only once the overlay
 * has actually gone, and the page never snaps back over a fading menu.
 */
export function OverlayCover() {
  const marker = useRef<HTMLSpanElement>(null)
  const id = useId()
  const [over, setOver] = useState(false)

  useLayoutEffect(() => {
    let frame = 0
    let frames = 0
    const measure = () => {
      const slot = document.querySelector('.page-slot')
      const host = marker.current?.parentElement
      if (!slot || !host) return setOver(false)
      const s = slot.getBoundingClientRect()
      let hit = false
      for (const child of Array.from(host.children)) {
        if (child === marker.current) continue
        const r = child.getBoundingClientRect()
        if (r.width === 0 && r.height === 0) {
          // A zero-size positioner: its popup is what shows.
          const inner = child.firstElementChild?.getBoundingClientRect()
          if (inner && overlaps(inner, s)) hit = true
          continue
        }
        if (overlaps(r, s)) hit = true
      }
      setOver(hit)
    }
    // Floating UI places the popup a frame or two after mount.
    const tick = () => {
      measure()
      if (++frames < 4) frame = requestAnimationFrame(tick)
    }
    tick()
    window.addEventListener('resize', measure)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', measure)
    }
  }, [])

  useCover(`overlay-${id}`, over)
  useEffect(() => () => setOver(false), [])

  return <span ref={marker} hidden data-overlay-cover="" />
}

function overlaps(a: DOMRect, b: DOMRect) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}
