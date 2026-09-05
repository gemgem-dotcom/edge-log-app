// Small per-session cache for instruments/strategies - rows that almost
// never change but app/app/[instrument]/layout.js re-fetches on every
// in-app navigation under /app/[instrument]/... (its loadData effect
// deliberately depends on pathname, not just an instrument switch - see the
// comment on that effect for why: a strategy deleted from its own detail
// page redirects back here, and the sidebar needs to drop it immediately).
// That re-fetch only became worth caching once sidebar navigation switched
// from plain <a> tags to next/link's <Link> (same PR) - a plain <a> causes
// a full page reload, which wipes any in-browser cache on every click
// regardless of what's built here, so this was tried and deliberately
// reverted once before. With real client-side transitions, the layout now
// actually stays mounted across a page-to-page click, so this cache is hit
// for real instead of being dead weight.
//
// This only helps if it's never allowed to go stale, so every write to
// either table calls the matching invalidate* below in the same breath as
// its own success path - lib/instruments.js (add/restore an instrument),
// components/InstrumentMenu.js (archive one), components/TradeForm.js,
// this layout's own add-strategy, and the strategy detail +
// strategies-management pages (rename/archive/delete one). (app/app/page.js's
// onboarding used to insert a strategy too; that path no longer exists.) Treat adding a new write path to either
// table as also needing one of these calls, the same way a new column
// needs a schema.sql entry.
let instrumentsCache = null // { userId, data } | null
const strategiesCache = new Map() // instrumentId -> data[]

export async function getInstruments(supabase, userId) {
  if (instrumentsCache && instrumentsCache.userId === userId) return instrumentsCache.data
  const { data } = await supabase
    .from('instruments')
    .select('*')
    .eq('user_id', userId)
    .eq('archived', false)
    .order('created_at', { ascending: true })
  const rows = data || []
  instrumentsCache = { userId, data: rows }
  return rows
}

export async function getStrategies(supabase, instrumentId) {
  if (strategiesCache.has(instrumentId)) return strategiesCache.get(instrumentId)
  const { data } = await supabase
    .from('strategies')
    .select('*')
    .eq('instrument_id', instrumentId)
    .eq('archived', false)
    .order('created_at', { ascending: true })
  const rows = data || []
  strategiesCache.set(instrumentId, rows)
  return rows
}

// Synchronous peek at whatever's already cached, for seeding a component's
// very first render instead of leaving it to paint a loading state it's
// about to throw away one tick later - app/app/page.js's Overview uses this
// so a soft navigation in from any other /app page renders the shell
// immediately, the same way readCachedTutorialState seeds that page's
// tutorial overlay. Whoever seeds from this still runs the real async load
// right after, which corrects anything stale.
//
// Returns null (i.e. "not warm, gate normally") when there's no cache yet
// or the cached list is empty. The empty case matters: zero instruments is
// exactly the state that routes a brand-new account into its name/timezone
// onboarding steps, and seeding a render from it would flash the Overview's
// own empty state before that decision has been made.
//
// Not scoped by userId, unlike getInstruments' own read - there's no user
// id to check against synchronously. Safe because clearReferenceDataCache()
// runs on every sign-out and session-expiry path (app/app/layout.js's
// onAuthStateChange), so a cache that exists at all belongs to the user
// who's signed in right now.
export function peekReferenceData() {
  if (!instrumentsCache || instrumentsCache.data.length === 0) return null
  const instruments = instrumentsCache.data
  // Strategies are keyed per instrument, and an instrument the user hasn't
  // opened yet won't have any cached - seed with whichever are already
  // known rather than treating a partial list as cold. The full list lands
  // a tick later from the caller's own load; a sidebar that fills in one
  // more strategy beats a full-screen loading page.
  return { instruments, strategies: instruments.flatMap((i) => strategiesCache.get(i.id) ?? []) }
}

export function invalidateInstruments() {
  instrumentsCache = null
}

export function invalidateStrategies(instrumentId) {
  strategiesCache.delete(instrumentId)
}

// instrumentsCache is scoped by userId (checked on read above), so a
// different user signing in on the same tab already gets a clean refetch
// without this. strategiesCache has no such scoping - only instrumentId
// keys - so it's safe today purely because instrument ids are real
// Postgres UUIDs, not because anything here enforces per-user isolation.
// Called from app/app/layout.js's onAuthStateChange on every sign-out and
// session-expiry path, so a second user on the same tab always starts from
// an empty cache rather than relying on that UUID-collision argument.
export function clearReferenceDataCache() {
  instrumentsCache = null
  strategiesCache.clear()
}
