// MFE/MAE/drawdown - see schema.sql's comment above `mfe_points` for the
// full picture. Pure date-math and calculation here; the actual Databento
// fetch (fetchTrades - tick-level, not ohlcv-1m) lives in lib/databento.js
// (app/api/backfill-trade-excursion/route.js, the server-side path) and is
// duplicated minimally in scripts/retry-trade-excursions.js and
// scripts/recompute-trade-excursions.js (the standalone-script paths - see
// those files' headers for why they can't just import this one).
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

// How far past the trade's own logged times to pad a tick fetch - the
// fill-tick search below isn't bucketed to any interval (real trade prints
// carry their own exact timestamp, unlike a 1-minute bar), so this is
// purely a safety margin for a fill that landed a couple minutes off from
// what got logged. Exported so every caller that fetches ticks for this
// purpose (the live route, the retry script) pads by the same amount
// rather than each guessing its own margin.
export const FILL_SEARCH_PAD_MINUTES = 2

// A trade print "matches" a price within this tolerance - covers float
// round-trip noise from Databento's PRICE_SCALE division and from the
// stored numeric column, not a real difference in price. Kept as a
// separate constant, not imported, since this module is also duplicated
// into scripts/retry-trade-excursions.js and scripts/recompute-trade-
// excursions.js - see those files' own headers for why they can't just
// import this one.
const FILL_PRICE_EPSILON = 0.0001

function tickTouchesPrice(tick, price) {
  return Math.abs(tick.price - price) <= FILL_PRICE_EPSILON
}

