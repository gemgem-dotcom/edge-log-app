// The only thing this config does: when NEXT_PUBLIC_USE_MOCK_DB=true (see
// `npm run dev:mock`), redirect every import of lib/supabaseClient to
// lib/supabaseClient.mock.js instead.
//
// Next.js 16 made Turbopack the default bundler for both `next dev` and
// `next build`, and a custom `webpack` config (what this used to be, via
// NormalModuleReplacementPlugin) now makes `next build` fail outright under
// Turbopack rather than silently doing nothing - so this is a Turbopack-
// native resolveAlias instead. Unlike NormalModuleReplacementPlugin's regex
// match (which caught any import specifier ending in `lib/supabaseClient`,
// regardless of how deep the importing file was nested), resolveAlias
// matches the exact specifier string as written - so every file that
// imports supabaseClient uses the `@/lib/supabaseClient` form, even the
// handful one directory away that CLAUDE.md's own import convention would
// otherwise leave as a relative `../lib/supabaseClient`, specifically so
// this one alias entry covers all of them. `turbopack: {}` is present even
// outside mock mode - an empty config, same as no config, but Turbopack
// otherwise flags a webpack-shaped config file with no turbopack key as a
// likely mistake even when (as here) there's no webpack key left at all.
//
// The env var is never set in Vercel or the CI build (see .github/workflows
// /ci.yml and CLAUDE.md's Environment section), so this branch never runs
// outside a local `npm run dev:mock` - the real client, and the real
// database, are what every actual deployment ever uses.
//
// lib/supabaseConfig.js (the raw url/key pair app/auth/callback/page.js
// builds its own client from) is deliberately NOT aliased here - mock mode
// is for exercising the app's own pages against fake data, not for testing
// the Google OAuth callback flow.
// The NODE_ENV half mirrors lib/mockMode.js (which this file can't import -
// it's CommonJS, evaluated before the app's module graph exists). `next dev`
// sets NODE_ENV=development, so dev:mock is unaffected; `next build` sets
// production, so a production bundle can never resolve to the fake client
// even if the env var were set. Belt and braces with the runtime guards.
// ---------------------------------------------------------------
// SECURITY HEADERS
//
// The app shipped with none of these. An audit put it plainly: every
// page, including /app/account and the trade log, could be framed by
// any site - so a clickjacking overlay could drive the delete-account
// control and "sign out everywhere"; URLs carrying ids leaked in the
// Referer to any third-party host a page touched; and there was no
// second line of defence behind any future injected-script bug.
//
// CSP NOTES, because two entries here look odd and are load-bearing:
//
//   'unsafe-inline' in script-src is for the theme bootstrap in
//   app/layout.js, which must run before React hydrates or the page
//   flashes the wrong theme. Its content is a static literal with no
//   interpolation, so it is not an injection point. A nonce would be
//   better and needs the script to move behind middleware, which is a
//   change worth making on its own rather than smuggling in here.
//
//   connect-src has to name Supabase explicitly: the browser client
//   talks to it directly, and 'self' does not cover it. It is read
//   from the env var rather than hardcoded so a project move does not
//   silently break every query. https: is NOT used as a catch-all -
//   the whole value of connect-src is naming where data may go.
const supabaseOrigin = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).origin
  } catch {
    // No URL at config time (a bare `next lint`, say). Falling back to
    // the wildcard would quietly produce a useless policy, so fall
    // back to nothing and let the connection fail loudly instead.
    return ''
  }
})()

const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  // 'unsafe-eval' in DEVELOPMENT ONLY. Turbopack's hot reload evaluates
  // modules with eval, so without this every page in `npm run dev:mock`
  // logs a CSP error and HMR stops working - which would quietly
  // degrade the exact workflow CLAUDE.md says to verify UI changes in.
  // The production bundle does not use eval: that was checked by
  // building, serving with `next start`, and walking the pages with a
  // console listener, not assumed. NODE_ENV is set to production by
  // `next build`, so a shipped bundle can never pick this up.
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'production' ? '' : " 'unsafe-eval'"}`,
  // fonts.googleapis.com serves the stylesheet, fonts.gstatic.com the
  // font files. The first version of this policy omitted both and
  // blocked every page's typography - caught by walking the app with
  // a console listener rather than by reading the policy, which is
  // the only way a CSP mistake shows up.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  // data: for the 2FA QR code, which the auth server returns as a
  // data: URI; blob: for the screenshot previews the trade form makes
  // with URL.createObjectURL.
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https://fonts.gstatic.com",
  `connect-src 'self' ${supabaseOrigin} https://*.ingest.sentry.io https://*.ingest.us.sentry.io`.trim(),
  "worker-src 'self' blob:",
  'upgrade-insecure-requests',
].join('; ')

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  // Redundant with frame-ancestors for modern browsers, kept for the
  // ones that honour only this.
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // strict-origin-when-cross-origin keeps the path off cross-origin
  // requests. /app/NQ/log?strategy=<uuid> and /app/NQ/log/<id>/edit both
  // carry ids that are useful to an attacker.
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
]

/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },
  turbopack: process.env.NEXT_PUBLIC_USE_MOCK_DB === 'true' && process.env.NODE_ENV !== 'production' ? {
    resolveAlias: {
      '@/lib/supabaseClient': './lib/supabaseClient.mock.js',
    },
  } : {},
}

module.exports = nextConfig
