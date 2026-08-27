#!/usr/bin/env node
// Redo: use the ACTUAL findFillTick/deriveFillTicks logic to find the real
// derived entryInstant/exitInstant (not a padded approximation), then print
// every tick in that exact window whose price is within 2pts of the target,
// in order, to see exactly how price approached/crossed it.
const { createClient } = require('@supabase/supabase-js')

const DATASET = 'GLBX.MDP3'
const NQ_CONTINUOUS_SYMBOL = 'NQ.c.0'
const PRICE_SCALE = 1e9
const FILL_SEARCH_PAD_MINUTES = 2
const FILL_PRICE_EPSILON = 0.0001

function authHeader() {
  return 'Basic ' + Buffer.from(`${process.env.DATABENTO_API_KEY}:`).toString('base64')
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
  } catch {}
  return trimmed.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => normalize(JSON.parse(l)))
}
async function fetchTrades({ symbol, start, end, stypeIn = 'continuous' }) {
  const url = new URL('/v0/timeseries.get_range', 'https://hist.databento.com')
  url.searchParams.set('dataset', DATASET); url.searchParams.set('schema', 'trades'); url.searchParams.set('symbols', symbol)
  url.searchParams.set('stype_in', stypeIn); url.searchParams.set('start', start); url.searchParams.set('end', end); url.searchParams.set('encoding', 'json')
  const res = await fetch(url, { headers: { Authorization: authHeader() } })
  if (!res.ok) { const body = await res.text().catch(() => ''); throw new Error(`Databento get_range failed: ${res.status} ${res.statusText} ${body}`.trim()) }
  return parseRecords(await res.text(), normalizeTradeRecord)
}
function parseTickInstant(tsEvent) {
  if (typeof tsEvent === 'string' && /^\d+$/.test(tsEvent)) return new Date(Number(BigInt(tsEvent) / 1000000n))
  return new Date(Number(tsEvent) / 1e6)
}
function wallClockToInstant(dateStr, timeStr, offsetHours) {
  const [y, mo, d] = dateStr.split('-').map(Number)
  const [hh, mm, ss] = timeStr.split(':').map(Number)
  return new Date(Date.UTC(y, mo - 1, d, hh, mm, ss || 0) - offsetHours * 3600000)
}
function tickTouchesPrice(tick, price) { return Math.abs(tick.price - price) <= FILL_PRICE_EPSILON }
function findFillTick({ ticks, roughInstant, price, afterInstant }) {
  const padMs = FILL_SEARCH_PAD_MINUTES * 60000
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

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const admin = createClient(supabaseUrl, serviceKey)
  const { data: trade } = await admin.from('trades').select('*').eq('id', 'eee450d9-4a85-4856-adaa-2901066db337').single()
  console.log('Trade:', JSON.stringify({ entry: trade.entry, target: trade.target, exit_price: trade.exit_price, trade_time: trade.trade_time, exit_time: trade.exit_time, direction: trade.direction }))

  const res = await fetch(`${supabaseUrl}/auth/v1/admin/users/${trade.user_id}`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } })
  const user = await res.json()
  const offsetHours = parseFloat(user?.user_metadata?.timezone)

  const roughEntry = wallClockToInstant(trade.trade_date, trade.trade_time, offsetHours)
  const roughExit = wallClockToInstant(trade.trade_date, trade.exit_time, offsetHours)

  const padMs = FILL_SEARCH_PAD_MINUTES * 60000
  const rawTicks = await fetchTrades({
    symbol: NQ_CONTINUOUS_SYMBOL,
    stypeIn: 'continuous',
    start: new Date(roughEntry.getTime() - padMs).toISOString(),
    end: new Date(roughExit.getTime() + padMs).toISOString(),
  })
  const ticks = rawTicks.map((t) => ({ ...t, instant: parseTickInstant(t.tsEvent) })).sort((a, b) => a.instant.getTime() - b.instant.getTime())
  console.log(`Fetched ${ticks.length} ticks.`)

  const entryFill = findFillTick({ ticks, roughInstant: roughEntry, price: trade.entry })
  const exitFill = findFillTick({ ticks, roughInstant: roughExit, price: trade.target, afterInstant: entryFill.instant })
  console.log('Derived entryInstant:', entryFill.instant.toISOString(), 'matched:', entryFill.matched)
  console.log('Derived exitInstant:', exitFill.instant.toISOString(), 'matched:', exitFill.matched)

  const windowTicks = ticks.filter((t) => t.instant.getTime() >= entryFill.instant.getTime() && t.instant.getTime() <= exitFill.instant.getTime())
  console.log(`Ticks in real [entryInstant, exitInstant] window: ${windowTicks.length}`)
  const maxPrice = Math.max(...windowTicks.map((t) => t.price))
  const maxTick = windowTicks.find((t) => t.price === maxPrice)
  console.log('Max price in real window:', maxPrice, 'at', maxTick.instant.toISOString(), '- MFE would be', maxPrice - trade.entry)

  // Print every tick within 1.5pts of the target, in the real window, in order
  const nearTarget = windowTicks.filter((t) => t.price >= trade.target - 1.5)
  console.log(`\nTicks within 1.5pts of/above target (${trade.target}) inside the real window, in order:`)
  for (const t of nearTarget) {
    const exact = Math.abs(t.price - trade.target) <= FILL_PRICE_EPSILON
    console.log(`${t.instant.toISOString()} price=${t.price}${exact ? ' <-- EXACT TARGET' : ''}`)
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
