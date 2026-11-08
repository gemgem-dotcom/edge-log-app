import { createClient } from '@supabase/supabase-js'
import { createHash } from 'crypto'
import * as Sentry from '@sentry/nextjs'
import { TRUST_COOKIE, isTrustedRowValid } from '@/lib/trustedDevice'

// "Has this browser already been told not to ask for a code?"
//
// WHY THIS EXISTS AT ALL - the bug it fixes.
//
// "Remember this browser for 30 days" did not work, and could not have.
// The cookie was only ever read by proxy.js, which guards /app. But the
// LOGIN FORM decided whether to show the code step purely from
// getAuthenticatorAssuranceLevel(), and never looked at the cookie. So
// a remembered browser was still asked for a code at sign-in, every
// time - and the user never reached the gate that would have let them
// through, because they were stopped at the form in front of it.
//
// The feature was answering a question nobody was asking.
//
// WHY A SEPARATE ROUTE FROM THE GET THAT LISTS DEVICES. That one
// requires aal2, deliberately: the list names the owner's machines and
// when each was last used, which is a map of where they work. This one
// has to answer at aal1 - a session that has not shown a code is
// exactly the caller it exists for - so it is kept as narrow as it can
// be. It returns one boolean about the caller's own account and
// nothing else: no label, no expiry, no count.
//
// IT GRANTS NOTHING BY ITSELF. Answering true only lets the login form
// skip its own prompt. The session stays aal1; proxy.js still validates
// the same cookie on the way into /app and is still what writes the
// assurance grant the row-level-security policies read. A caller who
// forges a true here gains nothing, because nothing downstream trusts
// this answer.

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

export async function GET(req) {
  const token = (req.headers.get('authorization') || '').replace('Bearer ', '').trim()
  if (!token) return json(401, { error: 'Not authenticated' })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    Sentry.captureException(new Error('trusted-device/check: credentials are not configured'))
    // Fail CLOSED: a question about assurance that cannot be answered
    // is not a yes. The user is asked for a code, which is the state
    // they were in before this route existed.
    return json(200, { trusted: false })
  }

  const secret = (req.headers.get('cookie') || '')
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${TRUST_COOKIE}=`))
    ?.slice(TRUST_COOKIE.length + 1)
  if (!secret) return json(200, { trusted: false })

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // getUser revalidates the token against the auth server. Without it a
  // forged user id plus a stolen cookie would answer true.
  const { data: userData, error: userError } = await admin.auth.getUser(token)
  const user = userData?.user
  if (userError || !user) return json(401, { error: 'Invalid session' })

  try {
    // Matched on BOTH columns in one query, as everywhere else that
    // reads this table. Finding the row by hash and comparing user_id
    // afterwards is the shape this bug usually takes.
    const tokenHash = createHash('sha256').update(secret).digest('hex')
    const { data: row, error } = await admin
      .from('mfa_trusted_device')
      .select('id, user_id, expires_at')
      .eq('token_hash', tokenHash)
      .eq('user_id', user.id)
      .limit(1)
      .maybeSingle()
    if (error) throw error

    const trusted = isTrustedRowValid(row, { userId: user.id })
    if (trusted) {
      // Best effort, and never allowed to change the answer.
      await admin
        .from('mfa_trusted_device')
        .update({ last_seen_at: new Date().toISOString() })
        .eq('id', row.id)
        .eq('user_id', user.id)
    }
    return json(200, { trusted })
  } catch (err) {
    Sentry.captureException(err)
    return json(200, { trusted: false })
  }
}
