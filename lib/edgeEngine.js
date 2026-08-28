import { hasResult } from './tradeMath'

// The single source of truth for "what's the win rate/expectancy/profit
// factor for this slice of trades" - before this existed, that formula was
// copy-pasted independently in OverviewDashboard.js, the strategy detail
// page, and twice in the per-instrument dashboard page, and there was no
// shared sample-size confidence gate (one existed once, was lost, and got
// rebuilt inconsistently the next time a feature needed it). Every call
// site should go through queryPerformance from now on rather than
// reimplementing any piece of this.
//
// r_multiple is read directly off each trade rather than recomputed via
// calcRMultiple/calcBlendedRMultiple (lib/tradeMath.js) - those compute R
// from raw entry/stop/exit prices at save time (components/TradeForm.js),
// but every trade this function ever sees already carries its own final,
// stored r_multiple (single-exit or blended), the same value hasResult
// already treats as authoritative everywhere else in the app. There's no
// per-trade R math left to do here, only aggregation over values that are
// already computed.

// Group-key extractors, one per supported single-value groupBy dimension.
// Adding a new dimension later (day-of-week, a specific discipline tag) is
// one more entry here, not a rewrite of the grouping logic below. A trade
// whose extractor returns null/undefined is left out of the grouped result
// entirely, rather than showing up as a "null" group - session is the only
// dimension where that can currently happen for an ordinary trade (a trade
// with no recorded session).
//
// This is also lib/edgeBeliefs.js's single source of truth for which
// slices a trade belongs to - it derives its own per-trade slice list from
// SINGLE_DIMENSIONS and COMPOSITE_SLICES below rather than re-listing each
// dimension a second time, so the two files can't drift apart the way the
// old hand-written singleDimensionSlices/regimeSlices pair could.
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const BASE_DIMENSIONS = {
  session: (t) => t.session ?? null,
  // Same trade_date -> weekday conversion as components/TradeLogTable.js's
  // dayOf() and OverviewDashboard.js's computeWeekdayPnl() - trade_date is
  // a plain 'YYYY-MM-DD' wall-clock date with no timezone of its own (see
  // lib/tradeSessions.js's comment on why), so appending a bare
  // 'T00:00:00' with no offset parses it at local midnight rather than UTC
  // midnight, and .getDay() then reads back the calendar day that was
  // actually entered regardless of server timezone.
  day_of_week: (t) => (t.trade_date ? DAY_NAMES[new Date(t.trade_date + 'T00:00:00').getDay()] : null),
  strategy_id: (t) => t.strategy_id ?? null,
  instrument_id: (t) => t.instrument_id ?? null,
  // Every closed trade is exactly one of these three - never both flagged
  // and clean, schema.sql's comment above reviewed_no_issues/
  // discipline_tags is the source of truth for why those columns are
  // mutually exclusive. unreviewed is kept distinct from clean rather
  // than folded into it - that distinction is the whole reason
  // reviewed_no_issues exists as its own field instead of tags alone.
  discipline: (t) => {
    if (t.reviewed_no_issues) return 'clean'
    if (t.discipline_tags && t.discipline_tags.length > 0) return 'flagged'
    return 'unreviewed'
  },
  // r_multiple is only ever read on a trade that's already passed
  // hasResult (never null here), so this always resolves to exactly one of
  // the three - there's no "not yet applicable" case the way there is for
  // session/regime. Exists specifically so it can be composed with other
  // dimensions below (outcome x discipline: which specific mistakes are
  // actually costing you, not just "you were undisciplined").
  //
  // WARNING - degenerate win rate for any slice built on this dimension.
  // A slice like outcome:loss is by definition every trade where r<0, so
  // its win_alpha/win_beta only ever grow on the loss/beta side from real
  // data - the implied "win rate" for outcome:loss or outcome:win isn't a
  // measurement, it's a restatement of the slice's own definition, and it
  // drifts toward 0%/100% as n grows regardless of any real signal.
  // outcome:breakeven is worse: every trade in it has r_multiple===0, so
  // avg_r_mean/expectancy_mean stay frozen too - only n is informative.
  // avg_r_mean/expectancy_mean are NOT degenerate for outcome:win/loss
  // themselves (average win/loss size is real signal) - just win_alpha/
  // win_beta. Any read-side feature (lib/edgeBeliefs.js consumers, the
  // future belief-query UI) must not surface a win-rate figure for a slice
  // whose key contains "outcome:" - use avg_r_mean/n instead.
  outcome: (t) => {
    if (t.r_multiple > 0) return 'win'
    if (t.r_multiple < 0) return 'loss'
    return 'breakeven'
  },
  // Lazily backfilled at read time (lib/tradeRegimes.js), NQ-family
  // instruments only - null (not yet applicable) for every other trade,
  // same as every other dimension here.
  volatility_regime: (t) => t.volatility_regime ?? null,
  volume_regime: (t) => t.volume_regime ?? null,
}

