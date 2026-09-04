'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { strategyColor } from '@/lib/strategyColor'
import { hasResult } from '@/lib/tradeMath'
import { queryPerformance } from '@/lib/edgeEngine'
import { totalTradeCount } from '@/lib/insightData'
import EdgeInsightsPanel from '@/components/EdgeInsightsPanel'
import { pickGreeting } from '@/lib/greeting'
import { computeStreak } from '@/lib/streak'
import { daysToRollover } from '@/lib/contractRollover'
import EquityCurveChart from '@/components/EquityCurveChart'
import FlippingStatChips from '@/components/FlippingStatChips'
import AvgPnlByWeekdayChart from '@/components/AvgPnlByWeekdayChart'
import WinRateGauge from '@/components/WinRateGauge'
import EconomicCalendarCard from '@/components/EconomicCalendarCard'
import CalendarNewsBadge from '@/components/CalendarNewsBadge'
import StreakBadge from '@/components/StreakBadge'
import TableHeaderTooltip from '@/components/TableHeaderTooltip'
import TradeLogTable from '@/components/TradeLogTable'
import LogTradeMenu from '@/components/LogTradeMenu'
import MarketStatusPill from '@/components/MarketStatusPill'
import HeaderClock from '@/components/HeaderClock'
import OverviewSkeleton from '@/components/OverviewSkeleton'
import EmptyState from '@/components/EmptyState'
import PageError from '@/components/PageError'

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']
const CAL_HEADINGS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat','Weekly P&L']
const EQUITY_GROUPS = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
]

