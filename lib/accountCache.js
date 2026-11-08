// Last-known Account settings, so the tab does not show a skeleton on
// every single visit.
//
// THE COMPLAINT THIS ANSWERS, verbatim: "anytime I switch to the accounts
// tab the skeleton appears". It did, every time, because this screen
// cached nothing and re-ran four round-trips in series on every mount -
// getUser(), listFactors(), the instruments and the sign-in history.
// Account was the one tab that could never be instant, which made it the
// odd one out however fast the others became.
//
// Stale-while-revalidate, the same contract as lib/tradesCache.js: the
// peek seeds the first paint, the real load runs regardless and replaces
// it, so anything stale lasts one request rather than until a reload.
//
// WHAT IS DELIBERATELY NOT CACHED. Nothing here is a trust decision and
// nothing here gates an action. The 2FA factor list seeds the row's
// summary text, but every route that acts on a factor - enrolling,
// unenrolling, verifying - re-reads it server-side first, so a stale copy
// changes what the row SAYS for one request and never what it can DO.
// Keep it that way: if a control is ever added that acts on this copy
// without re-reading, it has to read the live list instead.
//
// CLEARED ON SIGN-OUT, which is not optional. This holds one account's
// email, name and sign-in history in a module variable with no user id on
// it - the same hazard peekReferenceData carries, and safe for the same
// reason: app/app/layout.js's onAuthStateChange clears it alongside every
// other per-session cache on each sign-out and session-expiry path, so a
// second user on the same tab can never peek the first user's details.
let cached = null

export function peekAccount() {
  return cached
}

export function writeAccount(state) {
  if (!state) return
  cached = state
}

export function clearAccountCache() {
  cached = null
}
