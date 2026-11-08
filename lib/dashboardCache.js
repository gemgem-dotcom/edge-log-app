import { onTradesInvalidated } from './tradesCache'

// Last-known per-instrument dashboard, so returning to the Overview tab
// paints instead of showing a skeleton for the length of its slowest query.
//
// WHY THIS PAGE NEEDS ITS OWN CACHE rather than reusing tradesCache. The
// dashboard does not just show trades: it shows them grouped by strategy,
// with the strategies themselves and the session regime beside them. The
// grouping is derived from two queries at once, so caching only the trades
// would still leave the page assembling an empty `tradesByStrategy` on the
// first frame - every strategy row blank beside a populated stats panel,
// which reads as data loss rather than as loading. What is cached is
// therefore the composed result, exactly as the page itself holds it.
//
// STALE-WHILE-REVALIDATE, the same contract as lib/tradesCache.js: the peek
// seeds the first paint, the real load runs regardless and replaces it, so
// anything stale lasts one request rather than until a reload. That floor is
// what makes this safe for a page of money figures - a missed invalidation
// self-corrects on the next visit instead of persisting.
//
// CLEARED ON SIGN-OUT, which is not optional. These are one user's trades
// and strategies in a module variable with no user id on it - the same
// hazard peekReferenceData carries, and safe for the same reason:
// app/app/layout.js's onAuthStateChange clears this alongside every other
// per-session cache on each sign-out and session-expiry path, so a second
// user on the same tab can never peek the first user's journal.
const cache = new Map() // symbol -> composed dashboard state

// What this holds contains trades, so a write to `trades` anywhere makes
// it stale - see onTradesInvalidated's comment on why it registers here
// instead of each write path calling this directly.
onTradesInvalidated(() => cache.clear())

export function peekDashboard(symbol) {
  if (!symbol) return null
  return cache.get(symbol) || null
}

export function writeDashboard(symbol, state) {
  if (!symbol || !state) return
  cache.set(symbol, state)
}

export function clearDashboardCache() {
  cache.clear()
}
