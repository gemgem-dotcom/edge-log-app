#!/usr/bin/env node

// Diagnostic / research script - NOT part of the app's runtime, NOT
// scheduled. Run manually via the "Run a diagnostic script" GitHub Action.
//
// pull-strategy-market-context.js answers "what did the market look like
// on the days a trade was actually logged". This answers the harder,
// more useful question: across every trading day in a date range, when
// does the same mechanical setup (impulse reaches the rolling 15m
// volume-profile POC, then a rejection at the rolling 5m POC, within 90
// minutes of the 9:30 NY open) actually occur - and of those occurrences,
// which ones turned into a logged trade and which didn't. Without this,
// any attempt to say "here's what makes a winner" is working from a
// dataset that's already been filtered by the trader's own (so far
// uncaptured) judgment call on which touches to take - comparing 21 wins
// against 3 losses can't reveal that judgment call, because every one of
// those 24 rows already passed it.
//
// Uses the exact same profile math, rejection check, and rollover
// handling as pull-strategy-market-context.js (duplicated rather than
// shared - this repo has no "type": "module", so ESM export/import isn't
// reliably loadable from a plain `node scripts/...` invocation, the same
// reason every other Databento helper in these scripts is its own copy).
// Any fix made to one script's copy of this logic (see that file's own
// "Fourth pass" and roll-window history) should be mirrored here too.
//
// For each trading day in the scan window: walks 1-minute bars from 9:30
// through 11:00, tracking the running impulse high/low and, on EVERY bar,
// recomputing both profile5m and profile15m from bars up to that exact
// minute - the trader confirmed their real indicator recomputes every
// minute too, not once at the open. (A first version of this script
// snapshotted the profile once at 9:30 and held it static for the whole
// 90-minute window to save recomputation - it missed 9 of the 24 logged
// trades entirely, because a touch late in the window can easily
// reference a POC that's shifted since 9:30. Recomputing costs no extra
// Databento usage - the bars are already fetched - just more CPU, which
// is trivial for an in-memory array pass.) Checks both directions for a
// rejection at that minute's 5m POC once the impulse has reached that
// minute's 15m POC zone. Records EVERY qualifying touch of the day (a
// whipsaw day can trigger several) and whether each touch's date/time
// lines up with an actual logged trade - not just the first touch. An
// earlier version only recorded/matched the first touch of the day on the
// theory that's what a trader scanning live would see first, but that
// missed real matches: a trade can legitimately be taken on the 2nd or 3rd
// touch of the day (the trader passing on an earlier one), and checking
// only the first touch undercounted matchedCount and hid those trades from
// the candidate dataset entirely.
//
// Prints one JSON line per scanned day (prefixed DAY_CONTEXT:) plus a
// closing SUMMARY: line - reads from the job log, writes nothing back to
// Supabase or anywhere else.
//
// Usage: node scripts/scan-strategy-setup-days.js
// Env: DATABENTO_API_KEY, SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL,
//      STRATEGY_NAME, INSTRUMENT_SYMBOL, USER_EMAIL, SCAN_START_DATE, SCAN_END_DATE

const { createClient } = require('@supabase/supabase-js')
const CME_HOLIDAYS = require('../lib/cmeHolidays.json')

const DATASET = 'GLBX.MDP3'
const PRICE_SCALE = 1e9
const BASE_URL = 'https://hist.databento.com'

const PROFILE_5M = { intervalMinutes: 5, lookbackBars: 270 }
const PROFILE_15M = { intervalMinutes: 15, lookbackBars: 240 }
const PROFILE_ROWS = 25
const FETCH_LOOKBACK_HOURS = 120
const SCAN_WINDOW_MINUTES = 90
// How far forward from a candidate touch to measure MFE/MAE - a rough,
// direction-aware "did price actually move favorably after this" proxy,
// since there's no codified stop-placement rule yet to simulate a real R.
const FORWARD_WINDOW_MINUTES = 60
// A logged trade counts as "matching" a candidate touch when it's the
// same calendar date and its trade_time sits within this many minutes of
// the touch - loose enough to survive a few minutes of manual entry lag,
// tight enough that two different touches on the same day won't both
// claim the same trade.
const TRADE_MATCH_TOLERANCE_MINUTES = 5

