'use client'

import { useState, useEffect, use } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { uploadScreenshots } from '@/lib/screenshots'
import { computeTradeSessions } from '@/lib/tradeSessions'
import { regimesForDate } from '@/lib/tradeRegimes'
import { invalidateTags } from '@/lib/tagsCache'
import { browserOffsetGuess } from '@/lib/timezone'
import { requestTradeExcursionBackfill } from '@/lib/tradeExcursionClient'
import { toast, queueToastForReturn } from '@/lib/toast'
import { usePageTitle } from '@/lib/usePageTitle'
import { useConfirm } from '@/lib/useConfirm'
import TradeForm from '@/components/TradeForm'
import PageLoading from '@/components/PageLoading'
import PageError from '@/components/PageError'
import ErrorBanner from '@/components/ErrorBanner'

export default function EditTradePage({ params }) {
  usePageTitle('Edit Trade')
  const resolvedParams = use(params)
  const symbol = resolvedParams.instrument
  const tradeId = resolvedParams.tradeId
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [deleteError, setDeleteError] = useState(null)
  const [trade, setTrade] = useState(null)
  const [instrumentId, setInstrumentId] = useState(null)
  const [strategies, setStrategies] = useState([])
  const { confirm, modal: confirmModal } = useConfirm()

  useEffect(() => {
    loadAll()
  }, [tradeId])

  async function loadAll() {
    setLoading(true)
    setError(null)
    try {
      const { data: t, error: tradeError } = await supabase.from('trades').select('*').eq('id', tradeId).single()
      if (tradeError) throw tradeError
      if (!t) { setLoading(false); return }
      setTrade(t)
      setInstrumentId(t.instrument_id)
      await loadStrategies(t.instrument_id)
    } catch {
      setError('something went wrong.')
    } finally {
      setLoading(false)
    }
  }

  async function loadStrategies(forInstrumentId) {
    const { data, error: stratError } = await supabase
      .from('strategies')
      .select('*')
      .eq('instrument_id', forInstrumentId ?? instrumentId)
      .eq('archived', false)
      .order('created_at', { ascending: true })
    if (stratError) throw stratError
    setStrategies(data || [])
  }

  async function handleSubmit({ values, screenshots, existingScreenshots }) {
    let uploaded = []
    try {
      uploaded = await uploadScreenshots(screenshots)
    } catch (uploadError) {
      return uploadError.message?.includes('Bucket not found')
        ? 'Screenshot upload failed: the "screenshots" storage bucket doesn\'t exist yet in Supabase. Run the storage setup SQL (storage-setup.sql) or create it manually under Storage, New bucket, name it "screenshots", and make it Public.'
        : 'Screenshot upload failed. Please try again.'
    }
    const screenshot_urls = [...existingScreenshots, ...uploaded]

    const { data: { user } } = await supabase.auth.getUser()
    const timezoneOffset = parseFloat(user.user_metadata?.timezone ?? browserOffsetGuess())
    const { session, continuedSessions } = computeTradeSessions(values, timezoneOffset)
    // Only recomputed when trade_date actually changed - matching the
    // excursionRelevantChanged gate below, an edit that only touches
    // reasoning/tags/discipline review has no reason to pay for two more
    // Supabase round trips whose answer can't have changed. When the date
    // *did* change: a real result always overwrites whatever was there;
    // null (this new date's session hasn't closed, or the daily job
    // hasn't reached it yet) explicitly clears both columns instead of
    // leaving them out of the update - the trade's OLD regime describes
    // its OLD date and is simply wrong now, not just stale. An edit that
    // leaves trade_date untouched skips this entirely, so a trade that's
    // already correctly bucketed is never touched by an unrelated field
    // edit. See log/new/page.js's comment and lib/tradeRegimes.js's header
    // for the save-time-computation half of this.
    const dateChanged = trade.trade_date !== values.trade_date
    let regimes = {}
    if (dateChanged) {
      regimes = (await regimesForDate(symbol, values.trade_date)) || { volatility_regime: null, volume_regime: null }
    }

    const { data: updated, error } = await supabase.from('trades').update({
      ...values,
      screenshot_urls,
      screenshot_url: screenshot_urls[0] || null,
      session,
      continued_sessions: continuedSessions,
      ...regimes,
    }).eq('id', tradeId).select().single()

    if (error) {
      return 'Could not save trade. Please try again.'
    }

    // Only re-triggers the (Databento-backed) excursion computation when a
    // field it actually depends on changed - an edit that only touches
    // reasoning/tags/discipline review shouldn't cost another API call
    // against a trade whose MFE/MAE/drawdown are already correct.
    // trade_date and trade_time belong here as much as exit_time does: the
    // Databento window MFE/MAE/drawdown are computed over runs from the
    // entry instant to the exit instant, so correcting a mislogged date or
    // entry time moves that window wholesale. Without them, fixing a trade
    // logged on the wrong day left its excursions computed over the old
    // day's prices while market_data_status still read 'complete' - wrong
    // numbers presented as verified, which is worse than none.
    const excursionRelevantChanged =
      trade.direction !== updated.direction ||
      trade.entry !== updated.entry ||
      trade.trade_date !== updated.trade_date ||
      trade.trade_time !== updated.trade_time ||
      trade.exit_time !== updated.exit_time ||
      trade.exit_price !== updated.exit_price ||
      JSON.stringify(trade.additional_exits || []) !== JSON.stringify(updated.additional_exits || [])
    if (excursionRelevantChanged) {
      requestTradeExcursionBackfill(symbol, tradeId)
    }
    invalidateTags()

    // Same as Cancel/Discard changes (onCancel below) - returns to wherever
    // the trader opened this edit from (the trade detail page, the log, a
    // strategy page) rather than always landing on the log. Queued rather
    // than a plain toast.success: see queueToastForReturn's comment - a
    // toast fired right before router.back() can otherwise be silently
    // lost to a back-forward-cache restore of the previous page.
    queueToastForReturn('Trade updated.')
    router.back()
  }

  async function handleDelete() {
    const sure = await confirm({ title: 'Delete Trade', message: 'This action cannot be undone.', confirmLabel: 'Delete trade', danger: true })
    if (!sure) return
    setDeleteError(null)
    const { error } = await supabase.from('trades').delete().eq('id', tradeId)
    if (error) {
      setDeleteError("Couldn't delete this trade. Please try again.")
      return
    }
    invalidateTags()
    toast.success('Trade deleted.')
    router.push(`/app/${symbol}/log`)
  }

  if (loading) return <PageLoading />
  if (error) return <div className="page-container"><PageError message={`Couldn't load this trade — ${error}`} onRetry={() => loadAll()} /></div>
  if (!trade) return <div className="page-container"><div className="empty">Trade not found.</div></div>

  // Trades logged before distances existed only stored absolute prices, so
  // derive the distance from the price when the column is empty.
  const initial = {
    direction: trade.direction,
    strategyId: trade.strategy_id || '',
    reasoning: trade.reasoning || '',
    setup: {
      trade_date: trade.trade_date || '',
      trade_time: trade.trade_time || '',
      entry: trade.entry ?? '',
      target_distance: trade.target_distance ?? (trade.target != null ? Math.abs(trade.target - trade.entry) : ''),
      stop_distance: trade.stop_distance ?? (trade.stop != null ? Math.abs(trade.stop - trade.entry) : ''),
    },
    execution: {
      contracts: trade.contracts ?? '',
      exit_time: trade.exit_time ?? '',
      exit_price: trade.exit_price ?? '',
    },
    additionalExits: (trade.additional_exits || []).map((e) => ({
      exit_time: e.exit_time ?? '',
      exit_price: e.exit_price ?? '',
      contracts: e.contracts ?? '',
    })),
    pnl: trade.pnl ?? null,
    // Read only by inferOutcome, to recognise a trade that was saved as
    // Breakeven - see its own comment for why the exit price alone can't
    // tell that apart from a Custom exit near entry.
    rMultiple: trade.r_multiple ?? null,
    tags: trade.tags || [],
    reviewedNoIssues: trade.reviewed_no_issues ?? false,
    disciplineTags: trade.discipline_tags || [],
    existingScreenshots: trade.screenshot_urls?.length
      ? trade.screenshot_urls
      : (trade.screenshot_url ? [trade.screenshot_url] : []),
  }

  return (
    <div className="page-container content-fade-in">
      <Link href={`/app/${symbol}/log`} className="back-link">Back to log</Link>
      <h1 className="page-title">Edit trade</h1>

      <ErrorBanner message={deleteError} />

      <TradeForm
        symbol={symbol}
        instrumentId={instrumentId}
        strategies={strategies}
        onStrategyAdded={() => loadStrategies()}
        initial={initial}
        submitLabel="Save changes"
        allowDiscard
        onCancel={() => router.back()}
        footerLeft={
          <span className="del" style={{ fontSize: '13px', alignSelf: 'center' }} onClick={handleDelete}>
            Delete this trade
          </span>
        }
        onSubmit={handleSubmit}
      />
      {confirmModal}
    </div>
  )
}
