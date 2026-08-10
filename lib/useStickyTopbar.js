'use client'

import { useEffect, useRef, useState, useCallback } from 'react'

const DELTA_THRESHOLD = 4

// Drives the "hide on scroll down, reveal pinned+blurred on scroll up, dock
// at the true top" topbar behavior shared by the app shell and Account
// Settings. The topbar itself is always position:fixed (see .shell-topbar /
// .account-topbar in globals.css) so it can overlay scrolled content while
// pinned - this hook also measures the topbar's own rendered space (height
// plus margins) so callers can render a same-sized spacer in the normal
// document flow and avoid a layout jump when the topbar leaves flow.
//
// Pass `scrollRef` for a page whose content scrolls inside its own element
// (the app shell's .main-area); omit it for a page that scrolls the window
// (Account Settings has no internal scroll container).
export function useStickyTopbar({ scrollRef } = {}) {
  const topbarRef = useRef(null)
  const lastScrollTop = useRef(0)
  const [mode, setMode] = useState('docked')
  const [spacerHeight, setSpacerHeight] = useState(0)

  const measure = useCallback(() => {
    const el = topbarRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    setSpacerHeight(rect.height + parseFloat(cs.marginTop || 0) + parseFloat(cs.marginBottom || 0))
  }, [])

  useEffect(() => {
    measure()
    if (!topbarRef.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(topbarRef.current)
    return () => observer.disconnect()
  }, [measure])

  useEffect(() => {
    const target = scrollRef?.current || window
    const getScrollTop = () => (scrollRef?.current ? scrollRef.current.scrollTop : window.scrollY)

    function handleScroll() {
      const scrollTop = getScrollTop()
      const delta = scrollTop - lastScrollTop.current
      if (scrollTop <= 0) {
        setMode('docked')
      } else if (delta > DELTA_THRESHOLD) {
        setMode('hidden')
      } else if (delta < -DELTA_THRESHOLD) {
        setMode('pinned')
      }
      lastScrollTop.current = scrollTop
    }

    target.addEventListener('scroll', handleScroll, { passive: true })
    return () => target.removeEventListener('scroll', handleScroll)
    // scrollRef is a stable ref object - re-running when .current changes on
    // every render would thrash the listener, so it's intentionally omitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { topbarRef, mode, spacerStyle: { height: spacerHeight } }
}
