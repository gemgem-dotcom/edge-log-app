'use client'

import { useState, useEffect, useCallback } from 'react'
import { ChevronDown } from 'lucide-react'

// Tutorial step 3 (tutorial_step === 2) - shown on the Log New Trade page
// itself, once the user has added an instrument and a strategy. Unlike
// TutorialOverlay.js's steps 1/2, the target here is the whole form, so
// there's nothing to dim or ring - this only ever blocks navigation
// (topbar/sidebar) and guides the user through scrolling the form, never
// obscuring it. TutorialOverlay.js is intentionally left untouched; this is
// a separate component because the interaction model doesn't fit it (no
// fixed target rect to spotlight, progression is scroll-driven rather than
// click-driven, and there's deliberately no Exit control here).
//
// Nav-blocking reuses TutorialOverlay's real 4-band-tiling technique - see
// its own comment for why a punched-out single overlay wouldn't actually
// block clicks - but tiled around .main-area's rect instead of a step
// target, and transparent instead of dimmed. .main-area's rect alone is
// enough: the topbar is position:fixed (a static rect regardless of
// scroll) and the sidebar is a plain flex sibling of .main-area inside
// .shell-body, so both fall entirely outside .main-area's own rect and are
// covered by the bands without needing to be measured separately.
const BOTTOM_TOLERANCE_PX = 24

export default function TutorialScrollGuide({ onComplete }) {
  const [ready, setReady] = useState(false)
  const [navRect, setNavRect] = useState(null)

  // window/document is what actually scrolls on this page, not .main-area
  // itself (verified directly - .main-area's overflow-y:auto never ends up
  // needing to scroll in practice, since .shell has no capped height and
  // taller-than-viewport content just grows past 100vh instead) - so this
  // reads window.scrollY / document.documentElement, not a container ref.
  const checkBottom = useCallback(() => {
    const doc = document.documentElement
    const atBottom = window.scrollY + window.innerHeight >= doc.scrollHeight - BOTTOM_TOLERANCE_PX
    if (atBottom) setReady(true)
  }, [])

  useEffect(() => {
    // Tall viewport / short form: nothing to scroll, so no scroll event
    // will ever fire - go straight to the "tap to continue" state instead
    // of waiting on one.
    checkBottom()
    window.addEventListener('scroll', checkBottom, { passive: true })
    window.addEventListener('resize', checkBottom)
    return () => {
      window.removeEventListener('scroll', checkBottom)
      window.removeEventListener('resize', checkBottom)
    }
  }, [checkBottom])

  const measureNav = useCallback(() => {
    const mainArea = document.querySelector('.main-area')
    if (mainArea) setNavRect(mainArea.getBoundingClientRect())
  }, [])

  useEffect(() => {
    measureNav()
    window.addEventListener('scroll', measureNav, { passive: true })
    window.addEventListener('resize', measureNav)
    return () => {
      window.removeEventListener('scroll', measureNav)
      window.removeEventListener('resize', measureNav)
    }
  }, [measureNav])

  const bands = navRect
    ? [
        { top: 0, left: 0, right: 0, height: `${Math.max(navRect.top, 0)}px` },
        { top: `${navRect.bottom}px`, left: 0, right: 0, bottom: 0 },
        { top: `${navRect.top}px`, left: 0, width: `${Math.max(navRect.left, 0)}px`, height: `${navRect.height}px` },
        { top: `${navRect.top}px`, left: `${navRect.right}px`, right: 0, height: `${navRect.height}px` },
      ]
    : [{ top: 0, left: 0, right: 0, bottom: 0 }]

  return (
    <>
      {bands.map((style, i) => (
        <div key={i} className="tutorial-scrim-band tutorial-scrim-band-transparent" style={style} />
      ))}
      {!ready && (
        <div className="tutorial-scroll-chevrons" aria-hidden="true">
          <ChevronDown size={22} />
          <ChevronDown size={22} />
          <ChevronDown size={22} />
        </div>
      )}
      {ready && (
        <>
          <div className="tutorial-scroll-continue">Tap anywhere to continue</div>
          {/* Genuinely intercepts every tap, including on the real Submit
              button underneath - not a layout coincidence with the chevrons
              above it. handleSubmit in log/new/page.js also independently
              refuses to insert while this step is active, since this
              catcher only stops pointer events, not a native Enter-key
              form submission. */}
          <div className="tutorial-tap-catcher" onClick={onComplete} />
        </>
      )}
    </>
  )
}
