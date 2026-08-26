#!/usr/bin/env node
// TEMPORARY, one-off - not part of the app, never meant to be merged.
// Trade 471db32c-4be5-4fbc-9014-7c59db1f5326 was permanently marked
// market_data_status = 'unavailable' by a non-embargo fetch error during
// an hourly retry, a bug just fixed in scripts/retry-trade-excursions.js
// and app/api/backfill-trade-excursion/route.js (see NOTES.md). A
// read-only diagnostic already confirmed Databento has good data for this
// trade's window right now (20 bars, clean fill-instant match on both
// entry and exit, no fallback needed). This re-runs that exact same
// backfill logic for this one trade and writes the result, the same way
// the fixed route/retry job would have.

const { createClient } = require('@supabase/supabase-js')
const ROLLOVER_DATES = require('../lib/contractRollover.json')
const CME_HOLIDAYS = require('../lib/cmeHolidays.json')

const DATASET = 'GLBX.MDP3'
const NQ_CONTINUOUS_SYMBOL = 'NQ.c.0'
const PRICE_SCALE = 1e9
const EMBARGO_HOURS = 8
const ROLL_PROXIMITY_DAYS = 10
const FILL_SEARCH_PAD_MINUTES = 2
const FILL_PRICE_EPSILON = 0.0001

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

function isEmbargoError(err) {
  const msg = err?.message || ''
  return msg.includes('dataset_unavailable_range') || msg.includes('data_end_after_available_end')
}

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
  } catch (err) {
    log(`  resolveFrontMonthByVolume fetch failed: ${err.message}`)
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
function barTouchesPrice(bar, price) {
  return price >= bar.low - FILL_PRICE_EPSILON && price <= bar.high + FILL_PRICE_EPSILON
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
  return { mfePoints, maePoints, drawdownSeconds: underwaterBars * 60 }
}

const TRADE_ID = '471db32c-4be5-4fbc-9014-7c59db1f5326'

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set')
  const admin = createClient(supabaseUrl, serviceKey)

  const { data: trade, error } = await admin.from('trades').select('*').eq('id', TRADE_ID).single()
  if (error) throw new Error(error.message)
  log(`Trade ${trade.id}: trade_date=${trade.trade_date} trade_time=${trade.trade_time} exit_time=${trade.exit_time} direction=${trade.direction} entry=${trade.entry} exit_price=${trade.exit_price} current market_data_status=${trade.market_data_status}`)

  const { data: { user }, error: userErr } = await admin.auth.admin.getUserById(trade.user_id)
  if (userErr) throw new Error(`Could not load user: ${userErr.message}`)
  const offsetHours = parseFloat(user?.user_metadata?.timezone)
  if (Number.isNaN(offsetHours)) throw new Error('No valid timezone offset on the account - refusing to write.')

  const rawWindow = excursionWindow(trade, offsetHours)
  if (!rawWindow) throw new Error('excursionWindow returned null - refusing to write.')
  log(`entryInstant=${rawWindow.entryInstant.toISOString()} exitInstant=${rawWindow.exitInstant.toISOString()}`)

  const padMs = FILL_SEARCH_PAD_MINUTES * 60000
  let symbol = NQ_CONTINUOUS_SYMBOL
  let stypeIn = 'continuous'
  if (isNearRollover('NQ', trade.trade_date)) {
    const { start: sessionStart, end: sessionEnd } = sessionBoundsFor(rawWindow.entryInstant)
    const frontMonthId = await resolveFrontMonthByVolume({ sessionStart, sessionEnd })
    if (frontMonthId !== null) {
      symbol = String(frontMonthId)
      stypeIn = 'instrument_id'
    }
  }
  log(`Using symbol=${symbol} stypeIn=${stypeIn}`)

  const start = new Date(rawWindow.entryInstant.getTime() - padMs).toISOString()
  const end = new Date(rawWindow.exitInstant.getTime() + padMs).toISOString()
  const bars = await fetchOhlcv1m({ symbol, stypeIn, start, end })
  log(`${bars.length} bar(s) fetched.`)
  if (bars.length === 0) throw new Error('No bars returned - refusing to write.')

  const { entryInstant, exitInstant, usedFallback } = deriveFillInstants({ rawWindow, entryPrice: trade.entry, bars })
  log(`Derived entryInstant=${entryInstant.toISOString()} exitInstant=${exitInstant.toISOString()} usedFallback=${usedFallback}`)
  const windowBars = sliceBarsForWindow(bars, entryInstant, exitInstant)
  if (windowBars.length === 0) throw new Error('No bars in derived window - refusing to write.')

  const { mfePoints, maePoints, drawdownSeconds } = computeExcursion({ bars: windowBars, entry: trade.entry, direction: trade.direction })
  log(`Computed: mfe_points=${mfePoints.toFixed(2)} mae_points=${maePoints.toFixed(2)} drawdown_seconds=${drawdownSeconds} excursion_fallback=${usedFallback}`)

  const { error: writeErr } = await admin.from('trades').update({
    mfe_points: mfePoints,
    mae_points: maePoints,
    drawdown_seconds: drawdownSeconds,
    market_data_status: 'complete',
    excursion_fallback: usedFallback,
  }).eq('id', TRADE_ID)
  if (writeErr) throw new Error(`Write failed: ${writeErr.message}`)
  log('Write succeeded.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
