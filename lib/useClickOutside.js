import { useEffect, useRef } from 'react'

// Attach the returned ref to a dropdown/menu wrapper and it closes when a
// click (or touch, or Escape) lands anywhere outside it. `active` should be
// the menu's own open state, so the listener only exists while it's open.
export function useClickOutside(active, onOutside) {
  const ref = useRef(null)

  useEffect(() => {
    if (!active) return

    function handlePointer(e) {
      if (ref.current && !ref.current.contains(e.target)) onOutside()
    }
    function handleKey(e) {
      if (e.key === 'Escape') onOutside()
    }

    // mousedown rather than click, so the menu closes on press instead of
    // waiting for the release — matches how native menus behave.
    document.addEventListener('mousedown', handlePointer)
    document.addEventListener('touchstart', handlePointer)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handlePointer)
      document.removeEventListener('touchstart', handlePointer)
      document.removeEventListener('keydown', handleKey)
    }
  }, [active, onOutside])

  return ref
}
