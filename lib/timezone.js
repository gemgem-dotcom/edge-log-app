// Trade times are stored as plain clock times, so the account page lets the
// trader say which UTC offset those were logged in. Shared by the timezone
// picker and the sign-in history that renders timestamps in it.
export const UTC_OFFSETS = [-12, -11, -10, -9.5, -9, -8, -7, -6, -5, -4.5, -4, -3.5, -3, -2, -1, 0, 1, 2, 3, 3.5, 4, 4.5, 5, 5.5, 5.75, 6, 6.5, 7, 8, 8.75, 9, 9.5, 10, 10.5, 11, 12, 12.75, 13, 14].map((h) => {
  const sign = h >= 0 ? '+' : '-'
  const abs = Math.abs(h)
  const hh = Math.floor(abs)
  const mm = Math.round((abs - hh) * 60)
  const label = `UTC${sign}${hh}${mm ? ':' + String(mm).padStart(2, '0') : ''}`
  return { value: String(h), label }
})

// e.g. "UTC-5" for '-5' - used in the confirmation prompt before
// shift_trade_times runs, so the trader sees the offset they're about to
// commit their whole trade history to, not just its raw numeric value.
export function offsetLabel(tz) {
  return UTC_OFFSETS.find((o) => o.value === String(tz))?.label ?? `UTC${tz >= 0 ? '+' : ''}${tz}`
}

// Nearest UTC_OFFSETS entry to the browser's own current offset - used to
// seed the Account Settings timezone dropdown before a trader has ever
// explicitly picked one, and reused by lib/tradeSessions.js as the same
// implicit assumption for a trade logged before any explicit choice exists
// (in that case at the moment of logging, not page-load, but the same
// "nearest to whatever the browser says right now" logic either way).
export function browserOffsetGuess() {
  const browserOffset = -(new Date().getTimezoneOffset()) / 60
  return UTC_OFFSETS.reduce((best, o) =>
    Math.abs(parseFloat(o.value) - browserOffset) < Math.abs(parseFloat(best.value) - browserOffset) ? o : best
  ).value
}

export function formatInTz(isoString, tz) {
  const offsetHours = parseFloat(tz)
  const instant = new Date(isoString)
  const shifted = new Date(instant.getTime() + (isNaN(offsetHours) ? 0 : offsetHours) * 3600000)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const datePart = `${months[shifted.getUTCMonth()]} ${shifted.getUTCDate()}, ${shifted.getUTCFullYear()}`
  let hh = shifted.getUTCHours()
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0')
  const ampm = hh >= 12 ? 'PM' : 'AM'
  hh = hh % 12
  if (hh === 0) hh = 12
  return `${datePart}, ${hh}:${mm} ${ampm}`
}
