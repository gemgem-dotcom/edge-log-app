'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react'
import { useClickOutside } from '@/lib/useClickOutside'

const IMPACT_OPTIONS = [
  { value: 'high', label: 'High impact' },
  { value: 'medium', label: 'Medium impact' },
]

function fmtDate(dateStr) {
  if (!dateStr) return '—'
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

function toDateStr(d) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function shiftWeek(dateStr, deltaDays) {
  const d = new Date(dateStr + 'T00:00:00')
  d.setDate(d.getDate() + deltaDays)
  return toDateStr(d)
}

function formatWeekLabel(from, to) {
  if (!from || !to) return ''
  const start = new Date(from + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const end = new Date(to + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  return `${start} – ${end}`
}

function impactFilterLabel(selected) {
  if (selected.length === 0) return 'No impact selected'
  if (selected.length === IMPACT_OPTIONS.length) return 'High + Medium impact'
  return IMPACT_OPTIONS.find((o) => o.value === selected[0])?.label
}

// Independent checkboxes rather than a "floor" select - High and Medium
// can each be toggled on/off on their own instead of only "high" or
// "high and up".
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

// Sourced from BLS's own release calendar plus a hand-maintained FOMC
// list (see app/api/economic-calendar/route.js) - every event here is US
// data with no actual/forecast/previous values, so there's no country or
// value columns to show, just the schedule itself.
export default function EconomicCalendarCard() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [events, setEvents] = useState([])
  const [weekStart, setWeekStart] = useState(null)
  const [weekEnd, setWeekEnd] = useState(null)
  const [impactSelected, setImpactSelected] = useState(['high'])

  useEffect(() => {
    loadEvents()
  }, [])

  // from/to omitted on first load - the server picks "this week" in ET, and
  // its answer becomes the cursor for the prev/next buttons from then on,
  // so the client never has to duplicate that ET week-boundary logic.
  async function loadEvents(from, to) {
    setLoading(true)
    setError(null)
    try {
      const qs = from && to ? `?from=${from}&to=${to}` : ''
      const res = await fetch(`/api/economic-calendar${qs}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Something went wrong')
      setEvents(data.events || [])
      setWeekStart(data.from)
      setWeekEnd(data.to)
    } catch (err) {
      setError(err.message || "Couldn't load the economic calendar.")
    } finally {
      setLoading(false)
    }
  }

  function goPrevWeek() {
    if (!weekStart) return
    loadEvents(shiftWeek(weekStart, -7), shiftWeek(weekEnd, -7))
  }
  function goNextWeek() {
    if (!weekStart) return
    loadEvents(shiftWeek(weekStart, 7), shiftWeek(weekEnd, 7))
  }

  const visible = events.filter((e) => impactSelected.includes(e.impact))

  return (
    <>
      <div className="calendar-toolbar">
        <ImpactChecklist selected={impactSelected} onChange={setImpactSelected} />
        <div className="calendar-month-nav">
          <button type="button" className="calendar-nav-btn" onClick={goPrevWeek} disabled={!weekStart} aria-label="Previous week"><ChevronLeft size={18} /></button>
          <div className="calendar-month-label">{formatWeekLabel(weekStart, weekEnd)}</div>
          <button type="button" className="calendar-nav-btn" onClick={goNextWeek} disabled={!weekStart} aria-label="Next week"><ChevronRight size={18} /></button>
        </div>
      </div>

      {loading ? (
        <div className="empty">Loading economic calendar…</div>
      ) : error ? (
        <div className="empty">{error}</div>
      ) : visible.length === 0 ? (
        <div className="empty">No matching events for this week.</div>
      ) : (
        <div className="table-scroll">
          <table className="econ-calendar-table">
            <thead>
              <tr><th>Date</th><th>Time (ET)</th><th>Event</th></tr>
            </thead>
            <tbody>
              {visible.map((e, i) => (
                <tr key={i}>
                  <td>{fmtDate(e.date)}</td>
                  <td>{e.time || '—'}</td>
                  <td>
                    <span className={`econ-impact-dot econ-impact-${e.impact}`} />
                    {e.event}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
