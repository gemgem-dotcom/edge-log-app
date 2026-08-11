'use client'

export default function WinRateGauge({ wins = 0, breakeven = 0, losses = 0, winRate = null }) {
    const total = wins + breakeven + losses
    const winPct = total > 0 ? (wins / total) * 100 : 0
    const bePct = total > 0 ? (breakeven / total) * 100 : 0
    const lossPct = total > 0 ? (losses / total) * 100 : 0

  const cx = 100
    const cy = 92
    const r = 78
    const arc = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`

  return (
        <div className="gauge-wrap">
          <div className="gauge-arc-wrap">
            <svg viewBox="0 0 200 104" className="gauge-svg">
              <path d={arc} pathLength="100" fill="none" stroke="var(--line)" strokeWidth="15" />
  {winPct > 0 && (
                <path
                d={arc} pathLength="100" fill="none" stroke="var(--win)" strokeWidth="15"
                strokeDasharray={`${winPct} 100`} strokeDashoffset="0"
            />
            )}
{bePct > 0 && (
              <path
              d={arc} pathLength="100" fill="none" stroke="var(--be)" strokeWidth="15"
              strokeDasharray={`${bePct} 100`} strokeDashoffset={`-${winPct}`}
            />
          )}
{lossPct > 0 && (
              <path
               d={arc} pathLength="100" fill="none" stroke="var(--loss)" strokeWidth="15"
               strokeDasharray={`${lossPct} 100`} strokeDashoffset={`-${winPct + bePct}`}
            />
          )}
</svg>
        <div className="gauge-center-text">
{winRate === null || winRate === undefined ? '—' : winRate.toFixed(1) + '%'}
  </div>
  </div>
      <div className="gauge-legend">
          <span className="gauge-legend-item">
            <span className="gauge-dot" style={{ background: 'var(--win)' }} />{wins.toLocaleString('en-US')}
  </span>
        <span className="gauge-legend-item">
            <span className="gauge-dot" style={{ background: 'var(--be)' }} />{breakeven.toLocaleString('en-US')}
  </span>
        <span className="gauge-legend-item">
            <span className="gauge-dot" style={{ background: 'var(--loss)' }} />{losses.toLocaleString('en-US')}
  </span>
  </div>
  </div>
  )
}
