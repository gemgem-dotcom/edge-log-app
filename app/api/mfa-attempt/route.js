import { createClient } from '@supabase/supabase-js'
import { createHash } from 'crypto'
import * as Sentry from '@sentry/nextjs'
import { attemptVerdict, isValidKind, lockoutMessage, observedSuccess } from '@/lib/mfaRateLimit'
import { decodeJwtClaims } from '@/lib/authAssurance'

// The server half of the verification rate limit.
//
// WHY A SERVER ROUTE AND NOT A COUNTER IN THE PAGE. A counter in the
// browser is a counter the attacker owns - reload the page and it is
// zero. The count has to live somewhere the client cannot reach, which
// is mfa_attempt, a table with row level security on and no policies
// at all, so only the service role can read or write it. A client that
// could edit its own attempt history could erase its own lockout,
// which is the whole control.
//
// Serverless is the other half of the reason. These routes run on
// instances that come and go, each with its own empty memory, so an
// in-process counter counts to one forever and limits nothing.
//
// WHAT THIS CANNOT DO. supabase.auth.mfa.verify() runs in the BROWSER
// and talks to the auth server directly; this route is not in that
// path and cannot stop a request reaching it. What it does is refuse
// to let EdgeLog's own login flow continue, and make the refusal
// durable across reloads. That raises the cost of attacking through
// the app. It does not touch someone scripting the public API, and the
// handover guide says exactly that rather than overclaiming.
//
// Two operations, one route:
//   GET   may this user try? - called before showing the code field
//   POST  record an attempt, and say where that leaves them
//
// Both require a valid session. At the point a code is being checked
// the user is already signed in at aal1 - the second factor is what is
// in question, not the first - so a bearer token is exactly the right
// level of proof here.

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// SHA-256 of the address, never the address. Enough to spot one source
// spraying many accounts if that is ever looked at; not enough to be a
// location history sitting in a journal's database. Salted with the
// service key so the hashes are useless outside this deployment - a
// bare SHA-256 of an IPv4 address is trivially reversible, since there
// are only four billion of them.
function hashIp(req, salt) {
  const forwarded = req.headers.get('x-forwarded-for') || ''
  const ip = forwarded.split(',')[0].trim() || req.headers.get('x-real-ip') || ''
  if (!ip) return null
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex')
}

async function authenticate(req) {
  const token = (req.headers.get('authorization') || '').replace('Bearer ', '').trim()
  if (!token) return { error: json(401, { error: 'Not authenticated' }) }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    Sentry.captureException(new Error('mfa-attempt: Supabase service credentials are not configured'))
    return { error: json(500, { error: 'Server is not configured' }) }
  }

  const admin = createClient(url, serviceKey)
  const { data, error } = await admin.auth.getUser(token)
  if (error || !data?.user) return { error: json(401, { error: 'Invalid session' }) }
  return { admin, user: data.user, serviceKey, accessToken: token }
}

async function readVerdict(admin, userId, kind, ipHash) {
  // Only the window's worth of rows, and only the two columns the
  // policy reads. This sits on the login path, so it is one small
  // indexed query (mfa_attempt_user_idx covers exactly this shape).
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { data, error } = await admin
    .from('mfa_attempt')
    .select('succeeded, created_at, ip_hash')
    .eq('user_id', userId)
    .eq('kind', kind)
    .gt('created_at', since)
    .order('created_at', { ascending: false })
    // Enough to see the account-wide cap (20) across several sources,
    // not just this caller's handful.
    .limit(200)
  if (error) throw error
  return attemptVerdict(data || [], { ipHash })
}

export async function GET(req) {
  const auth = await authenticate(req)
  if (auth.error) return auth.error

  const kind = new URL(req.url).searchParams.get('kind') || 'totp'
  if (!isValidKind(kind)) return json(400, { error: 'Unknown attempt kind' })

  try {
    const verdict = await readVerdict(auth.admin, auth.user.id, kind, hashIp(req, auth.serviceKey))
    return json(200, {
      allowed: verdict.allowed,
      remaining: verdict.remaining,
      retryAfterMs: verdict.retryAfterMs,
      message: verdict.allowed ? null : lockoutMessage(verdict.retryAfterMs),
    })
  } catch (err) {
    // FAIL OPEN, deliberately, and only here. If the limiter's own
    // table is unreachable, refusing every login would turn a database
    // hiccup into a total outage for every account with 2FA on - a
    // self-inflicted denial of service far more likely to happen, and
    // far more damaging, than the brute force this guards against. The
    // code itself still has to be correct; only the counting is skipped.
    Sentry.captureException(err)
    return json(200, { allowed: true, remaining: null, retryAfterMs: 0, message: null, degraded: true })
  }
}

export async function POST(req) {
  const auth = await authenticate(req)
  if (auth.error) return auth.error

  let body = {}
  try { body = await req.json() } catch { /* an empty body is fine - see below */ }
  const kind = body.kind || 'totp'
  if (!isValidKind(kind)) return json(400, { error: 'Unknown attempt kind' })

  // The outcome is NOT taken from the request. It used to be, and that
  // handed the lockout's off-switch to the caller: a session holding
  // only the password could POST {"succeeded":true}, clear every
  // recorded failure, and guess forever. See observedSuccess() for the
  // full reasoning. The token was validated by getUser() above, so its
  // claims are the auth server's word rather than the caller's.
  const succeeded = observedSuccess(decodeJwtClaims(auth.accessToken))

  try {
    // Recorded BEFORE the verdict is read back, so the attempt just
    // made is included in its own count. Reading first would let a
    // burst of parallel requests each see a stale count and all pass.
    const ipHash = hashIp(req, auth.serviceKey)
    const { error: insertError } = await auth.admin.from('mfa_attempt').insert({
      user_id: auth.user.id,
      kind,
      succeeded,
      ip_hash: ipHash,
    })
    if (insertError) throw insertError

    const verdict = await readVerdict(auth.admin, auth.user.id, kind, ipHash)
    return json(200, {
      allowed: verdict.allowed,
      remaining: verdict.remaining,
      retryAfterMs: verdict.retryAfterMs,
      message: verdict.allowed ? null : lockoutMessage(verdict.retryAfterMs),
    })
  } catch (err) {
    Sentry.captureException(err)
    return json(200, { allowed: true, remaining: null, retryAfterMs: 0, message: null, degraded: true })
  }
}
