'use client'

import { useState, useEffect } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { catalogEntryFor } from '@/lib/instrumentCatalog'
import { strategyColor } from '@/lib/strategyColor'
import { hasResult } from '@/lib/tradeMath'
import TradeLogTable from '@/components/TradeLogTable'
import WinRateGauge from '@/components/WinRateGauge'
import PageLoading from '@/components/PageLoading'

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']
const CAL_HEADINGS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat','Weekly P&L']

function computeStats(allTrades) {
  // Open trades (no exit price, so no R yet) can't be scored — leaving them
  // in would count them as breakeven and drag every average down.
  const trades = allTrades.filter(hasResult)
  const n = trades.length
  if (n === 0) return { n, winRate: null, avgR: null, expectancy: null, totalPnl: null, profitFactor: null, totalD: null, hasD: false, expectancyD: null }

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

const withD = trades.filter(hasDollar)
  const hasD = withD.length > 0
  const totalD = hasD ? withD.reduce((s, t) => s + t.pnl, 0) : null
  const winsD = wins.filter(hasDollar)
  const lossesD = losses.filter(hasDollar)
  const avgWinD = winsD.length ? winsD.reduce((s, t) => s + t.pnl, 0) / winsD.length : 0
  const avgLossD = lossesD.length ? lossesD.reduce((s, t) => s + t.pnl, 0) / lossesD.length : 0
  const expectancyD = hasD ? wr * avgWinD + (1 - wr) * avgLossD : null

return { n, winRate, avgR, expectancy, totalPnl, profitFactor, totalD, hasD, expectancyD }
}

function hasDollar(t) {
  return t.pnl !== null && t.pnl !== undefined
}

function computeMonthStats(allTrades) {
  const trades = allTrades.filter(hasResult)
  const n = trades.length
  if (n === 0) return { n, winRate: null, avgR: null, expectancyR: null, expectancyD: null, totalR: null, totalD: null, hasD: false, wins: 0, breakeven: 0, losses: 0 }

const wins = trades.filter((t) => t.r_multiple > 0)
  const losses = trades.filter((t) => t.r_multiple < 0)
  const breakeven = trades.filter((t) => t.r_multiple === 0)
  const wr = wins.length / n

const totalR = trades.reduce((s, t) => s + t.r_multiple, 0)
  const avgR = totalR / n
  const avgWinR = wins.length ? wins.reduce((s, t) => s + t.r_multiple, 0) / wins.length : 0
  const avgLossR = losses.length ? losses.reduce((s, t) => s + t.r_multiple, 0) / losses.length : 0
  const expectancyR = wr * avgWinR + (1 - wr) * avgLossR

const withD = trades.filter(hasDollar)
  const hasD = withD.length > 0
  const totalD = hasD ? withD.reduce((s, t) => s + t.pnl, 0) : null
  const winsD = wins.filter(hasDollar)
  const lossesD = losses.filter(hasDollar)
  const avgWinD = winsD.length ? winsD.reduce((s, t) => s + t.pnl, 0) / winsD.length : 0
  const avgLossD = lossesD.length ? lossesD.reduce((s, t) => s + t.pnl, 0) / lossesD.length : 0
  const expectancyD = hasD ? wr * avgWinD + (1 - wr) * avgLossD : null

return { n, winRate: wr * 100, avgR, expectancyR, expectancyD, totalR, totalD, hasD, wins: wins.length, breakeven: breakeven.length, losses: losses.length }
}

