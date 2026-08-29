'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { MoreVertical, Plus, X } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { invalidateStrategies } from '@/lib/referenceDataCache'
import { hasResult, tradeDurationMinutes, formatDuration } from '@/lib/tradeMath'
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
import TradeDurationChart from '@/components/TradeDurationChart'
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
function colorClass(val) {
  if (val === null || val === undefined) return 'neu'
  return val > 0 ? 'pos' : val < 0 ? 'neg' : 'neu'
}
function fmtPct(val) {
  if (val === null || val === undefined) return '—'
  return Math.round(val) + '%'
}
function fmtPctDelta(val) {
  if (val === null || val === undefined) return '—'
  return (val >= 0 ? '+' : '') + Math.round(val) + 'pp'
}

// The strategy's closed losing trades - the base set every Findings stat
// below that talks about "losses" draws from, so they can't quietly
// disagree about what counts as one.
function getClosedLosses(allTrades) {
  return allTrades.filter(hasResult).filter((t) => t.r_multiple < 0)
}

// Mirrors the Edge Engine's own discipline bucketing rule (lib/
// edgeEngine.js's DIMENSIONS.discipline) but returns the actual trades in
// each bucket rather than an aggregate row - queryPerformance's grouped
// output only returns stats per group, not the underlying trades, and
// finding the single most common tag (below) needs the real
// discipline_tags arrays to count over.
function classifyByDiscipline(losses) {
  const flagged = losses.filter((t) => !t.reviewed_no_issues && t.discipline_tags && t.discipline_tags.length > 0)
  const clean = losses.filter((t) => t.reviewed_no_issues)
  const unreviewed = losses.filter((t) => !t.reviewed_no_issues && (!t.discipline_tags || t.discipline_tags.length === 0))
  return { flagged, clean, unreviewed }
}

// The single most common individual Discipline tag among flagged losses -
// a loss with several tags counts toward each one's total. Null when
// there are no flagged losses to find a tag in.
function findTopMistakeTag(flaggedLosses) {
  const counts = {}
  for (const t of flaggedLosses) {
    for (const tag of t.discipline_tags || []) counts[tag] = (counts[tag] || 0) + 1
  }
  const entries = Object.entries(counts)
  if (entries.length === 0) return null
  entries.sort((a, b) => b[1] - a[1])
  return entries[0][0]
}

// The single most notable session row to call out in prose alongside the
// table - the confident (confidenceTier above too_early) row whose win
// rate differs most from the strategy's overall rate. MIN_STANDOUT_GAP
// keeps a trivial few-percent wobble from being flagged as if it meant
// something - judgment call, no exact threshold was specified.
const MIN_STANDOUT_GAP = 10
function findStandoutSession(sessionRows) {
  const confident = sessionRows.filter((r) => r.confidenceTier !== 'too_early' && r.deltaVsBaseline?.winRate != null)
  if (confident.length === 0) return null
  const standout = confident.reduce((a, b) => (Math.abs(b.deltaVsBaseline.winRate) > Math.abs(a.deltaVsBaseline.winRate) ? b : a))
  return Math.abs(standout.deltaVsBaseline.winRate) >= MIN_STANDOUT_GAP ? standout : null
}

