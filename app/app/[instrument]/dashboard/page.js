'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { catalogEntryFor } from '@/lib/instrumentCatalog'
import { strategyColor } from '@/lib/strategyColor'
import { hasResult } from '@/lib/tradeMath'
import { queryPerformance } from '@/lib/edgeEngine'
import { usePageTitle } from '@/lib/usePageTitle'
import { computeStreak } from '@/lib/streak'
import { latestClosedSessionRegime, edgeEngineClause } from '@/lib/todaysBrief'
import { upcomingEconEvents } from '@/lib/marketContextMock'
import { daysToRollover } from '@/lib/contractRollover'
import TradeLogTable from '@/components/TradeLogTable'
import InstrumentMenu from '@/components/InstrumentMenu'
import WinRateGauge from '@/components/WinRateGauge'
import AvgPnlByWeekdayChart from '@/components/AvgPnlByWeekdayChart'
import EquityCurveChart from '@/components/EquityCurveChart'
import FlippingStatChips from '@/components/FlippingStatChips'
import TableHeaderTooltip from '@/components/TableHeaderTooltip'
import CalendarNewsBadge from '@/components/CalendarNewsBadge'
import StreakBadge from '@/components/StreakBadge'
import MarketStatusPill from '@/components/MarketStatusPill'
import DashboardSkeleton from '@/components/DashboardSkeleton'
import EmptyState from '@/components/EmptyState'
import PageError from '@/components/PageError'

const NQ_DATA_SYMBOL = 'NQ'
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']
const CAL_HEADINGS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat','Weekly P&L']
const EQUITY_GROUPS = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
]

function computeStats(allTrades) {
  // winRate/expectancy/profitFactor come from the Edge Engine (the one
  // shared implementation - see lib/edgeEngine.js) rather than being
  // computed here a third time; everything below is either dollar-
  // denominated (out of the engine's scope, which is R-only) or a plain
  // count WinRateGauge/tradingDays still needs directly. Open trades (no
  // exit price, so no R yet) can't be scored either way — the engine's
  // own hasResult filtering already excludes them the same way this
  // used to.
  const perf = queryPerformance({ trades: allTrades, groupBy: null })
  const trades = allTrades.filter(hasResult)
  const tradingDays = new Set(allTrades.filter((t) => t.trade_date).map((t) => t.trade_date)).size
  if (perf.n === 0) return { n: perf.n, tradingDays, winRate: null, expectancy: null, totalPnl: null, profitFactor: null, totalD: null, hasD: false, expectancyD: null, wins: 0, losses: 0 }

const wins = trades.filter((t) => t.r_multiple > 0)
  const losses = trades.filter((t) => t.r_multiple < 0)
  const totalPnl = trades.reduce((s, t) => s + t.r_multiple, 0)

// expectancyD is the average $ P&L per trade with a recorded dollar value,
// breakevens included - same fix as lib/edgeEngine.js's expectancy (see
// its comment): a win-rate-weighted formula only matches this once a slice
// has zero breakevens.
const withD = trades.filter(hasDollar)
  const hasD = withD.length > 0
  const totalD = hasD ? withD.reduce((s, t) => s + t.pnl, 0) : null
  const expectancyD = hasD ? totalD / withD.length : null

return { n: perf.n, tradingDays, winRate: perf.winRate, expectancy: perf.expectancy, totalPnl, profitFactor: perf.profitFactor, totalD, hasD, expectancyD, wins: wins.length, losses: losses.length }
}

function hasDollar(t) {
  return t.pnl !== null && t.pnl !== undefined
}

// Average $ P&L per weekday (0=Sun..6=Sat, matching Date#getDay), ordered
// Sun-Fri - Saturday is skipped entirely, since none of these instruments'
// sessions land on it in any timezone. Every weekday is always included,
// even with zero trades - AvgPnlByWeekdayChart renders those as a flat
// $0 with no bar rather than omitting the row.
function computeWeekdayPnl(trades) {
  const byDay = new Map()
  for (const t of trades) {
    if (!hasResult(t) || !hasDollar(t) || !t.trade_date) continue
    const day = new Date(t.trade_date + 'T00:00:00').getDay()
    const entry = byDay.get(day) || { sum: 0, count: 0 }
    entry.sum += t.pnl
    entry.count += 1
    byDay.set(day, entry)
  }
  return [0, 1, 2, 3, 4, 5].map((day) => {
    const entry = byDay.get(day)
    return { day, avg: entry ? entry.sum / entry.count : 0, count: entry ? entry.count : 0 }
  })
}