const ROLL_PROXIMITY_DAYS = 10
const NQ_ROLLOVER_DATES = require('../lib/contractRollover.json').NQ.map((d) => new Date(`${d}T00:00:00Z`))
function isNearRollover(tradeDateStr) {
  const tradeDate = new Date(`${tradeDateStr}T00:00:00Z`)
  return NQ_ROLLOVER_DATES.some((rollDate) => Math.abs(rollDate.getTime() - tradeDate.getTime()) / 86400000 <= ROLL_PROXIMITY_DAYS)
}

function log(...args) {
  console.error(new Date().toISOString(), ...args)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function wallClockToInstant(dateStr, timeStr, offsetHours) {
  const [y, mo, d] = dateStr.split('-').map(Number)
  const [hh, mm, ss] = timeStr.split(':').map(Number)
  return new Date(Date.UTC(y, mo - 1, d, hh, mm, ss || 0) - offsetHours * 3600000)
}

function barEpochSeconds(bar) {
  return Number(BigInt(bar.tsEvent) / 1000000000n)
}

function addDaysToDateStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

// Weekday in the same "wall-clock the trader logs in" sense as
// wallClockToInstant uses elsewhere - close enough for a trading-day gate
// since this offset is a fixed -4h (EDT) across the whole scan window.
function isWeekday(dateStr) {
  const day = new Date(`${dateStr}T12:00:00Z`).getUTCDay()
  return day >= 1 && day <= 5
}

function isTradingDay(dateStr) {
  if (!isWeekday(dateStr)) return false
  return CME_HOLIDAYS[dateStr]?.type !== 'closed'
}

// ---------- Databento (see pull-strategy-market-context.js's own copy) ----------

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
    if (vol > bestVolume) { bestVolume = vol; bestId = id }
  }
  return bestId
}

const ROLLOVER_RESOLUTION_WINDOW_HOURS = 6
async function fetchOhlcv1m(symbol, start, end, { nearRollover } = {}) {
  if (!nearRollover) return fetchOhlcv1mRaw(`${symbol}.c.0`, 'continuous', start, end)
  const resolutionStart = new Date(end.getTime() - ROLLOVER_RESOLUTION_WINDOW_HOURS * 3600000)
  const instrumentId = await resolveFrontMonthInstrumentId(symbol, resolutionStart, end)
  if (instrumentId === null) return fetchOhlcv1mRaw(`${symbol}.c.0`, 'continuous', start, end)
  return fetchOhlcv1mRaw(String(instrumentId), 'instrument_id', start, end)
}

// ---------- volume profile (see pull-strategy-market-context.js's own copy) ----------

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

