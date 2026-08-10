'use client'

// Renders a cumulative $ P&L line from pre-bucketed points (see
// buildEquityCurve in OverviewDashboard.js). viewBox is a fixed virtual
// size and preserveAspectRatio="none" lets the wrapping CSS stretch it to
// whatever width the panel actually has.
export default function EquityCurveChart({ points }) {
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
  const lineColor = values[values.length - 1] >= 0 ? 'var(--win)' : 'var(--loss)'

  return (
    <div className="equity-chart-wrap">
      <svg viewBox={`0 0 ${width} ${height}`} className="equity-chart-svg" preserveAspectRatio="none">
        <line x1={padX} y1={zeroY} x2={width - padX} y2={zeroY} stroke="var(--line)" strokeWidth="1" />
        <polygon points={areaPoints} fill={lineColor} opacity="0.12" />
        <polyline points={linePoints} fill="none" stroke={lineColor} strokeWidth="2" />
      </svg>
    </div>
  )
}
