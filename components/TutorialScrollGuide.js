'use client'

import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react'
import { ChevronDown } from 'lucide-react'

// Tutorial step 3 (tutorial_step === 2) - shown on the Log New Trade page
// itself, once the user has added an instrument and a strategy. Spotlights
// the whole trade-form panel (data-tutorial-target="trade-form-panel" on
// TradeForm.js's own outer .panel) the same way TutorialOverlay.js's steps
// 1/2 spotlight a small control - dimmed bands tiling the viewport minus
// the panel's rect, plus its glowing ring - just scaled up to a panel-sized
// target instead of a button-sized one. TutorialOverlay.js is intentionally
// left untouched; this is a separate component because progression here is
// scroll-driven rather than click-driven, and there's deliberately no Exit
// control.
const PANEL_PAD = 10
// .panel's own border-radius (see app/globals.css) - the ring is drawn on
// a rect padded PANEL_PAD outside the panel's real one, so it needs its
// corner radius increased by the same amount to stay concentric with the
// panel's actual rounded corners instead of visibly cutting across them.
const PANEL_BORDER_RADIUS = 20
const SPOT_BORDER_RADIUS = `${PANEL_BORDER_RADIUS + PANEL_PAD}px`
const BOTTOM_TOLERANCE_PX = 24

export default function TutorialScrollGuide({ onComplete }) {
  const [ready, setReady] = useState(false)

  const bandRefs = useRef([])
  const dimRef = useRef(null)
  const ringRef = useRef(null)
  const chevronsRef = useRef(null)
  const continueRef = useRef(null)

  // Direct DOM writes, not React state - same reasoning as
  // lib/useStickyTopbar.js's own scroll handler (see its comment): scroll
  // fires far more often than a re-render can keep up with, and routing
  // every tick through setState was exactly what made the glow visibly
  // lag/jiggle behind the actual scroll position, since these are already
  // position:fixed elements whose on-screen position should track the
  // browser's own scroll compositing, not React's render cycle.
  const applyGeometry = useCallback(() => {
    const panel = document.querySelector('[data-tutorial-target="trade-form-panel"]')
    if (!panel) return
    const panelRect = panel.getBoundingClientRect()
    const spot = {
      top: panelRect.top - PANEL_PAD,
      left: panelRect.left - PANEL_PAD,
      width: panelRect.width + PANEL_PAD * 2,
      height: panelRect.height + PANEL_PAD * 2,
    }

    const bandStyles = [
      { top: '0px', left: '0px', right: '0px', height: `${Math.max(spot.top, 0)}px` },
      { top: `${spot.top + spot.height}px`, left: '0px', right: '0px', bottom: '0px' },
      { top: `${spot.top}px`, left: '0px', width: `${Math.max(spot.left, 0)}px`, height: `${spot.height}px` },
      { top: `${spot.top}px`, left: `${spot.left + spot.width}px`, right: '0px', height: `${spot.height}px` },
    ]
    bandRefs.current.forEach((el, i) => el && Object.assign(el.style, bandStyles[i]))

    const spotStyle = { top: `${spot.top}px`, left: `${spot.left}px`, width: `${spot.width}px`, height: `${spot.height}px`, borderRadius: SPOT_BORDER_RADIUS }
    if (dimRef.current) Object.assign(dimRef.current.style, spotStyle)
    if (ringRef.current) Object.assign(ringRef.current.style, spotStyle)

    // The panel fills .main-area's own width (neither .page-container nor
    // .panel constrain it further), so the panel's horizontal center and
    // .main-area's are the same - centering the chevrons/continue text
    // under panelRect keeps them aligned with the form rather than the
    // screen, which the sidebar otherwise throws off-center.
    const centerLeft = `${panelRect.left + panelRect.width / 2}px`
    if (chevronsRef.current) chevronsRef.current.style.left = centerLeft
    if (continueRef.current) continueRef.current.style.left = centerLeft
  }, [])

  // window/document is what actually scrolls on this page, not .main-area
  // itself (verified directly - .main-area's overflow-y:auto never ends up
  // needing to scroll in practice, since .shell has no capped height and
  // taller-than-viewport content just grows past 100vh instead).
  const checkBottom = useCallback(() => {
    const doc = document.documentElement
    const atBottom = window.scrollY + window.innerHeight >= doc.scrollHeight - BOTTOM_TOLERANCE_PX
    if (atBottom) setReady(true)
  }, [])

  // Runs before paint so the very first frame already has the bands/ring
  // positioned around the real panel, instead of a flash at 0,0.
  useLayoutEffect(() => {
    applyGeometry()
    // Tall viewport / short form: nothing to scroll, so no scroll event
    // will ever fire - go straight to the "tap to continue" state instead
    // of waiting on one.
    checkBottom()
  }, [applyGeometry, checkBottom])

  useEffect(() => {
    let rafId = null
    function onScrollOrResize() {
      if (rafId !== null) return
      rafId = requestAnimationFrame(() => {
        rafId = null
        applyGeometry()
        checkBottom()
      })
    }
    window.addEventListener('scroll', onScrollOrResize, { passive: true })
    window.addEventListener('resize', onScrollOrResize)
    return () => {
      window.removeEventListener('scroll', onScrollOrResize)
      window.removeEventListener('resize', onScrollOrResize)
      if (rafId !== null) cancelAnimationFrame(rafId)
    }
  }, [applyGeometry, checkBottom])

  function handleChevronsClick() {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' })
  }

  return (
    <>
      {/* Click-blocking only here (transparent) - the 4 rectangular bands'
          own hard corners would otherwise show through as a sharp notch cut
          into the ring's rounded corner, since a rect band's corner point
          sits outside a rounded target's curve but still inside the band's
          own bounding box. All the actual dimming instead comes from
          .tutorial-panel-dim below, a single rounded-rect box-shadow that
          has no seams to begin with. */}
      {[0, 1, 2, 3].map((i) => (
        <div key={i} ref={(el) => (bandRefs.current[i] = el)} className="tutorial-scrim-band tutorial-scrim-band-transparent" />
      ))}
      <div ref={dimRef} className="tutorial-panel-dim" />
      <div ref={ringRef} className="tutorial-spotlight-ring" />
      {!ready && (
        <div ref={chevronsRef} className="tutorial-scroll-chevrons" onClick={handleChevronsClick}>
          <ChevronDown size={22} />
          <ChevronDown size={22} />
          <ChevronDown size={22} />
        </div>
      )}
      {ready && (
        <>
          <div ref={continueRef} className="tutorial-scroll-continue">Tap anywhere to continue</div>
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
