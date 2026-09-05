'use client'

import { useState } from 'react'

// Indexed by Date#getDay, so Saturday has to be present even though the
// callers only pass a row for it when the trader actually has a Saturday
// trade (see computeWeekdayPnl) - without it that row renders a blank label
// and an undefined tooltip title rather than "SAT"/"Saturday".
const WEEKDAY_SHORT = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
const WEEKDAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function fmtD(val) {
  if (val === null || val === undefined) return '—'
  return (val >= 0 ? '+$' : '-$') + Math.abs(val).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// rows: [{ day: 0-5, avg, count }], see computeWeekdayPnl in
// OverviewDashboard.js - always Sun-Fri, every weekday present even with
// zero trades logged on it. A diverging horizontal bar per weekday, split
// into a negative lane and a positive lane either side of a fixed center
// line - plain flexbox rather than SVG, since each bar only ever grows
// from that shared zero point in one direction.
export default function AvgPnlByWeekdayChart({ rows }) {
  const [hovered, setHovered] = useState(null)

  if (rows.every((r) => r.count === 0)) {
    return <div className="empty">No dollar P&amp;L recorded yet.</div>
  }

  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.avg)))

  return (
    <div className="weekday-chart">
      {rows.map((r) => {
        const pct = maxAbs === 0 ? 0 : (Math.abs(r.avg) / maxAbs) * 100
        const isPos = r.avg > 0
        const isNeg = r.avg < 0
        return (
          <div
            className="weekday-chart-row"
            key={r.day}
            onMouseMove={(e) => setHovered({ row: r, x: e.clientX, y: e.clientY })}
            onMouseLeave={() => setHovered(null)}
          >
            <span className="weekday-chart-label">{WEEKDAY_SHORT[r.day]}</span>
            <div className="weekday-chart-track">
              <div className="weekday-chart-lane weekday-chart-lane-neg">
                {isNeg && <div className="weekday-chart-bar weekday-chart-bar-neg" style={{ width: `${pct}%` }} />}
              </div>
              <div className="weekday-chart-center" />
              <div className="weekday-chart-lane weekday-chart-lane-pos">
                {isPos && <div className="weekday-chart-bar weekday-chart-bar-pos" style={{ width: `${pct}%` }} />}
              </div>
            </div>
            <span className={`weekday-chart-value ${isPos ? 'pos' : isNeg ? 'neg' : 'neu'}`}>{fmtD(r.avg)}</span>
          </div>
        )
      })}
      {hovered && (
        <div className="chart-tooltip" style={{ left: hovered.x + 14, top: hovered.y - 10 }}>
          <div className="chart-tooltip-title">{WEEKDAY_FULL[hovered.row.day]}</div>
          <div className="chart-tooltip-row">{fmtD(hovered.row.avg)} avg</div>
          <div className="chart-tooltip-row chart-tooltip-muted">
            {hovered.row.count} trade{hovered.row.count === 1 ? '' : 's'}
          </div>
        </div>
      )}
    </div>
  )
}
