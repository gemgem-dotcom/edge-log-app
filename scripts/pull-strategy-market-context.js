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
// Fourth pass: comparing this script's computed POCs against the real "5
// POC"/"15 POC" price labels the trader had drawn on their own trade
// screenshots (a LuxAlgo "Delta Flow Profile" indicator, source shared)
// showed a real gap - e.g. one trade's real 5m POC sat around 29,748-851,
// this script's approximation landed near 29,740, close enough to look
// plausible but not the same level. Root cause: volumeProfile below used
// to dump each bar's whole volume onto its own midpoint price - the real
// indicator splits a bar's volume across every row its high-low range
// actually spans, and weights each row by its own center price ("money
// flow", not raw volume). volumeProfile now mirrors that math directly.
// Every entry price checked against a screenshot's real POC label landed
// within a few points of it (often exact to the cent) - so the entry rule
// really is "enter at the 5m POC", precisely, and this rewrite is what it
// takes to reproduce that number from raw bars instead of reading it off
// a chart. Also adds the trader's own take-profit rule (see
// tpNodeBoundary below), not previously modeled at all.
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
// range - the trader's own LuxAlgo Delta Flow Profile setting (Number of
// Rows), not a guess.
const PROFILE_ROWS = 25
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
// Comma-separated trade_date list (DEBUG_TRADE_DATES env var) - trades in
// this list get their full 5m profile (all 25 rows, sorted by price, with
// each row's %-of-peak) printed alongside the usual summary fields. Off by
// default: 24 trades' worth of full 25-row profiles would roughly double
// this script's already-large log output for no benefit on a normal run -
// only worth paying for when actually debugging tpNodeBoundary against a
// specific trade's real chart.
const DEBUG_TRADE_DATES = (process.env.DEBUG_TRADE_DATES || '').split(',').map((s) => s.trim()).filter(Boolean)

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
    // This was missing entirely until now - the actual reason the roll-
    // window fix (PR #183/#184) never changed a single trade's numbers
    // despite firing and despite narrowing its resolution window: without
    // instrumentId captured here, resolveFrontMonthInstrumentId's `r.
    // instrumentId === undefined` check skipped every record it ever saw,
    // volumeByInstrument stayed empty, and it silently returned null every
    // single time - falling back to the exact same continuous-symbol fetch
    // regardless of any other change made around it. lib/databento.js's own
    // normalizeRecord already captures this; this file's separate copy
    // (duplicated for the ESM reason this file's header explains) simply
    // never did. hd.instrument_id - an OHLCV record has no `symbol` field
    // of its own, only this raw numeric id.
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

// ohlcv-1m only - Databento's fixed-interval schemas for this dataset are
// 1s/1m/1h/1d, no 5m/15m of their own, so both profiles below are built by
// aggregating 1-minute bars up rather than requesting a schema that
// doesn't exist.
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

// lib/databento.js's own NQ_CONTINUOUS_SYMBOL comment (this repo's already-
// established, live-confirmed finding, PR #122): NQ.c.0's continuous-roll
// resolution disagrees with which contract is actually trading the volume
// within ROLL_PROXIMITY_DAYS of a quarterly roll - real volume can move to
// the next contract several days before Databento's own roll rule catches
// up. This script originally always used the plain continuous symbol,
// which is exactly why two trades landing in that window (2026-06-16,
// 2026-06-18, against the 2026-06-19 NQ roll) came back with an entry
// price far outside the fetched bars' own high/low range - not a logging
// error, a wrong-contract fetch. Below mirrors lib/databento.js's
// resolveFrontMonthByVolume/isNearRollover instead of importing them (this
// repo has no "type": "module", so their ESM export/import isn't reliably
// loadable from a plain `node scripts/...` invocation - the same reason
// this whole file already duplicates other Databento/date logic).
// Bug fixed here (see 2026-06-16/2026-06-18 still showing the exact same
// bad distances after the first version of this fallback shipped):
// resolveFrontMonthInstrumentId used to be asked "which contract traded
// the most volume across the WHOLE [start, end] fetch window" - up to 120
// hours (5 calendar days) per FETCH_LOOKBACK_HOURS. Near a roll, the
// outgoing contract can easily still hold the majority of volume summed
// across five whole days even after real trading has already shifted to
// the new front month for the specific session that matters (the one
// containing `end`, i.e. the trade's own entry) - so the "most volume
// overall" answer silently kept resolving to the same wrong contract
// continuous was already picking, and the fallback was a no-op in
// practice. Now resolves using only a narrow window immediately before
// `end` (this mirrors how lib/databento.js's own resolveFrontMonthByVolume
// is only ever called with one session's bounds, never a multi-day range),
// then fetches the FULL [start, end] lookback under that one resolved
// contract - a bounded approximation if the roll itself falls inside the
// lookback (older bars would come from a contract that may not have
// existed yet, likely returning fewer bars for that stretch rather than
// wrong-priced ones), but correct for the part that actually matters: the
// contract trading at and around entry.
const ROLLOVER_RESOLUTION_WINDOW_HOURS = 6

