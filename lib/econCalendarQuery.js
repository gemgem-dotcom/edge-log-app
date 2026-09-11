import { supabase } from '@/lib/supabaseClient'
import { fetchAllRows } from '@/lib/fetchAllRows'

// Reads the economic_events rows scripts/fetch-economic-calendar.js
// stores. Signed-in read only - the table's RLS policy allows select to
// any authenticated user and nothing else (see schema.sql); every write
// comes from the scheduled job holding the service-role key.
//
// `fromDateStr`/`toDateStr` are plain YYYY-MM-DD calendar days in the
// visitor's own timezone, which is how the card's date-range picker thinks
// about them. They're widened here to the instants that bound those local
// days before hitting the query, because event_time is a timestamptz: a
// London trader asking for "Friday" and a Chicago trader asking for
// "Friday" genuinely want different six-hour-offset windows, and comparing
// a UTC instant against a bare date string would give one of them the
// wrong end of the day.
//
// Paged through fetchAllRows rather than issued as a single select:
// PostgREST caps an unpaged response at 1000 rows, and a busy 90-day range
// across all nine currencies is comfortably past that. Truncating there
// would look like "the back half of the range has no events" rather than
// an error - the same silent-truncation trap that the rest of this app's
// queries were audited for.
export async function fetchEconomicEvents(fromDateStr, toDateStr) {
  // The two <input type="date"> fields don't enforce order, so accept
  // either direction rather than returning a confusing empty range.
  let from = fromDateStr
  let to = toDateStr
  if (from > to) { const t = from; from = to; to = t }

  const start = new Date(`${from}T00:00:00`)
  const end = new Date(`${to}T23:59:59.999`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return { data: [], error: null }
  }

  return fetchAllRows((rangeFrom, rangeTo) => supabase
    .from('economic_events')
    .select('*')
    .gte('event_time', start.toISOString())
    .lte('event_time', end.toISOString())
    // event_key as the final tiebreak so page boundaries are stable -
    // several releases genuinely share one timestamp (08:30 ET is half a
    // dozen prints at once), and an unstable order across pages can drop
    // or repeat one at the boundary.
    .order('event_time', { ascending: true })
    .order('event_key', { ascending: true })
    .range(rangeFrom, rangeTo))
}
