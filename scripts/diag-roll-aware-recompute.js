#!/usr/bin/env node

// TEMPORARY, read-only diagnostic - not part of the app, never meant to be
// merged. Runs the NEW logic (fill-instant derivation + roll-aware,
// volume-based front-month resolution within ROLL_PROXIMITY_DAYS of a
// quarterly roll) against every currently-complete NQ trade and reports
// full before/after for every one whose values change - not just a count,
// and not just the target-hit subset checked earlier. Writes nothing to
// the database. See PR #122 for the full investigation this closes out.

const { createClient } = require('@supabase/supabase-js')
const ROLLOVER_DATES = require('../lib/contractRollover.json')
const CME_HOLIDAYS = require('../lib/cmeHolidays.json')

const DATASET = 'GLBX.MDP3'
const NQ_CONTINUOUS_SYMBOL = 'NQ.c.0'
const PRICE_SCALE = 1e9
const BAR_SECONDS = 60
const FILL_SEARCH_PAD_MINUTES = 2
const FILL_PRICE_EPSILON = 0.0001
const ROLL_PROXIMITY_DAYS = 10

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

function parseOhlcvRecords(text) {
  const trimmed = text.trim()
  if (!trimmed) return []
  try {
    const whole = JSON.parse(trimmed)
    if (Array.isArray(whole)) return whole.map(normalizeRecord)
    if (Array.isArray(whole?.records)) return whole.records.map(normalizeRecord)
  } catch {
    // fall through to line-delimited
  }
  return trimmed.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => normalizeRecord(JSON.parse(l)))
}

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
  return parseOhlcvRecords(await res.text())
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

function barTouchesPrice(bar, price) {
  return price >= bar.low - FILL_PRICE_EPSILON && price <= bar.high + FILL_PRICE_EPSILON
}
function parseBarInstant(tsEvent) {
  if (tsEvent === null || tsEvent === undefined) return null
  if (typeof tsEvent === 'string' && /^\d+$/.test(tsEvent)) return new Date(Number(BigInt(tsEvent) / 1000000n))
  if (typeof tsEvent === 'number') return new Date(tsEvent / 1e6)
  const parsed = new Date(tsEvent)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}
function minuteBucketStart(instant, minuteOffset) {
  const bucket = new Date(instant.getTime() + minuteOffset * 60000)
  bucket.setUTCSeconds(0, 0)
  return bucket.getTime()
}
function findFillInstant({ bars, roughInstant, price }) {
  for (const minuteOffset of [0, -1, 1]) {
    const bucketStart = minuteBucketStart(roughInstant, minuteOffset)
    const candidates = bars
      .map((bar) => ({ bar, instant: parseBarInstant(bar.tsEvent) }))
      .filter(({ instant }) => instant && minuteBucketStart(instant, 0) === bucketStart)
      .sort((a, b) => a.instant.getTime() - b.instant.getTime())
    const hit = candidates.find(({ bar }) => barTouchesPrice(bar, price))
    if (hit) return { instant: hit.instant, matched: true }
  }
  return { instant: roughInstant, matched: false }
}
function deriveFillInstants({ rawWindow, entryPrice, bars }) {
  const entryFill = findFillInstant({ bars, roughInstant: rawWindow.entryInstant, price: entryPrice })
  let usedFallback = !entryFill.matched
  let lastInstant = entryFill.instant
  for (const leg of rawWindow.legs) {
    const legFill = findFillInstant({ bars, roughInstant: leg.instant, price: leg.price })
    if (!legFill.matched) usedFallback = true
    lastInstant = legFill.instant
  }
  return { entryInstant: entryFill.instant, exitInstant: lastInstant, usedFallback }
}
function sliceBarsForWindow(bars, entryInstant, exitInstant) {
  return bars.filter((bar) => {
    const instant = parseBarInstant(bar.tsEvent)
    return instant && instant.getTime() >= entryInstant.getTime() && instant.getTime() <= exitInstant.getTime()
  })
}
function computeExcursion({ bars, entry, direction }) {
  const highs = bars.map((b) => b.high)
  const lows = bars.map((b) => b.low)
  const maxHigh = Math.max(...highs)
  const minLow = Math.min(...lows)
  const mfePoints = direction === 'long' ? maxHigh - entry : entry - minLow
  const maePoints = direction === 'long' ? entry - minLow : maxHigh - entry
  let underwaterBars = 0
  for (const bar of bars) {
    const underwater = direction === 'long' ? bar.low < entry : bar.high > entry
    if (underwater) underwaterBars += 1
  }
  return { mfePoints, maePoints, drawdownSeconds: underwaterBars * BAR_SECONDS }
}

