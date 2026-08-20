'use client'

import { useState } from 'react'

// "Nice round number" progression for the trade-count axis, same idea as
// the duration buckets' own NICE_STEPS_MIN in the strategy detail page -
// picks the smallest step that keeps the axis to a handful of ticks
// regardless of whether the busiest bucket holds 4 trades or 400.
const AXIS_NICE_STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000]
const TARGET_MAX_TICKS = 5

function computeAxisTicks(maxCount) {
  if (maxCount <= 0) return { ticks: [0], axisMax: 1 }
  const step = AXIS_NICE_STEPS.find((s) => Math.ceil(maxCount / s) <= TARGET_MAX_TICKS) || AXIS_NICE_STEPS[AXIS_NICE_STEPS.length - 1]
  const axisMax = Math.ceil(maxCount / step) * step
  const ticks = []
  for (let t = 0; t <= axisMax; t += step) ticks.push(t)
  return { ticks, axisMax }
}

// buckets: [{ from, to, label, wins, losses, neutral }], see
// computeDurationBuckets in the strategy detail page - a single
// horizontal bar per bucket (not a diverging one like the weekday P&L
// chart, since a trade count has no negative direction), stacked
// smaller-outcome-first: whichever of wins/losses is fewer sits closest
// to the label, and the larger group continues the bar outward, so the
// dominant outcome is always the part that reaches furthest. Neutral
// (breakeven or still-unresolved) trades, if any, trail after both. Bars
// are read against the shared axis at the bottom rather than a per-row
// number - exact counts are still available on hover.
export default function TradeDurationChart({ buckets }) {
  const [hovered, setHovered] = useState(null)

  if (!buckets || buckets.length === 0) {
    return <div className="empty">No trade duration data yet.</div>
  }

  const maxTotal = Math.max(...buckets.map((b) => b.wins + b.losses + b.neutral))
  const { ticks, axisMax } = computeAxisTicks(maxTotal)

  return (
    <div className="duration-chart">
      {buckets.map((b) => {
        const total = b.wins + b.losses + b.neutral
        const totalPct = (total / axisMax) * 100
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
                {segments.map((s) => (
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
          </div>
        )
      })}
      <div className="duration-chart-axis">
        <span className="duration-chart-axis-spacer" />
        <div className="duration-chart-axis-track">
          {ticks.map((t) => (
            <span
              key={t}
              className="duration-chart-axis-tick"
              style={{
                left: `${(t / axisMax) * 100}%`,
                transform: t === 0 ? 'none' : t === axisMax ? 'translateX(-100%)' : 'translateX(-50%)',
              }}
            >
              {t}
            </span>
          ))}
        </div>
      </div>
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
