'use client'

import { useState, useEffect, use } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { uploadScreenshots } from '@/lib/screenshots'
import { computeTradeSessions } from '@/lib/tradeSessions'
import { browserOffsetGuess } from '@/lib/timezone'
import { applyTrade } from '@/lib/edgeBeliefs'
import { requestTradeExcursionBackfill } from '@/lib/tradeExcursionClient'
import { toast } from '@/lib/toast'
import { usePageTitle } from '@/lib/usePageTitle'
import TradeForm, { EMPTY_TRADE_FORM } from '@/components/TradeForm'
import ErrorBanner from '@/components/ErrorBanner'

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

  useEffect(() => {
    loadStrategies()
  }, [symbol])

  async function loadStrategies() {
    setStrategiesError(null)
    try {
      const { data: { user } } = await supabase.auth.getUser()
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
      setStrategiesError(`Couldn't load your strategies — ${err.message || 'something went wrong'}. You can still log the trade and assign a strategy later.`)
    }
  }

  async function handleSubmit({ values, screenshots }) {
    const { data: { user } } = await supabase.auth.getUser()

    let screenshot_urls = []
    try {
      screenshot_urls = await uploadScreenshots(screenshots)
    } catch (uploadError) {
      return uploadError.message?.includes('Bucket not found')
        ? 'Screenshot upload failed: the "screenshots" storage bucket doesn\'t exist yet in Supabase. Run the storage setup SQL (storage-setup.sql) or create it manually under Storage, New bucket, name it "screenshots", and make it Public.'
        : 'Screenshot upload failed: ' + uploadError.message
    }

    const timezoneOffset = parseFloat(user.user_metadata?.timezone ?? browserOffsetGuess())
    const { session, continuedSessions } = computeTradeSessions(values, timezoneOffset)

    const { data: inserted, error } = await supabase.from('trades').insert([{
      ...values,
      user_id: user.id,
      instrument_id: instrumentId,
      screenshot_urls,
      screenshot_url: screenshot_urls[0] || null,
      session,
      continued_sessions: continuedSessions,
    }]).select().single()

    if (error) {
      return 'Could not save trade: ' + error.message
    }

    // Best-effort - a belief-tracking hiccup should never block the trader
    // from having successfully saved the trade itself.
    try {
      await applyTrade(supabase, inserted)
    } catch (beliefError) {
      console.error('applyTrade failed:', beliefError)
    }
    requestTradeExcursionBackfill(symbol, inserted.id)

    toast.success('Trade logged.')
    router.push(`/app/${symbol}/log`)
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
    </div>
  )
}