// Every dimension in BASE_DIMENSIONS that gets its own single-value belief
// slice (lib/edgeBeliefs.js) and groupBy option - i.e. all of them. Kept as
// an explicit derived list (not inlined at each use site) so it's one
// clear answer to "what single-dimension slices exist" instead of two
// files each computing their own view of the same question.
export const SINGLE_DIMENSIONS = Object.keys(BASE_DIMENSIONS)

// 2-way intersections to also slice/groupBy - capped at 2-way per the
// brief this shipped under, no 3-way intersections. Order matters: it's
// the order the composite slice_key's two segments appear in
// ('dimA:X|dimB:Y', matching lib/edgeBeliefs.js's slice_key convention),
// and it's which single-dimension slice a brand-new composite slice seeds
// its Bayesian prior from (always dimA's) - so outcome before discipline
// means a fresh outcome:loss|discipline:flagged slice starts from "how do
// my losses generally look," which is the more informative prior of the
// two. Adding a new composite later - day_of_week x strategy_id, say - is
// one more entry here; queryPerformance's groupBy and edge_beliefs' slice
// list both pick it up automatically, not two separate changes.
export const COMPOSITE_SLICES = [
  ['strategy_id', 'volatility_regime'],
  ['strategy_id', 'volume_regime'],
  ['outcome', 'discipline'],
]

function compositeValue(dimA, dimB, t) {
  const a = BASE_DIMENSIONS[dimA](t)
  const b = BASE_DIMENSIONS[dimB](t)
  if (a == null || b == null) return null
  return `${dimA}:${a}|${dimB}:${b}`
}

export const DIMENSIONS = {
  ...BASE_DIMENSIONS,
  ...Object.fromEntries(
    COMPOSITE_SLICES.map(([dimA, dimB]) => [`${dimA}_x_${dimB}`, (t) => compositeValue(dimA, dimB, t)])
  ),
}

// n < 20 -> too_early, 20-49 -> early_signal, 50+ -> trustworthy. Internal
// to the engine on purpose - this used to be a standalone sampleConfidence
// helper other code had to remember to call; folding it in here means
// every queryPerformance result already carries its own confidence tier,
// so there's nothing left to forget.
function confidenceTierFor(n) {
  if (n < 20) return 'too_early'
  if (n < 50) return 'early_signal'
  return 'trustworthy'
}

// Aggregate stats for one slice of (already hasResult-filtered) trades -
// the single-row shape both the groupBy:null case and each grouped row
// share. Breakeven trades (r_multiple === 0) are excluded from winRate's
// denominator, matching every existing win-rate computation in the app,
// but still count toward n and avgR.
function computeRow(key, trades) {
  const n = trades.length
  if (n === 0) {
    return { key, n: 0, winRate: null, expectancy: null, avgR: null, profitFactor: null, confidenceTier: confidenceTierFor(0) }
  }

  const wins = trades.filter((t) => t.r_multiple > 0)
  const losses = trades.filter((t) => t.r_multiple < 0)
  const winRate = (wins.length + losses.length) > 0 ? (wins.length / (wins.length + losses.length)) * 100 : null

  // Expectancy is the average R per trade taken, breakevens included - the
  // same number as avgR below, returned under both names since the two
  // mean different things to a reader even though they're numerically
  // identical. Previously computed as a win-rate-weighted formula
  // (wr * avgWin + (1-wr) * avgLoss, wr = wins/n) that only equaled avgR
  // when a slice had zero breakeven trades: wr used n (every closed trade)
  // as its denominator while avgLoss averaged over decided trades only, so
  // any slice with breakevens silently got a more pessimistic number than
  // reality. edge_beliefs's own expectancy_mean was never subject to this -
  // it's always been a plain running average of r_multiple, i.e. avgR under
  // a different name - so this fix is what makes the two engines agree.
  const avgR = trades.reduce((s, t) => s + t.r_multiple, 0) / n
  const expectancy = avgR

  const grossWin = wins.reduce((s, t) => s + t.r_multiple, 0)
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.r_multiple, 0))
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null)

  return { key, n, winRate, expectancy, avgR, profitFactor, confidenceTier: confidenceTierFor(n) }
}

