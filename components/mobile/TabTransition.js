'use client'

import { ViewTransition } from 'react'
import { usePathname } from 'next/navigation'

// The horizontal slide between bottom-tab destinations.
//
// Wraps the CONTENT of a screen, never the chrome. The topbar and the tab
// bar have to stay nailed down while the content moves - a bar that slides
// with the page takes away the fixed reference that tells the eye it was
// the content that moved, not the whole phone. The usual way to anchor
// them is a `view-transition-name`, and that is exactly what must NOT be
// done here: view-transition-name makes an element a containing block and
// its own stacking context, which would break the two stacked pseudo-
// element blur passes the glass bars are built from. Leaving the bars
// outside this wrapper costs nothing and breaks nothing.
//
// `key` is load-bearing, and so is WHERE this is mounted. React pairs an
// old and a new screen only if this boundary survives the commit, so it
// has to sit in a layout that PERSISTS across the navigation, re-keyed on
// the pathname so React treats the two screens as an exit/enter pair
// rather than an in-place update. Pathname and not the full URL on
// purpose: the account screen's drill-downs are ?section= on one path,
// and those are not tab switches.
//
// THAT IS WHY ACCOUNT DOES NOT SLIDE, and the limit is worth stating
// rather than rediscovering. Only /app/[instrument]/* has a persistent
// layout; /app, /app/log, /app/strategies and /app/account each render
// their own AppShell from inside the page, so the whole subtree -
// this boundary with it - unmounts and remounts on every navigation.
// Measured: a wrapper in those pages produces no transition at all, with
// or without a shared `name`; the same wrapper moved into the persistent
// /app layout fires on every one of them. The fix is to hoist the chrome
// into that layout, which is a bigger change than this one; until then
// those routes degrade to the instant swap they already had.
//
// Note for whoever does hoist it: the obvious next step, anchoring the
// bars with a `view-transition-name` the way Next's own guide anchors a
// header, does NOT work here. view-transition-name makes an element a
// backdrop root, which kills the two stacked blur passes the glass bars
// are built from - measured, backdrop sd 24.3 -> 4.3 without it and
// 24.3 -> 24.3 with it. The bars have to be outside the subtree instead.
//
// Every animation here is opt-in per navigation. Only MobileTabBar passes
// a transition type, so desktop navigation, in-page links, the browser's
// own back button and router.refresh() all fall through to `none` and
// behave exactly as they did. A browser with no View Transitions support
// does the same.
const DIRECTIONS = {
  'tab-forward': 'tab-forward',
  'tab-back': 'tab-back',
  default: 'none',
}

export default function TabTransition({ children }) {
  const pathname = usePathname()

  return (
    <ViewTransition key={pathname} enter={DIRECTIONS} exit={DIRECTIONS} default="none">
      {children}
    </ViewTransition>
  )
}
