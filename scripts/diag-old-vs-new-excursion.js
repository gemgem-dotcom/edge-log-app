#!/usr/bin/env node

// TEMPORARY, read-only diagnostic - not part of the app, never meant to be
// merged. Finds every complete NQ trade whose exit hit its take-profit
// (mirroring components/TradeForm.js's inferOutcome 'target' branch) and,
// for each, computes MFE/MAE/drawdown BOTH ways: the OLD logic (raw
// wall-clock window, unpadded fetch, no fill-instant derivation - exactly
// what shipped before this fix) and the NEW logic (findFillInstant/
// deriveFillInstants + padded fetch + in-memory slice). Prints both,
// side by side, for every target-hit trade - not just ones that already
// look wrong - plus a flag on any where the OLD mfe_points came out below
// the target distance despite the exit having hit target (the exact
// undercount signature this fix targets). Writes nothing to the database.
//
// Usage: node scripts/diag-old-vs-new-excursion.js
// Env: DATABENTO_API_KEY, SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL

const { createClient } = require('@supabase/supabase-js')

const DATASET = 'GLBX.MDP3'
const NQ_CONTINUOUS_SYMBOL = 'NQ.c.0'
const PRICE_SCALE = 1e9
const BAR_SECONDS = 60
const FILL_SEARCH_PAD_MINUTES = 2
const FILL_PRICE_EPSILON = 0.0001
const ADHERENCE_EPSILON = 0.0001

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

// Mirrors components/TradeForm.js's inferOutcome 'target' branch exactly.
function hitTarget(trade) {
  if (trade.target === null || trade.target === undefined || trade.exit_price === null || trade.exit_price === undefined) return false
  const dir = trade.direction === 'long' ? 1 : -1
  return dir * (trade.exit_price - trade.target) >= -ADHERENCE_EPSILON
}

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set')
  const admin = createClient(supabaseUrl, serviceKey)

  const { data: complete, error } = await admin.from('trades').select('*').eq('market_data_status', 'complete')
  if (error) throw new Error(`Failed to load complete trades: ${error.message}`)

  const { data: instruments } = await admin.from('instruments').select('id, data_symbol')
  const dataSymbolById = new Map((instruments || []).map((i) => [i.id, i.data_symbol]))

  const targetHit = complete.filter((t) => dataSymbolById.get(t.instrument_id) === 'NQ' && hitTarget(t))
  log(`${complete.length} complete NQ-family trade(s) total, ${targetHit.length} of which hit target.`)

  const timezoneCache = new Map()
  let flaggedCount = 0

  for (const trade of targetHit) {
    const offsetHours = await getUserTimezone(supabaseUrl, serviceKey, trade.user_id, timezoneCache)
    const rawWindow = offsetHours === null ? null : excursionWindow(trade, offsetHours)
    if (!rawWindow) {
      log(`Trade ${trade.id}: no timezone/window - skipping.`)
      continue
    }

    const targetDistance = trade.direction === 'long' ? trade.target - trade.entry : trade.entry - trade.target

    // OLD logic: raw window, unpadded fetch, straight into computeExcursion.
    let oldResult = null
    try {
      const oldBars = await fetchOhlcv1m({
        symbol: NQ_CONTINUOUS_SYMBOL,
        start: rawWindow.entryInstant.toISOString(),
        end: rawWindow.exitInstant.toISOString(),
      })
      if (oldBars.length > 0) oldResult = computeExcursion({ bars: oldBars, entry: trade.entry, direction: trade.direction })
    } catch (err) {
      log(`Trade ${trade.id}: OLD-logic fetch failed: ${err.message}`)
    }

    // NEW logic: padded fetch, derive fill instants, in-memory slice.
    let newResult = null
    let usedFallback = null
    try {
      const padMs = FILL_SEARCH_PAD_MINUTES * 60000
      const newBars = await fetchOhlcv1m({
        symbol: NQ_CONTINUOUS_SYMBOL,
        start: new Date(rawWindow.entryInstant.getTime() - padMs).toISOString(),
        end: new Date(rawWindow.exitInstant.getTime() + padMs).toISOString(),
      })
      if (newBars.length > 0) {
        const derived = deriveFillInstants({ rawWindow, entryPrice: trade.entry, bars: newBars })
        usedFallback = derived.usedFallback
        const windowBars = sliceBarsForWindow(newBars, derived.entryInstant, derived.exitInstant)
        if (windowBars.length > 0) newResult = computeExcursion({ bars: windowBars, entry: trade.entry, direction: trade.direction })
      }
    } catch (err) {
      log(`Trade ${trade.id}: NEW-logic fetch failed: ${err.message}`)
    }

    const oldUndercounts = oldResult && oldResult.mfePoints < targetDistance - ADHERENCE_EPSILON
    if (oldUndercounts) flaggedCount += 1

    log(`Trade ${trade.id} [${trade.direction}, entry=${trade.entry}, target=${trade.target}, target_distance=${targetDistance.toFixed(2)}]${oldUndercounts ? '  <-- OLD MFE UNDERCOUNTS TARGET' : ''}`)
    log(`  stored (old, currently in DB): mfe=${trade.mfe_points} mae=${trade.mae_points} drawdown=${trade.drawdown_seconds}s`)
    log(`  OLD logic recomputed:          ${oldResult ? `mfe=${oldResult.mfePoints.toFixed(2)} mae=${oldResult.maePoints.toFixed(2)} drawdown=${oldResult.drawdownSeconds}s` : 'no bars / fetch failed'}`)
    log(`  NEW logic recomputed:          ${newResult ? `mfe=${newResult.mfePoints.toFixed(2)} mae=${newResult.maePoints.toFixed(2)} drawdown=${newResult.drawdownSeconds}s` : 'no bars / fetch failed'}${newResult ? `  (usedFallback=${usedFallback})` : ''}`)
  }

  log(`Done. ${targetHit.length} target-hit trade(s) examined, ${flaggedCount} showed the OLD-MFE-undercounts-target signature.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
