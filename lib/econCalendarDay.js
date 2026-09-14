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
// The fix needs no new column. event_key's first field is already FF's own
// day, written by whichever source stored the row, and both sources now
// derive it without naming a zone.

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

function pad(n) {
  return String(n).padStart(2, '0')
}

// The viewer's own calendar day for an instant.
export function localDayOf(eventTime) {
  const d = eventTime instanceof Date ? eventTime : new Date(eventTime)
  if (Number.isNaN(d.getTime())) return null
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// FF's own day, off the front of the key. Returns null for a key that
// doesn't start with one, so a caller falls back rather than rendering a
// slice of something unexpected.
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
  if (isAllDay(event)) return ffDayFromKey(event.event_key) || localDayOf(event.event_time)
  return localDayOf(event.event_time)
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
