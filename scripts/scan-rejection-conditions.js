#!/usr/bin/env node

// Diagnostic / research script - NOT part of the app's runtime, NOT
// scheduled. Run manually via the "Run a diagnostic script" GitHub Action.
//
// scan-strategy-setup-days.js answers "when did THIS trader's specific
// setup occur, and did they take it". This script answers a different and
// broader question: across a long history of NQ, when does ANY rejection
// at a meaningful volume level occur, what were the market conditions at
// the time, and which of those conditions actually separate the rejections
// that worked from the ones that didn't.
//
// Why a separate script rather than more fields on that one: this one is
// deliberately NOT anchored to the logged trades. Those 24 trades are a
// prior (they establish that rejections at volume levels are worth
// studying), not the dataset - 24 observations cannot support testing
// more than a couple of hypotheses without overfitting. Generating
// rejection events mechanically over a year produces hundreds to
// thousands of them, which is what makes a condition analysis honest.
// Nothing here reads from Supabase at all.
//
// ---------- what counts as an event ----------
//
// A RESTING LIMIT ORDER AT THE MIDDLE OF A LEVEL, filled the moment price
// trades there. This is what the trader actually does ("all my limit
// orders are set in the middle of the 5POC"), and it makes the rejection
// an OUTCOME being bet on rather than an entry condition.
//
// An earlier definition required a bar to wick INTO the zone and close
// back OUT of it, entering at that close. That is a materially different
// and strictly worse trade - entering after the bounce is already
// visible, further from the level, needing a wider stop. On a ~17 point
// ATR the gap between "filled at the POC" and "filled at the close of the
// bar that left the POC" can be most of the intended risk, so the
// year-long null that definition produced was measuring a strategy nobody
// trades. Whether a rejection followed is still recorded, as
// `rejectionConfirmed`, so "wait for confirmation" is testable as a
// filter rather than baked in as a precondition.
//
// Direction follows the side price approached from: arriving from above,
// the level is support and the limit is a buy; from below, resistance and
// a sell. Three level families are tested, all computed from real
// Databento ohlcv-1m bars:
//
//   poc5      - POC of the rolling 5m/270-bar volume profile
//   poc15     - POC of the rolling 15m/240-bar volume profile
//   heatmap   - a yellow (high-density) bin of the rolling 7-CALENDAR-DAY
//               volume-at-price heatmap, built to the trader's own
//               indicator settings (Rolling anchor, 1 week, Max Bins 35)
//               and rolling forward continuously with every bar, today's
//               developing volume included
//
// The same touch can qualify against more than one family at once, which
// is the point: `confluenceCount` makes "these levels lined up" a measured
// variable rather than an assumption baked into the event definition.
//
// Both intraday profiles use the LuxAlgo Delta Flow Profile money-flow
// math (volume split across every row a bar's range spans, each row
// weighted by its own center price) that scan-strategy-setup-days.js
// established against the trader's real charts - see that file's history.
//
// ---------- conditions measured ----------
//
// One measure per orthogonal axis, deliberately NOT five collinear
// volatility proxies (which is what a first draft of this list was, and
// would have been the same test five times):
//
//   efficiencyRatio     - net move / summed absolute move over the prior
//                         hour: the trend-vs-balance axis. A rejection
//                         should behave very differently when price is
//                         going somewhere than when it is rotating.
//   priorRangePosition  - where the touch sits within the prior session's
//                         range, plus whether it is inside it at all: the
//                         auction-location axis.
//   openRangeVsAtr      - opening 30-minute range over daily ATR(14): the
//                         volatility-regime axis, normalized so it means
//                         the same thing in a quiet month and a wild one.
//   minutesSinceOpen    - a control, not a condition.
//
// Plus the path axis, which the first version of this script missed
// entirely and which the trader named directly: they reject out of a
// high-volume ("yellow") heatmap area into a low-volume ("blue") one, and
// stand aside when the trade would run from yellow into more yellow. That
// is a statement about what lies BETWEEN entry and target, not about the
// entry level - and the first version measured only the level. See
// pathAhead(), in the indicator's own density bands. This is a HYPOTHESIS
// competing with the other conditions on equal footing, not an assumption
// the script is built around - the goal is to find what actually has an
// edge, which may or may not be the trader's stated rule. It is a leading
// candidate because a validation run showed the unfiltered signal winning
// 33.3% at a 2R target where breakeven IS 33.3%: the level alone is worth
// precisely nothing, so all of the edge has to come from selection.
//
// ---------- how outcome is measured ----------
//
// NOT as a single simulated stop and target. A first year-long run did
// that - wick plus 0.25x the 1-minute ATR for the stop, fixed 2R/3R
// targets - and produced a median risk of 16.8 points against a trader
// whose own logged median stop is 35.75. Two things followed: the stop
// was tight enough to be taken out by noise, and a 2R target landed ~34
// points away, about 1.3 heatmap bins, so the path features could not
// express "travel from yellow into blue" even in principle. The result
// was a clean null (31.7% at a 2R target where breakeven is 33.3%) that
// could not distinguish "the setup has no edge" from "the exits were
// wrong".
//
// So each event now carries an EXCURSION PROFILE instead: the first bar
// index at which price reached each rung of EXCURSION_ATR_GRID, both
// favourably and adversely. Any (stop, target) pair is then decided
// offline by comparing the two indices - identical sequencing to a
// bar-by-bar simulation, but it searches the entire exit space from one
// scan rather than testing a single guessed point in it. Distances are
// in ATR multiples so a rung means the same thing across volatility
// regimes; atr1m ships alongside so points are recoverable.
//
// Also new: rejection QUALITY (wickFraction, closeStrength,
// volumeRatio). The event definition alone treats a one-tick poke into a
// zone exactly like a thirty-point spike, so the first run measured
// where rejections happen in great detail and never measured whether
// they were any good - the most obvious thing a trader actually reads.
//
// ---------- data handling ----------
//
// Bars are fetched ONE DAY AT A TIME and kept in a rolling in-memory
// buffer of SESSION_BUFFER_SESSIONS sessions. That buffer feeds all three
// level families plus the ATR and prior-session stats, so the rolling
// 7-day heatmap costs no extra Databento usage - each day's bars are
// fetched exactly once no matter how many later days look back at them.
// The first ~12 days of any scan range produce no events while the buffer
// fills, so start the range a few weeks before the period being studied.
//
// Prints one JSON line per event (prefixed EVENT:) plus a closing
// SUMMARY: line, read from the job log. Writes nothing anywhere.
//
// Usage: node scripts/scan-rejection-conditions.js
// Env: DATABENTO_API_KEY, INSTRUMENT_SYMBOL (default NQ),
//      SCAN_START_DATE, SCAN_END_DATE

