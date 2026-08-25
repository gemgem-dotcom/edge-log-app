#!/usr/bin/env node
// TEMPORARY, read-only diagnostic - not part of the app, never meant to be
// merged. Three independent investigations for the PR #122 follow-up:
//   1. Wide manual search for 7e8616fb's real fill instants (several hours
//      + adjacent calendar days, not just the automated fix's ±1 minute).
//   2. 137c4594's raw fields + actual bar data around entry/exit.
//   3. Databento end-inclusivity smoke test against a known narrow window.
// Writes nothing to the database.

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

function normalizeRecord(record) {
  return {
    tsEvent: record.ts_event ?? record.hd?.ts_event ?? null,
    instrumentId: record.hd?.instrument_id ?? null,
    open: record.open / PRICE_SCALE,
    high: record.high / PRICE_SCALE,
    low: record.low / PRICE_SCALE,
    close: record.close / PRICE_SCALE,
    volume: Number(record.volume),
  }
}

function parseOhlcvRecords(text) {
  const trimmed = text.trim()
  if (!trimmed) return []
  try {
    const whole = JSON.parse(trimmed)
    if (Array.isArray(whole)) return whole.map(normalizeRecord)
    if (Array.isArray(whole?.records)) return whole.records.map(normalizeRecord)
  } catch {
    // fall through to line-delimited
  }
  return trimmed.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => normalizeRecord(JSON.parse(l)))
}

async function fetchOhlcv1m({ symbol, start, end, stypeIn = 'continuous' }) {
  const url = new URL('/v0/timeseries.get_range', 'https://hist.databento.com')
  url.searchParams.set('dataset', DATASET)
  url.searchParams.set('schema', 'ohlcv-1m')
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
  return parseOhlcvRecords(await res.text())
}

