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
/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: process.env.NEXT_PUBLIC_USE_MOCK_DB === 'true' ? {
    resolveAlias: {
      '@/lib/supabaseClient': './lib/supabaseClient.mock.js',
    },
  } : {},
}

module.exports = nextConfig
