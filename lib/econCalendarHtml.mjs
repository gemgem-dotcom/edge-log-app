// Parses forexfactory.com/calendar's own HTML into the same row shape
// lib/econCalendarEvents.mjs produces from the JSON feed, so both sources
// upsert into economic_events on the same key.
//
// Why the HTML at all, when there's a published JSON feed: the feed covers
// ONE week and carries no `actual` column. The page covers any week or
// month (?week=aug28.2026, ?month=sep.2026) and carries actual, forecast,
// previous, FF's own beat/miss marking, and FF's own event ids. Backfill,
// forward fill and actuals all need it.
//
// On access: the page is served to this app's own honest, self-identifying
// User-Agent. It is a stock browser User-Agent that gets a Cloudflare
// challenge - confirmed both ways by scripts/probe-forexfactory-sources.js.
// Nothing here pretends to be a browser, solves a challenge, or evades a
// bot check, and nothing that does should be added: if the honest request
// ever stops being served, the answer is a different source.
//
// Everything below is a pure function over an HTML string, so it is tested
// against a fixture of real markup rather than against a live fetch.

import {
  classifyEventType,
  eventKey,
  cleanFigure,
  detailUrlFor,
  sequenceEventKeys,
} from './econCalendarEvents.mjs'
import { candidateZones, resolveDay, narrowByDay, addDays } from './econCalendarZone.mjs'

// FF's impact icon suffixes. The colours are the same four the JSON feed's
// words map to (see IMPACT_LEVELS), just expressed as sprite classes.
const IMPACT_BY_ICON = {
  red: 'high',
  ora: 'medium',
  yel: 'low',
  gra: 'holiday',
}

// Strips tags and decodes the handful of entities FF's calendar actually
// emits. Deliberately not a general HTML entity decoder - this runs over
// table cells holding numbers, percentages and event names, and a full
// decoder would be a dependency bought for nothing.
const NAMED_ENTITIES = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  apos: "'",
  quot: '"',
}

function cellText(html) {
  if (!html) return ''
  return html
    .replace(/<[^>]*>/g, '')
    // One pass over every entity rather than a chain of replaces. A chain
    // decodes its own output: `&amp;lt;` became `&lt;` on the &amp; step
    // and then `<` on the &lt; step, inventing markup that was never in
    // the source. Numeric forms are handled here too - FF emits `&#039;`
    // in names like "Moody's", which the old named-only list left raw in
    // both the title and the event key built from it.
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body) => {
      if (body[0] === '#') {
        const code = body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10)
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match
      }
      const named = NAMED_ENTITIES[body.toLowerCase()]
      return named === undefined ? match : named
    })
    .replace(/\s+/g, ' ')
    .trim()
}

function cellHtml(row, cellClass) {
  const re = new RegExp(`<td[^>]*class="[^"]*calendar__${cellClass}[^"]*"[^>]*>([\\s\\S]*?)</td>`, 'i')
  const m = re.exec(row)
  return m ? m[1] : ''
}

// FF renders clock times in whatever timezone it is displaying in
// (America/Chicago for an anonymous visitor). Rather than assume that -
// which would put every stored timestamp hours out the moment FF changed
// it, or across a DST boundary - each day's first row carries
// data-day-dateline, the Unix epoch of MIDNIGHT in that display timezone.
// Midnight plus the wall-clock time on the row is therefore the exact
// instant, with no timezone assumption anywhere in the maths.
export function parseClockMinutes(text) {
  const m = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(String(text).trim())
  if (!m) return null
  const hour = Number(m[1]) % 12
  const pm = /pm/i.test(m[3])
  return (hour + (pm ? 12 : 0)) * 60 + Number(m[2])
}

// Rows whose time cell isn't a clock: "All Day", "Tentative", "Day 1" (a
// multi-day summit), "24h". They're real events with a real date and no
// meaningful minute, so they're kept and marked rather than dropped or
// given a fake 00:00 that would sort them among the overnight releases as
// if they were scheduled then.
function timePrecisionFor(text) {
  const value = String(text || '').trim().toLowerCase()
  if (!value) return null
  if (value.startsWith('all day')) return 'all_day'
  if (value.startsWith('tentative')) return 'tentative'
  if (parseClockMinutes(value) !== null) return 'exact'
  return 'all_day'
}

