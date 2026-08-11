'use client'

import { useState } from 'react'

function fmtD(val) {
  if (val === null || val === undefined) return '—'
  return (val >= 0 ? '+$' : '-$') + Math.abs(val).toFixed(2)
}

// Renders a cumulative $ P&L line from pre-bucketed points (see
// buildEquityCurve in OverviewDashboard.js). viewBox is a fixed virtual
// size and preserveAspectRatio="none" lets the wrapping CSS stretch it to
// whatever width the panel actually has.
export default function EquityCurveChart({ points }) {
  const [hover, setHover] = useState(null)

  if (!points || points.length === 0) {
    return <div className="empty">Not enough closed trades yet to plot an equity curve.</div>
  }

  const width = 600
  const height = 180
  const padX = 10
  const padY = 14

  const values = points.map((p) => p.cumulative)
  const min = Math.min(0, ...values)
  const max = Math.max(0, ...values)
  const range = max - min || 1

  const stepX = points.length > 1 ? (width - padX * 2) / (points.length - 1) : 0
  const xFor = (i) => (points.length > 1 ? padX + i * stepX : width / 2)
  const yFor = (v) => height - padY - ((v - min) / range) * (height - padY * 2)

  const linePoints = points.map((p, i) => `${xFor(i)},${yFor(p.cumulative)}`).join(' ')
  const zeroY = yFor(0)
  const areaPoints = `${xFor(0)},${zeroY} ${linePoints} ${xFor(points.length - 1)},${zeroY}`

  // Maps the mouse's real pixel X (the SVG is stretched by CSS to the
  // panel's actual width, unrelated to the 600-unit viewBox above) to the
  // nearest point index, then keeps the cursor's real position for the
  // tooltip itself - the two coordinate spaces stay separate throughout.
  function handleMove(e) {
    const rect = e.currentTarget.getBoundingClientRect()
    const fraction = (e.clientX - rect.left) / rect.width
    const index = points.length > 1 ? Math.round(fraction * (points.length - 1)) : 0
    setHover({ index: Math.min(points.length - 1, Math.max(0, index)), x: e.clientX, y: e.clientY })
  }

  return (
    <div className="equity-chart-wrap" onMouseMove={handleMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${width} ${height}`} className="equity-chart-svg" preserveAspectRatio="none">
        <line x1={padX} y1={zeroY} x2={width - padX} y2={zeroY} stroke="var(--line)" strokeWidth="1" />
        <polygon points={areaPoints} fill="var(--accent)" opacity="0.12" />
        <polyline points={linePoints} fill="none" stroke="var(--accent)" strokeWidth="2" />
        {hover && (
          <>
            <line
              x1={xFor(hover.index)} y1="0" x2={xFor(hover.index)} y2={height}
              stroke="var(--muted)" strokeWidth="1" strokeDasharray="3 3"
            />
            <circle
              cx={xFor(hover.index)} cy={yFor(points[hover.index].cumulative)} r="4"
              fill="var(--accent)" stroke="var(--panel)" strokeWidth="2"
            />
          </>
        )}
      </svg>
      {hover && (
        <div className="chart-tooltip" style={{ left: hover.x + 14, top: hover.y - 10 }}>
          <div className="chart-tooltip-title">{points[hover.index].key}</div>
          <div className="chart-tooltip-row">{fmtD(points[hover.index].cumulative)}</div>
        </div>
      )}
    </div>
  )
}
