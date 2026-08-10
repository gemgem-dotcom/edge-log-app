'use client'

import { useEffect, useRef, useState, useCallback } from 'react'

const DELTA_THRESHOLD = 4
const TOP_EPSILON = 2
// How far (px) the user has to be from the top before the pinned glass
// background reaches its most opaque - within this distance it fades
// toward fully transparent as they keep scrolling up, so it visibly
// "clears" right before docking rather than snapping from glass to solid.
const FADE_DISTANCE = 320
const MIN_GLASS_ALPHA = 0.03
const MAX_GLASS_ALPHA = 0.5

// Drives the "hide on scroll down, reveal pinned+blurred (and increasingly
// transparent as it nears the top) on scroll up, dock at the true top"
// topbar behavior shared by the app shell and Account Settings.
//
// Every page in this app scrolls the window, not an internal element - the
// app shell's .shell{min-height:100vh} lets its content grow taller than
// the viewport rather than trapping overflow in .main-area (min-height
// only sets a floor, it doesn't cap the container the way a flex
// scroll-trap needs), so .main-area never actually develops its own
// scrollbar. This hook listens on window accordingly.
//
// The topbar itself is always position:fixed (see .shell-topbar /
// .account-topbar in globals.css) so it can overlay scrolled content while
// pinned - this hook also measures the topbar's own rendered space (height
// plus margins) so callers can render a same-sized spacer in the normal
// document flow and avoid a layout jump when the topbar leaves flow.
export function useStickyTopbar() {
  const topbarRef = useRef(null)
  const referenceTop = useRef(0)
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
    function handleScroll() {
      const scrollTop = window.scrollY

      // Continuous, independent of the discrete mode below - cheap direct
      // DOM write (not React state) since scroll fires far too often to
      // push through a re-render every time. Only visible once
      // .topbar-pinned actually applies the custom property, but harmless
      // to keep current the rest of the time.
      const alpha = MIN_GLASS_ALPHA + (MAX_GLASS_ALPHA - MIN_GLASS_ALPHA) * Math.min(1, scrollTop / FADE_DISTANCE)
      topbarRef.current?.style.setProperty('--topbar-glass-alpha', alpha.toFixed(3))

      if (scrollTop <= TOP_EPSILON) {
        referenceTop.current = scrollTop
        setMode('docked')
        return
      }

      // Compare against the point where the current run started, not just
      // the previous event - inertial/trackpad scrolling delivers many
      // small-delta events, and diffing consecutive events against each
      // other would mean no single one ever crosses the threshold even as
      // the cumulative scroll adds up to hundreds of pixels.
      const traveled = scrollTop - referenceTop.current
      if (traveled > DELTA_THRESHOLD) {
        referenceTop.current = scrollTop
        setMode('hidden')
      } else if (traveled < -DELTA_THRESHOLD) {
        referenceTop.current = scrollTop
        setMode('pinned')
      }
    }

    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  return { topbarRef, mode, spacerStyle: { height: spacerHeight } }
}
