#!/usr/bin/env node

// Diagnostic / research script - NOT part of the app's runtime, NOT
// scheduled. Run manually via the "Run a diagnostic script" GitHub Action.
//
// Pulls every trade logged under one strategy (STRATEGY_NAME, scoped to one
// instrument's INSTRUMENT_SYMBOL) and, for each, fetches the real Databento
// market data around it - the prior completed session's volume profile (a
// coarse "which price zone traded the most" read, built from ohlcv-1m bar
// volume rather than raw tick prints, to keep this first pass cheap against
// the account's $125 historical credit) and the hour and a half of price
// action immediately before entry - so a strategy's actual setup can be
// characterized from real market context instead of guessed at from
// entry/stop/target prices alone.
//
// This is a data-gathering step, not a finished indicator: it prints one
// JSON object per trade (prefixed TRADE_CONTEXT:) plus a closing SUMMARY:
// line, meant to be read from the workflow's job log and analyzed from
// there - it does not write anything back to Supabase or anywhere else.
//
// Deliberately standalone (duplicates the ET-session-boundary math from
// lib/databento.js / scripts/fetch-daily-market-stats.js and the wall-clock
// -to-UTC-instant math from lib/tradeSessions.js) rather than importing
// those - this repo has no "type": "module" in package.json, so their
// `export`/`import` syntax isn't reliably loadable from a plain `node
// scripts/...` invocation. Same reason those two scripts already duplicate
// this logic instead of sharing it.
//
// Usage: node scripts/pull-strategy-market-context.js
// Env: DATABENTO_API_KEY, SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL,
//      STRATEGY_NAME, INSTRUMENT_SYMBOL, USER_EMAIL

const { createClient } = require('@supabase/supabase-js')

const DATASET = 'GLBX.MDP3'
const PRICE_SCALE = 1e9
const BASE_URL = 'https://hist.databento.com'

// How wide one volume-profile bucket is, in points - coarse on purpose for
// this first pass (see header comment). 25 points on NQ is roughly the
// width of a small consolidation, not a single price.
const BUCKET_POINTS = 25
// How many of the highest-volume buckets from the prior session count as
// "the HVZs" a trade's entry gets measured against.
const TOP_ZONES = 3
// How far back from entry to pull 1-minute bars for the immediate pre-entry
// read (approach direction, recent range, ATR).
const LOOKBACK_MINUTES = 90
// A trade's entry within this many points of a prior-session high-volume
// zone counts toward the summary's "near an HVZ" tally - a loose first-pass
// threshold, not a claim about the strategy's real trigger distance.
const HVZ_PROXIMITY_POINTS = 15

function log(...args) {
  console.error(new Date().toISOString(), ...args)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------- duplicated ET / session-boundary math ----------
// See scripts/fetch-daily-market-stats.js's own copy of this - same reason
// for the duplication (this file's header comment).

function etOffsetMinutesFor(dateStr) {
  const noonUtc = new Date(`${dateStr}T12:00:00Z`)
  const etString = noonUtc.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' })
  const [h, m] = etString.split(':').map(Number)
  const etMinutesOfDay = (h % 24) * 60 + m
  let offset = etMinutesOfDay - 12 * 60
  if (offset > 720) offset -= 1440
  if (offset <= -720) offset += 1440
  return offset
}

function easternPartsFor(instant) {
  const dateStr = instant.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const timeStr = instant.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false })
  const [h, m] = timeStr.split(':').map(Number)
  return { dateStr, minutesOfDay: h * 60 + m }
}

function etWallClockToUtc(dateStr, minutesOfDay) {
  const offset = etOffsetMinutesFor(dateStr)
  const [y, m, d] = dateStr.split('-').map(Number)
  const baseUtcMs = Date.UTC(y, m - 1, d, 0, 0, 0)
  return new Date(baseUtcMs + (minutesOfDay - offset) * 60000)
}

function addDaysToDateStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

