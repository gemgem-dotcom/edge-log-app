// Which timezone did Forex Factory render this page in?
//
// WHY THIS EXISTS. The parser used to store `dateline + clock time` as the
// instant of a release, on the understanding that data-day-dateline is the
// epoch of local midnight. Measured against live pages on 2026-11-10
// (scripts/probe-forexfactory-datelines.js), it is not reliably that:
//
//   - FF stamps the offset of the page's FIRST day onto every day of the
//     page. Every gap between consecutive datelines is exactly 86400s, on
//     every page, including the ones that contain a clock change. The week
//     of 2026-03-08 carries 05:00Z for all seven days; the true local
//     midnight from the 9th on is 04:00Z. One hour out, all week.
//   - On a page that STARTS on the autumn changeover, every dateline is
//     also a whole day late. `?week=nov1.2026` and `?month=nov.2026` both
//     print "Mon Nov 2" beside a dateline of 2026-11-03T04:00Z.
//
// The second of those put 214 of November 2026's 411 events on the wrong
// day in production. The first had been quietly wrong since the feature
// shipped.
//
// What FF does get right, on every page checked, is what it PRINTS: the
// date label and the clock time are true local wall time, clock changes
// included. So those are the authority now, and the dateline is demoted
// to the one thing it is still good for - evidence of which timezone the
// page was rendered in, which FF picks from the caller's IP and never
// states.
//
// NO ZONE IS NAMED HERE, and that is deliberate (see CLAUDE.md: a fixed
// `America/Chicago` was wrong for most callers, because a runner in
// Wyoming is served Denver and Vercel is served New York). Instead every
// timezone the runtime knows is a candidate, the evidence eliminates the
// ones that could not have produced the page, and a day is only trusted
// when EVERY surviving candidate puts its midnight at the same instant.
// If they disagree, the answer is "unknown" and the caller does not
// store it. An unknown time is a gap; a wrong time is a lie.

const DAY_MS = 86400000

let allZones = null
function zones() {
  if (allZones) return allZones
  let list = []
  try {
    list = Intl.supportedValuesOf('timeZone')
  } catch {
    // A runtime without the list still has the zones; it just cannot
    // enumerate them. These cover every display zone FF has been observed
    // to serve plus the fixed offsets, so the degraded answer is narrower
    // but not wrong.
    list = [
      'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
      'America/Phoenix', 'America/Anchorage', 'Pacific/Honolulu', 'Europe/London',
      'Europe/Berlin', 'Asia/Tokyo', 'Australia/Sydney',
    ]
  }
  allZones = list.includes('UTC') ? list : [...list, 'UTC']
  return allZones
}

const formatters = new Map()
function formatterFor(zone) {
  let f = formatters.get(zone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    formatters.set(zone, f)
  }
  return f
}

// The zone's wall clock at an instant, as the epoch-ms that wall time
// would be if it were UTC. `wallAt - instant` is the offset.
function wallAt(zone, epochMs) {
  const parts = {}
  for (const p of formatterFor(zone).formatToParts(new Date(epochMs))) parts[p.type] = Number(p.value)
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
}

const midnights = new Map()

// The instant a civil date begins in a zone, in epoch ms.
//
// Two estimates, because the offset in force at midnight is not known
// until the instant is: guess with the offset at the wall time read as
// UTC, then again with the offset at that guess. Where local midnight
// does not exist - Havana moves its clocks at 00:00, so 2026-03-08 there
// starts at 01:00 - neither estimate reads 00:00, and the earliest one
// that falls on the right date is the start of the day.
export function midnightUtc(zone, year, month, day) {
  const key = `${zone}|${year}-${month}-${day}`
  if (midnights.has(key)) return midnights.get(key)
  const wall = Date.UTC(year, month, day)
  const first = wall - (wallAt(zone, wall) - wall)
  const second = wall - (wallAt(zone, first) - first)
  let answer = null
  for (const t of first === second ? [first] : [Math.min(first, second), Math.max(first, second)]) {
    const local = wallAt(zone, t)
    if (local === wall) { answer = t; break }
    if (answer === null && local > wall && local - wall < DAY_MS) answer = t
  }
  if (answer === null) answer = second
  midnights.set(key, answer)
  return answer
}

