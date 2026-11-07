// Server-side gate for every /app/* route - systems-map audit finding #5.
// Before this, "is this person logged in?" was only ever answered in the
// browser (app/app/layout.js's getSession() check + a checked render-gate),
// after the page's full JS had already shipped. Postgres RLS was always the
// real data boundary (confirmed already correct, nothing changes there) -
// this closes the separate, smaller gap of a signed-out visitor (or a bot)
// downloading the whole app shell before being redirected away.
//
// Only possible now that lib/supabaseClient.js persists the session via
// cookies (createBrowserClient, @supabase/ssr) instead of localStorage -
// proxy.js (renamed from middleware.js in Next.js 16 - see the deprecation
// notice at node_modules/next/dist/docs/.../file-conventions/proxy.md) runs
// before any page component, with access to the request's cookies and
// nothing else. Defaults to the Node.js runtime as of v16, so nothing here
// needs to avoid Node-only APIs.
import { createServerClient } from '@supabase/ssr'
import { NextResponse } from 'next/server'
import { supabaseUrl, supabaseAnonKey } from '@/lib/supabaseConfig'
import { isMockDbEnabled } from '@/lib/mockMode'
import { decodeJwtClaims, sessionNeedsSecondFactor, verifiedFactorsOf } from '@/lib/authAssurance'
import { createClient } from '@supabase/supabase-js'
import { createHash } from 'crypto'
import { TRUST_COOKIE, isTrustedRowValid } from '@/lib/trustedDevice'

export async function proxy(request) {
  // Mock-DB dev mode (npm run dev:mock) never talks to real Supabase -
  // next.config.js's Turbopack alias swaps lib/supabaseClient.js for an
  // in-memory fake, but that alias doesn't (and can't) reach this file, so
  // without this guard every /app/* request here would try a real auth
  // check against .env.local's placeholder URL, always fail, and redirect
  // every single page to /login - silently breaking the exact workflow
  // CLAUDE.md calls out as how UI changes get verified without touching
  // production data. Same escape hatch every mock-DB-aware file already
  // uses, just needed here too since proxy.js sits outside that alias.
  //
  // isMockDbEnabled(), not the env var directly - this branch skips the auth
  // check entirely, so it additionally refuses to engage in a production
  // build. See lib/mockMode.js for why that second condition is there.
  if (isMockDbEnabled()) {
    return NextResponse.next()
  }

  // Re-created every request on purpose (never cached/module-level) - the
  // library's own docs are explicit that a server client must be scoped to
  // one request, unlike the browser client's deliberate singleton reuse.
  let response = NextResponse.next({ request })

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      // Called when a token refresh needs to write updated cookies back.
      // Mirrors both onto the request (so this same middleware pass, and
      // whatever server component runs next, sees the refreshed session)
      // and onto a fresh response built from that updated request (so the
      // browser actually receives the new cookies) - the exact pattern
      // @supabase/ssr's own SetAllCookies type doc prescribes; the
      // simpler get/set/remove shape is deprecated for missing this.
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
        response = NextResponse.next({ request })
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options))
      },
    },
  })

  // getUser(), not getSession() - this revalidates the token against
  // Supabase's own Auth server rather than trusting whatever a possibly-
  // stale cookie claims, the documented reason to prefer it specifically
  // in middleware/server contexts. That real network call is also the one
  // thing here that can genuinely throw (a Supabase outage, DNS hiccup) -
  // wrapped so a transient failure lets the request through to the
  // client-side check (app/app/layout.js) rather than 500ing every single
  // /app/* page for every visitor until Supabase recovers. A malformed or
  // absent session resolves normally (user: null, no throw), so this only
  // ever catches a genuine infrastructure problem, not "not logged in."
  // NEVER CACHE A SIGNED-IN PAGE.
  //
  // Signing out and pressing Back used to re-display the app: the
  // browser restored the rendered page from its back/forward cache,
  // which runs no request and therefore passes no gate. The session
  // was gone and the page was still on screen.
  //
  // no-store is the specific thing that disqualifies a response from
  // that cache. It is applied through this helper rather than at one
  // point near the end because EVERY exit from here must carry it -
  // including the redirects, and including the fail-open return in
  // the catch below, which was the path that would otherwise have
  // kept serving a cacheable page during an outage.
  const uncached = (res) => {
    res.headers.set('Cache-Control', 'no-store, max-age=0, must-revalidate')
    return res
  }

  let user = null
  try {
    const result = await supabase.auth.getUser()
    user = result.data.user
  } catch {
    return uncached(response)
  }

  if (!user) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.search = ''
    return uncached(NextResponse.redirect(url))
  }

  // SECOND FACTOR. Until this, "is this person logged in?" was the only
  // question asked here, and two-factor authentication was enforced in
  // exactly one place in the whole app: the login form. That is not a
  // theoretical gap. A password-recovery link mints a real, live session
  // without ever presenting a code, so anyone holding the account's
  // email could reset the password and then navigate straight to /app -
  // with 2FA switched on - and never be asked for anything. The login
  // form was guarding a door that had another way in beside it.
  //
  // getSession() rather than another round trip: getUser() above has
  // already revalidated this exact token against the auth server, so the
  // cookie's claims are known good by the time they are read. That is
  // the whole reason decodeJwtClaims does no verification of its own -
  // it must never be mistaken for the thing that makes a token
  // trustworthy.
  //
  // Wrapped for the same reason the getUser() call above is: a thrown
  // exception in middleware 500s the page for every visitor. The
  // difference is what the catch does. Failing open on a Supabase outage
  // is right for "are you logged in", because the client-side check
  // still runs and the cost is a brief unauthenticated page shell. It is
  // NOT right here - failing open would wave through exactly the
  // sessions this exists to stop - so an unreadable session is sent to
  // the login page instead.
  let needsSecondFactor = false
  try {
    const { data: { session } } = await supabase.auth.getSession()
    needsSecondFactor = sessionNeedsSecondFactor({
      claims: decodeJwtClaims(session?.access_token),
      user,
    })
  } catch {
    needsSecondFactor = verifiedFactorsOf(user).length > 0
  }

  // A REMEMBERED BROWSER. The session is still aal1 - Supabase will
  // not mint aal2 without a code, so there is no way to make a
  // remembered browser genuinely fully authenticated. What the cookie
  // does is tell THIS gate that the browser passed a code recently
  // enough to be let through anyway. It is a decision EdgeLog makes
  // about EdgeLog's own pages, which is why it lives here.
  //
  // Checked only when the user would otherwise be bounced, so the
  // common path - already aal2, or no 2FA at all - costs nothing. The
  // database read happens on exactly the requests that were going to
  // be redirected regardless.
  if (needsSecondFactor) {
    needsSecondFactor = !(await browserIsTrusted(request, user.id))
  }

  if (needsSecondFactor) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    // The login page reads this and goes straight to the code step
    // rather than asking for a password the visitor has already given.
    // Without it, someone bounced out of a recovery session sees a bare
    // login form with no hint of why they were sent back.
    url.search = '?step=2fa'
    return uncached(NextResponse.redirect(url))
  }

  return uncached(response)
}