const CME_HOLIDAYS = require('../lib/cmeHolidays.json')

const DATASET = 'GLBX.MDP3'
const PRICE_SCALE = 1e9
const BASE_URL = 'https://hist.databento.com'

const PROFILE_5M = { intervalMinutes: 5, lookbackBars: 270 }
const PROFILE_15M = { intervalMinutes: 15, lookbackBars: 240 }
const PROFILE_ROWS = 25

// The rolling historical heatmap: volume-at-price over a trailing window
// that moves forward continuously with every bar, per the trader's own
// description of their indicator - SEVEN CALENDAR DAYS, not seven
// sessions, and critically NOT "the last N completed sessions". A first
// version of this script used 20 completed prior sessions and excluded
// the current day entirely, which was wrong twice over: far too long a
// window, and blind to the developing volume of the very session being
// traded. Every level the path features measured was therefore a shelf
// that does not appear on the trader's chart.
const HEATMAP_LOOKBACK_DAYS = 7
// Sessions kept in memory. Ten trading sessions spans roughly fourteen
// calendar days, so a seven-CALENDAR-day window is fully covered even
// when it straddles a weekend and a holiday - and it also comfortably
// covers the 15m profile's 240-bar (60-hour) lookback.
const SESSION_BUFFER_SESSIONS = 10
// Bins the heatmap splits its price range into - the indicator's own "Max
// Bins" setting, read off the trader's real configuration screen. A first
// version used 120, which made every band about a third the height and
// changed whether a shelf registered as standing in the way of a target
// at all. Each event carries heatmapBinHeight so this stays checkable
// against a real chart rather than trusted.
const HEATMAP_MAX_BINS = 35

// The indicator's own density bands, again straight off its settings:
// Low Density 0-25% renders blue, Mid 25-75% grey, High 75-100% yellow.
// So the trader's "reject in yellow, trade into blue" is a statement
// about these bands, and the honest way to test it is in the same terms
// rather than through a hand-rolled multiple-of-median proxy.
//
// Ambiguity worth naming: a density band can mean share-of-the-peak-bin
// (a colour gradient normalised to the busiest bin) or percentile RANK
// among bins (which would paint exactly a quarter of bins yellow by
// construction). A colour scale usually means the former, but rather than
// guess again, both are emitted per event - densityOfMax and densityRank -
// and the analysis can settle which reproduces the trader's chart.
const HEATMAP_HIGH_DENSITY = 0.75
const HEATMAP_LOW_DENSITY = 0.25

// The 7-day window shifts by one minute per scanned bar, so recomputing it
// every minute would mean rebuilding a ~10,000-bar profile 330 times a day
// for a window that has moved 0.01%. Recomputed on this cadence instead -
// a bounded approximation of a continuously rolling window, and the only
// deliberate one in this script.
const HEATMAP_REBUILD_MINUTES = 5

// Trading window scanned for events, in minutes after the 9:30 NY open.
// Stops well before the cash close so every event still has room for its
// forward resolution window inside liquid hours.
const SCAN_WINDOW_MINUTES = 330
const FORWARD_WINDOW_MINUTES = 240

const EFFICIENCY_LOOKBACK_MINUTES = 60
const OPENING_RANGE_MINUTES = 30
const ATR_DAYS = 14
const ATR_1M_BARS = 20
const STOP_BUFFER_ATR_MULT = 0.25

const ROLL_PROXIMITY_DAYS = 10
const ROLLOVER_RESOLUTION_WINDOW_HOURS = 6
const NQ_ROLLOVER_DATES = require('../lib/contractRollover.json').NQ.map((d) => new Date(`${d}T00:00:00Z`))

