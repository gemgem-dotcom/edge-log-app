// Edge-runtime Sentry init - loaded by instrumentation.js's register() for
// any middleware/edge route this app ever adds. See sentry.server.config.js
// for why tracesSampleRate is 0 and withSentryConfig isn't used - same
// reasoning applies here.
import * as Sentry from '@sentry/nextjs'

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0,
  enabled: process.env.NODE_ENV === 'production' && !!process.env.NEXT_PUBLIC_SENTRY_DSN,
})
