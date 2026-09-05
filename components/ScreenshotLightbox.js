'use client'

import { useEffect } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

// Screenshot viewer shared by the Trade Log's expand row and the trade
// form (new/edit) - both let a trader step through every screenshot on
// one trade with arrow buttons, when there's more than one.
//
// The arrows are ordinary flex siblings of .modal-content (see
// .modal-overlay in globals.css), not absolutely positioned - two earlier
// versions computed their pixel offsets by hand (first relative to the
// image's own edge, then relative to the viewport), and both ended up
// with a visibly uneven left/right gap in practice despite the math
// checking out. Letting the browser's own flex layout place them removes
// that entire class of bug.
export default function ScreenshotLightbox({ shots, index, onIndexChange, onClose }) {
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
          onClick={(e) => { e.stopPropagation(); go(-1) }}
          aria-label="Previous screenshot"
        >
          <ChevronLeft size={20} />
        </div>
      )}
      <div className={`modal-content${hasMultiple ? ' has-nav' : ''}`} onClick={(e) => e.stopPropagation()}>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Close">✕</button>
        <img src={shots[index]} alt={`Trade screenshot ${index + 1} of ${shots.length}`} />
      </div>
      {hasMultiple && (
        <div
          className="modal-nav modal-nav-next"
          onClick={(e) => { e.stopPropagation(); go(1) }}
          aria-label="Next screenshot"
        >
          <ChevronRight size={20} />
        </div>
      )}
    </div>
  )
}
