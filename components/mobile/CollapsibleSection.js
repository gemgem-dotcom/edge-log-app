'use client'

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'

// A section heading that folds its content away, on mobile only.
//
// The mobile Overview is one page in the desktop's own order - the pane
// switcher that used to split it was removed because a segmented row above
// the content is indistinguishable from a third navigation bar. That was
// the right call and it is not being undone here: this is still one page,
// in one order, with one navigation surface. The sections just fold.
//
// WHAT FOLDS AND WHY, decided by measuring rather than by taste. At 390px
// the per-instrument dashboard is 2,572px, and it divides like this:
//
//     655px  brief + session stats + next event   (no heading, always up)
//     969px  All-Time Performance
//     112px  Edge Insights
//     836px  Monthly P&L
//
// So two sections carry the page's height and one does not. Edge Insights
// at 112px would save ~68px once a 44px control is added - not worth a tap.
// It still gets a chevron, because a heading that behaves differently from
// the heading above it for no visible reason is worse than a chevron that
// saves little; it simply starts open.
//
// The two heavy ones start FOLDED. The daily glance - today's brief,
// session stats, the next calendar event - is the 655px above them and
// never folds, so the page still answers "what do I need to know right
// now" without a tap. Everything below that is a deeper dive.
//
// WHY NOT UNMOUNT. Closed content is hidden, not removed. The panels hold
// charts that measure their own container to lay out, and remounting them
// on every toggle re-runs that measurement against a container mid-
// transition - they visibly resize. Same reasoning MobilePanes carried.
//
// With enabled=false this renders the heading and children exactly as the
// page did before, with no wrapper element and no button - so the desktop
// DOM is untouched, which is verified by pixel diff rather than asserted.
export default function CollapsibleSection({
  enabled,
  title,
  defaultOpen = true,
  headingStyle,
  children,
}) {
  const [open, setOpen] = useState(defaultOpen)

  if (!enabled) {
    return (
      <>
        <div className="section-heading" style={headingStyle}>{title}</div>
        {children}
      </>
    )
  }

  return (
    <>
      <button
        type="button"
        className={`section-heading m-section-toggle${open ? ' is-open' : ''}`}
        style={headingStyle}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>{title}</span>
        <ChevronDown size={16} className="m-section-chevron" aria-hidden="true" />
      </button>
      <div hidden={!open}>{children}</div>
    </>
  )
}
