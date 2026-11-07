// "Don't ask for a code on this browser for 30 days."
//
// WHAT IT ACTUALLY DOES, because the obvious description is wrong. It
// does NOT skip the second factor: the session is still aal1, and
// Supabase will not mint an aal2 token without a code, so there is no
// way to make a remembered browser genuinely "fully authenticated".
// What it does is tell EdgeLog's own gate - proxy.js's assurance check
// - that this browser has proved itself recently enough to be let
// through at aal1. That is a decision the application makes about its
// own pages, which is why the rule lives here and not in the auth
// server.
//
// It follows that this cookie is as good as a second factor for
// anything EdgeLog protects, and must be treated that way:
//
//   - The cookie holds a random secret; the DATABASE holds only its
//     SHA-256. A stolen database dump is therefore not a pile of
//     working skip-2FA tokens.
//   - A row is bound to a user_id, and the lookup matches on both. A
//     token minted for one account is simply not found for another,
//     rather than being found and then checked - "found then checked"
//     is where this kind of thing usually goes wrong.
//   - Expiry is enforced from the ROW, not the cookie's own max-age.
//     A cookie's lifetime is a suggestion the browser makes to itself
//     and anyone can edit it; expires_at is the real deadline.
//   - Clearing the account's factors clears its trusted devices too.
//     Otherwise a browser remembered under the old setup would keep
//     skipping a challenge that no longer resembles the one it passed.

export const TRUST_DAYS = 30

// Thirty days because that is what "remember me" means to people, and
// because the session itself is signed out after thirty days of
// inactivity anyway (app/app/[instrument]/layout.js) - a longer trust
// window would outlive the thing it is attached to.
export const TRUST_MS = TRUST_DAYS * 24 * 60 * 60 * 1000

// Not prefixed NEXT_PUBLIC_ or anything resembling it, and read only
// on the server. __Host- would be stricter still, but it forbids a
// Domain attribute and requires Secure, which breaks local http
// development; the attributes below get the same protection where it
// matters.
export const TRUST_COOKIE = 'edgelog_td'

export function trustCookieOptions({ secure = true } = {}) {
  return {
    httpOnly: true,            // JavaScript must never be able to read it
    secure,                    // never sent over plain http in production
    sameSite: 'lax',           // survives a top-level navigation to /app, which strict would not
    path: '/',
    maxAge: Math.floor(TRUST_MS / 1000),
  }
}

// A row is usable if it belongs to this user and has not expired.
// Written as one function so that both the middleware and the account
// page's list agree on what "still trusted" means.
export function isTrustedRowValid(row, { userId, now = Date.now() } = {}) {
  if (!row || !row.expires_at) return false
  if (userId && row.user_id && row.user_id !== userId) return false
  const expires = new Date(row.expires_at).getTime()
  if (!Number.isFinite(expires)) return false
  return expires > now
}

export function trustExpiresAt(now = Date.now()) {
  return new Date(now + TRUST_MS).toISOString()
}

// How a remembered browser is described in Account settings. The label
// is what the user recognises; the dates are what lets them spot one
// they do not. "Expired" rows are shown rather than hidden until a
// sweep removes them, because a list that quietly drops entries is one
// people stop trusting.
export function describeTrustedDevice(row, { now = Date.now() } = {}) {
  const expires = new Date(row?.expires_at).getTime()
  const valid = Number.isFinite(expires) && expires > now
  const daysLeft = valid ? Math.max(1, Math.ceil((expires - now) / (24 * 60 * 60 * 1000))) : 0
  return {
    id: row?.id,
    label: row?.label || 'Unknown device',
    valid,
    daysLeft,
    note: valid
      ? `Won't ask for a code for ${daysLeft} more ${daysLeft === 1 ? 'day' : 'days'}`
      : 'Expired - this device will be asked for a code',
  }
}

// Newest first, and expired ones last regardless of age: the rows a
// user might want to revoke are the ones still working.
export function sortTrustedDevices(rows, { now = Date.now() } = {}) {
  return [...(rows || [])]
    .filter(Boolean)
    .sort((a, b) => {
      const av = isTrustedRowValid(a, { now }) ? 0 : 1
      const bv = isTrustedRowValid(b, { now }) ? 0 : 1
      if (av !== bv) return av - bv
      return new Date(b.last_seen_at || b.created_at || 0) - new Date(a.last_seen_at || a.created_at || 0)
    })
}