// WHAT THE INSTANT OF A ROW IS, and what it used to be.
//
// It used to be `dateline + the row's clock time`, on the understanding
// that data-day-dateline is the epoch of local midnight. Measured against
// live pages (scripts/probe-forexfactory-datelines.js, 2026-11-10) the
// dateline is not reliably that: FF stamps the page's first-day offset on
// every day, and on a page that starts on the autumn changeover every
// dateline is a whole day late as well. See lib/econCalendarZone.mjs for
// the measurements and for what that did to production.
//
// A correction that waited for a 23- or 25-hour gap between consecutive
// datelines lived here before this. It was reasoned from how a dateline
// ought to behave and tested against fixtures built to behave that way.
// FF has never emitted such a gap - every gap on every measured page is
// exactly 86400 - so it never ran, and the two weeks a year it existed
// for were wrong the whole time.
//
// So the instant is now built from what FF PRINTS, which is right on
// every page checked: the day's date label and the row's clock time are
// true local wall time. `resolved` is where that day starts and how long
// it runs in FF's display zone, agreed by every timezone the page's
// evidence is consistent with.
//
// The one assumption left is WHEN in a changeover day the clocks move.
// 02:00 local is what every zone FF has been observed to serve uses. A
// zone that moves at another hour would misplace only the rows between
// midnight and its own transition, on two days a year, where FF lists
// essentially nothing.
const DAY_SECONDS = 86400
const TRANSITION_MINUTES = 120

function instantFor(resolved, minutes) {
  // An all-day or tentative row is anchored to the start of its day.
  if (minutes === 0) return new Date(resolved.start)
  const shift = resolved.lengthSeconds - DAY_SECONDS
  const correction = shift !== 0 && minutes >= TRANSITION_MINUTES ? shift : 0
  return new Date(resolved.start + (minutes * 60 + correction) * 1000)
}

// FF's own calendar day for a dateline, as YYYY-MM-DD. Taken from the
// dateline directly rather than from the event's instant: the dateline is
// the day the page filed the row under, which is exactly what eventKey
// needs, and it stays right for an evening row whose UTC date has already
// rolled over.
// No timezone at all, named or assumed. The dateline is midnight on FF's
// own day, so noon on that same day is twelve hours later - and a local
// noon lands on the same calendar date in every zone within ±12 hours of
// UTC, which is every zone a calendar site would display in. Reading the
// UTC date of dateline+12h therefore gives FF's day whatever zone FF is
// using, without needing to work out which one that is.
//
// This replaced taking the UTC date of the dateline itself, which was only
// right while FF displayed in a zone BEHIND UTC. Served a page in a zone
// ahead of it - the dateline then being 23:00Z on the previous UTC day -
// every key and detail_url on that page came out a day early, while
// event_time stayed correct. Seen in production: 181 of 1503 backfilled
// rows, all at 05:00Z and 06:00Z, e.g. "2026-07-01|CHF|CPI m/m" holding an
// event at 2026-07-02T06:30Z. The danger is not the label but the key: the
// same release fetched again from a page served in a behind-UTC zone keys
// differently and inserts a SECOND row rather than updating the first.
//
// The arithmetic alone carries one bound: "every zone a calendar site would
// display in" means |offset| <= 12. At UTC+13 or +14 (Auckland in southern
// summer, Apia, Chatham) local midnight is 11:00Z or 10:00Z on the PREVIOUS
// UTC day, so +12h lands before the rollover and the day comes out one
// early - the same failure described above, one zone further out. A
// dateline alone genuinely cannot tell UTC-11 from UTC+13: both put local
// midnight at the same point in the UTC day.
//
// So the dateline is no longer asked on its own. FF prints the day's date
// in the row's own date cell - `<span class="date">Fri <span>Aug 28</span>
// </span>` - and that label is FF stating which day it thinks this is, in
// its own display zone, with no arithmetic in between. Where it is present
// it decides; the arithmetic supplies the year the label omits, and the
// candidate window it is matched against.
//
// Matching against dateline-1d/+0/+1d is enough, because the arithmetic is
// never more than a day out in either direction, and three consecutive
// dates cannot repeat a month-and-day - so a match is unique when it
// exists. Falling back to the bare arithmetic when the label is missing or
// unreadable keeps a markup change from turning into dropped rows: the
// result is then exactly what it was before, correct for |offset| <= 12.
const HALF_DAY_SECONDS = 43200
const MONTH_BY_ABBR = Object.fromEntries(
  ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
    .map((name, i) => [name, i]),
)

