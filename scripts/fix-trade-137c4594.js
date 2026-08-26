#!/usr/bin/env node
// TEMPORARY, one-off - not part of the app, never meant to be merged.
// Trade 137c4594-c6d0-40f1-904f-acb9e71d9ef6 was flagged in NOTES.md as a
// known excursion-data issue. Tick-level re-investigation found clean,
// unambiguous real fills for both entry and exit, offset from the logged
// times by about the same ~10 minutes (the user confirmed this was a
// logging error) - this re-derives fresh (not from memory) and writes the
// corrected trade_time/exit_time plus the resulting mfe/mae/drawdown.

const { createClient } = require('@supabase/supabase-js')

const DATASET = 'GLBX.MDP3'
const PRICE_SCALE = 1e9
const FILL_PRICE_EPSILON = 0.0001
const FILL_SEARCH_PAD_MINUTES = 2

function log(...args) {
  console.log(new Date().toISOString(), ...args)
}

function authHeader() {
  const apiKey = process.env.DATABENTO_API_KEY
  if (!apiKey) throw new Error('DATABENTO_API_KEY is not set')
  return 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64')
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
  } catch { /* fall through */ }
  return trimmed.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => normalize(JSON.parse(l)))
}
async function fetchTrades({ symbol, start, end, stypeIn = 'continuous' }) {
  const url = new URL('/v0/timeseries.get_range', 'https://hist.databento.com')
  url.searchParams.set('dataset', DATASET)
  url.searchParams.set('schema', 'trades')
  url.searchParams.set('symbols', symbol)
  url.searchParams.set('stype_in', stypeIn)
  url.searchParams.set('start', start)
  url.searchParams.set('end', end)
  url.searchParams.set('encoding', 'json')
  const res = await fetch(url, { headers: { Authorization: authHeader() } })
  if (!res.ok) { const body = await res.text().catch(() => ''); throw new Error(`Databento get_range failed: ${res.status} ${res.statusText} ${body}`.trim()) }
  return parseRecords(await res.text(), normalizeTradeRecord)
}

function parseTickInstant(tsEvent) {
  if (tsEvent === null || tsEvent === undefined) return null
  if (typeof tsEvent === 'string' && /^\d+$/.test(tsEvent)) return new Date(Number(BigInt(tsEvent) / 1000000n))
  if (typeof tsEvent === 'number') return new Date(tsEvent / 1e6)
  const parsed = new Date(tsEvent)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}
