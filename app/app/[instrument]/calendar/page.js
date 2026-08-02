'use client'

import { useState, useEffect } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { supabase } from '../../../../lib/supabaseClient'
import TradeLogTable from '../../../../components/TradeLogTable'

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']
const WEEKDAY_LABELS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']

function toDateStr(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

export default function CalendarPage({ params }) {
  const symbol = params.instrument
  const [loading, setLoading] = useState(true)
  const [strategies, setStrategies] = useState([])
  const [trades, setTrades] = useState([])
  const [cursor, setCursor] = useState(() => { const n = new Date(); return { year: n.getFullYear(), month: n.getMonth() } })
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
  .from('strategies').select('*').eq('instrument_id', instrument.id)
  const { data: tradeData } = await supabase
  .from('trades').select('*').eq('instrument_id', instrument.id)

  setStrategies(stratData || [])
  setTrades(tradeData || [])
  setLoading(false)
}

if (loading) return <div className="page-loading">Loading…</div>

const strategyName = (id) => strategies.find((s) => s.id === id)?.name || '—'

const { year, month } = cursor
  const firstOfMonth = new Date(year, month, 1)
  const startWeekday = firstOfMonth.getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()

const tradesByDate = {}
  for (const t of trades) {
    tradesByDate[t.trade_date] = tradesByDate[t.trade_date] || []
      tradesByDate[t.trade_date].push(t)
  }

const cells = []
  for (let i = 0; i < startWeekday; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)

function goPrevMonth() {
  setCursor((c) => c.month === 0 ? { year: c.year - 1, month: 11 } : { year: c.year, month: c.month - 1 })
  setSelectedDate(null)
}
  function goNextMonth() {
    setCursor((c) => c.month === 11 ? { year: c.year + 1, month: 0 } : { year: c.year, month: c.month + 1 })
    setSelectedDate(null)
  }

const selectedTrades = selectedDate ? (tradesByDate[selectedDate] || []) : []

  return (
    <div className="page-container">
    <h1 className="page-title">{symbol} — Calendar</h1>
  <p className="page-subtitle">Click a day to see the trades logged on it.</p>

<div className="panel">
    <div className="calendar-header">
    <button className="calendar-nav-btn" onClick={goPrevMonth}><ChevronLeft size={18} /></button>
  <div className="calendar-month-label">{MONTH_NAMES[month]} {year}</div>
<button className="calendar-nav-btn" onClick={goNextMonth}><ChevronRight size={18} /></button>
  </div>

<div className="calendar-grid calendar-weekday-row">
{WEEKDAY_LABELS.map((w) => <div key={w} className="calendar-weekday">{w}</div>)}
                    </div>

                    <div className="calendar-grid">
                    {cells.map((d, i) => {
                      if (d === null) return <div key={i} className="calendar-cell calendar-cell-empty" />
                        const dateStr = toDateStr(year, month, d)
                      const dayTrades = tradesByDate[dateStr] || []
                        const classifiedDayTrades = dayTrades.filter((t) => t.strategy_id)
                      const dayPnl = classifiedDayTrades.reduce((s, t) => s + t.r_multiple, 0)
                      const isSelected = selectedDate === dateStr
                      return (
                        <div
                      key={i}
                      className={`calendar-cell ${dayTrades.length > 0 ? 'calendar-cell-has-trades' : ''} ${isSelected ? 'calendar-cell-selected' : ''}`}
                               onClick={() => dayTrades.length > 0 && setSelectedDate(isSelected ? null : dateStr)}
>
  <div className="calendar-date-num">{d}</div>
{dayTrades.length > 0 && (
  <>
{classifiedDayTrades.length > 0 ? (
  <div className={`calendar-day-pnl ${dayPnl > 0 ? 'pos' : dayPnl < 0 ? 'neg' : 'neu'}`}>
{(dayPnl >= 0 ? '+' : '') + dayPnl.toFixed(2)}R
  </div>
) : (
  <div className="calendar-day-pnl neu">—</div>
)}
<div className="calendar-day-count">{dayTrades.length} trade{dayTrades.length > 1 ? 's' : ''}</div>
  </>
)}
</div>
)
})}
</div>
  </div>

{selectedDate && (
  <>
  <div className="section-heading">Trades on {selectedDate}</div>
 <div className="panel">
  <TradeLogTable trades={selectedTrades} strategyNameById={strategyName} showStrategyColumn={true} symbol={symbol}/>
  </div>
  </>
 )}
</div>
)
}