async function fetchOhlcv1m(symbol, start, end, { nearRollover } = {}) {
  if (!nearRollover) return fetchOhlcv1mRaw(`${symbol}.c.0`, 'continuous', start, end)

  const resolutionStart = new Date(end.getTime() - ROLLOVER_RESOLUTION_WINDOW_HOURS * 3600000)
  const instrumentId = await resolveFrontMonthInstrumentId(symbol, resolutionStart, end)
  if (instrumentId === null) return fetchOhlcv1mRaw(`${symbol}.c.0`, 'continuous', start, end)
  return fetchOhlcv1mRaw(String(instrumentId), 'instrument_id', start, end)
}

// Which contract actually traded the most volume across [start, end] -
// resolved through parent symbology (`${root}.FUT`) rather than the
// continuous `.c.0` shortcut, which is exactly the resolution ROLL_
// PROXIMITY_DAYS windows can't trust. Mirrors lib/databento.js's
// resolveFrontMonthByVolume. Returns a raw instrument_id (fetchOhlcv1mRaw
// takes it directly via stype_in: 'instrument_id'), or null if the fetch
// or aggregation comes up empty, so the caller falls back to the
// continuous symbol rather than fail outright.
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
    if (vol > bestVolume) {
      bestVolume = vol
      bestId = id
    }
  }
  return bestId
}

// Same ROLL_PROXIMITY_DAYS gate as lib/databento.js's isNearRollover, using
// this repo's real published NQ roll calendar (lib/contractRollover.json)
// rather than reimplementing the holiday-adjustment nuance that file's
// adjustForHolidays applies - a roll landing on a holiday shifts by at most
// a day or two, never enough to move a trade in or out of a +/-10-day
// window, so the unadjusted listed dates are close enough for this gate.
const ROLL_PROXIMITY_DAYS = 10
const NQ_ROLLOVER_DATES = require('../lib/contractRollover.json').NQ.map((d) => new Date(`${d}T00:00:00Z`))
function isNearRollover(tradeDateStr) {
  const tradeDate = new Date(`${tradeDateStr}T00:00:00Z`)
  return NQ_ROLLOVER_DATES.some((rollDate) => Math.abs(rollDate.getTime() - tradeDate.getTime()) / 86400000 <= ROLL_PROXIMITY_DAYS)
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
// spanning the bars' own high-low range - reimplemented to match the exact
// math of the real indicator the trader uses (LuxAlgo's "Delta Flow
// Profile", Money Flow Profile component - the trader shared its source).
// Two things this gets right that a naive "assign each bar's whole volume
// to its own midpoint" approximation (this function's first version)
// didn't, which is why that version's POC values didn't closely match the
// real indicator's on real trades:
//
// 1. A bar whose high-low range spans multiple rows has its volume split
//    across all of them, proportional to how much of the bar's own range
//    falls in each row (vPOR below) - not dumped entirely into one row.
// 2. Each row's accumulated volume is weighted by that row's own center
//    price before comparing rows (LuxAlgo calls this "money flow" - volume
//    times price, a dollar-turnover proxy) - not raw volume.
//
// Mirrors the source's own loop structure (rpVST.set(l, ... + nzV[bI] *
// vPOR * rowCenter)) directly rather than a from-scratch reimplementation,
// so a future discrepancy is easy to diff against the original.
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
      if (barRange <= 0) {
        vPOR = 1
      } else if (bar.low >= rowLow && bar.high > rowHigh) {
        vPOR = (rowHigh - bar.low) / barRange
      } else if (bar.high <= rowHigh && bar.low < rowLow) {
        vPOR = (bar.high - rowLow) / barRange
      } else if (bar.low >= rowLow && bar.high <= rowHigh) {
        vPOR = 1
      } else {
        vPOR = step / barRange
      }

      const rowCenter = rowLow + step / 2
      rowTotals[l] += bar.volume * vPOR * rowCenter
    }
  }

  const zones = rowTotals
    .map((moneyFlow, l) => ({ bucketStart: low + l * step, bucketEnd: low + (l + 1) * step, moneyFlow }))
    .sort((a, b) => b.moneyFlow - a.moneyFlow)
  return { poc: zones[0] || null, zones, bucketSize: step, barsUsed: bars.length }
}

