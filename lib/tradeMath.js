// Stop/target are entered as a distance (points/ticks) from entry and
// converted to absolute prices here, which is what gets stored in the
// `stop`/`target` columns and what R-multiple is computed from.
export function calcStopPrice(direction, entry, stopDistance) {
  if (entry === null || entry === undefined || stopDistance === null || stopDistance === undefined || Number.isNaN(stopDistance)) {
    return null
  }
  return direction === 'long' ? entry - stopDistance : entry + stopDistance
}

export function calcTargetPrice(direction, entry, targetDistance) {
  if (entry === null || entry === undefined || targetDistance === null || targetDistance === undefined || Number.isNaN(targetDistance)) {
    return null
  }
  return direction === 'long' ? entry + targetDistance : entry - targetDistance
}

// R = reward / risk, where risk is the entry-to-stop distance and reward
// is the entry-to-exit distance, signed so a winning trade is positive
// regardless of direction. Returns null if risk is zero (can't divide).
export function calcRMultiple(direction, entry, stop, exitPrice) {
  const risk = direction === 'long' ? entry - stop : stop - entry
  if (!risk) return null
  const reward = direction === 'long' ? exitPrice - entry : entry - exitPrice
  return reward / risk
}
