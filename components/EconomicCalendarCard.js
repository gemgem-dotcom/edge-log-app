'use client'

import { useState, useCallback } from 'react'
import { ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react'
import { useClickOutside } from '@/lib/useClickOutside'
import { MOCK_ECON_WEEK } from '@/lib/marketContextMock'

const IMPACT_OPTIONS = [
  { value: 'high', label: 'High impact' },
  { value: 'medium', label: 'Medium impact' },
  { value: 'low', label: 'Low impact' },
]
const WEEKDAY_LABELS = ['MON', 'TUE', 'WED', 'THU', 'FRI']

function pad(n) {
  return String(n).padStart(2, '0')
}
function toDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// Monday of the week containing `date`.
function mondayOf(date) {
  const d = new Date(date)
  const day = d.getDay()
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day))
  d.setHours(0, 0, 0, 0)
  return d
}

function formatWeekLabel(monday) {
  const friday = new Date(monday)
  friday.setDate(monday.getDate() + 4)
  const start = monday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const end = friday.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  return `${start} – ${end}`
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
// feed. MOCK_ECON_WEEK's shape (weekday offset + time/event/impact/
// forecast/previous) is what a real provider's data should slot into so
// this component doesn't need to change - only the Monday/Friday dates
// shown are real (computed from the browser clock plus however many weeks
// the trader has flipped), the event list itself repeats every week.
//
// Reused as-is on the per-instrument Overview page. A future version
// should filter events down to whatever's relevant to that instrument's
// underlying currency/market instead of always showing the same US-wide
// list - no such filtering exists yet.
export default function EconomicCalendarCard() {
  const [weekOffset, setWeekOffset] = useState(0)
  const [impactSelected, setImpactSelected] = useState(['high', 'medium', 'low'])

  const monday = mondayOf(new Date())
  monday.setDate(monday.getDate() + weekOffset * 7)

  const events = MOCK_ECON_WEEK
    .filter((e) => impactSelected.includes(e.impact))
    .map((e) => {
      const d = new Date(monday)
      d.setDate(d.getDate() + e.day)
      return { ...e, dateStr: toDateStr(d) }
    })
    .sort((a, b) => (a.dateStr + a.time).localeCompare(b.dateStr + b.time))

  return (
    <>
      <div className="calendar-toolbar">
        <ImpactChecklist selected={impactSelected} onChange={setImpactSelected} />
        <div className="calendar-month-nav">
          <button type="button" className="calendar-nav-btn" onClick={() => setWeekOffset((w) => w - 1)} aria-label="Previous week"><ChevronLeft size={18} /></button>
          <div className="calendar-month-label">{formatWeekLabel(monday)}</div>
          <button type="button" className="calendar-nav-btn" onClick={() => setWeekOffset((w) => w + 1)} aria-label="Next week"><ChevronRight size={18} /></button>
        </div>
      </div>

      {events.length === 0 ? (
        <div className="empty">No matching events this week.</div>
      ) : (
        <div className="econ-calendar-mock-list">
          {events.map((e, i) => (
            <div className="econ-calendar-mock-row" key={i}>
              <span className={`econ-impact-dot econ-impact-${e.impact}`} />
              <span className="econ-calendar-mock-day">{WEEKDAY_LABELS[e.day]}</span>
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
          week's high-impact events instead of this hardcoded line. */}
      <div className="econ-calendar-mock-footer">
        2 of your strategies trade around high-impact events this week — Powell Mon, Break and Retest
      </div>
    </>
  )
}
