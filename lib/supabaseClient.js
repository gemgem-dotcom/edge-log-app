// This file creates ONE connection to your Supabase database, that the
// rest of the app imports and reuses. Think of it as "the phone line"
// to your database — every part of the app that needs to read or write
// trades goes through this.
//
// The two values below come from your Supabase project settings, and
// get set in a file called `.env.local` (see .env.local.example) —
// NEVER hard-code real keys directly into this file.

import { createClient } from '@supabase/supabase-js'
import { supabaseUrl, supabaseAnonKey } from './supabaseConfig'

// flowType: 'pkce' so Google sign-in (app/login, app/signup) redirects
// back with a ?code= param that app/auth/callback/page.js exchanges for a
// session, rather than tokens in a URL fragment the server never sees.
//
// Leave detectSessionInUrl on its default (true) here - reset-password/
// page.js depends on it to pick up the recovery link's token and fire the
// PASSWORD_RECOVERY event. app/auth/callback/page.js uses its own
// dedicated client (built from lib/supabaseConfig.js, not this file) so
// that constructing it never touches this shared client at all - see the
// comment there for why that distinction matters.
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { flowType: 'pkce' },
})
