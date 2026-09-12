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
  zoneOffsetSeconds,
  FF_DISPLAY_TIMEZONE,
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
// midnight + the row's wall-clock minutes looks like the exact instant.
// It isn't, on the two days a year the offset changes partway through:
// on 2026-11-01 Chicago midnight is CDT but 8:30am is CST, and plain
// addition stored 8:30am as 7:30am. Both directions were reproduced.
//
// So the offset is taken at the target instant, not at midnight, and the
// difference is corrected out:
//
//   T = T0 + offset(midnight) - offset(T0)
//
// with T0 the naive sum. One pass is enough - offset(T0) and offset(T)
// differ only inside the transition hour itself, whose wall-clock times
// are genuinely ambiguous (or nonexistent) anyway.
//
// The zone is verified rather than assumed on every page: if `dateline`
// is not actually midnight in FF_DISPLAY_TIMEZONE then FF has moved off
// that zone, and applying a correction derived from the wrong zone would
// be worse than the naive sum it replaces - so the naive sum is kept and
// the caller is told, which is the same information a wrong timestamp
// would have hidden.
function isLocalMidnight(dateline) {
  const offset = zoneOffsetSeconds(new Date(dateline * 1000), FF_DISPLAY_TIMEZONE)
  return (dateline + offset) % 86400 === 0
}

function instantFor(dateline, minutes) {
  const naive = new Date((dateline + minutes * 60) * 1000)
  if (minutes === 0 || !isLocalMidnight(dateline)) return naive
  const midnightOffset = zoneOffsetSeconds(new Date(dateline * 1000), FF_DISPLAY_TIMEZONE)
  const naiveOffset = zoneOffsetSeconds(naive, FF_DISPLAY_TIMEZONE)
  return new Date(naive.getTime() + (midnightOffset - naiveOffset) * 1000)
}

// FF's own calendar day for a dateline, as YYYY-MM-DD. Taken from the
// dateline directly rather than from the event's instant: the dateline is
// the day the page filed the row under, which is exactly what eventKey
// needs, and it stays right for an evening row whose UTC date has already
// rolled over.
function dayFor(dateline) {
  const offset = isLocalMidnight(dateline) ? zoneOffsetSeconds(new Date(dateline * 1000), FF_DISPLAY_TIMEZONE) : 0
  return new Date((dateline + offset) * 1000).toISOString().slice(0, 10)
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

  let dateline = null
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
    const eventTime = instantFor(dateline, minutes)
    if (Number.isNaN(eventTime.getTime())) { skipped++; continue }
    const day = dayFor(dateline)

    const actualHtml = cellHtml(rowHtml, 'actual')
    const previousHtml = cellHtml(rowHtml, 'previous')

    events.push({
      event_key: eventKey({ eventTime, currency, title, day }),
      ff_event_id: /data-event-id="(\d+)"/i.exec(rowHtml)?.[1] || null,
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

  // Same de-duplication as the JSON path: one upsert batch must never name
  // the same key twice, and a month page legitimately repeats an event
  // that was rescheduled within it.
  const byKey = new Map()
  for (const e of events) byKey.set(e.event_key, e)

  return { events: [...byKey.values()], skipped, days: datelines.size }
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
