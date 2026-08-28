#!/usr/bin/env node

// Hourly retry for trades whose MFE/MAE/drawdown fetch was blocked by this
// account's Databento embargo at save time (market_data_status = 'pending')
// - see the .github/workflows/retry-trade-excursions.yml this runs under,
// lib/tradeExcursions.js, and schema.sql's comment above `mfe_points` for
// the full picture.
//
// Standalone rather than importing lib/tradeExcursions.js or lib/
// databento.js: this repo has no "type": "module", so ESM lib files aren't
// reliably loadable from a plain `node scripts/...` invocation the way
// Next.js's own bundler handles it - same reason scripts/fetch-daily-
// market-stats.js is already a fully separate script. The pieces
// duplicated below (the Databento HTTP call, the embargo-error check, the
// excursion window/math, and now the belief-tracking Welford math for
// MFE/MAE/drawdown - see WELFORD MATH below) are kept intentionally
// minimal and mirror those files exactly, so there's little for the
// copies to drift on.
//
// One exception: this script DOES dynamically import lib/edgeEngine.js
// and lib/edgeBeliefs.js (see loadBeliefHelpers below) for the
// slice-membership list (which belief slices a trade belongs to) rather
// than keeping a third copy of that logic - unlike the Welford math,
// which changes rarely, the slice list grows every time a new dimension
// or composite is added, making a duplicate copy of THAT specifically
// riskier to keep in sync than the small, stable math is. This only
// works because those two files (and everything they import) are kept
// deliberately framework-free - see the CONSTRAINT comment atop
// lib/edgeEngine.js. If that import ever starts failing, this script
// throws rather than silently skipping belief updates - see main().
//
// Usage: node scripts/retry-trade-excursions.js
// Env: DATABENTO_API_KEY, SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL

const { createClient } = require('@supabase/supabase-js')
// JSON, not ESM - require() loads these directly regardless of the
// "type": "module" gap that keeps this script from importing lib/*.js
// files, so the actual roll-date data (not just the logic around it)
// stays a single source of truth with lib/contractRollover.js.
const ROLLOVER_DATES = require('../lib/contractRollover.json')
const CME_HOLIDAYS = require('../lib/cmeHolidays.json')

const DATASET = 'GLBX.MDP3'
const NQ_CONTINUOUS_SYMBOL = 'NQ.c.0'
const PRICE_SCALE = 1e9
const EMBARGO_HOURS = 8
// See lib/databento.js's ROLL_PROXIMITY_DAYS for the full explanation.
const ROLL_PROXIMITY_DAYS = 10

function log(...args) {
  console.log(new Date().toISOString(), ...args)
}

// ===== WELFORD MATH =====
// Duplicate of lib/edgeBeliefs.js's PSEUDO_COUNT/welfordAdd/welfordRemove/
// excursionFor/excursionSeedFromParent/buildExcursionRow - see the
// CONSTRAINT comment atop lib/edgeEngine.js and this script's own header
// comment for why this specific piece is duplicated rather than imported
// (unlike slicesForTrade/fetchBeliefsByKeys below, which ARE imported).
// If you change any of the functions in this section, make the exact same
// change to their counterparts in lib/edgeBeliefs.js, or this script will
// silently compute different MFE/MAE/drawdown numbers than the rest of
// the app depending on which of the two paths backfilled a given trade.
// scripts/check-excursion-math-parity.js runs both copies against the
// same inputs on every CI run specifically to catch that kind of drift.
const PSEUDO_COUNT = 10

function welfordAdd(mean, m2, count, value) {
  const newCount = count + 1
  const delta = value - mean
  const newMean = mean + delta / newCount
  const delta2 = value - newMean
  const newM2 = m2 + delta * delta2
  return { mean: newMean, m2: newM2, count: newCount }
}

function welfordRemove(mean, m2, count, value) {
  const newCount = count - 1
  if (newCount <= 0) return { mean: 0, m2: 0, count: 0 }
  const newMean = (mean * count - value) / newCount
  const delta = value - newMean
  const delta2 = value - mean
  const newM2 = m2 - delta * delta2
  return { mean: newMean, m2: newM2, count: newCount }
}

