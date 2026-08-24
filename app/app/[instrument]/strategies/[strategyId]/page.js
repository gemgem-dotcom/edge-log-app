'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { MoreVertical, Plus, X } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { hasResult, tradeDurationMinutes, formatDuration, sampleConfidence } from '@/lib/tradeMath'
import { useClickOutside } from '@/lib/useClickOutside'
import { toast } from '@/lib/toast'
import { usePageTitle } from '@/lib/usePageTitle'
import { computeStreak } from '@/lib/streak'
import TradeLogTable from '@/components/TradeLogTable'
import StreakBadge from '@/components/StreakBadge'
import MarketStatusPill from '@/components/MarketStatusPill'
import WinRateGauge from '@/components/WinRateGauge'
import TradeDurationChart from '@/components/TradeDurationChart'
import StrategyDetailSkeleton from '@/components/StrategyDetailSkeleton'
import PageError from '@/components/PageError'
import EmptyState from '@/components/EmptyState'
import ErrorBanner from '@/components/ErrorBanner'

function hasDollar(t) {
  return t.pnl !== null && t.pnl !== undefined
}

async function computeStrategyStats(allTrades) {
  const trades = allTrades.filter(hasResult)
  const n = trades.length
  if (n === 0) {
    return {
      n, winRate: null, expectancy: null, expectancyD: null, totalPnl: null, totalD: null,
      hasD: false, profitFactor: null, wins: 0, losses: 0,
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

return { n, winRate, expectancy, expectancyD, totalPnl, totalD, hasD, profitFactor, wins: wins.length, losses: losses.length }
}

// The strategy's closed losing trades - the shared base set every Findings
// stat below that talks about "losses" draws from, so they can't quietly
// disagree about what counts as one (open trades excluded via hasResult,
// same as computeStrategyStats' own losses count above).
function getClosedLosses(allTrades) {
  return allTrades.filter(hasResult).filter((t) => t.r_multiple < 0)
}

// Every closed loss is exactly one of: flagged (has one or more Discipline
// tags), clean (explicitly reviewed with no issues), or unreviewed (neither
// set yet) - schema.sql's comment above reviewed_no_issues/discipline_tags
// is the source of truth for why those two columns are mutually exclusive.
// Unreviewed is kept as its own bucket rather than folded into "clean" -
// the whole reason reviewed_no_issues exists as an explicit field is that
// "never reviewed" and "reviewed, no issues found" are different facts.
function computeLossBreakdown(losses) {
  const n = losses.length
  const flagged = losses.filter((t) => !t.reviewed_no_issues && t.discipline_tags && t.discipline_tags.length > 0)
  const clean = losses.filter((t) => t.reviewed_no_issues)
  const unreviewed = losses.filter((t) => !t.reviewed_no_issues && (!t.discipline_tags || t.discipline_tags.length === 0))
  const pct = (count) => (n > 0 ? (count / n) * 100 : null)
  return {
    n,
    flagged, clean, unreviewed,
    flaggedPct: pct(flagged.length),
    cleanPct: pct(clean.length),
    unreviewedPct: pct(unreviewed.length),
  }
}

// The single most common Discipline tag among this strategy's flagged
// losses (computeLossBreakdown's `flagged` bucket) - a loss with several
// tags counts toward each one's total, so this is a plain frequency count
// across every tag on every flagged loss, not a count of losses. Once the
// top tag is found, "trades carrying that tag" vs. "all other losing
// trades" is checked against every closed loss (not just the flagged
// ones) - a loss can only carry a Discipline tag if it's flagged, so
// "carrying that tag" is already a subset of flagged, but "other losing
// trades" correctly includes clean/unreviewed losses too, not just
// differently-flagged ones. r_multiple is reused as stored, never
// recomputed. Null when there are no flagged losses to find a tag in.
function computeTopMistakeTag(closedLosses, flaggedLosses) {
  const tagCounts = {}
  for (const t of flaggedLosses) {
    for (const tag of t.discipline_tags || []) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1
    }
  }
  const entries = Object.entries(tagCounts)
  if (entries.length === 0) return null
  entries.sort((a, b) => b[1] - a[1])
  const [tag, tagCount] = entries[0]

  const withTag = closedLosses.filter((t) => (t.discipline_tags || []).includes(tag))
  const withoutTag = closedLosses.filter((t) => !(t.discipline_tags || []).includes(tag))
  const avgR = (arr) => (arr.length > 0 ? arr.reduce((s, t) => s + t.r_multiple, 0) / arr.length : null)

  return {
    tag,
    n: withTag.length,
    pctOfFlagged: flaggedLosses.length > 0 ? (tagCount / flaggedLosses.length) * 100 : null,
    avgRWithTag: avgR(withTag),
    avgRWithoutTag: avgR(withoutTag),
  }
}

// Adaptive-width duration histogram - bucket width scales to the trades'
// own min/max duration (picked from NICE_STEPS_MIN, the same "round
// number of minutes/hours" progression a chart-axis tick algorithm would
// use) so a scalper's few-minute trades land in minute-wide buckets and a
// swing trader's multi-hour trades land in hour-wide ones, rather than
// one fixed scale being too coarse for one trader and too fine for the
// other. Every trade with a recorded entry+exit time counts, regardless
// of hasResult - duration is about time, not outcome, the same reasoning
// the old computeAvgDuration used allTrades for.
const NICE_STEPS_MIN = [1, 2, 5, 10, 15, 30, 60, 120, 240, 360, 480, 720, 1440, 2880]
const TARGET_MAX_BUCKETS = 6

function computeDurationBuckets(allTrades) {
  const withDuration = allTrades
    .map((t) => ({ t, duration: tradeDurationMinutes(t) }))
    .filter((x) => x.duration !== null)
  if (withDuration.length === 0) return []

  const durations = withDuration.map((x) => x.duration)
  const min = Math.min(...durations)
  const max = Math.max(...durations)

  const step = min === max
    ? Math.max(1, min)
    : (NICE_STEPS_MIN.find((s) => Math.ceil((max - min) / s) <= TARGET_MAX_BUCKETS) || NICE_STEPS_MIN[NICE_STEPS_MIN.length - 1])

  const start = Math.floor(min / step) * step
  const numBuckets = Math.max(1, Math.ceil((max - start + 1) / step))
  const buckets = Array.from({ length: numBuckets }, (_, i) => {
    const from = start + i * step
    const to = from + step
    return { from, to, label: `${formatDuration(from)}–${formatDuration(to)}`, wins: 0, losses: 0, neutral: 0 }
  })

  for (const { t, duration } of withDuration) {
    const idx = Math.min(numBuckets - 1, Math.max(0, Math.floor((duration - start) / step)))
    const bucket = buckets[idx]
    if (!hasResult(t) || t.r_multiple === 0) bucket.neutral += 1
    else if (t.r_multiple > 0) bucket.wins += 1
    else bucket.losses += 1
  }

  return buckets
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
function fmtPct(val) {
  if (val === null || val === undefined) return '—'
  return Math.round(val) + '%'
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

  // Set when a Trade duration bar is clicked - narrows the trade log below
  // to just that bucket's trades and scrolls it into view, so the chart
  // doubles as a filter rather than just a static breakdown.
  const [durationFilter, setDurationFilter] = useState(null)
  const tradeLogRef = useRef(null)

  function handleSelectDuration(bucket) {
    setDurationFilter({ from: bucket.from, to: bucket.to, label: bucket.label })
    tradeLogRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

useEffect(() => {
  loadData()
}, [strategyId])

async function loadData() {
  setLoading(true)
  setError(null)
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
  const closedLosses = getClosedLosses(trades)
  const lossBreakdown = computeLossBreakdown(closedLosses)
  const topMistakeTag = computeTopMistakeTag(closedLosses, lossBreakdown.flagged)
  const durationBuckets = computeDurationBuckets(trades)
  // Same [from, to) partition computeDurationBuckets itself assigns trades
  // to, so a bucket's trade count and what shows up here when it's
  // selected always agree.
  const visibleTrades = durationFilter
    ? trades.filter((t) => {
        const d = tradeDurationMinutes(t)
        return d !== null && d >= durationFilter.from && d < durationFilter.to
      })
    : trades

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
<a href={`/app/${symbol}/log/new?strategy=${strategyId}`} className="new-trade-btn"><Plus size={16} /> Log new trade</a>
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
  <div className="stats stats-5">
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
    <div className="stat">
      <div className="stat-label">Total trades</div>
      <div className="stat-value neu">{stats.n.toLocaleString('en-US')}</div>
    </div>
  </div>
  <div className="performance-duration-chart">
    <div className="stat-label dashboard-card-title">Trade duration</div>
    <TradeDurationChart buckets={durationBuckets} onSelect={handleSelectDuration} />
  </div>
  <div className="strategy-findings">
    <div className="stat-label dashboard-card-title">Findings</div>
    <div className="strategy-finding">
      <div className="strategy-finding-label">Loss breakdown</div>
      {sampleConfidence(lossBreakdown.n).level === 'low' ? (
        <div className="stat-placeholder">Not enough losses yet.</div>
      ) : (
        <p className="strategy-finding-text">
          <strong className="neg">{fmtPct(lossBreakdown.flaggedPct)}</strong> of your losses carried a mistake tag —{' '}
          <strong className="pos">{fmtPct(lossBreakdown.cleanPct)}</strong> clean,{' '}
          <strong className="neu">{fmtPct(lossBreakdown.unreviewedPct)}</strong> unreviewed.
        </p>
      )}
    </div>
    <div className="strategy-finding">
      <div className="strategy-finding-label">Most frequent mistake</div>
      {!topMistakeTag || sampleConfidence(topMistakeTag.n).level === 'low' ? (
        <div className="stat-placeholder">Not enough tagged losses yet.</div>
      ) : (
        <p className="strategy-finding-text">
          &quot;{topMistakeTag.tag}&quot; appears in <strong>{fmtPct(topMistakeTag.pctOfFlagged)}</strong> of your tagged losses, and those trades average{' '}
          <strong className={colorClass(topMistakeTag.avgRWithTag)}>{fmtR(topMistakeTag.avgRWithTag)}</strong> vs.{' '}
          <strong className={colorClass(topMistakeTag.avgRWithoutTag)}>{fmtR(topMistakeTag.avgRWithoutTag)}</strong> for your other losses.
        </p>
      )}
    </div>
  </div>
</div>

<div className="section-heading">At a glance</div>
<div className="panel">
  <div className="stat-label dashboard-card-title">Trades around today&apos;s events?</div>
  {/* Mock only - a real version should check this strategy's name/tags
      against today's economic-calendar events instead of a fixed line. */}
  <p className="strategy-context-text">This strategy often trades around scheduled Fed events — one lands today at 10:00.</p>
</div>

<div className="section-heading" ref={tradeLogRef}>Trade log — {strategy.name}</div>
<div className="panel">
  {durationFilter && (
    <div className="active-filters">
      <span className="filter-chip">
        Duration: {durationFilter.label}
        <button type="button" onClick={() => setDurationFilter(null)} aria-label="Remove duration filter">
          <X size={12} />
        </button>
      </span>
    </div>
  )}
  <TradeLogTable
    trades={visibleTrades}
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
