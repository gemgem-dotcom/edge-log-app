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

// { entryInstant, legs, exitInstant } for the fixed window MFE/MAE/drawdown
// are computed over - entry to the *final* exit, not per-leg, per the brief
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
//
// `legs` is each exit's own { price, instant } in order - this raw,
// wall-clock-derived instant is only a rough starting point for
// findFillInstant/deriveFillInstants below, not the final boundary fed
// into computeExcursion; a caller that only needs the coarse window
// (excursionStatusMessage's "Available in ~Xh" estimate) can still just
// read entryInstant/exitInstant and ignore legs entirely.
export function excursionWindow(trade, offsetHours) {
  if (!trade.trade_date || !trade.trade_time || offsetHours === null || offsetHours === undefined || Number.isNaN(offsetHours)) return null

  const entryInstant = wallClockToInstant(trade.trade_date, trade.trade_time, offsetHours)
  if (!entryInstant) return null

  const exitLegs = [
    { price: trade.exit_price, time: trade.exit_time },
    ...(trade.additional_exits || []).map((e) => ({ price: e.exit_price, time: e.exit_time })),
  ].filter((leg) => leg.time)
  if (exitLegs.length === 0) return null

  let currentDate = trade.trade_date
  let currentInstant = entryInstant
  const legs = []
  for (const leg of exitLegs) {
    let instant = wallClockToInstant(currentDate, leg.time, offsetHours)
    if (instant.getTime() < currentInstant.getTime()) {
      currentDate = addOneDay(currentDate)
      instant = wallClockToInstant(currentDate, leg.time, offsetHours)
    }
    currentInstant = instant
    legs.push({ price: leg.price, instant })
  }

  return { entryInstant, legs, exitInstant: legs[legs.length - 1].instant }
}

// How far past the ±1-minute search window (findFillInstant, below) to pad
// a bar fetch - deliberately generous relative to that 1-minute margin, so
// the fetch's own start/end boundary handling (still an open question -
// see lib/databento.js's header) can never be the reason a bar the search
// actually needs gets clipped. Exported so every caller that fetches bars
// for this purpose (the live route, the retry script, the DBN backfill)
// pads by the same amount rather than each guessing its own margin.
export const FILL_SEARCH_PAD_MINUTES = 2

// A bar "touches" a price if that price falls within its high/low range -
// same tolerance convention as lib/tradeMath.js's ADHERENCE_EPSILON (kept
// as a separate constant, not imported, since this module is also
// duplicated into scripts/retry-trade-excursions.js and reimplemented in
// scripts/backfill_trade_excursions_from_dbn.py - see those files' own
// headers for why they can't just import this one).
const FILL_PRICE_EPSILON = 0.0001

function barTouchesPrice(bar, price) {
  return price >= bar.low - FILL_PRICE_EPSILON && price <= bar.high + FILL_PRICE_EPSILON
}