// Roll-date logic - mirrors lib/contractRollover.js's own copies.
function rolloverDateStr(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
function isWeekend(date) {
  const day = date.getDay()
  return day === 0 || day === 6
}
function adjustForHolidays(ds) {
  const d = new Date(ds + 'T00:00:00')
  while (isWeekend(d) || CME_HOLIDAYS[rolloverDateStr(d)]?.type === 'closed') d.setDate(d.getDate() - 1)
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

// Session-bounds + volume-based front-month resolution - mirrors
// lib/databento.js's own copies.
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

async function getUserTimezone(supabaseUrl, serviceKey, userId, cache) {
  if (cache.has(userId)) return cache.get(userId)
  const res = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  })
  if (!res.ok) { cache.set(userId, null); return null }
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

  const { data: instruments } = await admin.from('instruments').select('id, symbol, data_symbol')
  const dataSymbolById = new Map((instruments || []).map((i) => [i.id, i.data_symbol]))
  const nqInstrumentIds = (instruments || []).filter((i) => i.data_symbol === 'NQ').map((i) => i.id)

  const { data: complete, error } = await admin.from('trades').select('*')
    .eq('market_data_status', 'complete').in('instrument_id', nqInstrumentIds)
  if (error) throw new Error(`Failed to load trades: ${error.message}`)
  log(`${complete.length} complete NQ-family trade(s) examined (every one, not just target-hit).`)

  const timezoneCache = new Map()
  let changedCount = 0
  let unchangedCount = 0
  let errorCount = 0

  for (const trade of complete) {
    const offsetHours = await getUserTimezone(supabaseUrl, serviceKey, trade.user_id, timezoneCache)
    const rawWindow = offsetHours === null ? null : excursionWindow(trade, offsetHours)
    if (!rawWindow) {
      log(`Trade ${trade.id}: no timezone/window - skipping.`)
      errorCount += 1
      continue
    }

    const rollDistance = daysToNearestRollover(dataSymbolById.get(trade.instrument_id), new Date(trade.trade_date + 'T00:00:00'))
    const nearRoll = isNearRollover(dataSymbolById.get(trade.instrument_id), trade.trade_date)

    let symbol = NQ_CONTINUOUS_SYMBOL
    let stypeIn = 'continuous'
    let resolvedVia = 'NQ.c.0 (continuous, not near a roll)'
    if (nearRoll) {
      const { start: sessionStart, end: sessionEnd } = sessionBoundsFor(rawWindow.entryInstant)
      const frontMonthId = await resolveFrontMonthByVolume({ sessionStart, sessionEnd })
      if (frontMonthId !== null) {
        symbol = String(frontMonthId)
        stypeIn = 'instrument_id'
        resolvedVia = `instrument_id=${frontMonthId} (volume-based, ${rollDistance}d from roll)`
      } else {
        resolvedVia = `NQ.c.0 (volume resolution failed, ${rollDistance}d from roll)`
      }
    }

    try {
      const padMs = FILL_SEARCH_PAD_MINUTES * 60000
      const bars = await fetchOhlcv1m({
        symbol, stypeIn,
        start: new Date(rawWindow.entryInstant.getTime() - padMs).toISOString(),
        end: new Date(rawWindow.exitInstant.getTime() + padMs).toISOString(),
      })
      if (bars.length === 0) {
        log(`Trade ${trade.id}: no bars returned (${resolvedVia}) - leaving as-is.`)
        errorCount += 1
        continue
      }
      const { entryInstant, exitInstant, usedFallback } = deriveFillInstants({ rawWindow, entryPrice: trade.entry, bars })
      const windowBars = sliceBarsForWindow(bars, entryInstant, exitInstant)
      if (windowBars.length === 0) {
        log(`Trade ${trade.id}: no bars in derived window (${resolvedVia}) - leaving as-is.`)
        errorCount += 1
        continue
      }
      const { mfePoints, maePoints, drawdownSeconds } = computeExcursion({ bars: windowBars, entry: trade.entry, direction: trade.direction })

      const changed = Math.abs((trade.mfe_points ?? NaN) - mfePoints) > 0.005 ||
        Math.abs((trade.mae_points ?? NaN) - maePoints) > 0.005 ||
        (trade.drawdown_seconds ?? null) !== drawdownSeconds

      if (changed) {
        changedCount += 1
        log(`CHANGED  ${trade.id} [${trade.direction}, ${trade.trade_date}] via ${resolvedVia}`)
        log(`  before: mfe=${trade.mfe_points} mae=${trade.mae_points} drawdown=${trade.drawdown_seconds}s`)
        log(`  after:  mfe=${mfePoints.toFixed(2)} mae=${maePoints.toFixed(2)} drawdown=${drawdownSeconds}s usedFallback=${usedFallback}`)
      } else {
        unchangedCount += 1
        log(`unchanged ${trade.id} [${trade.direction}, ${trade.trade_date}] via ${resolvedVia} - mfe=${mfePoints.toFixed(2)} mae=${maePoints.toFixed(2)} drawdown=${drawdownSeconds}s`)
      }
    } catch (err) {
      errorCount += 1
      log(`Trade ${trade.id}: fetch/compute failed (${resolvedVia}): ${err.message}`)
    }
  }

  log(`Done. ${complete.length} examined. Changed: ${changedCount}. Unchanged: ${unchangedCount}. Errors/skipped: ${errorCount}.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