// "Fri Aug 28" / "Aug 28" / "Fri <span>Aug 28</span>" -> { month: 7, dom: 28 }
// The weekday is ignored: it is redundant with the date, and FF has printed
// it both with and without a trailing comma.
export function parseDateLabel(text) {
  const m = /\b([a-z]{3})[a-z]*\.?\s+(\d{1,2})\b/i.exec(String(text || ''))
  if (!m) return null
  const month = MONTH_BY_ABBR[m[1].toLowerCase()]
  const dom = Number(m[2])
  if (month === undefined || !(dom >= 1 && dom <= 31)) return null
  return { month, dom }
}

// `labelled` says whether FF's printed date decided the answer. It matters
// to the caller: a day placed by the label has been cross-checked against
// what a person reading the page would see, and a day placed by dateline
// arithmetic alone has not - and the arithmetic is exactly what is a whole
// day out on FF's autumn pages.
export function labelledDay(dateline, label = null) {
  const base = new Date((dateline + HALF_DAY_SECONDS) * 1000)
  const parsed = parseDateLabel(label)
  if (parsed) {
    for (const shift of [0, 1, -1]) {
      const candidate = new Date(base.getTime() + shift * DAY_SECONDS * 1000)
      if (candidate.getUTCMonth() === parsed.month && candidate.getUTCDate() === parsed.dom) {
        return { date: candidate.toISOString().slice(0, 10), labelled: true }
      }
    }
  }
  // No label, or one that matches no candidate - a label about some other
  // day, markup that moved, a cell read from the wrong row. Trusting it
  // over the dateline would be worse than ignoring it.
  return { date: base.toISOString().slice(0, 10), labelled: false }
}

export function dayFor(dateline, label = null) {
  return labelledDay(dateline, label).date
}

function impactFrom(rowHtml) {
  const m = /icon--ff-impact-(\w+)/i.exec(rowHtml)
  // Unknown icon -> the grey "nothing is being released" level, the same
  // conservative default normalizeImpact uses for an unknown word.
  return (m && IMPACT_BY_ICON[m[1].toLowerCase()]) || 'holiday'
}

// FF marks an actual green or red against its own forecast by putting
// "better"/"worse" on the value's span. That's a genuine piece of the
// calendar's meaning - whether a release beat or missed - so it's kept
// rather than thrown away with the markup.
function actualStatusFrom(actualCellHtml) {
  if (/class="[^"]*\bbetter\b[^"]*"/i.test(actualCellHtml)) return 'better'
  if (/class="[^"]*\bworse\b/i.test(actualCellHtml)) return 'worse'
  return null
}

