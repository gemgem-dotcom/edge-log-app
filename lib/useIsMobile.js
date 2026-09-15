'use client'

import { useSyncExternalStore } from 'react'

// The one place the mobile breakpoint is defined.
//
// It is duplicated in exactly one other place - the `@media (max-width:
// 768px)` block in globals.css - and the two MUST agree. They are checked
// against each other by lib/useIsMobile.test.js, which reads the
// stylesheet, because a silent disagreement between them is the worst
// failure this design has: the mobile components would mount while the
// desktop CSS still applied, or vice versa, and the result is a layout
// that exists in neither design.
//
// 768 rather than the 640 the older rules use, because those were
// narrow-desktop patches - "the sidebar is cramped, drop it to one
// column" - and this is a different thing: the width below which the
// DESKTOP UI IS REPLACED rather than adjusted. A 700px-wide phone in
// landscape wants the mobile app, not a squeezed desktop.
export const MOBILE_MAX_WIDTH = 768
export const MOBILE_QUERY = `(max-width: ${MOBILE_MAX_WIDTH}px)`

// Returns true on mobile, false on desktop, and NULL until the first
// client render has happened.
//
// The null matters. There is no viewport during server rendering, so any
// hook that guessed would guess wrong half the time and hydrate into a
// mismatch; and a hook that defaulted to `false` would flash the full
// desktop dashboard at every phone user before swapping.
//
// What callers actually do with null is treat it as "not mobile" and
// render the desktop branch for that one frame. On the desktop side that
// is the whole point - it is what keeps the output identical. On the
// mobile side, be honest about the cost rather than overstating it: at
// phone widths the first paint is the narrow-desktop shell, without the
// tab bar, for a frame before the real answer lands. An earlier version
// of this comment claimed callers render a loading state instead. They do
// not - the pages that show a skeleton show it for their own data, not
// for this.
// matchMedia rather than an innerWidth read plus a resize listener: it
// fires on the transition itself rather than on every pixel of a drag,
// and it is the same primitive the CSS is using, so the two cannot
// disagree about where the boundary is.
function subscribe(onChange) {
  const mql = window.matchMedia(MOBILE_QUERY)
  mql.addEventListener('change', onChange)
  return () => mql.removeEventListener('change', onChange)
}

function getSnapshot() {
  return window.matchMedia(MOBILE_QUERY).matches
}

// The server has no viewport, so it has no answer. Returning null rather
// than guessing is what makes the desktop output identical to what it was
// before any of this existed.
function getServerSnapshot() {
  return null
}

// useSyncExternalStore rather than useState + useEffect, which is what
// this was first written as. Three things improve:
//
//   - It is the subscription primitive React actually provides for an
//     external store, and matchMedia is exactly that.
//   - No setState inside an effect, so no cascading render and no
//     react-hooks/set-state-in-effect warning (this repo's lint budget is
//     a ratchet that must never go up - see CLAUDE.md).
//   - Hydration is handled properly rather than worked around: React
//     renders getServerSnapshot's value while hydrating, then switches to
//     the real one, instead of hydrating a guess and correcting it in an
//     effect a frame later.
export function useIsMobile() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
