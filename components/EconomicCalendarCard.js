'use client'

import { useState, useEffect, useCallback } from 'react'
import { ChevronDown } from 'lucide-react'
import { useClickOutside } from '@/lib/useClickOutside'
import { mockEventsForDate } from '@/lib/marketContextMock'
import DateRangePicker from '@/components/DateRangePicker'

const IMPACT_OPTIONS = [
  { value: 'high', label: 'High impact' },
  { value: 'medium', label: 'Medium impact' },
  { value: 'low', label: 'Low impact' },
]

// Long enough for any range someone would plausibly pick in this card, and
// a hard stop against an accidental multi-year range (e.g. a typo'd year
// in the date input) turning into a very long loop.
const MAX_RANGE_DAYS = 90

function pad(n) {
  return String(n).padStart(2, '0')
}
function toDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function todayStr() {
  return toDateStr(new Date())
}

const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
function formatDateLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00')
  return `${WEEKDAY_ABBR[d.getDay()]} ${d.getDate()}`
}

// Every mock event landing on any day within [fromStr, toStr] inclusive,
// via marketContextMock's per-date lookup rather than duplicating its
// weekday-offset math here. Swaps the bounds if entered backwards, since
// the two <input type="date"> fields don't enforce order themselves.
function eventsInRange(fromStr, toStr) {
  let from = new Date(fromStr + 'T00:00:00')
  let to = new Date(toStr + 'T00:00:00')
  if (from > to) { const t = from; from = to; to = t }

  const out = []
  const cursor = new Date(from)
  let guard = 0
  while (cursor <= to && guard < MAX_RANGE_DAYS) {
    const dateStr = toDateStr(cursor)
    for (const e of mockEventsForDate(dateStr)) out.push({ ...e, dateStr })
    cursor.setDate(cursor.getDate() + 1)
    guard++
  }
  return out
}

function impactFilterLabel(selected) {
  if (selected.length === 0) return 'No impact selected'
  if (selected.length === IMPACT_OPTIONS.length) return 'High + Medium + Low'
  return IMPACT_OPTIONS.filter((o) => selected.includes(o.value)).map((o) => o.label.replace(' impact', '')).join(' + ')
}

// Independent checkboxes, same pattern as the table column filters
// (ColumnFilter.js) - High/Medium/Low can each be toggled on their own.
function ImpactChecklist({ selected, onChange }) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const wrapRef = useClickOutside(open, close)

  // Same close-on-scroll behavior as DateRangePicker/ColumnFilter/
  // CalendarNewsBadge, for consistency across every popover this card
  // (and the calendar) opens - this one is position:absolute rather than
  // fixed, so it wouldn't visually detach the way theirs do, but leaving
  // it open while the page scrolls out from under the toolbar still looks
  // wrong the same way an unrelated stray open dropdown always does.
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

  function toggle(value) {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value])
  }

  return (
    <div className="econ-impact-filter" ref={wrapRef}>
      <button type="button" className="calendar-strategy-filter econ-impact-filter-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {impactFilterLabel(selected)}
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="col-filter-menu econ-impact-filter-menu">
          {IMPACT_OPTIONS.map((o) => (
            <label key={o.value} className="col-filter-option">
              <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)} />
              {o.label}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

// Mock data only (lib/marketContextMock.js) - not sourced from any live
// feed. mockEventsForDate's shape (time/event/impact/forecast/previous per
// date) is what a real provider's data should slot into so this component
// doesn't need to change - only the dates picked are real, the event
// pattern itself repeats every week since there's no live source yet.
//
// Reused as-is on the per-instrument Overview page. A future version
// should filter events down to whatever's relevant to that instrument's
// underlying currency/market instead of always showing the same US-wide
// list - no such filtering exists yet.
export default function EconomicCalendarCard() {
  const [fromDate, setFromDate] = useState(todayStr)
  const [toDate, setToDate] = useState(todayStr)
  const [impactSelected, setImpactSelected] = useState(['high', 'medium', 'low'])

  const isSingleDay = fromDate === toDate
  const today = todayStr()

  const events = eventsInRange(fromDate, toDate)
    .filter((e) => impactSelected.includes(e.impact))
    .sort((a, b) => (a.dateStr + a.time).localeCompare(b.dateStr + b.time))

  return (
    <>
      <div className="calendar-toolbar">
        <ImpactChecklist selected={impactSelected} onChange={setImpactSelected} />
        <DateRangePicker from={fromDate} to={toDate} onChange={(f, t) => { setFromDate(f); setToDate(t) }} />
      </div>

      {events.length === 0 ? (
        <div className="empty">No matching events in this range.</div>
      ) : (
        <div className="econ-calendar-mock-list">
          {events.map((e, i) => (
            <div className={`econ-calendar-mock-row ${!isSingleDay && e.dateStr === today ? 'econ-calendar-mock-row-today' : ''}`} key={i}>
              <span className={`econ-impact-dot econ-impact-${e.impact}`} />
              {!isSingleDay && <span className="econ-calendar-mock-day">{formatDateLabel(e.dateStr)}</span>}
              <span className="econ-calendar-mock-time">{e.time}</span>
              <span className="econ-calendar-mock-event">{e.event}</span>
              <span className="econ-calendar-mock-figures">
                {e.forecast ? <>fcst {e.forecast} &nbsp;&nbsp; prev {e.previous}</> : '–'}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Mock only - a real version would check whether the trader's own
          strategies (tags, typical session times) line up with this
          range's high-impact events instead of this hardcoded line. */}
      <div className="econ-calendar-mock-footer">
        2 of your strategies trade around high-impact events this week — Powell Mon, Break and Retest
      </div>
    </>
  )
}
