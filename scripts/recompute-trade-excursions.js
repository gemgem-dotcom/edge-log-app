#!/usr/bin/env node

// One-time, manually-run recompute of MFE/MAE/drawdown for every trade
// already marked market_data_status = 'complete' - not scheduled, not
// part of any workflow. Run repeatedly, once per correction to the
// underlying formula (see lib/tradeExcursions.js's computeExcursion for
// the current one): first after the fill-instant-derivation fix, again
// after a since-superseded stop/target-capping change, and now again after
// switching from ohlcv-1m bars to real trade prints (schema `trades`) -
// real prices have no coarse-minute ambiguity to correct for in the first
// place, and don't depend on trusting `stop`/`target` values a trader
// could edit at any time. Each time, every 'complete' trade computed under
// the old logic has unverified values under it, whether or not the
// mismatch happened to be visible, not just the ones that looked obviously
// wrong - so this always recomputes everything rather than trying to guess
// which trades are affected.
//
// Also brought current with the roll-aware front-month resolution
// (isNearRollover/sessionBoundsFor/resolveFrontMonthByVolume below) that
// scripts/retry-trade-excursions.js already had and this file was missing
// - this file predates that fix, and re-running it without picking that up
// would have silently regressed any near-roll trade back to the
// continuous-symbol mismatch that fix corrected.
//
// Uses the live Databento API rather than a downloaded DBN file (unlike
// scripts/backfill_trade_excursions_from_dbn.py) so it isn't limited to
// that one file's fixed historical date range - Databento's historical
// API retains full history for any trade date, the only real availability
// constraint is the ~8h access embargo on very recent data (see
// EMBARGO_HOURS below), which no 'complete' trade should still be within.
// This covers every 'complete' trade regardless of whether the live
// route, the retry job, or the DBN backfill originally computed it - none
// of that matters once this recomputes fresh from the corrected logic.
//
// Standalone rather than importing lib/tradeExcursions.js or lib/
// databento.js - same reason scripts/retry-trade-excursions.js already
// is (this repo has no "type": "module"). The pieces duplicated below are
// kept intentionally minimal and mirror those files exactly, same as
// that script's own copies.
//
// Usage: node scripts/recompute-trade-excursions.js
// Env: DATABENTO_API_KEY, SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL

const { createClient } = require('@supabase/supabase-js')
const ROLLOVER_DATES = require('../lib/contractRollover.json')
const CME_HOLIDAYS = require('../lib/cmeHolidays.json')

const DATASET = 'GLBX.MDP3'
const NQ_CONTINUOUS_SYMBOL = 'NQ.c.0'
const PRICE_SCALE = 1e9
const EMBARGO_HOURS = 8
const FILL_SEARCH_PAD_MINUTES = 2
const FILL_PRICE_EPSILON = 0.0001
// See lib/databento.js's ROLL_PROXIMITY_DAYS for the full explanation.
const ROLL_PROXIMITY_DAYS = 10
// A recomputed value within this of the old one counts as "unchanged" -
// covers float round-trip noise from the PRICE_SCALE division, not a
// real difference in what the fix found.
const CHANGE_EPSILON = 0.005

