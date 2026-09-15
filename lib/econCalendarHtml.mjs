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

// A day's dateline is the epoch of MIDNIGHT in FF's display timezone, so
// midnight + the row's wall-clock minutes is the exact instant on any
// ordinary day, in any zone, with nothing assumed.
//
// It stops being exact on the two days a year the offset changes partway
// through: on a 23-hour day an 8:30am row sits an hour later in real time
// than the arithmetic says, and on a 25-hour day an hour earlier. Both
// directions were reproduced.
//
// This used to correct that by asking a NAMED zone for its offset, with a
// guard that fell back to the naive sum if the dateline wasn't midnight in
// that zone. The guard did its job and then some: FF picks its display
// zone from the client's IP, so the name was wrong for most callers and
// the correction never ran anywhere. It was also silent, despite a comment
// claiming the caller was told.
//
// The page already carries the fact without naming anything. Consecutive
// datelines are exactly 86400s apart on an ordinary day, and 82800/90000
// across a changeover - so the day's own length IS the offset shift, and
// its sign says which way. The only thing left to assume is WHEN in the
// day it happens; 02:00 local is what every zone FF has been observed to
// serve uses, and it is stated here rather than buried. Getting it wrong
// would only misplace rows between 00:00 and 02:00 on a changeover day,
// where FF lists essentially nothing.
const DAY_SECONDS = 86400
const TRANSITION_MINUTES = 120

function instantFor(dateline, minutes, dayLength = DAY_SECONDS) {
  const naive = new Date((dateline + minutes * 60) * 1000)
  // An all-day or tentative row is anchored to the dateline itself, which
  // is already the exact instant of local midnight - nothing to correct.
  if (minutes === 0) return naive
  // A whole-day gap (or no next day to measure against) means no
  // changeover, and the naive sum is exact rather than merely close.
  const shift = dayLength - DAY_SECONDS
  if (shift === 0 || minutes < TRANSITION_MINUTES) return naive
  return new Date(naive.getTime() + shift * 1000)
}

