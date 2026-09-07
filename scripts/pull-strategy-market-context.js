#!/usr/bin/env node

// Diagnostic / research script - NOT part of the app's runtime, NOT
// scheduled. Run manually via the "Run a diagnostic script" GitHub Action.
//
// Pulls every trade logged under one strategy (STRATEGY_NAME, scoped to one
// instrument's INSTRUMENT_SYMBOL) and, for each, rebuilds the same two
// rolling volume profiles the trader actually uses to find this setup: a
// 5-minute profile over a rolling 270-bar lookback and a 15-minute profile
// over a rolling 240-bar lookback (both real trader-supplied parameters,
// not guessed at - see the "Second pass" note below). Both are built from
// real Databento ohlcv-1m bars, aggregated up rather than fetched as a
// distinct schema (see fetchOhlcv1m's own comment on why).
//
// For each trade this reports: where the entry sits relative to each
// profile's proof-of-concept node (POC) and its top-3 highest-volume
// zones, and whether the few minutes immediately before entry show a
// wick into one of those zones that closed back out in the trade's
// direction - the actual mechanical signature of a "rejection" trade,
// rather than just "was the entry close to a high-volume price".
//
// This is a data-gathering step, not a finished indicator: it prints one
// JSON object per trade (prefixed TRADE_CONTEXT:) plus a closing SUMMARY:
// line, meant to be read from the workflow's job log and analyzed from
// there - it does not write anything back to Supabase or anywhere else.
//
// Second pass: the first version of this script (see PR #177) guessed at
// "HVZ" as the top-3 buckets of the single prior CME session, which only
// matched about half the logged trades - a coin flip, not a signal. The
// trader then gave the actual definition they trade off: a 5m volume
// profile (270-bar rolling lookback) and a 15m volume profile (240-bar
// rolling lookback). This version replaces the session-based guess with
// that real definition.
//
// Deliberately standalone (duplicates the wall-clock-to-UTC-instant math
// from lib/tradeSessions.js) rather than importing it - this repo has no
// "type": "module" in package.json, so its `export`/`import` syntax isn't
// reliably loadable from a plain `node scripts/...` invocation. Same
// reason scripts/fetch-daily-market-stats.js already duplicates similar
// Databento/date logic instead of importing lib/databento.js.
//
// Usage: node scripts/pull-strategy-market-context.js
// Env: DATABENTO_API_KEY, SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL,
//      STRATEGY_NAME, INSTRUMENT_SYMBOL, USER_EMAIL

const { createClient } = require('@supabase/supabase-js')

const DATASET = 'GLBX.MDP3'
const PRICE_SCALE = 1e9
const BASE_URL = 'https://hist.databento.com'

// The trader's own indicator parameters - not guesses. See header comment.
const PROFILE_5M = { intervalMinutes: 5, lookbackBars: 270 }
const PROFILE_15M = { intervalMinutes: 15, lookbackBars: 240 }
// How many price rows each profile is split into across its own high-low
// range - a typical default for a volume-profile study (matches common
// charting-platform defaults; the trader didn't specify their own row
// count, so this is the one guessed parameter left).
const PROFILE_ROWS = 30
// How many of a profile's highest-volume rows count as its "zones" for the
// entry-proximity and rejection checks.
const TOP_ZONES = 3
// How far back from entry (in raw 1-minute bars) to look for a wick into a
// zone that closed back out before entry - the actual "rejection" motion.
const REJECTION_LOOKBACK_MINUTES = 15
// How far back from entry to pull 1-minute bars for the immediate pre-entry
// read (recent range, ATR) - kept separate from the profile lookbacks
// since it's just a shorter, human-readable window.
const PRE_ENTRY_WINDOW_MINUTES = 90
// Calendar hours of 1-minute bars to fetch per trade, ending at entry - has
// to comfortably exceed the 15m profile's 240*15 = 3600 real trading
// minutes (60h) even after a weekend (~49h closed) and daily maintenance
// breaks, so a Monday-morning trade can still fill its whole lookback.
const FETCH_LOOKBACK_HOURS = 120

