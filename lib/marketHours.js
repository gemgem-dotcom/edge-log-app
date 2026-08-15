// Futures trade around the clock on one shared schedule, not per-instrument,
// so this has no symbol parameter: open Sunday 6pm ET through Friday 5pm ET,
// with a daily maintenance break every weekday from 5pm-6pm ET. Within that,
// the trading day is further divided into named sessions (below) - always in
// ET regardless of the trader's own configured timezone, since the sessions
// are defined by ET clock time, not by the account's trade-logging offset.
const ET_TIME_ZONE = 'America/New_York'
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
const THREE_AM = 3 * 60
const EIGHT_THIRTY_AM = 8 * 60 + 30
const NINE_THIRTY_AM = 9 * 60 + 30
const ELEVEN_THIRTY_AM = 11 * 60 + 30
const ONE_THIRTY_PM = 13 * 60 + 30
const FIVE_PM = 17 * 60
const SIX_PM = 18 * 60

// Exported so other ET-anchored features (e.g. the overview greeting's
// weekend/market-closed phrasing) can share this instead of re-deriving it.
export function easternParts(date) {
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

function computeOpen(weekday, minutesOfDay) {
  if (weekday === 6) return false // Saturday: closed all day
  if (weekday === 0) return minutesOfDay >= SIX_PM // Sunday: opens 6pm
  if (weekday === 5) return minutesOfDay < FIVE_PM // Friday: closes 5pm
  // Mon-Thu: open except the 5pm-6pm daily break
  return minutesOfDay < FIVE_PM || minutesOfDay >= SIX_PM
}

export function isMarketOpen(date = new Date()) {
  const { weekday, minutesOfDay } = easternParts(date)
  return computeOpen(weekday, minutesOfDay)
}

// Only called once computeOpen has already confirmed the market is open,
// so the 5pm-6pm daily gap this doesn't have a case for can never actually
// be reached - whichever weekday it is, minutesOfDay lands somewhere
// before New York PM ends (5pm) or from 6pm onward into Asian session.
function sessionFor(minutesOfDay) {
  if (minutesOfDay >= SIX_PM || minutesOfDay < THREE_AM) return 'Asian session'
  if (minutesOfDay < EIGHT_THIRTY_AM) return 'London session'
  if (minutesOfDay < NINE_THIRTY_AM) return 'US pre-market'
  if (minutesOfDay < ELEVEN_THIRTY_AM) return 'New York AM'
  if (minutesOfDay < ONE_THIRTY_PM) return 'Midday lull'
  return 'New York PM'
}

// { open, label } together, rather than two separate calls each re-deriving
// eastern time independently - keeps the pill's color and its text from
// ever being able to disagree about whether the market is open.
export function marketStatus(date = new Date()) {
  const { weekday, minutesOfDay } = easternParts(date)
  const open = computeOpen(weekday, minutesOfDay)
  return { open, label: open ? sessionFor(minutesOfDay) : 'Market closed' }
}
