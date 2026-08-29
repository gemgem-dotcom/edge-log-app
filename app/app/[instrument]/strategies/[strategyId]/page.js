'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { MoreVertical, Plus } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { invalidateStrategies } from '@/lib/referenceDataCache'
import { hasResult } from '@/lib/tradeMath'
import { queryPerformance } from '@/lib/edgeEngine'
import { totalTradeCount } from '@/lib/insightData'
import EdgeInsightsPanel from '@/components/EdgeInsightsPanel'
import { useClickOutside } from '@/lib/useClickOutside'
import { toast } from '@/lib/toast'
import { usePageTitle } from '@/lib/usePageTitle'
import { computeStreak } from '@/lib/streak'
import TradeLogTable from '@/components/TradeLogTable'
import StreakBadge from '@/components/StreakBadge'
import MarketStatusPill from '@/components/MarketStatusPill'
import WinRateGauge from '@/components/WinRateGauge'
import EquityCurveChart from '@/components/EquityCurveChart'
import StrategyDetailSkeleton from '@/components/StrategyDetailSkeleton'
import PageError from '@/components/PageError'
import EmptyState from '@/components/EmptyState'
import ErrorBanner from '@/components/ErrorBanner'

function hasDollar(t) {
  return t.pnl !== null && t.pnl !== undefined
}

async function computeStrategyStats(allTrades) {
  // winRate/expectancy/profitFactor come from the Edge Engine (the one
  // shared implementation - see lib/edgeEngine.js) rather than being
  // computed here a second time; everything below is either dollar-
  // denominated (out of the engine's scope, which is R-only) or a plain
  // count WinRateGauge still needs directly.
  const perf = queryPerformance({ trades: allTrades, groupBy: null })
  const trades = allTrades.filter(hasResult)
  if (perf.n === 0) {
    return {
      n: perf.n, winRate: null, expectancy: null, expectancyD: null, totalPnl: null, totalD: null,
      hasD: false, profitFactor: null, wins: 0, losses: 0,
    }
  }

  const wins = trades.filter((t) => t.r_multiple > 0)
  const losses = trades.filter((t) => t.r_multiple < 0)
  const totalPnl = trades.reduce((s, t) => s + t.r_multiple, 0)

  // expectancyD is the average $ P&L per trade with a recorded dollar
  // value, breakevens included - same fix as lib/edgeEngine.js's
  // expectancy (see its comment): a win-rate-weighted formula only
  // matches this once a slice has zero breakevens.
  const withD = trades.filter(hasDollar)
  const hasD = withD.length > 0
  const totalD = hasD ? withD.reduce((s, t) => s + t.pnl, 0) : null
  const expectancyD = hasD ? totalD / withD.length : null

  return {
    n: perf.n, winRate: perf.winRate, expectancy: perf.expectancy, expectancyD, totalPnl, totalD,
    hasD, profitFactor: perf.profitFactor, wins: wins.length, losses: losses.length,
  }
}