function log(...args) {
  console.error(new Date().toISOString(), ...args)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
    // Kept as a string (nanosecond epoch) rather than parsed into a Number -
    // real values here (~1.8e18) blow past Number.MAX_SAFE_INTEGER, so the
    // aggregation below reads it back out via BigInt instead.
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

// ohlcv-1m only - Databento's fixed-interval schemas for this dataset are
// 1s/1m/1h/1d, no 5m/15m of their own, so the two profiles below are built
// by aggregating 1-minute bars up rather than requesting a schema that
// doesn't exist. One fetch per trade (not two, the way the first pass did)
// since this window comfortably covers both the profile lookbacks and the
// shorter pre-entry read.
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

// Groups consecutive 1-minute bars into `intervalMinutes` bars, keyed by
// each bar's own minute-of-epoch (via BigInt - see normalizeRecord's own
// comment on why tsEvent stays a string). Only ever produces a bar for a
// span that actually has 1-minute data in it, so a maintenance-break or
// weekend gap just contributes no bar rather than a hole to fill - the same
// "rolling N *real* bars back" behavior a charting platform's own volume
// profile study would show.
function aggregateBars(bars, intervalMinutes) {
  const groups = []
  let current = null
  let currentKey = null
  for (const bar of bars) {
    const minuteEpoch = BigInt(bar.tsEvent) / 1000000000n / 60n
    const key = minuteEpoch / BigInt(intervalMinutes)
    if (currentKey === null || key !== currentKey) {
      if (current) groups.push(current)
      current = { open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume }
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

// A volume profile over `bars`, split into `rows` equal-width price bands
// spanning the bars' own high-low range - the standard "fixed row count"
// construction most charting platforms' volume profile study uses. Returns
// the point-of-control (single highest-volume row) and every row sorted by
// volume descending, each bar's volume weighted onto its own midpoint price
// (a bar's volume traded across its whole range, not just one price - the
// midpoint is the standard approximation here, same tradeoff the first
// pass's session-level version made).
function volumeProfile(bars, rows) {
  if (bars.length === 0) return { poc: null, zones: [], bucketSize: null, barsUsed: 0 }
  const high = Math.max(...bars.map((b) => b.high))
  const low = Math.min(...bars.map((b) => b.low))
  const bucketSize = (high - low) / rows || 1
  const byBucket = new Map()
  for (const bar of bars) {
    const mid = (bar.high + bar.low) / 2
    let idx = Math.floor((mid - low) / bucketSize)
    if (idx >= rows) idx = rows - 1
    if (idx < 0) idx = 0
    byBucket.set(idx, (byBucket.get(idx) || 0) + bar.volume)
  }
  const zones = [...byBucket.entries()]
    .map(([idx, volume]) => ({ bucketStart: low + idx * bucketSize, bucketEnd: low + (idx + 1) * bucketSize, volume }))
    .sort((a, b) => b.volume - a.volume)
  return { poc: zones[0] || null, zones, bucketSize, barsUsed: bars.length }
}

function zoneCenter(zone) {
  return (zone.bucketStart + zone.bucketEnd) / 2
}

function priceInZone(price, zone) {
  return price >= zone.bucketStart && price < zone.bucketEnd
}

function distanceToPoc(price, profile) {
  return profile.poc ? Math.abs(price - zoneCenter(profile.poc)) : null
}

function entryInsideTopZones(price, profile) {
  return profile.zones.slice(0, TOP_ZONES).some((z) => priceInZone(price, z))
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

// Did price wick into one of a profile's top zones in the REJECTION_
// LOOKBACK_MINUTES before entry, then close back outside it in the trade's
// own direction? For a short, "into the zone" means price ran UP into it
// (the zone capped the rally); for a long, price ran DOWN into it (the zone
// held as support). This is the actual mechanical signature "rejection"
// implies, not just "the entry happened to be near a high-volume price".
function findRejection(recentBars, direction, profile) {
  const topZones = profile.zones.slice(0, TOP_ZONES)
  if (topZones.length === 0) return null
  for (const bar of recentBars) {
    const touchPrice = direction === 'short' ? bar.high : bar.low
    const zone = topZones.find((z) => priceInZone(touchPrice, z))
    if (!zone) continue
    const closedBackOut = direction === 'short' ? bar.close < zone.bucketStart : bar.close >= zone.bucketEnd
    if (closedBackOut) return { touchPrice, zone, closedBackOut: true }
  }
  return null
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

  let usableCount = 0
  let insideTop5mCount = 0
  let insideTop15mCount = 0
  let insideEitherCount = 0
  let rejection5mCount = 0
  let rejection15mCount = 0

  for (const trade of trades) {
    try {
      const entryInstant = wallClockToInstant(trade.trade_date, trade.trade_time, offsetHours)
      const fetchStart = new Date(entryInstant.getTime() - FETCH_LOOKBACK_HOURS * 3600000)
      const oneMinBars = await fetchOhlcv1m(instrument.symbol, fetchStart, entryInstant)

      if (oneMinBars.length === 0) {
        log(`Trade ${trade.id} (${trade.trade_date}): no bars returned - skipping (embargo, holiday, or gap).`)
        continue
      }

      const bars5m = aggregateBars(oneMinBars, PROFILE_5M.intervalMinutes).slice(-PROFILE_5M.lookbackBars)
      const bars15m = aggregateBars(oneMinBars, PROFILE_15M.intervalMinutes).slice(-PROFILE_15M.lookbackBars)
      const profile5m = volumeProfile(bars5m, PROFILE_ROWS)
      const profile15m = volumeProfile(bars15m, PROFILE_ROWS)

      const preEntryBars = oneMinBars.filter((b) => Number(BigInt(b.tsEvent) / 1000000000n) >= entryInstant.getTime() / 1000 - PRE_ENTRY_WINDOW_MINUTES * 60)
      const recentBars = oneMinBars.filter((b) => Number(BigInt(b.tsEvent) / 1000000000n) >= entryInstant.getTime() / 1000 - REJECTION_LOOKBACK_MINUTES * 60)

      const inside5m = entryInsideTopZones(trade.entry, profile5m)
      const inside15m = entryInsideTopZones(trade.entry, profile15m)
      const rejection5m = findRejection(recentBars, trade.direction, profile5m)
      const rejection15m = findRejection(recentBars, trade.direction, profile15m)

      usableCount++
      if (inside5m) insideTop5mCount++
      if (inside15m) insideTop15mCount++
      if (inside5m || inside15m) insideEitherCount++
      if (rejection5m) rejection5mCount++
      if (rejection15m) rejection15mCount++

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
        profile5m: {
          barsUsed: profile5m.barsUsed,
          bucketSize: profile5m.bucketSize,
          poc: profile5m.poc,
          topZones: profile5m.zones.slice(0, TOP_ZONES),
          entryInsideTopZones: inside5m,
          distanceToPoc: distanceToPoc(trade.entry, profile5m),
          rejection: rejection5m,
        },
        profile15m: {
          barsUsed: profile15m.barsUsed,
          bucketSize: profile15m.bucketSize,
          poc: profile15m.poc,
          topZones: profile15m.zones.slice(0, TOP_ZONES),
          entryInsideTopZones: inside15m,
          distanceToPoc: distanceToPoc(trade.entry, profile15m),
          rejection: rejection15m,
        },
        preEntryWindowMinutes: PRE_ENTRY_WINDOW_MINUTES,
        preEntryWindowHigh: preEntryBars.length ? Math.max(...preEntryBars.map((b) => b.high)) : null,
        preEntryWindowLow: preEntryBars.length ? Math.min(...preEntryBars.map((b) => b.low)) : null,
        preEntryAtr14: averageTrueRange(preEntryBars.slice(-15)),
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
    insideTop5mCount,
    insideTop15mCount,
    insideEitherCount,
    rejection5mCount,
    rejection15mCount,
    profileRows: PROFILE_ROWS,
    topZones: TOP_ZONES,
    profile5m: PROFILE_5M,
    profile15m: PROFILE_15M,
  }))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
