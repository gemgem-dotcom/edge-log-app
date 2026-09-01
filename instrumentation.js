// Next.js's own instrumentation hook - picked up automatically at startup
// with no config flag needed (stable since Next.js 15). Separate from
// instrumentation-client.js (browser init, also auto-loaded by Next.js) -
// this only covers the server and edge runtimes, which is why the actual
// Sentry.init() calls live in two files this conditionally imports rather
// than one shared module: sentry.server.config.js and sentry.edge.config.js
// each pull in a runtime-appropriate build of the SDK, and importing the
// wrong one for the current runtime would fail.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config.js')
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config.js')
  }
}
