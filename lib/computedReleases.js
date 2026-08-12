// ISM (Manufacturing/Services PMI) and Conference Board (Consumer
// Confidence) don't publish a machine-readable schedule feed, and neither
// shows up as a trackable "release" in FRED's catalog - but both follow a
// fixed, well-known publication rule rather than an irregularly-set
// calendar (unlike FOMC), so the dates can be computed instead of fetched
// or hand-maintained:
//   - ISM Manufacturing PMI: 1st business day of the month, 10:00am ET
//   - ISM Services PMI: 3rd business day of the month, 10:00am ET
//   - Consumer Confidence (Conference Board): last Tuesday of the month, 10:00am ET
//
// This is an approximation, not a scrape of either organization's own
// calendar: it uses a standard US federal holiday set to skip non-business
// days, but ISM's own internal office-closure calendar can occasionally
// differ from that (e.g. shifting a report an extra day around New Year's),
// so a date here could be off by one business day a few times a year around
// holidays. Flagged rather than silently assumed exact.

const RELEASE_TIME = '10:00'

function pad(n) {
  return String(n).padStart(2, '0')
}

function toDateStr(y, m, d) {
  return `${y}-${pad(m + 1)}-${pad(d)}`
}

// Nth weekday-of-month helpers (0=Sunday..6=Saturday), used for the fixed
// federal holidays defined that way (e.g. "3rd Monday of January").
function nthWeekdayOfMonth(year, month, weekday, n) {
  const first = new Date(year, month, 1)
  const firstWeekday = first.getDay()
  const offset = (weekday - firstWeekday + 7) % 7
  const day = 1 + offset + (n - 1) * 7
  return new Date(year, month, day)
}

function lastWeekdayOfMonth(year, month, weekday) {
  const last = new Date(year, month + 1, 0)
  const lastWeekday = last.getDay()
  const offset = (lastWeekday - weekday + 7) % 7
  return new Date(year, month + 1, 0 - offset)
}

// Observed date for a fixed-date holiday: shifted to Friday if it falls on
// Saturday, or Monday if it falls on Sunday - the standard federal
// observance rule.
function observedFixedHoliday(year, month, day) {
  const d = new Date(year, month, day)
  if (d.getDay() === 6) d.setDate(d.getDate() - 1)
  if (d.getDay() === 0) d.setDate(d.getDate() + 1)
  return d
}

function usFederalHolidays(year) {
  return [
    observedFixedHoliday(year, 0, 1),          // New Year's Day
    nthWeekdayOfMonth(year, 0, 1, 3),          // MLK Day - 3rd Monday of Jan
    nthWeekdayOfMonth(year, 1, 1, 3),          // Presidents Day - 3rd Monday of Feb
    lastWeekdayOfMonth(year, 4, 1),            // Memorial Day - last Monday of May
    observedFixedHoliday(year, 5, 19),         // Juneteenth
    observedFixedHoliday(year, 6, 4),          // Independence Day
    nthWeekdayOfMonth(year, 8, 1, 1),          // Labor Day - 1st Monday of Sep
    nthWeekdayOfMonth(year, 10, 4, 4),         // Thanksgiving - 4th Thursday of Nov
    observedFixedHoliday(year, 11, 25),        // Christmas
  ].map((d) => toDateStr(d.getFullYear(), d.getMonth(), d.getDate()))
}

function isBusinessDay(date, holidaySet) {
  const day = date.getDay()
  if (day === 0 || day === 6) return false
  return !holidaySet.has(toDateStr(date.getFullYear(), date.getMonth(), date.getDate()))
}

function nthBusinessDayOfMonth(year, month, n, holidaySet) {
  let count = 0
  let day = 1
  while (true) {
    const d = new Date(year, month, day)
    if (d.getMonth() !== month) return null
    if (isBusinessDay(d, holidaySet)) {
      count++
      if (count === n) return d
    }
    day++
  }
}

// All computed events falling within [from, to] (inclusive, 'YYYY-MM-DD').
export function computedReleasesInRange(from, to) {
  const events = []
  const startYear = Number(from.slice(0, 4))
  const endYear = Number(to.slice(0, 4))

  for (let year = startYear; year <= endYear; year++) {
    const holidaySet = new Set([...usFederalHolidays(year - 1), ...usFederalHolidays(year), ...usFederalHolidays(year + 1)])
    for (let month = 0; month < 12; month++) {
      const manufacturing = nthBusinessDayOfMonth(year, month, 1, holidaySet)
      if (manufacturing) {
        const date = toDateStr(year, month, manufacturing.getDate())
        if (date >= from && date <= to) {
          events.push({ date, time: RELEASE_TIME, country: 'US', event: 'ISM Manufacturing PMI', impact: 'high', actual: null, estimate: null, prev: null, unit: '' })
        }
      }
      const services = nthBusinessDayOfMonth(year, month, 3, holidaySet)
      if (services) {
        const date = toDateStr(year, month, services.getDate())
        if (date >= from && date <= to) {
          events.push({ date, time: RELEASE_TIME, country: 'US', event: 'ISM Services PMI', impact: 'high', actual: null, estimate: null, prev: null, unit: '' })
        }
      }
      const confidence = lastWeekdayOfMonth(year, month, 2) // Tuesday
      const confDate = toDateStr(confidence.getFullYear(), confidence.getMonth(), confidence.getDate())
      if (confDate >= from && confDate <= to) {
        events.push({ date: confDate, time: RELEASE_TIME, country: 'US', event: 'CB Consumer Confidence', impact: 'medium', actual: null, estimate: null, prev: null, unit: '' })
      }
    }
  }
  return events
}