// One <tr> per event; a day's first row also carries the dateline and a
// rowspan'd date cell. Day-breaker rows carry neither and are skipped.
const ROW_RE = /<tr[^>]*class="[^"]*calendar__row[^"]*"[\s\S]*?<\/tr>/gi

const DATELINE_RE = /data-day-dateline="(\d+)"/i

// The first day a page renders, as an observation about FF's display zone:
// "FF says `dateline` is midnight on `date`". Cheap enough to read off a
// page that is being fetched for nothing else - which is what the fetch
// script does when one page alone cannot say which zone it is in.
export function readPageAnchor(html) {
  if (typeof html !== 'string') return null
  for (const [rowHtml] of html.matchAll(ROW_RE)) {
    const m = DATELINE_RE.exec(rowHtml)
    if (!m) continue
    const dateline = Number(m[1])
    const { date, labelled } = labelledDay(dateline, cellText(cellHtml(rowHtml, 'date')))
    // An anchor placed by arithmetic alone is not evidence worth lending
    // to another page: it could be the whole-day-late dateline itself.
    return labelled ? { date, dateline } : null
  }
  return null
}

const EMPTY_PAGE = {
  events: [],
  skipped: 0,
  days: 0,
  dstDays: 0,
  oddDatelines: 0,
  coveredFrom: null,
  coveredTo: null,
  coveredDays: [],
  untrustedDays: [],
  untrustedRows: 0,
  unlabelledDays: 0,
  zoneAmbiguous: false,
  anchor: null,
  anchorAfter: null,
  zones: [],
}

// Parses a whole calendar page.
//
//   events          rows whose instant is established. NOT every row on
//                   the page - see untrustedDays.
//   skipped         rows the parser saw and could not read.
//   days            distinct datelines seen, which is what tells a caller
//                   whether it got a real week or a page that merely
//                   looked like one.
//   untrustedDays   days the page rendered but whose instants could not
//                   be established, each with a reason. Their rows are
//                   withheld rather than stored on a guess.
//   zoneAmbiguous   true when that was because the page alone did not say
//                   which timezone it was in. `anchorAfter` is then the
//                   date whose page would settle it.
//
// `options.anchors` are first-day observations from OTHER pages fetched in
// the same run, which is the same caller and therefore the same zone.
export function parseCalendarHtml(html, options = {}) {
  if (typeof html !== 'string' || !html.includes('calendar__row')) {
    return { ...EMPTY_PAGE }
  }

  let skipped = 0
  const days = []
  let current = null
  // Blank time cells mean "same time as the row above" - FF only prints
  // the clock once per group of simultaneous releases.
  let lastTimeText = ''

  for (const [rowHtml] of html.matchAll(ROW_RE)) {
    // Read the dateline BEFORE skipping a day-breaker. The two live on
    // separate rows today, but if FF ever moves the attribute onto the
    // breaker, skipping first would leave every row of every later day
    // silently stamped with the previous day's date.
    const datelineMatch = DATELINE_RE.exec(rowHtml)
    if (datelineMatch) {
      const dateline = Number(datelineMatch[1])
      // FF's own printed date for the day. Read on the same row as the
      // dateline, and never carried over: a label from the previous day
      // would be a label about the wrong day.
      const label = cellText(cellHtml(rowHtml, 'date'))
      current = { dateline, label, ...labelledDay(dateline, label), rows: [] }
      days.push(current)
      // A new day restarts the carry-forward: the first row of a day must
      // never inherit the last time of the previous one.
      lastTimeText = ''
    } else if (current && !current.labelled) {
      // The dateline arrived on a row with no date cell (a day-breaker
      // carrying the attribute). The day's own first event row still has
      // the label, so take it from there rather than go without.
      const label = cellText(cellHtml(rowHtml, 'date'))
      if (label) Object.assign(current, { label }, labelledDay(current.dateline, label))
    }

    if (/calendar__row--day-breaker/i.test(rowHtml)) continue

    // Tags inside the title span are stripped rather than treated as its
    // end. The old non-greedy match to the first </span> returned an empty
    // title for `<span class="...-title"><span class="flag"></span>FOMC
    // Statement</span>`, which dropped the row entirely - and dropped it
    // without counting it, so a run that lost events still reported
    // skipped=0 and looked clean.
    const titleMatch = /<span class="calendar__event-title"[^>]*>([\s\S]*)<\/span>/i.exec(
      cellHtml(rowHtml, 'event'),
    )
    const title = cellText(titleMatch?.[1] || '')
    // No title at all means this isn't an event row (a spacer, an ad slot,
    // or markup that moved). Counted, never silently dropped.
    if (!title) {
      if (/calendar__event-title/i.test(rowHtml)) skipped++
      continue
    }
    if (current === null) { skipped++; continue }

    const ownTime = cellText(cellHtml(rowHtml, 'time'))
    const timeText = ownTime || lastTimeText
    if (ownTime) lastTimeText = ownTime
    current.rows.push({ rowHtml, title, timeText })
  }

  if (days.length === 0) return { ...EMPTY_PAGE, skipped }

  // --- Which zone is this page in? -------------------------------------
  //
  // The first day's dateline is the one FF's bug does not corrupt, so it
  // anchors the page; anchors lent by other pages of the same run narrow
  // it. If the lent ones contradict this page outright they are dropped
  // rather than obeyed - a page is better judged on its own evidence than
  // on another's.
  const first = days[0]
  const ownAnchor = { date: first.date, dateline: first.dateline }
  const lent = Array.isArray(options.anchors) ? options.anchors : []
  let candidates = candidateZones([ownAnchor, ...lent])
  if (candidates.length === 0 && lent.length > 0) candidates = candidateZones([ownAnchor])

  // A day whose dateline is not the first day's stamp carried forward is
  // not explained by FF's bug, so it is a real midnight and further
  // evidence. On today's pages there are none; if FF ever fixes its
  // datelines every day becomes one and a single page pins the zone.
  const carried = (d) => (d.dateline - first.dateline) % DAY_SECONDS === 0
  for (const d of days) {
    if (d !== first && !carried(d)) candidates = narrowByDay(candidates, d.date, d.dateline)
  }

  let zoneAmbiguous = false
  const untrustedDays = []
  for (const d of days) {
    const resolved = resolveDay(candidates, d.date)
    let reason = null
    if (!resolved) {
      reason = candidates.length === 0 ? 'no-zone' : 'ambiguous'
      if (reason === 'ambiguous') zoneAmbiguous = true
    } else {
      // The dateline still has to be explicable: either a whole number of
      // days from the day's true start (right, or FF's whole-day-late
      // autumn stamp) or the first day's stamp carried forward. One that
      // is neither is saying something this parser does not understand,
      // and the day is withheld rather than interpreted.
      const offBy = d.dateline * 1000 - resolved.start
      const wholeDays = offBy % (DAY_SECONDS * 1000) === 0
      if (!(wholeDays || carried(d)) || Math.abs(offBy) > 2 * DAY_SECONDS * 1000) reason = 'dateline-mismatch'
    }
    d.resolved = reason ? null : resolved
    if (reason) untrustedDays.push({ date: d.date, label: d.label, reason, rows: d.rows.length })
  }

  // --- Rows -> events ---------------------------------------------------
  const events = []
  let untrustedRows = 0
  for (const d of days) {
    if (!d.resolved) { untrustedRows += d.rows.length; continue }
    for (const { rowHtml, title, timeText } of d.rows) {
      const currency = cellText(cellHtml(rowHtml, 'currency')).toUpperCase()
      const precision = timePrecisionFor(timeText) || 'all_day'
      const minutes = precision === 'exact' ? parseClockMinutes(timeText) : 0
      const eventTime = instantFor(d.resolved, minutes)
      if (Number.isNaN(eventTime.getTime())) { skipped++; continue }

      const actualHtml = cellHtml(rowHtml, 'actual')
      const previousHtml = cellHtml(rowHtml, 'previous')

      // FF's own id for the row, which becomes the key when present - see
      // eventKey. Every row on a real calendar page carries one (confirmed
      // in production: 2477 of 2477 stored rows have it), so the day-based
      // form below is effectively the JSON feed's alone.
      const ffEventId = /data-event-id="(\d+)"/i.exec(rowHtml)?.[1] || null

      events.push({
        event_key: eventKey({ eventTime, currency, title, day: d.date, ffEventId }),
        ff_event_id: ffEventId,
        title,
        currency,
        event_time: eventTime.toISOString(),
        impact: impactFrom(cellHtml(rowHtml, 'impact')),
        event_type: classifyEventType(title),
        forecast: cleanFigure(cellText(cellHtml(rowHtml, 'forecast'))),
        previous: cleanFigure(cellText(previousHtml)),
        actual: cleanFigure(cellText(actualHtml)),
        actual_status: actualStatusFrom(actualHtml),
        // FF flags a previous figure that has since been restated.
        previous_revised: /class="[^"]*\brevised\b/i.test(previousHtml),
        time_precision: precision,
        detail_url: detailUrlFor(eventTime, d.date),
      })
    }
  }

  // Same pass as the JSON path. It collapses the rows that really are one
  // event (a month page can list one twice when it was rescheduled within
  // the month - same FF event id), which an upsert batch requires since
  // naming a key twice fails the whole statement, and it keeps genuine
  // same-day repeats of a title apart instead of letting the later one
  // overwrite the earlier.
  const sequenced = sequenceEventKeys(events)

  // The instants this page actually spoke for, so a caller can tell what
  // its absence from the page means. FF removes events - a speech is
  // cancelled, a release is withdrawn, something moves to another week -
  // and an upsert can only ever add or update, so without a bound like
  // this there is no safe way to drop a row FF has stopped listing.
  //
  // One [start, end) window per day, and a day only gets one when ALL of
  // these hold:
  //   - its instants were established. A day that was withheld above has
  //     stored rows this run did not refresh, and every one of them would
  //     read as "vanished".
  //   - FF's printed date placed it. A day placed by dateline arithmetic
  //     alone could be the whole-day-late one, and a window a day out
  //     deletes a real day of events.
  //   - the NEXT calendar day is rendered straight after it. That excludes
  //     the final day, which is the one a truncated response leaves
  //     half-rendered, and any day followed by a hole in the page, where
  //     rows may have been attributed to the wrong side of the hole.
  //
  // Each window is the day's REAL length, so a 23-hour changeover day does
  // not reach an hour into the next one and take its all-day rows.
  //
  // The cost is that the last rendered day is never removed from. The next
  // page containing it covers it - the week page re-fetches the same days
  // hourly - so it is a delay, not a permanent miss, and the diagnostic's
  // STALENESS section is where it shows up meanwhile.
  const coveredDays = []
  for (let i = 0; i + 1 < days.length; i++) {
    const d = days[i]
    if (!d.resolved || !d.labelled) continue
    if (days[i + 1].date !== addDays(d.date, 1)) continue
    coveredDays.push([new Date(d.resolved.start).toISOString(), new Date(d.resolved.end).toISOString()])
  }

  // The outer bound of those windows, so a caller can scan the database
  // once rather than per day. It is a superset - anything it returns is
  // still checked against coveredDays before being acted on.
  const coveredFrom = coveredDays.length ? coveredDays[0][0] : null
  const coveredTo = coveredDays.length ? coveredDays[coveredDays.length - 1][1] : null

  const datelines = new Set(days.map((d) => d.dateline))
  return {
    events: sequenced,
    skipped,
    days: datelines.size,
    // Changeover days whose rows were placed with the real day length.
    dstDays: days.filter((d) => d.resolved && d.resolved.lengthSeconds !== DAY_SECONDS).length,
    // A dateline is midnight somewhere, so it is always a whole number of
    // minutes from a UTC day. Anything else means the attribute changed
    // format.
    oddDatelines: [...datelines].filter((d) => d % 60 !== 0).length,
    coveredFrom,
    coveredTo,
    coveredDays,
    untrustedDays,
    untrustedRows,
    unlabelledDays: days.filter((d) => !d.labelled).length,
    zoneAmbiguous,
    anchor: first.labelled ? ownAnchor : null,
    // The day after the page ends. A page starting there carries the
    // offset in force once any clock change inside THIS page has happened,
    // which is the one fact a single page cannot supply.
    anchorAfter: addDays(days[days.length - 1].date, 1),
    // For the log only - never a decision input. Enough to see at a
    // glance which family of zones the evidence left standing.
    zones: candidates.slice(0, 4),
  }
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

// FF's own URL forms. Both take its ?week=/?month= date spelling, which is
// lowercase-month + non-padded day + year.
export function weekUrl(date) {
  const d = date instanceof Date ? date : new Date(date)
  return `https://www.forexfactory.com/calendar?week=${MONTHS[d.getUTCMonth()]}${d.getUTCDate()}.${d.getUTCFullYear()}`
}

export function monthUrl(date) {
  const d = date instanceof Date ? date : new Date(date)
  return `https://www.forexfactory.com/calendar?month=${MONTHS[d.getUTCMonth()]}.${d.getUTCFullYear()}`
}
