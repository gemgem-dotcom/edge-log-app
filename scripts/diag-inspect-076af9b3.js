#!/usr/bin/env node
// TEMPORARY, read-only diagnostic - not part of the app, never meant to be
// merged. Investigates why trade 076af9b3-312c-47c8-9987-1e6176545a6b
// shows excursion_fallback=true and a negative MAE even under the
// first-touch fix - pulls raw fields and real tick data around its logged
// entry/exit times to find out why the entry (or exit) fill couldn't be
// matched to a real trade print. Writes nothing to the database.

const { createClient } = require('@supabase/supabase-js')

const DATASET = 'GLBX.MDP3'
const PRICE_SCALE = 1e9
const FILL_PRICE_EPSILON = 0.0001

function log(...args) {
  console.log(new Date().toISOString(), ...args)
}

function authHeader() {
  const apiKey = process.env.DATABENTO_API_KEY
  if (!apiKey) throw new Error('DATABENTO_API_KEY is not set')
  return 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64')
}

function normalizeTradeRecord(record) {
  return {
    tsEvent: record.ts_event ?? record.hd?.ts_event ?? null,
    price: record.price / PRICE_SCALE,
    size: Number(record.size),
  }
}

function parseRecords(text, normalize) {
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
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Databento get_range failed: ${res.status} ${res.statusText} ${body}`.trim())
  }
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
  if (!dateStr || !timeStr) return null
  const [y, mo, d] = dateStr.split('-').map(Number)
  const [hh, mm, ss] = timeStr.split(':').map(Number)
  return new Date(Date.UTC(y, mo - 1, d, hh, mm, ss || 0) - offsetHours * 3600000)
}

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set')
  const admin = createClient(supabaseUrl, serviceKey)

  const TRADE_ID = '076af9b3-312c-47c8-9987-1e6176545a6b'
  const { data: trade, error } = await admin.from('trades').select('*').eq('id', TRADE_ID).single()
  if (error) throw new Error(error.message)
  log('Raw fields: ' + JSON.stringify(trade, null, 2))

  const { data: { user }, error: userErr } = await admin.auth.admin.getUserById(trade.user_id)
  if (userErr) throw new Error(`Could not load user: ${userErr.message}`)
  const offsetHours = parseFloat(user?.user_metadata?.timezone)
  log(`Timezone offset: ${offsetHours}`)

  const entryInstant = wallClockToInstant(trade.trade_date, trade.trade_time, offsetHours)
  const exitInstant = wallClockToInstant(trade.trade_date, trade.exit_time, offsetHours)
  log(`Rough entryInstant=${entryInstant.toISOString()} exitInstant=${exitInstant.toISOString()}`)
  log(`entry=${trade.entry} exit_price=${trade.exit_price} direction=${trade.direction} stop=${trade.stop} target=${trade.target}`)

  // Wide-ish window: 15 minutes before the logged entry through 15 minutes
  // after the logged exit, to see the full real price action around both
  // anchors and judge whether either price was ever actually touched.
  const padMs = 15 * 60000
  const start = new Date(entryInstant.getTime() - padMs).toISOString()
  const end = new Date(exitInstant.getTime() + padMs).toISOString()
  log(`Fetching trades: start=${start} end=${end}`)

  const ticks = await fetchTrades({ symbol: 'NQ.c.0', start, end })
  const parsed = ticks
    .map((t) => ({ ...t, instant: parseTickInstant(t.tsEvent) }))
    .filter((t) => t.instant)
    .sort((a, b) => a.instant.getTime() - b.instant.getTime())
  log(`${parsed.length} tick(s) fetched.`)

  if (parsed.length === 0) {
    log('=> No trade prints at all in this window - cannot investigate further.')
    return
  }

  log(`First tick: ${parsed[0].instant.toISOString()} price=${parsed[0].price}`)
  log(`Last tick: ${parsed[parsed.length - 1].instant.toISOString()} price=${parsed[parsed.length - 1].price}`)

  for (const [label, price] of [['entry', trade.entry], ['exit', trade.exit_price]]) {
    if (price === null || price === undefined) continue
    const matches = parsed.filter((t) => Math.abs(t.price - price) <= FILL_PRICE_EPSILON)
    if (matches.length === 0) {
      log(`No tick anywhere in the ±15min window touches ${label} price ${price}.`)
      const closestBefore = [...parsed].reverse().find((t) => t.instant.getTime() <= (label === 'entry' ? entryInstant : exitInstant).getTime())
      const closestAfter = parsed.find((t) => t.instant.getTime() >= (label === 'entry' ? entryInstant : exitInstant).getTime())
      log(`  Nearest tick before logged ${label} time: ${closestBefore ? `${closestBefore.instant.toISOString()} price=${closestBefore.price}` : 'none'}`)
      log(`  Nearest tick after logged ${label} time: ${closestAfter ? `${closestAfter.instant.toISOString()} price=${closestAfter.price}` : 'none'}`)
    } else {
      log(`${matches.length} tick(s) touch ${label} price ${price}. First: ${matches[0].instant.toISOString()}, last: ${matches[matches.length - 1].instant.toISOString()}`)
    }
  }

  // Print every tick within ±3 minutes of the logged entry time for close
  // visual inspection - this is where the real fill almost certainly is,
  // given trade times are accurate to about a minute.
  const closeWindow = parsed.filter((t) => Math.abs(t.instant.getTime() - entryInstant.getTime()) <= 3 * 60000)
  log(`--- Ticks within ±3min of logged entry time (${closeWindow.length}) ---`)
  for (const t of closeWindow) {
    log(`  ${t.instant.toISOString()} price=${t.price}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
