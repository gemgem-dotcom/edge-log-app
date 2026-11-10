import { createClient } from '@supabase/supabase-js'
import * as Sentry from '@sentry/nextjs'
import { parseCalendarHtml, readPageAnchor, weekUrl } from '@/lib/econCalendarHtml.mjs'
import {
  COOLDOWN_MS, backoffMs, notBeforeAfterFailure, shouldEscalate, isUpstreamFailure,
} from '@/lib/econRefreshBackoff.mjs'
import { isMockDbEnabled } from '@/lib/mockMode'

// Refreshes the current week of economic_events on demand, so the calendar
// card shows a release within minutes of it printing rather than waiting
// on the next scheduled run.
//
// This exists alongside the scheduled job rather than replacing it. The
// hourly/daily workflow is the baseline that keeps the table complete even
// when nobody is looking; this is what makes it live for someone who IS
// looking - the card calls it on mount and every couple of minutes it
// stays open, so an actual landing mid-session appears without a reload,
// within about ten minutes rather than instantly (see COOLDOWN_MS).
//
// Two things keep that from turning into a stampede against someone else's
// site:
//
//   1. A global claim, not a per-user cooldown, and a claim rather than a
//      check. econ_refresh_lock is a single row moved by one conditional
//      UPDATE, so ten traders with the dashboard open produce at most one
//      fetch per COOLDOWN_MS between them - and, because the claim is taken
//      before the fetch and kept whether or not it succeeds, a spell of
//      FF refusing us backs off instead of being retried per tab.
//      See that table's comment in schema.sql for why the read-then-fetch
//      version this replaced was not enough.
//   2. Signed-in callers only, same bearer-token check the other API
//      routes here use. Otherwise this is an open proxy that will fetch a
//      1.6MB page for anyone who curls it.
//
// Uses SUPABASE_SERVICE_ROLE_KEY like the other routes in app/api - the
// table's RLS allows reads to any signed-in user and writes to nobody, so
// the write side has to come from the service role.

// How stale the table may be before a caller triggers a real fetch.
//
// This was 60s, which was too eager. One dashboard left open asked Forex
// Factory for the current week sixty times an hour on its own, and on
// 2026-09-12 - after a morning of that plus a dozen manual backfill runs -
// FF began answering 403 to whichever pages we had been asking for most,
// the current week among them. Causation isn't proven, but the reading is
// obvious enough to act on, and the right answer to being refused by
// someone else's site is to ask less rather than to ask harder. Nothing
// here retries a 403, spoofs a User-Agent or works around a block, and
// nothing that does should be added.
//
// Ten minutes cuts that same dashboard to six fetches an hour while
// costing very little of what the feature is for: FF fills an actual in
// within minutes of a release printing, so the figure still lands while
// the trader is watching, just not within the same minute.
// HOW LONG THE PLATFORM LETS THIS RUN, and the reason it is declared at
// all rather than left to the default.
//
// This route's own budget is one 15s fetch, a 2s pause, and a second 15s
// fetch - 32 seconds worst case, before parsing a ~400KB page and
// upserting the week. Vercel's default serverless timeout is 10 seconds.
// So the slow half of this route could never finish: the platform killed
// the function somewhere inside the first fetch.
//
// Every symptom follows from that, and it is worth writing down because
// the obvious suspect - Forex Factory refusing us - was the wrong one.
// On 2026-10-28 the FOMC decision printed at 18:00Z and the card still
// had no actual at 18:39Z. The table was healthy, the lock had been
// claimed a minute earlier, and the newest row in the whole table had
// been fetched at 15:55Z - by the scheduled job, which runs on a GitHub
// runner with no such limit and had been succeeding all along. A probe
// from that same runner four minutes later pulled the calendar page down
// and parsed it cleanly, actuals and all. FF was answering us the whole
// time; this function was being killed before it could write.
//
// It also explains the silence. A function killed by the platform does
// not throw, so the catch below never ran, Sentry never received an
// event, and the claim stayed taken - which backed the next caller off
// for ten minutes, exactly as designed, on a failure that had nothing to
// do with being refused.
//
// 60 is the ceiling on Vercel's lowest tier and comfortably clears the
// 32s worst case plus the parse and the write. Raising it is not making
// the route slower or greedier: the request budget below is unchanged,
// and this only stops the platform from cutting it off mid-flight.
export const maxDuration = 60

const USER_AGENT = 'EdgeLog/1.0 (trading journal; +https://github.com/gemgem-dotcom/edge-log-app)'
const FETCH_TIMEOUT_MS = 15000
const FORBIDDEN_RETRY_DELAY_MS = 2000
const ANCHOR_TIMEOUT_MS = 10000

