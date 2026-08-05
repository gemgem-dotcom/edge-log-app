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
