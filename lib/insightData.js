import { hasResult, tradeDurationMinutes, formatDuration } from './tradeMath'
import { queryPerformance } from './edgeEngine'

// Raw-data assembly for the AI insights feature (app/api/generate-insights/
// route.js). The trader explicitly asked for true, unsmoothed numbers
// here: this is queryPerformance's plain aggregation over the real
// trades, with every breakdown's own real sample size (n) included
// alongside it, so the model judges and states reliability itself rather
// than a pre-smoothed number deciding that for it.

// Every breakdown below reports its count as `sampleSize`, not `n` - the
// bare statistical symbol was showing up verbatim in Claude's prose
// ("n=5"), presumably echoing the field name it was reading. Renaming the
// field, plus the prompt's own explicit instruction
// (app/api/generate-insights/route.js) to phrase counts naturally in a
// sentence, is what actually stopped it.
function rows(trades, groupBy) {
  return queryPerformance({ trades, groupBy }).map((r) => ({
    key: r.key, sampleSize: r.n, winRate: r.winRate, avgR: r.avgR, profitFactor: r.profitFactor,
  }))
}

// Same shape as rows(), minus winRate and profitFactor, for a set that has
// already been filtered to losses. Over loss-only trades those two are 0 and
// 0 by construction, not measurements - but nothing downstream can tell that
// from a real 0% win rate, and the model duly wrote "your NY AM win rate is
// 0%" as if it were a finding. edgeEngine.js's own comment warns about
// exactly this trap for `outcome:` slices; pre-filtering reproduces it.
// avgR still carries real signal here (how badly the losses lose).
function lossRows(trades, groupBy) {
  return queryPerformance({ trades, groupBy }).map((r) => ({
    key: r.key, sampleSize: r.n, avgR: r.avgR,
  }))
}

function overallRow(trades) {
  const r = queryPerformance({ trades, groupBy: null })
  return { sampleSize: r.n, winRate: r.winRate, avgR: r.avgR, profitFactor: r.profitFactor }
}

// tag -> { sampleSize, avgR, winRate } for every discipline tag present
// among the trades handed in (already loss-only where a caller wants that
// scoping) - a plain count/average, since nothing here is ever written
// back anywhere.
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
    return { tag, sampleSize: r.n, winRate: r.winRate, avgR: r.avgR }
  })
}

function hasDollar(t) {
  return t.pnl !== null && t.pnl !== undefined
}

function dollarStats(trades) {
  const withD = trades.filter((t) => hasResult(t) && hasDollar(t))
  if (withD.length === 0) return null
  const total = withD.reduce((s, t) => s + t.pnl, 0)
  return { sampleSize: withD.length, avgDollarPerTrade: total / withD.length, totalDollar: total }
}

// "Xm Ys" rather than a bare seconds count - handed to Claude already
// formatted so it has no reason to echo a raw number like "331 seconds"
// in its prose (confirmed live that it otherwise just repeats whatever
// unit the field arrived in).
function formatDurationSeconds(totalSeconds) {
  const s = Math.round(totalSeconds)
  const m = Math.floor(s / 60)
  const remSeconds = s % 60
  return m === 0 ? `${remSeconds}s` : `${m}m ${remSeconds}s`
}

// MFE/MAE/drawdown, computed straight from trades.mfe_points/mae_points/
// drawdown_seconds (normalized to R via stop_distance, the same
// convention the trade detail page displays them in).
//
// Only VERIFIED excursions count - the same bar the UI applies before it
// will show one of these numbers to the trader (market_data_status
// 'complete' AND no excursion_fallback; see excursionCell in
// components/TradeLogTable.js and excursionStatusMessage in
// lib/tradeExcursions.js). Without it, a value the app itself labels
// "Unverified" on screen was still averaged in and handed to the model as
// fact - including a known trade carrying mae_points +170 against a 55
// point stop, physically impossible, which alone contributes 3.09R to
// avgMaeR. A number the trader is not allowed to see should not be the
// basis of advice given to them.
function excursionStats(trades) {
  const withExcursion = trades.filter((t) => (
    t.market_data_status === 'complete'
    && !t.excursion_fallback
    && t.mfe_points != null
    && t.mae_points != null
    && t.stop_distance
  ))
  if (withExcursion.length === 0) return null
  const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length
  const drawdowns = withExcursion.filter((t) => t.drawdown_seconds != null).map((t) => t.drawdown_seconds)
  return {
    sampleSize: withExcursion.length,
    avgMfeR: avg(withExcursion.map((t) => t.mfe_points / t.stop_distance)),
    avgMaeR: avg(withExcursion.map((t) => t.mae_points / t.stop_distance)),
    avgDrawdownDuration: drawdowns.length > 0 ? formatDurationSeconds(avg(drawdowns)) : null,
  }
}

// Average hold time overall, and split by win/loss - not tied to any
// particular finding, just handed over as optional context (the model
// isn't required to comment on it; it's there in case a duration pattern
// - e.g. cutting winners short relative to losers - is actually
// relevant). Replaces the old visual duration-bucket histogram that used
// to sit on the per-strategy page (components/TradeDurationChart.js,
// removed) - the raw signal now goes to Claude to describe in prose
// instead of a chart to look at, per explicit request. Pre-formatted via
// lib/tradeMath.js's formatDuration for the same reason avgDrawdownDuration
// above is - so the model has no raw-minutes number to echo verbatim.
function durationStats(trades) {
  const withDuration = trades
    .filter(hasResult)
    .map((t) => ({ t, duration: tradeDurationMinutes(t) }))
    .filter((x) => x.duration !== null)
  if (withDuration.length === 0) return null

  const wins = withDuration.filter((x) => x.t.r_multiple > 0)
  const losses = withDuration.filter((x) => x.t.r_multiple < 0)
  const avg = (arr) => arr.reduce((s, x) => s + x.duration, 0) / arr.length

  return {
    sampleSize: withDuration.length,
    avgDurationOverall: formatDuration(Math.round(avg(withDuration))),
    avgDurationWins: wins.length > 0 ? formatDuration(Math.round(avg(wins))) : null,
    avgDurationLosses: losses.length > 0 ? formatDuration(Math.round(avg(losses))) : null,
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
    lossesBySession: lossRows(closedLosses, 'session'),
    lossesByDayOfWeek: lossRows(closedLosses, 'day_of_week'),
    tagBreakdown: tagBreakdown(closed),
    excursion: excursionStats(strategyTrades),
    duration: durationStats(strategyTrades),
    dollar: dollarStats(strategyTrades),
  }
}
