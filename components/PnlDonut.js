'use client'

import { useState } from 'react'

function fmtD(val) {
  if (val === null || val === undefined) return '—'
  return (val >= 0 ? '+$' : '-$') + Math.abs(val).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// segments: [{ label, value, color }].
//
// netSignOnly (on for both P&L-by-instrument and P&L-by-strategy; off
// defaults to the original trading-magnitude ring, unused by either caller
// today): the ring represents the net P&L direction, not raw trading
// magnitude. If the net total across every segment is
// negative, only the loss-side segments (value < 0) are drawn in the ring -
// sized by their share of the total loss - and the profit-side segments
// still get a legend row, just muted, with no arc. A positive net total
// mirrors this (only profit-side segments ring, losses muted in the
// legend). A net total of exactly zero has no direction to represent, so it
// falls back to the empty state.
export default function PnlDonut({ segments, netSignOnly = false }) {
  const [hovered, setHovered] = useState(null)
  const totalAbs = segments.reduce((s, seg) => s + Math.abs(seg.value), 0)

  if (totalAbs === 0) {
    return <div className="empty">No dollar P&amp;L recorded yet.</div>
  }

  const netTotal = segments.reduce((s, seg) => s + seg.value, 0)
  if (netSignOnly && netTotal === 0) {
    return <div className="empty">No dollar P&amp;L recorded yet.</div>
  }

  const inRing = (seg) => (netSignOnly ? (netTotal > 0 ? seg.value > 0 : seg.value < 0) : seg.value !== 0)
  const ringSegments = segments.filter(inRing)
  const ringTotal = ringSegments.reduce((s, seg) => s + Math.abs(seg.value), 0)

  const cx = 90
  const cy = 90
  const r = 70
  const strokeWidth = 26
  const circumference = 2 * Math.PI * r

  let offset = 0
  const arcs = ringSegments.map((seg) => {
    const dash = (Math.abs(seg.value) / ringTotal) * circumference
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
          <div className={`donut-legend-item ${netSignOnly && !inRing(seg) ? 'donut-legend-item-muted' : ''}`} key={seg.label}>
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
            {((Math.abs(hovered.arc.value) / ringTotal) * 100).toFixed(1)}%
          </div>
        </div>
      )}
    </div>
  )
}
