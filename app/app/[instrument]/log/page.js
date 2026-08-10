'use client'

import { useState, useEffect } from 'react'
import { Plus } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { catalogEntryFor } from '@/lib/instrumentCatalog'
import { usePageTitle } from '@/lib/usePageTitle'
import TradeLogTable from '@/components/TradeLogTable'
import TradeLogSkeleton from '@/components/TradeLogSkeleton'
import EmptyState from '@/components/EmptyState'
import PageError from '@/components/PageError'

export default function LogPage({ params }) {
  usePageTitle('Trade Log')
  const symbol = params.instrument
  const displayName = catalogEntryFor(symbol)?.display_name || symbol

const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [strategies, setStrategies] = useState([])
  const [trades, setTrades] = useState([])

useEffect(() => {
  loadData()
}, [symbol])

async function loadData() {
  setLoading(true)
  setError(null)
  try {
    const { data: { user } } = await supabase.auth.getUser()
    const { data: instrument } = await supabase
    .from('instruments').select('*').eq('user_id', user.id).eq('symbol', symbol).single()
    if (!instrument) { setLoading(false); return }

    const { data: stratData, error: stratError } = await supabase
    .from('strategies').select('*').eq('instrument_id', instrument.id).order('created_at', { ascending: true })
    if (stratError) throw stratError

    const { data: tradeData, error: tradeError } = await supabase
    .from('trades').select('*').eq('instrument_id', instrument.id)
    .order('trade_date', { ascending: false }).order('trade_time', { ascending: false })
    if (tradeError) throw tradeError

    setStrategies(stratData || [])
    setTrades(tradeData || [])
  } catch (err) {
    setError(err.message || "Couldn't load your trades — something went wrong.")
  } finally {
    setLoading(false)
  }
}

if (loading) return <TradeLogSkeleton />
if (error) return <div className="page-container"><PageError message={`Couldn't load your trades — ${error}`} onRetry={loadData} /></div>

const strategyName = (id) => strategies.find((s) => s.id === id)?.name || '—'

return (
  <div className="page-container">
  <div className="page-header-row">
    <h1 className="page-title">TRADE LOG</h1>
    <a href={`/app/${symbol}/log/new`} className="new-trade-btn"><Plus size={16} /> Log new trade</a>
  </div>
  <p className="page-subtitle">All trades logged for {displayName}, across every strategy.</p>

<div className="panel">
  <TradeLogTable
    trades={trades}
    strategies={strategies}
    strategyNameById={strategyName}
    showStrategyColumn={true}
    showFilters={true}
    symbol={symbol}
    emptyState={
      <EmptyState
        title="No trades yet"
        message={`No trades logged yet for ${displayName}. Log your first one to start tracking your stats.`}
        actionHref={`/app/${symbol}/log/new`}
        actionLabel="Log new trade"
      />
    }
  />
  </div>
  </div>
)
}