function hasDollar(t) {
  return t.pnl !== null && t.pnl !== undefined
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
function toDateStr(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}
function toneClass(value, count) {
  if (!count) return ''
  return value > 0 ? 'calendar-cell-win' : value < 0 ? 'calendar-cell-loss' : ''
}

// Overall stats across every trade handed in, independent of strategy
// assignment - unlike the per-instrument dashboard, this view has no
// strategy grouping to exclude unclassified trades from.
function computeOverallStats(allTrades) {
  // winRate/expectancy/profitFactor come from the Edge Engine (the one
  // shared implementation - see lib/edgeEngine.js) rather than being
  // computed here a fourth time; everything below is either dollar-
  // denominated (out of the engine's scope, which is R-only) or a plain
  // count the WinRateGauge/equity-curve math below still needs directly.
  const perf = queryPerformance({ trades: allTrades, groupBy: null })
  const trades = allTrades.filter(hasResult)
  const tradingDays = new Set(allTrades.filter((t) => t.trade_date).map((t) => t.trade_date)).size
  if (perf.n === 0) {
    return {
      n: perf.n, tradingDays, winRate: null, expectancy: null, expectancyD: null,
      totalPnl: null, totalD: null, hasD: false, profitFactor: null, wins: 0, losses: 0,
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
    n: perf.n, tradingDays, winRate: perf.winRate, expectancy: perf.expectancy, expectancyD,
    totalPnl, totalD, hasD, profitFactor: perf.profitFactor, wins: wins.length, losses: losses.length,
  }
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

export default function OverviewDashboard({ instruments, strategies }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [allTrades, setAllTrades] = useState([])
  const [greeting, setGreeting] = useState('')
  const [equityGroup, setEquityGroup] = useState('day')
  const [perfInstrument, setPerfInstrument] = useState('all')
  const [calInstrument, setCalInstrument] = useState('all')
  const [calCursor, setCalCursor] = useState(() => { const n = new Date(); return { year: n.getFullYear(), month: n.getMonth() } })
  const [selectedDate, setSelectedDate] = useState(null)

  const instrumentIds = instruments.map((i) => i.id).join(',')

  useEffect(() => {
    // Zero instruments (a brand-new account, or an existing one that's
    // archived every instrument it had) has nothing to fetch - the render
    // below returns before any of this data would be used anyway.
    if (instruments.length === 0) { setLoading(false); return }
    loadData()
  }, [instrumentIds])

  async function loadData() {
    setLoading(true)
    setError(null)
    try {
      const ids = instruments.map((i) => i.id)

      const { data: tradeData, error: tradeError } = await supabase
        .from('trades').select('*').in('instrument_id', ids)
      if (tradeError) throw tradeError

      setAllTrades(tradeData || [])

      const { data: { user } } = await supabase.auth.getUser()
      setGreeting(pickGreeting(user?.user_metadata?.full_name))
    } catch {
      setError('something went wrong.')
    } finally {
      setLoading(false)
    }
  }

  // Genuinely nothing to show yet - no greeting, no pills, no panels, just
  // the prompt to add one. Checked before the loading/error gates below
  // (which only ever matter once there's data worth fetching), so this
  // never flashes a skeleton first. Also what makes firstInstrument below
  // safe to use unconditionally: instruments.length > 0 is guaranteed by
  // the time any code past this point runs.
  if (instruments.length === 0) {
    return (
      <div className="page-container zero-instruments-empty">
        <p className="zero-instruments-message">To get started, add your first instrument.</p>
      </div>
    )
  }

  if (loading) return <OverviewSkeleton />
  if (error) return <div className="page-container"><PageError message={`Couldn't load your dashboard — ${error}`} onRetry={loadData} /></div>

  const instrumentById = {}
  instruments.forEach((inst, i) => { instrumentById[inst.id] = { ...inst, color: strategyColor(i) } })
  const strategyName = (id) => strategies.find((s) => s.id === id)?.name || '—'

  const streak = computeStreak(allTrades)

  const briefText = streak
    ? `You're ${streak.count} ${streak.isWin ? 'wins' : 'losses'} deep, and CPI drops at 08:30.`
    : 'Markets are active today and CPI drops at 08:30 — worth keeping an eye on.'

  const now = new Date()

  const perfTrades = perfInstrument === 'all' ? allTrades : allTrades.filter((t) => t.instrument_id === perfInstrument)
  const overall = computeOverallStats(perfTrades)
  const equityPoints = buildEquityCurve(perfTrades, equityGroup)
  const weekdayRows = computeWeekdayPnl(perfTrades)

  // Always every instrument's own total, regardless of perfInstrument -
  // the filter dims the others in the list rather than removing them, so
  // their totals need to stay on screen to dim.
  const instrumentSegments = instruments.map((inst, i) => {
    const trades = allTrades.filter((t) => t.instrument_id === inst.id && hasResult(t) && hasDollar(t))
    return { id: inst.id, label: inst.symbol, value: trades.reduce((s, t) => s + t.pnl, 0), color: strategyColor(i) }
  })

  // Full per-instrument stats (independent of allTrades filtering by
  // perfInstrument, same reasoning as instrumentSegments above) - feeds
  // the 4 other faces FlippingStatChips cycles through beside P&L.
  const perInstrumentStats = instruments.map((inst, i) => ({
    id: inst.id,
    label: inst.symbol,
    color: strategyColor(i),
    stats: computeOverallStats(allTrades.filter((t) => t.instrument_id === inst.id)),
  }))

  const flipViews = [
    {
      label: 'Total P&L',
      segments: instrumentSegments
        .slice()
        .sort((a, b) => b.value - a.value)
        .map((seg) => ({ id: seg.id, label: seg.label, color: seg.color, value: fmtD(seg.value), tone: colorClass(seg.value) })),
    },
    {
      label: 'Expectancy',
      segments: perInstrumentStats
        .slice()
        .sort((a, b) => (b.stats.expectancyD ?? b.stats.expectancy ?? -Infinity) - (a.stats.expectancyD ?? a.stats.expectancy ?? -Infinity))
        .map(({ id, label, color, stats }) => ({
          id, label, color,
          value: stats.expectancyD !== null ? `${fmtD(stats.expectancyD)} (${fmtR(stats.expectancy)})` : fmtR(stats.expectancy),
          tone: colorClass(stats.expectancyD !== null ? stats.expectancyD : stats.expectancy),
        })),
    },
    {
      label: 'Win rate',
      segments: perInstrumentStats
        .slice()
        .sort((a, b) => (b.stats.winRate ?? -Infinity) - (a.stats.winRate ?? -Infinity))
        .map(({ id, label, color, stats }) => ({
          id, label, color,
          value: stats.winRate === null ? '—' : stats.winRate.toFixed(1) + '%',
          tone: stats.winRate !== null && stats.winRate < 50 ? 'neg' : 'neu',
        })),
    },
    {
      label: 'Profit factor',
      segments: perInstrumentStats
        .slice()
        .sort((a, b) => (b.stats.profitFactor ?? -Infinity) - (a.stats.profitFactor ?? -Infinity))
        .map(({ id, label, color, stats }) => ({ id, label, color, value: fmtPF(stats.profitFactor), tone: 'neu' })),
    },
    {
      label: 'Total trades',
      segments: perInstrumentStats
        .slice()
        .sort((a, b) => b.stats.n - a.stats.n)
        .map(({ id, label, color, stats }) => ({ id, label, color, value: stats.n.toLocaleString('en-US'), tone: 'neu' })),
    },
  ]

  const recentTrades = allTrades
    .filter(hasResult)
    .slice()
    .sort((a, b) => b.trade_date.localeCompare(a.trade_date) || (b.trade_time || '').localeCompare(a.trade_time || ''))
    .slice(0, 5)

  const calTrades = calInstrument === 'all' ? allTrades : allTrades.filter((t) => t.instrument_id === calInstrument)
  const tradesByDate = {}
  for (const t of calTrades) {
    tradesByDate[t.trade_date] = tradesByDate[t.trade_date] || []
    tradesByDate[t.trade_date].push(t)
  }

  const year = calCursor.year
  const month = calCursor.month
  const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}`
  const monthTrades = calTrades.filter((t) => t.trade_date && t.trade_date.startsWith(monthPrefix))
  const monthStats = computeOverallStats(monthTrades)
  const weeks = buildCalendarWeeks(year, month, tradesByDate)
  const selectedTrades = selectedDate ? (tradesByDate[selectedDate] || []) : []
  const todayNow = new Date()
  const todayStr = toDateStr(todayNow.getFullYear(), todayNow.getMonth(), todayNow.getDate())

  function goPrevMonth() {
    setCalCursor((c) => (c.month === 0 ? { year: c.year - 1, month: 11 } : { year: c.year, month: c.month - 1 }))
    setSelectedDate(null)
  }
  function goNextMonth() {
    setCalCursor((c) => (c.month === 11 ? { year: c.year + 1, month: 0 } : { year: c.year, month: c.month + 1 }))
    setSelectedDate(null)
  }

  const firstInstrument = instruments[0]

  return (
    <div className="page-container content-fade-in">
      <div className="page-header-row">
        <h1 className="page-title">{greeting}</h1>
        <HeaderClock />
      </div>
      <p className="page-subtitle page-subtitle-tight">Here&apos;s what you need to know.</p>
      <div className="header-pills-row">
        <MarketStatusPill />
        <StreakBadge
          streak={streak}
          winLabel={(n) => `${n}-trade win streak`}
          lossLabel={(n) => `${n}-trade losing streak`}
        />
        <LogTradeMenu instruments={instruments} />
      </div>

      {allTrades.length === 0 ? (
        <div className="panel">
          <EmptyState
            title="No trades yet"
            message="Log your first trade to see your combined stats, equity curve and P&L calendar here."
            actionHref={`/app/${firstInstrument.symbol}/log/new`}
            actionLabel="Log new trade"
          />
        </div>
      ) : (
        <>
          <div className="dashboard-split brief-calendar-row">
            <div>
              <div className="panel">
                <div className="stat-label dashboard-card-title">Today&apos;s brief</div>
                <p className="brief-card-text">{briefText}</p>
              </div>
            </div>
            <div>
              <div className="panel">
                <div className="stat-label dashboard-card-title">Economic calendar</div>
                <EconomicCalendarCard />
              </div>
            </div>
          </div>

          <div className="market-context-row">
            <div className="panel">
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Instrument</th>
                      <th>
                        <span className="th-with-tooltip">
                          Days to rollover
                          <TableHeaderTooltip text="Front-month rollover/expiration date for this contract - liquidity shifts to the next expiry once trading in this one ends." />
                        </span>
                      </th>
                      <th>
                        <span className="th-with-tooltip">
                          Range vs. typical
                          <TableHeaderTooltip text="How far price has ranged this session so far, compared to the average range at this same point across the last 20 sessions." />
                        </span>
                      </th>
                      <th>
                        <span className="th-with-tooltip">
                          Volume vs. typical
                          <TableHeaderTooltip text="How much volume has traded so far this session, compared to the average volume at this same point across the last 20 sessions." />
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {instruments.map((inst) => {
                      const days = daysToRollover(inst.data_symbol || inst.symbol, now)
                      return (
                        <tr key={inst.id}>
                          <td>{inst.symbol}</td>
                          <td>{days === null ? '—' : `${days}d`}</td>
                          <td className="stat-placeholder">Not available yet</td>
                          <td className="stat-placeholder">Not available yet</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div className="section-heading">All-Time Performance</div>
          <div className="panel">
            <div className="calendar-toolbar">
              <select
                className="calendar-strategy-filter"
                value={perfInstrument}
                onChange={(e) => setPerfInstrument(e.target.value)}
              >
                <option value="all">All instruments</option>
                {instruments.map((inst) => (
                  <option key={inst.id} value={inst.id}>{inst.symbol}</option>
                ))}
              </select>
              <FlippingStatChips views={flipViews} />
            </div>

            {/* key + .stats-refreshable replay the stat-value fade whenever
                the instrument filter changes these numbers in place - see
                .stats-refreshable in globals.css. */}
            <div className="stats stats-5 stats-refreshable" key={perfInstrument}>
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

          <div className="section-heading">Edge Insights</div>
          <div className="panel">
            <EdgeInsightsPanel scope="overall" tradeCount={totalTradeCount(allTrades)} />
          </div>

          <div className="section-heading">Monthly P&L</div>
          <div className="panel">
            <div className="calendar-toolbar">
              <select
                className="calendar-strategy-filter"
                value={calInstrument}
                onChange={(e) => { setCalInstrument(e.target.value); setSelectedDate(null) }}
              >
                <option value="all">All instruments</option>
                {instruments.map((inst) => (
                  <option key={inst.id} value={inst.id}>{inst.symbol}</option>
                ))}
              </select>
              <div className="calendar-month-nav">
                <button type="button" className="calendar-nav-btn" onClick={goPrevMonth} aria-label="Previous month"><ChevronLeft size={18} /></button>
                <div className="calendar-month-label">{MONTH_NAMES[month]} {year}</div>
                <button type="button" className="calendar-nav-btn" onClick={goNextMonth} aria-label="Next month"><ChevronRight size={18} /></button>
              </div>
            </div>

            <div className="stats stats-5 stats-refreshable" key={`${calInstrument}-${year}-${month}`}>
              <div className="stat">
                <div className="stat-label">Monthly P&L</div>
                <div className={`stat-value ${colorClass(monthStats.hasD ? monthStats.totalD : monthStats.totalPnl)}`}>
                  {monthStats.hasD ? fmtD(monthStats.totalD) : fmtR(monthStats.totalPnl)}
                </div>
                {monthStats.hasD && (
                  <div className={`stat-subvalue ${colorClass(monthStats.totalPnl)}`}>{fmtR(monthStats.totalPnl)}</div>
                )}
              </div>
              <div className="stat">
                <div className="stat-label">Expectancy</div>
                <div className={`stat-value ${colorClass(monthStats.expectancyD !== null ? monthStats.expectancyD : monthStats.expectancy)}`}>
                  {monthStats.expectancyD !== null ? fmtD(monthStats.expectancyD) : fmtR(monthStats.expectancy)}
                </div>
                {monthStats.expectancyD !== null && (
                  <div className={`stat-subvalue ${colorClass(monthStats.expectancy)}`}>{fmtR(monthStats.expectancy)}</div>
                )}
              </div>
              <div className="stat stat-gauge">
                <div className="stat-label">Win rate</div>
                <WinRateGauge wins={monthStats.wins} losses={monthStats.losses} winRate={monthStats.winRate} />
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
                <TradeLogTable
                  trades={selectedTrades}
                  strategyNameById={strategyName}
                  showStrategyColumn
                  showDayColumn={false}
                  showInstrumentColumn
                  instrumentSymbolFor={(t) => instrumentById[t.instrument_id]?.symbol}
                  instrumentColorFor={(t) => instrumentById[t.instrument_id]?.color}
                />
              </>
            )}
          </div>

          <div className="section-heading">Recent trades</div>
          <div className="panel">
            <TradeLogTable
              trades={recentTrades}
              strategyNameById={strategyName}
              showStrategyColumn
              showDayColumn={false}
              showInstrumentColumn
              instrumentSymbolFor={(t) => instrumentById[t.instrument_id]?.symbol}
              instrumentColorFor={(t) => instrumentById[t.instrument_id]?.color}
              showTimeInDate
            />
            <div className="panel-link-row">
              <Link href="/app/log" className="panel-link">View all trades</Link>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
