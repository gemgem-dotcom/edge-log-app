import { createClient } from '@supabase/supabase-js'
import * as Sentry from '@sentry/nextjs'
import { parseCalendarHtml, weekUrl } from '@/lib/econCalendarHtml.mjs'

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
//   1. A global cooldown, not a per-user one. The freshest fetched_at in
//      the table is the shared clock, so ten traders with the dashboard
//      open produce at most one fetch a minute between them, not ten.
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

  // The shared cooldown clock. Ordering by fetched_at rather than tracking
  // state anywhere else keeps this correct across serverless instances,
  // which have no memory in common.
  const { data: newest } = await admin
    .from('economic_events')
    .select('fetched_at')
    .order('fetched_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const lastFetchedAt = newest?.fetched_at ? new Date(newest.fetched_at).getTime() : 0
  const ageMs = Date.now() - lastFetchedAt
  if (ageMs < COOLDOWN_MS) {
    return Response.json({ refreshed: false, reason: 'cooldown', ageMs })
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
