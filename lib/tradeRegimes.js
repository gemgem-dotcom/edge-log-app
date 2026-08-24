// Regime bucketing per trade (volatility_regime, volume_regime) - lazily
// computed the next time a trade is read/displayed, never at save time: a
// same-day trade's own session hasn't closed yet, so there's genuinely
// nothing to bucket it against until market_session_stats has a row for
// that date (written by the daily job - see scripts/fetch-daily-market-
// stats.js). Same "backfill on next read" shape as lib/tradeSessions.js's
// backfillOwnTradeSessions, just triggered from app/app/layout.js on every
// app-shell mount instead of once at timezone-set time, since new sessions
// close (and so new rows to backfill against) every trading day rather than
// only once.
//
// NQ only, per §1/§2's scope - a trade on any other instrument (checked via
// its instruments row's data_symbol, the same grouping key
// market_session_stats itself is keyed by) simply never gets these columns
// populated. That's correct, not a bug: same "missing dimension means not
// yet applicable" principle as `session` already follows elsewhere in this
// app.
import { supabase } from './supabaseClient'

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

async function regimesForDate(sessionDate) {
  const ownRow = await statsRowFor(sessionDate)
  if (!ownRow) return null // session not yet closed, or the daily job hasn't run yet
  const trailing = await trailingRowsBefore(sessionDate)
  if (trailing.length === 0) return null // no baseline to compare against yet
  return bucketRegime(ownRow, trailing)
}

// Fire-and-forget from the caller's side, same as backfillOwnTradeSessions -
// nothing on screen is waiting on this to finish. Runs as the signed-in
// user via the normal client (RLS already scopes it to their own trades);
// only touches trades still missing at least one of the two columns, so a
// trade this has already bucketed is never re-written.
export async function backfillTradeRegimes() {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return

  const { data: nqInstruments } = await supabase
    .from('instruments')
    .select('id')
    .eq('user_id', user.id)
    .eq('data_symbol', NQ_DATA_SYMBOL)
  if (!nqInstruments || nqInstruments.length === 0) return

  const { data: trades } = await supabase
    .from('trades')
    .select('id, trade_date')
    .eq('user_id', user.id)
    .in('instrument_id', nqInstruments.map((i) => i.id))
    .or('volatility_regime.is.null,volume_regime.is.null')
  if (!trades || trades.length === 0) return

  // Group by date so every trade logged on the same NQ session shares one
  // pair of market_session_stats lookups instead of repeating them per trade.
  const byDate = {}
  for (const t of trades) {
    if (!byDate[t.trade_date]) byDate[t.trade_date] = []
    byDate[t.trade_date].push(t.id)
  }

  for (const [date, ids] of Object.entries(byDate)) {
    const regimes = await regimesForDate(date)
    if (!regimes) continue
    await supabase.from('trades').update(regimes).in('id', ids)
  }
}
