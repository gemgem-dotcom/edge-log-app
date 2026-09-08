#!/usr/bin/env node

// Diagnostic / research script - NOT part of the app's runtime, NOT
// scheduled. Run manually via the "Run a diagnostic script" GitHub Action.
//
// A from-scratch search for an intraday NQ edge, with no reference to any
// logged trade, any volume profile, or any level the trader named. The
// preceding investigation established that the 5m POC limit is a coin, and
// that the conditions attached to it (session window, range position, 15m POC
// precondition, impulse fade) do not rescue it. So this stops trying to
// explain that strategy and asks the blunter question: over a year of real
// bars, does ANY simple mechanical rule beat a matched random entry.
//
// ---------- how this avoids finding a ghost ----------
//
// Searching ~1000 rule variants against one year of data will produce
// spectacular-looking results by chance alone. Three things stand between the
// search and a false positive, and none of them is optional:
//
// 1. A MATCHED RANDOM NULL, not a coin. Each rule is scored against random
//    entries drawn from the same sessions, stratified by half-hour bucket and
//    direction so the null inherits the rule's own timing and long/short mix.
//    A breakout rule that only fires at 10:00 is compared against darts thrown
//    at 10:00. This is what catches "edges" that are really just intraday
//    drift or the fact that longs made money in a rising year.
//
// 2. BONFERRONI OVER EVERY HYPOTHESIS TESTED, counted honestly - including
//    the ones that failed. The threshold is printed alongside the count so it
//    cannot be quietly relaxed afterwards.
//
// 3. A SEALED HOLDOUT. Everything above runs on 2025-08-01..2026-06-05. The
//    final three months are scored exactly once, at the end, for whatever
//    survived. A rule that clears Bonferroni on exploration and dies on the
//    holdout was noise, and that outcome is reported as loudly as a success.
//
// Costs are charged on every trade (see strategy-core.js). Unresolved trades
// are marked to market rather than dropped, and bars that span both stop and
// target are charged as losses and counted.
//
// Env: DATABENTO_API_KEY, plus optional SCAN_START_DATE / SCAN_END_DATE /
// HOLDOUT_START_DATE to move the boundaries.

const {
  atrSeries,
  vwapSeries,
  rollingExtremes,
  openingRange,
  resolveTrade,
  scoreTrades,
  makeRng,
  mean,
  stdev,
} = require('./strategy-core.js')

const CME_HOLIDAYS = require('../lib/cmeHolidays.json')
const NQ_ROLLOVER_DATES = require('../lib/contractRollover.json').NQ.map((d) => new Date(`${d}T00:00:00Z`))

const DATASET = 'GLBX.MDP3'
const PRICE_SCALE = 1e9
const BASE_URL = 'https://hist.databento.com'
const SYMBOL = 'NQ'

const DEFAULT_START = '2025-08-01'
const DEFAULT_HOLDOUT_START = '2026-06-06'
const DEFAULT_END = '2026-09-05'

// Session geometry, in minutes from the 9:30 ET open.
const SESSION_MINUTES = 390          // 9:30 to 16:00
const LAST_ENTRY_MINUTE = 330        // 15:00, leaving room to resolve
const MAX_HOLD_BARS = 120            // two hours
const BUCKET_MINUTES = 30            // null stratification granularity

const ROLL_PROXIMITY_DAYS = 10
const ROLLOVER_RESOLUTION_WINDOW_HOURS = 6

// Search space. Every combination of these is one hypothesis, and the count
// is what the Bonferroni threshold divides by.
const STOP_MULTS = [1.5, 2, 3]
const TARGET_MULTS = [1.5, 2, 3, 4, 6]
const WINDOWS = [
  { name: 'open', startMinute: 0, endMinute: 120 },      // 9:30-11:30
  { name: 'midday', startMinute: 120, endMinute: 270 },  // 11:30-14:00
  { name: 'allday', startMinute: 0, endMinute: LAST_ENTRY_MINUTE },
]

