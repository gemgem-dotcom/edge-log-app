'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { TrendingUp } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { getInstruments } from '@/lib/referenceDataCache'
import { useIsMobile } from '@/lib/useIsMobile'
import { useStickyTopbar } from '@/lib/useStickyTopbar'
import { readCachedTutorialState } from '@/lib/tutorial'
import InstrumentNav from '@/components/InstrumentNav'
import MobileScopeButton from '@/components/mobile/MobileScopeButton'
import MobileTabBar from '@/components/mobile/MobileTabBar'
import TabTransition from '@/components/mobile/TabTransition'

// Reads the instrument out of /app/<symbol>/..., and null on the three
// screens that have none in view (/app, /app/log, /app/account). The tab
// bar and the scope button both already know what to do with null - see
// lib/mobileTabs.js - so this is the only thing the chrome needs from the
// route.
function symbolFromPath(pathname) {
  const m = /^\/app\/([^/]+)/.exec(pathname || '')
  if (!m) return null
  const first = m[1]
  // Real routes under /app that are not an instrument symbol.
  return ['log', 'account', 'strategies'].includes(first) ? null : first
}

// THE MOBILE CHROME, MOUNTED ONCE FOR EVERY /app ROUTE.
//
// It used to be rendered three times over: once in
// app/app/[instrument]/layout.js, once in components/AppShell.js for the
// instrument-less screens, and a third time inside
// app/app/account/page.js. Three copies of one bar is how they drifted -
// the logo measured 15px on six screens and 16px on Account, because the
// rule that shrinks it is scoped to `.shell` and the account page's bar
// is the one that sits outside `.shell`. A copy cannot disagree with
// itself.
//
// The bigger reason is the slide. React pairs an old and a new screen
// only if the <ViewTransition> boundary survives the commit, so it has to
// sit in a layout that persists - and the chrome has to sit OUTSIDE that
// boundary, or the bars slide with the content. Mounting both here, in
// the one layout every /app route shares, is what satisfies both at once.
// It is also why the bars cannot simply be anchored with a
// view-transition-name instead: that makes an element a backdrop root and
// kills the stacked blur passes the glass is built from.
//
// MOBILE ONLY. On desktop this renders its children and nothing else, and
// the three shells keep their own topbars exactly as they were - those
// bars carry an instrument nav, a clock, a theme toggle and a settings
// link that have no mobile equivalent, so there is no shared bar to be
// had there and no reason to go looking for one.
export default function MobileChrome({ children }) {
  const pathname = usePathname()
  const isMobile = useIsMobile()
  const symbol = symbolFromPath(pathname)
  const [instruments, setInstruments] = useState([])
  // The first-run tutorial anchors the topbar (drops it out of fixed
  // positioning) so it scrolls away with the step it belongs to. That
  // state is owned by the instrument layout; this reads the same
  // sessionStorage cache that layout seeds its own first paint from,
  // rather than lifting the whole tutorial up here.
  // Read during render rather than held in state: the read is sync and
  // fully guarded (see readCachedTutorialState), and starting or
  // finishing the tutorial is always followed by a route change, which
  // re-renders this. Mirroring it into state would mean a setState inside
  // an effect, which this repo's lint budget is at the ceiling of.
  const anchored = readCachedTutorialState()?.status === 'active'
  const { topbarRef, mode, spacerStyle } = useStickyTopbar({ anchored })

  // The band the bottom-tab slide is allowed to paint into: from the
  // topbar's bottom edge to the tab bar's top edge, both as a distance
  // down from the top of the viewport, published to :root for
  // app/globals.css's ::view-transition clip-path.
  //
  // See that file's "Bottom-tab slide" section for why the overlay is
  // clipped at all. Short version: both bars are backdrop-filter glass,
  // and a view transition lifts away the very content they exist to blur,
  // so they have to go on painting as live DOM underneath the overlay
  // rather than be captured into it.
  //
  // Measured here rather than written in CSS because neither edge is
  // expressible there: the tab bar's height is its content's, not
  // --m-tabbar-h, and the topbar's edge collapses to 0 whenever the scroll
  // has hidden it or the tutorial has anchored it into the flow. Both bars
  // are position:fixed, so they only move when `mode` or `anchored`
  // changes - which is exactly when this re-runs - plus on a rotation.
  useEffect(() => {
    if (!isMobile) return undefined
    const root = document.documentElement
    const update = () => {
      const bar = anchored || mode === 'hidden' ? null : document.querySelector('.m-chrome-topbar')
      const tabs = document.querySelector('.m-tabbar')
      // offsetTop/offsetHeight, not getBoundingClientRect: the topbar
      // reveals itself with a transform transition, and this runs on the
      // frame `mode` flips, while the bar is still mid-slide and its rect
      // still off-screen. The offset pair reports the laid-out box and
      // ignores the transform, which is the edge the bar is about to
      // settle on - and "hidden" is read off `mode` instead of the rect.
      const top = bar ? bar.offsetTop + bar.offsetHeight : 0
      const bottom = tabs ? tabs.getBoundingClientRect().top : window.innerHeight
      root.style.setProperty('--m-vt-band-top', `${Math.max(0, Math.ceil(top))}px`)
      root.style.setProperty('--m-vt-band-bottom', `${Math.max(0, Math.floor(bottom))}px`)
    }
    update()
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('resize', update)
      root.style.removeProperty('--m-vt-band-top')
      root.style.removeProperty('--m-vt-band-bottom')
    }
  }, [isMobile, mode, anchored])

  useEffect(() => {
    let cancelled = false
    supabase.auth.getUser().then(({ data }) => {
      if (cancelled || !data?.user) return undefined
      return getInstruments(supabase, data.user.id)
        .then((rows) => { if (!cancelled) setInstruments(rows || []) })
        .catch(() => {})
    }).catch(() => {})
    return () => { cancelled = true }
  }, [pathname])

  // null while useIsMobile has not resolved, false on desktop - both mean
  // "render nothing of your own", and the desktop shells are untouched.
  if (!isMobile) return children

  return (
    <>
      <header
        ref={topbarRef}
        // is-tutorial is the hook the mobile stylesheet reads to square
        // the capsule off and un-hide the instrument nav for onboarding.
        // It used to live on .shell; the bar is outside .shell now, so it
        // travels with the bar itself.
        className={`shell-topbar m-chrome-topbar${anchored ? ' is-tutorial' : ''}${mode === 'hidden' ? ' topbar-hidden' : ''}${mode === 'pinned' ? ' topbar-pinned' : ''}${anchored ? ' topbar-anchored' : ''}`}
      >
        <Link href="/app" className="shell-logo"><TrendingUp size={18} />Edge<span>Log</span></Link>
        {/* Hidden by the mobile stylesheet on every ordinary screen - the
            scope control below replaces it - but it must still be IN the
            DOM, because the first-run tutorial's step 0 spotlights the
            "+ Add instrument" button inside it by MEASURING the element.
            Dropping it hands TutorialOverlay a 0x0 rect and step 0 points
            at nothing. That mistake has shipped three times now; this is
            the comment that was meant to stop the fourth. */}
        <InstrumentNav instruments={instruments} currentSymbol={symbol} />
        <div className="shell-topbar-right">
          {/* Mobile gets ONE control here instead of the desktop's three:
              the clock duplicates the phone's own status bar, the theme
              toggle duplicates Account -> Preferences, and the cog
              duplicates the Account tab. */}
          <MobileScopeButton instruments={instruments} currentSymbol={symbol} />
        </div>
      </header>
      <div className="topbar-spacer" style={spacerStyle} />

      <TabTransition>{children}</TabTransition>

      <MobileTabBar symbol={symbol} instruments={instruments} />
    </>
  )
}
