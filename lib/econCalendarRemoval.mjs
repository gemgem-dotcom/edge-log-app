// Deciding which stored events Forex Factory has stopped listing.
//
// The fetch upserts, so until this existed a row lived forever: a speech
// that was cancelled, a release withdrawn, an event moved to another week -
// all of them stayed on the card indefinitely, with nothing to say they
// had stopped being real. Additions and revisions propagated; removals
// never did.
//
// The rule is "absent from a page that spoke for its day". After a page
// parses and stores, every event FF still lists in that page's own day
// range carries the run's fetched_at; anything older in the same range was
// not on the page.
//
// This module is only the DECISION, kept apart from the fetch script and
// pure, because it is the one piece of the pipeline that destroys data and
// it is worth being able to test the threshold directly rather than by
// reading it. The script owns the range, the read and the delete.

// A genuine removal is a handful of rows; a parse regression is hundreds.
// The proportion is the real guard - the floor only keeps a thin range (a
// quiet week, a legitimately sparse month) from being held to an
// impossibly tight absolute.
export const MAX_REMOVAL_FRACTION = 0.10
export const MIN_REMOVAL_ALLOWANCE = 5

export function removalAllowance(inRangeCount) {
  return Math.max(MIN_REMOVAL_ALLOWANCE, Math.floor(inRangeCount * MAX_REMOVAL_FRACTION))
}

// Rows in the range the page spoke for that the page did not mention.
//
// A missing fetched_at counts as stale rather than as fresh. The opposite
// default would let a row with no stamp survive every sweep forever, which
// is precisely the invisible-staleness this exists to end.
export function vanishedRows(inRange, since) {
  if (!Array.isArray(inRange) || !since) return []
  return inRange.filter((r) => !r?.fetched_at || r.fetched_at < since)
}

// Whether to act, and what on.
//
// Returns `allowed: false` rather than a trimmed list when the count is
// over the threshold. Deleting "as many as are allowed" would be the worst
// of both: it would still destroy data on a bad parse, and it would hide
// the signal that something was wrong by never looking unusual.
export function planRemoval(inRange, since) {
  const rows = Array.isArray(inRange) ? inRange : []
  const vanished = vanishedRows(rows, since)
  const allowance = removalAllowance(rows.length)
  return {
    vanished,
    allowance,
    inRangeCount: rows.length,
    allowed: vanished.length > 0 && vanished.length <= allowance,
  }
}
