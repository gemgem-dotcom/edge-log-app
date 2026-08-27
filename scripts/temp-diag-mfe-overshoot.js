#!/usr/bin/env node
// Check the RAW nanosecond ts_event values (not the millisecond-truncated
// Date conversion lib/tradeExcursions.js uses) for the burst of ticks
// around eee450d9's target fill, to see whether the "simultaneous" prints
// at 13:44:07.967Z are genuinely simultaneous or just rounding to the same
// millisecond when true (sub-millisecond) order would put some of them
// after the actual fill.
const { createClient } = require('@supabase/supabase-js')

const DATASET = 'GLBX.MDP3'
const NQ_CONTINUOUS_SYMBOL = 'NQ.c.0'
const PRICE_SCALE = 1e9

function authHeader() {
  return 'Basic ' + Buffer.from(`${process.env.DATABENTO_API_KEY}:`).toString('base64')
}
function normalizeRaw(record) {
  return { tsEventRaw: record.ts_event ?? record.hd?.ts_event ?? null, price: record.price / PRICE_SCALE, size: Number(record.size) }
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
  return parseRecords(await res.text(), normalizeRaw)
}

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const admin = createClient(supabaseUrl, serviceKey)
  const { data: trade } = await admin.from('trades').select('*').eq('id', 'eee450d9-4a85-4856-adaa-2901066db337').single()

  const ticks = await fetchTrades({
    symbol: NQ_CONTINUOUS_SYMBOL,
    stypeIn: 'continuous',
    start: '2026-08-26T13:44:07.900Z',
    end: '2026-08-26T13:44:08.100Z',
  })
  const sorted = ticks
    .filter((t) => t.tsEventRaw !== null)
    .sort((a, b) => (BigInt(a.tsEventRaw) < BigInt(b.tsEventRaw) ? -1 : BigInt(a.tsEventRaw) > BigInt(b.tsEventRaw) ? 1 : 0))
  console.log(`${sorted.length} ticks in the 200ms window around the fill, sorted by RAW nanosecond ts_event:`)
  for (const t of sorted) {
    console.log(`ts_event_ns=${t.tsEventRaw} price=${t.price} size=${t.size}`)
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