function log(...args) {
  console.log(new Date().toISOString(), ...args)
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

// See lib/contractRollover.js's/scripts/retry-trade-excursions.js's own
// copies for the full explanation - this is the same logic, standalone.
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
    records = await fetchOhlcv1m({ symbol: 'NQ.FUT', stypeIn: 'parent', start: sessionStart.toISOString(), end: sessionEnd.toISOString() })
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
// the same logic, standalone.
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

function findFillTick({ ticks, roughInstant, price }) {
  let best = null
  let bestDiffMs = Infinity
  for (const tick of ticks) {
    if (!tickTouchesPrice(tick, price)) continue
    const instant = parseTickInstant(tick.tsEvent)
    if (!instant) continue
    const diffMs = Math.abs(instant.getTime() - roughInstant.getTime())
    if (diffMs < bestDiffMs) {
      bestDiffMs = diffMs
      best = instant
    }
  }
  if (best) return { instant: best, matched: true }
  return { instant: roughInstant, matched: false }
}

function deriveFillTicks({ rawWindow, entryPrice, ticks }) {
  const entryFill = findFillTick({ ticks, roughInstant: rawWindow.entryInstant, price: entryPrice })
  let usedFallback = !entryFill.matched
  let lastInstant = entryFill.instant

  for (const leg of rawWindow.legs) {
    const legFill = findFillTick({ ticks, roughInstant: leg.instant, price: leg.price })
    if (!legFill.matched) usedFallback = true
    lastInstant = legFill.instant
  }

  return { entryInstant: entryFill.instant, exitInstant: lastInstant, usedFallback }
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

function valueChanged(oldVal, newVal) {
  if (oldVal === null || oldVal === undefined) return newVal !== null && newVal !== undefined
  if (newVal === null || newVal === undefined) return true
  return Math.abs(Number(oldVal) - Number(newVal)) > CHANGE_EPSILON
}

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set')
  const admin = createClient(supabaseUrl, serviceKey)

  const { data: complete, error } = await admin.from('trades').select('*').eq('market_data_status', 'complete')
  if (error) throw new Error(`Failed to load complete trades: ${error.message}`)

  log(`${complete.length} trade(s) currently marked complete.`)
  if (complete.length === 0) return

  const instrumentIds = [...new Set(complete.map((t) => t.instrument_id))]
  const { data: instruments } = await admin.from('instruments').select('id, data_symbol').in('id', instrumentIds)
  const dataSymbolById = new Map((instruments || []).map((i) => [i.id, i.data_symbol]))

  const timezoneCache = new Map()
  // Flagged for manual human review (see NOTES.md's "Known excursion data
  // issues" section) - both explicitly documented to keep whatever values
  // they already have until a person looks at them directly, not whatever
  // an automated recompute would produce.
  const MANUAL_REVIEW_TRADE_IDS = new Set([
    '7e8616fb-334b-4465-8a2f-e572b634df5a',
    '137c4594-c6d0-40f1-904f-acb9e71d9ef6',
  ])

  let recomputed = 0
  let changed = 0
  let skippedNotNq = 0
  let skippedNoWindow = 0
  let skippedStillEmbargoed = 0
  let skippedNoTicks = 0
  let skippedError = 0
  let skippedManualReview = 0

  for (const trade of complete) {
    if (MANUAL_REVIEW_TRADE_IDS.has(trade.id)) {
      skippedManualReview += 1
      continue
    }
    if (dataSymbolById.get(trade.instrument_id) !== 'NQ') {
      skippedNotNq += 1
      continue
    }

    const offsetHours = await getUserTimezone(supabaseUrl, serviceKey, trade.user_id, timezoneCache)
    const rawWindow = offsetHours === null ? null : excursionWindow(trade, offsetHours)
    if (!rawWindow) {
      skippedNoWindow += 1
      continue
    }

    const embargoClears = rawWindow.exitInstant.getTime() + EMBARGO_HOURS * 3600000
    if (Date.now() < embargoClears) {
      // Shouldn't happen for a trade already marked complete, but leave its
      // existing values untouched rather than guess if it somehow does.
      skippedStillEmbargoed += 1
      continue
    }

    try {
      const padMs = FILL_SEARCH_PAD_MINUTES * 60000
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
      if (ticks.length === 0) {
        skippedNoTicks += 1
        continue
      }
      const { entryInstant, exitInstant, usedFallback } = deriveFillTicks({ rawWindow, entryPrice: trade.entry, ticks })
      const windowTicks = sliceTicksForWindow(ticks, entryInstant, exitInstant)
      if (windowTicks.length === 0) {
        skippedNoTicks += 1
        continue
      }
      const { mfePoints, maePoints, drawdownSeconds } = computeExcursion({
        ticks: windowTicks,
        entry: trade.entry,
        direction: trade.direction,
      })

      const isChanged = valueChanged(trade.mfe_points, mfePoints) ||
        valueChanged(trade.mae_points, maePoints) ||
        valueChanged(trade.drawdown_seconds, drawdownSeconds) ||
        Boolean(trade.excursion_fallback) !== usedFallback

      await admin.from('trades').update({
        mfe_points: mfePoints,
        mae_points: maePoints,
        drawdown_seconds: drawdownSeconds,
        market_data_status: 'complete',
        excursion_fallback: usedFallback,
      }).eq('id', trade.id)

      recomputed += 1
      if (isChanged) {
        changed += 1
        log(`Trade ${trade.id} changed: mfe ${trade.mfe_points} -> ${mfePoints.toFixed(2)}, mae ${trade.mae_points} -> ${maePoints.toFixed(2)}, drawdown ${trade.drawdown_seconds}s -> ${drawdownSeconds}s${usedFallback ? ' [fallback timestamp used]' : ''}`)
      }
    } catch (err) {
      // A recompute failure should never destroy already-good stored
      // values - leave the trade's existing complete values as they are.
      skippedError += 1
      log(`Trade ${trade.id} recompute failed, left unchanged: ${err.message}`)
    }
  }

  log(`Recomputed: ${recomputed}. Values actually changed: ${changed}. Unchanged (recomputed to the same values): ${recomputed - changed}.`)
  log(`Skipped - flagged for manual review: ${skippedManualReview}. Not NQ-family: ${skippedNotNq}. No timezone/exit window: ${skippedNoWindow}. Still within embargo: ${skippedStillEmbargoed}. No trade prints found: ${skippedNoTicks}. Errored (left untouched): ${skippedError}.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
