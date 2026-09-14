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
// Compared as INSTANTS, not as strings. The two sides are spelled
// differently and always will be: `since` comes from JavaScript's
// toISOString ("2026-09-14T12:00:00.123Z") and fetched_at comes back from
// PostgREST rendered by Postgres, which uses a numeric offset and trims
// trailing zeros from the fraction ("2026-09-14T12:00:00.123+00:00").
//
// '+' is 0x2B and 'Z' is 0x5A, so a string compare calls every row written
// in the SAME millisecond as `since` older than it. That is not an edge
// case - storeEvents stamps a whole 200-row chunk in a tight map, so most
// of the first chunk lands in that millisecond. The page's own rows would
// have been judged removed: either tipping the count past the threshold so
// the feature refused on every run forever, or, when the millisecond
// happened to tick mid-chunk, deleting live events and logging them as FF
// removals.
//
// A missing or unparseable fetched_at still counts as stale. The opposite
// default would let a row with no usable stamp survive every sweep, which
// is precisely the invisible staleness this exists to end.
export function vanishedRows(inRange, since) {
  if (!Array.isArray(inRange)) return []
  const cutoff = Date.parse(since)
  if (Number.isNaN(cutoff)) return []
  return inRange.filter((r) => {
    const at = Date.parse(r?.fetched_at)
    return Number.isNaN(at) || at < cutoff
  })
}

// Whether to act, and what on.
//
// Returns `allowed: false` rather than a trimmed list when the count is
// over the threshold. Deleting "as many as are allowed" would be the worst
// of both: it would still destroy data on a bad parse, and it would hide
// the signal that something was wrong by never looking unusual.
// Restricts a scanned set to the days a page actually rendered. The scan
// is bounded by the outer span for one round trip; this is what makes the
// decision match the page rather than the span. With no windows given,
// nothing qualifies - a page that rendered no consecutive pair speaks for
// no day at all.
export function withinCoveredDays(rows, coveredDays) {
  if (!Array.isArray(coveredDays) || coveredDays.length === 0) return []
  return rows.filter((r) => {
    const at = r?.event_time
    return typeof at === 'string' && coveredDays.some(([from, to]) => at >= from && at < to)
  })
}

export function planRemoval(inRange, since, coveredDays = null) {
  const scanned = Array.isArray(inRange) ? inRange : []
  // When windows are supplied they define both what may be removed AND the
  // denominator, so the threshold is a proportion of what the page spoke
  // for rather than of a wider span it did not.
  const rows = coveredDays === null ? scanned : withinCoveredDays(scanned, coveredDays)
  const vanished = vanishedRows(rows, since)
  const allowance = removalAllowance(rows.length)
  return {
    vanished,
    allowance,
    inRangeCount: rows.length,
    allowed: vanished.length > 0 && vanished.length <= allowance,
  }
}
