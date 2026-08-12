import { FRED_RELEASES } from '@/lib/fredReleases'
import { computedReleasesInRange } from '@/lib/computedReleases'

// No API key needed: BLS publishes this iCalendar feed for exactly this
// purpose (external subscription in Outlook/Google Calendar/etc.), unlike
// the paywalled Finnhub/FMP endpoints this route was originally built
// against, or CME's own calendar (explicitly prohibits automated
// collection/redistribution in their Terms of Use - see git history for
// that dead end). It's U.S. government data with no comparable
// restriction, and it's schedule-only - no actual/forecast/previous
// values - which matches what this card actually needs.
const BLS_ICS_URL = 'https://www.bls.gov/schedule/news_release/bls.ics'

// No official feed exists for FOMC meeting dates (checked FRED, the Fed's
// own site, Federal Register) - every known open-source tool that solves
// this scrapes federalreserve.gov's own calendar page, so this does too.
// A government agency's own scheduling page, not a commercial product they
// license (unlike CME, which explicitly prohibits this - see git history).
const FOMC_CALENDAR_URL = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm'

const MONTH_NAMES = { January: 0, February: 1, March: 2, April: 3, May: 4, June: 5, July: 6, August: 7, September: 8, October: 9, November: 10, December: 11 }

// Everything else in BLS's release calendar defaults to medium impact -
// there's no "low" tier here, since BLS only lists indicators it
// considers release-worthy in the first place. CATEGORIES:IMPORTANT is on
// every event in the feed (including minor regional releases), so it
// can't be used to distinguish market-moving impact - matching on the
// well-known high-impact release names instead.
const HIGH_IMPACT_KEYWORDS = ['Employment Situation', 'Consumer Price Index', 'Producer Price Index', 'Employment Cost Index']

function classifyImpact(summary) {
  return HIGH_IMPACT_KEYWORDS.some((kw) => summary.includes(kw)) ? 'high' : 'medium'
}

// Module-level cache of the whole merged event list, unfiltered by week -
// none of these sources change more than a few times a year, so a several-
// hour TTL is plenty. Caching the raw merged list rather than one week's
// slice means flipping between weeks (see EconomicCalendarCard.js) never
// re-fetches anything, just re-filters data already in memory.
let cache = { data: null, fetchedAt: 0 }
const CACHE_TTL_MS = 6 * 60 * 60 * 1000

// How far the FRED fetch reaches on either side of "now" - wide enough to
// cover the card's prev/next week navigation without needing a fresh fetch
// on every click.
const FRED_WINDOW_PAST_DAYS = 90
const FRED_WINDOW_FUTURE_DAYS = 180

function pad(n) {
  return String(n).padStart(2, '0')
}

function toDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// BLS's DTSTART values are bare US-Eastern local time with no UTC offset
// (DTSTART;TZID=US-Eastern:20250110T083000) - confirmed against a real
// sample of the feed, not guessed - so there's no timezone conversion to
// do here at all, unlike sessionFor() in lib/tradeMath.js.
function todayInET() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const get = (type) => parts.find((p) => p.type === type).value
  return `${get('year')}-${get('month')}-${get('day')}`
}

// Monday through Sunday of the week containing dateStr.
function weekRangeOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00')
  const day = d.getDay()
  const monday = new Date(d)
  monday.setDate(d.getDate() + (day === 0 ? -6 : 1 - day))
  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 6)
  return { from: toDateStr(monday), to: toDateStr(sunday) }
}

// RFC 5545 line-folding: a line starting with a space is a continuation of
// the previous line, not a new field.
function unfoldLines(text) {
  return text.replace(/\r\n/g, '\n').split('\n').reduce((lines, line) => {
    if (line.startsWith(' ') && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1)
    } else {
      lines.push(line)
    }
    return lines
  }, [])
}

function parseBlsIcs(text) {
  const lines = unfoldLines(text)
  const events = []
  let current = null
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      current = {}
    } else if (line === 'END:VEVENT') {
      if (current?.event && current?.date) events.push(current)
      current = null
    } else if (current) {
      const idx = line.indexOf(':')
      if (idx === -1) continue
      const key = line.slice(0, idx)
      const value = line.slice(idx + 1)
      if (key.startsWith('SUMMARY')) {
        current.event = value.replace(/\\,/g, ',')
      } else if (key.startsWith('DTSTART')) {
        const m = value.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/)
        if (m) {
          const [, y, mo, d, h, mi] = m
          current.date = `${y}-${mo}-${d}`
          current.time = `${h}:${mi}`
        }
      }
    }
  }
  return events
}

async function fetchBlsEvents() {
  // BLS's server rejects requests with no/generic User-Agent (a 403, even
  // though the feed itself is public) - identify honestly as a real
  // calendar client fetching a feed BLS publishes for exactly this
  // purpose, the same way Outlook/Google Calendar would when subscribing.
  const res = await fetch(BLS_ICS_URL, {
    headers: { 'User-Agent': 'EdgeLog-EconomicCalendar/1.0 (+https://edgelog-journal.com)' },
  })
  if (!res.ok) throw new Error(`BLS returned ${res.status}`)
  const text = await res.text()
  const raw = parseBlsIcs(text)

  return raw.map((e) => ({
    date: e.date,
    time: e.time,
    country: 'US',
    event: e.event,
    impact: classifyImpact(e.event),
    actual: null,
    estimate: null,
    prev: null,
    unit: '',
  }))
}

