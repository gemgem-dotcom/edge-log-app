// Pure mechanics for the from-scratch strategy search. No network, no dates
// fetched, nothing stateful - everything here takes bars in and gives numbers
// out, so it can be unit tested and so search-strategies.js is only glue.
//
// CommonJS rather than ESM because scripts/ is run directly by node and this
// repo has no "type": "module" (see scan-strategy-setup-days.js's header).
// Vitest imports it through CJS interop, which is what lets the search have
// real tests instead of another smoke script.
//
// ---------- the one idea this file exists to enforce ----------
//
// A backtest that reports "62% win rate" has said nothing. Almost every
// question about a trading rule is really a question about the comparison,
// so the comparison is built into the scoring here rather than bolted on:
//
//   1. Costs come out of every trade. A one-point round trip (two ticks of
//      slippage plus commission on NQ) is small against a 90 point target and
//      fatal against a 20 point one, and a search run without it will
//      reliably "find" edges that are entirely spread.
//
//   2. Every result is scored against RANDOM ENTRIES matched on count,
//      direction mix and time of day, drawn from the same sessions. This is
//      a far better null than the analytic s/(s+t) coin: it inherits the
//      real volatility, the real trend, the real intraday shape. If a rule
//      cannot beat a dart thrown into the same afternoon, it has no edge, and
//      the analytic coin can hide that.
//
//   3. Bars that span both the stop and the target are counted as AMBIGUOUS
//      and reported, never silently resolved. At 1m granularity there is no
//      way to know which came first, and quietly calling them wins is the
//      single easiest way to manufacture a fake strategy.

// Two ticks of slippage plus commission, per round turn, in NQ points.
// Deliberately pessimistic: a limit strategy might pay less, but a rule that
// only works at optimistic costs is not a rule worth having.
const DEFAULT_COST_POINTS = 1.0
const ATR_BARS = 20

// ---------- small numeric helpers ----------

function mean(values) {
  if (values.length === 0) return null
  return values.reduce((a, b) => a + b, 0) / values.length
}

function stdev(values) {
  if (values.length < 2) return null
  const m = mean(values)
  const variance = values.reduce((sum, v) => sum + (v - m) * (v - m), 0) / (values.length - 1)
  return Math.sqrt(variance)
}

// Deterministic PRNG so a search run is reproducible - a null distribution
// that shifts between runs makes every borderline result unfalsifiable.
function makeRng(seed) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

// ---------- causal indicators ----------
//
// Every function here returns an array parallel to `bars` where element i is
// computed from bars 0..i INCLUSIVE and nothing later. That invariant is what
// makes the search honest, and it is what the tests check.

function trueRanges(bars) {
  return bars.map((bar, i) => {
    if (i === 0) return bar.high - bar.low
    const prevClose = bars[i - 1].close
    return Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose))
  })
}