// Win rate over the most recent 20 closed trades vs. all-time - only
// meaningful once there's a real baseline to have decayed from, so this
// only runs once queryPerformance's own confidenceTier for the full
// trade set is 'trustworthy' (50+); below that, callers should omit the
// finding entirely rather than show a placeholder for a concept the
// trader hasn't earned yet. allTrades is expected in the page's own
// newest-first query order, so recent20 is already the 20 most recently
// entered closed trades without a separate sort. MIN_DECAY_GAP keeps a
// small, normal fluctuation from reading as a warning, and only a
// DECLINE is flagged - an improving stretch isn't "decay".
const MIN_DECAY_GAP = 10
function computeEdgeDecay(allTrades) {
  const overall = queryPerformance({ trades: allTrades, groupBy: null })
  if (overall.confidenceTier !== 'trustworthy') return null
  const recent20 = allTrades.filter(hasResult).slice(0, 20)
  if (recent20.length === 0) return null
  const recent = queryPerformance({ trades: recent20, compareTo: allTrades })
  const gap = recent.deltaVsBaseline?.winRate
  if (gap === null || gap === undefined || gap > -MIN_DECAY_GAP) return null
  return { recentWinRate: recent.winRate, overallWinRate: overall.winRate, gap }
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
  setDurationFilter(null)
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
  const durationBuckets = computeDurationBuckets(trades)

  // Findings, all built on the Edge Engine (lib/edgeEngine.js) rather than
  // bespoke per-finding math - see each helper above for what it computes.
  const closedLosses = getClosedLosses(trades)
  const lossBreakdown = queryPerformance({ trades: closedLosses, groupBy: 'discipline' })
  const flaggedLossRow = lossBreakdown.find((r) => r.key === 'flagged') ?? { n: 0, confidenceTier: 'too_early' }
  const { flagged: flaggedLosses } = classifyByDiscipline(closedLosses)

  const topMistakeTag = findTopMistakeTag(flaggedLosses)
  let topMistakeTagPerf = null
  let topMistakeTagOtherPerf = null
  if (topMistakeTag) {
    const withTag = closedLosses.filter((t) => (t.discipline_tags || []).includes(topMistakeTag))
    const withoutTag = closedLosses.filter((t) => !(t.discipline_tags || []).includes(topMistakeTag))
    topMistakeTagPerf = queryPerformance({ trades: withTag, compareTo: withoutTag })
    topMistakeTagOtherPerf = queryPerformance({ trades: withoutTag })
  }

  const sessionBreakdown = queryPerformance({ trades, groupBy: 'session', compareTo: trades })
  const standoutSession = findStandoutSession(sessionBreakdown)

  const edgeDecay = computeEdgeDecay(trades)
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
      {flaggedLossRow.confidenceTier === 'too_early' ? (
        <div className="stat-placeholder">Not enough losses yet.</div>
      ) : (
        <p className="strategy-finding-text">
          <strong className="neg">{fmtPct((flaggedLossRow.n / closedLosses.length) * 100)}</strong> of your losses carried a mistake tag —{' '}
          <strong className="pos">{fmtPct(((lossBreakdown.find((r) => r.key === 'clean')?.n ?? 0) / closedLosses.length) * 100)}</strong> clean,{' '}
          <strong className="neu">{fmtPct(((lossBreakdown.find((r) => r.key === 'unreviewed')?.n ?? 0) / closedLosses.length) * 100)}</strong> unreviewed.
        </p>
      )}
    </div>
    <div className="strategy-finding">
      <div className="strategy-finding-label">Most frequent mistake</div>
      {!topMistakeTagPerf || topMistakeTagPerf.confidenceTier === 'too_early' ? (
        <div className="stat-placeholder">Not enough tagged losses yet.</div>
      ) : (
        <p className="strategy-finding-text">
          &quot;{topMistakeTag}&quot; appears in <strong>{fmtPct((topMistakeTagPerf.n / flaggedLosses.length) * 100)}</strong> of your tagged losses, and those trades average{' '}
          <strong className={colorClass(topMistakeTagPerf.avgR)}>{fmtR(topMistakeTagPerf.avgR)}</strong> vs.{' '}
          <strong className={colorClass(topMistakeTagOtherPerf?.avgR)}>{fmtR(topMistakeTagOtherPerf?.avgR)}</strong> for your other losses.
        </p>
      )}
    </div>
    <div className="strategy-finding">
      <div className="strategy-finding-label">Session breakdown</div>
      {sessionBreakdown.length === 0 ? (
        <div className="stat-placeholder">No session data yet.</div>
      ) : (
        <>
          {standoutSession && (
            <p className="strategy-finding-text">
              <strong>{fmtPct(stats.winRate)}</strong> overall, <strong className={colorClass(standoutSession.deltaVsBaseline.winRate)}>{fmtPct(standoutSession.winRate)}</strong> in the {standoutSession.key}.
            </p>
          )}
          <div className="table-scroll">
            <table className="session-breakdown-table">
              <thead>
                <tr><th>Session</th><th>Trades</th><th>Win rate</th><th>Expectancy</th></tr>
              </thead>
              <tbody>
                {sessionBreakdown.map((row) => (
                  <tr key={row.key}>
                    <td>{row.key}</td>
                    <td>{row.n}</td>
                    <td>
                      {row.confidenceTier === 'too_early' ? (
                        <span className="muted-note">Too few trades</span>
                      ) : (
                        <>
                          {fmtPct(row.winRate)}{' '}
                          <span className={colorClass(row.deltaVsBaseline?.winRate)}>({fmtPctDelta(row.deltaVsBaseline?.winRate)})</span>
                        </>
                      )}
                    </td>
                    <td>
                      {row.confidenceTier === 'too_early' ? (
                        <span className="muted-note">—</span>
                      ) : (
                        <span className={colorClass(row.expectancy)}>{fmtR(row.expectancy)}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
    {edgeDecay && (
      <div className="strategy-finding">
        <div className="strategy-finding-label">Edge decay</div>
        <p className="strategy-finding-text">
          Your last 20 trades are winning at <strong className="neg">{fmtPct(edgeDecay.recentWinRate)}</strong>, vs.{' '}
          <strong>{fmtPct(edgeDecay.overallWinRate)}</strong> all-time — worth a look.
        </p>
      </div>
    )}
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