const BOOTSTRAP_DRAWS = 500
// The pool has to populate bucket x direction x volatility-bin cells, so it
// needs to be far denser than a flat null would require.
const RANDOM_POOL_PER_SESSION = 60
// Volatility bins for null matching. Five is enough to remove the regime
// confound (see buildAtrBins) without thinning cells to the point where the
// null is drawn from a handful of darts.
const ATR_BINS = 5
const MIN_TRADES = 40          // below this, no result is worth reading
const ALPHA = 0.05
const RNG_SEED = 20260908

function log(...args) {
  console.error(new Date().toISOString(), ...args)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------- dates (duplicated per this repo's no-ESM-in-scripts rule) ----------

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

function enumerateDays(startDate, endDate) {
  const days = []
  for (let d = startDate; d <= endDate; d = addDaysToDateStr(d, 1)) {
    if (isTradingDay(d)) days.push(d)
  }
  return days
}

// ---------- Databento ----------

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

// ---------- session assembly ----------

// One session = the RTH bars indexed 0..389 from 9:30, plus the prior day's
// levels, plus every causal indicator series the signals read. Built once per
// day and reused across all ~1000 hypotheses.
function buildSession(dateStr, rawBars) {
  const offset = nyOffsetHours(dateStr)
  const openInstant = wallClockToInstant(dateStr, '09:30:00', offset).getTime()
  const closeInstant = openInstant + SESSION_MINUTES * 60000
  const priorStart = openInstant - 24 * 3600000

  const bars = []
  const priorDayBars = []
  for (const raw of rawBars) {
    const ms = Number(BigInt(raw.tsEvent) / 1000000n)
    if (ms >= openInstant && ms < closeInstant) bars.push({ ...raw, ms })
    else if (ms >= priorStart && ms < openInstant) priorDayBars.push({ ...raw, ms })
  }
  if (bars.length < SESSION_MINUTES * 0.8 || priorDayBars.length === 0) return null

  const atr = atrSeries(bars)
  const { vwap, sigma } = vwapSeries(bars)
  return {
    date: dateStr,
    bars,
    atr,
    vwap,
    sigma,
    priorHigh: Math.max(...priorDayBars.map((b) => b.high)),
    priorLow: Math.min(...priorDayBars.map((b) => b.low)),
    priorClose: priorDayBars[priorDayBars.length - 1].close,
    rolling15: rollingExtremes(bars, 15),
    rolling30: rollingExtremes(bars, 30),
    or5: openingRange(bars, 5),
    or15: openingRange(bars, 15),
    or30: openingRange(bars, 30),
  }
}

// ---------- signal families ----------
//
// Each returns candidate SIGNAL bar indices with a direction. The trade is
// entered at the OPEN of the following bar, so a signal at index i is only
// ever allowed to read bars 0..i.

function withCooldown(candidates, cooldownBars) {
  const out = []
  const lastByDirection = new Map()
  for (const c of candidates) {
    const last = lastByDirection.get(c.direction)
    if (last !== undefined && c.index - last < cooldownBars) continue
    lastByDirection.set(c.direction, c.index)
    out.push(c)
  }
  return out
}

// Opening-range break. `follow` true trades the break, false fades it. One
// per side per session, which is what stops a chopping day from generating
// forty entries and swamping the sample with a single session.
function signalOpeningRange(session, { minutes, follow }) {
  const or = minutes === 5 ? session.or5 : minutes === 15 ? session.or15 : session.or30
  if (!or) return []
  const out = []
  let firedUp = false
  let firedDown = false
  for (let i = or.readyIndex; i < session.bars.length; i++) {
    const close = session.bars[i].close
    if (!firedUp && close > or.high) {
      firedUp = true
      out.push({ index: i, direction: follow ? 'long' : 'short' })
    }
    if (!firedDown && close < or.low) {
      firedDown = true
      out.push({ index: i, direction: follow ? 'short' : 'long' })
    }
    if (firedUp && firedDown) break
  }
  return out.sort((a, b) => a.index - b.index)
}

// Stretched away from session VWAP by k volume-weighted sigmas, traded back
// toward it.
function signalVwapReversion(session, { sigmas }) {
  const out = []
  for (let i = 30; i < session.bars.length; i++) {
    const s = session.sigma[i]
    if (!s || s <= 0) continue
    const deviation = (session.bars[i].close - session.vwap[i]) / s
    if (deviation >= sigmas) out.push({ index: i, direction: 'short' })
    else if (deviation <= -sigmas) out.push({ index: i, direction: 'long' })
  }
  return withCooldown(out, 30)
}

// Crossing VWAP, traded in the direction of the cross.
function signalVwapCross(session) {
  const out = []
  for (let i = 30; i < session.bars.length; i++) {
    const prev = session.bars[i - 1].close - session.vwap[i - 1]
    const now = session.bars[i].close - session.vwap[i]
    if (prev <= 0 && now > 0) out.push({ index: i, direction: 'long' })
    else if (prev >= 0 && now < 0) out.push({ index: i, direction: 'short' })
  }
  return withCooldown(out, 30)
}

// Reaction at the prior day's high or low. `follow` true trades the break
// through it, false trades the rejection off it.
function signalPriorDayLevel(session, { follow }) {
  const out = []
  let firedHigh = false
  let firedLow = false
  for (let i = 1; i < session.bars.length; i++) {
    const bar = session.bars[i]
    if (!firedHigh && bar.high >= session.priorHigh) {
      firedHigh = true
      const rejected = bar.close < session.priorHigh
      out.push({ index: i, direction: follow === !rejected ? 'long' : 'short' })
    }
    if (!firedLow && bar.low <= session.priorLow) {
      firedLow = true
      const rejected = bar.close > session.priorLow
      out.push({ index: i, direction: follow === !rejected ? 'short' : 'long' })
    }
    if (firedHigh && firedLow) break
  }
  return out.sort((a, b) => a.index - b.index)
}

// An n-bar move worth k ATR, traded with it (follow) or against it (fade).
function signalMomentum(session, { bars: lookback, atrMult, follow }) {
  const out = []
  for (let i = lookback; i < session.bars.length; i++) {
    const atr = session.atr[i]
    if (!atr || atr <= 0) continue
    const move = session.bars[i].close - session.bars[i - lookback].close
    if (move >= atrMult * atr) out.push({ index: i, direction: follow ? 'long' : 'short' })
    else if (move <= -atrMult * atr) out.push({ index: i, direction: follow ? 'short' : 'long' })
  }
  return withCooldown(out, 30)
}

// Break of the rolling n-bar range (the window excludes the current bar, so
// the break is real - see rollingExtremes).
function signalRangeBreak(session, { bars: lookback }) {
  const extremes = lookback === 15 ? session.rolling15 : session.rolling30
  const out = []
  for (let i = lookback; i < session.bars.length; i++) {
    const high = extremes.high[i]
    const low = extremes.low[i]
    if (high === null || low === null) continue
    if (session.bars[i].close > high) out.push({ index: i, direction: 'long' })
    else if (session.bars[i].close < low) out.push({ index: i, direction: 'short' })
  }
  return withCooldown(out, 30)
}

// The full catalogue. Adding a line here adds a hypothesis, and the Bonferroni
// threshold moves accordingly - which is the intended cost of a wider search.
function buildSignalCatalogue() {
  const variants = []
  for (const minutes of [5, 15, 30]) {
    variants.push({ name: `orb${minutes}`, fn: (s) => signalOpeningRange(s, { minutes, follow: true }) })
    variants.push({ name: `orFade${minutes}`, fn: (s) => signalOpeningRange(s, { minutes, follow: false }) })
  }
  for (const sigmas of [1.5, 2, 2.5]) {
    variants.push({ name: `vwapRev${sigmas}`, fn: (s) => signalVwapReversion(s, { sigmas }) })
  }
  variants.push({ name: 'vwapCross', fn: (s) => signalVwapCross(s) })
  variants.push({ name: 'pdFollow', fn: (s) => signalPriorDayLevel(s, { follow: true }) })
  variants.push({ name: 'pdFade', fn: (s) => signalPriorDayLevel(s, { follow: false }) })
  for (const bars of [5, 15]) {
    for (const atrMult of [1, 2]) {
      variants.push({ name: `mom${bars}x${atrMult}`, fn: (s) => signalMomentum(s, { bars, atrMult, follow: true }) })
      variants.push({ name: `fade${bars}x${atrMult}`, fn: (s) => signalMomentum(s, { bars, atrMult, follow: false }) })
    }
  }
  for (const bars of [15, 30]) {
    variants.push({ name: `break${bars}`, fn: (s) => signalRangeBreak(s, { bars }) })
  }
  return variants
}

// ---------- trade construction ----------

function bucketOf(minute) {
  return Math.floor(minute / BUCKET_MINUTES)
}

// Quantile breakpoints of ATR across every tradeable minute of the
// exploration set.
//
// This is not cosmetic - it is the fix for the bug that made the first two
// control runs report z > 4 on data with no edge. Signals are not volatility-
// neutral: momentum and breakout rules fire almost exclusively when ATR is
// elevated, while random darts land anywhere. Because the stop and target are
// sized from a TRAILING ATR estimate, entries made when that estimate is high
// resolve differently from entries made when it is low - volatility mean
// reverts, so the barriers sit at a different effective distance in each
// regime. Comparing a high-ATR rule against an all-ATR null therefore scores
// the regime, not the rule, and reliably manufactures significance.
//
// Matching on the bin makes the comparison "this rule versus a dart thrown at
// the same time of day, on the same side, in the same volatility regime".
function buildAtrBins(sessions) {
  const values = []
  for (const session of sessions) {
    for (let i = 0; i < Math.min(session.atr.length, LAST_ENTRY_MINUTE); i++) {
      if (session.atr[i] > 0) values.push(session.atr[i])
    }
  }
  values.sort((a, b) => a - b)
  const edges = []
  for (let k = 1; k < ATR_BINS; k++) edges.push(values[Math.floor((values.length * k) / ATR_BINS)])
  return edges
}

function atrBinOf(atr, edges) {
  let bin = 0
  while (bin < edges.length && atr >= edges[bin]) bin++
  return bin
}

// Turns a signal into a fully specified trade against one (stop, target).
// Returns null when the signal is too late in the session to resolve, or the
// ATR is unusable.
function makeTrade(session, signal, stopMult, targetMult, atrEdges) {
  const signalIndex = signal.index
  const entryIndex = signalIndex + 1
  if (signalIndex > LAST_ENTRY_MINUTE || entryIndex >= session.bars.length) return null
  const atr = session.atr[signalIndex]
  if (!atr || atr <= 0) return null

  const stopPoints = stopMult * atr
  const targetPoints = targetMult * atr
  const outcome = resolveTrade(session.bars, entryIndex, signal.direction, stopPoints, targetPoints, MAX_HOLD_BARS)
  if (outcome.entryPrice === null) return null

  // Mark an unresolved trade at the last bar it was held through, so it
  // contributes its real (usually small) result instead of vanishing.
  let exitPoints = null
  if (outcome.result === 'open') {
    const exitIndex = Math.min(session.bars.length - 1, entryIndex + outcome.bars - 1)
    const move = session.bars[exitIndex].close - outcome.entryPrice
    exitPoints = signal.direction === 'long' ? move : -move
  }

  return {
    date: session.date,
    minute: signalIndex,
    bucket: bucketOf(signalIndex),
    atrBin: atrEdges ? atrBinOf(atr, atrEdges) : 0,
    direction: signal.direction,
    result: outcome.result,
    stopPoints,
    targetPoints,
    exitPoints,
    holdBars: outcome.bars,
  }
}

// ---------- the matched null ----------
//
// A pool of random entries per (stop, target), drawn from the same sessions
// and resolved by exactly the same code path as the real signals. Stratified
// by half-hour bucket and direction so a rule is judged against darts thrown
// at the same time of day, on the same side.

function buildRandomPool(sessions, stopMult, targetMult, rng, atrEdges) {
  const pool = new Map()
  for (const session of sessions) {
    for (let k = 0; k < RANDOM_POOL_PER_SESSION; k++) {
      const index = Math.floor(rng() * LAST_ENTRY_MINUTE)
      const direction = rng() < 0.5 ? 'long' : 'short'
      const trade = makeTrade(session, { index, direction }, stopMult, targetMult, atrEdges)
      if (!trade) continue
      const points = scoreTrades([trade]).expectancyPoints
      for (const key of poolKeys(trade)) {
        if (!pool.has(key)) pool.set(key, [])
        pool.get(key).push(points)
      }
    }
  }
  return pool
}

// Finest first. A trade is filed under all three so a thin exact cell can fall
// back to a coarser one rather than silently dropping the trade from the null.
function poolKeys(trade) {
  return [
    `${trade.bucket}:${trade.direction}:${trade.atrBin}`,
    `${trade.bucket}:${trade.direction}`,
    `${trade.direction}`,
  ]
}

const MIN_CELL_SAMPLES = 15

function lookupCell(pool, trade) {
  for (const key of poolKeys(trade)) {
    const cell = pool.get(key)
    if (cell && cell.length >= MIN_CELL_SAMPLES) return { cell, key }
  }
  return null
}

// Stratified bootstrap: for each real trade, draw a random trade from the same
// bucket and direction, and take the mean. Repeating that gives the
// distribution of what this rule's exact timing and side mix would earn with
// no skill at all.
function bootstrapNull(trades, pool, rng, draws = BOOTSTRAP_DRAWS) {
  const found = trades.map((t) => lookupCell(pool, t)).filter(Boolean)
  const cells = found.map((f) => f.cell)
  // Refuse to judge a rule whose timing the pool barely covers - a null built
  // from three darts is not a null.
  if (cells.length < trades.length * 0.9) return null
  const exactMatches = found.filter((f) => f.key.split(':').length === 3).length
  const means = []
  for (let d = 0; d < draws; d++) {
    let sum = 0
    for (const cell of cells) sum += cell[Math.floor(rng() * cell.length)]
    means.push(sum / cells.length)
  }
  const m = mean(means)
  const sd = stdev(means)
  return { nullMean: m, nullSd: sd, draws, cellsUsed: cells.length, exactCellFraction: exactMatches / cells.length }
}

function evaluate(trades, pool, rng) {
  const score = scoreTrades(trades)
  const nul = bootstrapNull(trades, pool, rng)
  if (!nul || !nul.nullSd || nul.nullSd <= 0) return { ...score, z: null, nullMean: nul ? nul.nullMean : null }
  const z = (score.expectancyPoints - nul.nullMean) / nul.nullSd
  return { ...score, nullMean: nul.nullMean, nullSd: nul.nullSd, exactCellFraction: nul.exactCellFraction, z }
}

// Two-sided normal tail. Good enough at these magnitudes, and stated as an
// approximation rather than dressed up as exact.
function twoSidedP(z) {
  if (z === null || !Number.isFinite(z)) return null
  const a = Math.abs(z)
  // Abramowitz & Stegun 7.1.26 error-function approximation.
  const t = 1 / (1 + 0.3275911 * (a / Math.SQRT2))
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592)
    * t * Math.exp(-(a / Math.SQRT2) * (a / Math.SQRT2))
  return Math.max(Number.MIN_VALUE, 1 - y)
}

// ---------- focused re-test of a single pre-registered rule ----------
//
// Set FOCUS_SIGNAL (plus FOCUS_WINDOW / FOCUS_STOP / FOCUS_TARGET) and the
// grid search is skipped entirely in favour of one rule, examined two ways.
//
// The order matters and is the point of the mode.
//
// STABILITY runs first, on the exploration set only, and costs nothing. A
// rule whose whole year came out of one quarter is not a rule, and there is
// no reason to spend a holdout finding that out. Each sub-period gets its own
// matched null built from its own sessions, so a quarter is judged against
// darts thrown in that quarter - otherwise a calm stretch scored against a
// violent year's null looks like skill.
//
// HOLDOUT runs second and exactly once. By the time it runs, the rule, its
// parameters, the window and the direction are all fixed by the environment
// this process was started with - nothing about it can be tuned in response
// to what the holdout says, which is the only property that makes an
// out-of-sample test worth anything. Whatever it returns is the answer,
// including when the answer is that the exploration result was noise.

function subPeriods(sessions, count) {
  const size = Math.ceil(sessions.length / count)
  const chunks = []
  for (let i = 0; i < sessions.length; i += size) chunks.push(sessions.slice(i, i + size))
  return chunks
}

function tradesFor(sessions, signalFn, window, stopMult, targetMult, atrEdges) {
  const trades = []
  for (const session of sessions) {
    for (const signal of signalFn(session)) {
      if (signal.index < window.startMinute || signal.index >= window.endMinute) continue
      const trade = makeTrade(session, signal, stopMult, targetMult, atrEdges)
      if (trade) trades.push(trade)
    }
  }
  return trades
}

// Two ways in: four separate env vars, which is convenient locally, or one
// colon-joined FOCUS string. The combined form exists because
// workflow_dispatch allows at most ten inputs and run-diagnostic.yml is
// already at eight - four more would not fit.
function parseFocus() {
  const combined = (process.env.FOCUS || '').trim()
  if (combined) {
    const [signal, window, stop, target] = combined.split(':')
    if (!signal) throw new Error(`FOCUS "${combined}" has no signal name (expected signal:window:stop:target)`)
    const focus = {
      signal,
      window: window || 'allday',
      stop: Number(stop || 1.5),
      target: Number(target || 2),
    }
    if (!Number.isFinite(focus.stop) || !Number.isFinite(focus.target)) {
      throw new Error(`FOCUS "${combined}" has a non-numeric stop or target`)
    }
    return focus
  }
  if (!process.env.FOCUS_SIGNAL) return null
  return {
    signal: process.env.FOCUS_SIGNAL,
    window: process.env.FOCUS_WINDOW || 'allday',
    stop: Number(process.env.FOCUS_STOP || 1.5),
    target: Number(process.env.FOCUS_TARGET || 2),
  }
}

function runFocus({ exploration, holdout, atrEdges, rng, focus }) {
  const variant = buildSignalCatalogue().find((v) => v.name === focus.signal)
  if (!variant) throw new Error(`FOCUS_SIGNAL "${focus.signal}" is not in the catalogue`)
  const window = WINDOWS.find((w) => w.name === focus.window)
  if (!window) throw new Error(`FOCUS_WINDOW "${focus.window}" is not a known window`)

  console.log('FOCUS_RULE:' + JSON.stringify({
    signal: focus.signal,
    window: focus.window,
    stop: focus.stop,
    target: focus.target,
    explorationSessions: exploration.length,
    holdoutSessions: holdout.length,
    note: 'one pre-registered hypothesis - threshold is a plain 0.05, no correction needed',
  }))

  const wholePool = buildRandomPool(exploration, focus.stop, focus.target, rng, atrEdges)
  const wholeTrades = tradesFor(exploration, variant.fn, window, focus.stop, focus.target, atrEdges)
  console.log('FOCUS_EXPLORATION:' + JSON.stringify({
    period: 'all',
    ...evaluate(wholeTrades, wholePool, rng),
    p: twoSidedP(evaluate(wholeTrades, wholePool, rng).z),
  }))

  const chunks = subPeriods(exploration, 4)
  let positiveQuarters = 0
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    const pool = buildRandomPool(chunk, focus.stop, focus.target, rng, atrEdges)
    const trades = tradesFor(chunk, variant.fn, window, focus.stop, focus.target, atrEdges)
    const evaluation = trades.length > 0 ? evaluate(trades, pool, rng) : { n: 0, expectancyPoints: null, z: null }
    if (evaluation.expectancyPoints > 0) positiveQuarters++
    console.log('FOCUS_STABILITY:' + JSON.stringify({
      period: `Q${i + 1}`,
      from: chunk[0].date,
      to: chunk[chunk.length - 1].date,
      ...evaluation,
    }))
  }
  console.log('FOCUS_STABILITY_SUMMARY:' + JSON.stringify({
    quarters: chunks.length,
    positiveQuarters,
    note: 'a rule carried by one quarter is a quarter, not a rule',
  }))

  const holdoutPool = buildRandomPool(holdout, focus.stop, focus.target, rng, atrEdges)
  const holdoutTrades = tradesFor(holdout, variant.fn, window, focus.stop, focus.target, atrEdges)
  const holdoutEval = holdoutTrades.length > 0 ? evaluate(holdoutTrades, holdoutPool, rng) : { n: 0 }
  console.log('FOCUS_HOLDOUT:' + JSON.stringify({
    from: holdout.length ? holdout[0].date : null,
    to: holdout.length ? holdout[holdout.length - 1].date : null,
    ...holdoutEval,
    p: twoSidedP(holdoutEval.z ?? null),
  }))
}