function atrSeries(bars, period = ATR_BARS) {
  const tr = trueRanges(bars)
  const out = new Array(bars.length).fill(null)
  let sum = 0
  for (let i = 0; i < bars.length; i++) {
    sum += tr[i]
    if (i >= period) sum -= tr[i - period]
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

// Session VWAP and the volume-weighted dispersion of price around it, both
// running. The dispersion is what turns "far from VWAP" into a threshold that
// means the same thing on a quiet day and a wild one.
function vwapSeries(bars) {
  const vwap = new Array(bars.length).fill(null)
  const sigma = new Array(bars.length).fill(null)
  let volumeSum = 0
  let priceVolumeSum = 0
  let priceSquaredVolumeSum = 0
  for (let i = 0; i < bars.length; i++) {
    const typical = (bars[i].high + bars[i].low + bars[i].close) / 3
    const volume = bars[i].volume > 0 ? bars[i].volume : 1
    volumeSum += volume
    priceVolumeSum += typical * volume
    priceSquaredVolumeSum += typical * typical * volume
    const v = priceVolumeSum / volumeSum
    vwap[i] = v
    const variance = priceSquaredVolumeSum / volumeSum - v * v
    sigma[i] = variance > 0 ? Math.sqrt(variance) : 0
  }
  return { vwap, sigma }
}

// Rolling extremes over the previous `period` bars, EXCLUDING the current bar
// - a breakout rule must compare today's bar against what came before it, not
// against a window that already contains it (which no bar can ever exceed).
function rollingExtremes(bars, period) {
  const high = new Array(bars.length).fill(null)
  const low = new Array(bars.length).fill(null)
  for (let i = 0; i < bars.length; i++) {
    if (i < period) continue
    let h = -Infinity
    let l = Infinity
    for (let j = i - period; j < i; j++) {
      h = Math.max(h, bars[j].high)
      l = Math.min(l, bars[j].low)
    }
    high[i] = h
    low[i] = l
  }
  return { high, low }
}

// The high and low of the first `minutes` bars of the session, available only
// from the bar AFTER that range closes.
function openingRange(bars, minutes) {
  if (bars.length < minutes) return null
  let high = -Infinity
  let low = Infinity
  for (let i = 0; i < minutes; i++) {
    high = Math.max(high, bars[i].high)
    low = Math.min(low, bars[i].low)
  }
  return { high, low, readyIndex: minutes }
}

// ---------- trade resolution ----------

// Walks forward from an entry and decides the trade. Entry is the OPEN of
// `entryIndex`, never the close of the signal bar, so nothing is filled on
// information that arrived at the same instant as the decision.
//
// Returns one of:
//   win / loss   - one level was reached first, unambiguously
//   ambiguous    - a single bar's range covers both levels; 1m data cannot
//                  order them, so this is reported rather than guessed
//   open         - neither level reached inside maxBars
function resolveTrade(bars, entryIndex, direction, stopPoints, targetPoints, maxBars) {
  if (entryIndex >= bars.length) return { result: 'open', entryPrice: null, bars: 0 }
  const entryPrice = bars[entryIndex].open
  const isLong = direction === 'long'
  const stopPrice = isLong ? entryPrice - stopPoints : entryPrice + stopPoints
  const targetPrice = isLong ? entryPrice + targetPoints : entryPrice - targetPoints

  const lastIndex = Math.min(bars.length - 1, entryIndex + maxBars - 1)
  for (let i = entryIndex; i <= lastIndex; i++) {
    const hitTarget = isLong ? bars[i].high >= targetPrice : bars[i].low <= targetPrice
    const hitStop = isLong ? bars[i].low <= stopPrice : bars[i].high >= stopPrice
    if (hitTarget && hitStop) return { result: 'ambiguous', entryPrice, bars: i - entryIndex + 1 }
    if (hitTarget) return { result: 'win', entryPrice, bars: i - entryIndex + 1 }
    if (hitStop) return { result: 'loss', entryPrice, bars: i - entryIndex + 1 }
  }
  return { result: 'open', entryPrice, bars: lastIndex - entryIndex + 1 }
}

// Expectancy in points per trade, after costs.
//
// Unresolved trades are closed at the last bar seen rather than dropped.
// Dropping them biases every wide target upward, because the trades that were
// still going nowhere when the window closed are exactly the bad ones.
// Ambiguous trades are charged as losses here - the pessimistic assignment -
// and counted separately so the reader can see how much of the result rests
// on them.
function scoreTrades(trades, options = {}) {
  const costPoints = options.costPoints ?? DEFAULT_COST_POINTS
  const perTrade = []
  let wins = 0
  let losses = 0
  let ambiguous = 0
  let unresolved = 0

  for (const trade of trades) {
    let points
    if (trade.result === 'win') {
      points = trade.targetPoints
      wins++
    } else if (trade.result === 'loss') {
      points = -trade.stopPoints
      losses++
    } else if (trade.result === 'ambiguous') {
      points = -trade.stopPoints
      ambiguous++
    } else {
      points = trade.exitPoints ?? 0
      unresolved++
    }
    perTrade.push(points - costPoints)
  }

  const n = perTrade.length
  const expectancy = n > 0 ? mean(perTrade) : null
  const sd = n > 1 ? stdev(perTrade) : null
  return {
    n,
    wins,
    losses,
    ambiguous,
    unresolved,
    winRate: wins + losses > 0 ? wins / (wins + losses) : null,
    expectancyPoints: expectancy,
    sdPoints: sd,
    totalPoints: n > 0 ? expectancy * n : null,
    // Standard error of the mean, which is the only honest way to read an
    // expectancy: a +3 point edge on 40 trades with a 40 point spread is
    // indistinguishable from zero.
    sePoints: sd !== null && n > 0 ? sd / Math.sqrt(n) : null,
    tStat: sd && sd > 0 && n > 0 ? expectancy / (sd / Math.sqrt(n)) : null,
  }
}

module.exports = {
  DEFAULT_COST_POINTS,
  ATR_BARS,
  mean,
  stdev,
  makeRng,
  trueRanges,
  atrSeries,
  vwapSeries,
  rollingExtremes,
  openingRange,
  resolveTrade,
  scoreTrades,
}
