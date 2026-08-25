// Databento Historical API client - historical only, never live/streaming.
//
// There is no official Databento Node.js/JavaScript SDK (their GitHub org
// ships official clients for Python, Rust, C++, and .NET, but not JS/TS -
// confirmed by searching their own package listings), so this talks to the
// underlying HTTP endpoint (`v0/timeseries.get_range`) directly with
// `fetch`, the same endpoint every official client is itself a wrapper
// around. Databento's own docs site (databento.com) isn't reachable from
// this environment's network egress, so the exact request/response shape
// below was cross-checked instead against a community Databento MCP
// server's TypeScript implementation on GitHub, which calls this same
// endpoint - it's a best-effort reconstruction of the real HTTP contract,
// not a copy of Databento's own documented examples, so smoke-test it
// against a real DATABENTO_API_KEY before trusting it in production.
//
// Never add a live/streaming call here - the free $125 historical credit
// this pass is scoped to doesn't cover the paid CME real-time plan.
//
// Two more things this reconstruction has never been confirmed against a
// real response for, both now load-bearing for lib/tradeExcursions.js's
// fill-instant derivation (findFillInstant/deriveFillInstants): whether
// `end` below is inclusive or exclusive of that exact timestamp, and
// whether ts_event (nanosecond epoch - a documented property of every DBN
// schema, not in question itself) comes back as a numeric string or a
// bare JSON number, since nothing read that field before now. Both are
// handled defensively where they matter rather than assumed; see
// lib/tradeExcursions.js's parseBarInstant for the second one.

import { easternParts } from './marketHours'
import { daysToNearestRollover } from './contractRollover'

const BASE_URL = 'https://hist.databento.com'
const DATASET = 'GLBX.MDP3'

// NQ's Databento continuous front-month symbol - see lib/instrumentCatalog.js
// for why "NQ" is the right data_symbol to hang this off, and §1's brief for
// why this pass is deliberately scoped to just this one symbol rather than
// looping the full instrument catalog. `stype_in: 'continuous'` resolves the
// rolling front-month contract for us - trusted directly outside
// ROLL_PROXIMITY_DAYS of a quarterly roll. Within that window it was
// confirmed (live, PR #122) to disagree with which contract actually traded
// the most that session - resolveFrontMonthByVolume below is the fallback
// for that window, not a replacement for this the rest of the time.
export const NQ_CONTINUOUS_SYMBOL = 'NQ.c.0'

// How close (in days, either direction) a trade's own date needs to be to
// a quarterly NQ roll before resolveFrontMonthByVolume's extra fetch is
// worth paying for - see lib/contractRollover.js's daysToNearestRollover.
// Outside this window the two resolution methods were never observed to
// disagree, so there's nothing to gain from the extra Databento usage.
export const ROLL_PROXIMITY_DAYS = 10

function authHeader() {
  const apiKey = process.env.DATABENTO_API_KEY
  if (!apiKey) throw new Error('DATABENTO_API_KEY is not set')
  // Databento's HTTP API authenticates with HTTP Basic auth: the API key as
  // the username, empty password - not a bearer token.
  return 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64')
}

// Databento's JSON encoding scales price fields to fixed-point integers
// (multiplied by 1e9) to avoid floating-point drift in its binary (DBN)
// encoding; volume is a plain integer, not scaled.
const PRICE_SCALE = 1e9

function normalizeRecord(record) {
  return {
    tsEvent: record.ts_event ?? record.hd?.ts_event ?? null,
    // hd.instrument_id - confirmed against a real response (PR #122's
    // investigation): an OHLCV record has no `symbol` field of its own,
    // only this raw numeric ID. Only used by resolveFrontMonthByVolume
    // below; every other caller ignores it.
    instrumentId: record.hd?.instrument_id ?? null,
    open: record.open / PRICE_SCALE,
    high: record.high / PRICE_SCALE,
    low: record.low / PRICE_SCALE,
    close: record.close / PRICE_SCALE,
    volume: Number(record.volume),
  }
}

// Databento's JSON encoding is newline-delimited (one record object per
// line), not a single JSON array. Parsed defensively: if the whole body
// happens to be a single JSON array or `{records: [...]}` instead, that's
// accepted too, so a format assumption that's slightly off degrades to
// "handle it anyway" instead of throwing on every call.
function parseOhlcvRecords(text) {
  const trimmed = text.trim()
  if (!trimmed) return []

  try {
    const whole = JSON.parse(trimmed)
    if (Array.isArray(whole)) return whole.map(normalizeRecord)
    if (Array.isArray(whole?.records)) return whole.records.map(normalizeRecord)
  } catch {
    // Not a single JSON document - fall through to line-delimited parsing.
  }

  return trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => normalizeRecord(JSON.parse(line)))
}

