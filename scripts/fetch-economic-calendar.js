#!/usr/bin/env node

// Fetches Forex Factory's economic calendar into economic_events - see
// .github/workflows/refresh-economic-calendar.yml (the hourly schedule)
// and schema.sql's comment above `create table economic_events`.
//
// SOURCE: forexfactory.com/calendar's own HTML, parsed by
// lib/econCalendarHtml.mjs. This used to read FF's published JSON feed
// instead; that feed is still used as a fallback below, but it cannot be
// the primary source because it carries exactly one week and no `actual`
// column at all - both confirmed live. The page carries actual values,
// FF's own beat/miss marking, revised-previous flags, FF's own event ids,
// and several months either side of today rather than one week.
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
// HOW FAR BACK IT REACHES: not yet known, and NOT the "about two months"
// this comment claimed between 2026-09-12 and 2026-09-13. That figure came
// from ?month=jun.2026 returning 403 on two runs while newer months
// returned 200 - which looked like an archive horizon and was not one.
// June had simply led both runs, and the first request of a run is the one
// that gets a cold-connection 403 (see fetchPage). With that retried, no
// horizon has actually been measured. Do not restate one until it has.
//
// Rows upsert on event_key (FF's own event id), so a re-fetch updates the
// release it already has - filling in an actual, moving a rescheduled time -
// rather than inserting a second copy.
//
// It DOES delete, in one narrow case: an event that has disappeared from a
// page which spoke for its day. FF withdraws releases and cancels speeches,
// and an upsert-only pipeline kept those on the card forever. The rails
// that keep this from becoming data loss are in
// lib/econCalendarRemoval.mjs and at the call site - a page that failed its
// own sanity checks never gets to speak for what is absent, and the JSON
// fallback never does either.
//
// Usage:
//   node scripts/fetch-economic-calendar.js
//   CALENDAR_MONTHS_BACK=2 node scripts/fetch-economic-calendar.js
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
// Below this many distinct days, a month page did not really come through.
// Even a quiet holiday month carries events on most weekdays; 20 is well
// under any real month and well over any truncated one.
const MIN_DAYS_PER_MONTH_PAGE = 20

// Removing events FF has removed. The decision - which rows count as
// vanished, and how many is too many to be believable - lives in
// lib/econCalendarRemoval.mjs so it can be tested directly; this file owns
// the range, the read and the delete. See that module's header.

