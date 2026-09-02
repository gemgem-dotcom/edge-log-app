'use client'

import { useState, useEffect, use } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { uploadScreenshots } from '@/lib/screenshots'
import { computeTradeSessions } from '@/lib/tradeSessions'
import { regimesForDate } from '@/lib/tradeRegimes'
import { catalogEntryFor } from '@/lib/instrumentCatalog'
import { invalidateTags } from '@/lib/tagsCache'
import { readTutorialState, completeTutorial, queueClosingScreen, cacheTutorialState, readCachedTutorialState } from '@/lib/tutorial'
import { browserOffsetGuess } from '@/lib/timezone'
import { requestTradeExcursionBackfill } from '@/lib/tradeExcursionClient'
import { toast } from '@/lib/toast'
import { usePageTitle } from '@/lib/usePageTitle'
import TradeForm, { EMPTY_TRADE_FORM } from '@/components/TradeForm'
import ErrorBanner from '@/components/ErrorBanner'
import TutorialScrollGuide from '@/components/TutorialScrollGuide'

export default function NewTradePage({ params, searchParams }) {
  usePageTitle('Log New Trade')
  const symbol = use(params).instrument
  const router = useRouter()
  // Arriving from a strategy's own page (its "Log new trade" button)
  // preselects that strategy instead of auto-selecting the first one -
  // the trader already told us which strategy this trade belongs to just
  // by where they clicked from.
  const preselectedStrategyId = use(searchParams)?.strategy || null

  const [instrumentId, setInstrumentId] = useState(null)
  const [strategies, setStrategies] = useState([])
  const [strategiesError, setStrategiesError] = useState(null)
  // Tutorial step 3 (tutorial_step === 2) lands here after adding a
  // strategy - read fresh on every mount alongside the rest of this page's
  // own data load, same as app/app/[instrument]/layout.js does for its own
  // copy of this state, rather than shared via props/context.
  //
  // Seeded from the sessionStorage cache rather than the hardcoded default:
  // this page fully remounts on the dashboard -> log/new navigation that
  // enters step 3, and without this the spotlight only appeared once this
  // component's own supabase.auth.getUser() call resolved - a beat of the
  // full, unblocked, undimmed form on every single transition into this
  // step. See cacheTutorialState's own comment in lib/tutorial.js.
  const [tutorial, setTutorial] = useState(readCachedTutorialState)

  useEffect(() => {
    loadStrategies()
  }, [symbol])

  async function loadStrategies() {
    setStrategiesError(null)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const freshTutorial = readTutorialState(user)
      setTutorial(freshTutorial)
      cacheTutorialState(freshTutorial)
      const { data: instrument } = await supabase
        .from('instruments')
        .select('*')
        .eq('user_id', user.id)
        .eq('symbol', symbol)
        .eq('archived', false)
        .single()
      if (!instrument) return
      setInstrumentId(instrument.id)

      const { data, error } = await supabase
        .from('strategies')
        .select('*')
        .eq('instrument_id', instrument.id)
        .eq('archived', false)
        .order('created_at', { ascending: true })
      if (error) throw error
      setStrategies(data || [])
    } catch (err) {
      setStrategiesError("Couldn't load your strategies — something went wrong. You can still log the trade and assign a strategy later.")
    }
  }

  async function handleSubmit({ values, screenshots }) {
    // Genuinely impossible to log a trade during tutorial step 3, not just
    // impractical - TutorialScrollGuide's tap-catcher only stops pointer
    // events, so this is the guard that also stops a native Enter-key
    // submit from a form field, regardless of scroll position.
    if (tutorial.status === 'active' && tutorial.step === 2) {
      return "You're previewing the form as part of setup - real trades can be logged once the tutorial finishes."
    }

    const { data: { user } } = await supabase.auth.getUser()

    let screenshot_urls = []
    try {
      screenshot_urls = await uploadScreenshots(screenshots)
    } catch (uploadError) {
      return uploadError.message?.includes('Bucket not found')
        ? 'Screenshot upload failed: the "screenshots" storage bucket doesn\'t exist yet in Supabase. Run the storage setup SQL (storage-setup.sql) or create it manually under Storage, New bucket, name it "screenshots", and make it Public.'
        : 'Screenshot upload failed. Please try again.'
    }

    const timezoneOffset = parseFloat(user.user_metadata?.timezone ?? browserOffsetGuess())
    const { session, continuedSessions } = computeTradeSessions(values, timezoneOffset)
    // Only resolves to real values when this date's session has already
    // closed and the daily job has picked it up - null otherwise, in which
    // case the two columns are just left out below rather than written as
    // null (scripts/fetch-daily-market-stats.js backfills them in bulk once
    // the session does close - see lib/tradeRegimes.js's header comment).
    const regimes = catalogEntryFor(symbol)?.data_symbol === 'NQ' ? await regimesForDate(values.trade_date) : null

    const { data: inserted, error } = await supabase.from('trades').insert([{
      ...values,
      user_id: user.id,
      instrument_id: instrumentId,
      screenshot_urls,
      screenshot_url: screenshot_urls[0] || null,
      session,
      continued_sessions: continuedSessions,
      ...regimes,
    }]).select().single()

    if (error) {
      return 'Could not save trade. Please try again.'
    }

    requestTradeExcursionBackfill(symbol, inserted.id)
    invalidateTags()

    toast.success('Trade logged.')
    router.push(`/app/${symbol}/log`)
  }

  // TutorialScrollGuide's tap-to-continue handler - marks the tutorial done
  // (same mechanism steps 1/2 use) and sends the user to the Overview page,
  // which shows the closing screen for ?onboarded=1 (see app/app/page.js).
  async function handleTutorialStep3Complete() {
    await completeTutorial()
    queueClosingScreen()
    router.push('/app')
  }

  return (
    <div className="page-container">
      <Link href={`/app/${symbol}/log`} className="back-link">Back to log</Link>
      <h1 className="page-title">Log new trade</h1>

      <ErrorBanner message={strategiesError} />

      <TradeForm
        key={`${symbol}-${preselectedStrategyId ?? 'none'}`}
        symbol={symbol}
        instrumentId={instrumentId}
        strategies={strategies}
        onStrategyAdded={loadStrategies}
        initial={preselectedStrategyId ? { ...EMPTY_TRADE_FORM, strategyId: preselectedStrategyId } : undefined}
        autoSelectFirstStrategy={!preselectedStrategyId}
        showEmptyStrategyMessage
        submitLabel="Log trade"
        onSubmit={handleSubmit}
      />

      {tutorial.status === 'active' && tutorial.step === 2 && (
        <TutorialScrollGuide onComplete={handleTutorialStep3Complete} />
      )}
    </div>
  )
}