// Does this request carry a valid trusted-device token for this user?
//
// Every part of this fails closed. An unreadable cookie, an absent
// row, a row for another account, an expired row, a database error -
// each returns false and the user is asked for a code. The cost of a
// false negative is one extra code; the cost of a false positive is
// that the second factor stops existing for whoever holds the cookie.
async function browserIsTrusted(request, userId) {
  const secret = request.cookies.get(TRUST_COOKIE)?.value
  if (!secret) return false

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceKey) return false

  try {
    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const tokenHash = createHash('sha256').update(secret).digest('hex')
    // Matched on BOTH the hash and the user. A single-column lookup
    // that found the row and then compared user_id afterwards is the
    // shape this kind of bug usually takes; there is nothing to
    // compare afterwards here.
    const { data, error } = await admin
      .from('mfa_trusted_device')
      .select('id, user_id, expires_at')
      .eq('token_hash', tokenHash)
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle()
    if (error || !data) return false
    if (!isTrustedRowValid(data, { userId })) return false

    // Best effort, and deliberately not awaited for its result: a
    // failed timestamp update must not cost the user their sign-in.
    admin.from('mfa_trusted_device')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', data.id)
      .then(() => {}, () => {})

    return true
  } catch {
    return false
  }
}

// /app itself (the cross-instrument Overview) and everything nested under
// it (/app/account, /app/log, /app/NQ/dashboard, ...) - the same route
// tree app/app/layout.js's own client-side guard already covers. Every
// other route (the public marketing/auth pages, /api/*, /privacy, /terms)
// is untouched - proxy.js doesn't even run for them.
export const config = {
  matcher: ['/app', '/app/:path*'],
}
