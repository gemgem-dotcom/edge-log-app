#!/usr/bin/env node

// Hourly retry for trades whose MFE/MAE/drawdown fetch was blocked by this
// account's Databento embargo at save time (market_data_status = 'pending')
// - see the .github/workflows/retry-trade-excursions.yml this runs under,
// lib/tradeExcursions.js, and schema.sql's comment above `mfe_points` for
// the full picture.
//
// Standalone rather than importing lib/tradeExcursions.js or lib/
// databento.js: this repo has no "type": "module", so ESM lib files aren't
// reliably loadable from a plain `node scripts/...` invocation the way
// Next.js's own bundler handles it - same reason scripts/fetch-daily-
// market-stats.js is already a fully separate script. The pieces
// duplicated below (the Databento HTTP call, the embargo-error check, the
// excursion window/math) are kept intentionally minimal and mirror those
// files exactly, so there's little for the copies to drift on.
//
// Usage: node scripts/retry-trade-excursions.js
// Env: DATABENTO_API_KEY, SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL

const { createClient } = require('@supabase/supabase-js')

const DATASET = 'GLBX.MDP3'
const NQ_CONTINUOUS_SYMBOL = 'NQ.c.0'
const PRICE_SCALE = 1e9
const EMBARGO_HOURS = 8
const BAR_SECONDS = 60

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

// trade_date/trade_time is a wall-clock reading, not a real instant, until
// combined with the account's own saved UTC offset - same conversion
// lib/tradeSessions.js's wallClockToInstant (and lib/tradeExcursions.js's
// copy of it) do.
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

// Entry-to-final-exit window - see lib/tradeExcursions.js's excursionWindow
// for the full explanation (this is the same logic, standalone).
function excursionWindow(trade, offsetHours) {
  if (!trade.trade_date || !trade.trade_time || Number.isNaN(offsetHours)) return null
  const entryInstant = wallClockToInstant(trade.trade_date, trade.trade_time, offsetHours)
  if (!entryInstant) return null

  const exitTimes = [trade.exit_time, ...(trade.additional_exits || []).map((e) => e.exit_time)].filter(Boolean)
  if (exitTimes.length === 0) return null

  let currentDate = trade.trade_date
  let currentInstant = entryInstant
  let exitInstant = entryInstant
  for (const exitTime of exitTimes) {
    let instant = wallClockToInstant(currentDate, exitTime, offsetHours)
    if (instant.getTime() < currentInstant.getTime()) {
      currentDate = addOneDay(currentDate)
      instant = wallClockToInstant(currentDate, exitTime, offsetHours)
    }
    currentInstant = instant
    exitInstant = instant
  }
  return { entryInstant, exitInstant }
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

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set')
  const admin = createClient(supabaseUrl, serviceKey)

  const { data: pending, error } = await admin.from('trades').select('*').eq('market_data_status', 'pending')
  if (error) throw new Error(`Failed to load pending trades: ${error.message}`)

  log(`${pending.length} trade(s) pending.`)
  if (pending.length === 0) return

  const instrumentIds = [...new Set(pending.map((t) => t.instrument_id))]
  const { data: instruments } = await admin.from('instruments').select('id, data_symbol').in('id', instrumentIds)
  const dataSymbolById = new Map((instruments || []).map((i) => [i.id, i.data_symbol]))

  const timezoneCache = new Map()
  let readyCount = 0
  let stillPending = 0
  let completed = 0
  let unavailable = 0

  for (const trade of pending) {
    // Only NQ-family instruments have a Databento symbol resolved anywhere
    // in this app - a 'pending' trade on anything else should never have
    // happened, but this is a genuine, permanent miss if it did.
    if (dataSymbolById.get(trade.instrument_id) !== 'NQ') {
      await admin.from('trades').update({ market_data_status: 'unavailable' }).eq('id', trade.id)
      unavailable += 1
      continue
    }

    const offsetHours = await getUserTimezone(supabaseUrl, serviceKey, trade.user_id, timezoneCache)
    const window = offsetHours === null ? null : excursionWindow(trade, offsetHours)
    if (!window) {
      await admin.from('trades').update({ market_data_status: 'unavailable' }).eq('id', trade.id)
      unavailable += 1
      continue
    }

    const embargoClears = window.exitInstant.getTime() + EMBARGO_HOURS * 3600000
    if (Date.now() < embargoClears) {
      stillPending += 1
      continue
    }
    readyCount += 1

    try {
      const bars = await fetchOhlcv1m({
        symbol: NQ_CONTINUOUS_SYMBOL,
        start: window.entryInstant.toISOString(),
        end: window.exitInstant.toISOString(),
      })
      if (bars.length === 0) {
        await admin.from('trades').update({ market_data_status: 'unavailable' }).eq('id', trade.id)
        unavailable += 1
        continue
      }
      const { mfePoints, maePoints, drawdownSeconds } = computeExcursion({ bars, entry: trade.entry, direction: trade.direction })
      await admin.from('trades').update({
        mfe_points: mfePoints,
        mae_points: maePoints,
        drawdown_seconds: drawdownSeconds,
        market_data_status: 'complete',
      }).eq('id', trade.id)
      completed += 1
    } catch (err) {
      if (isEmbargoError(err)) {
        // Still blocked despite clearing our own 8h estimate - leave it
        // pending rather than guessing further; next hour will retry.
        stillPending += 1
        log(`Trade ${trade.id} still embargoed past expected clear time: ${err.message}`)
      } else {
        await admin.from('trades').update({ market_data_status: 'unavailable' }).eq('id', trade.id)
        unavailable += 1
        log(`Trade ${trade.id} failed non-embargo: ${err.message}`)
      }
    }
  }

  log(`Ready to retry: ${readyCount}. Completed: ${completed}. Still pending (embargo not cleared yet): ${stillPending}. Marked unavailable: ${unavailable}.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