function excursionFor(trade) {
  if (trade.mfe_points == null || trade.mae_points == null || !trade.stop_distance) return null
  return {
    mfeR: trade.mfe_points / trade.stop_distance,
    maeR: trade.mae_points / trade.stop_distance,
    drawdownSeconds: trade.drawdown_seconds ?? 0,
  }
}

function excursionSeedFromParent(parent) {
  return {
    mfe_r_mean: parent?.mfe_r_mean ?? 0,
    mfe_r_m2: 0,
    mae_r_mean: parent?.mae_r_mean ?? 0,
    mae_r_m2: 0,
    drawdown_seconds_mean: parent?.drawdown_seconds_mean ?? 0,
    drawdown_seconds_m2: 0,
  }
}

function buildExcursionRow(existing, parent, trade, sign, nowIso) {
  if (!existing) return null
  const excursion = excursionFor(trade)
  if (!excursion) return null

  const priorCount = existing.excursion_n ?? 0
  if (sign < 0 && priorCount === 0) return null

  const source = priorCount === 0
    ? excursionSeedFromParent(parent)
    : {
        mfe_r_mean: existing.mfe_r_mean ?? 0,
        mfe_r_m2: existing.mfe_r_m2 ?? 0,
        mae_r_mean: existing.mae_r_mean ?? 0,
        mae_r_m2: existing.mae_r_m2 ?? 0,
        drawdown_seconds_mean: existing.drawdown_seconds_mean ?? 0,
        drawdown_seconds_m2: existing.drawdown_seconds_m2 ?? 0,
      }

  const weight = priorCount + PSEUDO_COUNT
  const op = sign > 0 ? welfordAdd : welfordRemove
  const mfeUpdate = op(source.mfe_r_mean, source.mfe_r_m2, weight, excursion.mfeR)
  const maeUpdate = op(source.mae_r_mean, source.mae_r_m2, weight, excursion.maeR)
  const drawdownUpdate = op(source.drawdown_seconds_mean, source.drawdown_seconds_m2, weight, excursion.drawdownSeconds)

  return {
    user_id: existing.user_id,
    slice_key: existing.slice_key,
    mfe_r_mean: mfeUpdate.mean,
    mfe_r_m2: mfeUpdate.m2,
    mae_r_mean: maeUpdate.mean,
    mae_r_m2: maeUpdate.m2,
    drawdown_seconds_mean: drawdownUpdate.mean,
    drawdown_seconds_m2: drawdownUpdate.m2,
    excursion_n: Math.max(0, priorCount + sign),
    updated_at: nowIso,
  }
}

// Orchestration only (fetch beliefs, build rows, upsert) - NOT duplicated,
// since it contains no math of its own, just plumbing around
// slicesForTrade/fetchBeliefsByKeys (imported for real, see
// loadBeliefHelpers below) and buildExcursionRow (duplicated above).
async function applyOrReverseExcursion(admin, trade, sign, { slicesForTrade, fetchBeliefsByKeys }) {
  if (!trade.user_id) return
  const slices = slicesForTrade(trade)
  if (slices.length === 0) return

  const neededKeys = new Set()
  for (const slice of slices) {
    neededKeys.add(slice.sliceKey)
    if (slice.parentSliceKey) neededKeys.add(slice.parentSliceKey)
  }
  const beliefs = await fetchBeliefsByKeys(admin, trade.user_id, [...neededKeys])

  const nowIso = new Date().toISOString()
  const rows = slices
    .map((slice) => buildExcursionRow(
      beliefs.get(slice.sliceKey),
      slice.parentSliceKey ? beliefs.get(slice.parentSliceKey) : null,
      trade,
      sign,
      nowIso,
    ))
    .filter((row) => row !== null)

  if (rows.length === 0) return
  const { error } = await admin.from('edge_beliefs').upsert(rows, { onConflict: 'user_id,slice_key' })
  if (error) throw error
}
// ===== END WELFORD MATH =====

