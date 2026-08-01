'use client'

import { useState, useEffect } from 'react'
import { supabase } from '../../../../lib/supabaseClient'

function computeStats(trades) {
  const n = trades.length
  if (n === 0) return { n, winRate: '—', avgR: null, expectancy: null, avgTimeInTrade: null }

  const wins = trades.filter((t) => t.r_multiple > 0)
  const losses = trades.filter((t) => t.r_multiple < 0)
  const winRate = ((wins.length / n) * 100).toFixed(1) + '%'
  const avgR = trades.reduce((s, t) => s + t.r_multiple, 0) / n
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.r_multiple, 0) / wins.length : 0
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.r_multiple, 0) / losses.length : 0
  const wr = wins.length / n
  const expectancy = wr * avgWin + (1 - wr) * avgLoss

  // Time in trade, for trades that have an exit_time logged
  const withDuration = trades.filter((t) => t.exit_time)
  let avgTimeInTrade = null
  if (withDuration.length > 0) {
    const totalMinutes = withDuration.reduce((sum, t) => {
      const [eh, em] = t.trade_time.split(':').map(Number)
      const [xh, xm] = t.exit_time.split(':').map(Number)
      let diff = (xh * 60 + xm) - (eh * 60 + em)
      if (diff < 0) diff += 24 * 60 // crossed midnight
      return sum + diff
    }, 0)
    avgTimeInTrade = Math.round(totalMinutes / withDuration.length)
  }

  return { n, winRate, avgR, expectancy, avgTimeInTrade }
}

export default function DashboardPage({ params }) {
  const symbol = params.instrument
  const [loading, setLoading] = useState(true)
  const [strategies, setStrategies] = useState([])
  const [tradesByStrategy, setTradesByStrategy] = useState({})
  const [totalTrades, setTotalTrades] = useState(0)

  useEffect(() => {
    loadData()
  }, [symbol])

  async function loadData() {
    setLoading(true)
    const { data: { user } } = await supabase.auth.getUser()

    const { data: instrument } = await supabase
      .from('instruments')
      .select('*')
      .eq('user_id', user.id)
      .eq('symbol', symbol)
      .single()

    if (!instrument) {
      setLoading(false)
      return
    }

    const { data: stratData } = await supabase
      .from('strategies')
      .select('*')
      .eq('instrument_id', instrument.id)
      .eq('archived', false)
      .order('created_at', { ascending: true })

    const { data: tradeData } = await supabase
      .from('trades')
      .select('*')
      .eq('instrument_id', instrument.id)

    const grouped = {}
    for (const s of stratData || []) {
      grouped[s.id] = (tradeData || []).filter((t) => t.strategy_id === s.id)
    }

    setStrategies(stratData || [])
    setTradesByStrategy(grouped)
    setTotalTrades((tradeData || []).length)
    setLoading(false)
  }

  if (loading) return <div className="page-loading">Loading…</div>

  return (
    <div className="page-container">
      <h1 className="page-title">{symbol} Dashboard</h1>

      <div className="panel">
        <div className="panel-title">Overview</div>
        <div className="stats">
          <div className="stat">
            <div className="stat-label">Total trades logged</div>
            <div className="stat-value neu">{totalTrades}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Strategies tracked</div>
            <div className="stat-value neu">{strategies.length}</div>
          </div>
        </div>
      </div>

      {strategies.length === 0 ? (
        <div className="empty">No strategies yet for {symbol}. Add one on the Strategies page.</div>
      ) : (
        strategies.map((s) => {
          const trades = tradesByStrategy[s.id] || []
          const stats = computeStats(trades)
          return (
            <div className="panel" key={s.id}>
              <div className="panel-title">{s.name}</div>
              <div className="stats">
                <div className="stat">
                  <div className="stat-label">Trades</div>
                  <div className="stat-value neu">{stats.n}</div>
                </div>
                <div className="stat">
                  <div className="stat-label">Win rate</div>
                  <div className="stat-value neu">{stats.winRate}</div>
                </div>
                <div className="stat">
                  <div className="stat-label">Avg R</div>
                  <div className={`stat-value ${stats.avgR > 0 ? 'pos' : stats.avgR < 0 ? 'neg' : 'neu'}`}>
                    {stats.avgR === null ? '—' : (stats.avgR >= 0 ? '+' : '') + stats.avgR.toFixed(2) + 'R'}
                  </div>
                </div>
                <div className="stat">
                  <div className="stat-label">Expectancy</div>
                  <div className={`stat-value ${stats.expectancy > 0 ? 'pos' : stats.expectancy < 0 ? 'neg' : 'neu'}`}>
                    {stats.expectancy === null ? '—' : (stats.expectancy >= 0 ? '+' : '') + stats.expectancy.toFixed(2) + 'R'}
                  </div>
                </div>
                <div className="stat">
                  <div className="stat-label">Avg time in trade</div>
                  <div className="stat-value neu">
                    {stats.avgTimeInTrade === null ? '—' : `${stats.avgTimeInTrade}m`}
                  </div>
                </div>
                <div className="stat">
                  <div className="stat-label">MFE / MAE</div>
                  <div className="stat-value neu" style={{ fontSize: '13px', color: 'var(--muted)' }}>
                    Coming in Phase 2
                  </div>
                </div>
              </div>
              <div className="panel-link-row">
                <a href={`/app/${symbol}/log?strategy=${s.id}`} className="panel-link">View full log →</a>
              </div>
            </div>
          )
        })
      )}
    </div>
  )
}
