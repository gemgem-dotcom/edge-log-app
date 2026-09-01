// Server-side paginated + filtered trade fetching for the trade log pages
// (app/app/[instrument]/log and app/app/log) - the two callers of
// TradeLogTable large enough to matter, and the two that actually pass
// `pageSize`. Every other caller (the dashboard's calendar-day table, the
// Overview page's Recent trades list, the per-strategy page) still fetches
// its full trade set once and filters/paginates it client-side, unchanged -
// their trade counts are small enough that this was never worth the added
// complexity here. See TradeLogTable.js's own `remote` prop for the other
// half of this.
import { supabase } from '@/lib/supabaseClient'
import { dedupeTags } from './tagsCache'

export const UNCLASSIFIED = 'unclassified'

export const EMPTY_FILTERS = { days: [], strategyKeys: [], direction: 'all', result: 'all', tags: [] }

// `result` (win/loss/breakeven/open) and `day_of_week` aren't typed in by
// the trader - they're derived from stored columns. Rather than filtering
// them in the browser (which only works once every matching row has
// already been fetched, defeating the point of paging server-side), result
// maps directly onto r_multiple's own sign/nullness, and day_of_week is a
// generated column added in schema.sql specifically so this can be a plain
// indexed filter instead of pulling every row down to compute
// getDay() in JS.
function applyResultFilter(query, result) {
  if (result === 'open') return query.is('r_multiple', null)
  if (result === 'win') return query.gt('r_multiple', 0)
  if (result === 'loss') return query.lt('r_multiple', 0)
  if (result === 'breakeven') return query.eq('r_multiple', 0)
  return query
}

// strategyKeys mixes real strategy ids with the UNCLASSIFIED sentinel
// (meaning strategy_id is null) - .in() alone can't express "in this list,
// or null", so this builds the two-part .or() PostgREST needs whenever
// both kinds of key are selected at once.
function applyStrategyFilter(query, strategyKeys) {
  if (!strategyKeys || strategyKeys.length === 0) return query
  const ids = strategyKeys.filter((k) => k !== UNCLASSIFIED)
  const wantsUnassigned = strategyKeys.includes(UNCLASSIFIED)
  const parts = []
  if (ids.length > 0) parts.push(`strategy_id.in.(${ids.join(',')})`)
  if (wantsUnassigned) parts.push('strategy_id.is.null')
  return parts.length > 0 ? query.or(parts.join(',')) : query
}

// One page of trades for the given instrument id(s), matching `filters`.
// `count: 'exact'` piggybacks the total-matching-row count onto the same
// request rather than a second round-trip. Returns { trades, totalCount,
// error } - callers keep whatever error message they already show today.
export async function fetchTradePage({ instrumentIds, page, pageSize, filters = EMPTY_FILTERS }) {
  const from = page * pageSize
  const to = from + pageSize - 1

  let query = supabase
    .from('trades')
    .select('*', { count: 'exact' })
    .in('instrument_id', instrumentIds)

  if (filters.days.length > 0) query = query.in('day_of_week', filters.days)
  if (filters.direction !== 'all') query = query.eq('direction', filters.direction)
  if (filters.tags.length > 0) query = query.overlaps('tags', filters.tags)
  query = applyResultFilter(query, filters.result)
  query = applyStrategyFilter(query, filters.strategyKeys)

  // .range() applied last (real PostgREST doesn't care about call order -
  // every .eq()/.in()/etc. just accumulates into one request regardless of
  // when it was chained - but the params still need to *exist* on the
  // builder before the request fires, which for an async builder means
  // "before the final await", not necessarily before .range() specifically.
  // Ordered this way regardless for clarity, and because it matters for
  // real - the mock client (lib/supabaseClient.mock.js) applies each
  // chained call as an immediate, sequential array transform, so a filter
  // called after .range() there would silently filter only the
  // already-sliced page instead of the full matching set.
  query = query
    .order('trade_date', { ascending: false })
    .order('trade_time', { ascending: false })
    .range(from, to)

  const { data, error, count } = await query
  return { trades: data || [], totalCount: count || 0, error }
}

// Every distinct tag in use across the given instrument id(s), for the tag
// filter menu's option list - can't be derived from just the current page
// once trades are paginated server-side (see TradeLogTable.js's tagOptions
// comment). Still an unbounded select of one column across every matching
// trade, same underlying shape as TradeForm.js's tag-suggestions fetch
// (lib/tagsCache.js) - lighter than pulling every column, but a real cost
// that grows with trade count; left as a known, documented simplification
// rather than solved here (a dedicated tags table would be the real fix,
// see the systems-map audit's follow-up notes).
export async function fetchDistinctTags(instrumentIds) {
  const { data } = await supabase.from('trades').select('tags').in('instrument_id', instrumentIds)
  return dedupeTags(data || [])
}
