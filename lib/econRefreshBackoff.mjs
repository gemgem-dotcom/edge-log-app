// What the on-demand refresh does when Forex Factory will not answer.
//
// WHY THIS EXISTS. In the fortnight to 2026-11-10 the refresh route sent
// Sentry 85 errors, every one of them "forexfactory returned 403" or a
// timeout. None was a fault in this app. FF declines requests from
// Vercel's addresses a good deal of the time, and the route treated each
// refusal as an exception: report it, wait the ordinary ten minutes, ask
// again. Two things were wrong with that, and they are the same thing
// seen from both ends.
//
// From Sentry's end, an upstream saying no is an OUTCOME, not an error.
// Reporting it eighty-five times buried the three issues in the same
// list that were real - one of which was the calendar storing a month of
// releases on the wrong day.
//
// From FF's end, being refused and asking again at the same rate is the
// behaviour that gets a client refused. CLAUDE.md records the last time:
// a dashboard polling every 60s, and FF answering 403 for the pages we
// asked for most. The honest response to "no" is to ask less often.
//
// So a refusal backs off, doubling each time, and is reported ONCE per
// outage rather than once per request. The scheduled job runs from
// GitHub's addresses and is unaffected; this route only ever made the
// card fresher for somebody watching, and it goes back to doing that the
// moment FF answers.
//
// Pure, so the policy is tested directly rather than by reading a route.

export const COOLDOWN_MS = 10 * 60_000

// Six hours. Long enough that a standing block costs FF four requests a
// day from this route rather than a hundred and forty-four; short enough
// that when a block lifts, the card is live again the same session.
export const MAX_BACKOFF_MS = 6 * 60 * 60_000

// How long to wait after the Nth consecutive refusal: 20m, 40m, 80m...
// The first refusal already doubles, because one refusal is the whole
// signal - there is no "probably a blip" reading of a 403 that makes
// asking again in ten minutes the polite thing to do.
export function backoffMs(consecutiveFailures) {
  const n = Number.isFinite(consecutiveFailures) && consecutiveFailures > 0 ? Math.floor(consecutiveFailures) : 0
  if (n === 0) return COOLDOWN_MS
  // Capped before the shift can overflow: 2 ** 40 minutes is not a wait.
  return Math.min(COOLDOWN_MS * 2 ** Math.min(n, 12), MAX_BACKOFF_MS)
}

// When the next attempt is allowed, for econ_refresh_lock.not_before.
//
// A column of its own rather than a claimed_at pushed into the future.
// That was the first version, and it broke an invariant somebody else
// relies on: scripts/inspect-economic-calendar.js reads a future
// claimed_at as a wedged lock and fails the daily check, correctly,
// because before this existed nothing legitimate could produce one.
// claimed_at keeps meaning "when the last attempt began" and nothing else.
export function notBeforeAfterFailure(nowMs, consecutiveFailures) {
  return new Date(nowMs + backoffMs(consecutiveFailures)).toISOString()
}

// Report on the refusal that makes it an OUTAGE, and on no other.
//
// By the sixth the route has been refused for about ten hours straight,
// which is past any blip and is a fact worth one notification: the card
// is running on the scheduled job alone. The seventh says nothing new.
// Recovery resets the count, so the next outage reports again.
export const ESCALATE_AT = 6

export function shouldEscalate(consecutiveFailures) {
  return consecutiveFailures === ESCALATE_AT
}

// Is this failure FF declining or being unreachable, as opposed to
// something of ours breaking?
//
// The distinction decides whether Sentry hears about it. An HTTP status
// from FF and a timeout or network failure reaching FF are theirs. A
// database error, or anything thrown while handling a page that DID
// arrive, is ours and is always reported.
export function isUpstreamFailure(failure) {
  if (!failure) return false
  if (Number.isFinite(failure.status)) return true
  const name = String(failure.name || '')
  return name === 'TimeoutError' || name === 'AbortError' || failure.upstream === true
}
