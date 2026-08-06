'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabaseClient'
import TradeLogTable from '@/components/TradeLogTable'
import PageLoading from '@/components/PageLoading'

export default function LogPage({ params }) {
  const symbol = params.instrument

const [loading, setLoading] = useState(true)
  const [strategies, setStrategies] = useState([])
  const [trades, setTrades] = useState([])

useEffect(() => {
  loadData()
}, [symbol])

async function loadData() {
  setLoading(true)
  const { data: { user } } = await supabase.auth.getUser()
  const { data: instrument } = await supabase
  .from('instruments').select('*').eq('user_id', user.id).eq('symbol', symbol).single()
  if (!instrument) { setLoading(false); return }

  const { data: stratData } = await supabase
  .from('strategies').select('*').eq('instrument_id', instrument.id).order('created_at', { ascending: true })

  const { data: tradeData } = await supabase
  .from('trades').select('*').eq('instrument_id', instrument.id)
  .order('trade_date', { ascending: false }).order('trade_time', { ascending: false })

  setStrategies(stratData || [])
  setTrades(tradeData || [])
  setLoading(false)
}

if (loading) return <PageLoading />

const strategyName = (id) => strategies.find((s) => s.id === id)?.name || '—'

return (
  <div className="page-container">
  <h1 className="page-title"><span className="page-title-symbol">{symbol}</span> TRADES</h1>
  <p className="page-subtitle">All trades logged for {symbol}, across every strategy.</p>

<div className="panel">
  <TradeLogTable
    trades={trades}
    strategies={strategies}
    strategyNameById={strategyName}
    showStrategyColumn={true}
    showFilters={true}
    symbol={symbol}
  />
  </div>
  </div>
)
}