// Cumulative $ P&L by day, ordered by trade_date - the same grouping
// OverviewDashboard.js defaults its own equity curve to, minus that
// page's day/week/month selector (not asked for here). Only trades with
// a recorded $ amount contribute, matching EquityCurveChart's existing
// dollar-only contract elsewhere in the app - an R-only strategy renders
// the chart's own "not enough closed trades" empty state.
function buildEquityCurve(trades) {
  const withD = trades
    .filter(hasResult)
    .filter(hasDollar)
    .slice()
    .sort((a, b) => a.trade_date.localeCompare(b.trade_date) || (a.trade_time || '').localeCompare(b.trade_time || ''))

  const byDate = new Map()
  for (const t of withD) {
    byDate.set(t.trade_date, (byDate.get(t.trade_date) || 0) + t.pnl)
  }

  const dates = [...byDate.keys()].sort()
  let running = 0
  return dates.map((key) => {
    running += byDate.get(key)
    return { key, cumulative: running }
  })
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
  // Menu/modal open-state and the duration-bucket filter are scoped to
  // whichever strategy is on screen - left open across a soft nav to a
  // different strategy (e.g. clicking straight from one strategy card to
  // another), a still-open delete-confirmation modal would confirm against
  // the *new* strategyId (read fresh from params on every render), not the
  // one the trader actually meant to delete. Previously this page always
  // remounted fresh on navigation, so these defaults doubled as the reset;
  // a soft nav no longer remounts it.
  setMenuOpen(false)
  setRenaming(false)
  setShowDeleteModal(false)
  setFormError(null)
  try {
    // PGRST116 is PostgREST's "0 rows" error for .single() - expected when
    // this strategy was deleted (e.g. a stale sidebar link, or a bookmark/
    // back-button hit before the sidebar catches up - see the layout's own
    // pathname-triggered refetch). That's the empty-strategy state below,
    // not a real failure worth surfacing as an error banner.
    const { data: s, error: stratError } = await supabase.from('strategies').select('*').eq('id', strategyId).single()
    if (stratError && stratError.code !== 'PGRST116') throw stratError
    setStrategy(stratError ? null : s)
    if (stratError) return

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
    invalidateStrategies(strategy.instrument_id)
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
  invalidateStrategies(strategy.instrument_id)
  toast.success('Strategy deleted.')
  router.push(`/app/${symbol}/dashboard`)
}

if (loading) return <StrategyDetailSkeleton />
if (error) return <div className="page-container"><PageError message={`Couldn't load this strategy — ${error}`} onRetry={loadData} /></div>
  if (!strategy) return <div className="page-container"><div className="empty">Strategy not found.</div></div>

const streak = computeStreak(trades)
const equityPoints = buildEquityCurve(trades)

return (
  <div className="page-container">
  <ErrorBanner message={formError} />
  <div className="strategy-header-row">
  <h1 className="page-title">{strategy.name}</h1>
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
<Link href={`/app/${symbol}/log/new?strategy=${strategyId}`} className="new-trade-btn"><Plus size={16} /> Log new trade</Link>
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

<p className="page-subtitle page-subtitle-tight">See how your strategy has performed.</p>
<div className="header-pills-row">
  <MarketStatusPill />
  <StreakBadge
    streak={streak}
    winLabel={(n) => `${n} win${n === 1 ? '' : 's'} in a row on this strategy`}
    lossLabel={(n) => `${n} loss${n === 1 ? '' : 'es'} in a row on this strategy`}
  />
</div>

<div className="section-heading">Performance</div>
<div className="panel">
  <div className="performance-card-subgrid" style={{ marginTop: 0 }}>
    {/* Wrapped in a plain div, rather than putting stats/stats-2 directly
        under .performance-card-subgrid - that selector's own
        ">div{display:flex; flex-direction:column}" rule (meant for
        stacking a chart's title/graph/labels in the other column) has
        higher specificity than .stats's display:grid and was silently
        collapsing these 4 cards into a single column instead of 2x2. */}
    <div>
      <div className="stats stats-2">
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
        <div className="stat stat-gauge">
          <div className="stat-label">Win rate</div>
          <WinRateGauge wins={stats.wins} losses={stats.losses} winRate={stats.winRate} />
        </div>
        <div className="stat">
          <div className="stat-label">Profit factor</div>
          <div className="stat-value neu">{fmtPF(stats.profitFactor)}</div>
        </div>
      </div>
    </div>

    <div className="strategy-equity-col">
      <div className="stat-label dashboard-card-title">Equity curve</div>
      <EquityCurveChart points={equityPoints} />
      {equityPoints.length > 0 && (
        <div className="equity-chart-labels">
          <span>{equityPoints[0].key}</span>
          <span>{equityPoints[equityPoints.length - 1].key}</span>
        </div>
      )}
    </div>
  </div>
</div>

<div className="section-heading">Edge Insights</div>
<div className="panel">
  <EdgeInsightsPanel scope={`strategy:${strategyId}`} tradeCount={totalTradeCount(trades)} />
</div>

<div className="section-heading">At a glance</div>
<div className="panel">
  <div className="stat-label dashboard-card-title">Trades around today&apos;s events?</div>
  {/* Mock only - a real version should check this strategy's name/tags
      against today's economic-calendar events instead of a fixed line. */}
  <p className="strategy-context-text">This strategy often trades around scheduled Fed events — one lands today at 10:00.</p>
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
        actionHref={`/app/${symbol}/log/new?strategy=${strategyId}`}
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