// Dynamically imports the real slice-membership logic from lib/edgeBeliefs.js
// (which the app also uses) rather than keeping a third copy of it - see
// this script's header comment for why that's the right call specifically
// for the slice list, unlike the Welford math above. Called once, at the
// very top of main(), so a broken import fails the whole run loudly and
// immediately rather than surfacing as a confusing per-trade failure deep
// in the retry loop.
async function loadBeliefHelpers() {
  const mod = await import('../lib/edgeBeliefs.js')
  return { slicesForTrade: mod.slicesForTrade, fetchBeliefsByKeys: mod.fetchBeliefsByKeys }
}

function authHeader() {
  const apiKey = process.env.DATABENTO_API_KEY
  if (!apiKey) throw new Error('DATABENTO_API_KEY is not set')
  return 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64')
}

function normalizeRecord(record) {
  return {
    high: record.high / PRICE_SCALE,
    low: record.low / PRICE_SCALE,
    tsEvent: record.ts_event ?? record.hd?.ts_event ?? null,
    volume: Number(record.volume),
    instrumentId: record.hd?.instrument_id ?? null,
  }
}

// One trade print - schema `trades`, tick-level. See lib/databento.js's
// own copy of this function for the full explanation.
function normalizeTradeRecord(record) {
  return {
    tsEvent: record.ts_event ?? record.hd?.ts_event ?? null,
    price: record.price / PRICE_SCALE,
    size: Number(record.size),
  }
}

function parseRecords(text, normalize) {
  const trimmed = text.trim()
  if (!trimmed) return []
  try {
    const whole = JSON.parse(trimmed)
    if (Array.isArray(whole)) return whole.map(normalize)
    if (Array.isArray(whole?.records)) return whole.records.map(normalize)
  } catch {
    // Not a single JSON document - fall through to line-delimited parsing.
  }
  return trimmed.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => normalize(JSON.parse(l)))
}

// Session-level aggregates only (resolveFrontMonthByVolume) - the
// excursion path below uses fetchTrades instead.
async function fetchOhlcv1m({ symbol, start, end, stypeIn = 'continuous' }) {
  const url = new URL('/v0/timeseries.get_range', 'https://hist.databento.com')
  url.searchParams.set('dataset', DATASET)
  url.searchParams.set('schema', 'ohlcv-1m')
  url.searchParams.set('symbols', symbol)
  url.searchParams.set('stype_in', stypeIn)
  url.searchParams.set('start', start)
  url.searchParams.set('end', end)
  url.searchParams.set('encoding', 'json')

  const res = await fetch(url, { headers: { Authorization: authHeader() } })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Databento get_range failed: ${res.status} ${res.statusText} ${body}`.trim())
  }
  return parseRecords(await res.text(), normalizeRecord)
}

// MFE/MAE/drawdown path - real trade prints, not ohlcv-1m bars. See
// lib/databento.js's fetchTrades for the full explanation.
async function fetchTrades({ symbol, start, end, stypeIn = 'continuous' }) {
  const url = new URL('/v0/timeseries.get_range', 'https://hist.databento.com')
  url.searchParams.set('dataset', DATASET)
  url.searchParams.set('schema', 'trades')
  url.searchParams.set('symbols', symbol)
  url.searchParams.set('stype_in', stypeIn)
  url.searchParams.set('start', start)
  url.searchParams.set('end', end)
  url.searchParams.set('encoding', 'json')

  const res = await fetch(url, { headers: { Authorization: authHeader() } })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Databento get_range failed: ${res.status} ${res.statusText} ${body}`.trim())
  }
  return parseRecords(await res.text(), normalizeTradeRecord)
}

function isEmbargoError(err) {
  const msg = err?.message || ''
  return msg.includes('dataset_unavailable_range') || msg.includes('data_end_after_available_end')
}

