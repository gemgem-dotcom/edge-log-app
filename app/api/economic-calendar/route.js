import { FOMC_STATEMENT_DATES_2026, FOMC_STATEMENT_TIME } from '@/lib/fomcDates'

// No API key needed: BLS publishes this iCalendar feed for exactly this
// purpose (external subscription in Outlook/Google Calendar/etc.), unlike
// the paywalled Finnhub/FMP endpoints this route was originally built
// against, or CME's own calendar (explicitly prohibits automated
// collection/redistribution in their Terms of Use - see git history for
// that dead end). It's U.S. government data with no comparable
// restriction, and it's schedule-only - no actual/forecast/previous
// values - which matches what this card actually needs.
const BLS_ICS_URL = 'https://www.bls.gov/schedule/news_release/bls.ics'

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

// Module-level cache: BLS's release calendar changes rarely (new dates get
// added a few times a year, not daily), so a several-hour TTL is plenty -
// this just avoids re-fetching and re-parsing the whole feed on every
// dashboard load.
let cache = { key: null, data: null, fetchedAt: 0 }
const CACHE_TTL_MS = 6 * 60 * 60 * 1000

function pad(n) {
  return String(n).padStart(2, '0')
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
  const fmt = (x) => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`
  return { from: fmt(monday), to: fmt(sunday) }
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

export async function GET() {
  const today = todayInET()
  const { from, to } = weekRangeOf(today)
  const cacheKey = `${from}_${to}`
  const now = Date.now()
  if (cache.key === cacheKey && now - cache.fetchedAt < CACHE_TTL_MS) {
    return new Response(JSON.stringify({ events: cache.data, from, to }), { status: 200 })
  }

  let events
  try {
    const res = await fetch(BLS_ICS_URL)
    if (!res.ok) throw new Error(`BLS returned ${res.status}`)
    const text = await res.text()
    const raw = parseBlsIcs(text)

    events = raw
      .filter((e) => e.date >= from && e.date <= to)
      .map((e) => ({
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

    FOMC_STATEMENT_DATES_2026
      .filter((date) => date >= from && date <= to)
      .forEach((date) => {
        events.push({
          date, time: FOMC_STATEMENT_TIME, country: 'US', event: 'FOMC Statement',
          impact: 'high', actual: null, estimate: null, prev: null, unit: '',
        })
      })

    events.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
  } catch (err) {
    return new Response(JSON.stringify({ error: "Couldn't load the economic calendar — " + err.message }), { status: 502 })
  }

  cache = { key: cacheKey, data: events, fetchedAt: now }
  return new Response(JSON.stringify({ events, from, to }), { status: 200 })
}
