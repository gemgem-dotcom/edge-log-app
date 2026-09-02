'use client'

import { useState, useEffect, useCallback } from 'react'

// Reusable spotlight tour, driven by `steps` (see lib/tutorial.js's
// TUTORIAL_STEPS) rather than three hand-built one-off overlays. Renders
// nothing itself besides fixed-position elements, so it can be mounted as
// a plain sibling anywhere in the tree - it finds its target the same way
// ColumnFilter.js and InstrumentNav.js's add-instrument dropdown do
// (measure via getBoundingClientRect, render position:fixed), including
// their scroll/resize listener pattern - except where those dismiss on
// scroll/resize, this re-measures instead, since "Exit tutorial" is meant
// to be the only way to close this.
//
// Blocking is real, not just visual: four bands tile the entire viewport
// minus the target's own rect (plus a little padding for the glow ring),
// each with the dim background and pointer-events:auto, so nothing under
// them is clickable. The target itself is never covered by a band, so it
// stays genuinely interactive - no pointer-events override needed on it.
// The callout (instruction copy + step count + Exit control) renders above
// all four bands, so it's always clickable regardless of where it lands.
const TARGET_PAD = 8
const CALLOUT_WIDTH = 300
const CALLOUT_EST_HEIGHT = 190
const VIEWPORT_MARGIN = 12
const POLL_MS = 300

export default function TutorialOverlay({ step, steps, onExit }) {
  const [rect, setRect] = useState(null)
  const current = steps[step]

  // Unions the trigger's own rect with its expandSelector's, when that
  // second element exists - covers both shapes a step's target takes:
  // InstrumentNav's dropdown (a separate, position:fixed element that
  // appears alongside its still-present trigger) and the sidebar's
  // strategy form (which replaces its trigger in place, so only the
  // expandSelector is left to find). Either one missing is fine as long as
  // the other resolves.
  const measure = useCallback(() => {
    if (!current) { setRect(null); return }
    const els = [
      document.querySelector(current.targetSelector),
      current.expandSelector ? document.querySelector(current.expandSelector) : null,
    ].filter(Boolean)
    if (els.length === 0) { setRect(null); return }
    const rects = els.map((el) => el.getBoundingClientRect())
    const top = Math.min(...rects.map((r) => r.top))
    const left = Math.min(...rects.map((r) => r.left))
    const right = Math.max(...rects.map((r) => r.right))
    const bottom = Math.max(...rects.map((r) => r.bottom))
    setRect({ top, left, width: right - left, height: bottom - top })
  }, [current])

  // Polled rather than event-driven: the step's target can still be
  // mounting right after a route change, and - more importantly - a step's
  // expandSelector only appears once the user clicks the trigger, a plain
  // React state change with no scroll/resize event of its own to key off.
  useEffect(() => {
    measure()
    const interval = setInterval(measure, POLL_MS)
    return () => clearInterval(interval)
  }, [measure])

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      window.addEventListener('scroll', measure, true)
      window.addEventListener('resize', measure)
    })
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [measure])

  if (!current) return null

  if (!rect) {
    // Target not found yet (still loading, or - on a stale/out-of-band
    // navigation - not on this page at all). Keeps the app inert rather
    // than let clicks through while nothing is spotlighted; Exit tutorial
    // still needs to work here too.
    return (
      <div className="tutorial-overlay">
        <div className="tutorial-scrim-band tutorial-scrim-full" />
        <button type="button" className="tutorial-exit-btn tutorial-exit-btn-standalone" onClick={onExit}>
          Exit tutorial
        </button>
      </div>
    )
  }

  const spot = {
    top: rect.top - TARGET_PAD,
    left: rect.left - TARGET_PAD,
    width: rect.width + TARGET_PAD * 2,
    height: rect.height + TARGET_PAD * 2,
  }

  let calloutTop = spot.top + spot.height + 14
  if (calloutTop + CALLOUT_EST_HEIGHT > window.innerHeight - VIEWPORT_MARGIN) {
    calloutTop = Math.max(spot.top - CALLOUT_EST_HEIGHT - 14, VIEWPORT_MARGIN)
  }
  const calloutLeft = Math.min(
    Math.max(spot.left, VIEWPORT_MARGIN),
    window.innerWidth - CALLOUT_WIDTH - VIEWPORT_MARGIN
  )

  return (
    <div className="tutorial-overlay">
      <div className="tutorial-scrim-band" style={{ top: 0, left: 0, right: 0, height: `${Math.max(spot.top, 0)}px` }} />
      <div className="tutorial-scrim-band" style={{ top: `${spot.top + spot.height}px`, left: 0, right: 0, bottom: 0 }} />
      <div className="tutorial-scrim-band" style={{ top: `${spot.top}px`, left: 0, width: `${Math.max(spot.left, 0)}px`, height: `${spot.height}px` }} />
      <div className="tutorial-scrim-band" style={{ top: `${spot.top}px`, left: `${spot.left + spot.width}px`, right: 0, height: `${spot.height}px` }} />

      <div
        className="tutorial-spotlight-ring"
        style={{ top: `${spot.top}px`, left: `${spot.left}px`, width: `${spot.width}px`, height: `${spot.height}px` }}
      />

      <div className="tutorial-callout" style={{ top: `${calloutTop}px`, left: `${calloutLeft}px`, width: `${CALLOUT_WIDTH}px` }}>
        <div className="tutorial-callout-step">Step {step + 1} of {steps.length}</div>
        <div className="tutorial-callout-title">{current.title}</div>
        <p className="tutorial-callout-message">{current.message}</p>
        <button type="button" className="tutorial-exit-btn" onClick={onExit}>Exit tutorial</button>
      </div>
    </div>
  )
}
