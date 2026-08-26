#!/usr/bin/env node
// The trader just edited 7e8616fb (direction/entry/stop/target/exit all
// changed - looks like a full re-log, not just a typo fix). Its edit-
// triggered recompute already ran and landed on market_data_status =
// 'unavailable', which no automated job (retry only touches 'pending',
// recompute only touches 'complete') will ever revisit. This script:
// 1. Prints the trade's current full state to see exactly what's there now.
// 2. Dry-runs the standard tick-level pipeline against the NEW values to
//    see whether they verify against real market data - no write yet,
//    report first per this session's established pattern.
const { createClient } = require('@supabase/supabase-js')

const DATASET = 'GLBX.MDP3'
const NQ_CONTINUOUS_SYMBOL = 'NQ.c.0'
const PRICE_SCALE = 1e9
const EMBARGO_HOURS = 8
const FILL_SEARCH_PAD_MINUTES = 2
const FILL_PRICE_EPSILON = 0.0001
const ROLL_PROXIMITY_DAYS = 10
const ROLLOVER_DATES = require('../lib/contractRollover.json')
const CME_HOLIDAYS = require('../lib/cmeHolidays.json')

function log(...args) { console.log(new Date().toISOString(), ...args) }
function authHeader() {
  const apiKey = process.env.DATABENTO_API_KEY
  if (!apiKey) throw new Error('DATABENTO_API_KEY is not set')
  return 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64')
}
function normalizeRecord(record) {
  return { high: record.high / PRICE_SCALE, low: record.low / PRICE_SCALE, tsEvent: record.ts_event ?? record.hd?.ts_event ?? null, volume: Number(record.volume), instrumentId: record.hd?.instrument_id ?? null }
}
function normalizeTradeRecord(record) {
  return { tsEvent: record.ts_event ?? record.hd?.ts_event ?? null, price: record.price / PRICE_SCALE, size: Number(record.size) }
}
function parseRecords(text, normalize) {
  const trimmed = text.trim()
  if (!trimmed) return []
  try {
    const whole = JSON.parse(trimmed)
    if (Array.isArray(whole)) return whole.map(normalize)
    if (Array.isArray(whole?.records)) return whole.records.map(normalize)
  } catch {}
  return trimmed.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => normalize(JSON.parse(l)))
}
async function fetchOhlcv1m({ symbol, start, end, stypeIn = 'continuous' }) {
  const url = new URL('/v0/timeseries.get_range', 'https://hist.databento.com')
  url.searchParams.set('dataset', DATASET); url.searchParams.set('schema', 'ohlcv-1m'); url.searchParams.set('symbols', symbol)
  url.searchParams.set('stype_in', stypeIn); url.searchParams.set('start', start); url.searchParams.set('end', end); url.searchParams.set('encoding', 'json')
  const res = await fetch(url, { headers: { Authorization: authHeader() } })
  if (!res.ok) { const body = await res.text().catch(() => ''); throw new Error(`Databento get_range failed: ${res.status} ${res.statusText} ${body}`.trim()) }
  return parseRecords(await res.text(), normalizeRecord)
}
async function fetchTrades({ symbol, start, end, stypeIn = 'continuous' }) {
  const url = new URL('/v0/timeseries.get_range', 'https://hist.databento.com')
  url.searchParams.set('dataset', DATASET); url.searchParams.set('schema', 'trades'); url.searchParams.set('symbols', symbol)
  url.searchParams.set('stype_in', stypeIn); url.searchParams.set('start', start); url.searchParams.set('end', end); url.searchParams.set('encoding', 'json')
  const res = await fetch(url, { headers: { Authorization: authHeader() } })
  if (!res.ok) { const body = await res.text().catch(() => ''); throw new Error(`Databento get_range failed: ${res.status} ${res.statusText} ${body}`.trim()) }
  return parseRecords(await res.text(), normalizeTradeRecord)
}
function isEmbargoError(err) {
  const msg = err?.message || ''
  return msg.includes('dataset_unavailable_range') || msg.includes('data_end_after_available_end')
}
function rolloverDateStr(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` }
function isWeekend(date) { const day = date.getDay(); return day === 0 || day === 6 }
function adjustForHolidays(ds) {
  const d = new Date(ds + 'T00:00:00')
  while (isWeekend(d) || CME_HOLIDAYS[rolloverDateStr(d)]?.type === 'closed') d.setDate(d.getDate() - 1)
  return rolloverDateStr(d)
}
function findNextRolloverDate(dataSymbol, fromDate) {
  const dates = ROLLOVER_DATES[dataSymbol]; if (!dates) return null
  const todayStr = rolloverDateStr(fromDate)
  for (const raw of dates) { const adjusted = adjustForHolidays(raw); if (adjusted >= todayStr) return adjusted }
  return null
}
function daysToNearestRollover(dataSymbol, fromDate) {
  const dates = ROLLOVER_DATES[dataSymbol]; if (!dates) return null
  const fromStr = rolloverDateStr(fromDate)
  const from = new Date(fromStr + 'T00:00:00')
  const next = findNextRolloverDate(dataSymbol, from)
  const daysToNext = next ? Math.round((new Date(next + 'T00:00:00') - from) / 86400000) : null
  let previous = null
  for (const raw of dates) { const adjusted = adjustForHolidays(raw); if (adjusted < fromStr) previous = adjusted; else break }
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
  for (let i = 0; i < 3; i++) { const { minutesOfDay } = easternParts(guess); const diffMinutes = 18 * 60 - minutesOfDay; guess = new Date(guess.getTime() + diffMinutes * 60000) }
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
  try { records = await fetchOhlcv1m({ symbol: 'NQ.FUT', stypeIn: 'parent', start: sessionStart.toISOString(), end: sessionEnd.toISOString() }) } catch { return null }
  const volumeByInstrument = new Map()
  for (const r of records) { if (r.instrumentId === null || r.instrumentId === undefined) continue; volumeByInstrument.set(r.instrumentId, (volumeByInstrument.get(r.instrumentId) || 0) + r.volume) }
  let bestId = null, bestVolume = -1
  for (const [id, vol] of volumeByInstrument) if (vol > bestVolume) { bestVolume = vol; bestId = id }
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
  const dt = new Date(Date.UTC(y, m - 1, d)); dt.setUTCDate(dt.getUTCDate() + 1)
  return dt.toISOString().slice(0, 10)
}
function excursionWindow(trade, offsetHours) {
  if (!trade.trade_date || !trade.trade_time || Number.isNaN(offsetHours)) return null
  const entryInstant = wallClockToInstant(trade.trade_date, trade.trade_time, offsetHours)
  if (!entryInstant) return null
  const exitLegs = [{ price: trade.exit_price, time: trade.exit_time }, ...(trade.additional_exits || []).map((e) => ({ price: e.exit_price, time: e.exit_time }))].filter((leg) => leg.time)
  if (exitLegs.length === 0) return null
  let currentDate = trade.trade_date, currentInstant = entryInstant
  const legs = []
  for (const leg of exitLegs) {
    let instant = wallClockToInstant(currentDate, leg.time, offsetHours)
    if (instant.getTime() < currentInstant.getTime()) { currentDate = addOneDay(currentDate); instant = wallClockToInstant(currentDate, leg.time, offsetHours) }
    currentInstant = instant; legs.push({ price: leg.price, instant })
  }
  return { entryInstant, legs, exitInstant: legs[legs.length - 1].instant }
}
function tickTouchesPrice(tick, price) { return Math.abs(tick.price - price) <= FILL_PRICE_EPSILON }
function parseTickInstant(tsEvent) {
  if (tsEvent === null || tsEvent === undefined) return null
  if (typeof tsEvent === 'string' && /^\d+$/.test(tsEvent)) return new Date(Number(BigInt(tsEvent) / 1000000n))
  if (typeof tsEvent === 'number') return new Date(tsEvent / 1e6)
  const parsed = new Date(tsEvent); return Number.isNaN(parsed.getTime()) ? null : parsed
}
function findFillTick({ ticks, roughInstant, price, afterInstant }) {
  const padMs = FILL_SEARCH_PAD_MINUTES * 60000
  const windowStartMs = Math.max(roughInstant.getTime() - padMs, afterInstant ? afterInstant.getTime() : -Infinity)
  const windowEndMs = roughInstant.getTime() + padMs
  let best = null
  for (const tick of ticks) {
    if (!tickTouchesPrice(tick, price)) continue
    const instant = parseTickInstant(tick.tsEvent); if (!instant) continue
    const ms = instant.getTime(); if (ms < windowStartMs || ms > windowEndMs) continue
    if (!best || ms < best.getTime()) best = instant
  }
  if (best) return { instant: best, matched: true }
  return { instant: roughInstant, matched: false }
}
function deriveFillTicks({ rawWindow, entryPrice, ticks }) {
  const entryFill = findFillTick({ ticks, roughInstant: rawWindow.entryInstant, price: entryPrice })
  let usedFallback = !entryFill.matched, lastInstant = entryFill.instant
  for (const leg of rawWindow.legs) {
    const legFill = findFillTick({ ticks, roughInstant: leg.instant, price: leg.price, afterInstant: lastInstant })
    if (!legFill.matched) usedFallback = true
    lastInstant = legFill.instant
  }
  return { entryInstant: entryFill.instant, exitInstant: lastInstant, usedFallback }
}
function sliceTicksForWindow(ticks, entryInstant, exitInstant) {
  return ticks.map((tick) => ({ ...tick, instant: parseTickInstant(tick.tsEvent) }))
    .filter((tick) => tick.instant && tick.instant.getTime() >= entryInstant.getTime() && tick.instant.getTime() <= exitInstant.getTime())
    .sort((a, b) => a.instant.getTime() - b.instant.getTime())
}
function computeExcursion({ ticks, entry, direction }) {
  const prices = ticks.map((t) => t.price)
  const maxPrice = Math.max(...prices), minPrice = Math.min(...prices)
  const mfePoints = direction === 'long' ? maxPrice - entry : entry - minPrice
  const maePoints = direction === 'long' ? entry - minPrice : maxPrice - entry
  let drawdownMs = 0
  for (let i = 0; i < ticks.length - 1; i++) {
    const underwater = direction === 'long' ? ticks[i].price < entry : ticks[i].price > entry
    if (underwater) drawdownMs += ticks[i + 1].instant.getTime() - ticks[i].instant.getTime()
  }
  return { mfePoints, maePoints, drawdownSeconds: Math.round(drawdownMs / 1000) }
}
function floorToMinute(instant) { return new Date(Math.floor(instant.getTime() / 60000) * 60000) }
function findVerifiedMinuteFill({ ticks, roughInstant, price, afterInstant }) {
  const minuteStartMs = floorToMinute(roughInstant).getTime(), minuteEndMs = minuteStartMs + 59999
  const windowStartMs = Math.max(minuteStartMs, afterInstant ? afterInstant.getTime() : -Infinity)
  let best = null
  for (const tick of ticks) {
    if (!tickTouchesPrice(tick, price)) continue
    const instant = parseTickInstant(tick.tsEvent); if (!instant) continue
    const ms = instant.getTime(); if (ms < windowStartMs || ms > minuteEndMs) continue
    if (!best || ms < best.getTime()) best = instant
  }
  if (best) return { instant: best, matched: true }
  return { instant: new Date(minuteStartMs), matched: false }
}
function deriveVerifiedTimes({ rawWindow, entryPrice, ticks }) {
  const entryFill = findVerifiedMinuteFill({ ticks, roughInstant: rawWindow.entryInstant, price: entryPrice })
  let anyUnverified = !entryFill.matched, lastInstant = entryFill.instant
  const legs = []
  for (const leg of rawWindow.legs) {
    const legFill = findVerifiedMinuteFill({ ticks, roughInstant: leg.instant, price: leg.price, afterInstant: lastInstant })
    if (!legFill.matched) anyUnverified = true
    legs.push(legFill); lastInstant = legFill.instant
  }
  return { entry: entryFill, legs, anyUnverified }
}
function instantToWallClockTime(instant, offsetHours) {
  const local = new Date(instant.getTime() + offsetHours * 3600000)
  return `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}:${String(local.getUTCSeconds()).padStart(2, '0')}`
}
async function getUserTimezone(supabaseUrl, serviceKey, userId) {
  const res = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } })
  if (!res.ok) return null
  const user = await res.json()
  const offset = parseFloat(user?.user_metadata?.timezone)
  return Number.isNaN(offset) ? null : offset
}

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const admin = createClient(supabaseUrl, serviceKey)
  const id = '20212645-30c0-457d-a310-0158b1b4350a'

  const { data: trade, error } = await admin.from('trades').select('*').eq('id', id).single()
  if (error) throw new Error(`Failed to load trade: ${error.message}`)
  log('Current trade state:', JSON.stringify(trade))

  const { data: instrument } = await admin.from('instruments').select('data_symbol').eq('id', trade.instrument_id).single()
  log('Instrument data_symbol:', instrument?.data_symbol)

  const offsetHours = await getUserTimezone(supabaseUrl, serviceKey, trade.user_id)
  log('Timezone offset:', offsetHours)
  const rawWindow = offsetHours === null ? null : excursionWindow(trade, offsetHours)
  if (!rawWindow) { log('No excursion window derivable - stopping.'); return }
  log('Raw window:', JSON.stringify({ entryInstant: rawWindow.entryInstant.toISOString(), exitInstant: rawWindow.exitInstant.toISOString() }))

  const padMs = FILL_SEARCH_PAD_MINUTES * 60000
  let symbol = NQ_CONTINUOUS_SYMBOL, stypeIn = 'continuous'
  if (isNearRollover(instrument.data_symbol, trade.trade_date)) {
    const { start: sessionStart, end: sessionEnd } = sessionBoundsFor(rawWindow.entryInstant)
    const frontMonthId = await resolveFrontMonthByVolume({ sessionStart, sessionEnd })
    if (frontMonthId !== null) { symbol = String(frontMonthId); stypeIn = 'instrument_id' }
  }
  log(`Resolved symbol: ${symbol} (stype_in=${stypeIn})`)

  let ticks
  try {
    ticks = await fetchTrades({ symbol, stypeIn, start: new Date(rawWindow.entryInstant.getTime() - padMs).toISOString(), end: new Date(rawWindow.exitInstant.getTime() + padMs).toISOString() })
  } catch (err) {
    log(`Fetch failed: ${err.message} (embargo=${isEmbargoError(err)})`)
    return
  }
  log(`Fetched ${ticks.length} ticks.`)
  if (ticks.length === 0) { log('No ticks returned - this would classify as unavailable.'); return }

  const { entryInstant, exitInstant, usedFallback } = deriveFillTicks({ rawWindow, entryPrice: trade.entry, ticks })
  const windowTicks = sliceTicksForWindow(ticks, entryInstant, exitInstant)
  log(`Derived window: entry=${entryInstant.toISOString()} exit=${exitInstant.toISOString()} usedFallback=${usedFallback} windowTicks=${windowTicks.length}`)
  if (windowTicks.length === 0) { log('No ticks in derived window - this would classify as unavailable.'); return }

  const { mfePoints, maePoints, drawdownSeconds } = computeExcursion({ ticks: windowTicks, entry: trade.entry, direction: trade.direction })
  const verifiedTimes = deriveVerifiedTimes({ rawWindow, entryPrice: trade.entry, ticks })
  const correctedTradeTime = verifiedTimes.entry.matched ? instantToWallClockTime(verifiedTimes.entry.instant, offsetHours) : trade.trade_time
  const correctedExitTime = verifiedTimes.legs[0]?.matched ? instantToWallClockTime(verifiedTimes.legs[0].instant, offsetHours) : trade.exit_time

  const payload = {
    mfe_points: mfePoints, mae_points: maePoints, drawdown_seconds: drawdownSeconds,
    market_data_status: 'complete',
    excursion_fallback: usedFallback, trade_time: correctedTradeTime, exit_time: correctedExitTime,
    trade_time_unverified: verifiedTimes.anyUnverified,
  }
  log("WRITING:", JSON.stringify(payload))
  const { error: updateError } = await admin.from('trades').update(payload).eq('id', id)
  if (updateError) { log(`WRITE FAILED: ${updateError.message}`); return }
  const { data: after } = await admin.from('trades').select('id, trade_time, exit_time, mfe_points, mae_points, drawdown_seconds, market_data_status, excursion_fallback, trade_time_unverified').eq('id', id).single()
  log('AFTER WRITE:', JSON.stringify(after))
}

main().catch((err) => { console.error(err); process.exit(1) })
