// Split out of lib/tutorial.js specifically so importing this one function
// never drags in that file's top-level `import { supabase } from
// '@/lib/supabaseClient'` - app/auth/callback/page.js's own extensive
// comment explains why that import, even as a side effect of importing
// something else from the same module, reintroduces the exact PKCE
// "invalid flow state" race this page's isolated client exists to avoid.
// This file must never import lib/supabaseClient.js, directly or
// otherwise, for that same reason.

// Google OAuth has no separate "create account" call the way email/
// password signUp() does - the very first successful sign-in for a given
// identity IS the account creation, so the callback page (the one place
// that sees a freshly-authenticated OAuth user) is the only hook available
// for it. created_at and last_sign_in_at land within moments of each other
// only on that first-ever sign-in; a returning user's created_at is always
// far older than "now". Getting the direction of this wrong would be the
// one genuinely bad outcome (see lib/tutorial.js's readTutorialState
// comment), so this only ever ADDS tutorial_status when it's entirely
// absent, and the window is deliberately tight - a false negative (an
// actual new user not getting the tutorial) is a far smaller loss than a
// false positive.
//
// Takes `client` rather than importing the shared supabase singleton,
// since the one caller (app/auth/callback/page.js) deliberately uses its
// own isolated client instance - see that file's own comment on why.
const NEW_ACCOUNT_WINDOW_MS = 60000
export async function markTutorialPendingIfNewAccount(client, user) {
  if (!user || user.user_metadata?.tutorial_status) return
  const created = new Date(user.created_at).getTime()
  const lastSignIn = new Date(user.last_sign_in_at).getTime()
  if (Number.isNaN(created) || Number.isNaN(lastSignIn)) return
  if (Math.abs(lastSignIn - created) > NEW_ACCOUNT_WINDOW_MS) return
  await client.auth.updateUser({ data: { tutorial_status: 'pending' } })
}
