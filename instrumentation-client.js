// Browser-runtime Sentry init - a reserved Next.js filename, auto-loaded at
// startup regardless of bundler (unlike the older sentry.client.config.js
// pattern, which relied on a webpack-specific auto-import and silently
// doesn't run under this app's Turbopack-only build - see sentry.server
// .config.js's comment on why withSentryConfig is skipped for the same
// underlying Turbopack-vs-webpack reason).
//
// NEXT_PUBLIC_SENTRY_DSN (not a plain SENTRY_DSN) because this file ships
// to the browser - only NEXT_PUBLIC_-prefixed env vars get inlined into
// client code at build time (same convention as NEXT_PUBLIC_SUPABASE_URL/
// ANON_KEY). A DSN is meant to be public - it only allows *sending* events
// in, never reading anything back out - so reusing the same public var
// name for the server/edge configs too (rather than a second, redundant
// server-only copy) is safe, not a leak.
import * as Sentry from '@sentry/nextjs'

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0,
  enabled: process.env.NODE_ENV === 'production' && !!process.env.NEXT_PUBLIC_SENTRY_DSN,
})