// Each dateline mapped to the length of the day it starts, measured
// against the next dateline on the page. The last day has no successor to
// measure against, so it is treated as ordinary - a changeover falling on
// the final day of a page is corrected on the next page that contains it,
// which for the week and month pages this fetches always exists.
function dayLengthsFor(datelines) {
  const sorted = [...datelines].sort((a, b) => a - b)
  const lengths = new Map()
  for (let i = 0; i < sorted.length; i++) {
    const gap = i + 1 < sorted.length ? sorted[i + 1] - sorted[i] : DAY_SECONDS
    // Only a same-day-adjacent pair measures a day. A page with a gap in
    // it (FF omits days with no events) would otherwise read as a very
    // long day and invent a correction.
    lengths.set(sorted[i], gap > 0 && gap < 2 * DAY_SECONDS ? gap : DAY_SECONDS)
  }
  return lengths
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

export function dayFor(dateline, label = null) {
  const base = new Date((dateline + HALF_DAY_SECONDS) * 1000)
  const parsed = parseDateLabel(label)
  if (!parsed) return base.toISOString().slice(0, 10)

  for (const shift of [0, 1, -1]) {
    const candidate = new Date(base.getTime() + shift * DAY_SECONDS * 1000)
    if (candidate.getUTCMonth() === parsed.month && candidate.getUTCDate() === parsed.dom) {
      return candidate.toISOString().slice(0, 10)
    }
  }
  // A label that matches no candidate is a label about some other day -
  // markup moved, or a cell read from the wrong row. Trusting it over the
  // dateline would be worse than ignoring it.
  return base.toISOString().slice(0, 10)
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

// Parses a whole calendar page. Returns { events, skipped, days } - `days`
// being how many distinct datelines were seen, which is what tells a
// caller whether it got a real week or a page that merely looked like one.
export function parseCalendarHtml(html) {
  const events = []
  let skipped = 0
  const datelines = new Set()

  if (typeof html !== 'string' || !html.includes('calendar__row')) {
    return { events: [], skipped: 0, days: 0 }
  }

  // Every dateline on the page, read before the row walk, because a day's
  // length can only be measured against the NEXT day's dateline and the
  // rows arrive in order.
  const allDatelines = new Set(
    [...html.matchAll(/data-day-dateline="(\d+)"/gi)].map((m) => Number(m[1])),
  )
  const dayLengths = dayLengthsFor(allDatelines)

  let dateline = null
  // FF's own printed date for the current day, carried forward the same way
  // the dateline is: the date cell is rowspan'd across the day, so only the
  // day's first row actually has one.
  let dateLabel = ''
  // Blank time cells mean "same time as the row above" - FF only prints
  // the clock once per group of simultaneous releases.
  let lastTimeText = ''

  for (const [rowHtml] of html.matchAll(ROW_RE)) {
    // Read the dateline BEFORE skipping a day-breaker. The two live on
    // separate rows today, but if FF ever moves the attribute onto the
    // breaker, skipping first would leave every row of every later day
    // silently stamped with the previous day's date.
    const datelineMatch = /data-day-dateline="(\d+)"/i.exec(rowHtml)
    if (datelineMatch) {
      dateline = Number(datelineMatch[1])
      datelines.add(dateline)
      // A new day restarts the carry-forward: the first row of a day must
      // never inherit the last time of the previous one.
      lastTimeText = ''
      // Read on the same row as the dateline, and reset even when the cell
      // is absent. A label carried over from the previous day would be a
      // label about the wrong day, which dayFor would then either ignore or
      // - worse - match against the neighbouring candidate.
      dateLabel = cellText(cellHtml(rowHtml, 'date'))
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
    if (dateline === null) { skipped++; continue }

    const currency = cellText(cellHtml(rowHtml, 'currency')).toUpperCase()
    const timeText = cellText(cellHtml(rowHtml, 'time')) || lastTimeText
    if (cellText(cellHtml(rowHtml, 'time'))) lastTimeText = cellText(cellHtml(rowHtml, 'time'))

    const precision = timePrecisionFor(timeText) || 'all_day'
    const minutes = precision === 'exact' ? parseClockMinutes(timeText) : 0
    const eventTime = instantFor(dateline, minutes, dayLengths.get(dateline))
    if (Number.isNaN(eventTime.getTime())) { skipped++; continue }
    const day = dayFor(dateline, dateLabel)

    const actualHtml = cellHtml(rowHtml, 'actual')
    const previousHtml = cellHtml(rowHtml, 'previous')

    // FF's own id for the row, which becomes the key when present - see
    // eventKey. Every row on a real calendar page carries one (confirmed
    // in production: 2477 of 2477 stored rows have it), so the day-based
    // form below is effectively the JSON feed's alone.
    const ffEventId = /data-event-id="(\d+)"/i.exec(rowHtml)?.[1] || null

    events.push({
      event_key: eventKey({ eventTime, currency, title, day, ffEventId }),
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
      detail_url: detailUrlFor(eventTime, day),
    })
  }

  // Same pass as the JSON path. It collapses the rows that really are one
  // event (a month page can list one twice when it was rescheduled within
  // the month - same FF event id), which an upsert batch requires since
  // naming a key twice fails the whole statement, and it keeps genuine
  // same-day repeats of a title apart instead of letting the later one
  // overwrite the earlier.
  const sequenced = sequenceEventKeys(events)

  // A dateline whose local midnight can't be placed, or a day whose length
  // isn't 24h, is reported rather than left to be inferred from a wrong
  // timestamp. `dstDays` counts the changeover days the correction was
  // applied to; `oddDatelines` counts datelines that aren't a whole number
  // of minutes from a UTC day, which is what a format change would look
  // like.
  const { dstDays, oddDatelines } = describeDatelines(datelines)

  // The instants this page actually spoke for, so a caller can tell what
  // its absence from the page means. FF removes events - a speech is
  // cancelled, a release is withdrawn, something moves to another week -
  // and an upsert can only ever add or update, so without a bound like
  // this there is no safe way to drop a row FF has stopped listing.
  //
  // Bounded by the datelines rather than by the requested URL: a page that
  // rendered four of its seven days speaks for four days, and treating it
  // as speaking for the whole week would delete three days of real events.
  const sortedDatelines = [...datelines].sort((a, b) => a - b)

  // The days this page ACTUALLY rendered, as [start, end) instant pairs.
  //
  // Not a span from first dateline to last. A span silently includes days
  // the page never mentioned, and there are three ways a day goes missing -
  // FF dropped every event on it, its dateline failed to parse, or the
  // response was truncated - and only the first makes deleting its rows
  // correct. dayLengthsFor just below already refuses to measure across a
  // gap for the same reason.
  //
  // Built from CONSECUTIVE pairs, which buys three things at once:
  //   - an omitted day is excluded, because its gap fails the < 2 days test
  //   - the FINAL dateline is excluded, and that is the one day a truncated
  //     response leaves half-rendered - the tail of it would otherwise look
  //     removed on every cut-short fetch
  //   - each window is the day's REAL length, so a 23-hour changeover day
  //     does not reach an hour into the next day and take its all-day rows
  //
  // The cost is that the last rendered day is never removed from. The next
  // page containing it covers it - the week page re-fetches the same days
  // hourly - so it is a delay, not a permanent miss, and the diagnostic's
  // STALENESS section is where it shows up meanwhile.
  const coveredDays = []
  for (let i = 0; i + 1 < sortedDatelines.length; i++) {
    const gap = sortedDatelines[i + 1] - sortedDatelines[i]
    if (gap > 0 && gap < 2 * DAY_SECONDS) {
      coveredDays.push([
        new Date(sortedDatelines[i] * 1000).toISOString(),
        new Date(sortedDatelines[i + 1] * 1000).toISOString(),
      ])
    }
  }

  // The outer bound of those windows, so a caller can scan the database
  // once rather than per day. It is a superset - anything it returns is
  // still checked against coveredDays before being acted on.
  const coveredFrom = coveredDays.length ? coveredDays[0][0] : null
  const coveredTo = coveredDays.length ? coveredDays[coveredDays.length - 1][1] : null

  return {
    events: sequenced,
    skipped,
    days: datelines.size,
    dstDays,
    oddDatelines,
    coveredFrom,
    coveredTo,
    coveredDays,
  }
}

// What the set of datelines on a page says about FF's zone, without naming
// one. A dateline is local midnight, so consecutive datelines are 86400s
// apart on an ordinary day and 82800/90000 across a DST changeover. That
// is enough to find the changeover days; `instantFor` uses the same fact.
function describeDatelines(datelines) {
  const sorted = [...datelines].sort((a, b) => a - b)
  let dstDays = 0
  let oddDatelines = 0
  for (const d of sorted) if (d % 60 !== 0) oddDatelines++
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1]
    if (gap !== DAY_SECONDS && gap % DAY_SECONDS !== 0) dstDays++
  }
  return { dstDays, oddDatelines }
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
