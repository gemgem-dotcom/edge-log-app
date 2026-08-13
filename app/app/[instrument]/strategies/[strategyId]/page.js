'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { MoreVertical, Plus } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { hasResult, tradeDurationMinutes, formatDuration } from '@/lib/tradeMath'
import { useClickOutside } from '@/lib/useClickOutside'
import { toast } from '@/lib/toast'
import { usePageTitle } from '@/lib/usePageTitle'
import { computeStreak } from '@/lib/streak'
import { mockVolatility } from '@/lib/marketContextMock'
import TradeLogTable from '@/components/TradeLogTable'
import StreakBadge from '@/components/StreakBadge'
import MarketStatusPill from '@/components/MarketStatusPill'
import StrategyDetailSkeleton from '@/components/StrategyDetailSkeleton'
import PageError from '@/components/PageError'
import EmptyState from '@/components/EmptyState'
import ErrorBanner from '@/components/ErrorBanner'

function hasDollar(t) {
  return t.pnl !== null && t.pnl !== undefined
}

async function computeStrategyStats(allTrades) {
  // Duration is measured over every trade that has an exit time, but the R
  // stats only make sense for trades that actually have a result.
  const trades = allTrades.filter(hasResult)
  const n = trades.length
  if (n === 0) {
    return {
      n, winRate: null, expectancy: null, expectancyD: null, totalPnl: null, totalD: null,
      hasD: false, profitFactor: null, avgDuration: computeAvgDuration(allTrades),
    }
  }

const wins = trades.filter((t) => t.r_multiple > 0)
  const losses = trades.filter((t) => t.r_multiple < 0)
  const totalPnl = trades.reduce((s, t) => s + t.r_multiple, 0)
  // Breakeven trades don't count as a win or a loss, so they're excluded
  // from the denominator here rather than diluting the rate - wr below
  // (which feeds expectancy, not the displayed win rate) is unrelated and
  // deliberately left as wins/n.
  const winRate = (wins.length + losses.length) > 0 ? (wins.length / (wins.length + losses.length)) * 100 : null
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.r_multiple, 0) / wins.length : 0
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.r_multiple, 0) / losses.length : 0
  const wr = wins.length / n
  const expectancy = wr * avgWin + (1 - wr) * avgLoss

const grossWin = wins.reduce((s, t) => s + t.r_multiple, 0)
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.r_multiple, 0))
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null)

const withD = trades.filter(hasDollar)
  const hasD = withD.length > 0
  const totalD = hasD ? withD.reduce((s, t) => s + t.pnl, 0) : null
  const winsD = wins.filter(hasDollar)
  const lossesD = losses.filter(hasDollar)
  const avgWinD = winsD.length ? winsD.reduce((s, t) => s + t.pnl, 0) / winsD.length : 0
  const avgLossD = lossesD.length ? lossesD.reduce((s, t) => s + t.pnl, 0) / lossesD.length : 0
  const expectancyD = hasD ? wr * avgWinD + (1 - wr) * avgLossD : null

return { n, winRate, expectancy, expectancyD, totalPnl, totalD, hasD, profitFactor, avgDuration: computeAvgDuration(allTrades) }
}

function computeAvgDuration(trades) {
  const durations = trades.map(tradeDurationMinutes).filter((d) => d !== null)
  return durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null
}

