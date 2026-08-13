// Rotating greeting phrases for the cross-instrument Overview page, picked
// per page load based on the trader's local time - their stored timezone
// preference (lib/timezone.js), not the server's clock or raw UTC. {name}
// is substituted with their profile name, or "there" if none is set yet.
const BUCKETS = [
  { startHour: 5, endHour: 11, phrases: ['Good morning, {name}', 'Morning, {name}', 'Rise and grind, {name}'] },
  { startHour: 11, endHour: 17, phrases: ['Good afternoon, {name}', 'Welcome back, {name}'] },
  { startHour: 17, endHour: 21, phrases: ['Good evening, {name}', 'Welcome back, {name}'] },
]
const LATE_NIGHT_PHRASES = ['Welcome back, {name}', 'Burning the midnight oil, {name}']

// tz is the stored UTC-offset preference (a plain number like "-5" or
// "5.5", same shape as lib/timezone.js's UTC_OFFSETS values) - not an IANA
// zone name. Mirrors the shift-and-read-UTC-hours trick formatInTz uses.
export function localHour(tz) {
  const offset = parseFloat(tz)
  const shifted = new Date(Date.now() + (isNaN(offset) ? 0 : offset) * 3600000)
  return shifted.getUTCHours()
}

export function pickGreeting(name, tz) {
  const hour = localHour(tz)
  const bucket = BUCKETS.find((b) => hour >= b.startHour && hour < b.endHour)
  const phrases = bucket ? bucket.phrases : LATE_NIGHT_PHRASES
  const template = phrases[Math.floor(Math.random() * phrases.length)]
  return template.replace('{name}', name || 'there')
}