// One retry, and only on a 403. Across seven runs on 2026-09-12/13 the
// FIRST request of every process came back 403 and every later one came
// back 200 - whichever page happened to lead. This route asks for exactly
// one page, so its single request was always that first one, which is why
// it claimed the lock every poll and then never wrote a row.
//
// See scripts/fetch-economic-calendar.js's fetchPage for the full evidence
// and for the line this does not cross: no User-Agent games, no pretending
// to be a browser, no solving a challenge. One polite second ask, then we
// take no for an answer.
async function fetchWeekPage() {
  const request = () => fetch(weekUrl(new Date()), {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  const first = await request()
  if (first.status !== 403) return first
  await new Promise((resolve) => setTimeout(resolve, FORBIDDEN_RETRY_DELAY_MS))
  return request()
}

// FF said no, or could not be reached. Thrown rather than returned so the
// one catch below sees every way the fetch can fail, and tagged so it can
// tell this from a fault of ours - see isUpstreamFailure.
class UpstreamFailure extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'UpstreamFailure'
    this.upstream = true
    if (Number.isFinite(status)) this.status = status
  }
}

async function fetchWeekHtml() {
  let res
  try {
    res = await fetchWeekPage()
  } catch (err) {
    // A timeout, a reset, DNS: nothing arrived. `fetch failed` is a bare
    // TypeError with the reason in `cause`, so the reason is kept.
    throw new UpstreamFailure(`forexfactory unreachable: ${err?.cause?.code || err?.name || 'error'}`)
  }
  if (!res.ok) throw new UpstreamFailure(`forexfactory returned ${res.status}`, res.status)
  return res.text()
}

// The first day of the week AFTER this one, when the current week alone
// cannot say which timezone FF rendered it in - which happens in the
// weeks the clocks change (see lib/econCalendarZone.mjs). One request, no
// retry, a short timeout: this is evidence for placing rows, not the rows
// themselves, and if it does not arrive the undecidable days are simply
// not written this time. The scheduled job places them.
async function fetchAnchorAfter(date) {
  try {
    const res = await fetch(weekUrl(new Date(`${date}T12:00:00Z`)), {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      signal: AbortSignal.timeout(ANCHOR_TIMEOUT_MS),
    })
    return res.ok ? readPageAnchor(await res.text()) : null
  } catch {
    return null
  }
}

// Records what this attempt concluded, for scripts/inspect-economic-
// calendar.js to read later. Paired with claimed_at, which was stamped
// before the fetch: an attempt that finishes stamps a time AFTER its
// claim, so a claim with no later finish is one the platform killed
// mid-flight - the failure mode that reports nothing anywhere else,
// Sentry included, because a killed function never throws.
//
// Never allowed to affect the request. A failure to write a diagnostic
// is not a failure to refresh, and the claim does not depend on any of
// these columns, so a stuck outcome cannot wedge the route.
async function record(admin, outcome, detail, extra = {}) {
  const base = {
    last_finished_at: new Date().toISOString(),
    last_outcome: outcome,
    last_detail: detail === undefined || detail === null ? null : String(detail).slice(0, 300),
  }
  try {
    const { error } = await admin.from('econ_refresh_lock').update({ ...base, ...extra }).eq('id', 1)
    // `extra` carries columns added after the table shipped. If they have
    // not been run in yet the whole update is rejected, and losing the
    // outcome as well would hide the very thing this row exists to show -
    // so it is written again without them.
    if (error && Object.keys(extra).length > 0) {
      await admin.from('econ_refresh_lock').update(base).eq('id', 1)
    }
  } catch {
    // Deliberately swallowed - see above.
  }
}

// How many times in a row FF has declined this route. Read, not carried
// in memory: a serverless instance counts to one and forgets.
async function failureStreak(admin) {
  try {
    const { data } = await admin
      .from('econ_refresh_lock')
      .select('consecutive_failures, last_ok_at')
      .eq('id', 1)
      .maybeSingle()
    return { failures: Number(data?.consecutive_failures) || 0, lastOkAt: data?.last_ok_at || null }
  } catch {
    return { failures: 0, lastOkAt: null }
  }
}