function fmtR(val) {
  if (val === null || val === undefined) return '—'
  return (val >= 0 ? '+' : '') + val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + 'R'
}
function fmtD(val) {
  if (val === null || val === undefined) return '—'
  return (val >= 0 ? '+$' : '-$') + Math.abs(val).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function fmtPF(val) {
  if (val === null || val === undefined) return '—'
  if (val === Infinity) return '∞'
  return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function colorClass(val) {
  if (val === null || val === undefined) return 'neu'
  return val > 0 ? 'pos' : val < 0 ? 'neg' : 'neu'
}
export default function StrategyDetailPage({ params }) {
  const symbol = params.instrument
  const strategyId = params.strategyId
  const router = useRouter()

const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [formError, setFormError] = useState(null)
  const [strategy, setStrategy] = useState(null)
  const [trades, setTrades] = useState([])
  const [stats, setStats] = useState(null)
  usePageTitle(strategy ? strategy.name : 'Strategy')

const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useClickOutside(menuOpen, useCallback(() => setMenuOpen(false), []))
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [savingRename, setSavingRename] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showDeleteModal, setShowDeleteModal] = useState(false)

useEffect(() => {
  loadData()
}, [strategyId])

async function loadData() {
  setLoading(true)
  setError(null)
  try {
    const { data: s, error: stratError } = await supabase.from('strategies').select('*').eq('id', strategyId).single()
    if (stratError) throw stratError
    setStrategy(s)

    const { data: tradeData, error: tradeError } = await supabase
    .from('trades')
    .select('*')
    .eq('strategy_id', strategyId)
    .order('trade_date', { ascending: false })
    .order('trade_time', { ascending: false })
    if (tradeError) throw tradeError

    setTrades(tradeData || [])
    const computed = await computeStrategyStats(tradeData || [])
    setStats(computed)
  } catch (err) {
    setError(err.message || "Couldn't load this strategy — something went wrong.")
  } finally {
    setLoading(false)
  }
}

function openRename() {
  setRenameValue(strategy.name)
  setRenaming(true)
  setMenuOpen(false)
}

async function handleRename(e) {
  e.preventDefault()
  if (!renameValue.trim()) return
  setFormError(null)
  setSavingRename(true)
  const { error } = await supabase.from('strategies').update({ name: renameValue.trim() }).eq('id', strategyId)
  if (!error) {
    setStrategy((prev) => ({ ...prev, name: renameValue.trim() }))
    setRenaming(false)
    toast.success('Strategy renamed.')
  } else {
    setFormError(error.message)
  }
  setSavingRename(false)
}

async function handleDeleteStrategy() {
  setFormError(null)
  setDeleting(true)
  await supabase.from('trades').update({ strategy_id: null }).eq('strategy_id', strategyId)
  const { error } = await supabase.from('strategies').delete().eq('id', strategyId)
  if (error) {
    setFormError(error.message)
    setDeleting(false)
    setShowDeleteModal(false)
    return
  }
  toast.success('Strategy deleted.')
  router.push(`/app/${symbol}/dashboard`)
}

if (loading) return <StrategyDetailSkeleton />
if (error) return <div className="page-container"><PageError message={`Couldn't load this strategy — ${error}`} onRetry={loadData} /></div>
  if (!strategy) return <div className="page-container"><div className="empty">Strategy not found.</div></div>

const streak = computeStreak(trades)
  const volatility = mockVolatility(symbol)

return (
  <div className="page-container">
  <ErrorBanner message={formError} />
  <div className="strategy-header-row">
  <h1 className="page-title" style={{ marginBottom: 0 }}>{strategy.name}</h1>
<div className="strategy-menu-wrap" ref={menuRef}>
  <div className="strategy-menu-btn" onClick={() => setMenuOpen(!menuOpen)}>
<MoreVertical size={17} />
  </div>
{menuOpen && (
  <div className="strategy-menu-dropdown">
  <div className="strategy-menu-item" onClick={openRename}>Rename strategy</div>
 <div className="strategy-menu-item strategy-menu-item-danger" onClick={() => { setMenuOpen(false); setShowDeleteModal(true) }}>
Delete strategy
</div>
  </div>
)}
</div>
<a href={`/app/${symbol}/log/new`} className="new-trade-btn"><Plus size={16} /> Log new trade</a>
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
<span className="del" onClick={() => setRenaming(false)}>Cancel</span>
  </form>
)}

<div className="page-subtitle-row">
  <p className="page-subtitle">See how your strategy has performed.</p>
  <div className="header-action-group">
    <MarketStatusPill />
    <StreakBadge
      streak={streak}
      winLabel={(n) => `${n} win${n === 1 ? '' : 's'} in a row on this strategy`}
      lossLabel={(n) => `${n} loss${n === 1 ? '' : 'es'} in a row on this strategy`}
    />
  </div>
</div>

<div className="section-heading">Performance</div>
<div className="stats strategy-perf-stats">
<div className="stat">
  <div className="stat-label">Total P&amp;L</div>
<div className={`stat-value ${colorClass(stats.hasD ? stats.totalD : stats.totalPnl)}`}>
{stats.hasD ? fmtD(stats.totalD) : fmtR(stats.totalPnl)}
</div>
{stats.hasD && (
  <div className={`stat-subvalue ${colorClass(stats.totalPnl)}`}>{fmtR(stats.totalPnl)}</div>
)}
  </div>
<div className="stat">
  <div className="stat-label">Expectancy</div>
<div className={`stat-value ${colorClass(stats.expectancyD !== null ? stats.expectancyD : stats.expectancy)}`}>
{stats.expectancyD !== null ? fmtD(stats.expectancyD) : fmtR(stats.expectancy)}
</div>
{stats.expectancyD !== null && (
  <div className={`stat-subvalue ${colorClass(stats.expectancy)}`}>{fmtR(stats.expectancy)}</div>
)}
  </div>
<div className="stat">
  <div className="stat-label">Profit factor</div>
<div className="stat-value neu">{fmtPF(stats.profitFactor)}</div>
  </div>
  <div className="stat">
  <div className="stat-label">Win rate</div>
<div className="stat-value neu">{stats.winRate === null ? '—' : stats.winRate.toFixed(1) + '%'}</div>
  </div>
  <div className="stat">
  <div className="stat-label">Total trades</div>
<div className="stat-value neu">{stats.n.toLocaleString('en-US')}</div>
  </div>
<div className="stat">
  <div className="stat-label">Avg trade duration</div>
<div className="stat-value neu">{formatDuration(stats.avgDuration)}</div>
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

<div className="section-heading">At a glance</div>
<div className="strategy-glance-row">
  <div className="panel">
    <div className="stat-label dashboard-card-title">Trades around today&apos;s events?</div>
    {/* Mock only - a real version should check this strategy's name/tags
        against today's economic-calendar events instead of a fixed line. */}
    <p className="strategy-context-text">This strategy often trades around scheduled Fed events — one lands today at 10:00.</p>
  </div>
  <div className="panel">
    <div className="stat-label dashboard-card-title">Volatility context</div>
    {/* Mock only - the 1.2-1.8x "typical" range is a placeholder, not
        computed from this strategy's own trade history yet. */}
    <p className="strategy-context-text">This strategy typically performs best around 1.2–1.8x normal volatility. Today is {volatility.multiplier}x.</p>
  </div>
</div>

<div className="section-heading">Trade log — {strategy.name}</div>
<div className="panel">
  <TradeLogTable
    trades={trades}
    showStrategyColumn={false}
    showFilters={true}
    symbol={symbol}
    emptyState={
      <EmptyState
        title="No trades yet"
        message={`No trades have been logged against "${strategy.name}" yet.`}
        actionHref={`/app/${symbol}/log/new`}
        actionLabel="Log new trade"
      />
    }
  />
  </div>

{showDeleteModal && (
  <div className="confirm-modal-overlay" onClick={() => setShowDeleteModal(false)}>
  <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
  <h2>Delete &quot;{strategy.name}&quot;?</h2>
  <p>This will remove the strategy only. Any trades assigned to it will be reclassified as Unassigned and won&apos;t contribute to your statistics until reassigned to a strategy.</p>
  <div className="submit-row">
  <button type="button" className="btn-accent-outline" onClick={() => setShowDeleteModal(false)}>Cancel</button>
  <button type="button" className="btn-danger-outline" onClick={handleDeleteStrategy} disabled={deleting}>
{deleting ? 'Deleting…' : 'Delete strategy'}
</button>
  </div>
  </div>
  </div>
)}
  </div>
)
}