// The CME/Globex trading day containing `instant`: 6pm ET the evening
// before through 6pm ET on the session's own date. Mirrors lib/
// databento.js's sessionBoundsFor.
function sessionBoundsFor(instant) {
  const { dateStr, minutesOfDay } = easternPartsFor(instant)
  let sessionDateStr = dateStr
  if (minutesOfDay >= 18 * 60) sessionDateStr = addDaysToDateStr(dateStr, 1)
  const end = etWallClockToUtc(sessionDateStr, 18 * 60)
  const start = etWallClockToUtc(addDaysToDateStr(sessionDateStr, -1), 18 * 60)
  return { start, end, sessionDateStr }
}

// Same "local = UTC + offset" convention as lib/tradeSessions.js's own
// wallClockToInstant.
function wallClockToInstant(dateStr, timeStr, offsetHours) {
  const [y, mo, d] = dateStr.split('-').map(Number)
  const [hh, mm, ss] = timeStr.split(':').map(Number)
  return new Date(Date.UTC(y, mo - 1, d, hh, mm, ss || 0) - offsetHours * 3600000)
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

async function fetchOhlcv1m(symbol, start, end) {
  const url = new URL('/v0/timeseries.get_range', BASE_URL)
  url.searchParams.set('dataset', DATASET)
  url.searchParams.set('schema', 'ohlcv-1m')
  url.searchParams.set('symbols', `${symbol}.c.0`)
  url.searchParams.set('stype_in', 'continuous')
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

// ---------- analysis ----------

// { bucketStart, volume }[] sorted by volume desc - the highest-volume
// price buckets across a set of bars, built from each bar's own volume
// weighted onto its midpoint price. A first-pass stand-in for a true
// tick-built volume profile (see header comment).
function volumeProfile(bars) {
  const byBucket = new Map()
  for (const bar of bars) {
    const mid = (bar.high + bar.low) / 2
    const bucketStart = Math.floor(mid / BUCKET_POINTS) * BUCKET_POINTS
    byBucket.set(bucketStart, (byBucket.get(bucketStart) || 0) + bar.volume)
  }
  return [...byBucket.entries()]
    .map(([bucketStart, volume]) => ({ bucketStart, bucketEnd: bucketStart + BUCKET_POINTS, volume }))
    .sort((a, b) => b.volume - a.volume)
}

function averageTrueRange(bars) {
  if (bars.length < 2) return null
  let sum = 0
  let count = 0
  for (let i = 1; i < bars.length; i++) {
    const prevClose = bars[i - 1].close
    const bar = bars[i]
    const tr = Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose))
    sum += tr
    count++
  }
  return count ? sum / count : null
}

function distanceToNearestZone(price, zones) {
  let best = null
  for (const z of zones) {
    const center = (z.bucketStart + z.bucketEnd) / 2
    const dist = Math.abs(price - center)
    if (best === null || dist < best) best = dist
  }
  return best
}

async function findUserIdByEmail(admin, email) {
  let page = 1
  const perPage = 1000
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage })
    if (error) throw error
    const match = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase())
    if (match) return match
    if (data.users.length < perPage) return null
    page++
  }
}

