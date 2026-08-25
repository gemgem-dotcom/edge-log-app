#!/usr/bin/env node

// One-time, manually-run recompute of MFE/MAE/drawdown for every trade
// already marked market_data_status = 'complete' - not scheduled, not
// part of any workflow, run once after the fill-instant-derivation fix
// (see lib/tradeExcursions.js's findFillInstant/deriveFillInstants and
// schema.sql's comment above `excursion_fallback`) to overwrite values
// computed under the old logic, which trusted a trade's logged
// trade_time/exit_time second directly as the query window's boundary.
// That second is frequently a TimePicker default, not a real observation
// - every 'complete' trade computed under the old logic has unverified
// values under it, whether or not the mismatch happened to be visible,
// not just the ones that looked obviously wrong.
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

const DATASET = 'GLBX.MDP3'
const NQ_CONTINUOUS_SYMBOL = 'NQ.c.0'
const PRICE_SCALE = 1e9
const EMBARGO_HOURS = 8
const BAR_SECONDS = 60
const FILL_SEARCH_PAD_MINUTES = 2
const FILL_PRICE_EPSILON = 0.0001
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

async function fetchOhlcv1m({ symbol, start, end }) {
  const url = new URL('/v0/timeseries.get_range', 'https://hist.databento.com')
  url.searchParams.set('dataset', DATASET)
  url.searchParams.set('schema', 'ohlcv-1m')
  url.searchParams.set('symbols', symbol)
  url.searchParams.set('stype_in', 'continuous')
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
  if (typeof tsEvent === 'string' && /^\d+$/.test(tsEvent)) {
    return new Date(Number(BigInt(tsEvent) / 1000000n))
  }
  if (typeof tsEvent === 'number') {
    return new Date(tsEvent / 1e6)
  }
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
  let recomputed = 0
  let changed = 0
  let skippedNotNq = 0
  let skippedNoWindow = 0
  let skippedStillEmbargoed = 0
  let skippedNoBars = 0
  let skippedError = 0

  for (const trade of complete) {
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
      const bars = await fetchOhlcv1m({
        symbol: NQ_CONTINUOUS_SYMBOL,
        start: new Date(rawWindow.entryInstant.getTime() - padMs).toISOString(),
        end: new Date(rawWindow.exitInstant.getTime() + padMs).toISOString(),
      })
      if (bars.length === 0) {
        skippedNoBars += 1
        continue
      }
      const { entryInstant, exitInstant, usedFallback } = deriveFillInstants({ rawWindow, entryPrice: trade.entry, bars })
      const windowBars = sliceBarsForWindow(bars, entryInstant, exitInstant)
      if (windowBars.length === 0) {
        skippedNoBars += 1
        continue
      }
      const { mfePoints, maePoints, drawdownSeconds } = computeExcursion({ bars: windowBars, entry: trade.entry, direction: trade.direction })

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
  log(`Skipped - not NQ-family: ${skippedNotNq}. No timezone/exit window: ${skippedNoWindow}. Still within embargo: ${skippedStillEmbargoed}. No bars found: ${skippedNoBars}. Errored (left untouched): ${skippedError}.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
