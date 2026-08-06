'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { uploadScreenshots } from '@/lib/screenshots'
import TradeForm from '@/components/TradeForm'
import PageLoading from '@/components/PageLoading'

export default function EditTradePage({ params }) {
  const symbol = params.instrument
  const tradeId = params.tradeId
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [trade, setTrade] = useState(null)
  const [instrumentId, setInstrumentId] = useState(null)
  const [strategies, setStrategies] = useState([])

  useEffect(() => {
    loadAll()
  }, [tradeId])

  async function loadAll() {
    setLoading(true)
    const { data: t } = await supabase.from('trades').select('*').eq('id', tradeId).single()
    if (!t) { setLoading(false); return }
    setTrade(t)
    setInstrumentId(t.instrument_id)
    await loadStrategies(t.instrument_id)
    setLoading(false)
  }

  async function loadStrategies(forInstrumentId) {
    const { data } = await supabase
      .from('strategies')
      .select('*')
      .eq('instrument_id', forInstrumentId ?? instrumentId)
      .eq('archived', false)
      .order('created_at', { ascending: true })
    setStrategies(data || [])
  }

  async function handleSubmit({ values, screenshots, existingScreenshots }) {
    let uploaded = []
    try {
      uploaded = await uploadScreenshots(screenshots)
    } catch (uploadError) {
      alert('Screenshot upload failed: ' + uploadError.message)
      return false
    }
    const screenshot_urls = [...existingScreenshots, ...uploaded]

    const { error } = await supabase.from('trades').update({
      ...values,
      screenshot_urls,
      screenshot_url: screenshot_urls[0] || null,
    }).eq('id', tradeId)

    if (error) {
      alert('Could not save trade: ' + error.message)
      return false
    }

    router.push(`/app/${symbol}/log`)
  }

  async function handleDelete() {
    if (!confirm('Delete this trade? This cannot be undone.')) return
    await supabase.from('trades').delete().eq('id', tradeId)
    router.push(`/app/${symbol}/log`)
  }

  if (loading) return <PageLoading />
  if (!trade) return <div className="page-container"><div className="empty">Trade not found.</div></div>

  // Trades logged before distances existed only stored absolute prices, so
  // derive the distance from the price when the column is empty.
  const initial = {
    direction: trade.direction,
    strategyId: trade.strategy_id || '',
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
    existingScreenshots: trade.screenshot_urls?.length
      ? trade.screenshot_urls
      : (trade.screenshot_url ? [trade.screenshot_url] : []),
  }

  return (
    <div className="page-container">
      <a href={`/app/${symbol}/log`} className="back-link">Back to log</a>
      <h1 className="page-title">{symbol} — Edit Trade</h1>

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
    </div>
  )
}
