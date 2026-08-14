// Stop/target are entered as a distance in points from entry and converted
// to absolute prices here, which is what gets stored in the `stop`/`target`
// columns and what R-multiple is computed from. A "point" is a raw decimal
// price difference for every instrument — see lib/instrumentCatalog.js.
export function calcStopPrice(direction, entry, stopDistance) {
  if (!isNum(entry) || !isNum(stopDistance)) return null
  return direction === 'long' ? entry - stopDistance : entry + stopDistance
}

export function calcTargetPrice(direction, entry, targetDistance) {
  if (!isNum(entry) || !isNum(targetDistance)) return null
  return direction === 'long' ? entry + targetDistance : entry - targetDistance
}

// Planned risk-to-reward: the R-multiple this trade would print if price
// reached the take profit. Deliberately routed through the same
// calcStopPrice/calcTargetPrice/calcRMultiple path that produces the stored
// r_multiple, so the number on the form can never drift from the platform's
// R math. Display only — nothing derived here is persisted.
//
// Entry and direction cancel out of the ratio (it reduces to
// targetDistance / stopDistance), so a zero placeholder entry gives the
// correct figure while the entry price field is still empty.
export function calcRiskReward(targetDistance, stopDistance, direction = 'long', entry = 0) {
  if (!isNum(targetDistance) || !isNum(stopDistance) || stopDistance <= 0) return null
  const base = isNum(entry) ? entry : 0
  const stopPrice = calcStopPrice(direction, base, stopDistance)
  const targetPrice = calcTargetPrice(direction, base, targetDistance)
  return calcRMultiple(direction, base, stopPrice, targetPrice)
}

// Dollar P&L for a closed trade. point_value comes from the instrument
// catalog and is the dollar move of one contract per 1.00 of price.
// Returns null when any input is missing, so the caller can leave the
// field alone rather than filling in a misleading zero.
export function calcProfitLoss(direction, entry, exitPrice, contracts, pointValue) {
  if (!isNum(entry) || !isNum(exitPrice) || !isNum(contracts) || !isNum(pointValue)) return null
  const sign = direction === 'long' ? 1 : -1
  return (exitPrice - entry) * pointValue * contracts * sign
}

// R = reward / risk, where risk is the entry-to-stop distance and reward is
// the entry-to-exit distance, signed so a winning trade is positive in
// either direction. Returns null when the trade has no exit price yet (an
// open trade has no result) or when risk is zero.
export function calcRMultiple(direction, entry, stop, exitPrice) {
  if (!isNum(entry) || !isNum(stop) || !isNum(exitPrice)) return null
  const risk = direction === 'long' ? entry - stop : stop - entry
  if (!risk) return null
  const reward = direction === 'long' ? exitPrice - entry : entry - exitPrice
  return reward / risk
}

// A trade only has a result once it has been exited. Stats that average or
// total R must skip open trades rather than counting them as breakeven.
export function hasResult(trade) {
  return trade.r_multiple !== null && trade.r_multiple !== undefined
}

// Below this tolerance, a typed exit price is treated as "at" a stop/target/
// entry level - covers float roundtrip noise from the entry +/- distance
// arithmetic in calcStopPrice/calcTargetPrice, not user-facing rounding.
const ADHERENCE_EPSILON = 0.0001

// Whether the trade's actual exit followed the plan. Directional rather than
// an exact price match: closing at or past the target (in the profit
// direction) counts as reaching it even if price ran further; closing at or
// past the stop (in the loss direction) counts as the stop being hit even
// through slippage that fills worse than the calculated price. An exit back
// at entry is a breakeven scratch. Anything strictly between the two
// boundaries is a discretionary deviation - the trader closed before either
// plan level was reached. Returns null for an open trade, so callers can
// render a neutral state rather than a false "deviated".
export function planAdherence(trade) {
  if (!isNum(trade.exit_price) || !isNum(trade.stop) || !isNum(trade.entry) || !trade.direction) return null
  const dir = trade.direction === 'long' ? 1 : -1
  if (isNum(trade.target) && dir * (trade.exit_price - trade.target) >= -ADHERENCE_EPSILON) return 'target'
  if (dir * (trade.exit_price - trade.stop) <= ADHERENCE_EPSILON) return 'stop'
  if (Math.abs(trade.exit_price - trade.entry) < ADHERENCE_EPSILON) return 'breakeven'
  return 'deviated'
}

// Minutes from entry to exit, wrapping past midnight so a session that
// crosses the day boundary doesn't come out negative. Null when the trade
// has no exit time to measure to.
export function tradeDurationMinutes(trade) {
  if (!trade.trade_time || !trade.exit_time) return null
  const diff = timeToMinutes(trade.exit_time) - timeToMinutes(trade.trade_time)
  return diff < 0 ? diff + 24 * 60 : diff
}

export function formatDuration(mins) {
  if (mins === null || mins === undefined) return '—'
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return `${h}h ${m}m`
}

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

// trade_time/exit_time are stored 24-hour ("HH:MM" or "HH:MM:SS", trades
// logged before seconds were tracked have no third segment) - this is
// display only, matching the 12-hour + AM/PM convention TimePicker's own
// popup uses, independent of whatever format the native input rendered
// while it was actually being typed into.
export function formatTime12h(value) {
  if (!value) return '—'
  const [h, m, s] = value.split(':').map(Number)
  if (Number.isNaN(h) || Number.isNaN(m)) return '—'
  const pad = (n) => String(n).padStart(2, '0')
  const period = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${pad(h12)}:${pad(m)}:${pad(Number.isFinite(s) ? s : 0)} ${period}`
}

function isNum(v) {
  return v !== null && v !== undefined && !Number.isNaN(v)
}