export async function POST(req) {
  // Against the mock database there is no Supabase to authenticate with
  // and no reason to fetch a live page - the card polls this on a timer,
  // and without this every `npm run dev:mock` session would quietly beat
  // on forexfactory.com. Reported as a non-refresh so the card's own "only
  // re-read when something changed" path behaves exactly as in production.
  if (isMockDbEnabled()) {
    return Response.json({ refreshed: false, reason: 'mock-db' })
  }

  // `'Bearer ' + undefined` stringifies to the literal "undefined", which
  // is truthy - so a caller with no session used to get past this guard
  // and spend a Supabase round trip proving it. Rejected here instead.
  const token = (req.headers.get('authorization') || '').replace('Bearer ', '').trim()
  if (!token || token === 'undefined' || token === 'null') {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) {
    return Response.json({ error: 'Not configured' }, { status: 500 })
  }
  const admin = createClient(supabaseUrl, serviceKey)

  const { data: userData, error: userError } = await admin.auth.getUser(token)
  if (userError || !userData?.user) {
    return Response.json({ error: 'Invalid session' }, { status: 401 })
  }

  // Claim the fetch. One conditional UPDATE, in the database, so the
  // decision is atomic across serverless instances that share no memory:
  // concurrent callers block on the row and then re-check the cutoff
  // against the committed value, so exactly one gets a row back and
  // everyone else is told to wait. Doing this BEFORE the fetch is the
  // whole point - a check that only advanced on success let a failing
  // fetch be retried by every open tab on every poll.
  const now = Date.now()
  const cutoff = new Date(now - COOLDOWN_MS).toISOString()
  // Still ONE conditional UPDATE, which is the lock's whole safety
  // argument (see schema.sql). `not_before` is the backoff after FF has
  // declined: both conditions are plain ANDed column comparisons, so
  // concurrent callers still block on the row and exactly one wins.
  let { data: claimed, error: claimError } = await admin
    .from('econ_refresh_lock')
    .update({ claimed_at: new Date(now).toISOString() })
    .eq('id', 1)
    .lt('claimed_at', cutoff)
    .lte('not_before', new Date(now).toISOString())
    .select('claimed_at')
  if (claimError && /not_before/.test(claimError.message || '')) {
    // The column has not been run in. Fall back to the claim as it was
    // rather than take the route down over a missing backoff.
    ;({ data: claimed, error: claimError } = await admin
      .from('econ_refresh_lock')
      .update({ claimed_at: new Date(now).toISOString() })
      .eq('id', 1)
      .lt('claimed_at', cutoff)
      .select('claimed_at'))
  }

  if (claimError) {
    Sentry.captureException(new Error(`Economic calendar refresh could not claim: ${claimError.message}`))
    return Response.json({ refreshed: false, reason: 'unavailable' })
  }
  if (!claimed || claimed.length === 0) {
    return Response.json({ refreshed: false, reason: 'cooldown' })
  }

  try {
    const html = await fetchWeekHtml()

    let page = parseCalendarHtml(html)
    if (page.zoneAmbiguous && page.anchorAfter) {
      const anchor = await fetchAnchorAfter(page.anchorAfter)
      if (anchor) page = parseCalendarHtml(html, { anchors: [anchor] })
    }
    const { events, untrustedDays, untrustedRows } = page

    if (events.length === 0) {
      // Never an empty write: a page that parsed to nothing means the
      // markup moved - or no day on it could be placed - and the right
      // response is to leave the table alone and say so, not to report a
      // successful refresh of nothing.
      const why = untrustedRows > 0
        ? `${untrustedRows} row(s) on ${untrustedDays.length} day(s) could not be placed`
        : 'page fetched but parsed to zero events'
      Sentry.captureMessage(`Economic calendar on-demand refresh stored nothing: ${why}`, 'warning')
      await record(admin, 'no-events', why, { consecutive_failures: 0 })
      return Response.json({ refreshed: false, reason: 'no-events' })
    }

    const { error } = await admin
      .from('economic_events')
      .upsert(
        events.map((e) => ({ ...e, fetched_at: new Date().toISOString() })),
        { onConflict: 'event_key' },
      )
    if (error) throw new Error(error.message)

    // Days whose instants could not be established are not written - an
    // unknown time is a gap, a wrong one is a lie. Said in the outcome so
    // a partly-stored week is visible rather than reading as a full one.
    const detail = untrustedDays.length > 0
      ? `${events.length} rows; ${untrustedRows} withheld on ${untrustedDays.length} day(s)`
      : `${events.length} rows`
    await record(admin, 'ok', detail, { consecutive_failures: 0, last_ok_at: new Date().toISOString() })
    return Response.json({ refreshed: true, count: events.length })
  } catch (err) {
    // A failed refresh is not a failed page. The card already has whatever
    // the scheduled job last stored, so the client carries on showing it.
    if (!isUpstreamFailure(err)) {
      // Ours: the write failed, or something threw while handling a page
      // that did arrive. Always reported.
      Sentry.captureException(err)
      await record(admin, 'fetch-failed', err?.message)
      return Response.json({ refreshed: false, reason: 'fetch-failed' }, { status: 200 })
    }

    // Theirs: FF declined, or could not be reached. An outcome, not an
    // error - see lib/econRefreshBackoff.mjs for why this used to be 85
    // Sentry events a fortnight and what it does instead.
    const { failures: before, lastOkAt } = await failureStreak(admin)
    const failures = before + 1
    // Ask less often. The claim taken above already holds the ordinary
    // ten minutes; not_before pushes the next attempt out to the backoff
    // for this streak. If the write is lost the ordinary cooldown still
    // stands, which costs FF one early request rather than anything worse.
    await record(admin, 'upstream-declined', err?.message, {
      consecutive_failures: failures,
      not_before: notBeforeAfterFailure(Date.now(), failures),
    })
    if (shouldEscalate(failures)) {
      Sentry.captureMessage(
        `Economic calendar on-demand refresh: Forex Factory has declined ${failures} times running `
        + `(last success ${lastOkAt || 'not recorded'}) - the card is on the scheduled job alone`,
        'warning',
      )
    }
    return Response.json(
      { refreshed: false, reason: 'upstream-declined', retryAfterMs: backoffMs(failures) },
      { status: 200 },
    )
  }
}
