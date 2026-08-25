#!/usr/bin/env node

// TEMPORARY, read-only diagnostic - not part of the app, never meant to be
// merged. Investigates the front-month-resolution discrepancy surfaced
// while checking PR #122's fix against real trade 076af9b3-312c-47c8-9987-
// 1e6176545a6b: does Databento's own NQ.c.0 continuous-symbol resolution
// (the live route/retry job's method) agree with the "whichever contract
// traded the most volume that session" method (scripts/
// backfill_trade_excursions_from_dbn.py's method, applied to a downloaded
// file) for that trade's specific session? And separately: how many
// trades in the *whole* set sit near any quarterly roll (3rd Friday of
// Mar/Jun/Sep/Dec), where this kind of disagreement could plausibly show
// up? Writes nothing to the database.
//
// Usage: node scripts/diag-front-month-scope.js
// Env: DATABENTO_API_KEY, SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL

const { createClient } = require('@supabase/supabase-js')

const DATASET = 'GLBX.MDP3'
const PRICE_SCALE = 1e9

function log(...args) {
  console.log(new Date().toISOString(), ...args)
}

function authHeader() {
  const apiKey = process.env.DATABENTO_API_KEY
  if (!apiKey) throw new Error('DATABENTO_API_KEY is not set')
  return 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64')
}

