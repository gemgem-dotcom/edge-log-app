#!/usr/bin/env node

// Fetches Forex Factory's economic calendar into economic_events - see
// .github/workflows/refresh-economic-calendar.yml (the hourly schedule)
// and schema.sql's comment above `create table economic_events`.
//
// SOURCE: forexfactory.com/calendar's own HTML, parsed by
// lib/econCalendarHtml.mjs. This used to read FF's published JSON feed
// instead; that feed is still used as a fallback below, but it cannot be
// the primary source because it carries exactly one week and no `actual`
// column at all - both confirmed live. The page carries any week or month,
// actual values, FF's own beat/miss marking, revised-previous flags, and
// FF's own event ids.
//
// ON ACCESS, stated plainly because "scrape Forex Factory" usually means
// something worse: the page is served to this script's honest,
// self-identifying User-Agent. A stock browser User-Agent is what gets a
// Cloudflare challenge - verified in both directions by
// scripts/probe-forexfactory-sources.js. So nothing here circumvents an
// access control, and nothing here pretends to be a browser, solves a
// challenge, or evades a bot check. If the honest request ever stops being
// served, the fix is a different source, not a sneakier request.
//
// TIMEZONE: never assumed. FF prints wall-clock times in its own display
// timezone, but each day's first row carries data-day-dateline, the Unix
// epoch of midnight in that timezone. Midnight plus the row's clock time
// is the exact instant, so a change to FF's display timezone (or a DST
// boundary) cannot silently shift every stored timestamp.
//
// SCOPE, chosen by env so one script serves all three jobs:
//   - default (both vars unset): this week only. One ~400KB page, which is
//     what the hourly schedule runs - enough to pick up actuals as they
//     print and any reschedule within the week.
//   - CALENDAR_MONTHS_BACK / CALENDAR_MONTHS_FORWARD: month pages across
//     that span instead. A month page is ~1.6MB and covers 4-5 weeks, so
//     it is the cheaper unit per event for anything wider than a week.
//     Used by the daily forward-fill and by a manual backfill.
//
// Nothing here ever deletes. Rows upsert on event_key (day|currency|title),
// so a re-fetch updates the release it already has - filling in an actual,
// moving a rescheduled time - rather than inserting a second copy.
//
// Usage:
//   node scripts/fetch-economic-calendar.js
//   CALENDAR_MONTHS_BACK=6 node scripts/fetch-economic-calendar.js
// Env: SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL

const { createClient } = require('@supabase/supabase-js')
const Sentry = require('@sentry/node')

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0,
  enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
})

// Identifies this app rather than pretending to be a browser - see the
// header. This is the User-Agent that actually gets served.
const USER_AGENT = 'EdgeLog/1.0 (trading journal; +https://github.com/gemgem-dotcom/edge-log-app)'
const JSON_FEED = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json'
const FETCH_TIMEOUT_MS = 30000
const FETCH_ATTEMPTS = 3
const UPSERT_CHUNK = 200
// Spacing between page fetches. A backfill walks a lot of months, and
// there is no reason for it to look like a burst against someone else's
// site; nothing downstream cares whether a backfill takes a few minutes.
const PAGE_GAP_MS = 1500

function log(...args) {
  console.log(new Date().toISOString(), ...args)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Retries network errors and 5xx, never a 4xx - a 403 means we are being
// refused, and asking three times over neither changes that answer nor is
// a polite thing to do with it.
async function fetchPage(url, accept) {
  let lastError = null
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: accept },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (res.status >= 400 && res.status < 500) {
        throw new Error(`${url} returned ${res.status} (not retried)`)
      }
      if (!res.ok) throw new Error(`${url} returned ${res.status}`)
      return await res.text()
    } catch (err) {
      lastError = err
      if (/not retried/.test(err.message) || attempt === FETCH_ATTEMPTS) break
      const backoffMs = 1000 * 2 ** (attempt - 1)
      log(`  attempt ${attempt} failed (${err.message}) - retrying in ${backoffMs}ms`)
      await sleep(backoffMs)
    }
  }
  throw lastError
}

async function storeEvents(admin, events) {
  let stored = 0
  for (let i = 0; i < events.length; i += UPSERT_CHUNK) {
    const chunk = events.slice(i, i + UPSERT_CHUNK)
    const { error } = await admin
      .from('economic_events')
      .upsert(chunk.map((e) => ({ ...e, fetched_at: new Date().toISOString() })), { onConflict: 'event_key' })
    if (error) throw new Error(`Supabase upsert failed: ${error.message}`)
    stored += chunk.length
  }
  return stored
}

