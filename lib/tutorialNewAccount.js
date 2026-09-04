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

function isNewAccount(user) {
  if (!user) return false
  const created = new Date(user.created_at).getTime()
  const lastSignIn = new Date(user.last_sign_in_at).getTime()
  if (Number.isNaN(created) || Number.isNaN(lastSignIn)) return false
  return Math.abs(lastSignIn - created) <= NEW_ACCOUNT_WINDOW_MS
}

export async function markTutorialPendingIfNewAccount(client, user) {
  if (!user || user.user_metadata?.tutorial_status) return
  if (!isNewAccount(user)) return
  await client.auth.updateUser({ data: { tutorial_status: 'pending' } })
}

// Theme preference lives in plain localStorage (see components/
// AppShell.js/[instrument]/layout.js, both of which read
// localStorage.getItem('edgelog-theme') on mount), which has no concept of
// *whose* preference it is - it's just whatever the last person to touch
// this browser left behind. That's invisible for a returning user signing
// back in on their own device, but signing out of one account and
// immediately creating a different one in the same browser carries the
// previous account's theme straight into the new account's very first
// render, before that new account has ever expressed a preference of its
// own. Reusing isNewAccount's same tight, false-negative-biased window
// (see its own comment above) rather than resetting on every OAuth
// sign-in, which would otherwise wipe a *returning* user's own saved
// choice on this device every time they log in.
//
// Clearing localStorage alone isn't enough: app/layout.js's own comment
// explains that data-theme is only ever applied to <html> by its
// pre-hydration inline script (once, on a hard navigation) or by an
// explicit toggle click - nothing re-applies it reactively from React
// state on mount. router.replace('/app') right after this is a client-side
// transition, which doesn't remount the root layout or re-run that script,
// so a stale data-theme="light" left over from the previous account would
// otherwise still be sitting on <html> - correct localStorage, wrong
// rendered theme - until the next full page load or manual toggle. Setting
// the attribute directly here is what actually fixes what's on screen.
export function resetThemeForNewAccount(user) {
  if (typeof window === 'undefined' || !isNewAccount(user)) return
  localStorage.removeItem('edgelog-theme')
  document.documentElement.setAttribute('data-theme', 'dark')
}