// null-safe subtraction - a row or its baseline can have a null metric
// (an empty group, or a baseline with no wins/losses to rate), and a
// delta against a missing number isn't 0, it's unknown.
function delta(a, b) {
  return a === null || a === undefined || b === null || b === undefined ? null : a - b
}

function withDelta(row, baseline) {
  if (!baseline) return row
  return {
    ...row,
    deltaVsBaseline: {
      winRate: delta(row.winRate, baseline.winRate),
      expectancy: delta(row.expectancy, baseline.expectancy),
    },
  }
}

// Per-`trades`-array-identity memoization. A dashboard page routinely calls
// queryPerformance several times per render against the same `allTrades`
// array (overall stats, then a groupBy breakdown, then a loss-only
// breakdown, ...), and re-renders without new data leave that same array
// reference in place - see the systems-map review's finding #2 ("every
// stat recomputes from the full trade history, every time"). Keying on the
// array reference itself rather than a hand-rolled cache key needs no
// invalidation logic: a fresh Supabase fetch always produces a new array,
// so a stale entry is simply never looked up again, and WeakMap lets the
// old array (and its cached rows) be garbage collected once nothing else
// references it. compareTo is nested the same way since it's also an
// array-or-null identity, not a primitive.
const NULL_KEY = Symbol('null')
const resultCache = new WeakMap() // trades -> Map(compareTo|NULL_KEY -> Map(groupBy|NULL_KEY -> result))

// trades: any array of trade rows (a strategy's, an instrument's, a
// tag-filtered subset - whatever slice the caller wants stats for).
// groupBy: null for one aggregate row, or one of DIMENSIONS' keys for one
// row per group value present in `trades` (a group nobody has ever traded
// in doesn't appear - there's no "0 trades" row to pad in).
// compareTo: an optional second trades array (often `trades` itself,
// ungrouped, to mean "this same set's own overall baseline") - when set,
// every returned row also gets deltaVsBaseline against that baseline's
// winRate/expectancy.
export function queryPerformance({ trades, groupBy = null, compareTo = null }) {
  let byCompare = resultCache.get(trades)
  if (!byCompare) {
    byCompare = new Map()
    resultCache.set(trades, byCompare)
  }
  const compareKey = compareTo ?? NULL_KEY
  let byGroup = byCompare.get(compareKey)
  if (!byGroup) {
    byGroup = new Map()
    byCompare.set(compareKey, byGroup)
  }
  const groupKey = groupBy ?? NULL_KEY
  if (byGroup.has(groupKey)) return byGroup.get(groupKey)

  const result = computeQueryPerformance({ trades, groupBy, compareTo })
  byGroup.set(groupKey, result)
  return result
}

function computeQueryPerformance({ trades, groupBy, compareTo }) {
  const closed = trades.filter(hasResult)
  const baseline = compareTo ? computeRow(null, compareTo.filter(hasResult)) : null

  if (groupBy === null) {
    return withDelta(computeRow(null, closed), baseline)
  }

  const keyFor = DIMENSIONS[groupBy]
  if (!keyFor) {
    throw new Error(`queryPerformance: unsupported groupBy "${groupBy}"`)
  }

  const byKey = {}
  for (const t of closed) {
    const key = keyFor(t)
    if (key === null || key === undefined) continue
    if (!byKey[key]) byKey[key] = []
    byKey[key].push(t)
  }

  return Object.entries(byKey).map(([key, groupTrades]) => withDelta(computeRow(key, groupTrades), baseline))
}
