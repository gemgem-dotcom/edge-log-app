// Futures trade around the clock on one shared schedule, not per-instrument,
// so this has no symbol parameter: open Sunday 6pm ET through Friday 5pm ET,
// with a daily maintenance break every weekday from 5pm-6pm ET.
const ET_TIME_ZONE = 'America/New_York'
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
const FIVE_PM = 17 * 60
const SIX_PM = 18 * 60

function easternParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ET_TIME_ZONE,
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(date)
  const map = {}
  for (const p of parts) map[p.type] = p.value
  // Midnight renders as hour "24" in some environments under hour12:false.
  const hour = Number(map.hour) % 24
  return { weekday: WEEKDAY_INDEX[map.weekday], minutesOfDay: hour * 60 + Number(map.minute) }
}

export function isMarketOpen(date = new Date()) {
  const { weekday, minutesOfDay } = easternParts(date)
  if (weekday === 6) return false // Saturday: closed all day
  if (weekday === 0) return minutesOfDay >= SIX_PM // Sunday: opens 6pm
  if (weekday === 5) return minutesOfDay < FIVE_PM // Friday: closes 5pm
  // Mon-Thu: open except the 5pm-6pm daily break
  return minutesOfDay < FIVE_PM || minutesOfDay >= SIX_PM
}