// Fetch every completed ohlcv-1m bar for one symbol between two instants.
// start/end are ISO 8601 timestamps (with an explicit offset) - the caller
// is responsible for only ever passing a range that's already fully in the
// past, since this module never requests live/streaming data and Databento
// would reject (or bill differently for) a range that isn't. stypeIn
// defaults to 'continuous' (the normal case, NQ_CONTINUOUS_SYMBOL) but
// resolveFrontMonthByVolume's callers pass 'instrument_id' with a raw
// numeric ID instead, once ROLL_PROXIMITY_DAYS applies.
export async function fetchOhlcv1m({ symbol, start, end, dataset = DATASET, stypeIn = 'continuous' }) {
  const url = new URL('/v0/timeseries.get_range', BASE_URL)
  url.searchParams.set('dataset', dataset)
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

// 6pm ET the evening before `instant`'s own ET calendar date, through 6pm
// ET on that date - the same CME-trading-day rule scripts/
// backfill_trade_excursions_from_dbn.py's session_date_for uses, built on
// lib/marketHours.js's easternParts rather than a third independent ET
// reimplementation. Only needed for summing volume across a whole session
// (resolveFrontMonthByVolume) - nothing else here reasons about session
// boundaries.
function sixPmEtUtc(dateUtcMidnight) {
  // Seeded ~22h in (not at midnight itself) so the guess starts already
  // inside the target ET calendar day - ET trails UTC, so a guess seeded
  // at UTC midnight lands in the *previous* ET day, and the loop below
  // (which only compares minutesOfDay) would converge on 6pm the day
  // before instead of correcting the date too.
  let guess = new Date(dateUtcMidnight.getTime() + 22 * 3600000)
  for (let i = 0; i < 3; i++) {
    const { minutesOfDay } = easternParts(guess)
    const diffMinutes = 18 * 60 - minutesOfDay
    guess = new Date(guess.getTime() + diffMinutes * 60000)
  }
  return guess
}

export function sessionBoundsFor(instant) {
  const { minutesOfDay, dateStr } = easternParts(instant)
  const [y, m, d] = dateStr.split('-').map(Number)
  let sessionDateUtc = new Date(Date.UTC(y, m - 1, d))
  if (minutesOfDay >= 18 * 60) sessionDateUtc = new Date(sessionDateUtc.getTime() + 24 * 3600000)
  const end = sixPmEtUtc(sessionDateUtc)
  const start = sixPmEtUtc(new Date(sessionDateUtc.getTime() - 24 * 3600000))
  return { start, end }
}

// Which NQ contract actually traded the most volume across a whole
// session - confirmed live (PR #122) to disagree with NQ_CONTINUOUS_
// SYMBOL's own resolution within ROLL_PROXIMITY_DAYS of a quarterly roll:
// real trading volume can move to the next contract several days before
// Databento's own continuous-roll rule catches up. Returns a raw
// instrument_id (not a symbol string - fetchOhlcv1m takes it directly via
// stypeIn: 'instrument_id'), or null if the fetch or aggregation comes up
// empty, so callers can fall back to NQ_CONTINUOUS_SYMBOL rather than fail
// outright.
export async function resolveFrontMonthByVolume({ sessionStart, sessionEnd, dataset = DATASET }) {
  let records
  try {
    const url = new URL('/v0/timeseries.get_range', BASE_URL)
    url.searchParams.set('dataset', dataset)
    url.searchParams.set('schema', 'ohlcv-1m')
    url.searchParams.set('symbols', 'NQ.FUT')
    url.searchParams.set('stype_in', 'parent')
    url.searchParams.set('start', sessionStart.toISOString())
    url.searchParams.set('end', sessionEnd.toISOString())
    url.searchParams.set('encoding', 'json')
    const res = await fetch(url, { headers: { Authorization: authHeader() } })
    if (!res.ok) return null
    records = parseOhlcvRecords(await res.text())
  } catch {
    return null
  }

  const volumeByInstrument = new Map()
  for (const r of records) {
    if (r.instrumentId === null || r.instrumentId === undefined) continue
    volumeByInstrument.set(r.instrumentId, (volumeByInstrument.get(r.instrumentId) || 0) + r.volume)
  }

  let bestId = null
  let bestVolume = -1
  for (const [id, vol] of volumeByInstrument) {
    if (vol > bestVolume) {
      bestVolume = vol
      bestId = id
    }
  }
  return bestId
}

// True when `dataSymbol`'s trade date sits within ROLL_PROXIMITY_DAYS of a
// quarterly roll - the shared gate callers use to decide whether
// resolveFrontMonthByVolume's extra fetch is worth paying for.
export function isNearRollover(dataSymbol, tradeDate) {
  const distance = daysToNearestRollover(dataSymbol, new Date(tradeDate + 'T00:00:00Z'))
  return distance !== null && distance <= ROLL_PROXIMITY_DAYS
}