// The trader's own take-profit rule, not entry: "I will not place a TP
// past halfway of the 5m node before a 5m node that has a value of <1%."
// Walks profile5m's rows outward from the row containing `entry`, in the
// trade's direction, until finding the first row whose money-flow is under
// 1% of the profile's TOTAL money flow - the point where real liquidity
// thins out. Returns the halfway price of the row just before that one
// (the trader's own stated TP ceiling/floor), or null if entry falls
// outside the profile's range or no sub-1% row is found within it.
//
// The percent basis matters and was wrong in the first version of this
// function: it compared each row against the profile's PEAK row (LpM in
// the source - vtLV / vtMX), which on real NQ data never drops anywhere
// near 1% across just 25 rows (the trader's own screenshot of the real
// indicator's row labels showed values like 0.42%, 0.79%, 1.92%, 3.03% -
// far too varied and far too low overall to be "% of peak"). The source's
// own row-label text confirms the real basis: `vtLV / rpVST.sum() * 100`
// - each row's share of the profile's TOTAL, not its peak. With 25 rows an
// even split already averages 4% each, so a real row legitimately landing
// under 1% of the total is common - unlike under 1% of the peak, which
// this script's corrected math essentially never produced.
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
  let tpRuleComputableCount = 0
  let tpWithinRuleCount = 0

  for (const trade of trades) {
    try {
      const entryInstant = wallClockToInstant(trade.trade_date, trade.trade_time, offsetHours)
      const fetchStart = new Date(entryInstant.getTime() - FETCH_LOOKBACK_HOURS * 3600000)
      const nearRollover = isNearRollover(trade.trade_date)
      if (nearRollover) log(`Trade ${trade.id} (${trade.trade_date}) is within ${ROLL_PROXIMITY_DAYS} days of an NQ roll - resolving front-month by volume instead of trusting the continuous symbol.`)
      const oneMinBars = await fetchOhlcv1m(instrument.symbol, fetchStart, entryInstant, { nearRollover })

      if (oneMinBars.length === 0) {
        log(`Trade ${trade.id} (${trade.trade_date}): no bars returned - skipping (embargo, holiday, or gap).`)
        continue
      }

      // The trader states every entry is the CENTRE of the 5m POC. That
      // gives 24 known answers, so the profile's settings can be FITTED
      // rather than guessed: compute the POC several plausible ways and
      // see which reproduces the logged entries. A first pass matched 6
      // trades to under a point and 11 to under five - proving the
      // money-flow math itself is right - while missing 11 others by more
      // than a full row height, with no constant offset (mean +2.0 pts).
      // Bimodal error like that means a categorical difference in which
      // BARS go into the profile, and the obvious candidate is the
      // chart's session setting: 270 five-minute bars of regular hours
      // spans ~3.5 sessions, 270 bars of 24-hour data spans ~1 day.
      const inRth = (b) => {
        const mins = ((barEpochSeconds(b) * 1000 + offsetHours * 3600000) / 60000) % 1440
        return mins >= 9 * 60 + 30 && mins < 16 * 60
      }
      const rthBars = oneMinBars.filter(inRth)
      const pocVariants = {}
      for (const [label, src, lookback] of [
        ['allHours_270', oneMinBars, 270],
        ['rth_270', rthBars, 270],
        ['allHours_360', oneMinBars, 360],
        ['rth_360', rthBars, 360],
        ['allHours_120', oneMinBars, 120],
        ['rth_120', rthBars, 120],
      ]) {
        const agg = aggregateBars(src, PROFILE_5M.intervalMinutes).slice(-lookback)
        const prof = volumeProfile(agg, PROFILE_ROWS)
        pocVariants[label] = prof.poc
          ? { center: zoneCenter(prof.poc), barsUsed: agg.length, diffToEntry: trade.entry - zoneCenter(prof.poc) }
          : null
      }

      const bars5m = aggregateBars(oneMinBars, PROFILE_5M.intervalMinutes).slice(-PROFILE_5M.lookbackBars)
      const bars15m = aggregateBars(oneMinBars, PROFILE_15M.intervalMinutes).slice(-PROFILE_15M.lookbackBars)
      const profile5m = volumeProfile(bars5m, PROFILE_ROWS)
      const profile15m = volumeProfile(bars15m, PROFILE_ROWS)

      const preEntryBars = oneMinBars.filter((b) => barEpochSeconds(b) >= entryInstant.getTime() / 1000 - PRE_ENTRY_WINDOW_MINUTES * 60)
      const recentBars = oneMinBars.filter((b) => barEpochSeconds(b) >= entryInstant.getTime() / 1000 - REJECTION_LOOKBACK_MINUTES * 60)

      const openingRange = buildOpeningRangeContext({ oneMinBars, trade, offsetHours, profile5m, profile15m, recentBars })
      const tpBoundary = tpNodeBoundary(profile5m, trade.entry, trade.direction)
      const tpWithinRule = tpBoundary === null ? null
        : trade.direction === 'long' ? trade.target <= tpBoundary : trade.target >= tpBoundary

      usableCount++
      if (openingRange.reachedInto15PocZone) reachedInto15PocCount++
      if (openingRange.gappedThroughPoc15) gappedThroughPoc15Count++
      if (openingRange.rejectionAtPoc5) rejectionAtPoc5Count++
      if (openingRange.biasDirection) {
        biasComputableCount++
        if (openingRange.biasDirectionMatchesTradeDirection) biasMatchesCount++
      }
      if (tpBoundary !== null) {
        tpRuleComputableCount++
        if (tpWithinRule) tpWithinRuleCount++
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
        // distanceEntryToPoc5m/15m below are the key fidelity check against
        // this rewrite's whole reason for existing (see header's "Fourth
        // pass") - compare them against the real "5 POC"/"15 POC" price
        // labels on the trader's own chart screenshots for the same trade.
        // A small number here (a few points) means this script's profile
        // math now actually reproduces the real indicator; a large one
        // means it still doesn't and needs another look before trusting
        // anything derived from it.
        profile5mPoc: profile5m.poc,
        profile15mPoc: profile15m.poc,
        pocVariants,
        distanceEntryToPoc5m: distanceToPoc(trade.entry, profile5m),
        distanceEntryToPoc15m: distanceToPoc(trade.entry, profile15m),
        // See DEBUG_TRADE_DATES's own comment - only populated for trades
        // explicitly opted into that env var, to debug tpNodeBoundary
        // against a specific trade's real chart row-by-row.
        profile5mRowsDebug: DEBUG_TRADE_DATES.includes(trade.trade_date)
          ? (() => {
              const totalFlow = profile5m.zones.reduce((sum, z) => sum + z.moneyFlow, 0)
              return [...profile5m.zones].sort((a, b) => a.bucketStart - b.bucketStart).map((z) => ({
                bucketStart: z.bucketStart,
                bucketEnd: z.bucketEnd,
                // % of the profile's TOTAL money flow - matches the real
                // indicator's own row-label basis (vtLV / rpVST.sum() * 100
                // in the shared Pine source), not % of the peak row. See
                // tpNodeBoundary's own comment for why this distinction is
                // the whole point of this debug field.
                pctOfTotal: Number((z.moneyFlow / totalFlow * 100).toFixed(2)),
              }))
            })()
          : undefined,
        openingRange,
        tpNodeBoundary: tpBoundary,
        tpWithinRule,
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
    tpRuleComputableCount,
    tpWithinRuleCount,
    profileRows: PROFILE_ROWS,
    profile5m: PROFILE_5M,
    profile15m: PROFILE_15M,
  }))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
