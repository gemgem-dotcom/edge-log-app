// Whether the in-memory mock database (npm run dev:mock, see
// lib/supabaseClient.mock.js) is active for this process.
//
// Both callers use this to skip a real Supabase auth check - proxy.js lets
// /app/* through without verifying a session, and app/api/generate-insights
// returns a canned narrative before authenticating. That makes this flag an
// auth bypass, not merely a data-source switch, so it carries a second
// condition the env var alone doesn't: never in a production build.
//
// NEXT_PUBLIC_USE_MOCK_DB is set in neither Vercel nor CI today, so mock
// mode cannot currently reach production either way. The NODE_ENV check is
// here so that adding that variable to a Vercel project by mistake - and
// preview deployments inherit production's environment - costs nothing
// worse than a confusing preview, rather than serving the whole app shell
// with its auth gate switched off. One env var should not be the only thing
// standing between a deploy and an unauthenticated app.
//
// next.config.js carries the same NODE_ENV condition inline on its own
// Turbopack alias; it can't import this file (it's CommonJS, loaded before
// the app's module graph exists).
export function isMockDbEnabled() {
  return process.env.NEXT_PUBLIC_USE_MOCK_DB === 'true' && process.env.NODE_ENV !== 'production'
}
