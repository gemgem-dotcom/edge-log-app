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
// A rejection at a level: a 1-minute bar whose wick pierces into the
// level's price zone and whose close comes back out of it, in either
// direction (a long rejection = wicked down into the zone, closed back
// above it; short = the mirror). Three level families are tested, all
// computed from real Databento ohlcv-1m bars:
//
//   poc5      - POC of the rolling 5m/270-bar volume profile
//   poc15     - POC of the rolling 15m/240-bar volume profile
//   heatmap   - a high-intensity row of a rolling 20-SESSION volume-at-
//               price profile (the "historical heatmap" - the same idea as
//               a heatmap indicator: where has real volume persistently
//               transacted over weeks, not minutes)
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
// pathAhead(): entryIntensity, pathMeanIntensity, pathNodeDistanceR and
// clearanceRatio, all expressed relative to the heatmap's own median row
// so they mean the same thing across volatility regimes. This is the
// leading candidate for what separates a taken rejection from a passed
// one: a validation run showed the unfiltered signal winning 33.3% at a
// 2R target, where breakeven IS 33.3% - the level alone is worth
// precisely nothing, so all of the edge has to come from selection.
//
// ---------- how outcome is measured ----------
//
// Stop: structurally beyond the rejection wick's own extreme, plus a
// volatility buffer of STOP_BUFFER_ATR_MULT x the recent 1-minute ATR -
// NOT a fixed point count. A flat stop cannot adapt across volatility
// regimes, and volatility regime is one of the things under test, so a
// flat stop would silently confound it.
//
// Target: fixed multiples of that risk (2R and 3R), NOT a node-based
// target. A node-based target makes target DISTANCE a function of level
// quality, which confounds exactly the variable being measured. Fixed R
// keeps every event's outcome comparable on one scale.
//
// Both are resolved by walking forward bar-by-bar to see which price
// reaches first, with the conservative convention that a bar containing
// both is scored as the stop (1-minute OHLC does not reveal intra-bar
// sequence).
//
// ---------- data handling ----------
//
// Bars are fetched ONE DAY AT A TIME and kept in a rolling in-memory
// buffer of the last HEATMAP_LOOKBACK_SESSIONS sessions. That buffer
// feeds all three level families plus the ATR and prior-session stats, so
// a 20-session heatmap costs no more Databento usage than a 5-day one -
// each day's bars are fetched exactly once no matter how many later days
// look back at them. The first ~20 days of any scan range produce no
// events while the buffer fills, so start the range about a month before
// the period actually being studied.
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

// The rolling historical heatmap: volume-at-price over this many prior
// sessions, in this many rows. More rows than the intraday profiles
// because it spans a far wider price range - 25 rows over a month of NQ
// would make each row hundreds of points tall and meaningless.
const HEATMAP_LOOKBACK_SESSIONS = 20
const HEATMAP_ROWS = 120
// A heatmap row counts as a "node" worth rejecting at when it holds at
// least this share of the heatmap's total volume. With 120 rows, uniform
// distribution would put ~0.83% in each, so this is roughly "twice its
// fair share of volume".
const HEATMAP_NODE_MIN_SHARE = 0.017
// How much thicker than the heatmap's own median row a row must be to
// count as a shelf price would have to grind through - the "yellow" in
// the trader's own reject-from-yellow-into-blue description. Relative to
// the median rather than an absolute share so it means the same thing
// across a quiet month and a wild one.
const HEATMAP_WALL_INTENSITY = 1.5

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
const TARGET_R_MULTIPLES = [2, 3]

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

// The rolling historical heatmap: which price rows have persistently
// absorbed volume over the last HEATMAP_LOOKBACK_SESSIONS sessions. Built
// straight from raw 1-minute bars rather than an aggregated interval,
// since at this lookback the row height (not the bar interval) is what
// sets resolution.
function heatmapNodeAt(price, heatmap) {
  if (!heatmap || !heatmap.totalFlow) return null
  const zone = heatmap.zones.find((z) => priceInZone(price, z))
  if (!zone) return null
  const share = zone.flow / heatmap.totalFlow
  return share >= HEATMAP_NODE_MIN_SHARE ? { zone, share } : null
}

// The median share of the rows where price has actually traded. Used to
// express every heatmap reading as a MULTIPLE of typical rather than as a
// raw share: raw shares depend on how wide a range the last 20 sessions
// covered, so 2% means something different in a quiet month than a wild
// one, and would not be comparable across a year. Relative intensity is:
// 1.0 = an ordinary row, >1 = "yellow" (volume has persistently
// transacted here), <1 = "blue" (it has not).
function heatmapMedianShare(heatmap) {
  if (!heatmap || !heatmap.totalFlow) return null
  const shares = heatmap.zones.map((z) => z.flow / heatmap.totalFlow).filter((s) => s > 0).sort((a, b) => a - b)
  if (shares.length === 0) return null
  return shares[Math.floor(shares.length / 2)]
}

