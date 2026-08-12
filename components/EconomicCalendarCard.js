'use client'

import { useState, useEffect } from 'react'

const IMPACT_FLOORS = [
  { value: 'high', label: 'High impact only' },
  { value: 'medium', label: 'High + medium impact' },
  { value: 'all', label: 'All impact levels' },
]
const IMPACT_RANK = { high: 2, medium: 1, low: 0 }

function meetsImpactFloor(impact, floor) {
  if (floor === 'all') return true
  const floorRank = floor === 'high' ? 2 : 1
  return (IMPACT_RANK[impact] ?? 0) >= floorRank
}

function fmtVal(value, unit) {
  if (value === null || value === undefined) return '—'
  return `${value}${unit || ''}`
}

function fmtDate(dateStr) {
  if (!dateStr) return '—'
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

// EdgeLog's instruments are all US-listed futures, so US high-impact events
// are the useful default - everything else is available behind the filters
// rather than shown by default and adding noise.
export default function EconomicCalendarCard() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [events, setEvents] = useState([])
  const [countryFilter, setCountryFilter] = useState('US')
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

  const visible = events.filter((e) => {
    if (countryFilter !== 'all' && e.country !== countryFilter) return false
    if (!meetsImpactFloor(e.impact, impactFilter)) return false
    return true
  })

  return (
    <>
      <div className="calendar-toolbar">
        <select className="calendar-strategy-filter" value={countryFilter} onChange={(e) => setCountryFilter(e.target.value)}>
          <option value="US">US only</option>
          <option value="all">All countries</option>
        </select>
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
              <tr>
                <th>Date</th><th>Time (UTC)</th><th>Country</th><th>Event</th>
                <th>Actual</th><th>Forecast</th><th>Previous</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((e, i) => (
                <tr key={i}>
                  <td>{fmtDate(e.date)}</td>
                  <td>{e.time || '—'}</td>
                  <td>{e.country}</td>
                  <td>
                    <span className={`econ-impact-dot econ-impact-${e.impact}`} />
                    {e.event}
                  </td>
                  <td>{fmtVal(e.actual, e.unit)}</td>
                  <td>{fmtVal(e.estimate, e.unit)}</td>
                  <td>{fmtVal(e.prev, e.unit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
