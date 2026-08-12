// Hand-maintained: unlike BLS's official ICS calendar (see
// app/api/economic-calendar/route.js), the Fed doesn't publish a
// machine-readable feed for FOMC meeting dates - just a static HTML page.
// They publish the whole year's schedule at once, a year or more ahead, and
// it essentially never changes once announced, so this needs updating only
// once a year rather than as individual dates are announced.
//
// Each entry is the announcement day (the second day of each two-day
// meeting) - the statement releases at 2:00pm ET, which is what actually
// moves markets, not the first day.
export const FOMC_STATEMENT_DATES_2026 = [
  '2026-01-28',
  '2026-03-18',
  '2026-04-29',
  '2026-06-17',
  '2026-07-29',
  '2026-09-16',
  '2026-10-28',
  '2026-12-09',
]

export const FOMC_STATEMENT_TIME = '14:00'