function wallClockToInstant(dateStr, timeStr, offsetHours) {
  const [y, mo, d] = dateStr.split('-').map(Number)
  const [hh, mm, ss] = timeStr.split(':').map(Number)
  return new Date(Date.UTC(y, mo - 1, d, hh, mm, ss || 0) - offsetHours * 3600000)
}
// Inverse of wallClockToInstant - the trader's local "HH:MM:SS" for a real
// UTC instant, given the account's saved offset.
function instantToWallClockTime(instant, offsetHours) {
  const local = new Date(instant.getTime() + offsetHours * 3600000)
  const hh = String(local.getUTCHours()).padStart(2, '0')
  const mm = String(local.getUTCMinutes()).padStart(2, '0')
  const ss = String(local.getUTCSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

// A clean, explicit, generous window - wide enough to comfortably contain
// the ~10-minute discrepancy already observed for this trade, applied
// consistently to both entry and exit (the previous run used a narrower,
// inconsistently-derived window that clipped the true earliest entry
// touch by well under a second, cascading into slightly wrong values).
const MANUAL_SEARCH_PAD_MINUTES = 20

function tickTouchesPrice(t, p) { return Math.abs(t.price - p) <= FILL_PRICE_EPSILON }
function findFillTick({ ticks, roughInstant, price, afterInstant }) {
  const padMs = MANUAL_SEARCH_PAD_MINUTES * 60000
  const windowStartMs = Math.max(roughInstant.getTime() - padMs, afterInstant ? afterInstant.getTime() : -Infinity)
  const windowEndMs = roughInstant.getTime() + padMs
  let best = null
  for (const tick of ticks) {
    if (!tickTouchesPrice(tick, price)) continue
    const ms = tick.instant.getTime()
    if (ms < windowStartMs || ms > windowEndMs) continue
    if (!best || ms < best.getTime()) best = tick.instant
  }
  if (best) return { instant: best, matched: true }
  return { instant: roughInstant, matched: false }
}

const TRADE_ID = '137c4594-c6d0-40f1-904f-acb9e71d9ef6'

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set')
  const admin = createClient(supabaseUrl, serviceKey)

  const { data: trade, error } = await admin.from('trades').select('*').eq('id', TRADE_ID).single()
  if (error) throw new Error(error.message)
  log(`Trade ${trade.id}: current trade_time=${trade.trade_time} exit_time=${trade.exit_time} mfe=${trade.mfe_points} mae=${trade.mae_points} drawdown=${trade.drawdown_seconds}`)

  const { data: { user }, error: userErr } = await admin.auth.admin.getUserById(trade.user_id)
  if (userErr) throw new Error(`Could not load user: ${userErr.message}`)
  const offsetHours = parseFloat(user?.user_metadata?.timezone)
  log(`Timezone offset: ${offsetHours}`)

  const roughEntryInstant = wallClockToInstant(trade.trade_date, trade.trade_time, offsetHours)
  const roughExitInstant = wallClockToInstant(trade.trade_date, trade.exit_time, offsetHours)

  const fetchPadMs = MANUAL_SEARCH_PAD_MINUTES * 60000
  const start = new Date(roughEntryInstant.getTime() - fetchPadMs).toISOString()
  const end = new Date(roughExitInstant.getTime() + fetchPadMs).toISOString()
  const rawTicks = await fetchTrades({ symbol: 'NQ.c.0', start, end })
  const ticks = rawTicks.map((t) => ({ ...t, instant: parseTickInstant(t.tsEvent) })).filter((t) => t.instant).sort((a, b) => a.instant.getTime() - b.instant.getTime())
  log(`${ticks.length} tick(s) fetched (fetch window ±${MANUAL_SEARCH_PAD_MINUTES}min).`)

  // Sanity check: how many distinct touches of each price exist in the
  // whole fetched window - confirms this is a clean, unambiguous match
  // rather than a commonly-retested level (the 7e8616fb-style problem).
  const entryTouches = ticks.filter((t) => tickTouchesPrice(t, trade.entry))
  const exitTouches = ticks.filter((t) => tickTouchesPrice(t, trade.exit_price))
  log(`Entry price ${trade.entry} touched ${entryTouches.length} time(s) in the fetch window; first=${entryTouches[0]?.instant.toISOString()}, last=${entryTouches[entryTouches.length - 1]?.instant.toISOString()}`)
  log(`Exit price ${trade.exit_price} touched ${exitTouches.length} time(s) in the fetch window; first=${exitTouches[0]?.instant.toISOString()}, last=${exitTouches[exitTouches.length - 1]?.instant.toISOString()}`)

  const entryFill = findFillTick({ ticks, roughInstant: roughEntryInstant, price: trade.entry })
  if (!entryFill.matched) throw new Error('Entry fill not matched - refusing to write.')
  const exitFill = findFillTick({ ticks, roughInstant: roughExitInstant, price: trade.exit_price, afterInstant: entryFill.instant })
  if (!exitFill.matched) throw new Error('Exit fill not matched - refusing to write.')
  log(`Entry fill: ${entryFill.instant.toISOString()}  Exit fill: ${exitFill.instant.toISOString()}`)

  const windowTicks = ticks.filter((t) => t.instant.getTime() >= entryFill.instant.getTime() && t.instant.getTime() <= exitFill.instant.getTime())
  if (windowTicks.length === 0) throw new Error('No ticks in derived window - refusing to write.')

  const prices = windowTicks.map((t) => t.price)
  const maxPrice = Math.max(...prices)
  const minPrice = Math.min(...prices)
  const mfePoints = trade.direction === 'long' ? maxPrice - trade.entry : trade.entry - minPrice
  const maePoints = trade.direction === 'long' ? trade.entry - minPrice : maxPrice - trade.entry
  let drawdownMs = 0
  for (let i = 0; i < windowTicks.length - 1; i++) {
    const underwater = trade.direction === 'long' ? windowTicks[i].price < trade.entry : windowTicks[i].price > trade.entry
    if (underwater) drawdownMs += windowTicks[i + 1].instant.getTime() - windowTicks[i].instant.getTime()
  }
  const drawdownSeconds = Math.round(drawdownMs / 1000)

  const newTradeTime = instantToWallClockTime(entryFill.instant, offsetHours)
  const newExitTime = instantToWallClockTime(exitFill.instant, offsetHours)

  log(`Computed: mfe_points=${mfePoints.toFixed(2)} mae_points=${maePoints.toFixed(2)} drawdown_seconds=${drawdownSeconds}`)
  log(`Corrected local times: trade_time=${newTradeTime} exit_time=${newExitTime} (trade_date unchanged: ${trade.trade_date})`)

  const { error: writeErr } = await admin.from('trades').update({
    trade_time: newTradeTime,
    exit_time: newExitTime,
    mfe_points: mfePoints,
    mae_points: maePoints,
    drawdown_seconds: drawdownSeconds,
    market_data_status: 'complete',
    excursion_fallback: false,
  }).eq('id', TRADE_ID)
  if (writeErr) throw new Error(`Write failed: ${writeErr.message}`)
  log('Write succeeded.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