async function databentoGet(path, params) {
  const url = new URL(path, 'https://hist.databento.com')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url, { headers: { Authorization: authHeader() } })
  const text = await res.text()
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${res.statusText} ${text}`.trim())
  return text
}

function wallClockToInstant(dateStr, timeStr, offsetHours) {
  if (!dateStr || !timeStr) return null
  const [y, mo, d] = dateStr.split('-').map(Number)
  const [hh, mm, ss] = timeStr.split(':').map(Number)
  return new Date(Date.UTC(y, mo - 1, d, hh, mm, ss || 0) - offsetHours * 3600000)
}

// Same CME-trading-day rule scripts/backfill_trade_excursions_from_dbn.py
// uses: 6pm ET or later rolls into the next calendar day's session.
function sessionDateFor(instant) {
  // Approximate ET offset handling: use Intl to get real ET wall-clock hour.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(instant)
  const get = (t) => parts.find((p) => p.type === t).value
  let y = Number(get('year')), mo = Number(get('month')), d = Number(get('day'))
  const hour = Number(get('hour'))
  let date = new Date(Date.UTC(y, mo - 1, d))
  if (hour >= 18) date = new Date(date.getTime() + 24 * 3600000)
  return date
}

// Session boundaries in UTC: 6pm ET the evening before sessionDate through
// that same evening's close - generous enough to cover the whole trading
// day for volume-summing purposes.
function sessionBoundsUtc(sessionDate) {
  // sessionDate is a UTC midnight Date representing the *session's own*
  // calendar day. Start = 6pm ET the day before; end = 6pm ET on
  // sessionDate itself. Use a fixed UTC-4/UTC-5 approximation is risky
  // across DST, so approximate by asking Intl for the actual offset via a
  // round-trip: construct 6pm ET on each day using Intl.
  function sixPmEtUtc(dateUtcMidnight) {
    // Binary-search-free approach: format a guess instant in ET, adjust.
    let guess = new Date(dateUtcMidnight.getTime() + 22 * 3600000) // ~6pm ET assuming UTC-4
    for (let i = 0; i < 3; i++) {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(guess)
      const hh = Number(parts.find((p) => p.type === 'hour').value)
      const mm = Number(parts.find((p) => p.type === 'minute').value)
      const diffMinutes = (18 * 60) - (hh * 60 + mm)
      guess = new Date(guess.getTime() + diffMinutes * 60000)
    }
    return guess
  }
  const dayBefore = new Date(sessionDate.getTime() - 24 * 3600000)
  return { start: sixPmEtUtc(dayBefore), end: sixPmEtUtc(sessionDate) }
}

function thirdFriday(year, month) {
  // month is 1-12
  const d = new Date(Date.UTC(year, month - 1, 1))
  const dayOfWeek = d.getUTCDay() // 0=Sun..6=Sat
  const firstFriday = 1 + ((5 - dayOfWeek + 7) % 7)
  return new Date(Date.UTC(year, month - 1, firstFriday + 14))
}

function nearestRollDistanceDays(dateUtcMidnight) {
  const year = dateUtcMidnight.getUTCFullYear()
  const candidates = []
  for (const y of [year - 1, year, year + 1]) {
    for (const m of [3, 6, 9, 12]) candidates.push(thirdFriday(y, m))
  }
  let best = Infinity
  for (const c of candidates) {
    const days = Math.abs((dateUtcMidnight.getTime() - c.getTime()) / 86400000)
    if (days < best) best = days
  }
  return Math.round(best)
}

function normalizeOhlcv(record) {
  return {
    symbol: record.symbol,
    high: record.high / PRICE_SCALE,
    low: record.low / PRICE_SCALE,
    open: record.open / PRICE_SCALE,
    close: record.close / PRICE_SCALE,
    volume: Number(record.volume),
  }
}

function parseNdjson(text, normalize) {
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

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set')
  const admin = createClient(supabaseUrl, serviceKey)

  // --- Part 1: the specific trade ---
  const TRADE_ID = '076af9b3-312c-47c8-9987-1e6176545a6b'
  const { data: trade, error: tradeErr } = await admin.from('trades').select('*').eq('id', TRADE_ID).single()
  if (tradeErr || !trade) throw new Error(`Could not load trade ${TRADE_ID}: ${tradeErr?.message}`)

  const { data: { user } } = await admin.auth.admin.getUserById(trade.user_id)
  const offsetHours = parseFloat(user?.user_metadata?.timezone)
  log(`Trade ${TRADE_ID}: trade_date=${trade.trade_date} trade_time=${trade.trade_time} exit_time=${trade.exit_time} direction=${trade.direction} entry=${trade.entry} timezone_offset=${offsetHours}`)

  const entryInstant = wallClockToInstant(trade.trade_date, trade.trade_time, offsetHours)
  const exitInstant = wallClockToInstant(trade.trade_date, trade.exit_time, offsetHours)
  const sessionDate = sessionDateFor(entryInstant)
  const sessionDateStr = sessionDate.toISOString().slice(0, 10)
  const rollDistance = nearestRollDistanceDays(sessionDate)
  log(`Session date (6pm-ET-rollover rule): ${sessionDateStr}. Distance to nearest quarterly 3rd-Friday roll: ${rollDistance} day(s).`)

  const { start, end } = sessionBoundsUtc(sessionDate)
  log(`Session bounds (UTC): ${start.toISOString()} to ${end.toISOString()}`)

  // --- RAW SHAPE DUMP FIRST: neither of this file's two symbology guesses
  // (symbology.resolve's stype_out=raw_symbol, and a plain `symbol` field
  // on parent-symbol OHLCV records) has ever been confirmed against a
  // real response - the first attempt already proved one of them wrong
  // (a 422). Dumping a tiny raw sample of each before parsing anything,
  // rather than guessing a second field name blind. ---
  log('--- RAW: 3 records from a 2-minute stype_in=continuous (NQ.c.0) fetch ---')
  try {
    const sampleEnd = new Date(start.getTime() + 2 * 60000)
    const rawContinuous = await databentoGet('/v0/timeseries.get_range', {
      dataset: DATASET,
      schema: 'ohlcv-1m',
      symbols: 'NQ.c.0',
      stype_in: 'continuous',
      start: start.toISOString(),
      end: sampleEnd.toISOString(),
      encoding: 'json',
    })
    log(rawContinuous.trim().split('\n').slice(0, 3).join('\n'))
  } catch (err) {
    log(`continuous raw sample failed: ${err.message}`)
  }

  log('--- RAW: 3 records from a 2-minute stype_in=parent (NQ.FUT) fetch ---')
  try {
    const sampleEnd = new Date(start.getTime() + 2 * 60000)
    const rawParent = await databentoGet('/v0/timeseries.get_range', {
      dataset: DATASET,
      schema: 'ohlcv-1m',
      symbols: 'NQ.FUT',
      stype_in: 'parent',
      start: start.toISOString(),
      end: sampleEnd.toISOString(),
      encoding: 'json',
    })
    log(rawParent.trim().split('\n').slice(0, 6).join('\n'))
  } catch (err) {
    log(`parent raw sample failed: ${err.message}`)
  }

  log('--- Stopping here for this pass - fixing the parser against the real shapes above before doing the full comparison. ---')
  return

  const bySymbol = new Map()
  for (const bar of parentBars) {
    if (!bar.symbol || bar.symbol.includes('-')) continue // drop spreads
    const agg = bySymbol.get(bar.symbol) || { volume: 0, high: -Infinity, low: Infinity, bars: 0 }
    agg.volume += bar.volume
    agg.high = Math.max(agg.high, bar.high)
    agg.low = Math.min(agg.low, bar.low)
    agg.bars += 1
    bySymbol.set(bar.symbol, agg)
  }
  const ranked = [...bySymbol.entries()].sort((a, b) => b[1].volume - a[1].volume)
  log('Per-contract session summary (sorted by volume):')
  for (const [symbol, agg] of ranked) {
    log(`  ${symbol}: volume=${agg.volume} high=${agg.high} low=${agg.low} bars=${agg.bars}`)
  }
  const manualFrontMonth = ranked[0]?.[0]
  log(`Manual (highest-volume) method picks: ${manualFrontMonth}`)

  // --- If the entry/exit window's own bars differ between candidates,
  // show that difference directly (not just the whole-session summary) ---
  if (ranked.length >= 2) {
    const [topSymbol] = ranked[0]
    const [secondSymbol] = ranked[1]
    log(`--- Comparing ${topSymbol} vs ${secondSymbol} over just the trade's own entry-exit window ---`)
    const windowBars = parentBars.filter((b) => {
      // We don't have per-bar timestamps parsed here (kept minimal) - this
      // section is best-effort context, the whole-session summary above is
      // the authoritative comparison.
      return b.symbol === topSymbol || b.symbol === secondSymbol
    })
    log(`(${windowBars.length} bars available across both candidates for the whole session; see per-contract summary above for the actual high/low/volume comparison.)`)
  }

  // --- Part 2: scope across every complete trade, any product, any roll ---
  log('--- Roll-proximity scan across every trade ---')
  const { data: allTrades, error: allErr } = await admin.from('trades').select('id, trade_date, trade_time, instrument_id, market_data_status')
  if (allErr) throw new Error(`Failed to load trades: ${allErr.message}`)

  const { data: instruments } = await admin.from('instruments').select('id, symbol, data_symbol')
  const symbolById = new Map((instruments || []).map((i) => [i.id, i.symbol]))

  const nearRoll = []
  for (const t of allTrades) {
    if (!t.trade_date) continue
    const [y, mo, d] = t.trade_date.split('-').map(Number)
    const dateUtc = new Date(Date.UTC(y, mo - 1, d))
    const distance = nearestRollDistanceDays(dateUtc)
    if (distance <= 10) {
      nearRoll.push({ id: t.id, date: t.trade_date, symbol: symbolById.get(t.instrument_id), status: t.market_data_status, distance })
    }
  }
  log(`${allTrades.length} total trade(s) in the account. ${nearRoll.length} within 10 days of a quarterly roll:`)
  for (const t of nearRoll.sort((a, b) => a.distance - b.distance)) {
    log(`  ${t.id} [${t.symbol}, ${t.date}, status=${t.status}] - ${t.distance} day(s) from nearest roll`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
