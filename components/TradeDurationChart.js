'use client'

import { useState } from 'react'

// buckets: [{ from, to, label, wins, losses, neutral }], see
// computeDurationBuckets in the strategy detail page - a single
// horizontal bar per bucket (not a diverging one like the weekday P&L
// chart, since a trade count has no negative direction), stacked
// smaller-outcome-first: whichever of wins/losses is fewer sits closest
// to the label, and the larger group continues the bar outward, so the
// dominant outcome is always the part that reaches furthest. Neutral
// (breakeven or still-unresolved) trades, if any, trail after both.
export default function TradeDurationChart({ buckets }) {
  const [hovered, setHovered] = useState(null)

  if (!buckets || buckets.length === 0) {
    return <div className="empty">No trade duration data yet.</div>
  }

  const maxTotal = Math.max(...buckets.map((b) => b.wins + b.losses + b.neutral))

  return (
    <div className="duration-chart">
      {buckets.map((b) => {
        const total = b.wins + b.losses + b.neutral
        const totalPct = maxTotal === 0 ? 0 : (total / maxTotal) * 100
        const segments = b.wins <= b.losses
          ? [{ type: 'win', count: b.wins }, { type: 'loss', count: b.losses }]
          : [{ type: 'loss', count: b.losses }, { type: 'win', count: b.wins }]
        if (b.neutral > 0) segments.push({ type: 'neu', count: b.neutral })

        return (
          <div
            className="duration-chart-row"
            key={b.label}
            onMouseMove={(e) => setHovered({ bucket: b, total, x: e.clientX, y: e.clientY })}
            onMouseLeave={() => setHovered(null)}
          >
            <span className="duration-chart-label">{b.label}</span>
            <div className="duration-chart-track">
              <div className="duration-chart-fill" style={{ width: `${totalPct}%` }}>
                {segments.map((s, i) => (
                  s.count > 0 && (
                    <div
                      key={s.type}
                      className={`duration-chart-seg duration-chart-seg-${s.type}`}
                      style={{ width: `${(s.count / total) * 100}%` }}
                    />
                  )
                ))}
              </div>
            </div>
            <span className="duration-chart-value">{total}</span>
          </div>
        )
      })}
      {hovered && (
        <div className="chart-tooltip" style={{ left: hovered.x + 14, top: hovered.y - 10 }}>
          <div className="chart-tooltip-title">{hovered.bucket.label}</div>
          <div className="chart-tooltip-row">{hovered.total} trade{hovered.total === 1 ? '' : 's'}</div>
          <div className="chart-tooltip-row chart-tooltip-muted">
            {hovered.bucket.wins} win{hovered.bucket.wins === 1 ? '' : 's'} · {hovered.bucket.losses} loss{hovered.bucket.losses === 1 ? '' : 'es'}
            {hovered.bucket.neutral > 0 && ` · ${hovered.bucket.neutral} no result`}
          </div>
        </div>
      )}
    </div>
  )
}
