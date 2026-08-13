'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Calendar, ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react'
import { useClickOutside } from '@/lib/useClickOutside'

const WEEKDAY_HEADERS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
// Kept in sync with .date-range-picker's CSS width - needed here too, to
// clamp the popover on-screen before it's rendered (and thus measurable).
const POPOVER_WIDTH = 280

function pad(n) {
  return String(n).padStart(2, '0')
}
function toDateStr(y, m, d) {
  return `${y}-${pad(m + 1)}-${pad(d)}`
}
function todayStr() {
  const t = new Date()
  return toDateStr(t.getFullYear(), t.getMonth(), t.getDate())
}
function formatTriggerDate(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// 6 full weeks (42 cells) so the grid height never shifts month to month -
// a 4- or 5-week month would otherwise make the popover resize as the
// trader navigates, shifting its own trigger point on a fixed-position
// popover.
function buildMonthCells(year, month) {
  const startWeekday = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const daysInPrevMonth = new Date(year, month, 0).getDate()
  const prevMonth = month === 0 ? 11 : month - 1
  const prevYear = month === 0 ? year - 1 : year
  const nextMonth = month === 11 ? 0 : month + 1
  const nextYear = month === 11 ? year + 1 : year

  const cells = []
  for (let i = 0; i < startWeekday; i++) {
    const d = daysInPrevMonth - startWeekday + 1 + i
    cells.push({ dateStr: toDateStr(prevYear, prevMonth, d), dayNum: d, outside: true })
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ dateStr: toDateStr(year, month, d), dayNum: d, outside: false })
  }
  let nextDay = 1
  while (cells.length < 42) {
    cells.push({ dateStr: toDateStr(nextYear, nextMonth, nextDay), dayNum: nextDay, outside: true })
    nextDay++
  }
  return cells
}

// Self-contained calendar popover for picking a date range with two clicks
// (start, then end - order doesn't matter, a reversed pick gets swapped),
// with a live hover preview of the range while the second click is
// pending. `from`/`to` are the committed ISO date strings; onChange fires
// once, when the second click completes a range.
export default function DateRangePicker({ from, to, onChange }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const [cursor, setCursor] = useState(() => { const d = new Date(from + 'T00:00:00'); return { year: d.getFullYear(), month: d.getMonth() } })
  const [rangeStart, setRangeStart] = useState(from)
  const [rangeEnd, setRangeEnd] = useState(to)
  const [hoverDate, setHoverDate] = useState(null)
  const btnRef = useRef(null)

  const close = useCallback(() => setOpen(false), [])
  const wrapRef = useClickOutside(open, close)

  // Fixed-positioned off a bounding rect captured once at open time (see
  // openPicker below), so it has to close on scroll or it stays pinned to
  // that stale viewport position while the trigger scrolls away underneath
  // it - same reasoning, same fix as ColumnFilter.js/CalendarNewsBadge.js.
  useEffect(() => {
    if (!open) return
    const dismiss = () => setOpen(false)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [open])

  function openPicker() {
    const d = new Date(from + 'T00:00:00')
    setCursor({ year: d.getFullYear(), month: d.getMonth() })
    setRangeStart(from)
    setRangeEnd(to)
    setHoverDate(null)
    const rect = btnRef.current.getBoundingClientRect()
    // This trigger normally sits at the right edge of its toolbar (see
    // EconomicCalendarCard), so anchoring the popover's left edge to the
    // trigger's left edge routinely pushed it off the right side of the
    // viewport - clamp it to the trigger's right edge minus the popover's
    // own (fixed, CSS-defined) width instead, with a small margin either side.
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - 12))
    setPos({ left, top: rect.bottom + 6 })
    setOpen(true)
  }

  function handleDayClick(dateStr) {
    if (rangeStart === null || rangeEnd !== null) {
      setRangeStart(dateStr)
      setRangeEnd(null)
      return
    }
    let s = rangeStart
    let e = dateStr
    if (e < s) { const t = s; s = e; e = t }
    setRangeStart(s)
    setRangeEnd(e)
    onChange(s, e)
    setOpen(false)
  }

  function jumpToToday() {
    const t = todayStr()
    const d = new Date()
    setCursor({ year: d.getFullYear(), month: d.getMonth() })
    setRangeStart(t)
    setRangeEnd(t)
    onChange(t, t)
    setOpen(false)
  }

  function shiftMonth(delta) {
    setCursor((c) => {
      const total = c.year * 12 + c.month + delta
      return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 }
    })
  }

  // While a second click is pending (rangeEnd null), preview the range
  // against whatever's currently hovered instead of just the single
  // rangeStart day, so the trader can see what they're about to pick.
  let lo = rangeStart
  let hi = rangeEnd !== null ? rangeEnd : (hoverDate || rangeStart)
  if (lo && hi && hi < lo) { const t = lo; hi = lo; lo = t }

  const cells = buildMonthCells(cursor.year, cursor.month)
  const today = todayStr()

  return (
    <div className="date-range-picker-wrap" ref={wrapRef}>
      <button type="button" ref={btnRef} className="calendar-strategy-filter econ-date-range-trigger" onClick={() => (open ? setOpen(false) : openPicker())}>
        <Calendar size={13} />
        {from === to ? formatTriggerDate(from) : `${formatTriggerDate(from)} – ${formatTriggerDate(to)}`}
      </button>

      {open && pos && (
        <div className="date-range-picker" style={{ left: `${pos.left}px`, top: `${pos.top}px` }} onMouseLeave={() => setHoverDate(null)}>
          <div className="date-range-picker-header">
            <button type="button" className="calendar-nav-btn" onClick={() => shiftMonth(-1)} aria-label="Previous month"><ChevronLeft size={16} /></button>
            <div className="date-range-picker-month">{MONTH_NAMES[cursor.month]} {cursor.year}</div>
            <button type="button" className="calendar-nav-btn" onClick={() => shiftMonth(1)} aria-label="Next month"><ChevronRight size={16} /></button>
          </div>

          <div className="date-range-grid">
            {WEEKDAY_HEADERS.map((h) => <div className="date-range-weekday" key={h}>{h}</div>)}
            {cells.map((cell) => {
              const isStart = cell.dateStr === lo
              const isEnd = cell.dateStr === hi
              const isInRange = lo && hi && cell.dateStr > lo && cell.dateStr < hi
              return (
                <div
                  key={cell.dateStr}
                  className={[
                    'date-range-cell',
                    cell.outside ? 'date-range-cell-outside' : '',
                    cell.dateStr === today ? 'date-range-cell-today' : '',
                    isInRange ? 'date-range-cell-in-range' : '',
                    isStart || isEnd ? 'date-range-cell-endpoint' : '',
                  ].join(' ').trim()}
                  onClick={() => handleDayClick(cell.dateStr)}
                  onMouseEnter={() => setHoverDate(cell.dateStr)}
                >
                  {cell.dayNum}
                </div>
              )
            })}
          </div>

          <div className="date-range-picker-footer">
            <button type="button" className="econ-today-btn" onClick={jumpToToday}><RotateCcw size={12} /> Today</button>
          </div>
        </div>
      )}
    </div>
  )
}
