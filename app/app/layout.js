'use client'

import { useState, useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { clearReferenceDataCache } from '@/lib/referenceDataCache'
import { UTC_OFFSETS } from '@/lib/timezone'
import { backfillOwnTradeSessions } from '@/lib/tradeSessions'
import { backfillTradeRegimes } from '@/lib/tradeRegimes'
import PageLoading from '@/components/PageLoading'
import HolidayNotice from '@/components/HolidayNotice'
import TimezoneGate from '@/components/TimezoneGate'

function hasValidTimezone(user) {
  const tz = user.user_metadata?.timezone
  return tz !== undefined && tz !== null && UTC_OFFSETS.some((o) => o.value === String(tz))
}

export default function AppLayout({ children }) {
  const router = useRouter()
  const pathname = usePathname()
  const [checked, setChecked] = useState(false)
  // Every /app/* route goes through this one layout, so gating here (rather
  // than in app/app/page.js's own onboarding steps) catches both a brand
  // new signup and an existing account that predates this requirement -
  // trade_date/trade_time need a real saved offset to convert to ET
  // accurately (see lib/tradeSessions.js), and there's no page under here
  // that's meaningful to use before that's set.
  const [needsTimezone, setNeedsTimezone] = useState(false)

  useEffect(() => {
    let mounted = true

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!mounted) return
      if (!session) {
        router.replace('/login')
      } else {
        setNeedsTimezone(!hasValidTimezone(session.user))
        setChecked(true)
        // Fire-and-forget, once per app-shell mount - unlike
        // backfillOwnTradeSessions below (a one-time catch-up triggered by
        // setting a timezone), new market_session_stats rows land every
        // trading day, so this needs to run on a normal cadence rather than
        // only once ever. Doesn't depend on timezone being set.
        backfillTradeRegimes()
      }
    })

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) {
        clearReferenceDataCache()
        router.replace('/login')
      }
    })

    return () => {
      mounted = false
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
      {children}
    </>
  )
}
