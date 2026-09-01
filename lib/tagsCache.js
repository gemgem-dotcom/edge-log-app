// Small per-session cache for TradeForm.js's tag-suggestions dropdown -
// same shape and reasoning as lib/referenceDataCache.js's instruments/
// strategies cache: opening the trade form is the single most frequently
// visited screen in the app, and re-fetching every tag on every one of
// those visits (an unbounded `select('tags')` across a trader's whole
// history) is real, repeated cost for no benefit once it's already been
// fetched once this session.
//
// Only helps if it's never allowed to go stale: every trade write that
// could change what tags are in use (log/new and log/edit's onSubmit,
// TradeLogTable.js's delete) calls invalidateTags() in the same breath as
// its own success path, same discipline referenceDataCache's own header
// comment describes. This still doesn't eliminate the underlying
// unbounded-fetch shape (see lib/tradeQuery.js's fetchDistinctTags, which
// has the identical cost) - it only avoids paying it on every repeat visit
// within one session that didn't actually change any tags.
let tagsCache = null // { userId, data: string[] } | null

// Case-insensitive dedup ("FOMC" and "fomc" are one tag, kept under
// whichever casing was seen first), sorted for display - shared with
// lib/tradeQuery.js's fetchDistinctTags, which needs the exact same
// dedup/sort over a differently-scoped set of rows (by instrument rather
// than by user), so the two don't drift on what counts as "the same tag".
export function dedupeTags(rows) {
  const seen = new Map()
  for (const row of rows) {
    for (const tag of row.tags || []) {
      const key = tag.toLowerCase()
      if (!seen.has(key)) seen.set(key, tag)
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b))
}

export async function getTags(supabase, userId) {
  if (tagsCache && tagsCache.userId === userId) return tagsCache.data
  const { data } = await supabase.from('trades').select('tags').eq('user_id', userId)
  const rows = dedupeTags(data || [])
  tagsCache = { userId, data: rows }
  return rows
}

export function invalidateTags() {
  tagsCache = null
}
