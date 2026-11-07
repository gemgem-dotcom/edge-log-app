// Deciding whether a session has actually cleared its second factor.
//
// WHY THIS IS A MODULE AND NOT THREE LINES IN proxy.js. Before this,
// two-factor authentication was enforced in exactly one place in
// EdgeLog: the login form (app/login/page.js). proxy.js and the app
// shell both asked only "is there a user?", which is a different
// question. The gap that leaves is not theoretical - a password-recovery
// link produces a real, live session without ever presenting a code, so
// anyone holding the account's email could reset the password and then
// navigate straight to /app, with 2FA switched on, and never be asked
// for anything. The same logic now has to run in middleware, in the app
// shell and on the login page, so it lives somewhere all three can
// import and a test can reach.
//
// THE RULE, stated once: a session must be at aal2 if the account has
// any VERIFIED factor. Not "if 2FA is on" - an abandoned enrolment
// leaves an unverified factor behind, and treating that as protection
// would lock a user out of their own account over a QR code they never
// finished scanning.

// Decode a JWT payload without verifying it.
//
// Callers must have established the token's authenticity some other way
// first - in proxy.js that is supabase.auth.getUser(), which revalidates
// against the auth server. This function deliberately does no
// verification of its own, so that it can never be mistaken for the
// thing that makes a token trustworthy.
export function decodeJwtClaims(token) {
  const part = String(token || '').split('.')[1]
  if (!part) return null
  try {
    const padded = part.replace(/-/g, '+').replace(/_/g, '/')
    const pad = padded.length % 4 ? '='.repeat(4 - (padded.length % 4)) : ''
    const json = typeof atob === 'function'
      ? decodeURIComponent(Array.from(atob(padded + pad), (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''))
      : Buffer.from(padded + pad, 'base64').toString('utf8')
    const claims = JSON.parse(json)
    return claims && typeof claims === 'object' ? claims : null
  } catch {
    // A token we cannot read is not a token we can trust. Callers treat
    // null as "no assurance", which fails closed.
    return null
  }
}

// Verified factors only. An unverified factor is an abandoned enrolment,
// not a protection the user relies on.
export function verifiedFactorsOf(user) {
  return (user?.factors || []).filter((f) => f && f.status === 'verified')
}

// The one decision. Absent or unreadable claims count as aal1: a session
// whose assurance cannot be established has not demonstrated any.
export function sessionNeedsSecondFactor({ claims, user }) {
  if (verifiedFactorsOf(user).length === 0) return false
  return (claims?.aal || 'aal1') !== 'aal2'
}

// The authentication methods a genuine password-recovery session
// reports.
//
// MEASURED, NOT ASSUMED. scripts/probe-recovery-session.js mints a real
// recovery session against this project's auth server; on 2026-11-07 it
// returned aal "aal1" and amr [{"method":"otp","timestamp":...}]. There
// is no 'recovery' method in auth-js's own AMRMethod union - a recovery
// link is exchanged as a one-time password - but it is accepted here so
// that a future auth server which starts naming the method properly
// does not turn every password reset into a permanent lockout.
export const RECOVERY_AMR_METHODS = new Set(['otp', 'recovery'])

// Is this session one that is partway through a password reset?
//
// This is the gate on /api/clear-2fa, the one route in the app that can
// switch two-factor authentication off, so it is written to be as
// narrow as it can be:
//
//   aal1 only    an aal2 session has already proved it holds the
//                factor and belongs in Account settings instead.
//   exactly one  a token reporting ['password', 'otp'] is somebody who
//   method       signed in normally and then did something else, not
//                somebody recovering an account.
//
// It is only safe while EdgeLog issues no other kind of one-time
// password. There is no email-code sign-in and no magic link today; if
// either is ever added, 'otp' stops identifying a recovery and this
// needs a different proof entirely.
export function isRecoverySession(claims) {
  if (!claims) return false
  // Note the difference from sessionNeedsSecondFactor, which treats a
  // MISSING aal claim as aal1. That default is fail-closed there, where
  // aal1 means "challenge them". Here aal1 is the permissive answer, so
  // the same default would be fail-OPEN: a token with no aal claim at
  // all would be handed the power to switch 2FA off. The claim has to
  // be present and say aal1.
  if (claims.aal !== 'aal1') return false
  const methods = authMethodsOf(claims)
  return methods.length === 1 && RECOVERY_AMR_METHODS.has(methods[0])
}

// The authentication methods a session's token reports, flattened.
//
// Supabase emits amr in two shapes - an array of { method, timestamp }
// objects, and the RFC-8176 array of plain strings - and auth-js's own
// types say both are possible, so anything reading amr has to cope with
// each. Returns lowercase method names with nothing else.
export function authMethodsOf(claims) {
  const amr = claims?.amr
  if (!Array.isArray(amr)) return []
  return amr
    .map((e) => (typeof e === 'string' ? e : e?.method))
    .filter((m) => typeof m === 'string' && m)
    .map((m) => m.toLowerCase())
}