function parseBarInstant(tsEvent) {
  if (tsEvent === null || tsEvent === undefined) return null
  if (typeof tsEvent === 'string' && /^\d+$/.test(tsEvent)) return new Date(Number(BigInt(tsEvent) / 1000000n))
  if (typeof tsEvent === 'number') return new Date(tsEvent / 1e6)
  const parsed = new Date(tsEvent)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

const FILL_PRICE_EPSILON = 0.0001
function barTouchesPrice(bar, price) {
  return price >= bar.low - FILL_PRICE_EPSILON && price <= bar.high + FILL_PRICE_EPSILON
}

async function part1_investigate7e8616fb(admin) {
  log('=== PART 1: 7e8616fb wide search ===')
  const TRADE_ID = '7e8616fb-334b-4465-8a2f-e572b634df5a'
  const { data: trade, error } = await admin.from('trades').select('*').eq('id', TRADE_ID).single()
  if (error) throw new Error(error.message)
  log(`Trade: trade_date=${trade.trade_date} trade_time=${trade.trade_time} exit_time=${trade.exit_time} direction=${trade.direction} entry=${trade.entry} exit_price=${trade.exit_price} target=${trade.target} stop=${trade.stop}`)

  // Wide window: the full calendar day before, of, and after the logged
  // trade_date, in UTC (generous enough to cover any ET session shift).
  const [y, m, d] = trade.trade_date.split('-').map(Number)
  const windowStart = new Date(Date.UTC(y, m - 1, d - 1, 0, 0, 0))
  const windowEnd = new Date(Date.UTC(y, m - 1, d + 2, 0, 0, 0)) // exclusive-safe padding

  // Both candidate contracts already identified in PR #122 for this trade's
  // roll-proximity window: NQU6 (instrument_id=42004177, the volume winner)
  // and NQM6 (instrument_id=42004058, what NQ.c.0 resolved to).
  const candidates = [
    { label: 'NQU6 (volume-based, PR #122)', instrumentId: '42004177' },
    { label: 'NQM6 (NQ.c.0, PR #122)', instrumentId: '42004058' },
  ]

  for (const c of candidates) {
    log(`--- Searching ${c.label} across ${windowStart.toISOString()} to ${windowEnd.toISOString()} ---`)
    let bars
    try {
      bars = await fetchOhlcv1m({ symbol: c.instrumentId, stypeIn: 'instrument_id', start: windowStart.toISOString(), end: windowEnd.toISOString() })
    } catch (err) {
      log(`  fetch failed: ${err.message}`)
      continue
    }
    log(`  ${bars.length} bars fetched.`)
    const parsed = bars.map((b) => ({ ...b, instant: parseBarInstant(b.tsEvent) })).filter((b) => b.instant).sort((a, b) => a.instant - b.instant)

    for (const [label, price] of [['entry', trade.entry], ['exit/target', trade.exit_price]]) {
      const matches = parsed.filter((b) => barTouchesPrice(b, price))
      if (matches.length === 0) {
        log(`  No bar anywhere in the 3-day window touches ${label} price ${price}.`)
      } else {
        log(`  ${matches.length} bar(s) touch ${label} price ${price}. First: ${matches[0].instant.toISOString()}, last: ${matches[matches.length - 1].instant.toISOString()}`)
        // Show up to 5 examples spread across the match set for context.
        const step = Math.max(1, Math.floor(matches.length / 5))
        for (let i = 0; i < matches.length; i += step) {
          log(`    e.g. ${matches[i].instant.toISOString()} high=${matches[i].high} low=${matches[i].low}`)
        }
      }
    }
  }
}

async function part2_investigate137c4594(admin) {
  log('=== PART 2: 137c4594 raw fields + bars ===')
  const TRADE_ID = '137c4594-c6d0-40f1-904f-acb9e71d9ef6'
  const { data: trade, error } = await admin.from('trades').select('*').eq('id', TRADE_ID).single()
  if (error) throw new Error(error.message)
  log('Raw fields: ' + JSON.stringify(trade, null, 2))

  const { data: { user } } = await admin.auth.admin.getUserById(trade.user_id)
  const offsetHours = parseFloat(user?.user_metadata?.timezone)
  log(`Timezone offset: ${offsetHours}`)

  function wallClockToInstant(dateStr, timeStr, offset) {
    const [y, mo, d] = dateStr.split('-').map(Number)
    const [hh, mm, ss] = timeStr.split(':').map(Number)
    return new Date(Date.UTC(y, mo - 1, d, hh, mm, ss || 0) - offset * 3600000)
  }
  const entryInstant = wallClockToInstant(trade.trade_date, trade.trade_time, offsetHours)
  const exitInstant = wallClockToInstant(trade.trade_date, trade.exit_time, offsetHours)
  log(`entryInstant=${entryInstant.toISOString()} exitInstant=${exitInstant.toISOString()}`)

  // Not near a roll (per PR #122's diagnostic) - NQ.c.0 is the right symbol.
  const padMs = 5 * 60000
  const bars = await fetchOhlcv1m({
    symbol: 'NQ.c.0',
    start: new Date(Math.min(entryInstant, exitInstant) - padMs).toISOString(),
    end: new Date(Math.max(entryInstant, exitInstant) + padMs).toISOString(),
  })
  const parsed = bars.map((b) => ({ ...b, instant: parseBarInstant(b.tsEvent) })).filter((b) => b.instant).sort((a, b) => a.instant - b.instant)
  log(`${parsed.length} bars fetched around entry/exit (±5min pad).`)
  for (const b of parsed) {
    const touchesEntry = barTouchesPrice(b, trade.entry)
    const touchesExit = trade.exit_price !== null ? barTouchesPrice(b, trade.exit_price) : false
    const touchesStop = trade.stop !== null ? barTouchesPrice(b, trade.stop) : false
    log(`  ${b.instant.toISOString()} O=${b.open} H=${b.high} L=${b.low} C=${b.close}${touchesEntry ? ' [ENTRY]' : ''}${touchesExit ? ' [EXIT]' : ''}${touchesStop ? ' [STOP]' : ''}`)
  }
}

async function part3_endInclusivitySmokeTest() {
  log('=== PART 3: Databento end-inclusivity smoke test ===')
  // A known, actively-traded 3-minute window (from PR #122's own confirmed
  // real data - NQU6, instrument_id=42004177, session 2026-06-16).
  const start = '2026-06-16T14:00:00Z'
  const end = '2026-06-16T14:03:00Z' // exactly 3 minutes after start
  log(`Requesting instrument_id=42004177, start=${start}, end=${end} (expect bars at :00, :01, :02 if end is exclusive; also :03 if inclusive)`)
  const bars = await fetchOhlcv1m({ symbol: '42004177', stypeIn: 'instrument_id', start, end })
  const parsed = bars.map((b) => ({ ...b, instant: parseBarInstant(b.tsEvent) })).filter((b) => b.instant).sort((a, b) => a.instant - b.instant)
  log(`Bars returned: ${parsed.map((b) => b.instant.toISOString()).join(', ')}`)
  const hasEndBar = parsed.some((b) => b.instant.toISOString() === '2026-06-16T14:03:00.000Z')
  log(hasEndBar ? 'CONCLUSION: end is INCLUSIVE - the bar timestamped exactly at end WAS present.' : 'CONCLUSION: end is EXCLUSIVE - the bar timestamped exactly at end was NOT present.')
}

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set')
  const admin = createClient(supabaseUrl, serviceKey)

  await part1_investigate7e8616fb(admin)
  await part2_investigate137c4594(admin)
  await part3_endInclusivitySmokeTest()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
