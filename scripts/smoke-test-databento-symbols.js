#!/usr/bin/env node

// One-off, throwaway check: does this Databento account's GLBX.MDP3 access
// actually resolve a continuous front-month symbol (SYMBOL.c.0) for every
// instrument in lib/instrumentCatalog.js's data_symbol set, the same way
// NQ.c.0 was confirmed live before scripts/fetch-daily-market-stats.js was
// built on top of it? NQ is the only one anyone has actually verified
// against a real API key - this exists to check the rest (ES, YM, GC, CL,
// BTC) before lib/databento.js's NQ_CONTINUOUS_SYMBOL constant gets turned
// into a per-data_symbol map on the assumption they all follow the same
// convention.
//
// Deliberately standalone/CommonJS, not importing lib/databento.js - same
// reason fetch-daily-market-stats.js gives in its own header comment (no
// "type": "module" in package.json, so a plain `node scripts/...`
// invocation can't reliably load that file's ESM export/import syntax).
//
// Fetches exactly one ohlcv-1m bar per symbol, from a window ending 48
// hours ago - comfortably past the ~8h embargo confirmed for NQ (see
// lib/databento.js's own header), on the assumption the embargo is a
// dataset-level property (GLBX.MDP3), not a per-symbol one, so this should
// hold for every symbol below.
//
// Usage: DATABENTO_API_KEY=... node scripts/smoke-test-databento-symbols.js
// Prints one line per symbol: OK (with the bar's timestamp/close) or the
// exact error Databento returned. Not run by CI or any workflow - delete
// once every symbol below has been confirmed and the real per-symbol map
// is in place.

const DATASET = 'GLBX.MDP3'
const PRICE_SCALE = 1e9

// data_symbol -> Databento continuous front-month symbol, the .c.0
// convention NQ_CONTINUOUS_SYMBOL already uses - see lib/instrumentCatalog.js
// for the full data_symbol list this mirrors.
const CANDIDATES = {
  NQ: 'NQ.c.0',
  ES: 'ES.c.0',
  YM: 'YM.c.0',
  GC: 'GC.c.0',
  CL: 'CL.c.0',
  BTC: 'BTC.c.0',
}

function authHeader() {
  const apiKey = process.env.DATABENTO_API_KEY
  if (!apiKey) throw new Error('DATABENTO_API_KEY is not set')
  return 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64')
}

function parseFirstRecord(text) {
  const trimmed = text.trim()
  if (!trimmed) return null
  try {
    const whole = JSON.parse(trimmed)
    if (Array.isArray(whole)) return whole[0] ?? null
    if (Array.isArray(whole?.records)) return whole.records[0] ?? null
  } catch {
    // Not a single JSON document - newline-delimited, same as lib/
    // databento.js's own parseRecords.
  }
  const firstLine = trimmed.split('\n').map((l) => l.trim()).find(Boolean)
  return firstLine ? JSON.parse(firstLine) : null
}

async function checkSymbol(dataSymbol, symbol, start, end) {
  const url = new URL('/v0/timeseries.get_range', 'https://hist.databento.com')
  url.searchParams.set('dataset', DATASET)
  url.searchParams.set('schema', 'ohlcv-1m')
  url.searchParams.set('symbols', symbol)
  url.searchParams.set('stype_in', 'continuous')
  url.searchParams.set('start', start)
  url.searchParams.set('end', end)
  url.searchParams.set('encoding', 'json')

  let res
  try {
    res = await fetch(url, { headers: { Authorization: authHeader() } })
  } catch (err) {
    return { dataSymbol, symbol, ok: false, detail: `network error: ${err.message}` }
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    return { dataSymbol, symbol, ok: false, detail: `${res.status} ${res.statusText} ${body}`.trim() }
  }

  const text = await res.text()
  const record = parseFirstRecord(text)
  if (!record) return { dataSymbol, symbol, ok: false, detail: 'no bars returned for this window (market may have been closed - try a different hour)' }

  const close = record.close / PRICE_SCALE
  return { dataSymbol, symbol, ok: true, detail: `ts_event=${record.ts_event ?? record.hd?.ts_event} close=${close}` }
}

// A weekday, >=48h in the past (comfortably past NQ's confirmed ~8h
// embargo), at a fixed 15:00 UTC (10am ET) - deep in every one of these
// products' core regular trading hours, not just "some session is open
// somewhere." The first real run of this script picked a rolling
// now-minus-48h instant that happened to land in GC's daily 21:00-22:00
// UTC settlement halt and came back with zero bars - a false FAIL, not a
// real symbol problem. Fixing the hour (not just the day) avoids repeating
// that for GC or any other product with its own maintenance window.
function pastWeekdayAt(hoursAgo, utcHour) {
  let d = new Date(Date.now() - hoursAgo * 3600000)
  d.setUTCHours(utcHour, 0, 0, 0)
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d = new Date(d.getTime() - 24 * 3600000)
  }
  return d
}

async function main() {
  const start = pastWeekdayAt(48, 15)
  const end = new Date(start.getTime() + 3600000) // one hour window, plenty for a single 1m bar
  const startIso = start.toISOString()
  const endIso = end.toISOString()

  console.log(`Window: ${startIso} to ${endIso} (a weekday, >=48h ago, 15:00-16:00 UTC / 10-11am ET core hours)\n`)

  const results = []
  for (const [dataSymbol, symbol] of Object.entries(CANDIDATES)) {
    results.push(await checkSymbol(dataSymbol, symbol, startIso, endIso))
  }

  for (const r of results) {
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.dataSymbol.padEnd(4)} ${r.symbol.padEnd(8)} ${r.detail}`)
  }

  const failed = results.filter((r) => !r.ok)
  if (failed.length > 0) {
    console.log(`\n${failed.length} symbol(s) failed - re-run with a different window (e.g. a weekday hour) before concluding the symbol itself is wrong.`)
    process.exit(1)
  }
  console.log('\nAll symbols resolved.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
