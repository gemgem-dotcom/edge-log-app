'use client'

import { useState, Fragment } from 'react'

// Turns one very long page into a few short ones, on mobile only.
//
// The dashboard is 5,300px tall on a 390px screen - about fourteen
// screenfuls, in one undifferentiated scroll. Everything on it is worth
// having; none of it is worth scrolling past six times to reach the
// calendar. That is what a desktop page narrowed looks like, and it is
// the difference between a responsive site and an app.
//
// So the same content is grouped into panes behind a segmented control.
// Nothing is removed and nothing is summarised away - the trader chooses
// which third of the page they are looking at.
//
// WHY EVERY PANE STAYS MOUNTED. Inactive panes are hidden with the
// `hidden` attribute rather than unmounted. The panes hold charts that
// measure their own container to lay out; unmounting and remounting them
// on every tab switch would re-run that measurement against a container
// that is mid-transition, and the charts would resize visibly each time.
// Hidden keeps them laid out and costs one display:none.
//
// WHY `enabled` RATHER THAN A SEPARATE CALL SITE. With enabled=false this
// renders its children in order with no wrapper element and no segmented
// control - the exact DOM the page had before any of this existed. That
// is what lets one page serve both without the desktop markup being
// touched, and it is verified by pixel-diffing the desktop, not assumed.
export default function MobilePanes({ enabled, panes, ariaLabel = 'Sections' }) {
  const [active, setActive] = useState(panes[0]?.key)

  if (!enabled) {
    // Keyed fragments render no DOM of their own, so the desktop output
    // is byte-identical to listing these blocks inline.
    return <>{panes.map((p) => <Fragment key={p.key}>{p.content}</Fragment>)}</>
  }

  return (
    <>
      {/* role=tablist rather than plain buttons: this genuinely is a tab
          set, and a screen reader should announce "2 of 3" rather than
          three unrelated buttons. */}
      <div className="m-panebar" role="tablist" aria-label={ariaLabel}>
        {panes.map((p) => (
          <button
            key={p.key}
            type="button"
            role="tab"
            id={`m-tab-${p.key}`}
            aria-selected={active === p.key}
            aria-controls={`m-pane-${p.key}`}
            className={`m-panebar-item${active === p.key ? ' is-active' : ''}`}
            onClick={() => setActive(p.key)}
          >
            {p.label}
          </button>
        ))}
      </div>

      {panes.map((p) => (
        <div
          key={p.key}
          id={`m-pane-${p.key}`}
          role="tabpanel"
          aria-labelledby={`m-tab-${p.key}`}
          hidden={p.key !== active}
        >
          {p.content}
        </div>
      ))}
    </>
  )
}
