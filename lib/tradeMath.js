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

// Flags how much weight a trader should put on a win-rate/expectancy figure
// derived from n closed trades. Thresholds are deliberately coarse - this
// isn't a statistical significance test, it's a gut-check against reading a
// real pattern into what's still noise. Used anywhere win rate, expectancy,
// or profit factor is shown, so a 4-trade "strategy" doesn't look as
// trustworthy on screen as a 400-trade one.
export function sampleConfidence(n) {
  if (n < 20) return { tier: 'low', label: 'Too early to tell' }
  if (n < 50) return { tier: 'medium', label: 'Early signal' }
  return { tier: 'high', label: 'Enough to trust' }
}

// A trade only has a result once it has been exited. Stats that average or
// total R must skip open trades rather than counting them as breakeven.
export function hasResult(trade) {
  return trade.r_multiple !== null && trade.r_multiple !== undefined
}

// The four day-trading sessions a trade's entry time can fall into, in ET.
// NY and RTH are the same window for this purpose, so there are four
// buckets, not five: Asia 6pm-3am, London 3am-9:30am, RTH 9:30am-4pm,
// Overnight 4pm-6pm - together covering the full 24h cycle with no gaps.
export const SESSION_TAGS = ['Asia', 'London', 'RTH', 'Overnight']

// Computed, not stored. trade_date/trade_time are a plain wall-clock value
// with no timezone of their own - the account page's UTC offset (see
// lib/timezone.js) is the only thing that says what instant that clock
// meant. Reconstructing the instant and re-reading it in America/New_York
// via Intl.DateTimeFormat (rather than hand-rolled offset math) makes the
// session boundary DST-aware for free.
export function sessionFor(tradeDate, tradeTime, offset) {
  if (!tradeDate || !tradeTime) return null
  const [y, m, d] = tradeDate.split('-').map(Number)
  const [hh, mm, ss] = tradeTime.split(':').map(Number)
  const offsetHours = Number(offset)
  const validOffset = Number.isFinite(offsetHours) ? offsetHours : 0
  const naiveUtcMs = Date.UTC(y, m - 1, d, hh, mm || 0, ss || 0)
  const instant = new Date(naiveUtcMs - validOffset * 3600000)

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(instant)
  const etHour = Number(parts.find((p) => p.type === 'hour').value) % 24
  const etMinute = Number(parts.find((p) => p.type === 'minute').value)
  const minutesOfDay = etHour * 60 + etMinute

  if (minutesOfDay >= 18 * 60 || minutesOfDay < 3 * 60) return 'Asia'
  if (minutesOfDay < 9 * 60 + 30) return 'London'
  if (minutesOfDay < 16 * 60) return 'RTH'
  return 'Overnight'
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

function isNum(v) {
  return v !== null && v !== undefined && !Number.isNaN(v)
}
