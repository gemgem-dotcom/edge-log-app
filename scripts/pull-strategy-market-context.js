#!/usr/bin/env node

// Diagnostic / research script - NOT part of the app's runtime, NOT
// scheduled. Run manually via the "Run a diagnostic script" GitHub Action.
//
// Pulls every trade logged under one strategy (STRATEGY_NAME, scoped to one
// instrument's INSTRUMENT_SYMBOL) and, for each, checks it against the
// trader's own described mechanism for this setup (see "Third pass" below):
// after the 9:30am NY open, price makes an impulse move; if that move
// reaches the rolling 15-minute volume profile's point-of-control (POC),
// the trader scales down to the rolling 5-minute profile and looks for a
// rejection at ITS POC. A same-direction gap through the 15m POC right at
// the open is read as extra confirmation when the 5m POC sits on the same
// side the gap implies.
//
// Both profiles (5m over a rolling 270-bar lookback, 15m over a rolling
// 240-bar lookback - the trader's own parameters) are built by aggregating
// real Databento ohlcv-1m bars, since this dataset has no native 5m/15m
// schema of its own.
//
// This is a data-gathering step, not a finished indicator: it prints one
// JSON object per trade (prefixed TRADE_CONTEXT:) plus a closing SUMMARY:
// line, meant to be read from the workflow's job log and analyzed from
// there - it does not write anything back to Supabase or anywhere else.
// It deliberately reports the raw ingredients (which side of the 15m POC
// price sat on at 9:29/9:30, whether the impulse actually reached the 15m
// POC, where the 5m POC sits relative to the 15m POC, whether price
// rejected at the 5m POC) rather than asserting its own verdict on
// whether a trade "matches the rule" - that interpretation belongs in the
// analysis pass reading the job log, not baked into the script.
//
// Third pass: the first version (PR #177) guessed "HVZ" meant the busiest
// price zone of the single prior CME session - about half the trades
// matched, a coin flip. The second version (PR #179) used the trader's
// real 5m/270-bar and 15m/240-bar volume profiles, but tested "did entry
// sit near ANY of a profile's top-3 zones" and "did price wick into ANY of
// them and close back out" - both fired on nearly every trade (wins and
// losses alike, at the same rate), so neither actually discriminated
// anything. The trader then explained the real mechanism (see the top of
// this comment): it's specifically about the 15m POC and 5m POC in
// sequence after the 9:30 open, not "near a high-volume zone" in general.
// This version replaces the generic top-3-zone checks with that specific,
// ordered mechanism.
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
// How far back from entry (in raw 1-minute bars) to look for a wick into
// the 5m POC that closed back out before entry - the "rejection" motion.
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
// wallClockToInstant. The trader's saved offset for this dataset is a
// fixed -4h, which is EDT year-round for every trade date here (all within
// the March-November 2026 DST window), so this doubles as ET wall-clock
// math for the 9:29/9:30 open checks below without needing a separate,
// DST-aware ET conversion.
function wallClockToInstant(dateStr, timeStr, offsetHours) {
  const [y, mo, d] = dateStr.split('-').map(Number)
  const [hh, mm, ss] = timeStr.split(':').map(Number)
  return new Date(Date.UTC(y, mo - 1, d, hh, mm, ss || 0) - offsetHours * 3600000)
}

