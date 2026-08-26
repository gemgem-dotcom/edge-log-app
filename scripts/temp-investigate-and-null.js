#!/usr/bin/env node
// Corrected re-run: the first pass had two bugs - (1) it selected a
// nonexistent `updated_at` column on `trades` (that's an edge_beliefs
// column) without checking the returned `error`, so the "current state"
// section silently printed null/null instead of failing loudly; (2) the
// NQ.c.0 continuous-symbol comparison window for 7e8616fb was a guessed
// date/time, not derived from the trade's actual logged trade_date/
// trade_time - so its "3875 prints within 5pts" result isn't trustworthy
// evidence either way. This version pulls the trade's real fields first
// and derives the comparison window from them.
const { createClient } = require('@supabase/supabase-js')

const DATASET = 'GLBX.MDP3'
const PRICE_SCALE = 1e9

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
  } catch {}
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
function wallClockToInstant(dateStr, timeStr, offsetHours) {
  if (!dateStr || !timeStr) return null
  const [y, mo, d] = dateStr.split('-').map(Number)
  const [hh, mm, ss] = timeStr.split(':').map(Number)
  return new Date(Date.UTC(y, mo - 1, d, hh, mm, ss || 0) - offsetHours * 3600000)
}
async function getUserTimezone(supabaseUrl, serviceKey, userId) {
  const res = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  })
  if (!res.ok) return null
  const user = await res.json()
  const offset = parseFloat(user?.user_metadata?.timezone)
  return Number.isNaN(offset) ? null : offset
}
function summarize(ticks) {
  if (ticks.length === 0) return 'no prints'
  const prices = ticks.map((t) => t.price)
  return `${ticks.length} print(s), price range ${Math.min(...prices)}-${Math.max(...prices)}`
}

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const admin = createClient(supabaseUrl, serviceKey)

  const TRADE_IDS = [
    '7e8616fb-334b-4465-8a2f-e572b634df5a',
    '076af9b3-312c-47c8-9987-1e6176545a6b',
  ]

  console.log('=== Current trade state ===')
  const rows = {}
  for (const id of TRADE_IDS) {
    const { data, error } = await admin.from('trades')
      .select('id, user_id, trade_date, trade_time, entry, direction, stop, target, exit_price, exit_time, market_data_status, mfe_points, mae_points, drawdown_seconds, excursion_fallback, trade_time_unverified')
      .eq('id', id).single()
    if (error) {
      console.log(`${id}: query error - ${error.message}`)
      continue
    }
    console.log(JSON.stringify(data))
    rows[id] = data
  }

  console.log('\n=== NQ.c.0 continuous check around real logged entry instant ===')
  for (const id of TRADE_IDS) {
    const row = rows[id]
    if (!row) continue
    const offsetHours = await getUserTimezone(supabaseUrl, serviceKey, row.user_id)
    if (offsetHours === null) { console.log(`${id}: no timezone, skipping continuous check`); continue }
    const entryInstant = wallClockToInstant(row.trade_date, row.trade_time, offsetHours)
    const padMs = 15 * 60000
    const start = new Date(entryInstant.getTime() - padMs).toISOString()
    const end = new Date(entryInstant.getTime() + padMs).toISOString()
    console.log(`${id}: logged entry ${row.trade_date} ${row.trade_time} (offset ${offsetHours}) -> ${entryInstant.toISOString()}, checking NQ.c.0 ${start} to ${end}`)
    try {
      const ticks = await fetchTrades({ symbol: 'NQ.c.0', stypeIn: 'continuous', start, end })
      console.log(`  NQ.c.0: ${summarize(ticks)}`)
      const near = ticks.filter((t) => Math.abs(t.price - row.entry) <= 2)
      console.log(`  Prints within 2pts of logged entry ${row.entry}: ${near.length}${near.length ? ' e.g. ' + JSON.stringify(near.slice(0, 2)) : ''}`)
    } catch (err) {
      console.log(`  NQ.c.0 fetch failed: ${err.message}`)
    }
  }

  console.log('\n=== Conditional null (only for a trade still showing a fallback-derived value) ===')
  for (const id of TRADE_IDS) {
    const row = rows[id]
    if (!row) { console.log(`${id}: not found, skipping`); continue }
    if (!(row.market_data_status === 'complete' && row.excursion_fallback)) {
      console.log(`${id}: not in the fallback-bad state (status=${row.market_data_status}, excursion_fallback=${row.excursion_fallback}) - leaving untouched`)
      continue
    }
    const { error } = await admin.from('trades').update({
      market_data_status: 'unavailable',
      mfe_points: null,
      mae_points: null,
      drawdown_seconds: null,
    }).eq('id', id)
    console.log(error ? `${id}: FAILED - ${error.message}` : `${id}: nulled (was fallback-derived, now unavailable)`)
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
