#!/usr/bin/env node
// TEMPORARY, read-only diagnostic - not part of the app, never meant to be
// merged. Investigates why trade 076af9b3-312c-47c8-9987-1e6176545a6b
// shows excursion_fallback=true and a negative MAE even under the
// first-touch fix - pulls raw fields and real tick data around its logged
// entry/exit times to find out why the entry (or exit) fill couldn't be
// matched to a real trade print.
//
// Unlike the first version of this script, this one applies the same
// roll-aware front-month resolution the live code uses - this trade's
// date (2026-06-16) is only 3 days before the June 2026 quarterly roll,
// squarely in ROLL_PROXIMITY_DAYS, where NQ.c.0 (continuous) is confirmed
// to resolve to the wrong contract. Writes nothing to the database.

const { createClient } = require('@supabase/supabase-js')
const ROLLOVER_DATES = require('../lib/contractRollover.json')
const CME_HOLIDAYS = require('../lib/cmeHolidays.json')

const DATASET = 'GLBX.MDP3'
const PRICE_SCALE = 1e9
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

function normalizeTradeRecord(record) {
  return {
    tsEvent: record.ts_event ?? record.hd?.ts_event ?? null,
    price: record.price / PRICE_SCALE,
    size: Number(record.size),
  }
}
function normalizeOhlcvRecord(record) {
  return {
    tsEvent: record.ts_event ?? record.hd?.ts_event ?? null,
    high: record.high / PRICE_SCALE,
    low: record.low / PRICE_SCALE,
    volume: Number(record.volume),
    instrumentId: record.hd?.instrument_id ?? null,
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
    // fall through to line-delimited
  }
  return trimmed.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => normalize(JSON.parse(l)))
}

async function fetchRange({ schema, symbol, start, end, stypeIn = 'continuous', normalize }) {
  const url = new URL('/v0/timeseries.get_range', 'https://hist.databento.com')
  url.searchParams.set('dataset', DATASET)
  url.searchParams.set('schema', schema)
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
  return parseRecords(await res.text(), normalize)
}
async function fetchTrades(args) {
  return fetchRange({ ...args, schema: 'trades', normalize: normalizeTradeRecord })
}
async function fetchOhlcv1m(args) {
  return fetchRange({ ...args, schema: 'ohlcv-1m', normalize: normalizeOhlcvRecord })
}

