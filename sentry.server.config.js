// Server-runtime (API routes, server components) Sentry init - loaded by
// instrumentation.js's register(), never imported directly. See
// NEXT_PUBLIC_SENTRY_DSN's own comment in instrumentation-client.js for why
// one env var covers both the browser and server/edge here.
//
// tracesSampleRate: 0 - this is error tracking only (the systems-map audit's
// finding #2), not performance/APM monitoring, which is a separate, paid-at-
// volume feature this app has no need for yet. withSentryConfig (next.config.js)
// is deliberately NOT used - it mainly wires up webpack-based build-time
// instrumentation and sourcemap upload, both of which this app's Turbopack-
// only build can't use anyway (see @sentry/nextjs's own
// SentryBuildWebpackOptions type comment: "If you build Next.js with
// turbopack, the Sentry SDK will no longer apply build-time instrumentation").
// Every capture in this app is a manual Sentry.captureException/captureMessage
// call at a specific, already-identified error path (see app/api/*/route.js
// and the two Databento scheduled scripts) rather than automatic route
// wrapping, so none of that build-time machinery is actually needed.
import * as Sentry from '@sentry/nextjs'

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0,
  // Only active in a real deployment with a real DSN configured - never
  // during local dev, npm run dev:mock, or the CI build (which uses
  // placeholder env values, same as Supabase's - see CLAUDE.md's
  // Environment section), so no test-session noise ever reaches Sentry.
  enabled: process.env.NODE_ENV === 'production' && !!process.env.NEXT_PUBLIC_SENTRY_DSN,
})
