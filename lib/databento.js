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

const BASE_URL = 'https://hist.databento.com'
const DATASET = 'GLBX.MDP3'

// NQ's Databento continuous front-month symbol - see lib/instrumentCatalog.js
// for why "NQ" is the right data_symbol to hang this off, and §1's brief for
// why this pass is deliberately scoped to just this one symbol rather than
// looping the full instrument catalog. `stype_in: 'continuous'` resolves the
// rolling front-month contract for us, so this module never has to reason
// about contract rollover itself (lib/contractRollover.js is unrelated - a
// display-only concern for the trade log, not the fetch layer).
export const NQ_CONTINUOUS_SYMBOL = 'NQ.c.0'

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
// would reject (or bill differently for) a range that isn't.
export async function fetchOhlcv1m({ symbol, start, end, dataset = DATASET }) {
  const url = new URL('/v0/timeseries.get_range', BASE_URL)
  url.searchParams.set('dataset', dataset)
  url.searchParams.set('schema', 'ohlcv-1m')
  url.searchParams.set('symbols', symbol)
  url.searchParams.set('stype_in', 'continuous')
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
