'use client'

import { useEffect, useRef, useState } from 'react'

const CYCLE_MS = 10000
const HALF_FLIP_MS = 450 // must match .flip-cube-face's transition-duration in globals.css

// views: [{ label, segments: [{ id, label, color, value, tone }] }] - each
// entry is one full "face" (a label plus a chip strip), cycled through on a
// timer (and on click - see handleClick) . tone is 'pos'|'neg'|'neu',
// applied to the chip's value the same way PnlByInstrumentList (which this
// replaces) did. Every chip stays full color regardless of the card's own
// filter - unlike the static list this replaced, nothing here dims.
//
// The flip: a single face rotates up to rotateX(90deg) (edge-on, so
// backface-visibility:hidden makes it vanish), and only once that motion
// actually finishes (via transitionend, not a guessed delay) does the
// content swap - to the same still-invisible rotateX(-90deg), which reads
// identically to +90deg but lets the *next* transition run 90deg->0deg
// instead of reversing back the way it came, so the whole thing looks like
// one continuous tumble rather than a flip-and-bounce. That snap has its
// transition-duration turned off for one frame (the classic instant-reset
// trick - double rAF so the disabled state actually paints before it's
// undone). Only the transition-duration longhand is touched, never the
// transition shorthand - writing to el.style.transition resets every other
// longhand (property, timing-function) to its initial value too, which
// silently strips the CSS class's own transition-property and leaves
// every flip after the first with no transitionend event to listen for.
export default function FlippingStatChips({ views }) {
  const [index, setIndex] = useState(0)
  const elRef = useRef(null)
  const phaseRef = useRef('idle')
  const timeoutRef = useRef(null)
  const pausedRef = useRef(false)

  function triggerFlip() {
    const el = elRef.current
    if (!el || phaseRef.current !== 'idle') return
    phaseRef.current = 'up'
    el.style.transform = 'rotateX(90deg)'
  }

  // Self-rescheduling rather than setInterval, so a manual click (below)
  // can restart the countdown instead of leaving a stale timer that fires
  // again moments after the user just triggered one by hand. No-ops while
  // paused (hover / touch-hold) - resuming (handlePauseEnd) is what restarts
  // the countdown.
  function scheduleNext() {
    clearTimeout(timeoutRef.current)
    if (pausedRef.current) return
    timeoutRef.current = setTimeout(() => {
      triggerFlip()
      scheduleNext()
    }, CYCLE_MS)
  }

  useEffect(() => {
    scheduleNext()
    return () => clearTimeout(timeoutRef.current)
  }, [])

  function handleClick() {
    triggerFlip()
    scheduleNext()
  }

  // Mouse hover pauses/resumes directly. Touch has no hover state, so we
  // treat a held finger the same way: pause on touchstart, resume on
  // touchend/touchcancel. preventDefault is deliberately never called here -
  // doing so would suppress the browser's synthetic click that fires after a
  // tap, which is what makes tap-to-flip (handleClick) work on touch devices
  // too.
  function handlePauseStart() {
    pausedRef.current = true
    clearTimeout(timeoutRef.current)
  }

  function handlePauseEnd() {
    pausedRef.current = false
    scheduleNext()
  }

  function handleTransitionEnd(e) {
    if (e.propertyName !== 'transform') return
    const el = elRef.current
    if (!el) return
    if (phaseRef.current === 'up') {
      setIndex((i) => (i + 1) % views.length)
      el.style.transitionDuration = '0s'
      el.style.transform = 'rotateX(-90deg)'
      void el.offsetHeight
      el.style.transitionDuration = ''
      phaseRef.current = 'down'
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (elRef.current) elRef.current.style.transform = 'rotateX(0deg)'
        })
      })
    } else {
      phaseRef.current = 'idle'
    }
  }

  const view = views[index % views.length]

  return (
    <div
      className="flip-cube-wrap"
      onClick={handleClick}
      onMouseEnter={handlePauseStart}
      onMouseLeave={handlePauseEnd}
      onTouchStart={handlePauseStart}
      onTouchEnd={handlePauseEnd}
      onTouchCancel={handlePauseEnd}
    >
      <div
        ref={elRef}
        className="flip-cube-face"
        onTransitionEnd={handleTransitionEnd}
      >
        <span className="stat-label">{view.label}</span>
        <div className="pnl-rank-strip">
          {view.segments.map((seg) => (
            <div className="pnl-rank-chip" key={seg.id}>
              <span className="gauge-dot" style={{ background: seg.color }} />
              <span className="pnl-rank-symbol">{seg.label}</span>
              <span className={`pnl-rank-value ${seg.tone}`}>{seg.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