// Databento's ts_event is nanoseconds since the Unix epoch in every schema
// - a core, documented property of the DBN format itself. What *was*
// unconfirmed is which JSON shape the HTTP get_range endpoint renders that
// in - a numeric string (dodging float precision loss on a 19-digit
// integer) or a bare number - now confirmed (a numeric string, PR #122).
// Still handled defensively for both, since nothing about the wire format
// is contractually guaranteed.
function parseTickInstant(tsEvent) {
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

// A trade's logged trade_time/exit_time is only reliably accurate to the
// minute - the seconds field is frequently a TimePicker default (":00"),
// not a real observation (see wallClockToInstant's `ss || 0` and
// components/TimePicker.js's own second-spinner default). Rather than
// trust that logged second as a query boundary at all, this finds the real
// trade print that actually touched the fill level (entry price for the
// entry side, that leg's own exit price for an exit leg): the *earliest*
// matching tick within `roughInstant ± FILL_SEARCH_PAD_MINUTES`, further
// constrained to at-or-after `afterInstant` when given (omitted for entry,
// which has no earlier anchor to respect).
//
// Earliest, not closest-in-time to the logged instant: a limit order fills
// the first time price reaches it, and a market/stop order's fill price is
// whatever price was current the instant it triggered - either way, "when
// did this actually happen" is the *first* touch, not whichever touch
// happens to land nearest the trader's necessarily-imprecise logged clock
// time. Picking the closest-in-time touch instead can anchor the window
// after an earlier adverse move already happened and recovered, silently
// understating MAE (even reading exactly 0, or negative once combined with
// a genuine miss elsewhere) - a real trade surfaced exactly this.
//
// The `roughInstant ± pad` bound (not just "earliest anywhere in the whole
// fetch") matters specifically for a leg whose price coincides with an
// earlier anchor's price - most commonly a breakeven trade, where the exit
// price equals the entry price. Without this bound, "earliest match at or
// after the entry fill" would trivially re-match the entry fill's own
// tick (which of course also touches that same price), collapsing the
// whole window to ~0 duration and erasing every minute of real price
// action in between - a real trade surfaced exactly this too. Anchoring
// each leg's search near its *own* logged time instead finds the real,
// later touch.
//
// Falls back to roughInstant itself (matched: false) if nothing in `ticks`
// within that window matches - a genuine miss, not assumed to be this
// function's fault.
export function findFillTick({ ticks, roughInstant, price, afterInstant }) {
  const padMs = FILL_SEARCH_PAD_MINUTES * 60000
  const windowStartMs = Math.max(roughInstant.getTime() - padMs, afterInstant ? afterInstant.getTime() : -Infinity)
  const windowEndMs = roughInstant.getTime() + padMs

  let best = null
  for (const tick of ticks) {
    if (!tickTouchesPrice(tick, price)) continue
    const instant = parseTickInstant(tick.tsEvent)
    if (!instant) continue
    const ms = instant.getTime()
    if (ms < windowStartMs || ms > windowEndMs) continue
    if (!best || ms < best.getTime()) best = instant
  }
  if (best) return { instant: best, matched: true }
  return { instant: roughInstant, matched: false }
}

// Runs findFillTick for the entry and every exit leg of `rawWindow`
// (excursionWindow's return value), in order - each leg gets its own
// derived instant because the final exitInstant is only as accurate as
// the chain that produced it, not just because the final leg matters. Each
// leg's search is constrained to at-or-after the previous anchor's own
// derived instant, so a price level touched more than once (e.g. a stop
// level wicked near before the position even opened) can never match to an
// earlier occurrence than the leg it actually belongs to. `ticks` is one
// already-fetched, padded set covering the whole rough window - shared
// across every anchor rather than re-fetched per leg. Returns the derived
// entry/exit instants ready to feed a slice, plus usedFallback: true if
// entry or any leg couldn't be matched to a real trade print and fell back
// to its raw wall-clock instant - this needs to stay visible per trade
// (schema.sql's `excursion_fallback` column), since a trade using the
// fallback still carries the original second-level imprecision this whole
// mechanism exists to remove.
export function deriveFillTicks({ rawWindow, entryPrice, ticks }) {
  const entryFill = findFillTick({ ticks, roughInstant: rawWindow.entryInstant, price: entryPrice })
  let usedFallback = !entryFill.matched
  let lastInstant = entryFill.instant

  for (const leg of rawWindow.legs) {
    const legFill = findFillTick({ ticks, roughInstant: leg.instant, price: leg.price, afterInstant: lastInstant })
    if (!legFill.matched) usedFallback = true
    lastInstant = legFill.instant
  }

  return { entryInstant: entryFill.instant, exitInstant: lastInstant, usedFallback }
}

// Filters an already-fetched tick set down to [entryInstant, exitInstant]
// inclusive on both ends, sorted chronologically - the derived instants
// here are always real tick timestamps already present in `ticks` (or a
// raw fallback instant, in which case this is the same plain range filter
// the query itself would otherwise need to do), so a plain inclusive
// comparison is exact. Sorted (not just filtered) because computeExcursion
// below walks consecutive ticks in order to total real elapsed drawdown
// time, not just to find a max/min.
export function sliceTicksForWindow(ticks, entryInstant, exitInstant) {
  return ticks
    .map((tick) => ({ ...tick, instant: parseTickInstant(tick.tsEvent) }))
    .filter((tick) => tick.instant && tick.instant.getTime() >= entryInstant.getTime() && tick.instant.getTime() <= exitInstant.getTime())
    .sort((a, b) => a.instant.getTime() - b.instant.getTime())
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

// { mfePoints, maePoints, drawdownSeconds } from real trade prints already
// sliced to [entryInstant, exitInstant] and sorted chronologically
// (sliceTicksForWindow's return value) - direction-aware, raw points (not
// R; see schema.sql's comment on why R isn't stored a second time).
//
// This used to run against 1-minute bars and cap MFE/MAE at the trade's
// own stop/target whenever the final exit leg landed on that level exactly
// - a stop-loss or take-profit order closes a position the instant price
// reaches it, so a bar's high/low could show intra-bar movement beyond
// that level the trade was never actually exposed to. Real trade prints
// don't have that ambiguity in the first place: the true highest/lowest
// price the market actually traded at between entry and exit *is* MFE/MAE,
// no correction needed - and unlike the stop/target-based cap, this
// doesn't depend on trusting `stop`/`target` values that a trader could
// edit at any time, with no record of what they were when the trade was
// actually open.
//
// drawdown-duration walks consecutive ticks in order: the price a trade
// print establishes persists until the next one, so the real elapsed time
// between two consecutive ticks counts toward drawdownSeconds whenever the
// *earlier* tick's price was on the adverse side of entry - genuine
// elapsed time between real prints, not a bar-count multiple.
export function computeExcursion({ ticks, entry, direction }) {
  const prices = ticks.map((t) => t.price)
  const maxPrice = Math.max(...prices)
  const minPrice = Math.min(...prices)

  const mfePoints = direction === 'long' ? maxPrice - entry : entry - minPrice
  const maePoints = direction === 'long' ? entry - minPrice : maxPrice - entry

  let drawdownMs = 0
  for (let i = 0; i < ticks.length - 1; i++) {
    const underwater = direction === 'long' ? ticks[i].price < entry : ticks[i].price > entry
    if (underwater) drawdownMs += ticks[i + 1].instant.getTime() - ticks[i].instant.getTime()
  }

  return { mfePoints, maePoints, drawdownSeconds: Math.round(drawdownMs / 1000) }
}

// Floors an instant down to the start of its own UTC minute (":00.000") -
// the boundary deriveVerifiedTimes searches within, never past.
function floorToMinute(instant) {
  return new Date(Math.floor(instant.getTime() / 60000) * 60000)
}

// Like findFillTick, but bounded to exactly `roughInstant`'s own logged
// minute rather than a ±FILL_SEARCH_PAD_MINUTES window - this is the
// stricter search behind deriveVerifiedTimes below, which exists to
// recover a real *second* within a minute the trader is trusted to have
// logged correctly, not to relabel the minute itself. `afterInstant`
// chains forward the same way findFillTick's does, for the same
// repeated-price-level reason (see that function's comment).
//
// Falls back to the minute's own start (matched: false) if nothing in
// `ticks` within that single minute touches the price - unlike
// findFillTick's fallback to the raw logged instant, there is no
// trustworthy raw second to fall back to here (that's the whole reason
// this search exists), so the caller must treat `matched: false` as "leave
// this field alone, don't write a fabricated value" rather than as a
// usable instant.
export function findVerifiedMinuteFill({ ticks, roughInstant, price, afterInstant }) {
  const minuteStartMs = floorToMinute(roughInstant).getTime()
  const minuteEndMs = minuteStartMs + 59999
  const windowStartMs = Math.max(minuteStartMs, afterInstant ? afterInstant.getTime() : -Infinity)

  let best = null
  for (const tick of ticks) {
    if (!tickTouchesPrice(tick, price)) continue
    const instant = parseTickInstant(tick.tsEvent)
    if (!instant) continue
    const ms = instant.getTime()
    if (ms < windowStartMs || ms > minuteEndMs) continue
    if (!best || ms < best.getTime()) best = instant
  }
  if (best) return { instant: best, matched: true }
  return { instant: new Date(minuteStartMs), matched: false }
}

// Runs findVerifiedMinuteFill for the entry and every exit leg of
// `rawWindow`, chained the same way deriveFillTicks is. Unlike
// deriveFillTicks (which always returns a usable instant, real or
// fallback, for excursion windowing), this is for correcting the trade's
// own logged trade_time/exit_time - a field this couldn't verify must be
// left exactly as logged, not overwritten with a guess. Returns each leg's
// { instant, matched } alongside anyUnverified: true if entry or any leg's
// logged price never actually traded during its own logged minute -
// schema.sql's trade_time_unverified column mirrors this per trade, and is
// shown to the trader (unlike excursion_fallback, which stays
// developer-only) precisely because "leave it alone" means the original,
// possibly-wrong second is still sitting there unverified.
export function deriveVerifiedTimes({ rawWindow, entryPrice, ticks }) {
  const entryFill = findVerifiedMinuteFill({ ticks, roughInstant: rawWindow.entryInstant, price: entryPrice })
  let anyUnverified = !entryFill.matched
  let lastInstant = entryFill.instant

  const legs = []
  for (const leg of rawWindow.legs) {
    const legFill = findVerifiedMinuteFill({ ticks, roughInstant: leg.instant, price: leg.price, afterInstant: lastInstant })
    if (!legFill.matched) anyUnverified = true
    legs.push(legFill)
    lastInstant = legFill.instant
  }

  return { entry: entryFill, legs, anyUnverified }
}

// Inverse of wallClockToInstant, truncating (not rounding) to whole
// seconds - the same precision trade_time/exit_time are stored at. Used to
// turn a verified fill instant back into the "HH:MM:SS" string those
// columns hold; the minute component always matches what was already
// logged by construction (findVerifiedMinuteFill never returns an instant
// outside its own search minute), so this only ever changes the seconds.
export function instantToWallClockTime(instant, offsetHours) {
  const local = new Date(instant.getTime() + offsetHours * 3600000)
  const hh = String(local.getUTCHours()).padStart(2, '0')
  const mm = String(local.getUTCMinutes()).padStart(2, '0')
  const ss = String(local.getUTCSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

// "173.25 pts" / "-11.00 pts" - MFE/MAE are shown in points, not R (unlike
// realized R, they aren't a ratio against risk - see CLAUDE.md's "A point is
// a raw decimal price difference" domain rule). No leading "+" for a
// non-negative value (unlike realized R's pill) - MFE/MAE aren't a gain/loss
// sign to emphasize, just a magnitude; toLocaleString already supplies "-"
// for a genuinely negative one. Same two-decimal precision as every other
// point figure on the trade detail page/log table (stop/target distance's
// "pts" sub-value via fmtNum). null when there are no points to format.
// Shared by the trade detail page and the log table's expand row so the
// wording can't drift between the two places MFE/MAE are shown.
export const MFE_HINT = 'Maximum Favourable Excursion - the most this trade moved in your favour before it closed.'
export const MAE_HINT = 'Maximum Adverse Excursion - the most this trade moved against you before it closed.'

export function formatExcursionPoints(points) {
  if (points === null || points === undefined) return null
  return points.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' pts'
}

// The message to show in place of a real MFE/MAE/drawdown value, for every
// case other than a genuinely fill-verified 'complete' trade (the caller
// renders the real numbers itself in that case). Shared by the trade
// detail page and the trade log table's expand row so the four states
// can't drift between the two places they're shown. Returns null for a
// null/undefined status (no attempt has ever been made, or the trade isn't
// NQ-family) - the caller's existing plain "—" fallback already covers
// that, same "not yet applicable" principle as every other nullable
// dimension in this app, not a fifth message to maintain here.
//
// 'complete' with excursion_fallback true means the fill-tick search
// couldn't verify entry or an exit leg against a real trade print and fell
// back to the raw logged instant - the MFE/MAE/drawdown computed from that
// window can be badly wrong, not just imprecise (a real trade showed a
// physically-impossible MAE bigger than its own stop distance this way).
// Rather than display a concrete-looking number that might be nonsense,
// this is now treated the same as "not verified" everywhere else.
export function excursionStatusMessage(trade, offsetHours, now = new Date()) {
  if (trade.market_data_status === 'unavailable') return 'Not available for this trade'
  if (trade.market_data_status === 'pending') {
    const window = excursionWindow(trade, offsetHours)
    if (!window) return 'Available soon'
    const hours = hoursUntilEmbargoClears(window.exitInstant, now)
    return `Available in ~${hours}h`
  }
  if (trade.market_data_status === 'complete' && trade.excursion_fallback) return 'Unverified'
  return null
}
