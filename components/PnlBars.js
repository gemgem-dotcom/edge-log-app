'use client'

import { useState } from 'react'

function fmtD(val) {
  if (val === null || val === undefined) return '—'
  return (val >= 0 ? '+$' : '-$') + Math.abs(val).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function colorClass(val) {
  return val > 0 ? 'pos' : val < 0 ? 'neg' : 'neu'
}

// segments: [{ label, value, color }]. `color` (from strategyColor) is no
// longer used for the bar fill - polarity (win/loss) already carries the
// meaning a diverging bar needs, so every bar is green or red and the row
// label alone carries the segment's identity.
export default function PnlBars({ segments }) {
  const [hovered, setHovered] = useState(null)
  const totalAbs = segments.reduce((s, seg) => s + Math.abs(seg.value), 0)

  if (totalAbs === 0) {
    return <div className="empty">No dollar P&amp;L recorded yet.</div>
  }

  const maxAbs = Math.max(...segments.map((seg) => Math.abs(seg.value)))

  return (
    <div className="pnl-bars">
      {segments.map((seg) => {
        const pct = maxAbs > 0 ? (Math.abs(seg.value) / maxAbs) * 100 : 0
        const isNeg = seg.value < 0
        const bar = seg.value !== 0 && (
          <div
            className={`pnl-bars-bar ${isNeg ? 'pnl-bars-bar-neg' : 'pnl-bars-bar-pos'}`}
            style={{ width: `${pct}%`, minWidth: '3px' }}
            onMouseMove={(e) => setHovered({ seg, x: e.clientX, y: e.clientY })}
            onMouseLeave={() => setHovered(null)}
          />
        )
        const value = <span className={`pnl-bars-value ${colorClass(seg.value)}`}>{fmtD(seg.value)}</span>
        return (
          <div className="pnl-bars-row" key={seg.label}>
            <div className="pnl-bars-label">{seg.label}</div>
            <div className="pnl-bars-track">
              <div className="pnl-bars-baseline" />
              <div className="pnl-bars-half pnl-bars-half-neg">
                {isNeg && value}
                {isNeg && bar}
              </div>
              <div className="pnl-bars-half pnl-bars-half-pos">
                {!isNeg && bar}
                {!isNeg && value}
              </div>
            </div>
          </div>
        )
      })}
      {hovered && (
        <div className="chart-tooltip" style={{ left: hovered.x + 14, top: hovered.y - 10 }}>
          <div className="chart-tooltip-title">{hovered.seg.label}</div>
          <div className="chart-tooltip-row">{fmtD(hovered.seg.value)}</div>
          <div className="chart-tooltip-row chart-tooltip-muted">
            {((Math.abs(hovered.seg.value) / totalAbs) * 100).toFixed(1)}%
          </div>
        </div>
      )}
    </div>
  )
}
