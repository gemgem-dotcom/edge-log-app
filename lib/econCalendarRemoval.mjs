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
// So this is not a quota - it is a tripwire for "the page did not say what
// we think it said".
//
// Three numbers, because a proportion alone is wrong at both ends:
//
//   FRACTION  scales with the range, so a week and a month are judged on
//             the same terms.
//   FLOOR     stops a thin range - a quiet week, a sparse month - being
//             held to an allowance of zero, where a single genuine
//             cancellation could never be acted on.
//   CAP       stops the proportion growing teeth. A month page holds ~400
//             rows in range, and 10% of that is 40: a parse regression
//             touching one impact class or one title shape is proportional
//             to the range, so it could sit under the fraction and still
//             destroy forty real events per page per day, logged as
//             legitimate removals. No single page should ever be able to
//             delete more than a handful, whatever its size.
//
// The cost of the cap is that a genuine bulk removal - FF withdrawing a
// whole day's releases - is refused rather than actioned. That is the
// right trade: it surfaces in the diagnostic's STALENESS section as a
// number that stops going down, which is a person deciding, rather than a
// script deleting forty rows on its own judgement.
export const MAX_REMOVAL_FRACTION = 0.10
export const MIN_REMOVAL_ALLOWANCE = 5
export const MAX_REMOVAL_ABSOLUTE = 15

export function removalAllowance(inRangeCount) {
  const proportional = Math.max(MIN_REMOVAL_ALLOWANCE, Math.floor(inRangeCount * MAX_REMOVAL_FRACTION))
  return Math.min(proportional, MAX_REMOVAL_ABSOLUTE)
}

// A row the JSON fallback feed wrote, rather than the page.
//
// The feed carries no event id, so its rows keep the old day-based key and
// the page can never update them - when the page recovers it writes
// `ff|<id>` instead, and the feed's copy is orphaned. Left alone they stay
// on the card forever, and a day-long outage makes about a hundred of
// them, which is enough to exceed any allowance and wedge the removal pass
// permanently.
//
// They are exempt from the allowance for a reason, not for convenience: a
// feed row being absent from the page is not evidence the page is wrong.
// It was never from the page. It is a provisional stopgap by construction,
// and the page recovering is exactly the moment it stops being needed.
export function isFeedWritten(row) {
  return !row?.ff_event_id
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

  // Split before judging. Feed orphans are not evidence about the page, so
  // they neither consume the allowance nor can they exhaust it.
  const orphans = vanished.filter(isFeedWritten)
  const gated = vanished.filter((r) => !isFeedWritten(r))
  const allowance = removalAllowance(rows.length)
  const allowed = gated.length > 0 && gated.length <= allowance

  return {
    vanished,
    orphans,
    gated,
    allowance,
    inRangeCount: rows.length,
    allowed,
    // What the caller should actually delete: the orphans always, and the
    // rest only when the page is believable.
    removable: allowed ? [...orphans, ...gated] : orphans,
  }
}

// ---------------------------------------------------------------------------
// Identity duplicates: one release stored under two FF event ids.
// ---------------------------------------------------------------------------
//
// The partial unique index on ff_event_id stops the SAME id being stored
// twice. It cannot stop this: FF re-lists a release under a NEW id, the
// upsert keys on event_key (`ff|<id>`), and the table ends up holding the
// same release twice under two keys. That is what
// `2026-10-06T12:15:00+00:00|USD|ADP Weekly Employment Change` did, sitting
// in production under ff|151048 and ff|153364 until somebody looked.
//
// Note this is NOT the thing the `event_key` header in NOTES.md warns
// against. That warning is about the DAY not being an identity - a release
// near local midnight genuinely belongs to two different days depending on
// the timezone FF served the caller, so `day|currency|title` had two
// correct answers. This keys on the absolute `event_time` instead, which
// is the same instant no matter who asked, so it does not reintroduce that
// bug. Two rows only collide here if they are the same release at the same
// moment in time.
//
// Keep the most recently fetched of a colliding set: FF is still serving
// that id, and the older one is the listing it replaced.

// Beyond this many collisions in one run, refuse the whole set rather than
// act on it. Duplicates arrive one release at a time; dozens at once means
// the parser has started reading something wrong - most likely mangling
// titles or times so that unrelated events collide - and mass-deleting on
// that reading is exactly the failure this bound exists to prevent. Same
// reasoning as MAX_REMOVAL_FRACTION above, an absolute count rather than a
// proportion because a handful is already abnormal.
export const MAX_IDENTITY_DUPLICATES = 25

function identityOf(row) {
  return `${row?.event_time}|${row?.currency}|${row?.title}`
}

// Rows scanned from a range -> which ones to drop, and what collided.
// Pure, so the decision is testable without a database.
export function planIdentityDedupe(inRange) {
  const rows = (Array.isArray(inRange) ? inRange : []).filter(
    (r) => r && r.event_time && r.currency && r.title && r.event_key,
  )

  const byIdentity = new Map()
  for (const row of rows) {
    const id = identityOf(row)
    if (!byIdentity.has(id)) byIdentity.set(id, [])
    byIdentity.get(id).push(row)
  }

  const pairs = []
  const remove = []
  for (const [identity, group] of byIdentity) {
    // A single row is the normal case. More than one means two event_keys
    // for one release.
    if (group.length < 2) continue
    // Most recently fetched first; event_key breaks a tie so the choice is
    // deterministic rather than dependent on scan order.
    const ordered = group.slice().sort((a, b) => {
      const at = a.fetched_at || ''
      const bt = b.fetched_at || ''
      if (at !== bt) return at < bt ? 1 : -1
      return a.event_key < b.event_key ? 1 : -1
    })
    const [keep, ...stale] = ordered
    pairs.push({ identity, keep: keep.event_key, remove: stale.map((r) => r.event_key) })
    remove.push(...stale)
  }

  const allowed = remove.length <= MAX_IDENTITY_DUPLICATES
  return {
    pairs,
    duplicateCount: remove.length,
    allowed,
    // Same shape as planRemoval: an over-threshold result returns nothing
    // removable rather than a trimmed list, so a bad parse cannot destroy
    // data AND look unremarkable while doing it.
    removable: allowed ? remove : [],
  }
}
