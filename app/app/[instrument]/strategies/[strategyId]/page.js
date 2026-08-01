'use client'

import { useState, useEffect } from 'react'
import { supabase } from '../../../../../lib/supabaseClient'
import TradeLogTable from '../../../../../components/TradeLogTable'

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

async function computeStrategyStats(trades) {
  const n = trades.length
  if (n === 0) {
    return { n, winRate: null, avgR: null, expectancy: null, totalPnl: null, avgDuration: null }
  }

  const wins = trades.filter((t) => t.r_multiple > 0)
  const losses = trades.filter((t) => t.r_multiple < 0)
  const totalPnl = trades.reduce((s, t) => s + t.r_multiple, 0)
  const avgR = totalPnl / n
  const winRate = (wins.length / n) * 100
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.r_multiple, 0) / wins.length : 0
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.r_multiple, 0) / losses.length : 0
  const wr = wins.length / n
  const expectancy = wr * avgWin + (1 - wr) * avgLoss

  // Duration: for single-exit trades, use exit_time directly.
  // For multi-exit trades, fetch legs and use the latest leg's time.
  const multiExitTrades = trades.filter((t) => t.multi_exit)
  let legsByTrade = {}
  if (multiExitTrades.length > 0) {
    const { data: legs } = await supabase
      .from('exit_legs')
      .select('*')
      .in('trade_id', multiExitTrades.map((t) => t.id))
    legsByTrade = (legs || []).reduce((acc, leg) => {
      acc[leg.trade_id] = acc[leg.trade_id] || []
      acc[leg.trade_id].push(leg)
      return acc
    }, {})
  }

  const durations = []
  for (const t of trades) {
    let endTime = null
    if (t.multi_exit) {
      const legs = legsByTrade[t.id] || []
      if (legs.length > 0) {
        endTime = legs.reduce((latest, l) => (timeToMinutes(l.exit_time) > timeToMinutes(latest) ? l.exit_time : latest), legs[0].exit_time)
      }
    } else {
      endTime = t.exit_time
    }
    if (endTime) {
      let diff = timeToMinutes(endTime) - timeToMinutes(t.trade_time)
      if (diff < 0) diff += 24 * 60
      durations.push(diff)
    }
  }
  const avgDuration = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null

  return { n, winRate, avgR, expectancy, totalPnl, avgDuration }
}

function fmtR(val) {
  if (val === null || val === undefined) return '—'
  return (val >= 0 ? '+' : '') + val.toFixed(2) + 'R'
}
function colorClass(val) {
  if (val === null || val === undefined) return 'neu'
  return val > 0 ? 'pos' : val < 0 ? 'neg' : 'neu'
}
function fmtDuration(mins) {
  if (mins === null) return '—'
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return `${h}h ${m}m`
}

export default function StrategyDetailPage({ params }) {
  const symbol = params.instrument
  const strategyId = params.strategyId

  const [loading, setLoading] = useState(true)
  const [strategy, setStrategy] = useState(null)
  const [trades, setTrades] = useState([])
  const [stats, setStats] = useState(null)

  useEffect(() => {
    loadData()
  }, [strategyId])

  async function loadData() {
    setLoading(true)
    const { data: s } = await supabase.from('strategies').select('*').eq('id', strategyId).single()
    setStrategy(s)

    const { data: tradeData } = await supabase
      .from('trades')
      .select('*')
      .eq('strategy_id', strategyId)
      .order('trade_date', { ascending: false })
      .order('trade_time', { ascending: false })

    setTrades(tradeData || [])
    const computed = await computeStrategyStats(tradeData || [])
    setStats(computed)
    setLoading(false)
  }

  if (loading) return <div className="page-loading">Loading…</div>
  if (!strategy) return <div className="page-container"><div className="empty">Strategy not found.</div></div>

  return (
    <div className="page-container">
      <h1 className="page-title">{strategy.name}</h1>
      <p className="page-subtitle">{symbol} — strategy performance breakdown</p>

      <div className="section-heading">Performance</div>
      <div className="stats stats-6">
        <div className="stat">
          <div className="stat-label">Total trades</div>
          <div className="stat-value neu">{stats.n}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Win rate</div>
          <div className="stat-value neu">{stats.winRate === null ? '—' : stats.winRate.toFixed(1) + '%'}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Avg R</div>
          <div className={`stat-value ${colorClass(stats.avgR)}`}>{fmtR(stats.avgR)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Expectancy</div>
          <div className={`stat-value ${colorClass(stats.expectancy)}`}>{fmtR(stats.expectancy)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">PnL (R)</div>
          <div className={`stat-value ${colorClass(stats.totalPnl)}`}>{fmtR(stats.totalPnl)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Avg trade duration</div>
          <div className="stat-value neu">{fmtDuration(stats.avgDuration)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Avg MFE</div>
          <div className="stat-value neu stat-placeholder">Needs Phase 2</div>
        </div>
        <div className="stat">
          <div className="stat-label">Avg MAE</div>
          <div className="stat-value neu stat-placeholder">Needs Phase 2</div>
        </div>
      </div>

      <div className="section-heading">Trade log — {strategy.name}</div>
      <div className="panel">
        <TradeLogTable trades={trades} showStrategyColumn={false} />
      </div>
    </div>
  )
}