function relativeIntensity(price, heatmap, medianShare) {
  if (!heatmap || !heatmap.totalFlow || !medianShare) return null
  const zone = heatmap.zones.find((z) => priceInZone(price, z))
  if (!zone) return null
  return (zone.flow / heatmap.totalFlow) / medianShare
}

// What the trade has to travel THROUGH to reach its target, which is the
// piece the rest of this script was missing entirely. The trader's own
// stated rule is about the path, not the entry: reject out of a
// high-volume ("yellow") area into a low-volume ("blue") one, and stand
// aside when a rejection would have to trade from yellow into more
// yellow. The mechanism is standard auction logic - price is absorbed and
// chops where volume has persistently transacted, and travels fast where
// it has not - so a target sitting behind a thick shelf is a target price
// has to grind into, while the same distance through thin volume is a
// target it can reach in one move.
//
// Returns intensities relative to the heatmap's own median row (see
// heatmapMedianShare), plus how far away the first genuinely thick row
// is, expressed in R so it is directly comparable to the target distance:
// nodeDistanceR < 2 means a wall sits between entry and the 2R target.
function pathAhead(heatmap, medianShare, entry, direction, riskPoints, targetRMultiple) {
  if (!heatmap || !heatmap.totalFlow || !medianShare || !(riskPoints > 0)) return null
  const targetPrice = direction === 'long' ? entry + riskPoints * targetRMultiple : entry - riskPoints * targetRMultiple
  const lo = Math.min(entry, targetPrice)
  const hi = Math.max(entry, targetPrice)

  const corridor = heatmap.zones.filter((z) => z.bucketEnd > lo && z.bucketStart < hi)
  if (corridor.length === 0) return null
  const intensities = corridor.map((z) => (z.flow / heatmap.totalFlow) / medianShare)

  // Walk outward from entry in the trade's direction for the first row
  // thick enough to act as a shelf, so "is there a wall in the way" is a
  // distance rather than an average that a single thick row can hide in.
  const ordered = direction === 'long'
    ? corridor.slice().sort((a, b) => a.bucketStart - b.bucketStart)
    : corridor.slice().sort((a, b) => b.bucketStart - a.bucketStart)
  let nodeDistanceR = null
  for (const zone of ordered) {
    if ((zone.flow / heatmap.totalFlow) / medianShare < HEATMAP_WALL_INTENSITY) continue
    const edge = direction === 'long' ? zone.bucketStart : zone.bucketEnd
    const distance = Math.abs(edge - entry)
    if (distance <= 0) continue
    nodeDistanceR = distance / riskPoints
    break
  }

  return {
    meanIntensity: intensities.reduce((a, b) => a + b, 0) / intensities.length,
    maxIntensity: Math.max(...intensities),
    nodeDistanceR,
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
function simulateOutcomes(barsAfter, direction, entry, wickExtreme, atr1m) {
  const buffer = (atr1m ?? 0) * STOP_BUFFER_ATR_MULT
  const stopPrice = direction === 'long' ? wickExtreme - buffer : wickExtreme + buffer
  const riskPoints = Math.abs(entry - stopPrice)
  if (!(riskPoints > 0)) return { riskPoints: null, outcomes: {} }

  const outcomes = {}
  let firstResolvedBars = null
  for (const rMult of TARGET_R_MULTIPLES) {
    const targetPrice = direction === 'long' ? entry + riskPoints * rMult : entry - riskPoints * rMult
    let result = 'unresolved'
    let bars = null
    for (let i = 0; i < barsAfter.length; i++) {
      const bar = barsAfter[i]
      const stopHit = direction === 'long' ? bar.low <= stopPrice : bar.high >= stopPrice
      const targetHit = direction === 'long' ? bar.high >= targetPrice : bar.low <= targetPrice
      if (stopHit) { result = 'loss'; bars = i + 1; break }
      if (targetHit) { result = 'win'; bars = i + 1; break }
    }
    outcomes[`r${rMult}`] = result
    // The tightest target resolves first and is what frees the trader up
    // to take another signal, so it sets the cooldown below.
    if (firstResolvedBars === null && bars !== null) firstResolvedBars = bars
  }
  return { riskPoints, stopPrice, outcomes, barsToResolve: firstResolvedBars }
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
  // looks back at it - which is what makes a 20-session heatmap free.
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
      while (sessionBuffer.length > HEATMAP_LOOKBACK_SESSIONS + 1) sessionBuffer.shift()
      // Not enough history yet to build the long lookback honestly.
      if (sessionBuffer.length <= HEATMAP_LOOKBACK_SESSIONS) continue

      const priorSessions = sessionBuffer.slice(0, -1)
      const historyBars = priorSessions.flatMap((s) => s.bars)
      const heatmap = volumeProfile(historyBars, HEATMAP_ROWS)
      const heatmapMedian = heatmapMedianShare(heatmap)

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
      // Consecutive bars grinding along the same level fire the rejection
      // test over and over - a validation run over six weeks produced 92
      // events on one day, 65% of them within three minutes of a prior
      // same-direction one. Those are not independent observations, they
      // are one setup counted repeatedly, and left in they let a single
      // choppy session dominate a year of statistics. So once a direction
      // fires, it is suppressed until that trade would actually have
      // resolved - which is also the real constraint a trader is under,
      // since they are in the position and cannot take it again.
      const blockedUntilEpoch = { long: 0, short: 0 }

      for (const bar of scanBars) {
        const nowEpoch = barEpochSeconds(bar)
        while (idxAll + 1 < allBars.length && barEpochSeconds(allBars[idxAll + 1]) <= nowEpoch) idxAll++

        const profile5m = volumeProfile(
          seriesAsOf(bars5mAll, dayBars, PROFILE_5M.intervalMinutes, PROFILE_5M.lookbackBars, nowEpoch), PROFILE_ROWS)
        const profile15m = volumeProfile(
          seriesAsOf(bars15mAll, dayBars, PROFILE_15M.intervalMinutes, PROFILE_15M.lookbackBars, nowEpoch), PROFILE_ROWS)

        for (const direction of ['long', 'short']) {
          if (nowEpoch < blockedUntilEpoch[direction]) continue
          const wickExtreme = direction === 'long' ? bar.low : bar.high

          // Which level families does this wick reject at? A rejection
          // needs the wick INTO the zone and the close back OUT of it.
          const levels = []
          for (const [name, zone, share] of [
            ['poc5', profile5m.poc, zoneShare(profile5m.poc, profile5m.totalFlow)],
            ['poc15', profile15m.poc, zoneShare(profile15m.poc, profile15m.totalFlow)],
          ]) {
            if (!priceInZone(wickExtreme, zone)) continue
            const closedOut = direction === 'long' ? bar.close >= zone.bucketEnd : bar.close < zone.bucketStart
            if (closedOut) levels.push({ name, share })
          }
          const hmNode = heatmapNodeAt(wickExtreme, heatmap)
          if (hmNode) {
            const closedOut = direction === 'long'
              ? bar.close >= hmNode.zone.bucketEnd
              : bar.close < hmNode.zone.bucketStart
            if (closedOut) levels.push({ name: 'heatmap', share: hmNode.share })
          }
          if (levels.length === 0) continue

          const minutesSinceOpen = Math.round((nowEpoch - openEpoch) / 60)
          const recentBars = allBars.slice(Math.max(0, idxAll + 1 - ATR_1M_BARS), idxAll + 1)
          const atr1m = averageTrueRange(recentBars)
          const effBars = allBars.slice(Math.max(0, idxAll + 1 - EFFICIENCY_LOOKBACK_MINUTES), idxAll + 1)

          const barsAfter = dayBars.filter((b) => {
            const t = barEpochSeconds(b)
            return t > nowEpoch && t <= nowEpoch + FORWARD_WINDOW_MINUTES * 60
          })
          const sim = simulateOutcomes(barsAfter, direction, bar.close, wickExtreme, atr1m)
          if (!sim.riskPoints) continue

          // Hold this direction until the trade would have resolved, so
          // the next event is a genuinely new setup - see blockedUntilEpoch.
          blockedUntilEpoch[direction] = nowEpoch + (sim.barsToResolve ?? FORWARD_WINDOW_MINUTES) * 60

          const path2R = pathAhead(heatmap, heatmapMedian, bar.close, direction, sim.riskPoints, 2)
          const path3R = pathAhead(heatmap, heatmapMedian, bar.close, direction, sim.riskPoints, 3)
          const entryIntensity = relativeIntensity(wickExtreme, heatmap, heatmapMedian)

          console.log('EVENT:' + JSON.stringify({
            date: dateStr,
            time: new Date(nowEpoch * 1000).toISOString(),
            direction,
            entry: bar.close,
            levelTypes: levels.map((l) => l.name),
            confluenceCount: levels.length,
            levelShares: Object.fromEntries(levels.map((l) => [l.name, l.share])),
            heatmapShare: hmNode ? hmNode.share : null,
            // The trader's reject-from-yellow-into-blue rule, made
            // measurable: how thick the level itself is, how thick the
            // ground between it and the target is, and how far off the
            // first real shelf sits in R. entryIntensity is populated for
            // every event, not only ones passing the node threshold, so
            // "rejected from thin" is a value rather than a null.
            entryIntensity,
            pathMeanIntensity2R: path2R ? path2R.meanIntensity : null,
            pathMaxIntensity2R: path2R ? path2R.maxIntensity : null,
            pathNodeDistanceR2R: path2R ? path2R.nodeDistanceR : null,
            pathMeanIntensity3R: path3R ? path3R.meanIntensity : null,
            pathNodeDistanceR3R: path3R ? path3R.nodeDistanceR : null,
            // >1 = rejecting out of ground thicker than what lies ahead,
            // i.e. the yellow-into-blue case; <1 = into more yellow.
            clearanceRatio2R: path2R && entryIntensity && path2R.meanIntensity > 0
              ? entryIntensity / path2R.meanIntensity
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
            riskPoints: sim.riskPoints,
            outcomes: sim.outcomes,
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
    heatmapLookbackSessions: HEATMAP_LOOKBACK_SESSIONS,
    targetRMultiples: TARGET_R_MULTIPLES,
  }))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