function monthsAround(back, forward) {
  const out = []
  const now = new Date()
  for (let offset = -back; offset <= forward; offset++) {
    out.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1, 12)))
  }
  return out
}

// The JSON feed, used only when the HTML yielded nothing for the current
// week. It has no actuals and only ever covers this week, so it is a floor
// rather than a source: if FF's markup changes under us, the card keeps
// showing a current, correct schedule while the parser is fixed, instead
// of silently going stale.
async function fallbackToJsonFeed(admin, normalizeFeed) {
  log('HTML yielded no events - falling back to the JSON feed for this week')
  const body = await fetchPage(JSON_FEED, 'application/json')
  const { events, skipped } = normalizeFeed(JSON.parse(body))
  if (skipped > 0) log(`  json feed: skipped ${skipped} unusable record(s)`)
  if (events.length === 0) throw new Error('JSON feed fallback also produced no events')
  const stored = await storeEvents(admin, events)
  log(`  json feed: stored ${stored} event(s)`)
  return stored
}

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set')
  const admin = createClient(supabaseUrl, serviceKey)

  // Dynamic import: these are .mjs so a CommonJS script can read them -
  // see lib/econCalendarEvents.mjs's own header for why they are shared
  // rather than duplicated.
  const { parseCalendarHtml, weekUrl, monthUrl } = await import('../lib/econCalendarHtml.mjs')
  const { normalizeFeed } = await import('../lib/econCalendarEvents.mjs')

  const monthsBack = Number(process.env.CALENDAR_MONTHS_BACK || 0)
  const monthsForward = Number(process.env.CALENDAR_MONTHS_FORWARD || 0)
  if (!Number.isFinite(monthsBack) || !Number.isFinite(monthsForward) || monthsBack < 0 || monthsForward < 0) {
    throw new Error('CALENDAR_MONTHS_BACK / CALENDAR_MONTHS_FORWARD must be non-negative numbers')
  }

  const wide = monthsBack > 0 || monthsForward > 0
  const targets = wide
    ? monthsAround(monthsBack, monthsForward).map((d) => ({ label: `month ${d.toISOString().slice(0, 7)}`, url: monthUrl(d) }))
    : [{ label: 'this week', url: weekUrl(new Date()) }]

  log(`Fetching ${targets.length} page(s): ${wide ? `months -${monthsBack}..+${monthsForward}` : 'this week'}`)

  let totalStored = 0
  let totalEvents = 0
  let failures = 0

  for (const [i, target] of targets.entries()) {
    if (i > 0) await sleep(PAGE_GAP_MS)
    try {
      const html = await fetchPage(target.url, 'text/html')
      const { events, skipped, days } = parseCalendarHtml(html)
      if (skipped > 0) log(`  ${target.label}: skipped ${skipped} unusable row(s)`)
      if (events.length === 0) {
        // A real calendar page always has events. Zero means the markup
        // moved, so say so loudly rather than reporting a clean run that
        // stored nothing.
        log(`  ${target.label}: NO EVENTS PARSED (${html.length}b fetched) - markup may have changed`)
        Sentry.captureMessage(`Economic calendar: ${target.label} parsed 0 events from ${html.length}b`, 'warning')
        failures++
        continue
      }
      const stored = await storeEvents(admin, events)
      totalStored += stored
      totalEvents += events.length
      log(`  ${target.label}: ${events.length} event(s) across ${days} day(s), stored ${stored}`)
    } catch (err) {
      Sentry.captureMessage(`Economic calendar ${target.label} failed: ${err.message}`, 'warning')
      log(`  ${target.label}: FAILED - ${err.message}`)
      failures++
    }
  }

  if (totalEvents === 0) {
    // Nothing at all came through the HTML path. For the narrow (hourly)
    // scope there is a floor to fall back to; for a wide backfill there
    // isn't one, and the run should fail so the workflow goes red.
    if (!wide) {
      totalStored += await fallbackToJsonFeed(admin, normalizeFeed)
    } else {
      throw new Error(`No events parsed from any of ${targets.length} page(s) - see the errors above`)
    }
  }

  log(`Done. ${targets.length - failures}/${targets.length} page(s) OK, ${totalStored} row(s) written.`)
}

main()
  .then(() => Sentry.flush(2000))
  .catch(async (err) => {
    Sentry.captureException(err)
    await Sentry.flush(2000)
    console.error(err)
    process.exit(1)
  })
