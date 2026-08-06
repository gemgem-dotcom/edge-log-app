// Raw Supabase project config, deliberately with no client construction.
// Kept separate from supabaseClient.js so a file that needs to build its
// own client instance (app/auth/callback/page.js) can import just the
// url/key without also pulling in - and constructing - the shared
// `supabase` client. Importing any named export from a module runs that
// module's whole body, so importing supabaseUrl/supabaseAnonKey from
// supabaseClient.js would construct the shared client too (auto-detecting
// and consuming this page's ?code= via its own detectSessionInUrl, racing
// the callback page's own explicit exchange) even without ever touching
// the `supabase` export itself.
export const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
export const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
