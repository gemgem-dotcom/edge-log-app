// Some pure lib modules under test transitively import lib/supabaseClient.js,
// which constructs a Supabase client at module load time and throws if these
// are undefined. Never actually used - no test here talks to a real
// database - same placeholder-value convention CI's build step and
// npm run dev:mock already rely on (see .github/workflows/ci.yml).
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key'