function log(...args) {
  console.log(new Date().toISOString(), ...args)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Retries network errors and 5xx, and a 403 exactly once. Never any other
// 4xx.
//
// The 403 exception is narrow and is there because of what seven runs on
// 2026-09-12/13 actually showed: the FIRST request of every run came back
// 403, and every later request in the same process came back 200. Not a
// particular URL - whichever page happened to be asked for first. June
// 403'd when it led a backfill, then August did, then September, then the
// current week. It read like "FF declines months older than two" and like
// "FF is rate-limiting us", and it was neither; both of those readings are
// now corrected in the docs.
//
// So this is not a considered refusal being argued with. FF serves this
// app's honest User-Agent perfectly well - it does so on the second
// request, every time - and the first-request 403 is an artifact of a cold
// connection at their edge. Asking a second time is what a normal HTTP
// client does with a transient rejection, and the comment that used to sit
// here ("asking three times over neither changes that answer") was simply
// wrong on the facts: it demonstrably does.
//
// What has NOT changed, and must not: nothing here varies the User-Agent,
// pretends to be a browser, solves a challenge, or routes around a block.
// One polite retry, then we take no for an answer - and every other 4xx is
// still taken at face value on the first try. If FF ever starts refusing
// the second request too, that is a real no, and the answer is a different
// source rather than a third attempt.
//
// This matters most for the single-page callers - the hourly week fetch
// and the on-demand refresh route - whose one and only request was always
// the first one, and so always the one that got refused. That is why the
// live path had never once succeeded.
const FORBIDDEN_RETRIES = 1
const FORBIDDEN_RETRY_DELAY_MS = 2000

async function fetchPage(url, accept) {
  let lastError = null
  let forbiddenRetriesLeft = FORBIDDEN_RETRIES
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: accept },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (res.status === 403 && forbiddenRetriesLeft > 0) {
        forbiddenRetriesLeft--
        log(`  ${url} returned 403 on a cold connection - retrying once in ${FORBIDDEN_RETRY_DELAY_MS}ms`)
        await sleep(FORBIDDEN_RETRY_DELAY_MS)
        continue
      }
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

// Drop the rows FF has stopped listing inside a range it just spoke for.
// See MAX_REMOVAL_FRACTION's comment for why this exists and what stops it
// running away.
//
// `since` is the instant the page's own upsert began. Every row FF still
// lists carries a fetched_at at or after it; anything older in the same
// range was not on the page. Passing it in rather than reading the clock
// here keeps a slow store from making its own rows look stale.
async function removeVanishedEvents(admin, planRemoval, { label, coveredFrom, coveredTo, coveredDays, since }) {
  if (!coveredFrom || !coveredTo) return 0

  // Read first, decide, then delete. A conditional delete would be one
  // round trip, but it would also be unbounded: there would be no count to
  // check against the threshold until after the rows were gone.
  // Paged. PostgREST caps an unbounded select at 1000 rows and returns
  // that first page with no error and no flag - the trap lib/fetchAllRows
  // exists for. A busy month's range is near that cap, and a silently
  // truncated scan would make the denominator the whole threshold rests on
  // quietly wrong, over an arbitrary unordered subset.
  const inRange = []
  const SCAN_PAGE = 1000
  for (let page = 0; page < 50; page++) {
    const from = page * SCAN_PAGE
    const { data, error: readErr } = await admin
      .from('economic_events')
      // ff_event_id is read for the decision, not for display: its absence
      // is what marks a row as JSON-feed-written, and isFeedWritten exempts
      // those from the allowance. Leave it out of the select and every row
      // looks feed-written, which would hand the removal pass an unlimited
      // budget over the whole range.
      .select('event_key, ff_event_id, title, currency, event_time, fetched_at')
      .gte('event_time', coveredFrom)
      .lt('event_time', coveredTo)
      .order('event_time', { ascending: true })
      .order('event_key', { ascending: true })
      .range(from, from + SCAN_PAGE - 1)
    if (readErr) throw new Error(`removal scan failed: ${readErr.message}`)
    const rows = data || []
    inRange.push(...rows)
    if (rows.length < SCAN_PAGE) break
  }

  const { vanished, orphans, gated, allowance, inRangeCount, allowed, removable } = planRemoval(inRange, since, coveredDays)
  if (vanished.length === 0) return 0

  if (!allowed && gated.length > 0) {
    // Refuse, loudly, and keep them. Deleting this many means the page did
    // not say what we think it said - and a table missing a third of its
    // events is a far worse outcome than one holding a few stale ones.
    //
    // 'error', not 'warning'. A refusal changes nothing, so the next run
    // computes the same set and refuses again - every few hours, forever,
    // with no escape but manual SQL. That is a wedge, not a blip, and the
    // diagnostic's STALENESS section is where it shows as a number that
    // stops going down.
    log(`  ${label}: REFUSING to remove ${gated.length} of ${inRangeCount} row(s) - over the ${allowance} allowed`)
    Sentry.captureMessage(
      `Economic calendar: ${label} would have removed ${gated.length}/${inRangeCount} rows - refused`,
      'error',
    )
  }

  // Feed orphans are not gated - see isFeedWritten. They go whether or not
  // the rest was believable.
  if (removable.length === 0) return 0
  if (orphans.length > 0) {
    log(`  ${label}: ${orphans.length} of these were JSON-feed rows the page has now replaced`)
  }

  const keys = removable.map((r) => r.event_key)
  // Conditioned on fetched_at as well as the key. Between the scan and
  // this delete another writer can legitimately refresh one of these rows -
  // the on-demand refresh route upserts the current week whenever a
  // dashboard mounts - and an unconditional delete would remove a row that
  // had just been confirmed present on FF. The predicate costs nothing and
  // makes the delete self-verifying.
  const { error: delErr } = await admin
    .from('economic_events')
    .delete()
    .in('event_key', keys)
    .lt('fetched_at', since)
  if (delErr) throw new Error(`removal failed: ${delErr.message}`)

  // Named, not just counted. A removal is the one thing here that destroys
  // data, so the log has to be enough to tell a cancelled speech from a
  // parser that started missing a row type.
  log(`  ${label}: removed ${removable.length} event(s) FF no longer lists`)
  for (const r of removable.slice(0, 10)) {
    log(`      ${r.event_time}  ${r.currency}  ${r.title}`)
  }
  if (removable.length > 10) log(`      ...and ${removable.length - 10} more`)
  return removable.length
}

function monthsAround(back, forward) {
  const out = []
  const now = new Date()
  for (let offset = -back; offset <= forward; offset++) {
    out.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1, 12)))
  }
  return out
}