function log(...args) {
  console.error(new Date().toISOString(), ...args)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------- dates ----------

// US DST, which a year-long scan actually crosses (unlike the trader's own
// May-September trade history, where a hardcoded -4 was safe). Second
// Sunday in March to first Sunday in November, both at 2am local.
function nyOffsetHours(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const marchFirst = new Date(Date.UTC(y, 2, 1)).getUTCDay()
  const dstStart = new Date(Date.UTC(y, 2, 1 + ((7 - marchFirst) % 7) + 7))
  const novFirst = new Date(Date.UTC(y, 10, 1)).getUTCDay()
  const dstEnd = new Date(Date.UTC(y, 10, 1 + ((7 - novFirst) % 7)))
  const day = new Date(Date.UTC(y, m - 1, d))
  return day >= dstStart && day < dstEnd ? -4 : -5
}

function wallClockToInstant(dateStr, timeStr, offsetHours) {
  const [y, mo, d] = dateStr.split('-').map(Number)
  const [hh, mm, ss] = timeStr.split(':').map(Number)
  return new Date(Date.UTC(y, mo - 1, d, hh, mm, ss || 0) - offsetHours * 3600000)
}

function barEpochSeconds(bar) {
  return Number(BigInt(bar.tsEvent) / 1000000000n)
}

function addDaysToDateStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

function isTradingDay(dateStr) {
  const day = new Date(`${dateStr}T12:00:00Z`).getUTCDay()
  if (day === 0 || day === 6) return false
  return CME_HOLIDAYS[dateStr]?.type !== 'closed'
}

function isNearRollover(dateStr) {
  const date = new Date(`${dateStr}T00:00:00Z`)
  return NQ_ROLLOVER_DATES.some((roll) => Math.abs(roll.getTime() - date.getTime()) / 86400000 <= ROLL_PROXIMITY_DAYS)
}

// ---------- Databento (duplicated per this repo's no-ESM-in-scripts rule,
// see scan-strategy-setup-days.js's header for the full reasoning) ----------

function authHeader() {
  const apiKey = process.env.DATABENTO_API_KEY
  if (!apiKey) throw new Error('DATABENTO_API_KEY is not set')
  return 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64')
}

function normalizeRecord(record) {
  return {
    tsEvent: record.ts_event ?? record.hd?.ts_event ?? null,
    instrumentId: record.hd?.instrument_id ?? null,
    open: record.open / PRICE_SCALE,
    high: record.high / PRICE_SCALE,
    low: record.low / PRICE_SCALE,
    close: record.close / PRICE_SCALE,
    volume: Number(record.volume),
  }
}

function parseOhlcvRecords(text) {
  const trimmed = text.trim()
  if (!trimmed) return []
  try {
    const whole = JSON.parse(trimmed)
    if (Array.isArray(whole)) return whole.map(normalizeRecord)
    if (Array.isArray(whole?.records)) return whole.records.map(normalizeRecord)
  } catch {
    // Not a single JSON document - fall through to line-delimited parsing.
  }
  return trimmed.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => normalizeRecord(JSON.parse(l)))
}