async function main() {
  const strategyName = process.env.STRATEGY_NAME || 'HVZ rejection'
  const instrumentSymbol = process.env.INSTRUMENT_SYMBOL || 'NQ'
  const userEmail = process.env.USER_EMAIL
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set')
  if (!userEmail) throw new Error('USER_EMAIL is not set')

  const admin = createClient(supabaseUrl, serviceKey)

  const user = await findUserIdByEmail(admin, userEmail)
  if (!user) throw new Error(`No user found for email ${userEmail}`)
  const offsetHours = Number(user.user_metadata?.timezone ?? 0)
  log(`User ${userEmail} -> ${user.id}, saved UTC offset ${offsetHours}h`)

  const { data: instrument, error: instrumentError } = await admin
    .from('instruments')
    .select('id, symbol')
    .eq('user_id', user.id)
    .eq('symbol', instrumentSymbol)
    .maybeSingle()
  if (instrumentError) throw instrumentError
  if (!instrument) throw new Error(`No instrument ${instrumentSymbol} for this user`)

  const { data: strategy, error: strategyError } = await admin
    .from('strategies')
    .select('id, name')
    .eq('instrument_id', instrument.id)
    .eq('name', strategyName)
    .maybeSingle()
  if (strategyError) throw strategyError
  if (!strategy) throw new Error(`No strategy "${strategyName}" for ${instrumentSymbol}`)

  const { data: trades, error: tradesError } = await admin
    .from('trades')
    .select('id, trade_date, trade_time, direction, entry, stop, target, exit_price, exit_time, r_multiple, stop_distance, target_distance')
    .eq('strategy_id', strategy.id)
    .order('trade_date', { ascending: true })
  if (tradesError) throw tradesError
  if (!trades || trades.length === 0) {
    log(`No trades found under "${strategyName}" (${instrumentSymbol}).`)
    return
  }
  log(`${trades.length} trade(s) under "${strategyName}" (${instrumentSymbol}). Pulling market context...`)

  let nearHvzCount = 0
  let usableCount = 0

  for (const trade of trades) {
    try {
      const entryInstant = wallClockToInstant(trade.trade_date, trade.trade_time, offsetHours)
      const currentSession = sessionBoundsFor(entryInstant)
      // An instant safely inside the prior session, to derive its bounds.
      const priorSession = sessionBoundsFor(new Date(currentSession.start.getTime() - 3600000))

      const [priorSessionBars, preEntryBars] = await Promise.all([
        fetchOhlcv1m(instrument.symbol, priorSession.start, priorSession.end),
        fetchOhlcv1m(instrument.symbol, new Date(entryInstant.getTime() - LOOKBACK_MINUTES * 60000), entryInstant),
      ])

      if (priorSessionBars.length === 0 || preEntryBars.length === 0) {
        log(`Trade ${trade.id} (${trade.trade_date}): no bars returned - skipping (embargo, holiday, or gap).`)
        continue
      }

      const zones = volumeProfile(priorSessionBars).slice(0, TOP_ZONES)
      const distanceToHvz = distanceToNearestZone(trade.entry, zones)
      const windowHigh = Math.max(...preEntryBars.map((b) => b.high))
      const windowLow = Math.min(...preEntryBars.map((b) => b.low))
      const atr = averageTrueRange(preEntryBars.slice(-15))
      const near = distanceToHvz !== null && distanceToHvz <= HVZ_PROXIMITY_POINTS

      usableCount++
      if (near) nearHvzCount++

      console.log('TRADE_CONTEXT:' + JSON.stringify({
        tradeId: trade.id,
        tradeDate: trade.trade_date,
        tradeTime: trade.trade_time,
        direction: trade.direction,
        entry: trade.entry,
        stop: trade.stop,
        target: trade.target,
        exitPrice: trade.exit_price,
        rMultiple: trade.r_multiple,
        stopDistance: trade.stop_distance,
        targetDistance: trade.target_distance,
        priorSessionDate: priorSession.sessionDateStr,
        priorSessionHvzZones: zones,
        distanceToNearestHvz: distanceToHvz,
        nearHvz: near,
        preEntryWindowMinutes: LOOKBACK_MINUTES,
        preEntryWindowHigh: windowHigh,
        preEntryWindowLow: windowLow,
        preEntryAtr14: atr,
      }))
    } catch (err) {
      log(`Trade ${trade.id} (${trade.trade_date}) failed: ${err.message}`)
    }

    // One trade's worth of requests at a time, with a short pause - this is
    // a manual research run, not a latency-sensitive job, and a burst of
    // parallel range requests per trade is exactly the shape of traffic a
    // historical API is likely to throttle.
    await sleep(250)
  }

  console.log('SUMMARY:' + JSON.stringify({
    strategyName,
    instrumentSymbol,
    totalTrades: trades.length,
    usableTrades: usableCount,
    nearHvzCount,
    hvzProximityPoints: HVZ_PROXIMITY_POINTS,
    bucketPoints: BUCKET_POINTS,
  }))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
