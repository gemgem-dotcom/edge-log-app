// Futures trade around the clock on one shared schedule, not per-instrument,
// so this has no symbol parameter: open Sunday 6pm ET through Friday 5pm ET,
// with a daily maintenance break every weekday from 5pm-6pm ET, and CME
// holiday closures/early closes (cmeHolidays.json) layered on top of that.
// Within that, the trading day is further divided into named sessions
// (below) - always in ET regardless of the trader's own configured
// timezone, since the sessions are defined by ET clock time, not by the
// account's trade-logging offset.
import CME_HOLIDAYS from './cmeHolidays.json'

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
// weekend/market-closed phrasing, HolidayNotice) can share this instead of
// re-deriving it. dateStr is the ET calendar date - needed to key into
// cmeHolidays.json, since a holiday is a specific date, not a weekday.
export function easternParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ET_TIME_ZONE,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(date)
  const map = {}
  for (const p of parts) map[p.type] = p.value
  // Midnight renders as hour "24" in some environments under hour12:false.
  const hour = Number(map.hour) % 24
  return {
    weekday: WEEKDAY_INDEX[map.weekday],
    minutesOfDay: hour * 60 + Number(map.minute),
    dateStr: `${map.year}-${map.month}-${map.day}`,
  }
}

function parseCloseMinutes(closeTime) {
  const [h, m] = closeTime.split(':').map(Number)
  return h * 60 + m
}

// `holiday` is today's cmeHolidays.json entry (or undefined) - a `closed`
// entry overrides everything below to shut, an `early_close` entry
// replaces the normal 5pm cutoff with its own closeTime.
function computeOpen(weekday, minutesOfDay, holiday) {
  if (holiday?.type === 'closed') return false
  if (weekday === 6) return false // Saturday: closed all day
  if (weekday === 0) return minutesOfDay >= SIX_PM // Sunday: opens 6pm
  const closeMinutes = holiday?.type === 'early_close' ? parseCloseMinutes(holiday.closeTime) : FIVE_PM
  if (weekday === 5) return minutesOfDay < closeMinutes // Friday: closes 5pm (or early-close time)
  // Mon-Thu: open except the daily break (5pm, or early-close time, to 6pm)
  return minutesOfDay < closeMinutes || minutesOfDay >= SIX_PM
}

export function isMarketOpen(date = new Date()) {
  const { weekday, minutesOfDay, dateStr } = easternParts(date)
  return computeOpen(weekday, minutesOfDay, CME_HOLIDAYS[dateStr])
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
  const { weekday, minutesOfDay, dateStr } = easternParts(date)
  const holiday = CME_HOLIDAYS[dateStr]
  const open = computeOpen(weekday, minutesOfDay, holiday)
  if (open) return { open, label: sessionFor(minutesOfDay) }

  // Only call out the holiday by name if it's the actual reason the
  // market is shut right now, not just a date that happens to have a
  // holiday entry - compare against what the plain weekday/time rules
  // (ignoring any holiday) would have said. If that would have been open,
  // the holiday is what closed it: either a full `closed` day, or an
  // `early_close` day once past its shortened close time but still
  // before the normal 5pm cutoff.
  const closedByHoliday = holiday && computeOpen(weekday, minutesOfDay, null)
  return { open, label: closedByHoliday ? `Market closed • ${holiday.name}` : 'Market closed' }
}
