import { hasResult } from './tradeMath'
import { queryPerformance } from './edgeEngine'

// Raw-data assembly for the AI insights feature (app/api/generate-insights/
// route.js) - deliberately does NOT touch edge_beliefs anywhere. The
// trader explicitly asked for true, unsmoothed numbers here: this is
// queryPerformance's plain aggregation over the real trades, with every
// breakdown's own real sample size (n) included alongside it, so the
// model judges and states reliability itself rather than Bayesian
// pseudo-count blending pre-deciding that for it. See lib/edgeBeliefs.js
// for the belief-cache system this deliberately bypasses - that system
// still powers the existing Today's Brief clause (lib/todaysBrief.js),
// unaffected by this file.

function rows(trades, groupBy) {
  return queryPerformance({ trades, groupBy }).map((r) => ({
    key: r.key, n: r.n, winRate: r.winRate, avgR: r.avgR, profitFactor: r.profitFactor,
  }))
}

function overallRow(trades) {
  const r = queryPerformance({ trades, groupBy: null })
  return { n: r.n, winRate: r.winRate, avgR: r.avgR, profitFactor: r.profitFactor }
}

// tag -> { n, avgR, winRate } for every discipline tag present among the
// trades handed in (already loss-only where a caller wants that scoping) -
// a plain count/average, not a slice_key-based membership lookup the way
// lib/edgeBeliefs.js's tagSlices needs, since nothing here is ever
// written back anywhere.
function tagBreakdown(trades) {
  const byTag = {}
  for (const t of trades) {
    for (const tag of t.discipline_tags || []) {
      byTag[tag] = byTag[tag] || []
      byTag[tag].push(t)
    }
  }
  return Object.entries(byTag).map(([tag, tagTrades]) => {
    const r = queryPerformance({ trades: tagTrades, groupBy: null })
    return { tag, n: r.n, winRate: r.winRate, avgR: r.avgR }
  })
}

function hasDollar(t) {
  return t.pnl !== null && t.pnl !== undefined
}

function dollarStats(trades) {
  const withD = trades.filter((t) => hasResult(t) && hasDollar(t))
  if (withD.length === 0) return null
  const total = withD.reduce((s, t) => s + t.pnl, 0)
  return { n: withD.length, avgDollarPerTrade: total / withD.length, totalDollar: total }
}

// MFE/MAE/drawdown, computed straight from trades.mfe_points/mae_points/
// drawdown_seconds (normalized to R via stop_distance, the same
// convention the trade detail page displays them in) - never
// lib/edgeBeliefs.js's Welford-smoothed accumulators.
function excursionStats(trades) {
  const withExcursion = trades.filter((t) => t.mfe_points != null && t.mae_points != null && t.stop_distance)
  if (withExcursion.length === 0) return null
  const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length
  const drawdowns = withExcursion.filter((t) => t.drawdown_seconds != null).map((t) => t.drawdown_seconds)
  return {
    n: withExcursion.length,
    avgMfeR: avg(withExcursion.map((t) => t.mfe_points / t.stop_distance)),
    avgMaeR: avg(withExcursion.map((t) => t.mae_points / t.stop_distance)),
    avgDrawdownSeconds: drawdowns.length > 0 ? avg(drawdowns) : null,
  }
}

export function totalTradeCount(trades) {
  return trades.filter(hasResult).length
}

// All Instruments page.
export function overallInsightData(allTrades, instruments) {
  const closed = allTrades.filter(hasResult)
  const instrumentSymbolById = Object.fromEntries(instruments.map((i) => [i.id, i.symbol]))
  return {
    overall: overallRow(allTrades),
    byInstrument: rows(allTrades, 'instrument_id').map((r) => ({ ...r, instrument: instrumentSymbolById[r.key] || r.key })),
    bySession: rows(allTrades, 'session'),
    byDayOfWeek: rows(allTrades, 'day_of_week'),
    byDiscipline: rows(allTrades, 'discipline'),
    tagBreakdown: tagBreakdown(closed),
    dollar: dollarStats(allTrades),
  }
}

// Per-instrument page.
export function instrumentInsightData(instrumentTrades, strategies, symbol) {
  const closed = instrumentTrades.filter(hasResult)
  const strategyNameById = Object.fromEntries(strategies.map((s) => [s.id, s.name]))
  return {
    instrument: symbol,
    overall: overallRow(instrumentTrades),
    bySession: rows(instrumentTrades, 'session'),
    byDayOfWeek: rows(instrumentTrades, 'day_of_week'),
    byDiscipline: rows(instrumentTrades, 'discipline'),
    byStrategy: rows(instrumentTrades, 'strategy_id').map((r) => ({ ...r, strategy: strategyNameById[r.key] || r.key })),
    tagBreakdown: tagBreakdown(closed),
    dollar: dollarStats(instrumentTrades),
  }
}

// Per-strategy page.
export function strategyInsightData(strategyTrades, strategyName) {
  const closed = strategyTrades.filter(hasResult)
  const closedLosses = closed.filter((t) => t.r_multiple < 0)
  return {
    strategy: strategyName,
    overall: overallRow(strategyTrades),
    bySession: rows(strategyTrades, 'session'),
    byDayOfWeek: rows(strategyTrades, 'day_of_week'),
    lossesBySession: rows(closedLosses, 'session'),
    lossesByDayOfWeek: rows(closedLosses, 'day_of_week'),
    tagBreakdown: tagBreakdown(closed),
    excursion: excursionStats(strategyTrades),
    dollar: dollarStats(strategyTrades),
  }
}