function parseTickInstant(tsEvent) {
  if (tsEvent === null || tsEvent === undefined) return null
  if (typeof tsEvent === 'string' && /^\d+$/.test(tsEvent)) return new Date(Number(BigInt(tsEvent) / 1000000n))
  if (typeof tsEvent === 'number') return new Date(tsEvent / 1e6)
  const parsed = new Date(tsEvent)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function wallClockToInstant(dateStr, timeStr, offsetHours) {
  if (!dateStr || !timeStr) return null
  const [y, mo, d] = dateStr.split('-').map(Number)
  const [hh, mm, ss] = timeStr.split(':').map(Number)
  return new Date(Date.UTC(y, mo - 1, d, hh, mm, ss || 0) - offsetHours * 3600000)
}

// Roll-aware resolution - same logic as scripts/retry-trade-excursions.js.
function rolloverDateStr(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
function isWeekend(date) { const d = date.getDay(); return d === 0 || d === 6 }
function adjustForHolidays(ds) {
  const d = new Date(ds + 'T00:00:00')
  while (isWeekend(d) || CME_HOLIDAYS[rolloverDateStr(d)]?.type === 'closed') d.setDate(d.getDate() - 1)
  return rolloverDateStr(d)
}
function findNextRolloverDate(dataSymbol, fromDate) {
  const dates = ROLLOVER_DATES[dataSymbol]
  if (!dates) return null
  const todayStr = rolloverDateStr(fromDate)
  for (const raw of dates) { const adj = adjustForHolidays(raw); if (adj >= todayStr) return adj }
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
  for (const raw of dates) { const adj = adjustForHolidays(raw); if (adj < fromStr) previous = adj; else break }
  const daysSincePrevious = previous ? Math.round((from - new Date(previous + 'T00:00:00')) / 86400000) : null
  const candidates = [daysToNext, daysSincePrevious].filter((d) => d !== null)
  return candidates.length ? Math.min(...candidates) : null
}
function isNearRollover(dataSymbol, tradeDate) {
  const distance = daysToNearestRollover(dataSymbol, new Date(tradeDate + 'T00:00:00'))
  return distance !== null && distance <= ROLL_PROXIMITY_DAYS
}
function easternParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date)
  const map = {}; for (const p of parts) map[p.type] = p.value
  const hour = Number(map.hour) % 24
  return { minutesOfDay: hour * 60 + Number(map.minute), dateStr: `${map.year}-${map.month}-${map.day}` }
}
function sixPmEtUtc(dateUtcMidnight) {
  let guess = new Date(dateUtcMidnight.getTime() + 22 * 3600000)
  for (let i = 0; i < 3; i++) {
    const { minutesOfDay } = easternParts(guess)
    guess = new Date(guess.getTime() + (18 * 60 - minutesOfDay) * 60000)
  }
  return guess
}
function sessionBoundsFor(instant) {
  const { minutesOfDay, dateStr } = easternParts(instant)
  const [y, m, d] = dateStr.split('-').map(Number)
  let sessionDateUtc = new Date(Date.UTC(y, m - 1, d))
  if (minutesOfDay >= 18 * 60) sessionDateUtc = new Date(sessionDateUtc.getTime() + 24 * 3600000)
  return { start: sixPmEtUtc(new Date(sessionDateUtc.getTime() - 24 * 3600000)), end: sixPmEtUtc(sessionDateUtc) }
}
async function resolveFrontMonthByVolume({ sessionStart, sessionEnd }) {
  let records
  try {
    records = await fetchOhlcv1m({ symbol: 'NQ.FUT', stypeIn: 'parent', start: sessionStart.toISOString(), end: sessionEnd.toISOString() })
  } catch { return null }
  const volumeByInstrument = new Map()
  for (const r of records) {
    if (r.instrumentId == null) continue
    volumeByInstrument.set(r.instrumentId, (volumeByInstrument.get(r.instrumentId) || 0) + r.volume)
  }
  let bestId = null, bestVolume = -1
  for (const [id, vol] of volumeByInstrument) if (vol > bestVolume) { bestVolume = vol; bestId = id }
  return bestId
}

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set')
  const admin = createClient(supabaseUrl, serviceKey)

  const TRADE_ID = '076af9b3-312c-47c8-9987-1e6176545a6b'
  const { data: trade, error } = await admin.from('trades').select('*').eq('id', TRADE_ID).single()
  if (error) throw new Error(error.message)

  const { data: { user }, error: userErr } = await admin.auth.admin.getUserById(trade.user_id)
  if (userErr) throw new Error(`Could not load user: ${userErr.message}`)
  const offsetHours = parseFloat(user?.user_metadata?.timezone)
  log(`Timezone offset: ${offsetHours}`)

  const entryInstant = wallClockToInstant(trade.trade_date, trade.trade_time, offsetHours)
  const exitInstant = wallClockToInstant(trade.trade_date, trade.exit_time, offsetHours)
  log(`Rough entryInstant=${entryInstant.toISOString()} exitInstant=${exitInstant.toISOString()}`)
  log(`entry=${trade.entry} exit_price=${trade.exit_price} direction=${trade.direction} stop=${trade.stop} target=${trade.target} trade_date=${trade.trade_date}`)

  const nearRoll = isNearRollover('NQ', trade.trade_date)
  log(`isNearRollover: ${nearRoll}`)
  let symbol = 'NQ.c.0'
  let stypeIn = 'continuous'
  if (nearRoll) {
    const { start: sessionStart, end: sessionEnd } = sessionBoundsFor(entryInstant)
    log(`Session bounds for volume resolution: ${sessionStart.toISOString()} to ${sessionEnd.toISOString()}`)
    const frontMonthId = await resolveFrontMonthByVolume({ sessionStart, sessionEnd })
    log(`resolveFrontMonthByVolume => ${frontMonthId}`)
    if (frontMonthId !== null) { symbol = String(frontMonthId); stypeIn = 'instrument_id' }
  }
  log(`Using symbol=${symbol} stypeIn=${stypeIn}`)

  const padMs = 15 * 60000
  const start = new Date(entryInstant.getTime() - padMs).toISOString()
  const end = new Date(exitInstant.getTime() + padMs).toISOString()
  log(`Fetching trades: start=${start} end=${end}`)

  const ticks = await fetchTrades({ symbol, stypeIn, start, end })
  const parsed = ticks
    .map((t) => ({ ...t, instant: parseTickInstant(t.tsEvent) }))
    .filter((t) => t.instant)
    .sort((a, b) => a.instant.getTime() - b.instant.getTime())
  log(`${parsed.length} tick(s) fetched.`)

  if (parsed.length === 0) {
    log('=> No trade prints at all in this window on the resolved front-month contract.')
    return
  }

  log(`First tick: ${parsed[0].instant.toISOString()} price=${parsed[0].price}`)
  log(`Last tick: ${parsed[parsed.length - 1].instant.toISOString()} price=${parsed[parsed.length - 1].price}`)

  for (const [label, price, roughInstant] of [['entry', trade.entry, entryInstant], ['exit', trade.exit_price, exitInstant]]) {
    if (price === null || price === undefined) continue
    const matches = parsed.filter((t) => Math.abs(t.price - price) <= FILL_PRICE_EPSILON)
    if (matches.length === 0) {
      log(`No tick anywhere in the ±15min window touches ${label} price ${price}.`)
      const closestBefore = [...parsed].reverse().find((t) => t.instant.getTime() <= roughInstant.getTime())
      const closestAfter = parsed.find((t) => t.instant.getTime() >= roughInstant.getTime())
      log(`  Nearest tick before logged ${label} time: ${closestBefore ? `${closestBefore.instant.toISOString()} price=${closestBefore.price}` : 'none'}`)
      log(`  Nearest tick after logged ${label} time: ${closestAfter ? `${closestAfter.instant.toISOString()} price=${closestAfter.price}` : 'none'}`)
    } else {
      log(`${matches.length} tick(s) touch ${label} price ${price}. First: ${matches[0].instant.toISOString()}, last: ${matches[matches.length - 1].instant.toISOString()}`)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