// Databento's ts_event is nanoseconds since the Unix epoch in every schema
// - a core, documented property of the DBN format itself, not the part of
// lib/databento.js's header comment that's actually in question. What *is*
// unconfirmed is which JSON shape the HTTP get_range endpoint renders that
// in - a numeric string (dodging float precision loss on a 19-digit
// integer, the usual reason APIs do this) or a bare number - since nothing
// downstream read tsEvent before this function existed to need it. Handled
// defensively for both; treat this the same "smoke-test before fully
// trusting" way as that file's own end-inclusivity question.
function parseBarInstant(tsEvent) {
  if (tsEvent === null || tsEvent === undefined) return null
  if (typeof tsEvent === 'string' && /^\d+$/.test(tsEvent)) {
    return new Date(Number(BigInt(tsEvent) / 1000000n))
  }
  if (typeof tsEvent === 'number') {
    return new Date(tsEvent / 1e6)
  }
  const parsed = new Date(tsEvent)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function minuteBucketStart(instant, minuteOffset) {
  const bucket = new Date(instant.getTime() + minuteOffset * 60000)
  bucket.setUTCSeconds(0, 0)
  return bucket.getTime()
}

// A trade's logged trade_time/exit_time is only reliably accurate to the
// minute - the seconds field is frequently a TimePicker default (":00"),
// not a real observation (see wallClockToInstant's `ss || 0` and
// components/TimePicker.js's own second-spinner default). Rather than
// trust that logged second as a query boundary at all, this finds the bar
// where price actually touched the real fill level (entry price for the
// entry side, that leg's own exit price for an exit leg) - searching the
// logged minute first, then the minute immediately before and after, in
// that priority order. That's a narrow safety margin for a fill that
// landed right at a minute boundary and got logged rounded to the "wrong"
// side, not license to widen this into a multi-minute scan. `bars` must
// already cover at least [roughInstant - 1min, roughInstant + 2min) -
// FILL_SEARCH_PAD_MINUTES above is the caller's fetch-time margin for
// this, not something this function fetches itself, since it may run
// against one already-fetched set shared across several anchors. Falls
// back to roughInstant itself (matched: false) if no bar in any of the
// three minutes touches price - a genuine miss, not assumed to be this
// function's fault.
export function findFillInstant({ bars, roughInstant, price }) {
  for (const minuteOffset of [0, -1, 1]) {
    const bucketStart = minuteBucketStart(roughInstant, minuteOffset)
    const candidates = bars
      .map((bar) => ({ bar, instant: parseBarInstant(bar.tsEvent) }))
      .filter(({ instant }) => instant && minuteBucketStart(instant, 0) === bucketStart)
      .sort((a, b) => a.instant.getTime() - b.instant.getTime())
    const hit = candidates.find(({ bar }) => barTouchesPrice(bar, price))
    if (hit) return { instant: hit.instant, matched: true }
  }
  return { instant: roughInstant, matched: false }
}

// Runs findFillInstant for the entry and every exit leg of `rawWindow`
// (excursionWindow's return value), in order - each leg gets its own
// derived instant because the final exitInstant is only as accurate as
// the chain that produced it, not just because the final leg matters.
// `bars` is one already-fetched, padded set covering the whole rough
// window (see FILL_SEARCH_PAD_MINUTES) - shared across every anchor
// rather than re-fetched per leg. Returns the derived entry/exit instants
// ready to feed a slice, plus usedFallback: true if entry or any leg
// couldn't be matched to a real bar and fell back to its raw wall-clock
// instant - this needs to stay visible per trade (schema.sql's
// `excursion_fallback` column), since a trade using the fallback still
// carries the original second-level imprecision this whole mechanism
// exists to remove.
export function deriveFillInstants({ rawWindow, entryPrice, bars }) {
  const entryFill = findFillInstant({ bars, roughInstant: rawWindow.entryInstant, price: entryPrice })
  let usedFallback = !entryFill.matched
  let lastInstant = entryFill.instant

  for (const leg of rawWindow.legs) {
    const legFill = findFillInstant({ bars, roughInstant: leg.instant, price: leg.price })
    if (!legFill.matched) usedFallback = true
    lastInstant = legFill.instant
  }

  return { entryInstant: entryFill.instant, exitInstant: lastInstant, usedFallback }
}

// Filters an already-fetched bar set down to [entryInstant, exitInstant]
// inclusive on both ends, using each bar's own parsed timestamp rather
// than trusting a query's start/end semantics for the final slice fed
// into computeExcursion - the derived instants here are always real bar
// timestamps already present in `bars` (or a raw fallback instant, in
// which case this is the same plain range filter the old code effectively
// relied on the query itself to do), so a plain inclusive comparison is
// exact, not an assumption about Databento's own boundary handling.
export function sliceBarsForWindow(bars, entryInstant, exitInstant) {
  return bars.filter((bar) => {
    const instant = parseBarInstant(bar.tsEvent)
    return instant && instant.getTime() >= entryInstant.getTime() && instant.getTime() <= exitInstant.getTime()
  })
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

// "+173.25 pts" / "-11.00 pts" - MFE/MAE are shown in points, not R (unlike
// realized R, they aren't a ratio against risk - see CLAUDE.md's "A point is
// a raw decimal price difference" domain rule). Same two-decimal precision
// as every other point figure on the trade detail page/log table (stop/
// target distance's "pts" sub-value via fmtNum). null when there are no
// points to format.
export function formatExcursionPoints(points) {
  if (points === null || points === undefined) return null
  return (points >= 0 ? '+' : '') + points.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' pts'
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