// Columns the JSON feed cannot speak to. The feed carries no actual at
// all, so normalizeFeedEvent emits actual: null for every record - and an
// upsert writes that null over a figure the HTML path had already stored.
// This path runs exactly when the HTML parser is broken, so without this
// the fallback's first act would be to erase this week's printed actuals,
// leaving rows rendering a beat/miss colour against a blank figure.
// Dropping the keys entirely leaves the stored values alone.
const HTML_ONLY_COLUMNS = ['actual', 'actual_status', 'previous_revised', 'time_precision', 'ff_event_id']

function withoutHtmlOnlyColumns(event) {
  const out = { ...event }
  for (const column of HTML_ONLY_COLUMNS) delete out[column]
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
  const stored = await storeEvents(admin, events.map(withoutHtmlOnlyColumns))
  log(`  json feed: stored ${stored} event(s) (schedule only - actuals left as they were)`)
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
  const { planRemoval } = await import('../lib/econCalendarRemoval.mjs')

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
  let totalRemoved = 0
  let failures = 0

  for (const [i, target] of targets.entries()) {
    if (i > 0) await sleep(PAGE_GAP_MS)
    try {
      const html = await fetchPage(target.url, 'text/html')
      const { events, skipped, days, dstDays, oddDatelines, coveredFrom, coveredTo, coveredDays } = parseCalendarHtml(html)
      if (skipped > 0) log(`  ${target.label}: skipped ${skipped} unusable row(s)`)
      // The parser corrects a clock-change day using the page's own day
      // lengths. Saying so is the point: the previous implementation
      // claimed to tell the caller when it could not correct one, and then
      // returned nothing to say it with, so a silent hour of drift twice a
      // year had no signal anywhere at all.
      if (dstDays > 0) log(`  ${target.label}: ${dstDays} clock-change day(s) corrected`)
      if (oddDatelines > 0) {
        // A dateline is midnight somewhere, so it is always a whole number
        // of minutes from a UTC day. Anything else means the attribute
        // changed format, and every instant on the page is then suspect.
        log(`  ${target.label}: ${oddDatelines} dateline(s) are not a whole minute - format may have changed`)
        Sentry.captureMessage(`Economic calendar: ${target.label} had ${oddDatelines} odd dateline(s)`, 'warning')
      }
      if (events.length === 0) {
        // A real calendar page always has events. Zero means the markup
        // moved, so say so loudly rather than reporting a clean run that
        // stored nothing.
        log(`  ${target.label}: NO EVENTS PARSED (${html.length}b fetched) - markup may have changed`)
        Sentry.captureMessage(`Economic calendar: ${target.label} parsed 0 events from ${html.length}b`, 'warning')
        failures++
        continue
      }
      // A month page that parses to three days is a truncated response or
      // a partial render, not a quiet month. It would store fine and
      // report a clean run, so it is called out - the events themselves
      // are still good, so they are kept rather than thrown away.
      if (wide && days < MIN_DAYS_PER_MONTH_PAGE) {
        log(`  ${target.label}: only ${days} day(s) parsed from a month page - likely truncated`)
        Sentry.captureMessage(`Economic calendar: ${target.label} parsed only ${days} day(s)`, 'warning')
      }
      // Counted BEFORE the write, because this number decides whether the
      // JSON fallback runs and that decision is about the PARSER, not the
      // database. Counting after storeEvents meant a failed upsert - the
      // four new columns not yet added by hand, say - logged "HTML yielded
      // no events", blamed the parser, and fell back to the JSON feed,
      // which omits exactly those columns and therefore succeeded. A green
      // run, a correct-looking schedule, and no actuals, forever.
      totalEvents += events.length
      // Stamped before the write, so a slow store cannot make its own rows
      // look older than the run that wrote them.
      const storeStartedAt = new Date().toISOString()
      const stored = await storeEvents(admin, events)
      totalStored += stored
      log(`  ${target.label}: ${events.length} event(s) across ${days} day(s), stored ${stored}`)

      // Only a page that passed its own checks is allowed to speak for what
      // is NOT on it. A month page that came back thin already warned above;
      // letting it also delete would turn a truncated response into data
      // loss, which is the one outcome worth more than the staleness.
      // `skipped` counts rows the parser SAW and could not use, and those
      // are exactly the rows that will look vanished: they are in range,
      // they exist from earlier runs, and this run will not refresh them.
      // The relationship is one for one, so the clearest signal that the
      // parser is dropping real rows has to gate the destructive step.
      const trustedForRemoval = skipped === 0 && (!wide || days >= MIN_DAYS_PER_MONTH_PAGE)
      if (trustedForRemoval) {
        totalRemoved += await removeVanishedEvents(admin, planRemoval, {
          label: target.label,
          coveredFrom,
          coveredTo,
          coveredDays,
          since: storeStartedAt,
        })
      } else {
        log(`  ${target.label}: not removing anything - ${skipped > 0 ? `${skipped} row(s) were skipped` : 'the page is too thin'}, so it cannot be trusted for absence`)
      }
    } catch (err) {
      Sentry.captureMessage(`Economic calendar ${target.label} failed: ${err.message}`, 'warning')
      log(`  ${target.label}: FAILED - ${err.message}`)
      failures++
    }
  }

  if (totalEvents === 0 && !wide) {
    // A floor, not a rescue: the feed keeps the schedule current while the
    // page is unavailable, but it carries no actuals, so the run is still
    // a failure of the thing this job exists to do.
    totalStored += await fallbackToJsonFeed(admin, normalizeFeed)
  }

  const pagesOk = targets.length - failures
  log(`Done. ${pagesOk}/${targets.length} page(s) OK, ${totalStored} row(s) written`
    + `${totalRemoved > 0 ? `, ${totalRemoved} removed` : ''}.`)

  // Red when the page gave us nothing at all, whatever the fallback then
  // salvaged. This used to exit 0 in that case and the workflow went green
  // while actuals quietly stopped arriving - which is exactly how a source
  // going away stays unnoticed for a week.
  if (pagesOk === 0) {
    throw new Error(
      `No events parsed from any of ${targets.length} page(s)`
      + `${totalStored > 0 ? ` - the JSON feed floor stored ${totalStored} row(s), so the schedule is current but no actuals arrived` : ''}`
      + ' - see the errors above',
    )
  }

  // Red when ANY page was lost, too. This used to pass a partial wide run,
  // on the reasoning that "FF declines month pages beyond about two months
  // back, so a backfill is expected to lose its oldest page" - a claim this
  // file's own header, CLAUDE.md and NOTES.md all record as WRONG and
  // retracted. The 403s it rested on were cold-connection rejections of
  // whichever page led the run, and fetchPage retries those now. So a lost
  // page is a real loss, and the daily sweep losing two of its three months
  // should not be a green check.
  if (failures > 0) {
    throw new Error(
      `${failures} of ${targets.length} page(s) failed - ${pagesOk} stored `
      + `${totalStored} row(s), but the rest of the range was not refreshed`,
    )
  }
}

main()
  .then(() => Sentry.flush(2000))
  .catch(async (err) => {
    Sentry.captureException(err)
    await Sentry.flush(2000)
    console.error(err)
    process.exit(1)
  })
