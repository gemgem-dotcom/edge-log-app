// Rotating greeting phrases for the cross-instrument Overview page. The base
// time-of-day pool is picked against the trader's own local clock - this
// runs client-side, so `new Date()` already reads the browser's own
// timezone. A second, separate pool is mixed in only during specific real
// Eastern-time windows (weekday close, the weekend, Sunday's pre-open)
// since those describe the market's calendar, which doesn't move with the
// trader's own local time. {name} is substituted with their profile name,
// or "there" if none is set yet.
import { easternParts } from '@/lib/marketHours'

const DAY_PERIODS = [
  { startMinutes: 5 * 60, endMinutes: 10.5 * 60, phrases: ['Rise and grind, {name}', 'Good morning', 'Good morning, {name}', 'Morning, {name}'] },
  { startMinutes: 10.5 * 60, endMinutes: 12 * 60, phrases: ['Welcome back, {name}', 'Morning, {name}', 'Good to see you, {name}'] },
  { startMinutes: 12 * 60, endMinutes: 17 * 60, phrases: ['Good afternoon, {name}', 'Welcome back, {name}', "Afternoon. Let's get back to it, {name}", 'Afternoon, {name}'] },
  { startMinutes: 17 * 60, endMinutes: 23.5 * 60, phrases: ['Good evening, {name}', 'Evening, {name}', 'Welcome back, {name}'] },
]
// 11:30pm-3am wraps midnight, so it can't fit the same startMinutes/endMinutes
// shape as the rest of DAY_PERIODS - handled as a fallback below instead.
const LATE_NIGHT_PHRASES = ['Burning the midnight oil, {name}', 'Late one, {name}?', 'Welcome back, {name}']
const PRE_DAWN_PHRASES = ['Still here?', 'Welcome back, {name}', 'On the charts already?', 'Welcome to the night shift, {name}', 'The charts never sleep.', 'Well, this is commitment']
const PRE_DAWN_START_MINUTES = 3 * 60
const PRE_DAWN_END_MINUTES = 5 * 60

const ALWAYS_MIXED_IN = ['Back to the charts']

const FOUR_PM = 16 * 60
const FIVE_PM = 17 * 60
const SIX_PM = 18 * 60

function dayPeriodPhrases(minutesOfDay) {
  const period = DAY_PERIODS.find((p) => minutesOfDay >= p.startMinutes && minutesOfDay < p.endMinutes)
  if (period) return period.phrases
  if (minutesOfDay >= PRE_DAWN_START_MINUTES && minutesOfDay < PRE_DAWN_END_MINUTES) return PRE_DAWN_PHRASES
  return LATE_NIGHT_PHRASES
}

// weekday: 0=Sun ... 6=Sat, matching lib/marketHours.js's easternParts().
function estSpecialPhrases(weekday, minutesOfDay) {
  if (weekday >= 1 && weekday <= 5 && minutesOfDay >= FIVE_PM && minutesOfDay < SIX_PM) {
    return ['Time to review', "Let's review, {name}", 'See how you did today']
  }
  const isWeekend = (weekday === 5 && minutesOfDay >= SIX_PM) || weekday === 6 || (weekday === 0 && minutesOfDay < FOUR_PM)
  if (isWeekend) {
    return ['Time to review', "Let's review, {name}", 'Working through the weekend?', 'Markets closed. Plenty to review.', 'Take a look back']
  }
  if (weekday === 0 && minutesOfDay >= FOUR_PM && minutesOfDay < SIX_PM) {
    return ['Markets open soon, {name}', 'Ready for the week?', 'Almost time...', 'Ready for another week?']
  }
  return []
}

export function pickGreeting(name) {
  const now = new Date()
  const minutesOfDay = now.getHours() * 60 + now.getMinutes()
  const { weekday, minutesOfDay: etMinutesOfDay } = easternParts(now)

  const pool = [...dayPeriodPhrases(minutesOfDay), ...estSpecialPhrases(weekday, etMinutesOfDay), ...ALWAYS_MIXED_IN]
  const template = pool[Math.floor(Math.random() * pool.length)]
  return template.replace('{name}', name || 'there')
}