// Monday of the ISO week containing dateStr, used as the bucket key when
// the equity curve is grouped by week.
function weekStart(dateStr) {
  const d = new Date(dateStr + 'T00:00:00')
  const day = d.getDay()
  d.setDate(d.getDate() + ((day === 0 ? -6 : 1) - day))
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function bucketKey(dateStr, group) {
  if (group === 'month') return dateStr.slice(0, 7)
  if (group === 'week') return weekStart(dateStr)
  return dateStr
}

// Cumulative $ P&L, ordered by trade_date. Every trade always has a final
// result, so there's no open-trade state to filter around - only trades
// with a recorded $ amount (hasDollar) contribute, since R-only trades
// have nothing to add to a dollar curve.
function buildEquityCurve(trades, group) {
  const withD = trades
    .filter(hasResult)
    .filter(hasDollar)
    .slice()
    .sort((a, b) => a.trade_date.localeCompare(b.trade_date) || (a.trade_time || '').localeCompare(b.trade_time || ''))

  const byBucket = new Map()
  for (const t of withD) {
    const key = bucketKey(t.trade_date, group)
    byBucket.set(key, (byBucket.get(key) || 0) + t.pnl)
  }

  const keys = [...byBucket.keys()].sort()
  let running = 0
  return keys.map((key) => {
    running += byBucket.get(key)
    return { key, cumulative: running }
  })
}

function computeMonthStats(allTrades) {
  // Same migration as computeStats above (winRate/expectancy/profitFactor
  // via the Edge Engine) - kept as a separate function rather than
  // reusing computeStats since the field names differ (expectancyR/totalR
  // here vs. expectancy/totalPnl there) and callers read both shapes.
  const perf = queryPerformance({ trades: allTrades, groupBy: null })
  const trades = allTrades.filter(hasResult)
  const tradingDays = new Set(allTrades.filter((t) => t.trade_date).map((t) => t.trade_date)).size
  if (perf.n === 0) return { n: perf.n, tradingDays, winRate: null, expectancyR: null, expectancyD: null, totalR: null, totalD: null, hasD: false, profitFactor: null, wins: 0, losses: 0 }

const wins = trades.filter((t) => t.r_multiple > 0)
  const losses = trades.filter((t) => t.r_multiple < 0)

const totalR = trades.reduce((s, t) => s + t.r_multiple, 0)

// expectancyD is the average $ P&L per trade with a recorded dollar value,
// breakevens included - same fix as lib/edgeEngine.js's expectancy (see
// its comment): a win-rate-weighted formula only matches this once a slice
// has zero breakevens.
const withD = trades.filter(hasDollar)
  const hasD = withD.length > 0
  const totalD = hasD ? withD.reduce((s, t) => s + t.pnl, 0) : null
  const expectancyD = hasD ? totalD / withD.length : null

return { n: perf.n, tradingDays, winRate: perf.winRate, expectancyR: perf.expectancy, expectancyD, totalR, totalD, hasD, profitFactor: perf.profitFactor, wins: wins.length, losses: losses.length }
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
function fmtCountdown(ms) {
  if (ms === null || ms === undefined) return '—'
  const totalMinutes = Math.round(ms / 60000)
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}
function toDateStr(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}
function toneClass(value, count) {
  if (!count) return ''
  return value > 0 ? 'calendar-cell-win' : value < 0 ? 'calendar-cell-loss' : ''
}

function buildCalendarWeeks(year, month, tradesByDate) {
  function makeCell(y, m, d, outside) {
    const dateStr = toDateStr(y, m, d)
    const dayTrades = tradesByDate[dateStr] || []
      const withD = dayTrades.filter(hasDollar)
      const closed = dayTrades.filter(hasResult)
    return {
      dateStr,
      dayNum: d,
      outside,
      count: dayTrades.length,
      sumR: closed.reduce((s, t) => s + t.r_multiple, 0),
      sumD: withD.reduce((s, t) => s + t.pnl, 0),
      hasD: withD.length > 0,
    }
  }

const startWeekday = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const daysInPrevMonth = new Date(year, month, 0).getDate()
  const prevMonth = month === 0 ? 11 : month - 1
  const prevYear = month === 0 ? year - 1 : year
  const nextMonth = month === 11 ? 0 : month + 1
  const nextYear = month === 11 ? year + 1 : year

const cells = []
  for (let i = 0; i < startWeekday; i++) {
    cells.push(makeCell(prevYear, prevMonth, daysInPrevMonth - startWeekday + 1 + i, true))
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push(makeCell(year, month, d, false))
  }
  let nextDay = 1
  while (cells.length % 7 !== 0) {
    cells.push(makeCell(nextYear, nextMonth, nextDay, true))
    nextDay++
  }

const weeks = []
  for (let i = 0; i < cells.length; i += 7) {
    const weekCells = cells.slice(i, i + 7)
    weeks.push({
      cells: weekCells,
      weekR: weekCells.reduce((s, c) => s + c.sumR, 0),
      weekD: weekCells.reduce((s, c) => s + c.sumD, 0),
      weekHasD: weekCells.some((c) => c.hasD),
      weekCount: weekCells.reduce((s, c) => s + c.count, 0),
    })
  }
  return weeks
}

export default function DashboardPage({ params }) {
  usePageTitle('Overview')
  const symbol = params.instrument
  const displayName = catalogEntryFor(symbol)?.display_name || symbol
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [instrumentId, setInstrumentId] = useState(null)
  const [strategies, setStrategies] = useState([])
  const [tradesByStrategy, setTradesByStrategy] = useState({})
  const [allTrades, setAllTrades] = useState([])
  const [calCursor, setCalCursor] = useState(() => { const n = new Date(); return { year: n.getFullYear(), month: n.getMonth() } })
  const [calStrategy, setCalStrategy] = useState('all')
  const [perfStrategy, setPerfStrategy] = useState('all')
  const [equityGroup, setEquityGroup] = useState('day')
  const [selectedDate, setSelectedDate] = useState(null)
  const [regime, setRegime] = useState(null)

useEffect(() => {
  loadData()
}, [symbol])

async function loadData() {
  setLoading(true)
  setError(null)
  // Strategy ids and regime data are scoped to one instrument - carrying a
  // filter or regime reading over from whichever instrument was viewed
  // before would silently misfilter (a strategy id that matches nothing in
  // the new instrument) or mislabel (an NQ-family regime shown against a
  // non-NQ instrument) rather than error, so these need to reset on every
  // instrument switch, not just on first load. Previously this page always
  // remounted fresh on navigation, so the state's default values doubled as
  // this reset; a soft nav no longer remounts it.
  setPerfStrategy('all')
  setCalStrategy('all')
  setSelectedDate(null)
  setRegime(null)
  try {
    const { data: { user } } = await supabase.auth.getUser()
    const { data: instrument } = await supabase
    .from('instruments').select('*').eq('user_id', user.id).eq('symbol', symbol).eq('archived', false).single()
    if (!instrument) { setLoading(false); return }
    setInstrumentId(instrument.id)

    const { data: stratData, error: stratError } = await supabase
    .from('strategies').select('*').eq('instrument_id', instrument.id).eq('archived', false)
    .order('created_at', { ascending: true })
    if (stratError) throw stratError

    const { data: tradeData, error: tradeError } = await supabase
    .from('trades').select('*').eq('instrument_id', instrument.id)
    if (tradeError) throw tradeError

    const grouped = {}
      for (const s of stratData || []) {
        grouped[s.id] = (tradeData || []).filter((t) => t.strategy_id === s.id)
      }

    setStrategies(stratData || [])
    setTradesByStrategy(grouped)
    setAllTrades(tradeData || [])

    // NQ-family only, matching lib/tradeRegimes.js's own scope - every
    // other instrument's trades never carry volatility_regime/volume_regime,
    // so there's nothing this clause could match and no point in the query.
    if (catalogEntryFor(symbol)?.data_symbol === NQ_DATA_SYMBOL) {
      setRegime(await latestClosedSessionRegime(supabase))
    }
  } catch (err) {
    setError(err.message || "Couldn't load your dashboard — something went wrong.")
  } finally {
    setLoading(false)
  }
}

if (loading) return <DashboardSkeleton />
if (error) return <div className="page-container"><PageError message={`Couldn't load your dashboard — ${error}`} onRetry={loadData} /></div>

const classifiedTrades = allTrades.filter((t) => t.strategy_id)
  const unclassifiedCount = allTrades.length - classifiedTrades.length
  const sortedStrategies = strategies.slice().sort((a, b) => a.name.localeCompare(b.name))
  const perfTrades = perfStrategy === 'all' ? classifiedTrades : classifiedTrades.filter((t) => t.strategy_id === perfStrategy)
  const overall = computeStats(perfTrades)
  const weekdayRows = computeWeekdayPnl(perfTrades)
  const equityPoints = buildEquityCurve(perfTrades, equityGroup)
  // Always every strategy's own total, regardless of perfStrategy - the
  // filter dims the others in the list rather than removing them, so
  // their totals need to stay on screen to dim (same as instrumentSegments
  // on the all-instruments page).
  const strategySegments = strategies.map((s, i) => {
    const trades = (tradesByStrategy[s.id] || []).filter((t) => hasResult(t) && hasDollar(t))
    return { id: s.id, label: s.name, value: trades.reduce((sum, t) => sum + t.pnl, 0), color: strategyColor(i) }
  })

  // Full per-strategy stats (from every trade, independent of perfStrategy -
  // same reasoning as strategySegments above) - feeds the 4 other faces
  // FlippingStatChips cycles through beside P&L.
  const perStrategyStats = strategies.map((s, i) => ({
    id: s.id,
    label: s.name,
    color: strategyColor(i),
    stats: computeStats(tradesByStrategy[s.id] || []),
  }))

  // Alphabetical by strategy name in every view (not ranked by that view's
  // own metric) - strategies stay in the same order regardless of which
  // face is showing, matching how they're ordered everywhere else in the
  // app (sidebar, filter dropdowns).
  const alphaStrategySegments = strategySegments.slice().sort((a, b) => a.label.localeCompare(b.label))
  const alphaPerStrategyStats = perStrategyStats.slice().sort((a, b) => a.label.localeCompare(b.label))

  const flipViews = [
    {
      label: 'Total P&L',
      segments: alphaStrategySegments
        .map((seg) => ({ id: seg.id, label: seg.label, color: seg.color, value: fmtD(seg.value), tone: colorClass(seg.value) })),
    },
    {
      label: 'Expectancy',
      segments: alphaPerStrategyStats
        .map(({ id, label, color, stats }) => ({
          id, label, color,
          value: stats.expectancyD !== null ? `${fmtD(stats.expectancyD)} (${fmtR(stats.expectancy)})` : fmtR(stats.expectancy),
          tone: colorClass(stats.expectancyD !== null ? stats.expectancyD : stats.expectancy),
        })),
    },
    {
      label: 'Win rate',
      segments: alphaPerStrategyStats
        .map(({ id, label, color, stats }) => ({
          id, label, color,
          value: stats.winRate === null ? '—' : stats.winRate.toFixed(1) + '%',
          tone: stats.winRate !== null && stats.winRate < 50 ? 'neg' : 'neu',
        })),
    },
    {
      label: 'Profit factor',
      segments: alphaPerStrategyStats
        .map(({ id, label, color, stats }) => ({ id, label, color, value: fmtPF(stats.profitFactor), tone: 'neu' })),
    },
    {
      label: 'Total trades',
      segments: alphaPerStrategyStats
        .map(({ id, label, color, stats }) => ({ id, label, color, value: stats.n.toLocaleString('en-US'), tone: 'neu' })),
    },
  ]
  const streak = computeStreak(allTrades)
  // null (no clause rendered) until there's a confident, matching
  // strategy x regime signal for the most recently closed session - see
  // lib/todaysBrief.js. The existing sentence just above stays exactly as
  // it was either way.
  const briefClause = edgeEngineClause({ trades: classifiedTrades, strategies, regime })
  const now = new Date()
  const rolloverDays = daysToRollover(catalogEntryFor(symbol)?.data_symbol || symbol, now)
  const upcomingEvents = upcomingEconEvents(now)
  const strategyName = (id) => strategies.find((s) => s.id === id)?.name || '—'

const calTrades = calStrategy === 'all' ? allTrades : allTrades.filter((t) => t.strategy_id === calStrategy)
  const tradesByDate = {}
    for (const t of calTrades) {
      tradesByDate[t.trade_date] = tradesByDate[t.trade_date] || []
        tradesByDate[t.trade_date].push(t)
    }

const year = calCursor.year
  const month = calCursor.month
  const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}`
  const monthTrades = calTrades.filter((t) => t.trade_date && t.trade_date.startsWith(monthPrefix))
  const monthStats = computeMonthStats(monthTrades)
  const weeks = buildCalendarWeeks(year, month, tradesByDate)
  const selectedTrades = selectedDate ? (tradesByDate[selectedDate] || []) : []
  const todayStr = toDateStr(now.getFullYear(), now.getMonth(), now.getDate())

    function goPrevMonth() {
      setCalCursor((c) => (c.month === 0 ? { year: c.year - 1, month: 11 } : { year: c.year, month: c.month - 1 }))
      setSelectedDate(null)
    }
  function goNextMonth() {
    setCalCursor((c) => (c.month === 11 ? { year: c.year + 1, month: 0 } : { year: c.year, month: c.month + 1 }))
    setSelectedDate(null)
  }

return (
  <div className="page-container">
  <div className="strategy-header-row">
    <h1 className="page-title">{displayName} Futures</h1>
    {instrumentId && <InstrumentMenu instrumentId={instrumentId} symbol={symbol} />}
    <Link href={`/app/${symbol}/log/new`} className="new-trade-btn"><Plus size={16} /> Log new trade</Link>
  </div>
  <p className="page-subtitle page-subtitle-tight">Your overview for {displayName} futures.</p>
  <div className="header-pills-row">
    <MarketStatusPill />
    <StreakBadge
      streak={streak}
      winLabel={(n) => `${n} ${symbol} win${n === 1 ? '' : 's'} in a row`}
      lossLabel={(n) => `${n} ${symbol} loss${n === 1 ? '' : 'es'} in a row`}
    />
  </div>

  {unclassifiedCount > 0 && (
    <p className="unclassified-note">
  {unclassifiedCount} trade{unclassifiedCount > 1 ? 's' : ''} <span className="unclassified-tag">Unassigned</span> — not counted below until reassigned. <Link href={`/app/${symbol}/log?strategy=unclassified`}>View in Trade Log</Link>
    </p>
   )}

{allTrades.length === 0 ? (
  <div className="panel">
    <EmptyState
      title="No trades yet"
      message={`Log your first trade for ${displayName} to see your stats, strategy performance and P&L calendar here.`}
      actionHref={`/app/${symbol}/log/new`}
      actionLabel="Log new trade"
    />
  </div>
) : (
  <>
<div className="section-heading">All-Time Performance</div>
  <div className="panel">
  <div className="calendar-toolbar">
  <select
    className="calendar-strategy-filter"
    value={perfStrategy}
    onChange={(e) => setPerfStrategy(e.target.value)}
  >
    <option value="all">All strategies</option>
    {sortedStrategies.map((s) => (
      <option key={s.id} value={s.id}>{s.name}</option>
    ))}
  </select>
  <FlippingStatChips views={flipViews} />
  </div>

  <div className="stats stats-5">
  <div className="stat">
  <div className="stat-label">Total P&amp;L</div>
  <div className={`stat-value ${colorClass(overall.hasD ? overall.totalD : overall.totalPnl)}`}>
  {overall.hasD ? fmtD(overall.totalD) : fmtR(overall.totalPnl)}
  </div>
  {overall.hasD && (
  <div className={`stat-subvalue ${colorClass(overall.totalPnl)}`}>{fmtR(overall.totalPnl)}</div>
  )}
  </div>
  <div className="stat">
  <div className="stat-label">Expectancy</div>
  <div className={`stat-value ${colorClass(overall.expectancyD !== null ? overall.expectancyD : overall.expectancy)}`}>
  {overall.expectancyD !== null ? fmtD(overall.expectancyD) : fmtR(overall.expectancy)}
  </div>
  {overall.expectancyD !== null && (
  <div className={`stat-subvalue ${colorClass(overall.expectancy)}`}>{fmtR(overall.expectancy)}</div>
  )}
  </div>
  <div className="stat stat-gauge">
  <div className="stat-label">Win rate</div>
  <WinRateGauge wins={overall.wins} losses={overall.losses} winRate={overall.winRate} />
  </div>
<div className="stat">
  <div className="stat-label">Profit factor</div>
<div className="stat-value neu">{fmtPF(overall.profitFactor)}</div>
  </div>
  <div className="stat">
  <div className="stat-label">Total trades</div>
  <div className="stat-value neu">{overall.n.toLocaleString('en-US')}</div>
  <div className="stat-subvalue neu">{overall.tradingDays} trading day{overall.tradingDays === 1 ? '' : 's'}</div>
  </div>
  </div>

  <div className="performance-card-subgrid">
  <div>
  <div className="stat-label dashboard-card-title">Avg P&amp;L by day of week</div>
  <AvgPnlByWeekdayChart rows={weekdayRows} />
  </div>
  <div>
  <div className="stat-label dashboard-card-title">Equity curve</div>
  <div className="tabs">
  {EQUITY_GROUPS.map((g) => (
    <div
      key={g.value}
      className={`tab ${equityGroup === g.value ? 'tab-active' : ''}`}
      onClick={() => setEquityGroup(g.value)}
    >
      {g.label}
    </div>
  ))}
  </div>
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

<div className="section-heading">At a glance</div>
<div className="instrument-glance-row">
  <div className="panel">
    <div className="stat-label dashboard-card-title">Today&apos;s brief</div>
    <p className="brief-card-text">
      {streak ? `You're on a streak trading ${symbol}, and CPI lands at 08:30.` : `CPI lands at 08:30.`}
      {briefClause ? ` ${briefClause}` : ''}
    </p>
  </div>
  <div className="panel">
    <div className="stat-label dashboard-card-title">Key levels</div>
  </div>
  <div className="panel">
    <div className="stat-label dashboard-card-title">Session stats</div>
    <div className="key-levels-list">
      <div className="key-levels-row">
        <span className="th-with-tooltip">
          Overnight gap
          <TableHeaderTooltip text="Live — how much of the gap between yesterday's close and today's open is still unfilled." />
        </span>
        <span className="stat-placeholder">Needs Phase 2</span>
      </div>
      <div className="key-levels-row">
        <span className="th-with-tooltip">
          Range vs. typical
          <TableHeaderTooltip text="How far price has ranged this session so far, compared to the average range at this same point across the last 20 sessions." />
        </span>
        <span className="stat-placeholder">Needs Phase 2</span>
      </div>
      <div className="key-levels-row">
        <span className="th-with-tooltip">
          Volume vs. typical
          <TableHeaderTooltip text="How much volume has traded so far this session, compared to the average volume at this same point across the last 20 sessions." />
        </span>
        <span className="stat-placeholder">Needs Phase 2</span>
      </div>
    </div>
  </div>
</div>

<div className="market-context-row">
  <div className="panel">
    <div className="stat-label dashboard-card-title">Next calendar event</div>
    {upcomingEvents.length > 0 ? (
      <div className="key-levels-list">
        {upcomingEvents.map((e, i) => (
          <div className="key-levels-row" key={i}>
            <span>{e.event}</span>
            <span>{fmtCountdown(e.timestamp - now)}</span>
          </div>
        ))}
      </div>
    ) : (
      <p className="brief-card-text">No events in the next 24 hours.</p>
    )}
  </div>
  <div className="panel">
    <div className="stat-label dashboard-card-title">Days to rollover</div>
    <div className="stat-value neu">{rolloverDays === null ? '—' : `${rolloverDays}d`}</div>
  </div>
</div>

<div className="section-heading">Monthly P&L</div>
<div className="panel">
  <div className="calendar-toolbar">
  <select
className="calendar-strategy-filter"
value={calStrategy}
onChange={(e) => { setCalStrategy(e.target.value); setSelectedDate(null) }}
  >
  <option value="all">All strategies</option>
{sortedStrategies.map((s) => (
  <option key={s.id} value={s.id}>{s.name}</option>
))}
  </select>
<div className="calendar-month-nav">
  <button type="button" className="calendar-nav-btn" onClick={goPrevMonth} aria-label="Previous month"><ChevronLeft size={18} /></button>
<div className="calendar-month-label">{MONTH_NAMES[month]} {year}</div>
  <button type="button" className="calendar-nav-btn" onClick={goNextMonth} aria-label="Next month"><ChevronRight size={18} /></button>
  </div>
  </div>

<div className="stats stats-5">
  <div className="stat">
  <div className="stat-label">Monthly P&L</div>
<div className={`stat-value ${colorClass(monthStats.hasD ? monthStats.totalD : monthStats.totalR)}`}>
{monthStats.hasD ? fmtD(monthStats.totalD) : fmtR(monthStats.totalR)}
</div>
{monthStats.hasD && (
  <div className={`stat-subvalue ${colorClass(monthStats.totalR)}`}>{fmtR(monthStats.totalR)}</div>
)}
</div>
<div className="stat">
  <div className="stat-label">Expectancy</div>
<div className={`stat-value ${colorClass(monthStats.expectancyD !== null ? monthStats.expectancyD : monthStats.expectancyR)}`}>
{monthStats.expectancyD !== null ? fmtD(monthStats.expectancyD) : fmtR(monthStats.expectancyR)}
</div>
{monthStats.expectancyD !== null && (
  <div className={`stat-subvalue ${colorClass(monthStats.expectancyR)}`}>{fmtR(monthStats.expectancyR)}</div>
)}
</div>
<div className="stat stat-gauge">
  <div className="stat-label">Win rate</div>
<WinRateGauge
wins={monthStats.wins}
losses={monthStats.losses}
winRate={monthStats.winRate}
/>
  </div>
<div className="stat">
  <div className="stat-label">Profit factor</div>
<div className="stat-value neu">{fmtPF(monthStats.profitFactor)}</div>
  </div>
<div className="stat">
  <div className="stat-label">Total trades</div>
<div className="stat-value neu">{monthStats.n}</div>
<div className="stat-subvalue neu">{monthStats.tradingDays} trading day{monthStats.tradingDays === 1 ? '' : 's'}</div>
  </div>
  </div>

<div className="calendar-scroll">
<div className="calendar-grid calendar-grid-8 calendar-weekday-row">
{CAL_HEADINGS.map((h, hi) => (
  <div key={h} className={`calendar-weekday ${hi === 7 ? 'calendar-weekday-weekly' : ''}`}>{h}</div>
                  ))}
</div>

{weeks.map((week, wi) => (
  <div className="calendar-grid calendar-grid-8 calendar-week-row" key={wi}>
{week.cells.map((cell) => (
  <div
                key={cell.dateStr}
className={`calendar-cell ${cell.outside ? 'calendar-cell-outside' : ''} ${cell.count > 0 ? 'calendar-cell-has-trades' : ''} ${toneClass(cell.hasD ? cell.sumD : cell.sumR, cell.count)} ${selectedDate === cell.dateStr ? 'calendar-cell-selected' : ''}`}
onClick={() => cell.count > 0 && setSelectedDate(selectedDate === cell.dateStr ? null : cell.dateStr)}
>
<CalendarNewsBadge dateStr={cell.dateStr} />
<div className={`calendar-date-num ${cell.dateStr === todayStr ? 'calendar-date-num-today' : ''}`}>{String(cell.dayNum).padStart(2, '0')}</div>
{cell.count > 0 && (
  <>
  <div className={`calendar-day-pnl ${colorClass(cell.hasD ? cell.sumD : cell.sumR)}`}>
{cell.hasD ? fmtD(cell.sumD) : fmtR(cell.sumR)}
</div>
{cell.hasD && (
  <div className={`calendar-day-subpnl ${colorClass(cell.sumR)}`}>{fmtR(cell.sumR)}</div>
)}
<div className="calendar-day-count">{cell.count} trade{cell.count === 1 ? '' : 's'}</div>
  </>
)}
</div>
))}
<div className={`calendar-cell calendar-cell-weekly ${toneClass(week.weekHasD ? week.weekD : week.weekR, week.weekCount)}`}>
<div className={`calendar-day-pnl ${colorClass(week.weekHasD ? week.weekD : week.weekR)}`}>
{week.weekHasD ? fmtD(week.weekD) : fmtR(week.weekR)}
</div>
{week.weekHasD && (<div className={`calendar-day-subpnl ${colorClass(week.weekR)}`}>{fmtR(week.weekR)}</div>)}
<div className="calendar-day-count">{week.weekCount} trade{week.weekCount === 1 ? '' : 's'}</div>
  </div>
  </div>
))}
</div>

{selectedDate && (
  <>
  <div className="section-heading" style={{ marginTop: '24px' }}>Trades on {selectedDate}</div>
<TradeLogTable trades={selectedTrades} strategyNameById={strategyName} showStrategyColumn={true} showDayColumn={false} showPnlColumn={false} symbol={symbol} />
  </>
)}
</div>
  </>
)}
  </div>
)
}
