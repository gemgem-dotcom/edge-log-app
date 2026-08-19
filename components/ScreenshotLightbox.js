'use client'

import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

const NAV_GAP = 16 // space between the image's rendered edge and the arrow
const NAV_SIZE = 40 // must match .modal-nav's width/height in globals.css
const EDGE_MARGIN = 16 // closest an arrow is ever allowed to sit to the viewport edge

// Screenshot viewer shared by the Trade Detail page and the Trade Log's
// expand row - both let a trader step through every screenshot on one
// trade with arrow buttons, when there's more than one.
//
// The arrows track the image's own rendered left/right edge (measured via
// getBoundingClientRect on load and on resize) rather than a fixed CSS
// offset, because trading screenshots vary wildly in aspect ratio: a wide
// landscape chart nearly fills the 90vw cap, so anchoring to the viewport
// edge (an earlier version of this) put the arrows right next to it, but a
// narrow/tall screenshot leaves a lot of empty overlay on each side, and
// that same viewport-edge anchor stranded the arrows far from the image.
// Hugging the measured image edge instead keeps the gap consistent either
// way. EDGE_MARGIN is the floor for that - without it, a screenshot at the
// full 90vw would try to push an arrow off-screen.
//
// navPos starts null (before the image has loaded once) and the CSS
// fallback in globals.css (.modal-nav-prev/-next) takes over meanwhile -
// that fallback sits at the viewport edge, which is always a safe
// (non-overlapping) position even for a full-width image, so there's
// nothing to flash incorrectly before the first measurement lands.
export default function ScreenshotLightbox({ shots, index, onIndexChange, onClose }) {
  const imgRef = useRef(null)
  const [navPos, setNavPos] = useState(null)

  function measure() {
    const el = imgRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setNavPos({
      left: Math.max(EDGE_MARGIN, rect.left - NAV_GAP - NAV_SIZE),
      right: Math.max(EDGE_MARGIN, window.innerWidth - rect.right - NAV_GAP - NAV_SIZE),
    })
  }

  useEffect(() => {
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  })

  // Left/right arrow keys step through the screenshots the same as
  // clicking the on-screen arrows - only wired up while there's more than
  // one to step through, matching when the arrows themselves render.
  useEffect(() => {
    if (!shots || shots.length <= 1) return
    function onKeyDown(e) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); onIndexChange((index - 1 + shots.length) % shots.length) }
      else if (e.key === 'ArrowRight') { e.preventDefault(); onIndexChange((index + 1) % shots.length) }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [shots, index, onIndexChange])

  if (!shots || shots.length === 0) return null
  const hasMultiple = shots.length > 1

  function go(delta) {
    onIndexChange((index + delta + shots.length) % shots.length)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      {hasMultiple && (
        <div
          className="modal-nav modal-nav-prev"
          style={navPos ? { left: navPos.left } : undefined}
          onClick={(e) => { e.stopPropagation(); go(-1) }}
          aria-label="Previous screenshot"
        >
          <ChevronLeft size={20} />
        </div>
      )}
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-close" onClick={onClose}>✕</div>
        <img
          ref={imgRef}
          src={shots[index]}
          alt={`Trade screenshot ${index + 1} of ${shots.length}`}
          onLoad={measure}
        />
      </div>
      {hasMultiple && (
        <div
          className="modal-nav modal-nav-next"
          style={navPos ? { right: navPos.right } : undefined}
          onClick={(e) => { e.stopPropagation(); go(1) }}
          aria-label="Next screenshot"
        >
          <ChevronRight size={20} />
        </div>
      )}
    </div>
  )
}