function civil(date) {
  const [y, m, d] = String(date).split('-').map(Number)
  return { y, m: m - 1, d }
}

function addDays(date, n) {
  const { y, m, d } = civil(date)
  return new Date(Date.UTC(y, m, d + n)).toISOString().slice(0, 10)
}

function midnightOf(zone, date) {
  const { y, m, d } = civil(date)
  return midnightUtc(zone, y, m, d)
}

// How far `dateline` (epoch seconds) is from this zone's midnight of
// `date`: 'exact', 'day-off' (a whole day either side), or null.
function fit(zone, date, dateline) {
  const diff = dateline * 1000 - midnightOf(zone, date)
  if (diff === 0) return 'exact'
  return diff === DAY_MS || diff === -DAY_MS ? 'day-off' : null
}

// The zones one observation is consistent with.
//
// EXACT FITS WIN, and a whole-day-off fit is only entertained when there
// is no exact one anywhere. Both halves matter:
//
//   - FF's autumn pages stamp every dateline exactly one day late, and
//     the date label - not the dateline - says which day is meant. So a
//     whole-day excess has to be tolerated, or the one page this module
//     exists for would match no zone at all.
//   - But UTC+13 and UTC-11 are exactly 24 hours apart, so tolerating it
//     unconditionally makes Tonga's page indistinguishable from Pago
//     Pago's a day late, and every day on either reads as ambiguous. A
//     dateline that IS some zone's midnight of the printed date needs no
//     bug to explain it, so nothing else is considered.
function zonesFitting(pool, date, dateline) {
  const exact = []
  const dayOff = []
  for (const zone of pool) {
    const f = fit(zone, date, dateline)
    if (f === 'exact') exact.push(zone)
    else if (f === 'day-off') dayOff.push(zone)
  }
  return exact.length > 0 ? exact : dayOff
}

// Every zone that could have rendered a page, given observations of the
// form "FF said `dateline` was midnight on `date`".
//
// `anchors` are observations FF's bug does not corrupt: the first day of
// a page, on every page measured, carries the true offset for that day.
// More anchors from other pages of the same run narrow it further - that
// is what separates New York from Puerto Rico in the week the clocks
// change, since both are UTC-4 on the Sunday and only one is on Monday.
//
// Each anchor is judged against EVERY zone, not against the survivors of
// the one before, so the answer does not depend on the order they arrive
// in and one anchor cannot change how strictly another is read.
export function candidateZones(anchors) {
  const usable = (anchors || []).filter((a) => a && a.date && Number.isFinite(a.dateline))
  if (usable.length === 0) return []
  let candidates = null
  for (const a of usable) {
    const fitting = new Set(zonesFitting(zones(), a.date, a.dateline))
    candidates = candidates === null ? [...fitting] : candidates.filter((z) => fitting.has(z))
  }
  return candidates
}

// Where a day starts and how long it runs, IF the candidates agree.
//
// Returns null when they do not. That is the whole safety property: two
// zones the evidence cannot tell apart, disagreeing about a day, means
// the page did not say enough to place that day - and the caller must not
// guess.
export function resolveDay(candidates, date) {
  if (!candidates || candidates.length === 0) return null
  const next = addDays(date, 1)
  let start = null
  let end = null
  for (const zone of candidates) {
    const s = midnightOf(zone, date)
    const e = midnightOf(zone, next)
    if (start === null) { start = s; end = e; continue }
    if (s !== start || e !== end) return null
  }
  return { start, end, lengthSeconds: (end - start) / 1000 }
}

// Narrow the candidates with a day whose dateline is NOT simply the first
// day's stamp carried forward.
//
// FF's observed bug is to repeat the first day's offset down the page. A
// day that breaks that pattern is not explained by the bug, so it has to
// be a real midnight - and a real midnight is evidence. If FF ever fixes
// its datelines, every day becomes one of these and the zone is pinned
// from a single page, with no second request needed.
//
// Evidence that no candidate fits is ignored rather than obeyed: it then
// says something is wrong with that day, not with the zone.
export function narrowByDay(candidates, date, dateline) {
  const fitting = zonesFitting(candidates, date, dateline)
  return fitting.length > 0 ? fitting : candidates
}

export { addDays }
