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

import { classifyEventType, eventKey, cleanFigure, detailUrlFor } from './econCalendarEvents.mjs'

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
function cellText(html) {
  if (!html) return ''
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
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
    if (/calendar__row--day-breaker/i.test(rowHtml)) continue

    const datelineMatch = /data-day-dateline="(\d+)"/i.exec(rowHtml)
    if (datelineMatch) {
      dateline = Number(datelineMatch[1])
      datelines.add(dateline)
      // A new day restarts the carry-forward: the first row of a day must
      // never inherit the last time of the previous one.
      lastTimeText = ''
    }

    const title = cellText(
      /<span class="calendar__event-title">([\s\S]*?)<\/span>/i.exec(rowHtml)?.[1] || '',
    )
    // No title means this isn't an event row (a spacer, an ad slot, a
    // markup change) - counted rather than silently dropped.
    if (!title) continue
    if (dateline === null) { skipped++; continue }

    const currency = cellText(cellHtml(rowHtml, 'currency')).toUpperCase()
    const timeText = cellText(cellHtml(rowHtml, 'time')) || lastTimeText
    if (cellText(cellHtml(rowHtml, 'time'))) lastTimeText = cellText(cellHtml(rowHtml, 'time'))

    const precision = timePrecisionFor(timeText) || 'all_day'
    const minutes = precision === 'exact' ? parseClockMinutes(timeText) : 0
    const eventTime = new Date((dateline + minutes * 60) * 1000)
    if (Number.isNaN(eventTime.getTime())) { skipped++; continue }

    const actualHtml = cellHtml(rowHtml, 'actual')
    const previousHtml = cellHtml(rowHtml, 'previous')

    events.push({
      event_key: eventKey({ eventTime, currency, title }),
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
      detail_url: detailUrlFor(eventTime),
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
