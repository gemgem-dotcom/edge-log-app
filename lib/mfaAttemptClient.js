import { supabase } from '@/lib/supabaseClient'
import { lockoutMessage, remainingWarning } from '@/lib/mfaRateLimit'

// Browser side of the verification rate limit. Two call sites use it -
// the login page's code step and the account page's enrolment - and
// duplicating this in both is how one of them ends up with the check
// and the other without it.
//
// EVERY FAILURE HERE IS TREATED AS "ALLOWED". The limiter is a guard
// rail, not the thing that decides whether a code is correct. If it is
// unreachable, the worst case is that somebody gets more guesses at a
// six-digit code; if it instead blocked on its own failure, a hiccup
// in one table would lock every account with 2FA out of the app. The
// second is both likelier and worse, so this leans the other way on
// purpose - and the route it talks to leans the same way, for the same
// reason, which is why there is no case where a user is stuck with no
// explanation.

async function token() {
  const { data: { session } } = await supabase.auth.getSession()
  return session?.access_token || null
}

const OPEN = { allowed: true, remaining: null, message: null }

// Called before the code field is used. Returns the lockout message if
// the user must wait, null otherwise.
export async function checkAttemptAllowed(kind = 'totp') {
  try {
    const t = await token()
    if (!t) return OPEN
    const res = await fetch(`/api/mfa-attempt?kind=${encodeURIComponent(kind)}`, {
      headers: { Authorization: `Bearer ${t}` },
    })
    if (!res.ok) return OPEN
    const data = await res.json()
    return {
      allowed: data.allowed !== false,
      remaining: data.remaining,
      message: data.allowed === false ? (data.message || lockoutMessage(data.retryAfterMs)) : null,
    }
  } catch {
    return OPEN
  }
}

// Called after a verification, with whether it worked. Returns what to
// show the user: nothing on success, a lockout message once they are
// out of attempts, a countdown warning when they are nearly there.
export async function recordAttempt(kind, succeeded) {
  try {
    const t = await token()
    if (!t) return OPEN
    const res = await fetch('/api/mfa-attempt', {
      method: 'POST',
      headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, succeeded }),
    })
    if (!res.ok) return OPEN
    const data = await res.json()
    if (data.allowed === false) {
      return { allowed: false, remaining: 0, message: data.message || lockoutMessage(data.retryAfterMs) }
    }
    return {
      allowed: true,
      remaining: data.remaining,
      // Only on a failure, and only near the end. Telling someone
      // "4 attempts left" after a correct code is noise; telling them
      // "1 left" after a wrong one is what makes them stop and check
      // their authenticator's clock.
      message: succeeded ? null : remainingWarning(data.remaining),
    }
  } catch {
    return OPEN
  }
}
