// Last-known trades, so switching tabs does not stare at a skeleton.
//
// THE MEASUREMENT THIS EXISTS FOR. On a throttled phone against the mock
// database with realistic latency, every tab switch showed a skeleton for
// 1.3-1.8s - on EVERY visit, including the third visit to the same tab,
// because nothing was kept between them. The chain is serial across
// components: session, then instruments, then strategies, then the paged
// trades query. lib/referenceDataCache.js already removes the middle two
// on a repeat visit. This removes the last and largest one.
//
// STALE-WHILE-REVALIDATE, not a plain cache. A repeat visit paints the
// last known rows immediately and refetches in the background; when the
// fresh rows land, they replace what is on screen. That matters for a
// trading journal, where a wrong P&L figure is worse than a slow one:
//
//   - A missed invalidation self-corrects on the next visit, instead of
//     persisting until reload. A plain cache has no such floor.
//   - The stale window is one request long, and the figures only move if
//     they actually changed.
//   - It is per page-session. A reload fetches fresh, and nothing is
//     written to disk, so a shared machine keeps nothing.
//
// Even so, every write path calls invalidateTrades() in the same breath
// as its success, exactly as referenceDataCache's own comment requires of
// its callers. Treat a new write to `trades` as also needing that call,
// the same way a new column needs a schema.sql entry.

const cache = new Map() // key -> { rows, at }

// Keyed on the exact set of instruments the query covered, sorted so that
// the same set in a different order is the same key. A key that ignored
// this would serve one instrument's trades to a page asking for another's.
//
// `variant` separates callers whose queries differ in SHAPE over the same
// instruments, and it is not optional bookkeeping. The Overview orders by
// `id`; the strategies index orders by `trade_date`. Both ask for every
// trade of the same instruments, so on the set alone they collide - and
// the rows would come back in the other page's order, silently. Nothing
// would error; a strategies index would just draw its equity curve in
// insertion order. Any new caller that changes the order, the columns or
// the filter needs its own variant string.
export function tradesKey(instrumentIds, variant = '') {
  return `${variant}|${[...(instrumentIds || [])].map(String).sort().join(',')}`
}

export function readTrades(instrumentIds, variant = '') {
  const hit = cache.get(tradesKey(instrumentIds, variant))
  return hit ? hit.rows : null
}

export function writeTrades(instrumentIds, rows, variant = '') {
  if (!Array.isArray(rows)) return
  cache.set(tradesKey(instrumentIds, variant), { rows, at: Date.now() })
}

// Everything, not just one key. A trade can move between instruments and
// between strategies, so a write invalidates every set that might contain
// it. The map holds a handful of entries; clearing it costs nothing and
// reasoning about which keys are affected costs correctness.
export function invalidateTrades() {
  cache.clear()
  // Declared further down the file; this only ever runs after the module
  // has finished evaluating, so there is no temporal-dead-zone hazard.
  pageCache.clear()
  strategyCache.clear()
  for (const fn of listeners) fn()
}

// OTHER CACHES THAT HOLD TRADES clear themselves through this.
//
// lib/dashboardCache.js and lib/strategyIndexData.js both cache a composed
// result that contains trades, so a write to `trades` makes them stale too.
// Registering here rather than having each write path call three
// invalidators keeps the rule a single sentence - "a new write to `trades`
// calls invalidateTrades()" - instead of a list that a new call site will
// eventually get only partly right.
//
// This module imports nothing, so the registration direction (them -> here)
// cannot create a cycle.
const listeners = new Set()

export function onTradesInvalidated(fn) {
  listeners.add(fn)
}

// ---------------------------------------------------------------------
// The paged + filtered variant, for the two trade-log pages.
//
// Those pages cannot use the whole-set cache above: they fetch ONE page
// matching the current filters, with an exact total count, so what is
// cached has to be keyed on the page and the filters as well as the
// instruments. Keyed on anything less and switching a filter would paint
// the previous filter's rows as though they matched.
//
// Same stale-while-revalidate contract, same invalidateTrades() clearing
// both, which is why this lives here rather than in its own module.
const pageCache = new Map() // key -> { trades, totalCount }

// Every field of EMPTY_FILTERS, in a fixed order, with the array-valued
// ones sorted. Two filter objects that select the same trades have to
// produce the same key - built from Object.keys or JSON.stringify of the
// raw object they would not, because `{days:['mon','tue']}` and
// `{days:['tue','mon']}` are the same filter and `{direction, days}` and
// `{days, direction}` are the same object.
function filtersKey(f = {}) {
  const arr = (v) => [...(v || [])].map(String).sort().join('+')
  return [
    arr(f.days), arr(f.strategyKeys), arr(f.tags),
    f.direction || 'all', f.result || 'all',
  ].join('~')
}

function pageKey({ instrumentIds, page, pageSize, filters }) {
  return `${tradesKey(instrumentIds)}|${page}|${pageSize}|${filtersKey(filters)}`
}

export function readTradePage(args) {
  return pageCache.get(pageKey(args)) || null
}

export function writeTradePage(args, trades, totalCount) {
  if (!Array.isArray(trades)) return
  pageCache.set(pageKey(args), { trades, totalCount })
}

// The strategies each log page fetched, beside the page of rows.
//
// WHY THIS IS NOT OPTIONAL. The trade log resolves every row's strategy
// NAME from this list. Seeding a page of rows without it painted a column
// of em-dashes where the strategy names belong - caught in the browser,
// not reasoned about - which reads as "my strategies are gone", the exact
// failure mode a cache is supposed to avoid. So the two are cached
// together and the pages seed only when BOTH are present; a half-warm
// cache falls back to the skeleton, which is honest.
//
// Keyed with a variant because the two log pages do not ask the same
// question: /app/log filters out archived strategies and the
// per-instrument log deliberately does not, so a trade tagged with an
// archived strategy still shows its name there. One key for both would
// blank exactly those rows.
const strategyCache = new Map() // key -> rows

export function readLogStrategies(instrumentIds, variant) {
  const hit = strategyCache.get(tradesKey(instrumentIds, variant))
  return hit || null
}

export function writeLogStrategies(instrumentIds, rows, variant) {
  if (!Array.isArray(rows)) return
  strategyCache.set(tradesKey(instrumentIds, variant), rows)
}