function barEpochSeconds(bar) {
  return Number(BigInt(bar.tsEvent) / 1000000000n)
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
// 1s/1m/1h/1d, no 5m/15m of their own, so both profiles below are built by
// aggregating 1-minute bars up rather than requesting a schema that
// doesn't exist. One fetch per trade covers both profile lookbacks and the
// shorter pre-entry/opening-range reads.
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

// ---------- volume profile ----------

// Groups consecutive 1-minute bars into `intervalMinutes` bars, keyed by
// each bar's own minute-of-epoch. Only ever produces a bar for a span that
// actually has 1-minute data in it, so a maintenance-break or weekend gap
// just contributes no bar rather than a hole to fill - the same "rolling N
// *real* bars back" behavior a charting platform's own volume profile
// study would show.
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
// midpoint is the standard approximation here).
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

// Did price wick into `zone` in the minutes before entry, then close back
// outside it in the trade's own direction? For a short, "into the zone"
// means price ran UP into it (the zone capped the rally, i.e. resistance);
// for a long, price ran DOWN into it (the zone held as support). This is
// the actual mechanical signature "rejection" implies.
function findRejectionAtZone(recentBars, direction, zone) {
  if (!zone) return null
  for (const bar of recentBars) {
    const touchPrice = direction === 'short' ? bar.high : bar.low
    if (!priceInZone(touchPrice, zone)) continue
    const closedBackOut = direction === 'short' ? bar.close < zone.bucketStart : bar.close >= zone.bucketEnd
    if (closedBackOut) return { touchPrice, zone, closedBackOut: true }
  }
  return null
}

// ---------- opening-range mechanism ----------
// See header comment for the trader's own description of this sequence.

function sideOfPoc(price, poc) {
  if (price === null || !poc) return null
  const center = zoneCenter(poc)
  if (price > center) return 'above'
  if (price < center) return 'below'
  return 'equal'
}

// Last close at or before `instant` - "where was price sitting" at a given
// clock time, read from real prints rather than assuming a bar landed
// exactly on that minute.
function lastCloseAtOrBefore(bars, instant) {
  const cutoff = instant.getTime() / 1000
  let best = null
  for (const bar of bars) {
    const t = barEpochSeconds(bar)
    if (t <= cutoff && (best === null || t > barEpochSeconds(best))) best = bar
  }
  return best ? best.close : null
}

function buildOpeningRangeContext({ oneMinBars, trade, offsetHours, profile5m, profile15m, recentBars }) {
  const open930 = wallClockToInstant(trade.trade_date, '09:30:00', offsetHours)
  const pre929 = wallClockToInstant(trade.trade_date, '09:29:00', offsetHours)
  const entryInstant = wallClockToInstant(trade.trade_date, trade.trade_time, offsetHours)

  const priceAt929 = lastCloseAtOrBefore(oneMinBars, pre929)
  const priceAtOpen930 = lastCloseAtOrBefore(oneMinBars, open930) ?? lastCloseAtOrBefore(oneMinBars, entryInstant)

  const sinceOpenBars = oneMinBars.filter((b) => {
    const t = barEpochSeconds(b)
    return t >= open930.getTime() / 1000 && t <= entryInstant.getTime() / 1000
  })
  const impulseHigh = sinceOpenBars.length ? Math.max(...sinceOpenBars.map((b) => b.high)) : null
  const impulseLow = sinceOpenBars.length ? Math.min(...sinceOpenBars.map((b) => b.low)) : null

  const side929 = sideOfPoc(priceAt929, profile15m.poc)
  const sideOpen930 = sideOfPoc(priceAtOpen930, profile15m.poc)
  const gappedThroughPoc15 = !!(side929 && sideOpen930 && side929 !== sideOpen930)

  const reachedInto15PocZone = !!(profile15m.poc && impulseHigh !== null && impulseLow !== null &&
    impulseLow <= profile15m.poc.bucketEnd && impulseHigh >= profile15m.poc.bucketStart)

  const poc5RelativeToPoc15 = profile5m.poc && profile15m.poc
    ? (zoneCenter(profile5m.poc) > zoneCenter(profile15m.poc) ? 'above' : zoneCenter(profile5m.poc) < zoneCenter(profile15m.poc) ? 'below' : 'equal')
    : null

  const rejectionAtPoc5 = findRejectionAtZone(recentBars, trade.direction, profile5m.poc)

  // Two distinct cases, per the trader's own description - NOT one rule
  // extended to cover both:
  //
  // 1. Gap through the 15m POC at the open (side929 !== sideOpen930): the
  //    trader's own worked example keys the bias directly off where the 5m
  //    POC now sits relative to the 15m POC - 5m POC below the 15m POC
  //    means shorts, above means longs. This is NOT "fade the side price
  //    landed on" - it's read straight from the two POCs' relative
  //    position, which can in principle disagree with a naive fade (a
  //    first pass here conflated the two and got this case wrong on a
  //    synthetic no-gap test before this was caught).
  // 2. No gap, impulse simply reaches into the 15m POC zone: read as a
  //    fade - price approached from sideOpen930, so a rejection at the
  //    POC sends it back the way it came (short if approaching from
  //    below, long if approaching from above).
  const biasDirection = gappedThroughPoc15 && poc5RelativeToPoc15
    ? (poc5RelativeToPoc15 === 'below' ? 'short' : poc5RelativeToPoc15 === 'above' ? 'long' : null)
    : reachedInto15PocZone && sideOpen930
      ? (sideOpen930 === 'below' ? 'short' : sideOpen930 === 'above' ? 'long' : null)
      : null
  // Whether the two independent reads agree - only meaningful once there's
  // both a gap (so poc5RelativeToPoc15 drove biasDirection above) and a
  // confirmed side to fade against. Purely informational: it isn't used to
  // gate biasDirection itself, since the trader's own example treats the
  // 5m-POC read as sufficient on its own in the gap case.
  const confluenceMatches = gappedThroughPoc15 && sideOpen930 && poc5RelativeToPoc15
    ? poc5RelativeToPoc15 === (sideOpen930 === 'below' ? 'below' : 'above')
    : null

  return {
    priceAt929,
    priceAtOpen930,
    impulseHigh,
    impulseLow,
    sideAt929RelativeToPoc15: side929,
    sideAtOpen930RelativeToPoc15: sideOpen930,
    gappedThroughPoc15,
    reachedInto15PocZone,
    poc5RelativeToPoc15,
    distanceEntryToPoc5: distanceToPoc(trade.entry, profile5m),
    rejectionAtPoc5,
    biasDirection,
    biasDirectionMatchesTradeDirection: biasDirection ? biasDirection === trade.direction : null,
    confluenceMatches,
  }
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
  let reachedInto15PocCount = 0
  let gappedThroughPoc15Count = 0
  let rejectionAtPoc5Count = 0
  let biasComputableCount = 0
  let biasMatchesCount = 0

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

      const preEntryBars = oneMinBars.filter((b) => barEpochSeconds(b) >= entryInstant.getTime() / 1000 - PRE_ENTRY_WINDOW_MINUTES * 60)
      const recentBars = oneMinBars.filter((b) => barEpochSeconds(b) >= entryInstant.getTime() / 1000 - REJECTION_LOOKBACK_MINUTES * 60)

      const openingRange = buildOpeningRangeContext({ oneMinBars, trade, offsetHours, profile5m, profile15m, recentBars })

      usableCount++
      if (openingRange.reachedInto15PocZone) reachedInto15PocCount++
      if (openingRange.gappedThroughPoc15) gappedThroughPoc15Count++
      if (openingRange.rejectionAtPoc5) rejectionAtPoc5Count++
      if (openingRange.biasDirection) {
        biasComputableCount++
        if (openingRange.biasDirectionMatchesTradeDirection) biasMatchesCount++
      }

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
        profile5mPoc: profile5m.poc,
        profile15mPoc: profile15m.poc,
        openingRange,
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
    reachedInto15PocCount,
    gappedThroughPoc15Count,
    rejectionAtPoc5Count,
    biasComputableCount,
    biasMatchesCount,
    profileRows: PROFILE_ROWS,
    profile5m: PROFILE_5M,
    profile15m: PROFILE_15M,
  }))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
