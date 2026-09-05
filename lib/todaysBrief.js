// The EdgeEngine half of the per-instrument dashboard's "Today's brief" card
// (app/app/[instrument]/dashboard/page.js) - a second clause, in the
// trader's own historical terms, appended after the existing streak/
// mock-calendar sentence when there's something to say. Never touches that
// existing sentence - this only ever adds a clause after it, and returns
// null (nothing rendered, nothing appended) when there isn't yet enough
// history to say anything.
//
// "Today's overnight bucket" per the brief this shipped under turned out to
// not be buildable as literally worded: market_session_stats (schema.sql,
// scripts/fetch-daily-market-stats.js) stores one row per full close-to-
// close CME trading day, never a separate Asia+London-only sub-session -
// and that daily job is deliberately the only recurring Databento call in
// this whole pass, so there's no second early-morning fetch to add one.
// Flagged to the user, who confirmed reading the latest already-closed full
// session instead (typically yesterday's, or Friday's on a Monday) and
// phrasing it honestly as "most recent session" rather than "overnight."
import { queryPerformance } from './edgeEngine'
import { bucketRegime } from './tradeRegimes'

const TRAILING_WINDOW = 20

// { sessionDate, volatility_regime, volume_regime } for the most recently
// closed full trading day on this exact contract, or null if there isn't
// yet a large enough trailing baseline to bucket it against. Keyed by the
// exact catalog symbol (MNQ separately from NQ), not the data_symbol
// family - see lib/tradeRegimes.js's header for why.
export async function latestClosedSessionRegime(supabase, symbol) {
  const { data: rows } = await supabase
    .from('market_session_stats')
    .select('session_date, total_range, total_volume')
    .eq('data_symbol', symbol)
    .order('session_date', { ascending: false })
    .limit(TRAILING_WINDOW + 1)
  if (!rows || rows.length < 2) return null

  const [latest, ...trailing] = rows
  const { volatility_regime, volume_regime } = bucketRegime(latest, trailing)
  return { sessionDate: latest.session_date, volatility_regime, volume_regime }
}

const REGIME_LABELS = {
  volatility_regime: { high: 'elevated volatility', normal: 'typical volatility', low: 'unusually quiet, low-volatility conditions' },
  volume_regime: { high: 'elevated volume', normal: 'typical volume', low: 'light volume' },
}

function directionWord(delta) {
  if (delta > 0) return 'outperformed your average'
  if (delta < 0) return 'underperformed your average'
  return 'performed about the same as usual'
}

// Given the trader's own trades/strategies for this one instrument and the
// most-recently-closed session's regime bucket, finds the single most
// pronounced strategy x regime signal - largest |win-rate delta vs. that
// strategy's own baseline|, among slices past the too_early confidence gate
// - and phrases it as a second clause. Checks both volatility_regime and
// volume_regime (the brief names both as candidates without picking one),
// and every strategy on this instrument, the same "surface the most
// pronounced finding" pattern Tier A already uses elsewhere in this app
// (e.g. the strategy page's top-mistake-tag finding) rather than a second,
// unrelated way of picking what to show.
export function edgeEngineClause({ trades, strategies, regime, symbol }) {
  if (!regime) return null

  const candidates = []
  for (const dimension of ['volatility_regime', 'volume_regime']) {
    const bucket = regime[dimension]
    if (!bucket) continue

    for (const strategy of strategies) {
      const strategyTrades = trades.filter((t) => t.strategy_id === strategy.id)
      if (strategyTrades.length === 0) continue

      const rows = queryPerformance({ trades: strategyTrades, groupBy: `strategy_id_x_${dimension}`, compareTo: strategyTrades })
      const match = rows.find((r) => r.key === `strategy_id:${strategy.id}|${dimension}:${bucket}`)
      if (!match || match.confidenceTier === 'too_early') continue
      const delta = match.deltaVsBaseline?.winRate
      if (delta === null || delta === undefined) continue

      candidates.push({ strategyName: strategy.name, dimension, bucket, delta })
    }
  }
  if (candidates.length === 0) return null

  candidates.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
  const best = candidates[0]
  const conditionLabel = REGIME_LABELS[best.dimension][best.bucket]

  // Names the exact contract the reading actually came from (MNQ, not NQ,
  // on a micro instrument's own dashboard) - the regime is now measured per
  // contract, so the sentence has to match what was measured.
  return `${symbol}'s most recent session traded at ${conditionLabel}, and you've historically ${directionWord(best.delta)} on ${best.strategyName} in these conditions.`
}
