#!/usr/bin/env node

// Fetches every catalog instrument's completed daily session stats from
// Databento and stores them in market_session_stats - see the
// .github/workflows/refresh-market-session-stats.yml this runs under, and
// the comment above `create table market_session_stats` in schema.sql for
// the full picture.
//
// One row per EXACT contract (all 12 of lib/instrumentCatalog.js's symbols,
// full-size and micro alike), not one per data_symbol family. A mini and
// its own micro track the same underlying but trade on separate order
// books, so their own range/volume genuinely differ - bucketing an MNQ
// trade against NQ's numbers would be measuring a market the trader wasn't
// in. market_session_stats' key column is still named `data_symbol` (it was
// always free-text, never FK'd to instruments.data_symbol, so widening what
// it holds needed no schema change), but every row written here now stores
// the exact catalog symbol.
//
// Deliberately standalone rather than importing lib/databento.js or
// lib/marketHours.js: this repo has no "type": "module" in package.json, so
// those files' `export`/`import` syntax isn't reliably loadable from a
// plain `node scripts/...` invocation the way Next.js's own bundler handles
// it (confirmed: Node will reparse a bare .js file as ESM on a syntax
// error, but that's a documented fallback path with a performance warning,
// not something to depend on in CI) - the same reason
// scripts/generate_cme_holidays.py is already a fully separate script
// rather than sharing code with the JS app. The two small pieces of logic
// duplicated below (the ET UTC-offset math, and the Databento HTTP call)
// are kept intentionally minimal so there's little for the two copies to
// drift on; lib/cmeHolidays.json itself - the one thing that actually needs
// to be a single source of truth - is required directly, not duplicated.
//
// Historical only, same as lib/databento.js - never fetches anything less
// than a full calendar day old.
//
// Also backfills volatility_regime/volume_regime (see lib/tradeRegimes.js)
// on every trade dated the session just fetched, across every user, right
// after storing that day's stats row - the moment a date's regime becomes
// computable at all, this closes the gap for everyone at once rather than
// leaving it for each trader's own next app-open to lazily discover (the
// old design - see the systems-map audit's "lazily recomputed client-side"
// finding). bucketFor/HIGH_RATIO/LOW_RATIO/TRAILING_WINDOW below are a
// duplicate of lib/tradeRegimes.js's own copy for the same reason this
// file already duplicates the ET-offset math instead of importing it - see
// the paragraph above.
//
// Usage: node scripts/fetch-daily-market-stats.js
// Env: DATABENTO_API_KEY, SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL

const { createClient } = require('@supabase/supabase-js')
const Sentry = require('@sentry/node')
const CME_HOLIDAYS = require('../lib/cmeHolidays.json')

// NEXT_PUBLIC_SENTRY_DSN, not a separate SENTRY_DSN - same "one env var, read
// server-side too" convention this file already follows for
// NEXT_PUBLIC_SUPABASE_URL below. No-ops (enabled: false) if the secret was
// never added to this repo's GitHub Actions secrets - see .github/workflows
// /refresh-market-session-stats.yml's own comment.
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0,
  enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
})

// Every symbol in lib/instrumentCatalog.js, duplicated here rather than
// imported for the same ESM reason the header gives for lib/databento.js -
// treat adding an instrument to that catalog as also needing an entry here.
// Each fetches its own `${symbol}.c.0` continuous front-month contract;
// every one of these was confirmed to resolve live against a real API key
// (scripts/smoke-test-databento-symbols.js) rather than assumed, except GC,
// which needs the volume fallback in fetchSessionBars below.
const SYMBOLS = ['NQ', 'MNQ', 'ES', 'MES', 'YM', 'MYM', 'GC', 'MGC', 'CL', 'MCL', 'BTC', 'MBT']
const DATASET = 'GLBX.MDP3'
const PRICE_SCALE = 1e9

// Regime-bucketing constants, mirrored from lib/tradeRegimes.js - see that
// file's own comment on the +/-15% banding choice.
const TRAILING_WINDOW = 20
const HIGH_RATIO = 1.15
const LOW_RATIO = 0.85