function volumeProfile(bars, rows) {
  if (bars.length === 0) return { poc: null, zones: [], bucketSize: null, barsUsed: 0 }
  const high = Math.max(...bars.map((b) => b.high))
  const low = Math.min(...bars.map((b) => b.low))
  const step = (high - low) / rows || 1
  const rowTotals = new Array(rows).fill(0)

  for (const bar of bars) {
    const barRange = bar.high - bar.low
    for (let l = 0; l < rows; l++) {
      const rowLow = low + l * step
      const rowHigh = rowLow + step
      if (bar.high < rowLow || bar.low >= rowHigh) continue
      let vPOR
      if (barRange <= 0) vPOR = 1
      else if (bar.low >= rowLow && bar.high > rowHigh) vPOR = (rowHigh - bar.low) / barRange
      else if (bar.high <= rowHigh && bar.low < rowLow) vPOR = (bar.high - rowLow) / barRange
      else if (bar.low >= rowLow && bar.high <= rowHigh) vPOR = 1
      else vPOR = step / barRange
      const rowCenter = rowLow + step / 2
      rowTotals[l] += bar.volume * vPOR * rowCenter
    }
  }

  const zones = rowTotals
    .map((moneyFlow, l) => ({ bucketStart: low + l * step, bucketEnd: low + (l + 1) * step, moneyFlow }))
    .sort((a, b) => b.moneyFlow - a.moneyFlow)
  return { poc: zones[0] || null, zones, bucketSize: step, barsUsed: bars.length }
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

function tpNodeBoundary(profile5m, entry, direction) {
  const zones = profile5m.zones
  if (!zones || zones.length === 0) return null
  const totalFlow = zones.reduce((sum, z) => sum + z.moneyFlow, 0)
  if (!totalFlow) return null
  const byPrice = [...zones].sort((a, b) => a.bucketStart - b.bucketStart)
  let entryIdx = byPrice.findIndex((z) => entry >= z.bucketStart && entry < z.bucketEnd)
  if (entryIdx === -1) entryIdx = entry < byPrice[0].bucketStart ? -1 : byPrice.length
  const step = direction === 'long' ? 1 : -1
  for (let i = entryIdx + step; i >= 0 && i < byPrice.length; i += step) {
    if (byPrice[i].moneyFlow / totalFlow >= 0.01) continue
    const prior = byPrice[i - step]
    if (!prior) return null
    return zoneCenter(prior)
  }
  return null
}

// ---------- setup detection ----------

// Did `bar` show a rejection at `zone` in `direction`? Same wick-in/close-
// back-out signature pull-strategy-market-context.js's findRejectionAtZone
// checks, factored to test one bar at a time since this script walks
// forward bar-by-bar rather than scanning a fixed lookback window.
function barRejectsAtZone(bar, direction, zone) {
  if (!zone) return false
  const touchPrice = direction === 'short' ? bar.high : bar.low
  if (!priceInZone(touchPrice, zone)) return false
  return direction === 'short' ? bar.close < zone.bucketStart : bar.close >= zone.bucketEnd
}

function forwardExcursion(barsAfterTouch, direction, touchPrice) {
  if (barsAfterTouch.length === 0) return { mfe: null, mae: null }
  const highs = barsAfterTouch.map((b) => b.high)
  const lows = barsAfterTouch.map((b) => b.low)
  if (direction === 'long') {
    return { mfe: Math.max(...highs) - touchPrice, mae: touchPrice - Math.min(...lows) }
  }
  return { mfe: touchPrice - Math.min(...lows), mae: Math.max(...highs) - touchPrice }
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

function findMatchingTrade(trades, dateStr, touchInstant, offsetHours, direction) {
  // Direction must match too, not just date/time proximity - without this,
  // two candidates a few minutes apart in OPPOSITE directions (a real
  // whipsaw: price rejects long, then rejects short minutes later) can
  // both fall inside TRADE_MATCH_TOLERANCE_MINUTES of the same logged
  // trade and both get reported as "matched", even though only one of
  // them is actually the setup the trader took. Caught by cross-checking
  // 2026-06-16 against its screenshot: the trade was logged short, but a
  // long-direction candidate 4 minutes earlier was also matching it.
  const candidates = trades.filter((t) => t.trade_date === dateStr && t.direction === direction)
  if (candidates.length === 0) return null
  const touchMinutes = touchInstant.getTime()
  let best = null
  let bestDiff = Infinity
  for (const t of candidates) {
    const tradeInstant = wallClockToInstant(t.trade_date, t.trade_time, offsetHours)
    const diffMinutes = Math.abs(tradeInstant.getTime() - touchMinutes) / 60000
    if (diffMinutes <= TRADE_MATCH_TOLERANCE_MINUTES && diffMinutes < bestDiff) {
      best = t
      bestDiff = diffMinutes
    }
  }
  return best
}

async function main() {
  const strategyName = process.env.STRATEGY_NAME || 'HVZ rejection'
  const instrumentSymbol = process.env.INSTRUMENT_SYMBOL || 'NQ'
  const userEmail = process.env.USER_EMAIL
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const scanStart = process.env.SCAN_START_DATE
  const scanEnd = process.env.SCAN_END_DATE
  if (!supabaseUrl || !serviceKey) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set')
  if (!userEmail) throw new Error('USER_EMAIL is not set')
  if (!scanStart || !scanEnd) throw new Error('SCAN_START_DATE / SCAN_END_DATE are not set (YYYY-MM-DD)')

  const admin = createClient(supabaseUrl, serviceKey)

  const user = await findUserIdByEmail(admin, userEmail)
  if (!user) throw new Error(`No user found for email ${userEmail}`)
  const offsetHours = Number(user.user_metadata?.timezone ?? 0)
  log(`User ${userEmail} -> ${user.id}, saved UTC offset ${offsetHours}h`)

  const { data: instrument, error: instrumentError } = await admin
    .from('instruments').select('id, symbol').eq('user_id', user.id).eq('symbol', instrumentSymbol).maybeSingle()
  if (instrumentError) throw instrumentError
  if (!instrument) throw new Error(`No instrument ${instrumentSymbol} for this user`)

  const { data: strategy, error: strategyError } = await admin
    .from('strategies').select('id, name').eq('instrument_id', instrument.id).eq('name', strategyName).maybeSingle()
  if (strategyError) throw strategyError
  if (!strategy) throw new Error(`No strategy "${strategyName}" for ${instrumentSymbol}`)

  const { data: trades, error: tradesError } = await admin
    .from('trades')
    .select('id, trade_date, trade_time, direction, r_multiple')
    .eq('strategy_id', strategy.id)
  if (tradesError) throw tradesError
  log(`${trades?.length ?? 0} logged trade(s) under "${strategyName}" (${instrumentSymbol}) to match candidates against.`)

  const days = []
  for (let d = scanStart; d <= scanEnd; d = addDaysToDateStr(d, 1)) {
    if (isTradingDay(d)) days.push(d)
  }
  log(`Scanning ${days.length} trading day(s) from ${scanStart} to ${scanEnd}...`)

  let daysWithCandidate = 0
  let matchedCount = 0
  let unmatchedCount = 0

  for (const dateStr of days) {
    try {
      const open930 = wallClockToInstant(dateStr, '09:30:00', offsetHours)
      const scanWindowEnd = new Date(open930.getTime() + SCAN_WINDOW_MINUTES * 60000)
      const fetchStart = new Date(open930.getTime() - FETCH_LOOKBACK_HOURS * 3600000)
      const fetchEnd = new Date(scanWindowEnd.getTime() + FORWARD_WINDOW_MINUTES * 60000)
      const nearRollover = isNearRollover(dateStr)

      const oneMinBars = await fetchOhlcv1m(instrument.symbol, fetchStart, fetchEnd, { nearRollover })
      if (oneMinBars.length === 0) {
        log(`${dateStr}: no bars returned - skipping (embargo, holiday, or gap).`)
        continue
      }

      const scanBars = oneMinBars.filter((b) => {
        const t = barEpochSeconds(b)
        return t >= open930.getTime() / 1000 && t <= scanWindowEnd.getTime() / 1000
      })
      if (scanBars.length === 0) {
        log(`${dateStr}: no bars in the scan window - skipping.`)
        continue
      }

      let impulseHigh = null
      let impulseLow = null
      const foundCandidates = []

      // Recomputed on every bar, not once at 9:30 and held static - the
      // trader confirmed their real indicator recomputes every minute, and
      // a first version of this script that snapshotted the profile once
      // at market open missed 9 of the 24 logged trades entirely (a touch
      // late in the 90-minute window can easily reference a POC that's
      // shifted since 9:30). barsUpToNow only ever grows as bar advances,
      // so this still costs one pass over already-fetched in-memory bars
      // per minute - no extra Databento usage, just more CPU (trivial: a
      // handful of array operations per minute, not another network call).
      for (const bar of scanBars) {
        impulseHigh = impulseHigh === null ? bar.high : Math.max(impulseHigh, bar.high)
        impulseLow = impulseLow === null ? bar.low : Math.min(impulseLow, bar.low)

        const barsUpToNow = oneMinBars.filter((b) => barEpochSeconds(b) <= barEpochSeconds(bar))
        const bars5m = aggregateBars(barsUpToNow, PROFILE_5M.intervalMinutes).slice(-PROFILE_5M.lookbackBars)
        const bars15m = aggregateBars(barsUpToNow, PROFILE_15M.intervalMinutes).slice(-PROFILE_15M.lookbackBars)
        const profile5m = volumeProfile(bars5m, PROFILE_ROWS)
        const profile15m = volumeProfile(bars15m, PROFILE_ROWS)

        const reachedInto15PocZone = !!(profile15m.poc && impulseLow <= profile15m.poc.bucketEnd && impulseHigh >= profile15m.poc.bucketStart)
        if (!reachedInto15PocZone || !profile5m.poc) continue

        const longSignal = barRejectsAtZone(bar, 'long', profile5m.poc)
        const shortSignal = barRejectsAtZone(bar, 'short', profile5m.poc)
        if (!longSignal && !shortSignal) continue

        const direction = longSignal ? 'long' : 'short'
        const touchPrice = direction === 'long' ? bar.low : bar.high
        const touchInstant = new Date(barEpochSeconds(bar) * 1000)
        const barsAfter = oneMinBars.filter((b) => {
          const t = barEpochSeconds(b)
          return t > barEpochSeconds(bar) && t <= barEpochSeconds(bar) + FORWARD_WINDOW_MINUTES * 60
        })
        const { mfe, mae } = forwardExcursion(barsAfter, direction, touchPrice)
        const matchedTrade = findMatchingTrade(trades || [], dateStr, touchInstant, offsetHours, direction)

        foundCandidates.push({
          time: touchInstant.toISOString(),
          direction,
          touchPrice,
          distanceToPoc5m: distanceToPoc(touchPrice, profile5m),
          distanceToPoc15m: distanceToPoc(touchPrice, profile15m),
          tpNodeBoundary: tpNodeBoundary(profile5m, touchPrice, direction),
          forwardMfePoints: mfe,
          forwardMaePoints: mae,
          matchedTrade: matchedTrade ? { tradeId: matchedTrade.id, tradeTime: matchedTrade.trade_time, direction: matchedTrade.direction, rMultiple: matchedTrade.r_multiple } : null,
        })
      }

      // Every candidate in the day is checked against the trade log, not
      // just the first - a trade taken on the 2nd or 3rd touch of the day
      // (a real, common case: the trader passing on an earlier touch and
      // taking a later one) was previously invisible to matchedCount/
      // unmatchedCount and to the printed line, since only foundCandidates[0]
      // was ever inspected. That undercounted real matches: cross-checking
      // the 9 trades the static-snapshot version of this script missed
      // entirely showed 3 of them (2026-05-20, 08-14, 08-21) landing on a
      // later touch of a day that did have candidates, not the first one.
      if (foundCandidates.length > 0) {
        daysWithCandidate++
        for (const c of foundCandidates) {
          if (c.matchedTrade) matchedCount++
          else unmatchedCount++
        }
      }

      console.log('DAY_CONTEXT:' + JSON.stringify({
        date: dateStr,
        candidateCount: foundCandidates.length,
        candidates: foundCandidates,
      }))
    } catch (err) {
      log(`${dateStr} failed: ${err.message}`)
    }

    await sleep(200)
  }

  console.log('SUMMARY:' + JSON.stringify({
    strategyName,
    instrumentSymbol,
    scanStart,
    scanEnd,
    tradingDaysScanned: days.length,
    daysWithCandidate,
    matchedCount,
    unmatchedCount,
  }))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
