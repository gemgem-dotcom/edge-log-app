// Front-month rollover/expiration dates per underlying series, keyed by
// data_symbol (the same mini/micro grouping instrumentCatalog.js uses -
// MNQ rolls the same day NQ does). This is real, publicly known contract
// specification data, not a mock - it's a static lookup only because
// there's no need to recompute it at runtime, computed from the standard
// CME/COMEX/NYMEX expiration rules:
//   ES/NQ/YM - quarterly (Mar/Jun/Sep/Dec), 3rd Friday of the month
//   GC       - Feb/Apr/Jun/Aug/Oct/Dec, 3rd-to-last business day
//   CL       - monthly, 3 business days before the 25th of the prior month
//   BTC      - monthly, last Friday of the month
// contractRollover.json currently lists dates through end of 2028 - same
// spirit as lib/cmeHolidays.json, extend (or regenerate) it once the
// last listed date per symbol gets close.
//
// These rules are calendar-based ("3rd Friday", "last Friday") and don't
// themselves know about holidays, so a listed date can land on one - e.g.
// BTC's Dec 2026 entry is 2026-12-25, which is Christmas. adjustForHolidays
// below is what corrects that, walking back to the prior trading day,
// mirroring CME's own rule ("if the scheduled expiration falls on a
// holiday, trading terminates the prior business day").
import ROLLOVER_DATES from './contractRollover.json'
import CME_HOLIDAYS from './cmeHolidays.json'

function dateStr(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function isWeekend(date) {
  const day = date.getDay()
  return day === 0 || day === 6
}

// Walks a 'YYYY-MM-DD' date backward until it lands on an actual CME
// trading day - skips weekends and any date cmeHolidays.json lists as a
// full closure. Early-close days are left alone: the exchange is still
// open that day, so a contract can still roll on one.
function adjustForHolidays(ds) {
  const d = new Date(ds + 'T00:00:00')
  while (isWeekend(d) || CME_HOLIDAYS[dateStr(d)]?.type === 'closed') {
    d.setDate(d.getDate() - 1)
  }
  return dateStr(d)
}

// Holiday-adjusted 'YYYY-MM-DD' of the lookup's next date on/after
// fromDate, or null if the symbol isn't in the lookup or every listed
// date has already passed (the table needs extending) - shared by
// daysToRollover and nextRolloverDate below so both agree on which date
// is "next". Adjusts each candidate before comparing against fromDate,
// not after - a raw date landing exactly on fromDate but adjusting back
// past it (rare, but possible right at a holiday) must not still count
// as "next"; the following listed date should win instead.
function findNextDate(dataSymbol, fromDate) {
  const dates = ROLLOVER_DATES[dataSymbol]
  if (!dates) return null
  const todayStr = dateStr(fromDate)
  for (const raw of dates) {
    const adjusted = adjustForHolidays(raw)
    if (adjusted >= todayStr) return adjusted
  }
  return null
}

// Null in the same "no data" cases as findNextDate - callers should show
// that as "no data" rather than a stale or negative day count.
export function daysToRollover(dataSymbol, fromDate = new Date()) {
  const next = findNextDate(dataSymbol, fromDate)
  if (!next) return null
  const today = new Date(dateStr(fromDate) + 'T00:00:00')
  const target = new Date(next + 'T00:00:00')
  return Math.round((target - today) / 86400000)
}

// The next rollover date itself, e.g. for displaying "Dec 18" next to the
// day count - a plain 'YYYY-MM-DD' string, same null cases as daysToRollover.
export function nextRolloverDate(dataSymbol, fromDate = new Date()) {
  return findNextDate(dataSymbol, fromDate)
}

// Whole days from fromDate to the nearer of the next upcoming rollover or
// the most recent past one - unlike daysToRollover (always forward-
// looking), this is symmetric, for callers that care about proximity to a
// roll in either direction rather than just "how long until." Built for
// lib/databento.js's resolveFrontMonthByVolume: real trading volume can
// shift to the next contract days before a continuous-symbol resolution
// catches up (confirmed live, PR #122), so a trade logged just *after* a
// roll needs the same extra care as one logged just before it. null in
// the same "no data for this symbol" case as daysToRollover/
// nextRolloverDate.
export function daysToNearestRollover(dataSymbol, fromDate = new Date()) {
  const dates = ROLLOVER_DATES[dataSymbol]
  if (!dates) return null
  const fromStr = dateStr(fromDate)
  const from = new Date(fromStr + 'T00:00:00')

  const next = findNextDate(dataSymbol, from)
  const daysToNext = next ? Math.round((new Date(next + 'T00:00:00') - from) / 86400000) : null

  // The lookup is listed in ascending order and adjustForHolidays only
  // ever moves a date backward by a few days at most, so scanning in
  // order and keeping the last adjusted date still before fromStr finds
  // the most recent past rollover without needing a reverse lookup table.
  let previous = null
  for (const raw of dates) {
    const adjusted = adjustForHolidays(raw)
    if (adjusted < fromStr) previous = adjusted
    else break
  }
  const daysSincePrevious = previous ? Math.round((from - new Date(previous + 'T00:00:00')) / 86400000) : null

  const candidates = [daysToNext, daysSincePrevious].filter((d) => d !== null)
  return candidates.length ? Math.min(...candidates) : null
}
