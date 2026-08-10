'use client'

import { useState, useEffect } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { strategyColor } from '@/lib/strategyColor'
import { hasResult } from '@/lib/tradeMath'
import EquityCurveChart from '@/components/EquityCurveChart'
import PnlByInstrumentDonut from '@/components/PnlByInstrumentDonut'
import WinRateGauge from '@/components/WinRateGauge'
import DashboardSkeleton from '@/components/DashboardSkeleton'
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

// Overall stats across every trade handed in, independent of strategy
// assignment - unlike the per-instrument dashboard, this view has no
// strategy grouping to exclude unclassified trades from.
function computeOverallStats(allTrades) {
  const trades = allTrades.filter(hasResult)
  const n = trades.length
  const tradingDays = new Set(allTrades.filter((t) => t.trade_date).map((t) => t.trade_date)).size
  if (n === 0) {
    return {
      n, tradingDays, winRate: null, avgR: null, expectancy: null, expectancyD: null,
      totalPnl: null, totalD: null, hasD: false, profitFactor: null, wins: 0, breakeven: 0, losses: 0,
    }
  }

  const wins = trades.filter((t) => t.r_multiple > 0)
  const losses = trades.filter((t) => t.r_multiple < 0)
  const breakeven = trades.filter((t) => t.r_multiple === 0)
  const wr = wins.length / n
  const totalPnl = trades.reduce((s, t) => s + t.r_multiple, 0)
  const avgR = totalPnl / n
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.r_multiple, 0) / wins.length : 0
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.r_multiple, 0) / losses.length : 0
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

  return {
    n, tradingDays, winRate: wr * 100, avgR, expectancy, expectancyD, totalPnl, totalD, hasD,
    profitFactor, wins: wins.length, breakeven: breakeven.length, losses: losses.length,
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
  const [equityGroup, setEquityGroup] = useState('day')
  const [calInstrument, setCalInstrument] = useState('all')
  const [calCursor, setCalCursor] = useState(() => { const n = new Date(); return { year: n.getFullYear(), month: n.getMonth() } })
  const [selectedDate, setSelectedDate] = useState(null)

  const instrumentIds = instruments.map((i) => i.id).join(',')

  useEffect(() => {
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
    } catch (err) {
      setError(err.message || "Couldn't load your dashboard — something went wrong.")
    } finally {
      setLoading(false)
    }
  }

  if (loading) return <DashboardSkeleton />
  if (error) return <div className="page-container"><PageError message={`Couldn't load your dashboard — ${error}`} onRetry={loadData} /></div>

  const instrumentById = {}
  instruments.forEach((inst, i) => { instrumentById[inst.id] = { ...inst, color: strategyColor(i) } })
  const strategyName = (id) => strategies.find((s) => s.id === id)?.name || '—'

  const overall = computeOverallStats(allTrades)

  const equityPoints = buildEquityCurve(allTrades, equityGroup)

  const instrumentSegments = instruments.map((inst, i) => {
    const trades = allTrades.filter((t) => t.instrument_id === inst.id && hasResult(t) && hasDollar(t))
    return { symbol: inst.symbol, value: trades.reduce((s, t) => s + t.pnl, 0), color: strategyColor(i) }
  })

  const recentTrades = allTrades
    .filter(hasResult)
    .slice()
    .sort((a, b) => b.trade_date.localeCompare(a.trade_date) || (b.trade_time || '').localeCompare(a.trade_time || ''))
    .slice(0, 8)

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
    <div className="page-container">
      <h1 className="page-title">DASHBOARD</h1>
      <p className="page-subtitle">Your performance overview across all instruments.</p>

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
            <div className="stat stat-gauge">
              <div className="stat-label">Win rate</div>
              <WinRateGauge wins={overall.wins} breakeven={overall.breakeven} losses={overall.losses} winRate={overall.winRate} />
            </div>
            <div className="stat">
              <div className="stat-label">Profit factor</div>
              <div className="stat-value neu">{fmtPF(overall.profitFactor)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Average R</div>
              <div className={`stat-value ${colorClass(overall.avgR)}`}>{fmtR(overall.avgR)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Total trades</div>
              <div className="stat-value neu">{overall.n}</div>
              <div className="stat-subvalue neu">{overall.tradingDays} trading day{overall.tradingDays === 1 ? '' : 's'}</div>
            </div>
          </div>

          <div className="section-heading">Equity curve</div>
          <div className="panel">
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

          <div className="section-heading">P&amp;L by instrument</div>
          <div className="panel">
            <PnlByInstrumentDonut segments={instrumentSegments} />
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

            <div className="stats stats-5">
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
                <div className="stat-label">Total trades</div>
                <div className="stat-value neu">{monthStats.n}</div>
              </div>
              <div className="stat stat-gauge">
                <div className="stat-label">Win rate</div>
                <WinRateGauge wins={monthStats.wins} breakeven={monthStats.breakeven} losses={monthStats.losses} winRate={monthStats.winRate} />
              </div>
              <div className="stat">
                <div className="stat-label">Average R</div>
                <div className={`stat-value ${colorClass(monthStats.avgR)}`}>{fmtR(monthStats.avgR)}</div>
              </div>
              <div className="stat">
                <div className="stat-label">Trade expectancy</div>
                <div className={`stat-value ${colorClass(monthStats.expectancyD !== null ? monthStats.expectancyD : monthStats.expectancy)}`}>
                  {monthStats.expectancyD !== null ? fmtD(monthStats.expectancyD) : fmtR(monthStats.expectancy)}
                </div>
                {monthStats.expectancyD !== null && (
                  <div className={`stat-subvalue ${colorClass(monthStats.expectancy)}`}>{fmtR(monthStats.expectancy)}</div>
                )}
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
            </div>

            {selectedDate && (
              <>
                <div className="section-heading" style={{ marginTop: '24px' }}>Trades on {selectedDate}</div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr><th>Instrument</th><th>Strategy</th><th>Direction</th><th>R</th><th>P&amp;L</th></tr>
                    </thead>
                    <tbody>
                      {selectedTrades.map((t) => {
                        const inst = instrumentById[t.instrument_id]
                        const closed = hasResult(t)
                        const rClass = !closed ? 'r-zero' : t.r_multiple > 0 ? 'r-pos' : t.r_multiple < 0 ? 'r-neg' : 'r-zero'
                        return (
                          <tr key={t.id}>
                            <td>
                              <span className="strategy-dot" style={{ background: inst?.color, marginRight: '8px', verticalAlign: 'middle' }} />
                              {inst?.symbol || '—'}
                            </td>
                            <td>{t.strategy_id ? strategyName(t.strategy_id) : <span className="unclassified-tag">Unassigned</span>}</td>
                            <td style={{ color: t.direction === 'long' ? 'var(--win)' : 'var(--loss)' }}>{t.direction.toUpperCase()}</td>
                            <td>{closed ? <span className={`r-pill ${rClass}`}>{(t.r_multiple >= 0 ? '+' : '') + t.r_multiple.toFixed(2)}R</span> : <span className="r-pill r-open">Open</span>}</td>
                            <td className={t.pnl == null ? '' : t.pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}>{fmtD(t.pnl)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>

          <div className="section-heading">Recent trades</div>
          <div className="panel">
            <div className="table-scroll">
              <table>
                <thead>
                  <tr><th>Time</th><th>Instrument</th><th>Strategy</th><th>R</th><th>P&amp;L</th></tr>
                </thead>
                <tbody>
                  {recentTrades.map((t) => {
                    const inst = instrumentById[t.instrument_id]
                    const rClass = t.r_multiple > 0 ? 'r-pos' : t.r_multiple < 0 ? 'r-neg' : 'r-zero'
                    return (
                      <tr key={t.id}>
                        <td>{t.trade_date}{t.trade_time ? ` ${t.trade_time}` : ''}</td>
                        <td>
                          <span className="strategy-dot" style={{ background: inst?.color, marginRight: '8px', verticalAlign: 'middle' }} />
                          {inst?.symbol || '—'}
                        </td>
                        <td>{t.strategy_id ? strategyName(t.strategy_id) : <span className="unclassified-tag">Unassigned</span>}</td>
                        <td><span className={`r-pill ${rClass}`}>{(t.r_multiple >= 0 ? '+' : '') + t.r_multiple.toFixed(2)}R</span></td>
                        <td className={t.pnl == null ? '' : t.pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}>{fmtD(t.pnl)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="panel-link-row">
              <a href="/app/log" className="panel-link">View all trades →</a>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