function fmtR(val) {
  if (val === null || val === undefined) return '—'
  return (val >= 0 ? '+' : '') + val.toFixed(2) + 'R'
}
function fmtD(val) {
  if (val === null || val === undefined) return '—'
  return (val >= 0 ? '+$' : '-$') + Math.abs(val).toFixed(2)
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
  const symbol = params.instrument
  const displayName = catalogEntryFor(symbol)?.display_name || symbol
  const [loading, setLoading] = useState(true)
  const [strategies, setStrategies] = useState([])
  const [tradesByStrategy, setTradesByStrategy] = useState({})
  const [allTrades, setAllTrades] = useState([])
  const [calCursor, setCalCursor] = useState(() => { const n = new Date(); return { year: n.getFullYear(), month: n.getMonth() } })
  const [calStrategy, setCalStrategy] = useState('all')
  const [selectedDate, setSelectedDate] = useState(null)

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

if (loading) return <PageLoading />

const classifiedTrades = allTrades.filter((t) => t.strategy_id)
  const unclassifiedCount = allTrades.length - classifiedTrades.length
  const overall = computeStats(classifiedTrades)
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
  <h1 className="page-title"><span className="page-title-symbol">{symbol}</span> DASHBOARD</h1>
  <p className="page-subtitle">Your performance overview for {displayName} futures.</p>

  {unclassifiedCount > 0 && (
    <p className="unclassified-note">
  {unclassifiedCount} trade{unclassifiedCount > 1 ? 's' : ''} <span className="unclassified-tag">Unassigned</span> — not counted below until reassigned. <a href={`/app/${symbol}/log?strategy=unclassified`}>View in Trades log</a>
    </p>
   )}

<div className="section-heading">Overview</div>
  <div className="stats stats-6">
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
<div className="stat">
  <div className="stat-label">Profit factor</div>
<div className="stat-value neu">{fmtPF(overall.profitFactor)}</div>
  </div>
  <div className="stat">
  <div className="stat-label">Win rate</div>
  <div className="stat-value neu">{overall.winRate === null ? '—' : overall.winRate.toFixed(1) + '%'}</div>
  </div>
<div className="stat">
  <div className="stat-label">Average R</div>
<div className={`stat-value ${colorClass(overall.avgR)}`}>{fmtR(overall.avgR)}</div>
  </div>
  <div className="stat">
  <div className="stat-label">Total trades</div>
  <div className="stat-value neu">{overall.n}</div>
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
  <th>Expectancy</th><th>Total P&amp;L</th><th>Profit factor</th>
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

<div className="section-heading">Monthly P&L</div>
<div className="panel">
  <div className="calendar-toolbar">
  <select
className="calendar-strategy-filter"
value={calStrategy}
onChange={(e) => { setCalStrategy(e.target.value); setSelectedDate(null) }}
  >
  <option value="all">All strategies</option>
{strategies.map((s) => (
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
  <div className="stat-label">Total trades</div>
<div className="stat-value neu">{monthStats.n}</div>
  </div>
<div className="stat stat-gauge">
  <div className="stat-label">Win rate</div>
<WinRateGauge
wins={monthStats.wins}
breakeven={monthStats.breakeven}
losses={monthStats.losses}
winRate={monthStats.winRate}
/>
  </div>
<div className="stat">
  <div className="stat-label">Average R</div>
<div className={`stat-value ${colorClass(monthStats.avgR)}`}>{fmtR(monthStats.avgR)}</div>
  </div>
<div className="stat">
  <div className="stat-label">Trade expectancy</div>
<div className={`stat-value ${colorClass(monthStats.expectancyD !== null ? monthStats.expectancyD : monthStats.expectancyR)}`}>
{monthStats.expectancyD !== null ? fmtD(monthStats.expectancyD) : fmtR(monthStats.expectancyR)}
</div>
{monthStats.expectancyD !== null && (
  <div className={`stat-subvalue ${colorClass(monthStats.expectancyR)}`}>{fmtR(monthStats.expectancyR)}</div>
)}
</div>
  </div>

<div className="calendar-grid calendar-grid-8 calendar-weekday-row">
{CAL_HEADINGS.map((h) => (
  <div key={h} className="calendar-weekday">{h}</div>
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
<div className="calendar-date-num">{String(cell.dayNum).padStart(2, '0')}</div>
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

{selectedDate && (
  <>
  <div className="section-heading" style={{ marginTop: '24px' }}>Trades on {selectedDate}</div>
<TradeLogTable trades={selectedTrades} strategyNameById={strategyName} showStrategyColumn={true} showDayColumn={false} showPnlColumn={false} symbol={symbol} />
  </>
)}
</div>
  </div>
)
}