async function fetchOhlcv1mRaw(symbols, stypeIn, start, end) {
  const url = new URL('/v0/timeseries.get_range', BASE_URL)
  url.searchParams.set('dataset', DATASET)
  url.searchParams.set('schema', 'ohlcv-1m')
  url.searchParams.set('symbols', symbols)
  url.searchParams.set('stype_in', stypeIn)
  url.searchParams.set('start', start.toISOString())
  url.searchParams.set('end', end.toISOString())
  url.searchParams.set('encoding', 'json')

  const res = await fetch(url, { headers: { Authorization: authHeader() } })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Databento get_range failed: ${res.status} ${res.statusText} ${body}`.trim())
  }
  return parseOhlcvRecords(await res.text())
}

async function resolveFrontMonthInstrumentId(root, start, end) {
  let records
  try {
    records = await fetchOhlcv1mRaw(`${root}.FUT`, 'parent', start, end)
  } catch {
    return null
  }
  const volumeByInstrument = new Map()
  for (const r of records) {
    if (r.instrumentId === null || r.instrumentId === undefined) continue
    volumeByInstrument.set(r.instrumentId, (volumeByInstrument.get(r.instrumentId) || 0) + r.volume)
  }
  let bestId = null
  let bestVolume = -1
  for (const [id, vol] of volumeByInstrument) {
    if (vol > bestVolume) {
      bestVolume = vol
      bestId = id
    }
  }
  return bestId
}

async function fetchOhlcv1m(symbol, start, end, { nearRollover } = {}) {
  if (!nearRollover) return fetchOhlcv1mRaw(`${symbol}.c.0`, 'continuous', start, end)
  const resolutionStart = new Date(end.getTime() - ROLLOVER_RESOLUTION_WINDOW_HOURS * 3600000)
  const instrumentId = await resolveFrontMonthInstrumentId(symbol, resolutionStart, end)
  if (instrumentId === null) return fetchOhlcv1mRaw(`${symbol}.c.0`, 'continuous', start, end)
  return fetchOhlcv1mRaw(String(instrumentId), 'instrument_id', start, end)
}

// ---------- profiles ----------

function aggregateBars(bars, intervalMinutes) {
  const groups = []
  let current = null
  let currentKey = null
  for (const bar of bars) {
    const minuteEpoch = BigInt(bar.tsEvent) / 1000000000n / 60n
    const key = minuteEpoch / BigInt(intervalMinutes)
    if (currentKey === null || key !== currentKey) {
      if (current) groups.push(current)
      current = { tsEvent: bar.tsEvent, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume }
      currentKey = key
    } else {
      current.high = Math.max(current.high, bar.high)
      current.low = Math.min(current.low, bar.low)
      current.close = bar.close
      current.volume += bar.volume
    }
  }
  if (current) groups.push(current)
  return groups
}

// Money-flow volume profile - see this file's header and scan-strategy-
// setup-days.js for why volume is split across every row a bar spans and
// weighted by row center price rather than dumped on a midpoint.
function volumeProfile(bars, rows) {
  if (bars.length === 0) return { poc: null, zones: [], totalFlow: 0, bucketSize: null }
  const high = Math.max(...bars.map((b) => b.high))
  const low = Math.min(...bars.map((b) => b.low))
  const step = (high - low) / rows || 1
  const rowTotals = new Array(rows).fill(0)

  for (const bar of bars) {
    const barRange = bar.high - bar.low
    const firstRow = Math.max(0, Math.floor((bar.low - low) / step))
    const lastRow = Math.min(rows - 1, Math.floor((bar.high - low) / step))
    for (let l = firstRow; l <= lastRow; l++) {
      const rowLow = low + l * step
      const rowHigh = rowLow + step
      if (bar.high < rowLow || bar.low >= rowHigh) continue
      let vPOR
      if (barRange <= 0) vPOR = 1
      else if (bar.low >= rowLow && bar.high > rowHigh) vPOR = (rowHigh - bar.low) / barRange
      else if (bar.high <= rowHigh && bar.low < rowLow) vPOR = (bar.high - rowLow) / barRange
      else if (bar.low >= rowLow && bar.high <= rowHigh) vPOR = 1
      else vPOR = step / barRange
      rowTotals[l] += bar.volume * vPOR * (rowLow + step / 2)
    }
  }

  const zones = rowTotals.map((flow, l) => ({
    bucketStart: low + l * step,
    bucketEnd: low + (l + 1) * step,
    flow,
  }))
  const totalFlow = zones.reduce((sum, z) => sum + z.flow, 0)
  const poc = zones.reduce((best, z) => (best === null || z.flow > best.flow ? z : best), null)
  return { poc, zones, totalFlow, bucketSize: step }
}

function midOf(zone) {
  return zone ? (zone.bucketStart + zone.bucketEnd) / 2 : null
}

function priceInZone(price, zone) {
  return !!zone && price >= zone.bucketStart && price < zone.bucketEnd
}

// The rolling profile input as it would have looked AT nowEpoch, and not a
// minute later. Pre-aggregating each day's 5m/15m series once (rather than
// re-aggregating from 1-minute bars every minute, which is what makes a
// full-year scan affordable) introduces a subtle lookahead: the aggregated
// bar CONTAINING nowEpoch spans minutes that have not happened yet, so
// slicing the pre-built series directly would let a 9:32 event see the
// 9:30-9:35 bar's full high, low and volume. That is invisible in the
// output and would inflate every result.
//
// So: take only bars that had genuinely CLOSED by nowEpoch, then rebuild
// the still-forming bar from the 1-minute bars elapsed so far. That
// matches what a live chart actually showed at that moment, at the cost
// of aggregating a handful of 1-minute bars rather than thousands.
function seriesAsOf(aggregated, bars1m, intervalMinutes, lookbackBars, nowEpoch) {
  const intervalSeconds = intervalMinutes * 60
  let closedCount = 0
  let lo = 0
  let hi = aggregated.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (barEpochSeconds(aggregated[mid]) + intervalSeconds <= nowEpoch) lo = mid + 1
    else hi = mid
  }
  closedCount = lo

  const closed = aggregated.slice(Math.max(0, closedCount - lookbackBars), closedCount)
  const formingStart = Math.floor(nowEpoch / intervalSeconds) * intervalSeconds
  let forming = null
  for (let i = bars1m.length - 1; i >= 0; i--) {
    const t = barEpochSeconds(bars1m[i])
    if (t > nowEpoch) continue
    if (t < formingStart) break
    const b = bars1m[i]
    if (forming === null) {
      forming = { tsEvent: b.tsEvent, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }
    } else {
      forming.open = b.open
      forming.high = Math.max(forming.high, b.high)
      forming.low = Math.min(forming.low, b.low)
      forming.volume += b.volume
    }
  }
  return forming ? closed.concat(forming) : closed
}

function zoneShare(zone, totalFlow) {
  if (!zone || !totalFlow) return null
  return zone.flow / totalFlow
}

// ---------- heatmap density ----------

// The rolling heatmap, in the density terms the indicator itself uses.
// Each bin carries two readings because the indicator's "Low/Mid/High
// Density (0-25/25-75/75-100%)" bands are ambiguous between them (see
// HEATMAP_HIGH_DENSITY): densityOfMax is the bin's volume as a share of
// the busiest bin, the usual meaning of a colour gradient; densityRank is
// its percentile rank among bins, which by construction paints a fixed
// quarter of bins yellow. Emitting both means the analysis can settle
// which one reproduces the trader's chart instead of this script guessing
// a third time.
function decorateHeatmap(heatmap) {
  if (!heatmap || !heatmap.totalFlow) return null
  const flows = heatmap.zones.map((z) => z.flow)
  const maxFlow = Math.max(...flows)
  if (!(maxFlow > 0)) return null
  const sorted = flows.slice().sort((a, b) => a - b)
  const bins = heatmap.zones.map((z) => {
    let below = 0
    while (below < sorted.length && sorted[below] < z.flow) below++
    return {
      bucketStart: z.bucketStart,
      bucketEnd: z.bucketEnd,
      densityOfMax: z.flow / maxFlow,
      densityRank: sorted.length > 1 ? below / (sorted.length - 1) : 0,
    }
  })
  return { bins, binHeight: heatmap.bucketSize }
}

function binAt(price, decorated) {
  if (!decorated) return null
  return decorated.bins.find((b) => price >= b.bucketStart && price < b.bucketEnd) || null
}

// Is this bin one the trader would read as yellow (high density, price has
// persistently transacted here and tends to be absorbed) or blue (low
// density, price travels through)?
function isYellow(bin) {
  return !!bin && bin.densityOfMax >= HEATMAP_HIGH_DENSITY
}

function isBlue(bin) {
  return !!bin && bin.densityOfMax <= HEATMAP_LOW_DENSITY
}

// What the trade has to travel THROUGH to reach its target - the piece the
// entry level alone cannot express. The trader's stated rule is about the
// path: reject out of a high-density ("yellow") area into a low-density
// ("blue") one, and stand aside when the trade would run from yellow into
// more yellow. The mechanism is ordinary auction logic - price is absorbed
// where volume has persistently transacted and travels fast where it has
// not - so a target behind a thick shelf has to be ground into, while the
// same distance through thin volume can be covered in one move.
//
// This is a HYPOTHESIS being measured, not an assumption being encoded.
// Everything here is reported as raw values alongside the other
// conditions, and it competes with them on equal footing; the rule may
// well turn out not to be what carries the edge.
function pathAhead(decorated, entry, direction, riskPoints, targetRMultiple) {
  if (!decorated || !(riskPoints > 0)) return null
  const targetPrice = direction === 'long' ? entry + riskPoints * targetRMultiple : entry - riskPoints * targetRMultiple
  const lo = Math.min(entry, targetPrice)
  const hi = Math.max(entry, targetPrice)

  const corridor = decorated.bins.filter((b) => b.bucketEnd > lo && b.bucketStart < hi)
  if (corridor.length === 0) return null

  // Walk outward from entry in the trade's own direction so "is there a
  // wall in the way" is a distance rather than an average a single thick
  // bin can hide inside of.
  const ordered = direction === 'long'
    ? corridor.slice().sort((a, b) => a.bucketStart - b.bucketStart)
    : corridor.slice().sort((a, b) => b.bucketStart - a.bucketStart)
  let yellowWallDistanceR = null
  for (const bin of ordered) {
    if (!isYellow(bin)) continue
    const edge = direction === 'long' ? bin.bucketStart : bin.bucketEnd
    const distance = Math.abs(edge - entry)
    if (distance <= 0) continue
    yellowWallDistanceR = distance / riskPoints
    break
  }

  const densities = corridor.map((b) => b.densityOfMax)
  return {
    meanDensity: densities.reduce((a, b) => a + b, 0) / densities.length,
    maxDensity: Math.max(...densities),
    yellowFraction: corridor.filter(isYellow).length / corridor.length,
    blueFraction: corridor.filter(isBlue).length / corridor.length,
    yellowWallDistanceR,
    targetBin: binAt(targetPrice, decorated),
  }
}

// ---------- conditions ----------

// Net directional travel divided by total travel over the window: 1.0 is a
// perfectly straight move, near 0 is pure chop. The trend-vs-balance axis.
function efficiencyRatio(bars) {
  if (bars.length < 3) return null
  const net = Math.abs(bars[bars.length - 1].close - bars[0].close)
  let path = 0
  for (let i = 1; i < bars.length; i++) path += Math.abs(bars[i].close - bars[i - 1].close)
  return path > 0 ? net / path : null
}

function averageTrueRange(bars) {
  if (bars.length < 2) return null
  let sum = 0
  for (let i = 1; i < bars.length; i++) {
    const prevClose = bars[i - 1].close
    const bar = bars[i]
    sum += Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose))
  }
  return sum / (bars.length - 1)
}

// ---------- outcome ----------

// Structural stop beyond the rejection wick plus a volatility buffer, then
// fixed R targets - see this file's header for why neither is node-based
// or a flat point count.
// How convincing is this rejection, as a bar? The event definition alone
// ("wick pierced the zone, close came back out") treats a one-tick poke
// exactly like a thirty-point spike, which is plainly not how a trader
// reads a chart - so the first year-long scan measured WHERE rejections
// happen in great detail and never measured whether they were any good.
// These are the cheapest three that capture it: how much of the bar is
// the rejecting wick, how far back through its own range price closed,
// and whether the bar traded unusual volume while doing it.
function rejectionQuality(bar, direction, recentBars) {
  const range = bar.high - bar.low
  if (!(range > 0)) return { wickFraction: null, closeStrength: null, volumeRatio: null }
  const wick = direction === 'long'
    ? Math.min(bar.open, bar.close) - bar.low
    : bar.high - Math.max(bar.open, bar.close)
  const closeStrength = direction === 'long'
    ? (bar.close - bar.low) / range
    : (bar.high - bar.close) / range
  let volumeRatio = null
  if (recentBars.length >= 5) {
    const vols = recentBars.map((b) => b.volume).filter((v) => v > 0).sort((a, b) => a - b)
    const medianVol = vols.length ? vols[Math.floor(vols.length / 2)] : 0
    if (medianVol > 0) volumeRatio = bar.volume / medianVol
  }
  return { wickFraction: Math.max(0, wick) / range, closeStrength, volumeRatio }
}

// Instead of simulating ONE stop and target, record how far and how fast
// price travelled in each direction - as the first bar index at which it
// reached each distance on a grid. Every (stop, target) pair is then
// computable offline from one scan: the trade wins if the target's
// first-touch index is lower than the stop's, loses otherwise, and is
// unresolved if neither fires. Exactly the same sequencing a bar-by-bar
// simulation gives, but it searches the whole exit space rather than one
// point in it.
//
// Why this replaced a single simulated stop: the first version used the
// rejection wick plus 0.25x the 1-minute ATR, giving a median risk of
// 16.8 points against a trader whose own logged median stop is 35.75. At
// that size a 2R target sat ~34 points away - about 1.3 heatmap bins - so
// the path features could not express "travel from yellow into blue" even
// in principle, and the stop was tight enough to be hit by noise. Rather
// than guess a better single number, this grid lets the data pick.
//
// Distances are in multiples of the current 1-minute ATR rather than raw
// points, so a level means the same thing in a quiet week and a wild one;
// atr1m ships with the event so points can be recovered.
const EXCURSION_ATR_GRID = [1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30]

function excursionProfile(barsAfter, direction, entry, atr1m) {
  if (!(atr1m > 0)) return null
  const favorable = new Array(EXCURSION_ATR_GRID.length).fill(null)
  const adverse = new Array(EXCURSION_ATR_GRID.length).fill(null)

  for (let i = 0; i < barsAfter.length; i++) {
    const bar = barsAfter[i]
    const fav = direction === 'long' ? bar.high - entry : entry - bar.low
    const adv = direction === 'long' ? entry - bar.low : bar.high - entry
    for (let g = 0; g < EXCURSION_ATR_GRID.length; g++) {
      const d = EXCURSION_ATR_GRID[g] * atr1m
      if (favorable[g] === null && fav >= d) favorable[g] = i + 1
      if (adverse[g] === null && adv >= d) adverse[g] = i + 1
    }
    // Both extremes past the widest rung means nothing further can change.
    if (favorable[favorable.length - 1] !== null && adverse[adverse.length - 1] !== null) break
  }
  return { favorable, adverse }
}

// ---------- main ----------

async function main() {
  const symbol = process.env.INSTRUMENT_SYMBOL || 'NQ'
  const scanStart = process.env.SCAN_START_DATE
  const scanEnd = process.env.SCAN_END_DATE
  if (!scanStart || !scanEnd) throw new Error('SCAN_START_DATE / SCAN_END_DATE are not set (YYYY-MM-DD)')

  const days = []
  for (let d = scanStart; d <= scanEnd; d = addDaysToDateStr(d, 1)) {
    if (isTradingDay(d)) days.push(d)
  }
  log(`Scanning ${days.length} trading day(s) from ${scanStart} to ${scanEnd} on ${symbol}...`)

  // Rolling buffer of prior sessions' 1-minute bars, oldest first. Each
  // day is fetched exactly once and then reused by every later day that
  // looks back at it - which is what makes the 7-day heatmap free.
  const sessionBuffer = []
  let eventCount = 0
  let daysWithEvents = 0

  for (const dateStr of days) {
    try {
      const offsetHours = nyOffsetHours(dateStr)
      const open930 = wallClockToInstant(dateStr, '09:30:00', offsetHours)
      const dayFetchStart = new Date(open930.getTime() - 16 * 3600000)
      const dayFetchEnd = new Date(open930.getTime() + (SCAN_WINDOW_MINUTES + FORWARD_WINDOW_MINUTES) * 60000)

      const dayBars = await fetchOhlcv1m(symbol, dayFetchStart, dayFetchEnd, { nearRollover: isNearRollover(dateStr) })
      if (dayBars.length === 0) {
        log(`${dateStr}: no bars returned - skipping.`)
        continue
      }

      sessionBuffer.push({ dateStr, bars: dayBars })
      while (sessionBuffer.length > SESSION_BUFFER_SESSIONS) sessionBuffer.shift()
      // Not enough history yet to fill a 7-day heatmap window or the 15m
      // profile's 240-bar lookback honestly.
      if (sessionBuffer.length < SESSION_BUFFER_SESSIONS) continue

      const priorSessions = sessionBuffer.slice(0, -1)
      const historyBars = priorSessions.flatMap((s) => s.bars)

      const priorSession = priorSessions[priorSessions.length - 1]
      const priorHigh = Math.max(...priorSession.bars.map((b) => b.high))
      const priorLow = Math.min(...priorSession.bars.map((b) => b.low))
      const priorRange = priorHigh - priorLow

      const dailyBars = priorSessions.slice(-ATR_DAYS - 1).map((s) => ({
        high: Math.max(...s.bars.map((b) => b.high)),
        low: Math.min(...s.bars.map((b) => b.low)),
        close: s.bars[s.bars.length - 1].close,
      }))
      const atrDaily = averageTrueRange(dailyBars)

      // All bars available to "now" as the scan walks forward: prior
      // sessions plus today. Aggregated ONCE per day here rather than
      // re-aggregated every minute - the per-minute rebuild in
      // scan-strategy-setup-days.js is affordable over a 90-minute window
      // and 91 days, but not over 330 minutes and a full year.
      const allBars = historyBars.concat(dayBars)
      const bars5mAll = aggregateBars(allBars, PROFILE_5M.intervalMinutes)
      const bars15mAll = aggregateBars(allBars, PROFILE_15M.intervalMinutes)

      const openEpoch = open930.getTime() / 1000
      const scanEndEpoch = openEpoch + SCAN_WINDOW_MINUTES * 60
      const scanBars = dayBars.filter((b) => {
        const t = barEpochSeconds(b)
        return t >= openEpoch && t <= scanEndEpoch
      })
      if (scanBars.length === 0) continue

      const openingRangeBars = dayBars.filter((b) => {
        const t = barEpochSeconds(b)
        return t >= openEpoch && t < openEpoch + OPENING_RANGE_MINUTES * 60
      })
      const openingRange = openingRangeBars.length
        ? Math.max(...openingRangeBars.map((b) => b.high)) - Math.min(...openingRangeBars.map((b) => b.low))
        : null
      const openRangeVsAtr = openingRange !== null && atrDaily ? openingRange / atrDaily : null

      let dayEvents = 0
      // Cursor into the 1-minute series, advanced as the scan walks forward
      // so each minute costs a short scan rather than a full pass.
      let idxAll = 0
      let heatmap = null
      let heatmapBuiltAt = null
      // Consecutive bars grinding along the same level fire the rejection
      // test over and over - a validation run over six weeks produced 92
      // events on one day, 65% of them within three minutes of a prior
      // same-direction one. Those are not independent observations, they
      // are one setup counted repeatedly, and left in they let a single
      // choppy session dominate a year of statistics. So once a direction
      // fires, it is suppressed until that trade would actually have
      // resolved - which is also the real constraint a trader is under,
      // since they are in the position and cannot take it again.
      const blockedUntilEpoch = {}

      for (const bar of scanBars) {
        const nowEpoch = barEpochSeconds(bar)
        while (idxAll + 1 < allBars.length && barEpochSeconds(allBars[idxAll + 1]) <= nowEpoch) idxAll++

        // The heatmap window rolls forward continuously with price, and
        // includes TODAY's volume as the session develops - it is not a
        // set of completed prior sessions. Rebuilt on a cadence rather
        // than every minute (see HEATMAP_REBUILD_MINUTES); only bars at or
        // before `now` ever enter it, so the roll introduces no lookahead.
        if (heatmapBuiltAt === null || nowEpoch - heatmapBuiltAt >= HEATMAP_REBUILD_MINUTES * 60) {
          const windowStart = nowEpoch - HEATMAP_LOOKBACK_DAYS * 86400
          const windowBars = allBars.filter((b) => {
            const t = barEpochSeconds(b)
            return t >= windowStart && t <= nowEpoch
          })
          heatmap = decorateHeatmap(volumeProfile(windowBars, HEATMAP_MAX_BINS))
          heatmapBuiltAt = nowEpoch
        }

        const profile5m = volumeProfile(
          seriesAsOf(bars5mAll, dayBars, PROFILE_5M.intervalMinutes, PROFILE_5M.lookbackBars, nowEpoch), PROFILE_ROWS)
        const profile15m = volumeProfile(
          seriesAsOf(bars15mAll, dayBars, PROFILE_15M.intervalMinutes, PROFILE_15M.lookbackBars, nowEpoch), PROFILE_ROWS)

        // A resting limit order at the MIDDLE of a level fills the moment
        // price trades there. That is what the trader actually does - "all
        // my limit orders are set in the middle of the 5POC" - and it makes
        // the rejection an OUTCOME being bet on, not an entry condition.
        //
        // The previous definition required the bar to wick into the zone
        // AND close back out of it, then entered at that close. That is a
        // materially different and strictly worse trade: it enters after
        // the bounce is already visible, further from the level, needing a
        // wider stop. On a ~17 point ATR the gap between "filled at the
        // POC" and "filled at the close of the bar that left the POC" can
        // be most of the intended risk - so the year-long null it produced
        // was measuring a strategy nobody trades.
        //
        // Whether a rejection actually followed is still recorded, as the
        // feature `rejectionConfirmed`, so "wait for confirmation" can be
        // tested as a filter rather than baked in as a precondition.
        for (const [name, zone, share] of [
          ['poc5', profile5m.poc, zoneShare(profile5m.poc, profile5m.totalFlow)],
          ['poc15', profile15m.poc, zoneShare(profile15m.poc, profile15m.totalFlow)],
          ['heatmap', isYellow(binAt(midOf(profile5m.poc), heatmap)) ? binAt(midOf(profile5m.poc), heatmap) : null, null],
        ]) {
          if (!zone) continue
          const limitPrice = midOf(zone)
          // Did this bar trade through the resting limit? If so it filled.
          if (bar.low > limitPrice || bar.high < limitPrice) continue

          // Which way the trade is taken follows the side price approached
          // from: arriving from above, the level is support and the limit
          // is a buy; arriving from below it is resistance and a sell.
          const priorClose = idxAll > 0 ? allBars[idxAll - 1].close : bar.open
          if (priorClose === limitPrice) continue
          const direction = priorClose > limitPrice ? 'long' : 'short'
          const key = `${name}:${direction}`
          if (nowEpoch < (blockedUntilEpoch[key] ?? 0)) continue

          const minutesSinceOpen = Math.round((nowEpoch - openEpoch) / 60)
          const recentBars = allBars.slice(Math.max(0, idxAll + 1 - ATR_1M_BARS), idxAll + 1)
          const atr1m = averageTrueRange(recentBars)
          const effBars = allBars.slice(Math.max(0, idxAll + 1 - EFFICIENCY_LOOKBACK_MINUTES), idxAll + 1)

          const barsAfter = dayBars.filter((b) => {
            const t = barEpochSeconds(b)
            return t > nowEpoch && t <= nowEpoch + FORWARD_WINDOW_MINUTES * 60
          })
          // Excursion is measured from the LIMIT PRICE, which is the fill,
          // not from the bar's close.
          const excursion = excursionProfile(barsAfter, direction, limitPrice, atr1m)
          if (!excursion) continue
          const quality = rejectionQuality(bar, direction, recentBars)
          // Did the bar that filled us go on to reject - wick through the
          // level and close back out on the trade's side? A feature now,
          // not a gate.
          const rejectionConfirmed = direction === 'long'
            ? bar.close >= zone.bucketEnd
            : bar.close < zone.bucketStart

          const refRisk = Math.abs(limitPrice - (direction === 'long' ? bar.low : bar.high)) + atr1m * STOP_BUFFER_ATR_MULT
          const resolveIdx = excursion.favorable[5] ?? excursion.adverse[5] ?? FORWARD_WINDOW_MINUTES
          blockedUntilEpoch[key] = nowEpoch + resolveIdx * 60

          const path2R = pathAhead(heatmap, limitPrice, direction, refRisk, 2)
          const path3R = pathAhead(heatmap, limitPrice, direction, refRisk, 3)
          const entryBin = binAt(limitPrice, heatmap)
          const levels = [{ name, share }]

          console.log('EVENT:' + JSON.stringify({
            date: dateStr,
            time: new Date(nowEpoch * 1000).toISOString(),
            direction,
            entry: limitPrice,
            levelType: name,
            rejectionConfirmed,
            levelTypes: levels.map((l) => l.name),
            confluenceCount: levels.length,
            levelShares: Object.fromEntries(levels.map((l) => [l.name, l.share])),
            // The trader's reject-from-yellow-into-blue rule, expressed in
            // the indicator's own density bands rather than a proxy. Both
            // readings of "density" are carried (see decorateHeatmap) so
            // the analysis can settle which matches their chart.
            entryDensityOfMax: entryBin ? entryBin.densityOfMax : null,
            entryDensityRank: entryBin ? entryBin.densityRank : null,
            entryIsYellow: entryBin ? isYellow(entryBin) : null,
            entryIsBlue: entryBin ? isBlue(entryBin) : null,
            // Null entry density is not missing data - it means the wick
            // sat outside the whole 7-day heatmap range, i.e. price beyond
            // all recent value, which is a condition in its own right.
            entryOutsideHeatmap: entryBin === null,
            heatmapBinHeight: heatmap ? heatmap.binHeight : null,

            pathMeanDensity2R: path2R ? path2R.meanDensity : null,
            pathMaxDensity2R: path2R ? path2R.maxDensity : null,
            pathYellowFraction2R: path2R ? path2R.yellowFraction : null,
            pathBlueFraction2R: path2R ? path2R.blueFraction : null,
            yellowWallDistanceR2R: path2R ? path2R.yellowWallDistanceR : null,
            targetIsBlue2R: path2R && path2R.targetBin ? isBlue(path2R.targetBin) : null,
            pathMeanDensity3R: path3R ? path3R.meanDensity : null,
            pathYellowFraction3R: path3R ? path3R.yellowFraction : null,
            yellowWallDistanceR3R: path3R ? path3R.yellowWallDistanceR : null,

            // The trader's stated rule as one boolean, so it can be tested
            // directly as a single hypothesis rather than reconstructed
            // from parts afterwards: rejected off ground that holds, with
            // no yellow shelf standing between entry and the target.
            traderRuleMatch2R: entryBin
              ? (!isBlue(entryBin) && path2R !== null && path2R.yellowWallDistanceR === null)
              : null,
            efficiencyRatio: efficiencyRatio(effBars),
            priorRangePosition: priorRange > 0 ? (wickExtreme - priorLow) / priorRange : null,
            insidePriorRange: wickExtreme >= priorLow && wickExtreme <= priorHigh,
            // Null, not a number, for an event that fires before the
            // opening range has finished forming - the 30-minute range is
            // not knowable at minute 12, and quietly using it there would
            // be lookahead in a condition variable rather than in a
            // price series, which is just as invalidating and much harder
            // to spot afterwards.
            openRangeVsAtr: minutesSinceOpen >= OPENING_RANGE_MINUTES ? openRangeVsAtr : null,
            atrDaily,
            minutesSinceOpen,
            atr1m,
            riskPoints: refRisk,
            wickFraction: quality.wickFraction,
            closeStrength: quality.closeStrength,
            volumeRatio: quality.volumeRatio,
            // First bar index at which price reached each rung of
            // EXCURSION_ATR_GRID, favourably and adversely. Any (stop,
            // target) pair is decided offline by comparing the two.
            fav: excursion.favorable,
            adv: excursion.adverse,
          }))
          eventCount++
          dayEvents++
        }
      }
      if (dayEvents > 0) daysWithEvents++
    } catch (err) {
      log(`${dateStr} failed: ${err.message}`)
    }

    await sleep(150)
  }

  console.log('SUMMARY:' + JSON.stringify({
    instrumentSymbol: symbol,
    scanStart,
    scanEnd,
    tradingDaysScanned: days.length,
    daysWithEvents,
    eventCount,
    heatmapLookbackDays: HEATMAP_LOOKBACK_DAYS,
    heatmapMaxBins: HEATMAP_MAX_BINS,
    excursionAtrGrid: EXCURSION_ATR_GRID,
  }))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