// Meeting rows look like:
//   <div class="fomc-meeting__month ..."><strong>January</strong></div>
//   <div class="fomc-meeting__date ...">27-28</div>
// (sometimes "27-28*", the asterisk flagging a Summary of Economic
// Projections meeting - stripped, not meaningful here). The second day is
// the announcement/statement day. A meeting whose range crosses a month
// boundary (rare, e.g. "30-1") has a second day smaller than the first,
// meaning it falls in the following month. Confirmed against a real
// fetch of this page, not guessed - every 2026 date matched independent
// verification.
function parseFomcHtml(html) {
  const events = []
  const panelRe = /<a id="\d+">(\d{4}) FOMC Meetings<\/a>/g
  const panelStarts = []
  let m
  while ((m = panelRe.exec(html))) {
    panelStarts.push({ year: Number(m[1]), index: m.index })
  }
  for (let i = 0; i < panelStarts.length; i++) {
    const { year, index } = panelStarts[i]
    const end = i + 1 < panelStarts.length ? panelStarts[i + 1].index : html.length
    const panelHtml = html.slice(index, end)

    const meetingRe = /fomc-meeting__month[^>]*><strong>(\w+)<\/strong><\/div>\s*<div class="fomc-meeting__date[^>]*>(\d+)-(\d+)\*?<\/div>/g
    let mm
    while ((mm = meetingRe.exec(panelHtml))) {
      const [, monthName, startDayStr, endDayStr] = mm
      const month = MONTH_NAMES[monthName]
      if (month === undefined) continue
      const startDay = Number(startDayStr)
      const endDay = Number(endDayStr)
      let announceMonth = month
      let announceYear = year
      if (endDay < startDay) {
        announceMonth = month + 1
        if (announceMonth > 11) { announceMonth = 0; announceYear += 1 }
      }
      const date = `${announceYear}-${pad(announceMonth + 1)}-${pad(endDay)}`
      events.push({
        date, time: '14:00', country: 'US', event: 'FOMC Statement', impact: 'high',
        actual: null, estimate: null, prev: null, unit: '',
      })
    }
  }
  return events
}

// Additive on top of BLS, same as FRED - a scrape failure (markup change,
// site hiccup) shouldn't take down the whole card, just this one slice.
async function fetchFomcEvents() {
  try {
    const res = await fetch(FOMC_CALENDAR_URL, {
      headers: { 'User-Agent': 'EdgeLog-EconomicCalendar/1.0 (+https://edgelog-journal.com)' },
    })
    if (!res.ok) return []
    const html = await res.text()
    return parseFomcHtml(html)
  } catch {
    return []
  }
}

// FRED's release_dates endpoint returns a date only (no time of day) per
// release_id - one call per whitelisted release, in parallel. Silently
// contributes nothing (rather than failing the whole card) if FRED_API_KEY
// isn't set, since it's additive on top of BLS rather than required.
async function fetchFredEvents() {
  const apiKey = process.env.FRED_API_KEY
  if (!apiKey) return []

  const now = new Date()
  const start = new Date(now)
  start.setDate(start.getDate() - FRED_WINDOW_PAST_DAYS)
  const end = new Date(now)
  end.setDate(end.getDate() + FRED_WINDOW_FUTURE_DAYS)
  const realtimeStart = toDateStr(start)
  const realtimeEnd = toDateStr(end)

  const ids = Object.keys(FRED_RELEASES)
  const results = await Promise.all(ids.map(async (id) => {
    const meta = FRED_RELEASES[id]
    const url = `https://api.stlouisfed.org/fred/releases/dates?api_key=${apiKey}&file_type=json&release_id=${id}&realtime_start=${realtimeStart}&realtime_end=${realtimeEnd}&include_release_dates_with_no_data=true`
    try {
      const res = await fetch(url)
      if (!res.ok) return []
      const data = await res.json()
      return (data.release_dates || []).map((rd) => ({
        date: rd.date, time: meta.time, country: 'US', event: meta.name,
        impact: meta.impact, actual: null, estimate: null, prev: null, unit: '',
      }))
    } catch {
      return []
    }
  }))
  return results.flat()
}

async function loadAllEvents() {
  const now = Date.now()
  if (cache.data && now - cache.fetchedAt < CACHE_TTL_MS) return cache.data

  const [blsEvents, fredEvents, fomcEvents] = await Promise.all([
    fetchBlsEvents(),
    fetchFredEvents(),
    fetchFomcEvents(),
  ])

  // Computed events (ISM PMI, CB Consumer Confidence - see
  // lib/computedReleases.js) span the same window FRED was fetched for,
  // so all three sources cover the same forward/back range.
  const now2 = new Date()
  const start = new Date(now2); start.setDate(start.getDate() - FRED_WINDOW_PAST_DAYS)
  const end = new Date(now2); end.setDate(end.getDate() + FRED_WINDOW_FUTURE_DAYS)
  const computedEvents = computedReleasesInRange(toDateStr(start), toDateStr(end))

  const events = [...blsEvents, ...fredEvents, ...fomcEvents, ...computedEvents]
  events.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))

  cache = { data: events, fetchedAt: now }
  return events
}

function isDateStr(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
}

// ?from=YYYY-MM-DD&to=YYYY-MM-DD selects an explicit week (the card's
// prev/next buttons use this); omitted or malformed falls back to the
// current week in ET.
export async function GET(req) {
  const { searchParams } = new URL(req.url)
  const fromParam = searchParams.get('from')
  const toParam = searchParams.get('to')
  const { from, to } = isDateStr(fromParam) && isDateStr(toParam)
    ? { from: fromParam, to: toParam }
    : weekRangeOf(todayInET())

  let allEvents
  try {
    allEvents = await loadAllEvents()
  } catch (err) {
    return new Response(JSON.stringify({ error: "Couldn't load the economic calendar — " + err.message }), { status: 502 })
  }

  const events = allEvents.filter((e) => e.date >= from && e.date <= to)
  return new Response(JSON.stringify({ events, from, to }), { status: 200 })
}
