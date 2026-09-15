// Which calendar day an economic event belongs to, which is not one
// question but two.
//
// A release with a clock time happens at an INSTANT. A trader in Los
// Angeles should see an 08:30 New York print on their own Monday at 05:30,
// so those rows are bucketed by the viewer's local day - what the card has
// always done, correctly.
//
// An all-day or tentative row has no instant. FF files it under a DATE and
// prints no time at all. It is stored anchored to midnight in FF's own
// display timezone, because that is the only honest thing its timestamp
// can say - but midnight is the one instant where "the viewer's local day"
// and "FF's day" come apart, and they come apart by a whole day.
//
// FF picks its display zone from the client's IP, and the fetchers run in
// US Mountain time, so a stored all-day row sits at 06:00Z. Read in the
// viewer's zone that is:
//
//   America/Denver        Mon 14, 00:00   correct
//   America/New_York      Mon 14, 02:00   correct
//   America/Los_Angeles   Sun 13, 23:00   a day early
//   Pacific/Honolulu      Sun 13, 20:00   a day early
//
// So every Pacific-coast trader saw bank holidays, German Prelim CPI and
// OPEC meetings on the wrong day - and worse, a single-day range simply
// dropped them, because the row's instant fell outside the viewer's own
// local-day window entirely.
//
// The fix needs no new column, but it does not come from the key either.
// event_key USED to lead with FF's day; it is `ff|<id>` now and carries no
// day at all, and reading the day off it is exactly how this broke a
// second time. It comes from the row's own instant instead - see
// ffDayFromInstant.

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

function pad(n) {
  return String(n).padStart(2, '0')
}

// new Date(null) is epoch 0 - a perfectly valid date - so a NaN check
// alone lets null, undefined and '' through as 1970-01-01. A row with no
// timestamp should place nowhere, not on the first day of the epoch.
function toInstant(eventTime) {
  if (eventTime === null || eventTime === undefined || eventTime === '') return null
  const d = eventTime instanceof Date ? eventTime : new Date(eventTime)
  return Number.isNaN(d.getTime()) ? null : d
}

// The viewer's own calendar day for an instant.
export function localDayOf(eventTime) {
  const d = toInstant(eventTime)
  if (!d) return null
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// FF's own day for an all-day row, taken from the row's own timestamp.
//
// This used to read the day off the front of event_key, which worked right
// up until event_key became `ff|<id>` and stopped carrying a day at all -
// at which point displayDayFor silently fell back to the viewer's local
// day and every all-day row went back to showing a day early west of FF.
// Deriving it here instead means no key format can break it again.
//
// The arithmetic is the same trick dayFor uses on a dateline, and it works
// for the same reason: an all-day row is stored AT FF's local midnight, so
// event_time IS that day's dateline. Noon on that day is twelve hours
// later, and a local noon lands on the same calendar date in every zone
// within +/-12 of UTC - so the UTC date of event_time + 12h is FF's day
// without needing to know which zone FF used.
//
// This keeps the |offset| <= 12 bound that dayFor used to share and no
// longer does. dayFor resolved it by reading FF's own printed date off the
// page; there is no page here. A stored row carries its instant and nothing
// else - the day was never written to a column of its own - so at UTC+13 or
// +14 an all-day row would be filed a day early, exactly as the parser used
// to file it.
//
// Left as a bound rather than closed, because closing it means storing the
// day the parser already worked out, and that is a schema change to fix a
// case that cannot currently arise: the rows are written by GitHub runners
// and Vercel functions, all well inside the bound, and the bound is about
// where the WRITER sat, not the reader. A viewer in Auckland reading a row
// written from Wyoming is unaffected. If a writer ever runs east of UTC+12,
// this is the line that breaks, and the fix is a stored day.
const HALF_DAY_MS = 12 * 60 * 60 * 1000

export function ffDayFromInstant(eventTime) {
  const d = toInstant(eventTime)
  if (!d) return null
  return new Date(d.getTime() + HALF_DAY_MS).toISOString().slice(0, 10)
}

// Kept because the JSON fallback feed still writes day-based keys, and a
// row it created carries its day there and nowhere else. Returns null for
// an id key so the caller falls back to the arithmetic above.
export function ffDayFromKey(eventKey) {
  const head = String(eventKey || '').slice(0, 10)
  return DAY_RE.test(head) ? head : null
}

// True when a row carries no clock time of its own.
//
// A null time_precision is treated as exact, matching what the card
// renders. Those rows predate the column or were written by the JSON
// fallback; they are counted by the diagnostic rather than guessed at
// here.
export function isAllDay(event) {
  return Boolean(event?.time_precision) && event.time_precision !== 'exact'
}

// The day to file an event under: FF's when it has no time of its own, the
// viewer's when it does.
export function displayDayFor(event) {
  if (!isAllDay(event)) return localDayOf(event.event_time)
  // The instant first, because it is right for every row regardless of how
  // the key happens to be shaped. The key is consulted only as a fallback
  // for a feed-written row, whose day-based key is the one place a day is
  // recorded that the arithmetic could disagree with.
  return ffDayFromInstant(event.event_time) || ffDayFromKey(event.event_key)
}

// Display order for a list of events.
//
// The card used to render whatever order the query returned, which is by
// instant - and then LABEL each row with displayDayFor. Those two disagree
// for any viewer west of FF, because an all-day row is filed under FF's
// day while a timed row is filed under the viewer's, so the Date column
// ran backwards:
//
//   Pacific/Honolulu, rows in instant order
//     2026-09-18T06:00Z  all day  -> Fri 18
//     2026-09-18T07:00Z  07:00    -> Thu 17   <- goes back a day
//     2026-09-18T11:00Z  11:00    -> Fri 18
//
// Not confined to holidays: it catches any timed release in FF's own
// overnight window, which is where the Asian and European prints live.
//
// Sorting by the same function that labels the row is what keeps the two
// from ever disagreeing again. Within a day, all-day rows lead - that is
// where FF puts them, and a row with no time cannot be ordered against one
// that has a time in any more meaningful way.
export function compareForDisplay(a, b) {
  const dayA = displayDayFor(a) || ''
  const dayB = displayDayFor(b) || ''
  if (dayA !== dayB) return dayA < dayB ? -1 : 1

  const allDayA = isAllDay(a)
  const allDayB = isAllDay(b)
  if (allDayA !== allDayB) return allDayA ? -1 : 1

  const timeA = String(a?.event_time || '')
  const timeB = String(b?.event_time || '')
  if (timeA !== timeB) return timeA < timeB ? -1 : 1
  // A stable last resort, so a block of simultaneous releases keeps one
  // order across re-renders rather than shuffling.
  return String(a?.event_key || '').localeCompare(String(b?.event_key || ''))
}

// Whether an event belongs inside a from/to range of local day strings.
// Compared as dates rather than instants, which is the whole point: an
// all-day row's instant can sit outside the viewer's local-day window
// while its day sits comfortably inside the range.
export function eventInRange(event, fromDay, toDay) {
  const day = displayDayFor(event)
  if (!day) return false
  const lo = fromDay <= toDay ? fromDay : toDay
  const hi = fromDay <= toDay ? toDay : fromDay
  return day >= lo && day <= hi
}