function bucketFor(value, average) {
  if (!average) return 'normal'
  const ratio = value / average
  if (ratio >= HIGH_RATIO) return 'high'
  if (ratio <= LOW_RATIO) return 'low'
  return 'normal'
}

function log(...args) {
  console.log(new Date().toISOString(), ...args)
}

// ET UTC offset (in minutes, ET minus UTC - e.g. -300 for EST, -240 for
// EDT) in effect on a given ET calendar date. Sampled at UTC noon, which is
// never near the ~2am ET DST transition, so this is safe for any date.
// Mirrors lib/marketHours.js's easternParts, just inlined - see the file
// header comment for why this isn't a shared import.
function etOffsetMinutesFor(dateStr) {
  const noonUtc = new Date(`${dateStr}T12:00:00Z`)
  const etString = noonUtc.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' })
  const [h, m] = etString.split(':').map(Number)
  const etMinutesOfDay = (h % 24) * 60 + m
  let offset = etMinutesOfDay - 12 * 60
  if (offset > 720) offset -= 1440
  if (offset <= -720) offset += 1440
  return offset
}

// weekday: 0 = Sunday ... 6 = Saturday, in ET.
function etWeekdayFor(dateStr) {
  const noonUtc = new Date(`${dateStr}T12:00:00Z`)
  const weekdayString = noonUtc.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' })
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[weekdayString]
}

// Converts an ET wall-clock instant (dateStr + minutes since midnight ET)
// into a UTC Date, correctly rolling over the calendar date when
// minutesOfDay is negative or exceeds 1440 (used below for "6pm the day
// before").
function etWallClockToUtc(dateStr, minutesOfDay) {
  const offset = etOffsetMinutesFor(dateStr)
  const [y, m, d] = dateStr.split('-').map(Number)
  const baseUtcMs = Date.UTC(y, m - 1, d, 0, 0, 0)
  return new Date(baseUtcMs + (minutesOfDay - offset) * 60000)
}

function addDaysToDateStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

function authHeader() {
  const apiKey = process.env.DATABENTO_API_KEY
  if (!apiKey) throw new Error('DATABENTO_API_KEY is not set')
  return 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64')
}

// instrumentId is only read by resolveFrontMonthInstrumentId below (an
// OHLCV record carries no `symbol` of its own, just this raw numeric id);
// every other caller ignores it. Same shape lib/databento.js's own
// normalizeRecord returns, for the same reason.
function normalizeRecord(record) {
  return {
    high: record.high / PRICE_SCALE,
    low: record.low / PRICE_SCALE,
    volume: Number(record.volume),
    instrumentId: record.hd?.instrument_id ?? null,
  }
}

// Databento's JSON encoding is newline-delimited (one record per line), not
// a single JSON array - parsed defensively so a slightly-off format
// assumption degrades to "handle it anyway" rather than crashing outright.
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
  return trimmed.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => normalizeRecord(JSON.parse(l)))
}