// ---------- main ----------

async function main() {
  const scanStart = process.env.SCAN_START_DATE || DEFAULT_START
  const scanEnd = process.env.SCAN_END_DATE || DEFAULT_END
  const holdoutStart = process.env.HOLDOUT_START_DATE || DEFAULT_HOLDOUT_START

  const days = enumerateDays(scanStart, scanEnd)
  log(`fetching ${days.length} sessions ${scanStart}..${scanEnd} (holdout from ${holdoutStart})`)

  const sessions = []
  let failures = 0
  for (const dateStr of days) {
    try {
      const offset = nyOffsetHours(dateStr)
      const start = new Date(wallClockToInstant(dateStr, '09:30:00', offset).getTime() - 24 * 3600000)
      const end = wallClockToInstant(dateStr, '16:00:00', offset)
      const raw = await fetchOhlcv1m(SYMBOL, start, end, { nearRollover: isNearRollover(dateStr) })
      const session = buildSession(dateStr, raw)
      if (session) sessions.push(session)
      else failures++
    } catch (err) {
      failures++
      log(`${dateStr} failed: ${err.message}`)
    }
    await sleep(120)
  }

  const exploration = sessions.filter((s) => s.date < holdoutStart)
  const holdout = sessions.filter((s) => s.date >= holdoutStart)
  log(`sessions built: ${sessions.length} (exploration ${exploration.length}, holdout ${holdout.length}), ${failures} unusable`)

  const catalogue = buildSignalCatalogue()
  const rng = makeRng(RNG_SEED)
  const atrEdges = buildAtrBins(exploration)
  log(`ATR bin edges: ${atrEdges.map((e) => e.toFixed(2)).join(', ')}`)

  // Signals depend only on the session, never on the stop or target, so they
  // are generated once and reused across the whole grid.
  const signalsByVariant = new Map()
  for (const variant of catalogue) {
    signalsByVariant.set(variant.name, new Map(sessions.map((s) => [s.date, variant.fn(s)])))
  }

  const focus = parseFocus()
  if (focus) {
    runFocus({ exploration, holdout, atrEdges, rng, focus })
    return
  }

  const hypotheses = catalogue.length * STOP_MULTS.length * TARGET_MULTS.length * WINDOWS.length
  const bonferroni = ALPHA / hypotheses
  console.log('SEARCH_SPACE:' + JSON.stringify({
    signalVariants: catalogue.length,
    stopMults: STOP_MULTS,
    targetMults: TARGET_MULTS,
    windows: WINDOWS.map((w) => w.name),
    hypotheses,
    alpha: ALPHA,
    bonferroniThreshold: bonferroni,
    explorationSessions: exploration.length,
    holdoutSessions: holdout.length,
  }))

  const results = []
  for (const stopMult of STOP_MULTS) {
    for (const targetMult of TARGET_MULTS) {
      const pool = buildRandomPool(exploration, stopMult, targetMult, rng, atrEdges)
      for (const variant of catalogue) {
        const signals = signalsByVariant.get(variant.name)
        for (const window of WINDOWS) {
          const trades = []
          for (const session of exploration) {
            for (const signal of signals.get(session.date) || []) {
              if (signal.index < window.startMinute || signal.index >= window.endMinute) continue
              const trade = makeTrade(session, signal, stopMult, targetMult, atrEdges)
              if (trade) trades.push(trade)
            }
          }
          if (trades.length < MIN_TRADES) continue
          const evaluation = evaluate(trades, pool, rng)
          results.push({
            signal: variant.name,
            window: window.name,
            stop: stopMult,
            target: targetMult,
            ...evaluation,
            p: twoSidedP(evaluation.z),
          })
        }
      }
      log(`scored stop ${stopMult} target ${targetMult} (${results.length} cells so far)`)
    }
  }

  results.sort((a, b) => (b.z ?? -Infinity) - (a.z ?? -Infinity))
  for (const r of results.slice(0, 15)) console.log('TOP:' + JSON.stringify(r))
  for (const r of results.slice(-5)) console.log('BOTTOM:' + JSON.stringify(r))

  const survivors = results.filter((r) => r.p !== null && r.p < bonferroni && r.expectancyPoints > 0)
  console.log('EXPLORATION_SUMMARY:' + JSON.stringify({
    cellsScored: results.length,
    bonferroniThreshold: bonferroni,
    survivors: survivors.length,
    bestZ: results.length ? results[0].z : null,
    bestExpectancy: results.length ? results[0].expectancyPoints : null,
    // How many cells would clear an UNCORRECTED 0.05 - shown next to how many
    // pure chance predicts (5% of cells), because the gap between those two
    // numbers is the entire argument for correcting in the first place.
    nominallySignificant: results.filter((r) => r.p !== null && r.p < ALPHA).length,
    expectedByChance: Math.round(results.length * ALPHA),
  }))

  // ---------- the holdout, scored once ----------
  if (survivors.length === 0) {
    console.log('HOLDOUT:' + JSON.stringify({ tested: 0, note: 'nothing survived exploration - holdout left sealed' }))
  } else {
    for (const survivor of survivors.slice(0, 5)) {
      const pool = buildRandomPool(holdout, survivor.stop, survivor.target, rng, atrEdges)
      const window = WINDOWS.find((w) => w.name === survivor.window)
      const signals = signalsByVariant.get(survivor.signal)
      const trades = []
      for (const session of holdout) {
        for (const signal of signals.get(session.date) || []) {
          if (signal.index < window.startMinute || signal.index >= window.endMinute) continue
          const trade = makeTrade(session, signal, survivor.stop, survivor.target, atrEdges)
          if (trade) trades.push(trade)
        }
      }
      const evaluation = trades.length > 0 ? evaluate(trades, pool, rng) : { n: 0 }
      console.log('HOLDOUT:' + JSON.stringify({
        signal: survivor.signal,
        window: survivor.window,
        stop: survivor.stop,
        target: survivor.target,
        explorationExpectancy: survivor.expectancyPoints,
        explorationZ: survivor.z,
        ...evaluation,
      }))
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
