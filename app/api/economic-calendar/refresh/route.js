import { createClient } from '@supabase/supabase-js'
import * as Sentry from '@sentry/nextjs'
import { parseCalendarHtml, weekUrl } from '@/lib/econCalendarHtml.mjs'
import { isMockDbEnabled } from '@/lib/mockMode'

// Refreshes the current week of economic_events on demand, so the calendar
// card shows a release the moment it prints rather than up to an hour
// later.
//
// This exists alongside the scheduled job rather than replacing it. The
// hourly/daily workflow is the baseline that keeps the table complete even
// when nobody is looking; this is what makes it live for someone who IS
// looking - the card calls it on mount and every minute it stays open, so
// an actual landing mid-session appears without a reload.
//
// Two things keep that from turning into a stampede against someone else's
// site:
//
//   1. A global claim, not a per-user cooldown, and a claim rather than a
//      check. econ_refresh_lock is a single row moved by one conditional
//      UPDATE, so ten traders with the dashboard open produce at most one
//      fetch a minute between them - and, because the claim is taken
//      before the fetch and kept whether or not it succeeds, a spell of
//      FF refusing us backs off instead of retrying every minute per tab.
//      See that table's comment in schema.sql for why the read-then-fetch
//      version this replaced was not enough.
//   2. Signed-in callers only, same bearer-token check the other API
//      routes here use. Otherwise this is an open proxy that will fetch a
//      1.6MB page for anyone who curls it.
//
// Uses SUPABASE_SERVICE_ROLE_KEY like the other routes in app/api - the
// table's RLS allows reads to any signed-in user and writes to nobody, so
// the write side has to come from the service role.

// How stale the table may be before a caller triggers a real fetch. Short
// enough that "as soon as it's out" is true in practice, long enough that
// a busy dashboard can't ask FF for the same page more than once a minute.
const COOLDOWN_MS = 60_000
const USER_AGENT = 'EdgeLog/1.0 (trading journal; +https://github.com/gemgem-dotcom/edge-log-app)'
const FETCH_TIMEOUT_MS = 15000

export async function POST(req) {
  // Against the mock database there is no Supabase to authenticate with
  // and no reason to fetch a live page - the card polls this every minute,
  // and without this every `npm run dev:mock` session would quietly beat
  // on forexfactory.com. Reported as a non-refresh so the card's own "only
  // re-read when something changed" path behaves exactly as in production.
  if (isMockDbEnabled()) {
    return Response.json({ refreshed: false, reason: 'mock-db' })
  }

  const token = (req.headers.get('authorization') || '').replace('Bearer ', '').trim()
  if (!token) {
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
  // fetch be retried by every open tab, every minute.
  const cutoff = new Date(Date.now() - COOLDOWN_MS).toISOString()
  const { data: claimed, error: claimError } = await admin
    .from('econ_refresh_lock')
    .update({ claimed_at: new Date().toISOString() })
    .eq('id', 1)
    .lt('claimed_at', cutoff)
    .select('claimed_at')

  if (claimError) {
    Sentry.captureException(new Error(`Economic calendar refresh could not claim: ${claimError.message}`))
    return Response.json({ refreshed: false, reason: 'unavailable' })
  }
  if (!claimed || claimed.length === 0) {
    return Response.json({ refreshed: false, reason: 'cooldown' })
  }

  try {
    const res = await fetch(weekUrl(new Date()), {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`forexfactory returned ${res.status}`)

    const { events } = parseCalendarHtml(await res.text())
    if (events.length === 0) {
      // Never an empty write: a page that parsed to nothing means the
      // markup moved, and the right response is to leave the table alone
      // and say so, not to report a successful refresh of nothing.
      Sentry.captureMessage('Economic calendar on-demand refresh parsed 0 events', 'warning')
      return Response.json({ refreshed: false, reason: 'no-events' })
    }

    const { error } = await admin
      .from('economic_events')
      .upsert(
        events.map((e) => ({ ...e, fetched_at: new Date().toISOString() })),
        { onConflict: 'event_key' },
      )
    if (error) throw new Error(error.message)

    return Response.json({ refreshed: true, count: events.length })
  } catch (err) {
    // A failed refresh is not a failed page. The card already has whatever
    // the scheduled job last stored, so this reports the miss and lets the
    // client carry on showing it.
    Sentry.captureException(err)
    return Response.json({ refreshed: false, reason: 'fetch-failed' }, { status: 200 })
  }
}
