'use client'

function fmtD(val) {
  if (val === null || val === undefined) return '—'
  return (val >= 0 ? '+$' : '-$') + Math.abs(val).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// segments: [{ label, value, color }], one per instrument. Ranked highest
// to lowest $ P&L, including negative and zero - replaces the donut this
// card used to show, which could only represent a losing instrument as a
// muted legend row with no arc of its own. A horizontal strip of chips
// rather than a vertical list, so it reads as a compact line item inside
// the All-Time Performance card instead of competing with the equity
// curve/weekday chart row below it for column width.
export default function PnlByInstrumentList({ segments }) {
  const totalAbs = segments.reduce((s, seg) => s + Math.abs(seg.value), 0)
  if (totalAbs === 0) {
    return <div className="empty">No dollar P&amp;L recorded yet.</div>
  }

  const ranked = segments.slice().sort((a, b) => b.value - a.value)

  return (
    <div className="pnl-rank-strip">
      {ranked.map((seg) => (
        <div className="pnl-rank-chip" key={seg.label}>
          <span className="gauge-dot" style={{ background: seg.color }} />
          <span className="pnl-rank-symbol">{seg.label}</span>
          <span className={`pnl-rank-value ${seg.value > 0 ? 'pos' : seg.value < 0 ? 'neg' : 'neu'}`}>
            {fmtD(seg.value)}
          </span>
        </div>
      ))}
    </div>
  )
}