async function fetchOhlcv1m({ symbols, stypeIn, start, end }) {
  const url = new URL('/v0/timeseries.get_range', 'https://hist.databento.com')
  url.searchParams.set('dataset', DATASET)
  url.searchParams.set('schema', 'ohlcv-1m')
  url.searchParams.set('symbols', symbols)
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

// Which contract actually traded the most volume across the window, as a
// raw instrument_id - resolved through parent symbology (`${root}.FUT`)
// rather than the continuous `.c.0` shortcut. Same aggregation
// lib/databento.js's own resolveFrontMonthByVolume does for NQ near a
// quarterly roll; returns null (caller gives up on this symbol for today)
// if the fetch or the aggregation comes up empty.
async function resolveFrontMonthInstrumentId(root, start, end) {
  let records
  try {
    records = await fetchOhlcv1m({ symbols: `${root}.FUT`, stypeIn: 'parent', start, end })
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

// Continuous front-month first, falling back to resolving the actual
// highest-volume contract by hand when that comes back empty.
//
// The fallback exists because GC.c.0 genuinely does not resolve on this
// account: confirmed live (scripts/smoke-test-databento-symbols.js) that it
// returns zero bars even across a 6-hour core-hours window, on a day when a
// parent-symbology lookup for that identical window has real gold data, and
// when its own micro sibling MGC.c.0 resolves fine. So it's specific to
// that root's continuous resolution, not entitlement or market hours.
//
// Written as "whenever continuous is empty" rather than "if symbol is GC"
// deliberately: the same quirk showing up on another root later (or GC's
// resolution being fixed upstream) then needs no code change either way,
// and an empty continuous result is exactly the signal to fall back on
// regardless of which symbol produced it. The extra request only ever
// happens on a symbol that returned nothing, so a normal day still costs
// one request per symbol.
async function fetchSessionBars(symbol, start, end) {
  const bars = await fetchOhlcv1m({ symbols: `${symbol}.c.0`, stypeIn: 'continuous', start, end })
  if (bars.length > 0) return bars

  const instrumentId = await resolveFrontMonthInstrumentId(symbol, start, end)
  if (instrumentId === null) return []
  log(`${symbol}: continuous (.c.0) returned nothing - falling back to instrument_id ${instrumentId} (highest volume this session).`)
  return fetchOhlcv1m({ symbols: String(instrumentId), stypeIn: 'instrument_id', start, end })
}

function parseCloseMinutes(closeTime) {
  const [h, m] = closeTime.split(':').map(Number)
  return h * 60 + m
}

async function main() {
  // This account's access to GLBX.MDP3 lags wall-clock time by ~8 hours -
  // confirmed empirically (two live runs, hours apart, both blocked with
  // Databento's "requires a subscription and/or license" error, each
  // exactly 8h behind the request time) rather than assumed. The job used
  // to run the same evening (23:30 UTC) and fetch "today"'s just-closed
  // session, which an 8-hour-behind account can never actually see yet at
  // that hour - CME's own close (~21:00-22:00 UTC) is itself less than 8
  // hours before 23:30 UTC. It now runs the following morning instead (see
  // the workflow's cron), by which point the embargo has cleared - so
  // "today" in ET at run time is the morning after the session actually
  // closed, and the session to fetch is *yesterday's* ET date, not today's.
  const now = new Date()
  // en-CA formats as YYYY-MM-DD directly - avoids round-tripping a
  // locale-formatted string back through the Date constructor, which isn't
  // a reliably parseable format.
  const nowEt = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const sessionDate = addDaysToDateStr(nowEt, -1)

  const weekday = etWeekdayFor(sessionDate)
  if (weekday === 0 || weekday === 6) {
    log(`${sessionDate} is a weekend in ET - no session, skipping.`)
    return
  }

  const holiday = CME_HOLIDAYS[sessionDate]
  if (holiday?.type === 'closed') {
    log(`${sessionDate} is a full CME holiday (${holiday.name}) - skipping.`)
    return
  }

  const closeMinutes = holiday?.type === 'early_close' ? parseCloseMinutes(holiday.closeTime) : 17 * 60
  const priorDay = addDaysToDateStr(sessionDate, -1)
  // CME's trading day runs from the prior day's 6pm ET reopen through
  // that day's close - same "day starts at the prior evening" convention
  // lib/marketHours.js's computeOpen already uses for market-open/close.
  const start = etWallClockToUtc(priorDay, 18 * 60).toISOString()
  // `end` is exactly the session-close instant. Databento's `end` is
  // exclusive (confirmed live - see lib/databento.js's header), but since
  // every bar is timestamped by its start, the bar that would sit exactly
  // at `end` would cover the minute *after* close - never part of this
  // session - so excluding it costs nothing.
  const end = etWallClockToUtc(sessionDate, closeMinutes).toISOString()

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set')
  const admin = createClient(supabaseUrl, serviceKey)

  // Sequential, not Promise.all: 12 symbols x 1-2 requests is well within
  // any sane rate limit run one at a time, and a burst of a dozen parallel
  // range requests is exactly the shape of traffic a historical API is
  // likely to throttle. The whole job has a full day before it needs to
  // finish, so there's nothing to gain from the parallel version.
  for (const symbol of SYMBOLS) {
    await fetchAndStoreSymbol(admin, symbol, sessionDate, start, end)
  }
}

// One symbol's whole pass: fetch, store, backfill regime for that session,
// then catch up any older dates still missing it. Every failure inside is
// contained to this symbol - a symbol whose fetch dies (or whose backfill
// throws) must not stop the remaining 11 from being stored, since they're
// entirely independent series.
async function fetchAndStoreSymbol(admin, symbol, sessionDate, start, end) {
  log(`Fetching ${symbol} ohlcv-1m for session ${sessionDate} (${start} to ${end})`)

  let bars
  try {
    bars = await fetchSessionBars(symbol, start, end)
  } catch (err) {
    // Fail gracefully: skip this symbol rather than crash the job, so a
    // Databento outage or an unresolved symbol on some future date doesn't
    // take the whole scheduled workflow down. Still reported to Sentry
    // (not re-thrown) - a graceful skip is invisible in the GitHub Actions
    // UI unless someone happens to open that run's log, which is exactly
    // how a persistent, silent failure (an expired API key, a shifted
    // embargo window) could go unnoticed for a long time - see the systems-
    // map audit's finding #2.
    Sentry.captureMessage(`Databento fetch failed for ${symbol}, skipping ${sessionDate}: ${err.message}`, 'warning')
    log(`Databento fetch failed for ${symbol}, skipping ${sessionDate}: ${err.message}`)
    return
  }

  if (bars.length === 0) {
    log(`No bars returned for ${symbol} ${sessionDate} - skipping (nothing to store).`)
    return
  }

  const totalHigh = Math.max(...bars.map((b) => b.high))
  const totalLow = Math.min(...bars.map((b) => b.low))
  const totalRange = totalHigh - totalLow
  const totalVolume = bars.reduce((sum, b) => sum + b.volume, 0)

  const { error } = await admin.from('market_session_stats').upsert(
    { data_symbol: symbol, session_date: sessionDate, total_range: totalRange, total_volume: totalVolume },
    { onConflict: 'data_symbol,session_date' }
  )
  if (error) {
    // Same containment as the fetch above - one symbol's write failing
    // shouldn't cost the other 11 theirs.
    Sentry.captureMessage(`Supabase upsert failed for ${symbol} ${sessionDate}: ${error.message}`, 'warning')
    log(`Supabase upsert failed for ${symbol} ${sessionDate}: ${error.message}`)
    return
  }

  log(`Stored ${symbol} ${sessionDate}: range=${totalRange.toFixed(2)} volume=${totalVolume}`)

  // Backfill regime on every trade dated this session, across every user,
  // now that it's actually computable, then separately catch up any
  // *earlier* date that's still missing regime despite already having its
  // own market_session_stats row - e.g. a day this fetch itself failed for
  // (see the catch block a few lines up) and so never got its own chance
  // to backfill. Without this second pass, a skipped day's trades would
  // stay unbucketed forever: nothing else in the app retries an old date,
  // now that regime is computed at save time or on the day it happens
  // (see log/new and log/edit's onSubmit) rather than lazily rechecked on
  // every visit the way it used to be. Both wrapped in their own try/catch
  // so a problem here never undoes or fails the stats write above, which
  // is the primary, already-succeeded part of this job.
  try {
    const regimes = await regimeForSessionDate(admin, symbol, sessionDate, { total_range: totalRange, total_volume: totalVolume })
    if (!regimes) {
      log(`No trailing history yet for ${symbol} ${sessionDate} - skipping regime backfill.`)
    } else {
      const n = await backfillTradesForDate(admin, symbol, sessionDate, regimes)
      log(n === 0 ? `No trades to backfill regime for ${symbol} ${sessionDate}.` : `Backfilled regime (${regimes.volatility_regime}/${regimes.volume_regime}) on ${n} trade(s) for ${symbol} ${sessionDate}.`)
    }
  } catch (err) {
    Sentry.captureMessage(`Regime backfill failed for ${symbol} ${sessionDate}: ${err.message}`, 'warning')
    log(`Regime backfill failed for ${symbol} ${sessionDate}: ${err.message}`)
  }

  try {
    const { data: gapTrades } = await admin
      .from('trades')
      .select('trade_date, instruments!inner(symbol)')
      .eq('instruments.symbol', symbol)
      .neq('trade_date', sessionDate)
      .or('volatility_regime.is.null,volume_regime.is.null')

    const gapDates = [...new Set((gapTrades || []).map((t) => t.trade_date))]
    for (const date of gapDates) {
      const regimes = await regimeForSessionDate(admin, symbol, date)
      if (!regimes) continue // still not computable (e.g. a very recent date) - leave it for a later run
      const n = await backfillTradesForDate(admin, symbol, date, regimes)
      if (n > 0) log(`Backfilled regime (${regimes.volatility_regime}/${regimes.volume_regime}) on ${n} trade(s) for ${symbol} ${date} (gap catch-up).`)
    }
  } catch (err) {
    Sentry.captureMessage(`Regime gap catch-up failed for ${symbol}: ${err.message}`, 'warning')
    log(`Regime gap catch-up failed for ${symbol}: ${err.message}`)
  }
}

// { volatility_regime, volume_regime } for one symbol on `date`, or null if
// not computable yet (no trailing baseline, or - only relevant for the gap
// catch-up path above, since the caller already has today's own row in hand
// - `date` itself has no market_session_stats row for this symbol).
// `ownStats` lets the caller pass the just-fetched totals directly rather
// than immediately re-reading the row it just wrote. Every comparison here
// stays within one symbol's own series: a micro is bucketed against its own
// 20-session history, never its full-size sibling's.
async function regimeForSessionDate(admin, symbol, date, ownStats) {
  let ownRow = ownStats
  if (!ownRow) {
    const { data } = await admin
      .from('market_session_stats')
      .select('total_range, total_volume')
      .eq('data_symbol', symbol)
      .eq('session_date', date)
      .maybeSingle()
    if (!data) return null
    ownRow = data
  }

  const { data: trailing } = await admin
    .from('market_session_stats')
    .select('total_range, total_volume')
    .eq('data_symbol', symbol)
    .lt('session_date', date)
    .order('session_date', { ascending: false })
    .limit(TRAILING_WINDOW)
  if (!trailing || trailing.length === 0) return null

  const avgRange = trailing.reduce((s, r) => s + r.total_range, 0) / trailing.length
  const avgVolume = trailing.reduce((s, r) => s + r.total_volume, 0) / trailing.length
  return { volatility_regime: bucketFor(ownRow.total_range, avgRange), volume_regime: bucketFor(ownRow.total_volume, avgVolume) }
}

// Applies `regimes` to every still-unbucketed trade on this exact symbol
// dated `date`, across every user - a real server-side join (PostgREST's
// `!inner` embed) on trades.instrument_id -> instruments.id, filtered by
// the joined row's symbol, not "fetch every matching instrument's id into a
// JS array, then .in() against it". That two-step version's array grows
// with the total number of such instruments ever created across every user;
// this version's cost is set by Postgres's own query planner (index-backed,
// same as any other join) regardless of how many users the app has.
//
// instruments.symbol (the exact contract, 'MNQ') rather than
// instruments.data_symbol (the family, 'NQ') - matching what
// market_session_stats now stores per row, so an MNQ trade is tagged from
// MNQ's own session and never from NQ's.
// Returns how many rows it updated.
async function backfillTradesForDate(admin, symbol, date, regimes) {
  const { data: trades } = await admin
    .from('trades')
    .select('id, instruments!inner(symbol)')
    .eq('instruments.symbol', symbol)
    .eq('trade_date', date)
    .or('volatility_regime.is.null,volume_regime.is.null')
  if (!trades || trades.length === 0) return 0

  const { error } = await admin.from('trades').update(regimes).in('id', trades.map((t) => t.id))
  if (error) throw new Error(`Regime backfill update failed for ${symbol} ${date}: ${error.message}`)
  return trades.length
}

// A short-lived script's process can exit before Sentry's async transport
// finishes sending, dropping the event entirely - Sentry.flush() waits
// (bounded at 2s) for anything already queued (the captureMessage above, or
// the captureException below) before letting the process end either way.
main()
  .then(() => Sentry.flush(2000))
  .catch(async (err) => {
    Sentry.captureException(err)
    await Sentry.flush(2000)
    console.error(err)
    process.exit(1)
  })
