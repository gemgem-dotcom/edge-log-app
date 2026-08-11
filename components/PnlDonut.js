'use client'

import { useState } from 'react'

function fmtD(val) {
  if (val === null || val === undefined) return '—'
  return (val >= 0 ? '+$' : '-$') + Math.abs(val).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// segments: [{ label, value, color }]. Slice size is each segment's share of
// total trading magnitude (sum of |value|) rather than of the net total,
// since a net total near zero (winners offsetting losers) would otherwise
// make every slice size meaningless.
export default function PnlDonut({ segments }) {
  const [hovered, setHovered] = useState(null)
  const totalAbs = segments.reduce((s, seg) => s + Math.abs(seg.value), 0)

  if (totalAbs === 0) {
    return <div className="empty">No dollar P&amp;L recorded yet.</div>
  }

  const cx = 90
  const cy = 90
  const r = 70
  const strokeWidth = 26
  const circumference = 2 * Math.PI * r

  let offset = 0
  const arcs = segments
    .filter((seg) => seg.value !== 0)
    .map((seg) => {
      const dash = (Math.abs(seg.value) / totalAbs) * circumference
      const arc = { ...seg, dasharray: `${dash} ${circumference - dash}`, dashoffset: -offset }
      offset += dash
      return arc
    })

  return (
    <div className="donut-wrap">
      <svg viewBox="0 0 180 180" className="donut-svg">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--line)" strokeWidth={strokeWidth} />
        {arcs.map((arc) => (
          <circle
            key={arc.label}
            cx={cx} cy={cy} r={r} fill="none"
            stroke={arc.color} strokeWidth={strokeWidth}
            strokeDasharray={arc.dasharray}
            strokeDashoffset={arc.dashoffset}
            transform={`rotate(-90 ${cx} ${cy})`}
            className="donut-arc"
            onMouseMove={(e) => setHovered({ arc, x: e.clientX, y: e.clientY })}
            onMouseLeave={() => setHovered(null)}
          />
        ))}
      </svg>
      <div className="donut-legend">
        {segments.map((seg) => (
          <div className="donut-legend-item" key={seg.label}>
            <span className="gauge-dot" style={{ background: seg.color }} />
            <span className="donut-legend-symbol">{seg.label}</span>
            <span className={`donut-legend-value ${seg.value > 0 ? 'pos' : seg.value < 0 ? 'neg' : 'neu'}`}>
              {fmtD(seg.value)}
            </span>
          </div>
        ))}
      </div>
      {hovered && (
        <div className="chart-tooltip" style={{ left: hovered.x + 14, top: hovered.y - 10 }}>
          <div className="chart-tooltip-title">{hovered.arc.label}</div>
          <div className="chart-tooltip-row">{fmtD(hovered.arc.value)}</div>
          <div className="chart-tooltip-row chart-tooltip-muted">
            {((hovered.arc.value / totalAbs) * 100).toFixed(1)}%
          </div>
        </div>
      )}
    </div>
  )
}
