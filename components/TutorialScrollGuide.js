'use client'

import { useState, useEffect, useCallback } from 'react'
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
const BOTTOM_TOLERANCE_PX = 24

export default function TutorialScrollGuide({ onComplete }) {
  const [ready, setReady] = useState(false)
  const [panelRect, setPanelRect] = useState(null)

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

  const measurePanel = useCallback(() => {
    const panel = document.querySelector('[data-tutorial-target="trade-form-panel"]')
    if (panel) setPanelRect(panel.getBoundingClientRect())
  }, [])

  useEffect(() => {
    measurePanel()
    window.addEventListener('scroll', measurePanel, { passive: true })
    window.addEventListener('resize', measurePanel)
    return () => {
      window.removeEventListener('scroll', measurePanel)
      window.removeEventListener('resize', measurePanel)
    }
  }, [measurePanel])

  const spot = panelRect
    ? {
        top: panelRect.top - PANEL_PAD,
        left: panelRect.left - PANEL_PAD,
        width: panelRect.width + PANEL_PAD * 2,
        height: panelRect.height + PANEL_PAD * 2,
      }
    : null

  const bands = spot
    ? [
        { top: 0, left: 0, right: 0, height: `${Math.max(spot.top, 0)}px` },
        { top: `${spot.top + spot.height}px`, left: 0, right: 0, bottom: 0 },
        { top: `${spot.top}px`, left: 0, width: `${Math.max(spot.left, 0)}px`, height: `${spot.height}px` },
        { top: `${spot.top}px`, left: `${spot.left + spot.width}px`, right: 0, height: `${spot.height}px` },
      ]
    : [{ top: 0, left: 0, right: 0, bottom: 0 }]

  // The panel fills .main-area's own width (neither .page-container nor
  // .panel constrain it further), so the panel's horizontal center and
  // .main-area's are the same - centering the chevrons/continue text under
  // panelRect keeps them aligned with the form rather than the screen,
  // which the sidebar otherwise throws off-center.
  const centerX = panelRect ? panelRect.left + panelRect.width / 2 : null
  const centerStyle = centerX !== null ? { left: `${centerX}px` } : undefined

  return (
    <>
      {/* Click-blocking only here (transparent) - the 4 rectangular bands'
          own hard corners would otherwise show through as a sharp notch cut
          into the ring's rounded corner, since a rect band's corner point
          sits outside a rounded target's curve but still inside the band's
          own bounding box. All the actual dimming instead comes from
          .tutorial-panel-dim below, a single rounded-rect box-shadow that
          has no seams to begin with. */}
      {bands.map((style, i) => (
        <div key={i} className="tutorial-scrim-band tutorial-scrim-band-transparent" style={style} />
      ))}
      {spot && (
        <div
          className="tutorial-panel-dim"
          style={{
            top: `${spot.top}px`, left: `${spot.left}px`, width: `${spot.width}px`, height: `${spot.height}px`,
            borderRadius: `${PANEL_BORDER_RADIUS + PANEL_PAD}px`,
          }}
        />
      )}
      {spot && (
        <div
          className="tutorial-spotlight-ring"
          style={{
            top: `${spot.top}px`, left: `${spot.left}px`, width: `${spot.width}px`, height: `${spot.height}px`,
            borderRadius: `${PANEL_BORDER_RADIUS + PANEL_PAD}px`,
          }}
        />
      )}
      {!ready && (
        <div className="tutorial-scroll-chevrons" style={centerStyle} aria-hidden="true">
          <ChevronDown size={22} />
          <ChevronDown size={22} />
          <ChevronDown size={22} />
        </div>
      )}
      {ready && (
        <>
          <div className="tutorial-scroll-continue" style={centerStyle}>Tap anywhere to continue</div>
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
