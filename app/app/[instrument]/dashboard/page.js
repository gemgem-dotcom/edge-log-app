'use client'

import { useState, useEffect } from 'react'
import { supabase } from '../../../../lib/supabaseClient'
import { strategyColor } from '../../../../lib/strategyColor'

function computeStats(trades) {
  const n = trades.length
  if (n === 0) return { n, winRate: null, avgR: null, expectancy: null, totalPnl: null, profitFactor: null }

  const wins = trades.filter((t) => t.r_multiple > 0)
  const losses = trades.filter((t) => t.r_multiple < 0)
  const winRate = (wins.length / n) * 100
  const totalPnl = trades.reduce((s, t) => s + t.r_multiple, 0)
  const avgR = totalPnl / n
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.r_multiple, 0) / wins.length : 0
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.r_multiple, 0) / losses.length : 0
  const wr = wins.length / n
  const expectancy = wr * avgWin + (1 - wr) * avgLoss

  const grossWin = wins.reduce((s, t) => s + t.r_multiple, 0)
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.r_multiple, 0))
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null)

  return { n, winRate, avgR, expectancy, totalPnl, profitFactor }
}

function fmtR(val) {
  if (val === null || val === undefined) return '—'
  return (val >= 0 ? '+' : '') + val.toFixed(2) + 'R'
}
function fmtPF(val) {
  if (val === null || val === undefined) return '—'
  if (val === Infinity) return '∞'
  return val.toFixed(2)
}
function colorClass(val) {
  if (val === null || val === undefined) return 'neu'
  return val > 0 ? 'pos' : val < 0 ? 'neg' : 'neu'
}

export default function DashboardPage({ params }) {
  const symbol = params.instrument
  const [loading, setLoading] = useState(true)
  const [strategies, setStrategies] = useState([])
  const [tradesByStrategy, setTradesByStrategy] = useState({})
  const [allTrades, setAllTrades] = useState([])

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
      .from('strategies').select('*').eq('instrument_id', instrument.id).eq('archived', false)
      .order('created_at', { ascending: true })

    const { data: tradeData } = await supabase
      .from('trades').select('*').eq('instrument_id', instrument.id)

    const grouped = {}
    for (const s of stratData || []) {
      grouped[s.id] = (tradeData || []).filter((t) => t.strategy_id === s.id)
    }

    setStrategies(stratData || [])
    setTradesByStrategy(grouped)
    setAllTrades(tradeData || [])
    setLoading(false)
  }

  if (loading) return <div className="page-loading">Loading…</div>

  const overall = computeStats(allTrades)

  return (
    <div className="page-container">
      <h1 className="page-title">{symbol} Dashboard</h1>
      <p className="page-subtitle">Your performance overview for {symbol} futures.</p>

      <div className="section-heading">Overview</div>
      <div className="stats stats-6">
        <div className="stat">
          <div className="stat-label">Total trades</div>
          <div className="stat-value neu">{overall.n}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Win rate</div>
          <div className="stat-value neu">{overall.winRate === null ? '—' : overall.winRate.toFixed(1) + '%'}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Avg R</div>
          <div className={`stat-value ${colorClass(overall.avgR)}`}>{fmtR(overall.avgR)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Expectancy</div>
          <div className={`stat-value ${colorClass(overall.expectancy)}`}>{fmtR(overall.expectancy)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Profit factor</div>
          <div className="stat-value neu">{fmtPF(overall.profitFactor)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Total PnL</div>
          <div className={`stat-value ${colorClass(overall.totalPnl)}`}>{fmtR(overall.totalPnl)}</div>
        </div>
      </div>

      <div className="section-heading">Strategy performance</div>
      <div className="panel">
        {strategies.length === 0 ? (
          <div className="empty">No strategies yet for {symbol}. Add one from the Strategies page.</div>
        ) : (
          <table className="perf-table">
            <thead>
              <tr>
                <th>Strategy</th><th>Trades</th><th>Win rate</th><th>Avg R</th>
                <th>Expectancy</th><th>Total PnL</th><th>Profit factor</th>
              </tr>
            </thead>
            <tbody>
              {strategies.map((s, i) => {
                const stats = computeStats(tradesByStrategy[s.id] || [])
                return (
                  <tr
                    key={s.id}
                    className="clickable-row"
                    onClick={() => window.location.href = `/app/${symbol}/strategies/${s.id}`}
                  >
                    <td className="strategy-name-cell">
                      <span className="strategy-dot" style={{ background: strategyColor(i) }} />
                      {s.name}
                    </td>
                    <td>{stats.n}</td>
                    <td className={stats.winRate !== null && stats.winRate < 50 ? 'neg' : ''}>
                      {stats.winRate === null ? '—' : stats.winRate.toFixed(1) + '%'}
                    </td>
                    <td className={colorClass(stats.avgR)}>{fmtR(stats.avgR)}</td>
                    <td className={colorClass(stats.expectancy)}>{fmtR(stats.expectancy)}</td>
                    <td className={colorClass(stats.totalPnl)}>{fmtR(stats.totalPnl)}</td>
                    <td>{fmtPF(stats.profitFactor)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
