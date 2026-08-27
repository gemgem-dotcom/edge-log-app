#!/usr/bin/env node
// Investigating why eee450d9's MFE (84.00) exceeds its exact target
// distance (83.25) by 0.75pt. Fetches the real tick data around the
// derived entry/exit window and prints every tick touching or exceeding
// the target price, in order, to see whether price actually traded past
// the exact target level before/without an exact print at it (a tick-
// granularity gap), or whether this is a fill-matching bug.
const { createClient } = require('@supabase/supabase-js')

const DATASET = 'GLBX.MDP3'
const NQ_CONTINUOUS_SYMBOL = 'NQ.c.0'
const PRICE_SCALE = 1e9
const FILL_SEARCH_PAD_MINUTES = 2
const FILL_PRICE_EPSILON = 0.0001

function authHeader() {
  const apiKey = process.env.DATABENTO_API_KEY
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

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const admin = createClient(supabaseUrl, serviceKey)
  const { data: trade } = await admin.from('trades').select('*').eq('id', 'eee450d9-4a85-4856-adaa-2901066db337').single()
  console.log('Trade:', JSON.stringify({ entry: trade.entry, target: trade.target, exit_price: trade.exit_price, trade_time: trade.trade_time, exit_time: trade.exit_time, direction: trade.direction }))

  const res = await fetch(`${supabaseUrl}/auth/v1/admin/users/${trade.user_id}`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } })
  const user = await res.json()
  const offsetHours = parseFloat(user?.user_metadata?.timezone)
  console.log('Offset:', offsetHours)

  const entryInstant = wallClockToInstant(trade.trade_date, trade.trade_time, offsetHours)
  const exitInstant = wallClockToInstant(trade.trade_date, trade.exit_time, offsetHours)
  console.log('Rough entry/exit:', entryInstant.toISOString(), exitInstant.toISOString())

  const padMs = FILL_SEARCH_PAD_MINUTES * 60000
  const ticks = await fetchTrades({
    symbol: NQ_CONTINUOUS_SYMBOL,
    stypeIn: 'continuous',
    start: new Date(entryInstant.getTime() - padMs).toISOString(),
    end: new Date(exitInstant.getTime() + padMs).toISOString(),
  })
  console.log(`Fetched ${ticks.length} ticks.`)

  const withInstant = ticks.map((t) => ({ ...t, instant: parseTickInstant(t.tsEvent) })).sort((a, b) => a.instant.getTime() - b.instant.getTime())

  const target = trade.target
  // Print every tick from entry price onward that is >= target - 3pts, in order,
  // to see the exact sequence of prints as price approached/crossed the target.
  const relevant = withInstant.filter((t) => t.price >= target - 3 && t.instant.getTime() >= entryInstant.getTime() - padMs)
  console.log(`Ticks within 3pts below target or above, in chronological order (first 60):`)
  for (const t of relevant.slice(0, 60)) {
    const touchesExact = Math.abs(t.price - target) <= FILL_PRICE_EPSILON
    console.log(`${t.instant.toISOString()} price=${t.price}${touchesExact ? ' <-- EXACT TARGET MATCH' : ''}`)
  }

  const maxPrice = Math.max(...withInstant.filter((t) => t.instant.getTime() >= entryInstant.getTime() && t.instant.getTime() <= exitInstant.getTime() + padMs).map((t) => t.price))
  console.log('Max price in full fetched window:', maxPrice, 'vs target:', target, 'vs entry:', trade.entry)
}

main().catch((err) => { console.error(err); process.exit(1) })
