// Server only: FINNHUB_API_KEY never reaches the browser. This is reference
// data (not user data), so the route needs no auth check of its own - it's
// only ever rendered inside the authenticated app shell.
//
// Module-level cache rather than a database table: Finnhub's free tier rate
// limit is generous enough that a per-instance in-memory cache is all this
// needs, and it resets naturally on cold start.
let cache = { key: null, data: null, fetchedAt: 0 }
const CACHE_TTL_MS = 30 * 60 * 1000

function pad(n) {
  return String(n).padStart(2, '0')
}

function toDateStr(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

// Monday through Sunday of the current UTC week - the calendar shows "this
// week" as one fixed block rather than a rolling 7 days.
function thisWeekRange() {
  const now = new Date()
  const day = now.getUTCDay()
  const monday = new Date(now)
  monday.setUTCDate(now.getUTCDate() + (day === 0 ? -6 : 1 - day))
  const sunday = new Date(monday)
  sunday.setUTCDate(monday.getUTCDate() + 6)
  return { from: toDateStr(monday), to: toDateStr(sunday) }
}

export async function GET() {
  const apiKey = process.env.FINNHUB_API_KEY
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Economic calendar is not configured yet - FINNHUB_API_KEY is missing.' }), { status: 501 })
  }

  const { from, to } = thisWeekRange()
  const cacheKey = `${from}_${to}`
  const now = Date.now()
  if (cache.key === cacheKey && now - cache.fetchedAt < CACHE_TTL_MS) {
    return new Response(JSON.stringify({ events: cache.data, from, to }), { status: 200 })
  }

  let events
  try {
    const res = await fetch(`https://finnhub.io/api/v1/calendar/economic?from=${from}&to=${to}&token=${apiKey}`)
    if (!res.ok) throw new Error(`Finnhub returned ${res.status}`)
    const data = await res.json()
    const raw = Array.isArray(data?.economicCalendar) ? data.economicCalendar : []

    events = raw
      .map((e) => ({
        date: (e.time || '').slice(0, 10),
        time: (e.time || '').slice(11, 16),
        country: e.country || '—',
        event: e.event || 'Event',
        impact: (e.impact || 'low').toLowerCase(),
        actual: e.actual ?? null,
        estimate: e.estimate ?? null,
        prev: e.prev ?? null,
        unit: e.unit || '',
      }))
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
  } catch (err) {
    return new Response(JSON.stringify({ error: "Couldn't load the economic calendar — " + err.message }), { status: 502 })
  }

  cache = { key: cacheKey, data: events, fetchedAt: now }
  return new Response(JSON.stringify({ events, from, to }), { status: 200 })
}
