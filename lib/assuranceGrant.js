// Recording that a session may read data despite being aal1.
//
// WHY THIS EXISTS AT ALL. Two facts collide. "Remember this browser"
// leaves the session at aal1 on purpose - Supabase will not mint aal2
// without a code, so the cookie only tells proxy.js's gate to let the
// page through. And the row-level security policies now require
// assurance, because without them two-factor authentication protected
// the pages and not the rows: a password-only token could read the
// whole journal straight from PostgREST with the public anon key.
//
// Postgres cannot see the cookie. It CAN see `session_id`, which
// Supabase puts in every access token. So the bridge is a row: when
// the server validates a trusted-device cookie it records that
// session id, and session_meets_assurance() in schema.sql reads the
// same table. The grant is written by the server, never by the
// client, which is the whole reason it is trustworthy.

// A grant never outlives the trusted-device row it came from, and
// never outlives this either. A Supabase session is signed out after
// thirty days of inactivity anyway, so a longer grant would simply
// describe a session that no longer exists.
export const MAX_GRANT_MS = 30 * 24 * 60 * 60 * 1000

// The session id out of the token's claims.
//
// Returns null for anything that is not a plain uuid, because the
// value is written into a uuid column and compared against one in
// SQL. A malformed value must resolve to "no grant" rather than to a
// query error - the caller falls back to checking the cookie, and the
// worst case is one extra round trip.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function sessionIdFrom(claims) {
  const id = claims?.session_id
  return typeof id === 'string' && UUID.test(id) ? id : null
}

// When a grant minted now should end: the device's own expiry, capped.
// Takes the device row's expires_at so a grant can only ever be as
// long-lived as the trust it was derived from - shortening the device
// row later does not leave a longer grant behind it.
export function grantExpiry(deviceExpiresAt, { now = Date.now() } = {}) {
  // The null check is separate and comes first, because new Date(null)
  // is the epoch rather than Invalid Date - so a Number.isFinite guard
  // alone happily produced a 1970 expiry and wrote a permanently dead
  // grant row instead of writing nothing.
  if (deviceExpiresAt === null || deviceExpiresAt === undefined || deviceExpiresAt === '') return null
  const device = new Date(deviceExpiresAt).getTime()
  if (!Number.isFinite(device)) return null
  return new Date(Math.min(device, now + MAX_GRANT_MS)).toISOString()
}

export function isGrantValid(row, { now = Date.now() } = {}) {
  if (!row?.expires_at) return false
  const expires = new Date(row.expires_at).getTime()
  return Number.isFinite(expires) && expires > now
}
