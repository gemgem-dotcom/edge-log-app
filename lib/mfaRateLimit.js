// How many wrong codes an account may offer before it is made to wait.
//
// WHAT THIS CAN AND CANNOT DO, stated first because it decides how much
// to trust it. supabase.auth.mfa.verify() runs IN THE BROWSER and talks
// to the auth server directly - EdgeLog's code is not in that path. So
// this cannot PREVENT a verification attempt. What it does is refuse to
// let the app's own login flow continue, which raises the cost of
// attacking through the app and is the layer an application can
// honestly own. Someone scripting the public API is the auth server's
// problem, not this file's, and the handover guide says so rather than
// claiming more.
//
// A LOCKOUT IS A DENIAL OF SERVICE YOU BUILD ON PURPOSE. Every control
// here is shaped by the fact that the person most likely to trip it is
// the real owner, fumbling a code from a phone with the wrong clock.
// That is why the window is short, why a success clears the count, and
// why the message always says when it ends.

// Five wrong codes before a pause. A TOTP code is six digits: a
// thousand guesses is a 1-in-1000 shot, so the exact threshold matters
// far less than having one, and five is comfortably more than anyone
// mistypes in a row while being tight enough to make scripted guessing
// pointless.
export const MAX_ATTEMPTS = 5

// Fifteen minutes. Long enough that a script gains nothing by waiting,
// short enough that a locked-out owner is not forced into the password
// reset - which, with no recovery codes, would cost them their 2FA
// setup. A punitive window here would quietly become the commonest way
// people lose their second factor.
export const WINDOW_MS = 15 * 60 * 1000

// Counted separately per kind, so burning guesses on one does not lock
// someone out of the other. 'totp' is a login code; 'reauth' is proving
// identity before a sensitive change.
export const KINDS = ['totp', 'reauth']

export function isValidKind(kind) {
  return KINDS.includes(kind)
}

// The decision, over a list of this user's recent attempts.
//
// Takes rows rather than querying, so the policy is testable without a
// database and the route stays a thin caller. Rows are
// { succeeded, created_at }, newest first or not - order is not assumed.
export function attemptVerdict(rows, { now = Date.now(), windowMs = WINDOW_MS, maxAttempts = MAX_ATTEMPTS } = {}) {
  const cutoff = now - windowMs
  const recent = (rows || [])
    .filter((r) => r && Number.isFinite(new Date(r.created_at).getTime()))
    .filter((r) => new Date(r.created_at).getTime() > cutoff)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))

  // A success inside the window clears everything before it. Without
  // this, "four wrong, then the real user got in, then one more typo"
  // would lock out an account that has just proved itself - and the
  // whole point of counting successes as well as failures is to be able
  // to tell those two situations apart.
  const lastSuccessAt = recent.find((r) => r.succeeded)
  const countedFrom = lastSuccessAt ? new Date(lastSuccessAt.created_at).getTime() : cutoff
  const failures = recent.filter((r) => !r.succeeded && new Date(r.created_at).getTime() > countedFrom)

  if (failures.length < maxAttempts) {
    return {
      allowed: true,
      failures: failures.length,
      remaining: maxAttempts - failures.length,
      retryAfterMs: 0,
    }
  }

  // The lock ends a full window after the OLDEST failure that still
  // counts, not after the newest. Measuring from the newest would let
  // the lock be extended indefinitely by an attacker who keeps trying -
  // punishing only the owner, who is the one waiting for it to end.
  const oldestCounted = failures[failures.length - 1]
  const endsAt = new Date(oldestCounted.created_at).getTime() + windowMs

  return {
    allowed: false,
    failures: failures.length,
    remaining: 0,
    retryAfterMs: Math.max(0, endsAt - now),
  }
}

// What the user is told. Always says when the wait ends: "try again
// later" gives someone no way to tell a lockout from a broken app, and
// the one thing a locked-out owner needs is a reason to wait rather
// than to start resetting their password.
export function lockoutMessage(retryAfterMs) {
  const minutes = Math.ceil(Math.max(0, retryAfterMs) / 60000)
  if (minutes <= 1) return 'Too many incorrect codes. Try again in a minute.'
  return `Too many incorrect codes. Try again in ${minutes} minutes.`
}

// A warning before the last chance, not after it. Being told "2 left"
// is what makes someone stop and check their authenticator's clock
// instead of typing the same stale code a third time.
export function remainingWarning(remaining) {
  if (remaining > 2 || remaining < 1) return null
  return remaining === 1
    ? 'Incorrect code - 1 attempt left before a short lockout.'
    : `Incorrect code - ${remaining} attempts left before a short lockout.`
}
