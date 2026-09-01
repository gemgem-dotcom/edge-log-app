#!/usr/bin/env node

// Fetches NQ's completed daily session stats from Databento and stores them
// in market_session_stats - see the .github/workflows/refresh-market-
// session-stats.yml this runs under, and the comment above `create table
// market_session_stats` in schema.sql for the full picture.
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

const DATA_SYMBOL = 'NQ'
const DATABENTO_SYMBOL = 'NQ.c.0'
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

function normalizeRecord(record) {
  return {
    high: record.high / PRICE_SCALE,
    low: record.low / PRICE_SCALE,
    volume: Number(record.volume),
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

async function fetchOhlcv1m({ symbol, start, end }) {
  const url = new URL('/v0/timeseries.get_range', 'https://hist.databento.com')
  url.searchParams.set('dataset', DATASET)
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

  log(`Fetching NQ ohlcv-1m for session ${sessionDate} (${start} to ${end})`)

  let bars
  try {
    bars = await fetchOhlcv1m({ symbol: DATABENTO_SYMBOL, start, end })
  } catch (err) {
    // Fail gracefully: skip this day rather than crash the job, so a
    // Databento outage or an unresolved symbol on some future date doesn't
    // take the whole scheduled workflow down. Still reported to Sentry
    // (not re-thrown) - a graceful skip is invisible in the GitHub Actions
    // UI unless someone happens to open that run's log, which is exactly
    // how a persistent, silent failure (an expired API key, a shifted
    // embargo window) could go unnoticed for a long time - see the systems-
    // map audit's finding #2.
    Sentry.captureMessage(`Databento fetch failed, skipping ${sessionDate}: ${err.message}`, 'warning')
    log(`Databento fetch failed, skipping ${sessionDate}: ${err.message}`)
    return
  }

  if (bars.length === 0) {
    log(`No bars returned for ${sessionDate} - skipping (nothing to store).`)
    return
  }

  const totalHigh = Math.max(...bars.map((b) => b.high))
  const totalLow = Math.min(...bars.map((b) => b.low))
  const totalRange = totalHigh - totalLow
  const totalVolume = bars.reduce((sum, b) => sum + b.volume, 0)

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set')
  const admin = createClient(supabaseUrl, serviceKey)

  const { error } = await admin.from('market_session_stats').upsert(
    { data_symbol: DATA_SYMBOL, session_date: sessionDate, total_range: totalRange, total_volume: totalVolume },
    { onConflict: 'data_symbol,session_date' }
  )
  if (error) throw new Error(`Supabase upsert failed: ${error.message}`)

  log(`Stored ${sessionDate}: range=${totalRange.toFixed(2)} volume=${totalVolume}`)

  // Backfill regime on every trade dated this session, across every user,
  // now that it's actually computable - see the file header comment. Kept
  // in its own try/catch so a problem here (or simply too little trailing
  // history yet - see the trailing.length check) never undoes or fails the
  // stats write above, which is the primary, already-succeeded job.
  try {
    const { data: trailing } = await admin
      .from('market_session_stats')
      .select('total_range, total_volume')
      .eq('data_symbol', DATA_SYMBOL)
      .lt('session_date', sessionDate)
      .order('session_date', { ascending: false })
      .limit(TRAILING_WINDOW)

    if (!trailing || trailing.length === 0) {
      log(`No trailing history yet for ${sessionDate} - skipping regime backfill.`)
    } else {
      const avgRange = trailing.reduce((s, r) => s + r.total_range, 0) / trailing.length
      const avgVolume = trailing.reduce((s, r) => s + r.total_volume, 0) / trailing.length
      const volatility_regime = bucketFor(totalRange, avgRange)
      const volume_regime = bucketFor(totalVolume, avgVolume)

      // One query, a real server-side join (PostgREST's `!inner` embed) on
      // trades.instrument_id -> instruments.id, filtered by the joined
      // row's data_symbol - not "fetch every NQ instrument's id into a JS
      // array, then .in() against it". That two-step version's array grows
      // with the total number of NQ instruments ever created across every
      // user; this version's cost is set by Postgres's own query planner
      // (index-backed, same as any other join) regardless of how many
      // users the app has.
      const { data: tradesToBackfill } = await admin
        .from('trades')
        .select('id, instruments!inner(data_symbol)')
        .eq('instruments.data_symbol', DATA_SYMBOL)
        .eq('trade_date', sessionDate)
        .or('volatility_regime.is.null,volume_regime.is.null')

      if (!tradesToBackfill || tradesToBackfill.length === 0) {
        log(`No trades to backfill regime for ${sessionDate}.`)
      } else {
        const { error: backfillError } = await admin
          .from('trades')
          .update({ volatility_regime, volume_regime })
          .in('id', tradesToBackfill.map((t) => t.id))
        if (backfillError) throw new Error(`Regime backfill update failed: ${backfillError.message}`)
        log(`Backfilled regime (${volatility_regime}/${volume_regime}) on ${tradesToBackfill.length} trade(s) for ${sessionDate}.`)
      }
    }
  } catch (err) {
    Sentry.captureMessage(`Regime backfill failed for ${sessionDate}: ${err.message}`, 'warning')
    log(`Regime backfill failed for ${sessionDate}: ${err.message}`)
  }
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
