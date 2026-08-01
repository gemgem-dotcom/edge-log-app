'use client'

import { useState, useEffect } from 'react'
import { supabase } from '../../../../lib/supabaseClient'
import TradeLogTable from '../../../../components/TradeLogTable'

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function resultOf(t) {
  if (t.r_multiple > 0) return 'win'
  if (t.r_multiple < 0) return 'loss'
  return 'breakeven'
}

export default function LogPage({ params }) {
  const symbol = params.instrument

  const [loading, setLoading] = useState(true)
  const [strategies, setStrategies] = useState([])
  const [trades, setTrades] = useState([])

  const [filterStrategy, setFilterStrategy] = useState('all')
  const [filterDirection, setFilterDirection] = useState('all')
  const [filterResult, setFilterResult] = useState('all')
  const [filterDay, setFilterDay] = useState('all')

  useEffect(() => {
    loadData()
  }, [symbol])

  useEffect(() => {
    // Support deep links like /log?strategy=<id> from the dashboard table
    const urlParams = new URLSearchParams(window.location.search)
    const initial = urlParams.get('strategy')
    if (initial) setFilterStrategy(initial)
  }, [])

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

  if (loading) return <div className="page-loading">Loading…</div>

  const strategyName = (id) => strategies.find((s) => s.id === id)?.name || '—'

  const visible = trades.filter((t) => {
    if (filterStrategy !== 'all' && t.strategy_id !== filterStrategy) return false
    if (filterDirection !== 'all' && t.direction !== filterDirection) return false
    if (filterResult !== 'all' && resultOf(t) !== filterResult) return false
    if (filterDay !== 'all') {
      const day = new Date(t.trade_date + 'T00:00:00').getDay()
      if (DAYS[day] !== filterDay) return false
    }
    return true
  })

  return (
    <div className="page-container">
      <h1 className="page-title">{symbol} — Trades</h1>
      <p className="page-subtitle">All trades logged for {symbol}, across every strategy.</p>

      <div className="filter-bar">
        <select value={filterStrategy} onChange={(e) => setFilterStrategy(e.target.value)}>
          <option value="all">All strategies</option>
          {strategies.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select value={filterDirection} onChange={(e) => setFilterDirection(e.target.value)}>
          <option value="all">All directions</option>
          <option value="long">Long</option>
          <option value="short">Short</option>
        </select>
        <select value={filterResult} onChange={(e) => setFilterResult(e.target.value)}>
          <option value="all">All results</option>
          <option value="win">Win</option>
          <option value="loss">Loss</option>
          <option value="breakeven">Breakeven</option>
        </select>
        <select value={filterDay} onChange={(e) => setFilterDay(e.target.value)}>
          <option value="all">All days</option>
          {DAYS.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <span className="filter-count">{visible.length} of {trades.length} trades</span>
      </div>

      <div className="panel">
        <TradeLogTable trades={visible} strategyNameById={strategyName} showStrategyColumn={true} />
      </div>
    </div>
  )
}