// See lib/contractRollover.js's own copies for the full explanation - this
// is the same logic, standalone.
function rolloverDateStr(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
function isWeekend(date) {
  const day = date.getDay()
  return day === 0 || day === 6
}
function adjustForHolidays(ds) {
  const d = new Date(ds + 'T00:00:00')
  while (isWeekend(d) || CME_HOLIDAYS[rolloverDateStr(d)]?.type === 'closed') {
    d.setDate(d.getDate() - 1)
  }
  return rolloverDateStr(d)
}
function findNextRolloverDate(dataSymbol, fromDate) {
  const dates = ROLLOVER_DATES[dataSymbol]
  if (!dates) return null
  const todayStr = rolloverDateStr(fromDate)
  for (const raw of dates) {
    const adjusted = adjustForHolidays(raw)
    if (adjusted >= todayStr) return adjusted
  }
  return null
}
function daysToNearestRollover(dataSymbol, fromDate) {
  const dates = ROLLOVER_DATES[dataSymbol]
  if (!dates) return null
  const fromStr = rolloverDateStr(fromDate)
  const from = new Date(fromStr + 'T00:00:00')
  const next = findNextRolloverDate(dataSymbol, from)
  const daysToNext = next ? Math.round((new Date(next + 'T00:00:00') - from) / 86400000) : null
  let previous = null
  for (const raw of dates) {
    const adjusted = adjustForHolidays(raw)
    if (adjusted < fromStr) previous = adjusted
    else break
  }
  const daysSincePrevious = previous ? Math.round((from - new Date(previous + 'T00:00:00')) / 86400000) : null
  const candidates = [daysToNext, daysSincePrevious].filter((d) => d !== null)
  return candidates.length ? Math.min(...candidates) : null
}
function isNearRollover(dataSymbol, tradeDate) {
  const distance = daysToNearestRollover(dataSymbol, new Date(tradeDate + 'T00:00:00'))
  return distance !== null && distance <= ROLL_PROXIMITY_DAYS
}

// See lib/databento.js's sessionBoundsFor/resolveFrontMonthByVolume for
// the full explanation - this is the same logic, standalone. Uses Intl
// directly rather than lib/marketHours.js's easternParts (can't import
// that either), same minimal-duplication approach as the rest of this file.
function easternParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date)
  const map = {}
  for (const p of parts) map[p.type] = p.value
  const hour = Number(map.hour) % 24
  return { minutesOfDay: hour * 60 + Number(map.minute), dateStr: `${map.year}-${map.month}-${map.day}` }
}
function sixPmEtUtc(dateUtcMidnight) {
  // Seeded ~22h in, not at midnight - see lib/databento.js's own copy of
  // this comment for why (ET trails UTC, so a midnight-UTC seed lands in
  // the previous ET calendar day and the loop below would converge on the
  // wrong day's 6pm).
  let guess = new Date(dateUtcMidnight.getTime() + 22 * 3600000)
  for (let i = 0; i < 3; i++) {
    const { minutesOfDay } = easternParts(guess)
    const diffMinutes = 18 * 60 - minutesOfDay
    guess = new Date(guess.getTime() + diffMinutes * 60000)
  }
  return guess
}
function sessionBoundsFor(instant) {
  const { minutesOfDay, dateStr } = easternParts(instant)
  const [y, m, d] = dateStr.split('-').map(Number)
  let sessionDateUtc = new Date(Date.UTC(y, m - 1, d))
  if (minutesOfDay >= 18 * 60) sessionDateUtc = new Date(sessionDateUtc.getTime() + 24 * 3600000)
  const end = sixPmEtUtc(sessionDateUtc)
  const start = sixPmEtUtc(new Date(sessionDateUtc.getTime() - 24 * 3600000))
  return { start, end }
}
async function resolveFrontMonthByVolume({ sessionStart, sessionEnd }) {
  let records
  try {
    const bars = await fetchOhlcv1m({
      symbol: 'NQ.FUT',
      stypeIn: 'parent',
      start: sessionStart.toISOString(),
      end: sessionEnd.toISOString(),
    })
    records = bars
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
    if (vol > bestVolume) { bestVolume = vol; bestId = id }
  }
  return bestId
}

// trade_date/trade_time is a wall-clock reading, not a real instant, until
// combined with the account's own saved UTC offset - same conversion
// lib/tradeSessions.js's wallClockToInstant (and lib/tradeExcursions.js's
// copy of it) do.
function wallClockToInstant(dateStr, timeStr, offsetHours) {
  if (!dateStr || !timeStr) return null
  const [y, mo, d] = dateStr.split('-').map(Number)
  const [hh, mm, ss] = timeStr.split(':').map(Number)
  return new Date(Date.UTC(y, mo - 1, d, hh, mm, ss || 0) - offsetHours * 3600000)
}

function addOneDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + 1)
  return dt.toISOString().slice(0, 10)
}

// Entry-to-final-exit window - see lib/tradeExcursions.js's excursionWindow
// for the full explanation (this is the same logic, standalone). Returns
// legs (each exit's own raw { price, instant }) alongside entryInstant/
// exitInstant, same shape as that file's own return value.
function excursionWindow(trade, offsetHours) {
  if (!trade.trade_date || !trade.trade_time || Number.isNaN(offsetHours)) return null
  const entryInstant = wallClockToInstant(trade.trade_date, trade.trade_time, offsetHours)
  if (!entryInstant) return null

  const exitLegs = [
    { price: trade.exit_price, time: trade.exit_time },
    ...(trade.additional_exits || []).map((e) => ({ price: e.exit_price, time: e.exit_time })),
  ].filter((leg) => leg.time)
  if (exitLegs.length === 0) return null

  let currentDate = trade.trade_date
  let currentInstant = entryInstant
  const legs = []
  for (const leg of exitLegs) {
    let instant = wallClockToInstant(currentDate, leg.time, offsetHours)
    if (instant.getTime() < currentInstant.getTime()) {
      currentDate = addOneDay(currentDate)
      instant = wallClockToInstant(currentDate, leg.time, offsetHours)
    }
    currentInstant = instant
    legs.push({ price: leg.price, instant })
  }
  return { entryInstant, legs, exitInstant: legs[legs.length - 1].instant }
}

// See lib/tradeExcursions.js's FILL_SEARCH_PAD_MINUTES/findFillTick/
// deriveFillTicks/sliceTicksForWindow for the full explanation - this is
// the same logic, standalone (same reason excursionWindow above is).
const FILL_SEARCH_PAD_MINUTES = 2
const FILL_PRICE_EPSILON = 0.0001

function tickTouchesPrice(tick, price) {
  return Math.abs(tick.price - price) <= FILL_PRICE_EPSILON
}

