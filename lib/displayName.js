// What to call the user, and why it is not `full_name`.
//
// THE BUG. Signing in with Google reset the name from "Gem" back to
// "Gemma Murray", every time.
//
// Supabase merges the provider's ID-token claims into user_metadata on
// EVERY OAuth sign-in, and `full_name` is one of Google's claims. So a
// name typed in Account settings and saved to `full_name` survives
// exactly until the next Google sign-in, which quietly overwrites it
// with whatever Google holds. Nothing in this app was at fault; it was
// writing its own setting into a field the identity provider owns.
//
// Checking the live account made that plain - its metadata carries
// `iss`, `sub`, `provider_id`, `picture`, `avatar_url`, `email_verified`,
// `name` and `full_name`, all Google's, beside EdgeLog's own `timezone`
// and `auto_logout_monthly`, which survive precisely because Google
// does not send them.
//
// THE FIX. Keep the chosen name in a key the provider never writes.
// `display_name` is unused and means exactly this.
//
// READS FALL BACK, so nothing breaks for an account that has not set one
// yet: a Google user still gets their Google name until they change it,
// and an email user still gets the name they typed at signup. Only a
// WRITE is redirected - which is the whole of the fix.
export const DISPLAY_NAME_KEY = 'display_name'

export function displayNameOf(user) {
  const meta = user?.user_metadata
  if (!meta) return ''
  const chosen = typeof meta[DISPLAY_NAME_KEY] === 'string' ? meta[DISPLAY_NAME_KEY].trim() : ''
  if (chosen) return chosen
  const provider = typeof meta.full_name === 'string' ? meta.full_name.trim() : ''
  return provider
}

// The payload for saving a name. Writes BOTH keys on purpose:
//
//   display_name  is the one that is read first and that Google cannot
//                 touch, so it is what actually sticks.
//   full_name     is kept in step so that anything outside this app
//                 reading the conventional field - a Supabase dashboard,
//                 a future export, an email template - still sees the
//                 right name until Google next overwrites it.
//
// Writing only full_name was the bug. Writing only display_name would
// leave the conventional field permanently stale.
export function displayNameUpdate(name) {
  const trimmed = String(name || '').trim()
  return { [DISPLAY_NAME_KEY]: trimmed, full_name: trimmed }
}
