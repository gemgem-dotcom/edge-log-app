// This file creates ONE connection to your Supabase database, that the
// rest of the app imports and reuses. Think of it as "the phone line"
// to your database — every part of the app that needs to read or write
// trades goes through this.
//
// The two values below come from your Supabase project settings, and
// get set in a file called `.env.local` (see .env.local.example) —
// NEVER hard-code real keys directly into this file.

import { createBrowserClient } from '@supabase/ssr'
import { supabaseUrl, supabaseAnonKey } from './supabaseConfig'

// createBrowserClient (not @supabase/supabase-js's plain createClient) -
// systems-map audit finding #5: this persists the session via cookies
// instead of only localStorage, which is what lets middleware.js verify a
// login server-side, before a protected page's own JS ever ships to the
// browser. No `cookies` option configured on purpose - the docs
// specifically recommend leaving this to the library's own document.cookie
// fallback rather than hand-rolling it.
//
// flowType: 'pkce' so Google sign-in (app/login, app/signup) redirects
// back with a ?code= param that app/auth/callback/page.js exchanges for a
// session, rather than tokens in a URL fragment the server never sees.
//
// Leave detectSessionInUrl on its default (true) here - reset-password/
// page.js depends on it to pick up the recovery link's token and fire the
// PASSWORD_RECOVERY event. app/auth/callback/page.js uses its own
// dedicated client (built from lib/supabaseConfig.js, not this file, and
// with isSingleton: false - see the comment there for why that second
// part matters now) so that constructing it never touches this shared
// client at all - see the comment there for why that distinction matters.
//
// experimental.recoveryCodes turns on auth.mfa.recoveryCodes.*, which is
// how an account gets a way back in when the authenticator is lost. The
// methods THROW a descriptive error when the flag is off rather than
// returning one, so this is not optional decoration - without it the
// recovery UI cannot run at all.
//
// Experimental in the SDK means the shape can change in a minor release,
// so the calls are kept behind lib/mfaRecovery.js and the probe at
// scripts/probe-auth-capabilities.js records that this project's auth
// server really serves /factors/recovery-codes (it does - measured, all
// three routes answer rather than 404).
export const supabase = createBrowserClient(supabaseUrl, supabaseAnonKey, {
  auth: { flowType: 'pkce', experimental: { recoveryCodes: true } },
})
