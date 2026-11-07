'use client'

import { useState, useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { clearReferenceDataCache } from '@/lib/referenceDataCache'
import { invalidateTags } from '@/lib/tagsCache'
import { UTC_OFFSETS } from '@/lib/timezone'
import { backfillOwnTradeSessions } from '@/lib/tradeSessions'
import PageLoading from '@/components/PageLoading'
import HolidayNotice from '@/components/HolidayNotice'
import TimezoneGate from '@/components/TimezoneGate'
import MobileChrome from '@/components/mobile/MobileChrome'

function hasValidTimezone(user) {
  const tz = user.user_metadata?.timezone
  return tz !== undefined && tz !== null && UTC_OFFSETS.some((o) => o.value === String(tz))
}

export default function AppLayout({ children }) {
  const router = useRouter()
  const pathname = usePathname()
  const [checked, setChecked] = useState(false)
  // Every /app/* route goes through this one layout, so gating here (rather
  // than in app/app/page.js's own onboarding steps) catches an existing
  // account that predates this requirement, on whichever page they land on
  // - trade_date/trade_time need a real saved offset to convert to ET
  // accurately (see lib/tradeSessions.js), and there's no page under here
  // that's meaningful to use before that's set. A brand-new signup (no
  // full_name yet either) is deliberately left to fall through to
  // app/app/page.js instead, which runs its own name -> timezone -> Welcome
  // sequence in that order - gating here unconditionally would show this
  // before the name step every time, the wrong order for a fresh account.
  const [needsTimezone, setNeedsTimezone] = useState(false)

  useEffect(() => {
    let mounted = true

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!mounted) return
      if (!session) {
        router.replace('/login')
      } else {
        setNeedsTimezone(!!session.user.user_metadata?.full_name && !hasValidTimezone(session.user))
        setChecked(true)
      }
    })

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) {
        clearReferenceDataCache()
        invalidateTags()
        router.replace('/login')
      }
    })

    // THE BACK BUTTON AFTER SIGNING OUT.
    //
    // Signing out and pressing Back used to put the app back on
    // screen. Nothing had failed: the browser restored the page from
    // its back/forward cache, which replays the already-rendered DOM
    // without re-running this effect, without a network request, and
    // so without any auth check at all. The session was gone; the
    // pixels were not.
    //
    // proxy.js now sends Cache-Control: no-store on /app, which is
    // what actually keeps the page out of that cache in Chrome and
    // Firefox. This is the belt to that braces - Safari has honoured
    // no-store less consistently, and a restored page showing somebody
    // else's trades is not a thing to leave to one mechanism.
    const onPageShow = (e) => {
      if (!e.persisted) return
      supabase.auth.getSession().then(({ data: { session } }) => {
        if (!session) router.replace('/login')
      })
    }
    window.addEventListener('pageshow', onPageShow)

    return () => {
      mounted = false
      window.removeEventListener('pageshow', onPageShow)
      listener.subscription.unsubscribe()
    }
  }, [router])

  function handleTimezoneSet() {
    setNeedsTimezone(false)
    // The one-time SQL backfill (schema.sql) had no browser to guess an
    // offset from for anyone who'd never set one - now that this trader
    // has, recompute their own trade history for real instead of leaving
    // it on that backfill's UTC+0 default. Not awaited: nothing on screen
    // depends on it finishing.
    backfillOwnTradeSessions()
  }

  if (!checked) {
    return <PageLoading />
  }

  if (needsTimezone) {
    return <TimezoneGate onSet={handleTimezoneSet} />
  }

  return (
    <>
      {pathname !== '/app/account' && <HolidayNotice />}
      {/* The one mobile topbar and tab bar for every screen under /app,
          and the slide between them. This layout is the only thing that
          persists across a tab switch, which is what both of those need -
          see MobileChrome's own header. A no-op on desktop. */}
      <MobileChrome>{children}</MobileChrome>
    </>
  )
}
