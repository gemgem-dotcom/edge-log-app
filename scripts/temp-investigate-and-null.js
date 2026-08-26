#!/usr/bin/env node
// 1. Diagnostic (read-only): check whether Databento's plain continuous
//    symbol (NQ.c.0, i.e. NQ1-style front-month continuous - what the
//    trader says their own charting platform shows) has real prints near
//    7e8616fb's logged entry price, at its logged entry time - testing
//    whether continuous-vs-dated-contract choice explains the mismatch.
//    (076af9b3 is skipped here - the trader corrected its logged entry
//    price directly, which should already have gone through the live
//    edit-triggered recompute, so this run only checks its current state
//    rather than re-investigating the old, now-superseded mismatch.)
// 2. Current-state check for 076af9b3 (did the trader's own correction +
//    auto-recompute already fix it?) and conditional null of whichever of
//    the two trades still shows a fallback-derived (unverified, possibly
//    wrong) MFE/MAE - never nulling a trade that's already genuinely fixed.
const { createClient } = require('@supabase/supabase-js')

const DATASET = 'GLBX.MDP3'
const PRICE_SCALE = 1e9

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

function summarize(ticks) {
  if (ticks.length === 0) return 'no prints'
  const prices = ticks.map((t) => t.price)
  return `${ticks.length} print(s), price range ${Math.min(...prices)}-${Math.max(...prices)}, first=${ticks[0].price} last=${ticks[ticks.length - 1].price}`
}

async function investigate() {
  console.log('=== 7e8616fb: continuous NQ.c.0 near logged entry 29737.5 ===')
  const t1Start = '2026-06-23T13:30:00Z'
  const t1End = '2026-06-23T14:00:00Z'
  try {
    const ticks = await fetchTrades({ symbol: 'NQ.c.0', stypeIn: 'continuous', start: t1Start, end: t1End })
    console.log(`NQ.c.0 continuous, ${t1Start} to ${t1End}: ${summarize(ticks)}`)
    const near29737 = ticks.filter((t) => Math.abs(t.price - 29737.5) <= 5)
    console.log(`Prints within 5pts of 29737.5: ${near29737.length}${near29737.length ? ' e.g. ' + JSON.stringify(near29737.slice(0, 3)) : ''}`)
  } catch (err) {
    console.log(`NQ.c.0 fetch failed: ${err.message}`)
  }
}

async function main() {
  await investigate()

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const admin = createClient(supabaseUrl, serviceKey)

  console.log('\n=== Current state check ===')
  const TRADE_IDS = [
    '7e8616fb-334b-4465-8a2f-e572b634df5a',
    '076af9b3-312c-47c8-9987-1e6176545a6b',
  ]
  const rows = {}
  for (const id of TRADE_IDS) {
    const { data } = await admin.from('trades').select('id, entry, market_data_status, mfe_points, mae_points, drawdown_seconds, excursion_fallback, trade_time_unverified, updated_at').eq('id', id).single()
    console.log(JSON.stringify(data))
    rows[id] = data
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
