'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { MoreVertical } from 'lucide-react'
import { supabase } from '../../../../../lib/supabaseClient'
import TradeLogTable from '../../../../../components/TradeLogTable'

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

function resultOf(t) {
  if (t.r_multiple > 0) return 'win'
  if (t.r_multiple < 0) return 'loss'
  return 'breakeven'
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
  const router = useRouter()

const [loading, setLoading] = useState(true)
  const [strategy, setStrategy] = useState(null)
  const [trades, setTrades] = useState([])
  const [stats, setStats] = useState(null)

const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [savingRename, setSavingRename] = useState(false)
  const [deleting, setDeleting] = useState(false)

const [filterDirection, setFilterDirection] = useState('all')
  const [filterResult, setFilterResult] = useState('all')
  const [filterDay, setFilterDay] = useState('all')

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

function openRename() {
  setRenameValue(strategy.name)
  setRenaming(true)
  setMenuOpen(false)
}

async function handleRename(e) {
  e.preventDefault()
  if (!renameValue.trim()) return
  setSavingRename(true)
  const { error } = await supabase.from('strategies').update({ name: renameValue.trim() }).eq('id', strategyId)
  if (!error) {
    setStrategy((prev) => ({ ...prev, name: renameValue.trim() }))
    setRenaming(false)
  } else {
    alert(error.message)
  }
  setSavingRename(false)
}

async function handleDeleteStrategy() {
  setMenuOpen(false)
  const ok = confirm(
    `Delete "${strategy.name}"? Trades logged under this strategy will NOT be deleted — they'll be reclassified as Unclassified in the trade log and won't count toward any stats until reassigned to a strategy. This cannot be undone.`
    )
  if (!ok) return
  setDeleting(true)
  await supabase.from('trades').update({ strategy_id: null }).eq('strategy_id', strategyId)
  const { error } = await supabase.from('strategies').delete().eq('id', strategyId)
  if (error) {
    alert(error.message)
    setDeleting(false)
    return
  }
  window.location.href = `/app/${symbol}/dashboard`
}

if (loading) return <div className="page-loading">Loading…</div>
  if (!strategy) return <div className="page-container"><div className="empty">Strategy not found.</div></div>

    const visible = trades.filter((t) => {
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
  <div className="strategy-header-row">
  <h1 className="page-title" style={{ marginBottom: 0 }}>{strategy.name}</h1>
<div className="strategy-menu-wrap">
  <div className="strategy-menu-btn" onClick={() => setMenuOpen(!menuOpen)}>
<MoreVertical size={17} />
  </div>
{menuOpen && (
  <div className="strategy-menu-dropdown">
  <div className="strategy-menu-item" onClick={openRename}>Rename strategy</div>
 <div className="strategy-menu-item strategy-menu-item-danger" onClick={handleDeleteStrategy}>
{deleting ? 'Deleting…' : 'Delete strategy'}
</div>
  </div>
)}
</div>
  </div>

{renaming && (
  <form onSubmit={handleRename} className="strategy-rename-form">
  <input
 type="text"
 value={renameValue}
 autoFocus
 onChange={(e) => setRenameValue(e.target.value)}
 />
   <button type="submit" disabled={savingRename}>{savingRename ? 'Saving…' : 'Save'}</button>
<span className="del" onClick={() => setRenaming(false)}>cancel</span>
  </form>
)}

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
<div className="filter-bar">
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
  <TradeLogTable trades={visible} showStrategyColumn={false} showDurationColumn={true} symbol={symbol} />
  </div>
  </div>
)
}
