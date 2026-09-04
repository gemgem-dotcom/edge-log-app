'use client'

import { useState, useEffect, useCallback, useRef } from 'react'

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
// with pointer-events:auto, so nothing under them is clickable. The target
// itself is never covered by a band, so it stays genuinely interactive -
// no pointer-events override needed on it. The callout (instruction copy +
// step count + Exit control) renders above all four bands, so it's always
// clickable regardless of where it lands.
//
// The bands themselves are transparent, not dim - a rectangular band's own
// hard corner would otherwise poke a visible sharp notch into a rounded
// target's corner (most obvious around .new-trade-btn's fully pill-shaped
// border-radius:100px). All the actual dimming instead comes from
// .tutorial-panel-dim, a single rounded-rect box-shadow with no seams to
// begin with - same technique TutorialScrollGuide.js uses for its own
// panel-sized target, reused here via the same shared CSS class.
const TARGET_PAD = 8
const CALLOUT_WIDTH = 300
const CALLOUT_EST_HEIGHT = 190
const VIEWPORT_MARGIN = 12
const POLL_MS = 300

export default function TutorialOverlay({ step, steps, onExit }) {
  const [rect, setRect] = useState(null)
  const current = steps[step]
  // Tracks whichever real DOM node currently wears the spotlight, so its
  // own hover lift (button:hover's translateY(-1px) - see .new-trade-btn,
  // the one trigger that actually has one) can be suppressed while the
  // ring is drawn around it: hovering it mid-tutorial otherwise made the
  // button visibly detach from a glow that's supposed to be hugging it.
  // Not every target needs this ("+ Add instrument"/"+ Add new" are plain
  // hover-background links with no lift to begin with) - the class is a
  // no-op on those, so this applies it unconditionally rather than special-
  // casing which step's trigger happens to be a lifting button.
  const glowingElRef = useRef(null)

  // Unions the trigger's own rect with its expandSelector's, when that
  // second element exists - covers both shapes a step's target takes:
  // InstrumentNav's dropdown (a separate, position:fixed element that
  // appears alongside its still-present trigger) and the sidebar's
  // strategy form (which replaces its trigger in place, so only the
  // expandSelector is left to find). Either one missing is fine as long as
  // the other resolves.
  //
  // borderRadius is read straight off a real element's computed style
  // rather than hardcoded - a fixed radius happened to look fine against
  // .sidebar-strategy-add's sharp corners but drew an obviously squared-off
  // box around .new-trade-btn's fully pill-shaped border-radius:100px.
  // Prefer the expandSelector's own radius over the trigger's when both are
  // present: once expanded, the dropdown/form panel (a real bordered card,
  // e.g. .instrument-dropdown's 9px) is the dominant visual shape being
  // spotlighted, not the small pill-shaped trigger it's anchored to (e.g.
  // .instrument-nav-add's 100px) - using the trigger's radius there drew a
  // ring whose curve didn't match the panel's own corner underneath it,
  // which the panel's much sharper actual corner then visibly poked past.
  // Swaps the class onto whichever element is spotlighted right now,
  // removing it from wherever it was before - called from every exit
  // point of measure() below (target gone, step changed, tutorial
  // exited), not just the success path, so a stale glowing button never
  // outlives its own step. Diffs against the ref first so hovering the
  // still-current target doesn't retrigger a class add/remove on every
  // 300ms poll tick.
  const setGlowingEl = useCallback((el) => {
    if (glowingElRef.current === el) return
    glowingElRef.current?.classList.remove('tutorial-target-glow')
    el?.classList.add('tutorial-target-glow')
    glowingElRef.current = el
  }, [])

  useEffect(() => () => setGlowingEl(null), [setGlowingEl])

  const measure = useCallback(() => {
    if (!current) { setRect(null); setGlowingEl(null); return }
    const trigger = document.querySelector(current.targetSelector)
    const expandEl = current.expandSelector ? document.querySelector(current.expandSelector) : null
    // "Present in the DOM" isn't the same as "the user can see it", and
    // only the second one is worth spotlighting. The sidebar's strategy
    // list is the case that makes the difference: it's now always rendered
    // and collapsed via visibility:hidden (so it can animate shut - see
    // .sidebar-substrategies in globals.css) rather than unmounted, and on
    // a narrow viewport it collapses itself on scroll. Without this filter
    // step 1's "+ Add new" target would still measure to a full-size rect
    // while invisible, drawing a ring around nothing. Falling through to
    // the null-rect branch below instead gives the honest full-screen
    // fallback, exactly as it did when the element genuinely unmounted.
    const isVisible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
    const els = [trigger, expandEl].filter(isVisible)
    if (els.length === 0) { setRect(null); setGlowingEl(null); return }
    // Only the trigger itself, not expandEl - the ring visually covers
    // both once a dropdown/form opens, but the thing that needs its hover
    // lift suppressed is specifically the interactive control the ring
    // originated on, not a container it grew to include.
    setGlowingEl(isVisible(trigger) ? trigger : null)
    const rects = els.map((el) => el.getBoundingClientRect())
    const top = Math.min(...rects.map((r) => r.top))
    const left = Math.min(...rects.map((r) => r.left))
    const right = Math.max(...rects.map((r) => r.right))
    const bottom = Math.max(...rects.map((r) => r.bottom))
    const radiusSource = els[els.length - 1]
    const borderRadius = getComputedStyle(radiusSource).borderRadius
    setRect({ top, left, width: right - left, height: bottom - top, borderRadius })
  }, [current, setGlowingEl])

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
  // The ring is drawn on the padded spot rect, not the target's own rect,
  // so its radius needs to grow by the same padding to stay concentric
  // with the target's real rounded corners instead of cutting across them
  // (same reasoning as TutorialScrollGuide.js's PANEL_BORDER_RADIUS+PAD).
  const spotBorderRadius = `${parseFloat(rect.borderRadius || '12') + TARGET_PAD}px`

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
      <div className="tutorial-scrim-band tutorial-scrim-band-transparent" style={{ top: 0, left: 0, right: 0, height: `${Math.max(spot.top, 0)}px` }} />
      <div className="tutorial-scrim-band tutorial-scrim-band-transparent" style={{ top: `${spot.top + spot.height}px`, left: 0, right: 0, bottom: 0 }} />
      <div className="tutorial-scrim-band tutorial-scrim-band-transparent" style={{ top: `${spot.top}px`, left: 0, width: `${Math.max(spot.left, 0)}px`, height: `${spot.height}px` }} />
      <div className="tutorial-scrim-band tutorial-scrim-band-transparent" style={{ top: `${spot.top}px`, left: `${spot.left + spot.width}px`, right: 0, height: `${spot.height}px` }} />

      <div
        className="tutorial-panel-dim"
        style={{
          top: `${spot.top}px`, left: `${spot.left}px`, width: `${spot.width}px`, height: `${spot.height}px`,
          borderRadius: spotBorderRadius,
        }}
      />

      <div
        className="tutorial-spotlight-ring"
        style={{
          top: `${spot.top}px`, left: `${spot.left}px`, width: `${spot.width}px`, height: `${spot.height}px`,
          borderRadius: spotBorderRadius,
        }}
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
