import { createClient } from '@supabase/supabase-js'
import { createHash, randomBytes } from 'crypto'
import * as Sentry from '@sentry/nextjs'
import { parseDevice } from '@/lib/deviceLabel'
import { decodeJwtClaims } from '@/lib/authAssurance'
import {
  TRUST_COOKIE, trustCookieOptions, trustExpiresAt, sortTrustedDevices, describeTrustedDevice,
} from '@/lib/trustedDevice'

// Minting, listing and revoking "don't ask for a code on this browser".
//
// POST    remember this browser for 30 days (requires aal2 - see below)
// GET     list the browsers this account has remembered
// DELETE  forget one, by id, or all of them with ?all=1
//
// THE POST GATE IS THE WHOLE SECURITY STORY. A trusted-device cookie
// skips the second factor on every subsequent visit, so the request
// that creates one must come from a session that has JUST PASSED the
// second factor. Minting from an aal1 session would be a route that
// converts "I know the password" into "I never need the code again",
// which is worse than having no second factor at all - the user would
// believe they had one.
//
// The token itself never leaves this file in a readable form: the
// browser gets a random secret in an httpOnly cookie, the database
// gets only its SHA-256. A stolen database dump is a pile of hashes,
// not a pile of working skip-2FA tokens.

const TOKEN_BYTES = 32

// headers are MERGED, not replaced. Spreading `extra` over the options
// object would drop Content-Type the moment a caller passed a Set-Cookie,
// which works until something downstream starts caring about the type.
function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex')
}

async function authenticate(req) {
  const token = (req.headers.get('authorization') || '').replace('Bearer ', '').trim()
  if (!token) return { error: json(401, { error: 'Not authenticated' }) }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    Sentry.captureException(new Error('trusted-device: Supabase service credentials are not configured'))
    return { error: json(500, { error: 'Server is not configured' }) }
  }
  const admin = createClient(url, serviceKey)
  const { data, error } = await admin.auth.getUser(token)
  if (error || !data?.user) return { error: json(401, { error: 'Invalid session' }) }
  return { admin, user: data.user, accessToken: token }
}

// aal comes from the verified token's own claims. getUser() above has
// already revalidated it against the auth server, so reading them here
// is safe - but it is the ONLY thing standing between a password and a
// permanent 2FA skip, so it is checked explicitly rather than inferred
// from anything else.
function isFullyAuthenticated(accessToken) {
  // decodeJwtClaims, not a second inline decoder: this file had its
  // own copy, which meant two implementations of the same parsing
  // free to drift, and only one of them had the base64url padding
  // fix.
  return decodeJwtClaims(accessToken)?.aal === 'aal2'
}

export async function POST(req) {
  const auth = await authenticate(req)
  if (auth.error) return auth.error

  if (!isFullyAuthenticated(auth.accessToken)) {
    return json(403, { error: 'Finish signing in with your code before trusting this browser' })
  }

  const secret = randomBytes(TOKEN_BYTES).toString('hex')
  const { label } = parseDevice(req.headers.get('user-agent') || '')

  try {
    const { error } = await auth.admin.from('mfa_trusted_device').insert({
      user_id: auth.user.id,
      token_hash: hashToken(secret),
      label,
      expires_at: trustExpiresAt(),
      last_seen_at: new Date().toISOString(),
    })
    if (error) throw error
  } catch (err) {
    Sentry.captureException(err)
    // Not fatal to the sign-in. The user is already authenticated; all
    // they lose is the convenience they asked for, and telling them
    // that is better than failing a login over it.
    return json(200, { trusted: false, reason: 'not-saved' })
  }

  const secure = (process.env.NODE_ENV === 'production')
  const opts = trustCookieOptions({ secure })
  const cookie = [
    `${TRUST_COOKIE}=${secret}`,
    `Path=${opts.path}`,
    `Max-Age=${opts.maxAge}`,
    'HttpOnly',
    `SameSite=${opts.sameSite === 'lax' ? 'Lax' : opts.sameSite}`,
    secure ? 'Secure' : null,
  ].filter(Boolean).join('; ')

  return json(200, { trusted: true, label }, { 'Set-Cookie': cookie })
}

export async function GET(req) {
  const auth = await authenticate(req)
  if (auth.error) return auth.error

  // aal2 to read the list. It names the owner's machines and when
  // each was last used - a map of where they work, which a session
  // holding only the password has no business being handed.
  if (!isFullyAuthenticated(auth.accessToken)) {
    return json(403, { error: 'Finish signing in with your code first' })
  }

  try {
    const { data, error } = await auth.admin
      .from('mfa_trusted_device')
      .select('id, label, created_at, last_seen_at, expires_at, user_id')
      .eq('user_id', auth.user.id)
    if (error) throw error
    const now = Date.now()
    return json(200, { devices: sortTrustedDevices(data, { now }).map((r) => describeTrustedDevice(r, { now })) })
  } catch (err) {
    Sentry.captureException(err)
    return json(500, { error: 'Could not read your trusted browsers' })
  }
}

export async function DELETE(req) {
  const auth = await authenticate(req)
  if (auth.error) return auth.error

  // aal2 to revoke, too. On its own, forcing the owner to be
  // challenged again is a nuisance rather than a breach - but paired
  // with a lockout it is a way to make sure they cannot get past the
  // step they are being held at.
  if (!isFullyAuthenticated(auth.accessToken)) {
    return json(403, { error: 'Finish signing in with your code first' })
  }

  const params = new URL(req.url).searchParams
  const all = params.get('all') === '1'
  const id = params.get('id')
  if (!all && !id) return json(400, { error: 'Pass an id, or all=1' })

  try {
    // Always scoped to this user as well as to the id. Without the
    // user_id clause, knowing somebody else's row id would be enough
    // to revoke their trusted browser - a small harm, but a trivially
    // avoidable one.
    let q = auth.admin.from('mfa_trusted_device').delete().eq('user_id', auth.user.id)
    if (!all) q = q.eq('id', id)
    const { error } = await q
    if (error) throw error
  } catch (err) {
    Sentry.captureException(err)
    return json(500, { error: 'Could not forget that browser' })
  }

  // Clear this browser's own cookie when everything was revoked, so it
  // does not keep presenting a token that no longer resolves.
  const headers = {}
  if (all) headers['Set-Cookie'] = `${TRUST_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`
  return json(200, { ok: true }, headers)
}
