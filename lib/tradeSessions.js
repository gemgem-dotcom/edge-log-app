// Labels a logged trade with which named trading session (see
// lib/marketHours.js's sessionFor - London session, US pre-market, New
// York AM, Midday lull, New York PM, Asian session) it was opened in, plus
// every other session boundary it crossed before it closed. Computed once
// at write time (app/[instrument]/log/new and .../edit's onSubmit) and
// stored on the trade row as `session`/`continued_sessions` - hidden
// metadata for future session-based analytics, no page reads it back yet.
//
// trade_date/trade_time are a plain wall-clock reading with no timezone of
// their own (see schema.sql's comment on shift_trade_times) - the
// account's saved UTC offset (or, if it's never been explicitly set, the
// trader's own browser offset at the moment they log the trade - see
// lib/timezone.js's browserOffsetGuess) is what that clock currently means,
// and is what turns it into a real instant convertible to ET.
import { supabase } from '@/lib/supabaseClient'
import { easternParts, sessionFor } from './marketHours'
import { tradeDurationMinutes } from './tradeMath'
import { browserOffsetGuess } from './timezone'

// Exported so lib/tradeExcursions.js can share this instead of a second
// copy - both need the same "trade_date/trade_time is a wall-clock reading
// that only becomes a real instant once combined with the account's UTC
// offset" conversion.
export function wallClockToInstant(dateStr, timeStr, offsetHours) {
  if (!dateStr || !timeStr) return null
  const [y, mo, d] = dateStr.split('-').map(Number)
  const [hh, mm, ss] = timeStr.split(':').map(Number)
  // Treat the wall-clock numbers as if they were themselves UTC, then
  // subtract the offset to recover the real UTC instant: local = UTC +
  // offset, so UTC = local - offset.
  return new Date(Date.UTC(y, mo - 1, d, hh, mm, ss || 0) - offsetHours * 3600000)
}

// { session, continuedSessions }. continuedSessions is always [] for a
// trade with no exit_time recorded - duration (and so whether it crossed
// into another session at all) can't be known without one. Walks the
// trade's duration minute by minute re-deriving the real ET wall-clock
// time at each step (rather than just adding minutes to the entry
// session's own minute-of-day) so a trade that happens to span a DST
// transition still lands in the right session - duration is always under
// 24h (tradeDurationMinutes wraps past midnight), so this is at most
// ~1439 cheap iterations, not an unbounded loop.
export function computeTradeSessions(trade, timezoneOffsetHours) {
  const entryInstant = wallClockToInstant(trade.trade_date, trade.trade_time, timezoneOffsetHours)
  if (!entryInstant) return { session: null, continuedSessions: [] }

  const session = sessionFor(easternParts(entryInstant).minutesOfDay)
  const duration = tradeDurationMinutes(trade)
  if (!duration) return { session, continuedSessions: [] }

  const continuedSessions = []
  let last = session
  for (let m = 1; m <= duration; m++) {
    const label = sessionFor(easternParts(new Date(entryInstant.getTime() + m * 60000)).minutesOfDay)
    if (label !== last) {
      continuedSessions.push(label)
      last = label
    }
  }
  return { session, continuedSessions }
}

// Recomputes session/continued_sessions for every trade the signed-in
// trader owns, using their real saved timezone - called from
// TimezoneGate right after they confirm one (see app/app/layout.js). The
// one-time SQL backfill in schema.sql has no browser to fall back to for a
// trader who'd never set a timezone before that point, so it defaults
// those trades to UTC+0; this corrects them for real the moment the
// trader actually has an offset on record, using the exact same logic new
// trades get. Runs as the signed-in user via the normal client (not a
// service role), so RLS already limits it to their own rows - nothing
// else needs to filter by user_id here. Fire-and-forget from the caller's
// side: nothing in the UI is waiting on this to finish.
export async function backfillOwnTradeSessions() {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return
  const timezoneOffset = parseFloat(user.user_metadata?.timezone ?? browserOffsetGuess())

  const { data: trades, error } = await supabase
    .from('trades')
    .select('id, trade_date, trade_time, exit_time')
    .eq('user_id', user.id)
  if (error || !trades) return

  for (const t of trades) {
    const { session, continuedSessions } = computeTradeSessions(t, timezoneOffset)
    await supabase.from('trades').update({ session, continued_sessions: continuedSessions }).eq('id', t.id)
  }
}
