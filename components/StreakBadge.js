// Shared shell for the win/loss streak badge on the cross-instrument
// Overview, per-instrument Overview, and per-strategy detail page - only
// the label wording differs per page, via winLabel/lossLabel.
export default function StreakBadge({ streak, winLabel, lossLabel }) {
  if (!streak) return null
  return (
    <div className={`streak-badge ${streak.isWin ? 'streak-badge-win' : 'streak-badge-loss'}`}>
      {streak.isWin && <span className="streak-badge-fire">🔥</span>}
      {streak.isWin ? winLabel(streak.count) : lossLabel(streak.count)}
    </div>
  )
}
