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
import ROLLOVER_DATES from './contractRollover.json'

function dateStr(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

// Null if the symbol isn't in the lookup, or every listed date has
// already passed (the table needs extending) - callers should show that
// as "no data" rather than a stale or negative day count.
export function daysToRollover(dataSymbol, fromDate = new Date()) {
  const dates = ROLLOVER_DATES[dataSymbol]
  if (!dates) return null
  const todayStr = dateStr(fromDate)
  const next = dates.find((d) => d >= todayStr)
  if (!next) return null
  const today = new Date(todayStr + 'T00:00:00')
  const target = new Date(next + 'T00:00:00')
  return Math.round((target - today) / 86400000)
}
