// Rotating greeting phrases for the cross-instrument Overview page, picked
// per page load based on the trader's actual local time - this runs client-
// side, so `new Date()` already reads the browser's own clock/timezone,
// not the server's. {name} is substituted with their profile name, or
// "there" if none is set yet.
const BUCKETS = [
  { startHour: 5, endHour: 11, phrases: ['Good morning, {name}', 'Morning, {name}', 'Rise and grind, {name}'] },
  { startHour: 11, endHour: 17, phrases: ['Good afternoon, {name}', 'Welcome back, {name}'] },
  { startHour: 17, endHour: 21, phrases: ['Good evening, {name}', 'Welcome back, {name}'] },
]
const LATE_NIGHT_PHRASES = ['Welcome back, {name}', 'Burning the midnight oil, {name}']

export function pickGreeting(name) {
  const hour = new Date().getHours()
  const bucket = BUCKETS.find((b) => hour >= b.startHour && hour < b.endHour)
  const phrases = bucket ? bucket.phrases : LATE_NIGHT_PHRASES
  const template = phrases[Math.floor(Math.random() * phrases.length)]
  return template.replace('{name}', name || 'there')
}
