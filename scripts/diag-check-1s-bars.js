#!/usr/bin/env node
// TEMPORARY, read-only diagnostic - not part of the app, never meant to be
// merged. Checks whether this Databento account/plan can access ohlcv-1s
// (and, as a bonus check, raw trades) for GLBX.MDP3, to inform whether
// MFE/MAE could be computed at finer-than-1-minute granularity instead of
// the current stop/target-capping heuristic. Writes nothing.

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

async function fetchRange({ schema, symbol, start, end, stypeIn = 'continuous' }) {
  const url = new URL('/v0/timeseries.get_range', 'https://hist.databento.com')
  url.searchParams.set('dataset', DATASET)
  url.searchParams.set('schema', schema)
  url.searchParams.set('symbols', symbol)
  url.searchParams.set('stype_in', stypeIn)
  url.searchParams.set('start', start)
  url.searchParams.set('end', end)
  url.searchParams.set('encoding', 'json')
  const res = await fetch(url, { headers: { Authorization: authHeader() } })
  const text = await res.text()
  return { ok: res.ok, status: res.status, statusText: res.statusText, text }
}

function parseRecords(text) {
  const trimmed = text.trim()
  if (!trimmed) return []
  try {
    const whole = JSON.parse(trimmed)
    if (Array.isArray(whole)) return whole
    if (Array.isArray(whole?.records)) return whole.records
  } catch {
    // fall through to line-delimited
  }
  return trimmed.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l))
}

async function main() {
  // A known, actively-traded, non-embargoed 2-minute window (same session
  // used in PR #122's own end-inclusivity smoke test).
  const start = '2026-06-16T14:00:00Z'
  const end = '2026-06-16T14:02:00Z'

  log('=== Checking ohlcv-1s (NQ.c.0, continuous) ===')
  const oneSec = await fetchRange({ schema: 'ohlcv-1s', symbol: 'NQ.c.0', start, end })
  log(`HTTP ${oneSec.status} ${oneSec.statusText}`)
  if (oneSec.ok) {
    const records = parseRecords(oneSec.text)
    log(`${records.length} record(s) returned for a 2-minute window (120 expected if truly 1-second bars).`)
    for (const r of records.slice(0, 5)) {
      log(`  ts_event=${r.ts_event ?? r.hd?.ts_event} high=${(r.high / PRICE_SCALE)} low=${(r.low / PRICE_SCALE)}`)
    }
  } else {
    log(`Body: ${oneSec.text.slice(0, 500)}`)
  }

  log('=== Checking trades (tick-level, NQ.c.0, continuous) ===')
  const ticks = await fetchRange({ schema: 'trades', symbol: 'NQ.c.0', start: '2026-06-16T14:00:00Z', end: '2026-06-16T14:00:10Z' })
  log(`HTTP ${ticks.status} ${ticks.statusText}`)
  if (ticks.ok) {
    const records = parseRecords(ticks.text)
    log(`${records.length} tick record(s) returned for a 10-second window.`)
    for (const r of records.slice(0, 5)) {
      log(`  ts_event=${r.ts_event ?? r.hd?.ts_event} price=${(r.price / PRICE_SCALE)} size=${r.size}`)
    }
  } else {
    log(`Body: ${ticks.text.slice(0, 500)}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
