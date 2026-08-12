'use client'

import { useState, useEffect } from 'react'

const IMPACT_FLOORS = [
  { value: 'high', label: 'High impact only' },
  { value: 'medium', label: 'High + medium impact' },
]
const IMPACT_RANK = { high: 2, medium: 1 }

function meetsImpactFloor(impact, floor) {
  const floorRank = floor === 'high' ? 2 : 1
  return (IMPACT_RANK[impact] ?? 0) >= floorRank
}

function fmtDate(dateStr) {
  if (!dateStr) return '—'
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

// Sourced from BLS's own release calendar plus a hand-maintained FOMC
// list (see app/api/economic-calendar/route.js) - every event here is US
// data with no actual/forecast/previous values, so there's no country or
// value columns to show, just the schedule itself.
export default function EconomicCalendarCard() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [events, setEvents] = useState([])
  const [impactFilter, setImpactFilter] = useState('high')

  useEffect(() => {
    loadEvents()
  }, [])

  async function loadEvents() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/economic-calendar')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Something went wrong')
      setEvents(data.events || [])
    } catch (err) {
      setError(err.message || "Couldn't load the economic calendar.")
    } finally {
      setLoading(false)
    }
  }

  const visible = events.filter((e) => meetsImpactFloor(e.impact, impactFilter))

  return (
    <>
      <div className="calendar-toolbar">
        <select className="calendar-strategy-filter" value={impactFilter} onChange={(e) => setImpactFilter(e.target.value)}>
          {IMPACT_FLOORS.map((lvl) => <option key={lvl.value} value={lvl.value}>{lvl.label}</option>)}
        </select>
      </div>

      {loading ? (
        <div className="empty">Loading economic calendar…</div>
      ) : error ? (
        <div className="empty">{error}</div>
      ) : visible.length === 0 ? (
        <div className="empty">No matching events this week.</div>
      ) : (
        <div className="table-scroll">
          <table>
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
