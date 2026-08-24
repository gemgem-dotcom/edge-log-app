// The only thing this config does: when NEXT_PUBLIC_USE_MOCK_DB=true (see
// `npm run dev:mock`), redirect every import of lib/supabaseClient - however
// it was written (`@/lib/supabaseClient`, `../lib/supabaseClient`,
// `../../lib/supabaseClient`) - to lib/supabaseClient.mock.js instead.
// NormalModuleReplacementPlugin matches on the request string itself
// (before it's resolved to a path), so it works regardless of how deep the
// importing file is nested - a plain webpack alias can't do that, since
// alias keys have to match one exact specifier string.
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
  webpack: (config, { webpack }) => {
    if (process.env.NEXT_PUBLIC_USE_MOCK_DB === 'true') {
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(
          /lib\/supabaseClient$/,
          require.resolve('./lib/supabaseClient.mock.js')
        )
      )
    }
    return config
  },
}

module.exports = nextConfig
