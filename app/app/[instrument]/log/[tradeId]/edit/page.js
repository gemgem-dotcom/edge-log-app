'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { uploadScreenshots } from '@/lib/screenshots'
import { toast } from '@/lib/toast'
import { usePageTitle } from '@/lib/usePageTitle'
import { useConfirm } from '@/lib/useConfirm'
import TradeForm from '@/components/TradeForm'
import PageLoading from '@/components/PageLoading'
import PageError from '@/components/PageError'
import ErrorBanner from '@/components/ErrorBanner'

export default function EditTradePage({ params }) {
  usePageTitle('Edit Trade')
  const symbol = params.instrument
  const tradeId = params.tradeId
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
    } catch (err) {
      setError(err.message || "Couldn't load this trade — something went wrong.")
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
      return 'Screenshot upload failed: ' + uploadError.message
    }
    const screenshot_urls = [...existingScreenshots, ...uploaded]

    const { error } = await supabase.from('trades').update({
      ...values,
      screenshot_urls,
      screenshot_url: screenshot_urls[0] || null,
    }).eq('id', tradeId)

    if (error) {
      return 'Could not save trade: ' + error.message
    }

    toast.success('Trade updated.')
    router.push(`/app/${symbol}/log`)
  }

  async function handleDelete() {
    const sure = await confirm({ title: 'Delete Trade', message: 'This action cannot be undone.', confirmLabel: 'Delete trade', danger: true })
    if (!sure) return
    setDeleteError(null)
    const { error } = await supabase.from('trades').delete().eq('id', tradeId)
    if (error) {
      setDeleteError(`Couldn't delete this trade — ${error.message}`)
      return
    }
    toast.success('Trade deleted.')
    router.push(`/app/${symbol}/log`)
  }

  if (loading) return <PageLoading />
  if (error) return <div className="page-container"><PageError message={`Couldn't load this trade — ${error}`} onRetry={loadAll} /></div>
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
    pnl: trade.pnl ?? null,
    tags: trade.tags || [],
    mistakeTags: trade.mistake_tags || [],
    existingScreenshots: trade.screenshot_urls?.length
      ? trade.screenshot_urls
      : (trade.screenshot_url ? [trade.screenshot_url] : []),
  }

  return (
    <div className="page-container">
      <a href={`/app/${symbol}/log`} className="back-link">Back to log</a>
      <h1 className="page-title">EDIT TRADE</h1>

      <ErrorBanner message={deleteError} />

      <TradeForm
        symbol={symbol}
        instrumentId={instrumentId}
        strategies={strategies}
        onStrategyAdded={() => loadStrategies()}
        initial={initial}
        submitLabel="Save changes"
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