function parseTickInstant(tsEvent) {
  if (tsEvent === null || tsEvent === undefined) return null
  if (typeof tsEvent === 'string' && /^\d+$/.test(tsEvent)) {
    return new Date(Number(BigInt(tsEvent) / 1000000n))
  }
  if (typeof tsEvent === 'number') {
    return new Date(tsEvent / 1e6)
  }
  const parsed = new Date(tsEvent)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

// See lib/tradeExcursions.js's own copy of this function for the full
// explanation of why this picks the *earliest* qualifying match within
// roughInstant ± FILL_SEARCH_PAD_MINUTES (further floored at afterInstant
// when given) rather than the closest-in-time one, and why the ± window
// bound matters specifically for a leg whose price coincides with an
// earlier anchor's (e.g. a breakeven exit) - this is the same logic,
// standalone.
function findFillTick({ ticks, roughInstant, price, afterInstant }) {
  const padMs = FILL_SEARCH_PAD_MINUTES * 60000
  const windowStartMs = Math.max(roughInstant.getTime() - padMs, afterInstant ? afterInstant.getTime() : -Infinity)
  const windowEndMs = roughInstant.getTime() + padMs

  let best = null
  for (const tick of ticks) {
    if (!tickTouchesPrice(tick, price)) continue
    const instant = parseTickInstant(tick.tsEvent)
    if (!instant) continue
    const ms = instant.getTime()
    if (ms < windowStartMs || ms > windowEndMs) continue
    if (!best || ms < best.getTime()) best = instant
  }
  if (best) return { instant: best, matched: true }
  return { instant: roughInstant, matched: false }
}

function deriveFillTicks({ rawWindow, entryPrice, ticks }) {
  const entryFill = findFillTick({ ticks, roughInstant: rawWindow.entryInstant, price: entryPrice })
  let usedFallback = !entryFill.matched
  let lastInstant = entryFill.instant

  for (const leg of rawWindow.legs) {
    const legFill = findFillTick({ ticks, roughInstant: leg.instant, price: leg.price, afterInstant: lastInstant })
    if (!legFill.matched) usedFallback = true
    lastInstant = legFill.instant
  }

  return { entryInstant: entryFill.instant, exitInstant: lastInstant, usedFallback }
}

// See lib/tradeExcursions.js's floorToMinute/findVerifiedMinuteFill/
// deriveVerifiedTimes/instantToWallClockTime for the full explanation -
// this is the same logic, standalone.
function floorToMinute(instant) {
  return new Date(Math.floor(instant.getTime() / 60000) * 60000)
}

function findVerifiedMinuteFill({ ticks, roughInstant, price, afterInstant }) {
  const minuteStartMs = floorToMinute(roughInstant).getTime()
  const minuteEndMs = minuteStartMs + 59999
  const windowStartMs = Math.max(minuteStartMs, afterInstant ? afterInstant.getTime() : -Infinity)

  let best = null
  for (const tick of ticks) {
    if (!tickTouchesPrice(tick, price)) continue
    const instant = parseTickInstant(tick.tsEvent)
    if (!instant) continue
    const ms = instant.getTime()
    if (ms < windowStartMs || ms > minuteEndMs) continue
    if (!best || ms < best.getTime()) best = instant
  }
  if (best) return { instant: best, matched: true }
  return { instant: new Date(minuteStartMs), matched: false }
}

function deriveVerifiedTimes({ rawWindow, entryPrice, ticks }) {
  const entryFill = findVerifiedMinuteFill({ ticks, roughInstant: rawWindow.entryInstant, price: entryPrice })
  let anyUnverified = !entryFill.matched
  let lastInstant = entryFill.instant

  const legs = []
  for (const leg of rawWindow.legs) {
    const legFill = findVerifiedMinuteFill({ ticks, roughInstant: leg.instant, price: leg.price, afterInstant: lastInstant })
    if (!legFill.matched) anyUnverified = true
    legs.push(legFill)
    lastInstant = legFill.instant
  }

  return { entry: entryFill, legs, anyUnverified }
}

function instantToWallClockTime(instant, offsetHours) {
  const local = new Date(instant.getTime() + offsetHours * 3600000)
  const hh = String(local.getUTCHours()).padStart(2, '0')
  const mm = String(local.getUTCMinutes()).padStart(2, '0')
  const ss = String(local.getUTCSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

function sliceTicksForWindow(ticks, entryInstant, exitInstant) {
  return ticks
    .map((tick) => ({ ...tick, instant: parseTickInstant(tick.tsEvent) }))
    .filter((tick) => tick.instant && tick.instant.getTime() >= entryInstant.getTime() && tick.instant.getTime() <= exitInstant.getTime())
    .sort((a, b) => a.instant.getTime() - b.instant.getTime())
}

// See lib/tradeExcursions.js's own copy of this function for the full
// explanation - this is the same logic, standalone.
function computeExcursion({ ticks, entry, direction }) {
  const prices = ticks.map((t) => t.price)
  const maxPrice = Math.max(...prices)
  const minPrice = Math.min(...prices)

  const mfePoints = direction === 'long' ? maxPrice - entry : entry - minPrice
  const maePoints = direction === 'long' ? entry - minPrice : maxPrice - entry

  let drawdownMs = 0
  for (let i = 0; i < ticks.length - 1; i++) {
    const underwater = direction === 'long' ? ticks[i].price < entry : ticks[i].price > entry
    if (underwater) drawdownMs += ticks[i + 1].instant.getTime() - ticks[i].instant.getTime()
  }
  return { mfePoints, maePoints, drawdownSeconds: Math.round(drawdownMs / 1000) }
}

async function getUserTimezone(supabaseUrl, serviceKey, userId, cache) {
  if (cache.has(userId)) return cache.get(userId)
  const res = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  })
  if (!res.ok) {
    cache.set(userId, null)
    return null
  }
  const user = await res.json()
  const offset = parseFloat(user?.user_metadata?.timezone)
  const result = Number.isNaN(offset) ? null : offset
  cache.set(userId, result)
  return result
}

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set')
  const admin = createClient(supabaseUrl, serviceKey)

  // Fails the whole run immediately and loudly (non-zero exit, surfaces as
  // a failed GitHub Actions run) if lib/edgeBeliefs.js/lib/edgeEngine.js
  // ever stop being importable from plain Node - deliberately NOT folded
  // into the per-trade try/catch below, which is for ordinary,
  // expected-to-happen-sometimes Databento hiccups. A broken import means
  // this run can't determine which belief slices ANY trade belongs to, a
  // categorically different and more serious problem that shouldn't be
  // silently absorbed into the routine "left pending for next hour" path.
  let beliefHelpers
  try {
    beliefHelpers = await loadBeliefHelpers()
  } catch (err) {
    console.error('CRITICAL: could not load lib/edgeBeliefs.js/lib/edgeEngine.js - excursion data will NOT be tracked in edge_beliefs until this is fixed.', err)
    throw err
  }

  const { data: pending, error } = await admin.from('trades').select('*').eq('market_data_status', 'pending')
  if (error) throw new Error(`Failed to load pending trades: ${error.message}`)

  log(`${pending.length} trade(s) pending.`)
  if (pending.length === 0) return

  const instrumentIds = [...new Set(pending.map((t) => t.instrument_id))]
  const { data: instruments } = await admin.from('instruments').select('id, data_symbol').in('id', instrumentIds)
  const dataSymbolById = new Map((instruments || []).map((i) => [i.id, i.data_symbol]))

  const timezoneCache = new Map()
  let readyCount = 0
  let stillPending = 0
  let completed = 0
  let unavailable = 0

  for (const trade of pending) {
    // Only NQ-family instruments have a Databento symbol resolved anywhere
    // in this app - a 'pending' trade on anything else should never have
    // happened, but this is a genuine, permanent miss if it did.
    if (dataSymbolById.get(trade.instrument_id) !== 'NQ') {
      await admin.from('trades').update({ market_data_status: 'unavailable' }).eq('id', trade.id)
      unavailable += 1
      continue
    }

    const offsetHours = await getUserTimezone(supabaseUrl, serviceKey, trade.user_id, timezoneCache)
    const rawWindow = offsetHours === null ? null : excursionWindow(trade, offsetHours)
    if (!rawWindow) {
      await admin.from('trades').update({ market_data_status: 'unavailable' }).eq('id', trade.id)
      unavailable += 1
      continue
    }

    const embargoClears = rawWindow.exitInstant.getTime() + EMBARGO_HOURS * 3600000
    if (Date.now() < embargoClears) {
      stillPending += 1
      continue
    }
    readyCount += 1

    try {
      const padMs = FILL_SEARCH_PAD_MINUTES * 60000

      // Within ROLL_PROXIMITY_DAYS of a quarterly roll, NQ_CONTINUOUS_SYMBOL's
      // own resolution was confirmed (live, PR #122) to disagree with which
      // contract actually traded that session - resolve by volume instead.
      let symbol = NQ_CONTINUOUS_SYMBOL
      let stypeIn = 'continuous'
      if (isNearRollover(dataSymbolById.get(trade.instrument_id), trade.trade_date)) {
        const { start: sessionStart, end: sessionEnd } = sessionBoundsFor(rawWindow.entryInstant)
        const frontMonthId = await resolveFrontMonthByVolume({ sessionStart, sessionEnd })
        if (frontMonthId !== null) {
          symbol = String(frontMonthId)
          stypeIn = 'instrument_id'
        }
      }

      const ticks = await fetchTrades({
        symbol,
        stypeIn,
        start: new Date(rawWindow.entryInstant.getTime() - padMs).toISOString(),
        end: new Date(rawWindow.exitInstant.getTime() + padMs).toISOString(),
      })
      // See app/api/backfill-trade-excursion/route.js's own copy of this
      // comment - a real NQ session window this narrow essentially never
      // has zero real trade prints, so this is treated as transient
      // (leave 'pending', already is) rather than a permanent miss. No
      // write needed - the trade is already 'pending'.
      if (ticks.length === 0) {
        stillPending += 1
        continue
      }
      const { entryInstant, exitInstant, usedFallback } = deriveFillTicks({ rawWindow, entryPrice: trade.entry, ticks })
      const windowTicks = sliceTicksForWindow(ticks, entryInstant, exitInstant)
      if (windowTicks.length === 0) {
        stillPending += 1
        continue
      }
      const { mfePoints, maePoints, drawdownSeconds } = computeExcursion({
        ticks: windowTicks,
        entry: trade.entry,
        direction: trade.direction,
      })

      // See app/api/backfill-trade-excursion/route.js for why this reuses
      // the same fetched `ticks` rather than a second Databento call.
      const verifiedTimes = deriveVerifiedTimes({ rawWindow, entryPrice: trade.entry, ticks })
      const correctedTradeTime = verifiedTimes.entry.matched
        ? instantToWallClockTime(verifiedTimes.entry.instant, offsetHours)
        : trade.trade_time
      const correctedExitTime = verifiedTimes.legs[0]?.matched
        ? instantToWallClockTime(verifiedTimes.legs[0].instant, offsetHours)
        : trade.exit_time
      const correctedAdditionalExits = (trade.additional_exits || []).map((exit, i) => {
        const legFill = verifiedTimes.legs[i + 1]
        return legFill?.matched ? { ...exit, exit_time: instantToWallClockTime(legFill.instant, offsetHours) } : exit
      })

      // A trade can already have excursion data here if this is a
      // re-backfill after an edit changed entry/exit (same reasoning as
      // app/api/backfill-trade-excursion/route.js's own copy of this
      // step) - unapply the now-stale old contribution before overwriting
      // it. Best-effort, same as every other edge_beliefs call site.
      try {
        if (trade.mfe_points != null) {
          await applyOrReverseExcursion(admin, trade, -1, beliefHelpers)
        }
      } catch (beliefError) {
        log(`reverseExcursion failed for trade ${trade.id}:`, beliefError.message)
      }

      await admin.from('trades').update({
        mfe_points: mfePoints,
        mae_points: maePoints,
        drawdown_seconds: drawdownSeconds,
        market_data_status: 'complete',
        excursion_fallback: usedFallback,
        trade_time: correctedTradeTime,
        exit_time: correctedExitTime,
        additional_exits: correctedAdditionalExits,
        trade_time_unverified: verifiedTimes.anyUnverified,
      }).eq('id', trade.id)

      try {
        await applyOrReverseExcursion(
          admin,
          { ...trade, mfe_points: mfePoints, mae_points: maePoints, drawdown_seconds: drawdownSeconds },
          1,
          beliefHelpers,
        )
      } catch (beliefError) {
        log(`applyExcursion failed for trade ${trade.id}:`, beliefError.message)
      }

      completed += 1
    } catch (err) {
      if (isEmbargoError(err)) {
        // Still blocked despite clearing our own 8h estimate - leave it
        // pending rather than guessing further; next hour will retry.
        stillPending += 1
        log(`Trade ${trade.id} still embargoed past expected clear time: ${err.message}`)
      } else {
        // A fetch-level failure here (network hiccup, transient 5xx, rate
        // limit) isn't reliably distinguishable from a genuinely permanent
        // one without deeper Databento-specific error taxonomy than
        // isEmbargoError covers - leave it pending for next hour's retry
        // rather than permanently discarding data that may well be
        // recoverable (confirmed happened to a real trade - see NOTES.md).
        // The deterministic misses above (unsupported instrument, no
        // timezone/window, zero trade prints, zero window prints) are
        // genuinely permanent and still go straight to 'unavailable'.
        stillPending += 1
        log(`Trade ${trade.id} failed non-embargo, left pending for retry: ${err.message}`)
      }
    }
  }

  log(`Ready to retry: ${readyCount}. Completed: ${completed}. Still pending (embargo not cleared yet): ${stillPending}. Marked unavailable: ${unavailable}.`)
}

// Guarded so scripts/check-excursion-math-parity.js can require() this
// file for its duplicated buildExcursionRow/PSEUDO_COUNT (see the WELFORD
// MATH section above) without triggering an actual retry run against real
// Databento/Supabase credentials.
if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}

module.exports = { buildExcursionRow, PSEUDO_COUNT }
