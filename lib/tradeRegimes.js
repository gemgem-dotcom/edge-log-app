// Regime bucketing per trade (volatility_regime, volume_regime).
//
// Computed at save time where possible, same as lib/tradeSessions.js's
// session/continued_sessions - app/app/[instrument]/log/new and .../edit's
// onSubmit call regimesForDate(trade_date) right alongside
// computeTradeSessions. That only succeeds for a trade whose session has
// already closed and been picked up by the daily job (scripts/fetch-daily-
// market-stats.js) - a same-day trade's own session hasn't closed yet, so
// there's genuinely nothing to bucket it against, and regimesForDate
// returns null (the caller then omits both columns from the insert/update,
// leaving them null rather than clobbering anything).
//
// The other half: scripts/fetch-daily-market-stats.js itself backfills
// every trade dated the session it just fetched, across every user, right
// after writing that day's market_session_stats row - the moment a date's
// regime becomes computable at all, it's already applied everywhere it's
// needed, rather than waiting for each trader to individually reopen the
// app before their own trades catch up. See that script's own comment for
// why this couldn't just import bucketRegime from here instead of
// duplicating the small amount of math involved.
//
// NQ only, per §1/§2's scope - a trade on any other instrument (checked via
// its instruments row's data_symbol, the same grouping key
// market_session_stats itself is keyed by) simply never gets these columns
// populated. That's correct, not a bug: same "missing dimension means not
// yet applicable" principle as `session` already follows elsewhere in this
// app.
import { supabase } from '@/lib/supabaseClient'

const NQ_DATA_SYMBOL = 'NQ'
const TRAILING_WINDOW = 20

// No existing methodology to reuse here despite the brief's assumption -
// the Overview pages' "vs. typical" range/volume cards (components/
// OverviewDashboard.js, app/app/[instrument]/dashboard/page.js) are pure
// "Needs Phase 2" placeholders with no real algorithm behind them yet. This
// +/-15% banding is this module's own choice, not a port of an existing one.
const HIGH_RATIO = 1.15
const LOW_RATIO = 0.85

function bucketFor(value, average) {
  if (!average) return 'normal'
  const ratio = value / average
  if (ratio >= HIGH_RATIO) return 'high'
  if (ratio <= LOW_RATIO) return 'low'
  return 'normal'
}

// Pure - given one day's own market_session_stats row and the (already
// fetched) trailing rows before it, buckets both dimensions. Exported
// separately from the Supabase-fetching code below so §5's "most recent
// closed session" lookup (lib/todaysBrief.js) can reuse the exact same
// bucketing math against a differently-sourced pair of rows, rather than a
// second copy of this formula.
export function bucketRegime(ownRow, trailingRows) {
  if (!ownRow || !trailingRows || trailingRows.length === 0) {
    return { volatility_regime: null, volume_regime: null }
  }
  const avgRange = trailingRows.reduce((s, r) => s + r.total_range, 0) / trailingRows.length
  const avgVolume = trailingRows.reduce((s, r) => s + r.total_volume, 0) / trailingRows.length
  return {
    volatility_regime: bucketFor(ownRow.total_range, avgRange),
    volume_regime: bucketFor(ownRow.total_volume, avgVolume),
  }
}

// { total_range, total_volume } for one session_date, or null if the daily
// job hasn't stored that day yet.
async function statsRowFor(sessionDate) {
  const { data } = await supabase
    .from('market_session_stats')
    .select('total_range, total_volume')
    .eq('data_symbol', NQ_DATA_SYMBOL)
    .eq('session_date', sessionDate)
    .maybeSingle()
  return data
}

async function trailingRowsBefore(sessionDate) {
  const { data } = await supabase
    .from('market_session_stats')
    .select('total_range, total_volume')
    .eq('data_symbol', NQ_DATA_SYMBOL)
    .lt('session_date', sessionDate)
    .order('session_date', { ascending: false })
    .limit(TRAILING_WINDOW)
  return data || []
}

// null if the date's session hasn't closed yet, or the daily job hasn't
// picked it up yet - the caller (log/new, log/edit's onSubmit) treats that
// as "leave volatility_regime/volume_regime out of this write", not as an
// error, so a trade logged same-day just stays unbucketed until the daily
// job's own backfill (scripts/fetch-daily-market-stats.js) reaches it.
export async function regimesForDate(sessionDate) {
  const ownRow = await statsRowFor(sessionDate)
  if (!ownRow) return null // session not yet closed, or the daily job hasn't run yet
  const trailing = await trailingRowsBefore(sessionDate)
  if (trailing.length === 0) return null // no baseline to compare against yet
  return bucketRegime(ownRow, trailing)
}
