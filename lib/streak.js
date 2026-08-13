import { hasResult } from '@/lib/tradeMath'

// Current active win/loss streak: how many of the most recent trades (by
// date/time, most recent first) share the same win/loss direction as the
// very latest one. Breakeven trades and trades with no result yet don't
// count as either - a breakeven as the most recent trade means there's no
// active streak to report (null), same as having no trade history at all.
export function computeStreak(trades) {
  const resolved = trades
    .filter(hasResult)
    .slice()
    .sort((a, b) => (b.trade_date + (b.trade_time || '')).localeCompare(a.trade_date + (a.trade_time || '')))

  if (resolved.length === 0) return null
  const latest = resolved[0]
  if (latest.r_multiple === 0) return null

  const isWin = latest.r_multiple > 0
  let count = 0
  for (const t of resolved) {
    if (isWin ? t.r_multiple > 0 : t.r_multiple < 0) count++
    else break
  }
  return { count, isWin }
}
