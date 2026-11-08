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

// The same display, in the time of the DEVICE READING IT.
//
// WHY THIS EXISTS BESIDE formatInTz. A trading journal formats trade
// times in the account's chosen UTC offset, and that is right: a trader
// in Cape Town logging NQ against the US session wants US session
// times, and changing the setting deliberately shifts every trade
// already logged.
//
// A SECURITY LOG IS NOT A TRADE. "Was that me?" is answered in the time
// the person actually remembers - the clock that was in front of them.
// Rendering a sign-in that happened at 07:51 local as "1:51 AM" because
// the account is set to UTC-4 does not just read oddly, it defeats the
// one question the sign-in list exists to answer. The owner cannot
// recognise their own sign-in.
//
// Intl is used rather than arithmetic so that daylight saving is the
// browser's problem, not ours - the whole point is to agree with the
// clock the reader is looking at.
export function formatLocal(isoString) {
  const instant = new Date(isoString)
  if (!Number.isFinite(instant.getTime())) return ''
  try {
    // 'en-US', matching every other formatted date in this app, NOT the
    // device locale. It was the CLOCK that was wrong, not the format: an
    // en-GB phone would otherwise render "8 Nov 2026, 18:57" here and
    // "Nov 8, 2026" everywhere else, which is a new inconsistency in
    // exchange for nothing. The timezone still comes from the device,
    // which is the whole fix.
    return new Intl.DateTimeFormat('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    }).format(instant)
  } catch {
    // Intl is present everywhere this app runs, but a formatter that
    // throws must not take the security log down with it.
    return formatInTz(isoString, '0')
  }
}

// "2 minutes ago", for the row the reader most needs to recognise.
// Absolute time alone makes you do arithmetic to answer "is that the
// sign-in I just did?".
export function relativeTime(isoString, { now = Date.now() } = {}) {
  const t = new Date(isoString).getTime()
  if (!Number.isFinite(t)) return ''
  const secs = Math.round((now - t) / 1000)
  if (secs < 0) return 'just now'
  if (secs < 60) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`
  return ''
}
