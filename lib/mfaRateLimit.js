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

// A second, higher threshold counted across EVERY source, not just the
// caller's.
//
// WHY TWO. The per-caller limit is scoped to the requester's hashed IP,
// and it has to be: without that, anybody holding the password alone
// could spray five failures and lock the real owner out of their own
// account from any browser. With no recovery codes, the owner's only
// documented escape is a password reset - which clears their factors.
// So an unscoped limiter is a lever that coerces the victim into
// removing the very protection the attacker could not defeat, at a cost
// of twenty requests an hour.
//
// Scoping to the IP alone would then let an attacker rotate addresses
// for five fresh guesses each, so this cap still applies account-wide.
// It sits far above anything a real person does - twenty wrong codes in
// a quarter of an hour is not a fumbled phone clock - so it almost
// never fires for an owner, while a distributed guessing attempt still
// runs into it.
export const MAX_ATTEMPTS_ALL_SOURCES = 20

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
export function attemptVerdict(rows, {
  now = Date.now(),
  windowMs = WINDOW_MS,
  maxAttempts = MAX_ATTEMPTS,
  // The caller's own hashed address. When given, the per-caller count
  // only sees rows from the same source; the account-wide cap still
  // sees everything. When absent - a request with no usable address -
  // both counts see everything, which is the conservative direction.
  ipHash = null,
  maxAttemptsAllSources = MAX_ATTEMPTS_ALL_SOURCES,
} = {}) {
  const cutoff = now - windowMs
  const all = (rows || [])
    .filter((r) => r && Number.isFinite(new Date(r.created_at).getTime()))
    .filter((r) => new Date(r.created_at).getTime() > cutoff)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))

  const recent = ipHash ? all.filter((r) => r.ip_hash === ipHash) : all

  // A success inside the window clears everything before it. Without
  // this, "four wrong, then the real user got in, then one more typo"
  // would lock out an account that has just proved itself - and the
  // whole point of counting successes as well as failures is to be able
  // to tell those two situations apart.
  const lastSuccessAt = recent.find((r) => r.succeeded)
  const countedFrom = lastSuccessAt ? new Date(lastSuccessAt.created_at).getTime() : cutoff
  const failures = recent.filter((r) => !r.succeeded && new Date(r.created_at).getTime() > countedFrom)

  // The account-wide cap, counted over every source and NOT cleared by
  // a success from somewhere else: a success on the owner's laptop
  // should not hand an attacker twenty fresh guesses.
  const allFailures = all.filter((r) => !r.succeeded)
  if (allFailures.length >= maxAttemptsAllSources) {
    const oldestAll = allFailures[allFailures.length - 1]
    return {
      allowed: false,
      failures: allFailures.length,
      remaining: 0,
      retryAfterMs: Math.max(0, new Date(oldestAll.created_at).getTime() + windowMs - now),
      scope: 'account',
    }
  }

  if (failures.length < maxAttempts) {
    return {
      allowed: true,
      failures: failures.length,
      remaining: maxAttempts - failures.length,
      retryAfterMs: 0,
      scope: 'caller',
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
    scope: 'caller',
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

// Did the caller's own token prove the code was correct?
//
// THIS REPLACES A CLIENT-REPORTED BOOLEAN, and the reason is worth
// stating plainly because the first version of this file got it wrong
// in a way its own comments contradicted. /api/mfa-attempt used to take
// `succeeded` out of the request body - the caller asserted whether its
// own code had passed. Since a success inside the window clears every
// failure before it, one POST of {"succeeded":true} from a session
// holding nothing but the password reset the lockout, and the attacker
// could guess forever while the attempt table recorded only successes.
// The file had already argued that "a counter the browser owns is a
// counter the attacker owns" and then took the counted value from the
// browser.
//
// The fix is to derive the outcome from something the browser cannot
// forge: the access token the auth server minted. A correct code
// produces a NEW token, elevated to aal2 and carrying a fresh mfa/*
// entry in amr. A wrong code leaves the old token untouched. The
// claims were validated by getUser() before they reach this function,
// so they are the auth server's word, not the caller's.
//
// Two signals, in order:
//   1. aal must be aal2. An aal1 caller has demonstrably not passed a
//      second factor, whatever its request body says.
//   2. amr must carry an mfa/* method stamped within the last couple of
//      minutes. This is what separates "just verified" from "verified
//      an hour ago and is now adding a second device from Account
//      settings" - without it, an already-aal2 user could never
//      accumulate failures and the limiter would not apply to
//      enrolment at all.
//
// If no amr entry carries a usable timestamp - Supabase may emit the
// RFC-8176 plain-string form - signal 2 cannot be evaluated and the
// decision falls back to signal 1 alone. That is a weaker test, but it
// still cannot be reached by a password-only session, which is the
// attack this exists to stop.
export const VERIFY_RECENCY_SEC = 120

export function observedSuccess(claims, { now = Date.now(), windowSec = VERIFY_RECENCY_SEC } = {}) {
  if (!claims || claims.aal !== 'aal2') return false

  const amr = Array.isArray(claims.amr) ? claims.amr : []
  let sawTimestamp = false
  for (const entry of amr) {
    if (typeof entry === 'string') continue
    const method = String(entry?.method || '').toLowerCase()
    const ts = Number(entry?.timestamp)
    if (!Number.isFinite(ts)) continue
    sawTimestamp = true
    // A second factor of any kind: mfa/totp today, mfa/phone or
    // mfa/webauthn if one is ever enabled.
    if (method.startsWith('mfa/') && (now / 1000) - ts <= windowSec) return true
  }
  // No timestamps to read: fall back to the assurance level alone.
  return !sawTimestamp
}
