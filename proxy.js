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
  if (process.env.NEXT_PUBLIC_USE_MOCK_DB === 'true') {
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
  let user = null
  try {
    const result = await supabase.auth.getUser()
    user = result.data.user
  } catch {
    return response
  }

  if (!user) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.search = ''
    return NextResponse.redirect(url)
  }

  return response
}

// /app itself (the cross-instrument Overview) and everything nested under
// it (/app/account, /app/log, /app/NQ/dashboard, ...) - the same route
// tree app/app/layout.js's own client-side guard already covers. Every
// other route (the public marketing/auth pages, /api/*, /privacy, /terms)
// is untouched - proxy.js doesn't even run for them.
export const config = {
  matcher: ['/app', '/app/:path*'],
}
