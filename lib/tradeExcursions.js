// MFE/MAE/drawdown - see schema.sql's comment above `mfe_points` for the
// full picture. Pure date-math and calculation here; the actual Databento
// fetch lives in lib/databento.js (app/api/backfill-trade-excursion/
// route.js, the server-side path) and is duplicated minimally in
// scripts/retry-trade-excursions.js (the standalone-script path - see that
// file's header for why it can't just import this one).
import { wallClockToInstant } from './tradeSessions'

// This account's confirmed access embargo on Databento's GLBX.MDP3 feed -
// discovered live while debugging the daily market-stats job (two
// requests, hours apart, both rejected with available_end landing exactly
// 8 hours behind wall-clock time). Not a bug to route around: a trade
// closed more recently than this simply has no accessible bar data yet.
export const EMBARGO_HOURS = 8

function addOneDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + 1)
  return dt.toISOString().slice(0, 10)
}

// { entryInstant, exitInstant } for the fixed window MFE/MAE/drawdown are
// computed over - entry to the *final* exit, not per-leg, per the brief
// this shipped under. Walks the primary exit and then each additional_exits
// entry (components/TradeForm.js's multi-exit rows) in listed order,
// rolling to the next calendar day whenever an exit's clock time is
// earlier than the previous instant's - the same "day starts wherever the
// trade actually continues" rule tradeDurationMinutes uses for a single
// exit, extended to a chain for a multi-exit trade. Returns null if there's
// no timezone offset to convert with, or no exit at all yet (an open
// trade never reaches this code path in practice - trades are only logged
// after they've closed - but this guards the case defensively rather than
// computing a bogus window).
export function excursionWindow(trade, offsetHours) {
  if (!trade.trade_date || !trade.trade_time || offsetHours === null || offsetHours === undefined || Number.isNaN(offsetHours)) return null

  const entryInstant = wallClockToInstant(trade.trade_date, trade.trade_time, offsetHours)
  if (!entryInstant) return null

  const exitTimes = [
    trade.exit_time,
    ...(trade.additional_exits || []).map((e) => e.exit_time),
  ].filter(Boolean)
  if (exitTimes.length === 0) return null

  let currentDate = trade.trade_date
  let currentInstant = entryInstant
  let exitInstant = entryInstant
  for (const exitTime of exitTimes) {
    let instant = wallClockToInstant(currentDate, exitTime, offsetHours)
    if (instant.getTime() < currentInstant.getTime()) {
      currentDate = addOneDay(currentDate)
      instant = wallClockToInstant(currentDate, exitTime, offsetHours)
    }
    currentInstant = instant
    exitInstant = instant
  }

  return { entryInstant, exitInstant }
}

// The instant this trade's embargo actually clears - used both to decide
// whether a 'pending' trade is ready to retry (scripts/retry-trade-
// excursions.js) and to show "Available in ~Xh" while it isn't (the trade
// detail page/log table, computed at render time rather than stored, so it
// never drifts from "now").
export function embargoClearInstant(exitInstant) {
  return new Date(exitInstant.getTime() + EMBARGO_HOURS * 3600000)
}

// Whole hours remaining until embargoClearInstant, floored at 1 so a trade
// that clears in 20 minutes still reads "~1h" rather than a confusing
// "~0h" (which would look identical to "ready now").
export function hoursUntilEmbargoClears(exitInstant, now = new Date()) {
  const remainingMs = embargoClearInstant(exitInstant).getTime() - now.getTime()
  return Math.max(1, Math.ceil(remainingMs / 3600000))
}

// Databento's HTTP error responses for an embargoed request carry one of
// these two `"case"` values in the JSON body (confirmed against two real
// live rejections, not assumed) - lib/databento.js's fetchOhlcv1m throws an
// Error whose message includes the raw response body verbatim, so a plain
// substring check is enough without re-parsing JSON out of an error message.
export function isEmbargoError(err) {
  const msg = err?.message || ''
  return msg.includes('dataset_unavailable_range') || msg.includes('data_end_after_available_end')
}

const BAR_SECONDS = 60 // ohlcv-1m

// { mfePoints, maePoints, drawdownSeconds } from bars already sliced to
// [entryInstant, exitInstant] - direction-aware, raw points (not R; see
// schema.sql's comment on why R isn't stored a second time). MFE/MAE use
// each bar's high/low (the same "did price reach this level" methodology
// as everywhere else this app derives excursion-like figures), and
// drawdown-duration reuses that same high/low test per bar rather than a
// closes-only approximation: a bar counts as underwater if its adverse-side
// extreme crossed past entry at any point in that minute. That resolves
// duration to the bar's own 60-second granularity, not true tick-level
// precision - the best honestly available from minute bars - and sums
// every separate underwater run of bars, not just the first.
export function computeExcursion({ bars, entry, direction }) {
  const highs = bars.map((b) => b.high)
  const lows = bars.map((b) => b.low)
  const maxHigh = Math.max(...highs)
  const minLow = Math.min(...lows)

  const mfePoints = direction === 'long' ? maxHigh - entry : entry - minLow
  const maePoints = direction === 'long' ? entry - minLow : maxHigh - entry

  let underwaterBars = 0
  for (const bar of bars) {
    const underwater = direction === 'long' ? bar.low < entry : bar.high > entry
    if (underwater) underwaterBars += 1
  }

  return { mfePoints, maePoints, drawdownSeconds: underwaterBars * BAR_SECONDS }
}

// "+1.85R" / "-0.42R" - same sign/precision/suffix convention the trade
// detail page and log table already use for realized R, so MFE/MAE read
// as the same kind of number rather than a differently-formatted one.
// null when there's nothing to divide by (no stop distance) or no points.
export function formatExcursionR(points, stopDistance) {
  if (points === null || points === undefined || !stopDistance) return null
  const r = points / stopDistance
  return (r >= 0 ? '+' : '') + r.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + 'R'
}

// The message to show in place of a real MFE/MAE/drawdown value, for every
// market_data_status other than 'complete' (the caller renders the real
// numbers itself in that case). Shared by the trade detail page and the
// trade log table's expand row so the three states can't drift between the
// two places they're shown. Returns null for a null/undefined status (no
// attempt has ever been made, or the trade isn't NQ-family) - the caller's
// existing plain "—" fallback already covers that, same "not yet
// applicable" principle as every other nullable dimension in this app, not
// a fourth message to maintain here.
export function excursionStatusMessage(trade, offsetHours, now = new Date()) {
  if (trade.market_data_status === 'unavailable') return 'Not available for this trade'
  if (trade.market_data_status === 'pending') {
    const window = excursionWindow(trade, offsetHours)
    if (!window) return 'Available soon'
    const hours = hoursUntilEmbargoClears(window.exitInstant, now)
    return `Available in ~${hours}h`
  }
  return null
}
