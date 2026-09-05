import { describe, it, expect } from 'vitest'
import {
  calcStopPrice,
  calcTargetPrice,
  calcPointsFromExitPrice,
  calcRiskReward,
  calcProfitLoss,
  calcMultiExitProfitLoss,
  calcRMultiple,
  calcBlendedRMultiple,
  hasResult,
  tradeDurationMinutes,
  formatDuration,
  formatTime12h,
} from './tradeMath'

describe('calcStopPrice / calcTargetPrice', () => {
  it('subtracts distance from entry for a long stop, adds for a long target', () => {
    expect(calcStopPrice('long', 21050, 15)).toBe(21035)
    expect(calcTargetPrice('long', 21050, 30)).toBe(21080)
  })

  it('adds distance from entry for a short stop, subtracts for a short target', () => {
    expect(calcStopPrice('short', 21050, 15)).toBe(21065)
    expect(calcTargetPrice('short', 21050, 30)).toBe(21020)
  })

  it('returns null on a missing input rather than NaN', () => {
    expect(calcStopPrice('long', null, 15)).toBeNull()
    expect(calcTargetPrice('long', 21050, undefined)).toBeNull()
  })
})

describe('calcPointsFromExitPrice', () => {
  it('is positive for a long that exited above entry, negative below', () => {
    expect(calcPointsFromExitPrice('long', 100, 110)).toBe(10)
    expect(calcPointsFromExitPrice('long', 100, 90)).toBe(-10)
  })

  it('is positive for a short that exited below entry, negative above', () => {
    expect(calcPointsFromExitPrice('short', 100, 90)).toBe(10)
    expect(calcPointsFromExitPrice('short', 100, 110)).toBe(-10)
  })
})

describe('calcRMultiple', () => {
  it('is the classic worked example: entry 1000, stop 950, exit 1100 -> R = 2', () => {
    expect(calcRMultiple('long', 1000, 950, 1100)).toBe(2)
  })

  it('is negative when a long trade stops out below entry', () => {
    expect(calcRMultiple('long', 1000, 950, 950)).toBe(-1)
  })

  it('mirrors correctly for a short', () => {
    expect(calcRMultiple('short', 1000, 1050, 900)).toBe(2)
    expect(calcRMultiple('short', 1000, 1050, 1050)).toBe(-1)
  })

  it('is null when risk is zero (stop equals entry)', () => {
    expect(calcRMultiple('long', 1000, 1000, 1100)).toBeNull()
  })

  it('is null when there is no exit price yet (open trade)', () => {
    expect(calcRMultiple('long', 1000, 950, null)).toBeNull()
  })
})

describe('calcRiskReward', () => {
  it('reduces to targetDistance / stopDistance regardless of entry', () => {
    expect(calcRiskReward(60, 30, 'long')).toBe(2)
    expect(calcRiskReward(60, 30, 'short')).toBe(2)
  })

  it('gives the correct figure even with a zero placeholder entry (empty form field)', () => {
    expect(calcRiskReward(60, 30, 'long', 0)).toBe(2)
  })

  it('is null when stopDistance is zero or negative', () => {
    expect(calcRiskReward(60, 0, 'long')).toBeNull()
    expect(calcRiskReward(60, -5, 'long')).toBeNull()
  })
})

describe('calcProfitLoss', () => {
  it('multiplies price move by point value and contracts, signed by direction', () => {
    expect(calcProfitLoss('long', 100, 110, 2, 5)).toBe(100) // 10pts * 5 * 2
    expect(calcProfitLoss('short', 100, 90, 2, 5)).toBe(100)
    expect(calcProfitLoss('long', 100, 90, 2, 5)).toBe(-100)
  })

  it('treats zero or negative contracts as missing, not a signed/zeroed figure', () => {
    expect(calcProfitLoss('long', 100, 110, 0, 5)).toBeNull()
    expect(calcProfitLoss('long', 100, 110, -1, 5)).toBeNull()
  })

  it('is null on any missing input', () => {
    expect(calcProfitLoss('long', 100, null, 2, 5)).toBeNull()
  })
})

describe('calcMultiExitProfitLoss', () => {
  it('sums each exit leg\'s own contribution', () => {
    const exits = [
      { exit_price: 110, contracts: 1 },
      { exit_price: 120, contracts: 1 },
    ]
    // (10 + 20) pts * pointValue 5 * 1 contract each = 150
    expect(calcMultiExitProfitLoss('long', 100, exits, 5)).toBe(150)
  })

  it('skips an incomplete leg instead of blanking the whole total', () => {
    const exits = [
      { exit_price: 110, contracts: 1 },
      { exit_price: null, contracts: 1 },
    ]
    expect(calcMultiExitProfitLoss('long', 100, exits, 5)).toBe(50)
  })

  it('is null for an empty exits array', () => {
    expect(calcMultiExitProfitLoss('long', 100, [], 5)).toBeNull()
  })
})

describe('calcBlendedRMultiple', () => {
  it('weights each leg\'s R by its own contracts', () => {
    // leg 1: 1 contract at R=2, leg 2: 3 contracts at R=-1
    // weighted = (2*1 + -1*3) / 4 = -1/4 = -0.25
    const exits = [
      { exit_price: 1100, contracts: 1 }, // R = 2 given stop 950
      { exit_price: 950, contracts: 3 }, // R = -1
    ]
    expect(calcBlendedRMultiple('long', 1000, 950, exits)).toBe(-0.25)
  })

  it('reduces to the single exit\'s own R for one leg', () => {
    const exits = [{ exit_price: 1100, contracts: 1 }]
    expect(calcBlendedRMultiple('long', 1000, 950, exits)).toBe(2)
  })

  it('excludes a leg with zero/negative contracts from both sides of the average', () => {
    const exits = [
      { exit_price: 1100, contracts: 1 }, // R = 2
      { exit_price: 950, contracts: 0 }, // excluded
    ]
    expect(calcBlendedRMultiple('long', 1000, 950, exits)).toBe(2)
  })
})

describe('hasResult', () => {
  it('is true only when r_multiple is a real number, including 0', () => {
    expect(hasResult({ r_multiple: 1.5 })).toBe(true)
    expect(hasResult({ r_multiple: 0 })).toBe(true)
    expect(hasResult({ r_multiple: null })).toBe(false)
    expect(hasResult({ r_multiple: undefined })).toBe(false)
  })
})

describe('tradeDurationMinutes', () => {
  it('is the plain difference within the same day', () => {
    expect(tradeDurationMinutes({ trade_time: '09:30', exit_time: '09:47' })).toBe(17)
  })

  it('wraps past midnight rather than going negative', () => {
    expect(tradeDurationMinutes({ trade_time: '23:50', exit_time: '00:10' })).toBe(20)
  })

  it('is null without both times', () => {
    expect(tradeDurationMinutes({ trade_time: '09:30', exit_time: null })).toBeNull()
  })
})

describe('formatDuration', () => {
  it('shows minutes under an hour, hours+minutes at or over', () => {
    expect(formatDuration(45)).toBe('45m')
    expect(formatDuration(90)).toBe('1h 30m')
    expect(formatDuration(120)).toBe('2h 0m')
  })

  it('shows the em-dash placeholder for null/undefined', () => {
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(undefined)).toBe('—')
  })
})

describe('formatTime12h', () => {
  it('converts 24h HH:MM:SS to 12h with AM/PM', () => {
    expect(formatTime12h('09:35:00')).toBe('09:35:00 AM')
    expect(formatTime12h('13:05:30')).toBe('01:05:30 PM')
  })

  it('handles midnight and noon correctly', () => {
    expect(formatTime12h('00:00:00')).toBe('12:00:00 AM')
    expect(formatTime12h('12:00:00')).toBe('12:00:00 PM')
  })

  it('defaults missing seconds to :00 for a pre-seconds-tracking trade', () => {
    expect(formatTime12h('09:35')).toBe('09:35:00 AM')
  })

  it('returns the em-dash placeholder for an empty value', () => {
    expect(formatTime12h(null)).toBe('—')
    expect(formatTime12h('')).toBe('—')
  })
})

// Properties that must hold for ANY inputs, rather than specific worked
// examples. These are the invariants a trader's money depends on: they
// would catch a sign flip, a broken scaling factor, or a guard that starts
// letting a non-number through, even in a refactor that keeps every
// hand-picked case above passing.
describe('arithmetic invariants', () => {
  const PV = 20 // NQ

  it('P&L scales linearly with contracts and point_value', () => {
    const one = calcProfitLoss('long', 100, 110, 1, PV)
    expect(calcProfitLoss('long', 100, 110, 3, PV)).toBeCloseTo(one * 3, 10)
    // NQ's point_value is 10x MNQ's, and they track the same price.
    expect(calcProfitLoss('long', 100, 110, 1, 20)).toBeCloseTo(calcProfitLoss('long', 100, 110, 1, 2) * 10, 10)
  })

  it('a long and the mirrored short earn the same', () => {
    expect(calcProfitLoss('long', 100, 110, 2, PV)).toBeCloseTo(calcProfitLoss('short', 110, 100, 2, PV), 10)
  })

  it('exiting at the stop is exactly -1R, in both directions', () => {
    for (const [dir, entry, dist] of [['long', 21050, 15], ['short', 21050, 15], ['long', 21050.55, 15.3], ['short', 4.372, 0.4]]) {
      const stop = calcStopPrice(dir, entry, dist)
      expect(calcRMultiple(dir, entry, stop, stop)).toBeCloseTo(-1, 12)
    }
  })

  it('exiting at N times the risk is exactly +NR', () => {
    const stop = calcStopPrice('long', 100, 10)
    expect(calcRMultiple('long', 100, stop, 120)).toBeCloseTo(2, 12)
    expect(calcRMultiple('long', 100, stop, 135)).toBeCloseTo(3.5, 12)
  })

  it('a breakeven exit is exactly zero, not merely close to it', () => {
    // The stats layer classifies by the sign of r_multiple, so a value that
    // is 1e-16 rather than 0 would count as a win.
    expect(calcRMultiple('long', 100, 90, 100)).toBe(0)
    expect(calcRMultiple('short', 100, 110, 100)).toBe(0)
  })

  // calcRiskReward is documented as a thin wrapper over calcRMultiple
  // rather than a second formula (CLAUDE.md's domain rules), so it has to
  // reduce to target/stop no matter what entry or direction it is given.
  it('planned R:R reduces to target/stop for any entry and direction', () => {
    for (const dir of ['long', 'short']) {
      for (const entry of [0, 100, 21050.75]) {
        expect(calcRiskReward(30, 15, dir, entry)).toBeCloseTo(2, 10)
        expect(calcRiskReward(7.5, 15, dir, entry)).toBeCloseTo(0.5, 10)
      }
    }
  })

  it('multi-exit totals equal the sum of their legs, and blend R by contracts', () => {
    const exits = [{ exit_price: 110, contracts: 1 }, { exit_price: 120, contracts: 3 }]
    const manual = calcProfitLoss('long', 100, 110, 1, PV) + calcProfitLoss('long', 100, 120, 3, PV)
    expect(calcMultiExitProfitLoss('long', 100, exits, PV)).toBeCloseTo(manual, 10)
    // 1 contract at +1R and 3 at +2R is 1.75R, not the naive mean of 1.5R.
    expect(calcBlendedRMultiple('long', 100, calcStopPrice('long', 100, 10), exits)).toBeCloseTo(1.75, 12)
  })

  it('a zero-contract leg is excluded from both $ and R, consistently', () => {
    const exits = [{ exit_price: 110, contracts: 1 }, { exit_price: 120, contracts: 3 }]
    const withZero = [...exits, { exit_price: 500, contracts: 0 }]
    const stop = calcStopPrice('long', 100, 10)
    expect(calcMultiExitProfitLoss('long', 100, withZero, PV)).toBeCloseTo(calcMultiExitProfitLoss('long', 100, exits, PV), 10)
    expect(calcBlendedRMultiple('long', 100, stop, withZero)).toBeCloseTo(calcBlendedRMultiple('long', 100, stop, exits), 12)
  })

  // Everything here returns null rather than NaN/Infinity, so a partly
  // filled form shows an empty field instead of a confident wrong number.
  it('never returns NaN or Infinity for missing, non-numeric or zero-risk input', () => {
    for (const bad of [null, undefined, NaN, '', 'abc', Infinity, true, []]) {
      expect(calcProfitLoss('long', bad, 110, 1, PV)).toBeNull()
      expect(calcProfitLoss('long', 100, bad, 1, PV)).toBeNull()
      expect(calcProfitLoss('long', 100, 110, bad, PV)).toBeNull()
      expect(calcProfitLoss('long', 100, 110, 1, bad)).toBeNull()
      expect(calcRMultiple('long', bad, 90, 110)).toBeNull()
      expect(calcRMultiple('long', 100, bad, 110)).toBeNull()
      expect(calcRMultiple('long', 100, 90, bad)).toBeNull()
      expect(calcStopPrice('long', bad, 10)).toBeNull()
      expect(calcTargetPrice('long', 100, bad)).toBeNull()
    }
    expect(calcRMultiple('long', 100, 100, 110)).toBeNull() // zero risk
    expect(calcRiskReward(30, 0)).toBeNull()
    expect(calcProfitLoss('long', 100, 110, -2, PV)).toBeNull() // negative size
  })

  // A string reaching these would be silent and financial rather than loud:
  // subtraction coerces but addition concatenates, so entry 21050 with a
  // '30' distance yields a correct stop of 21020 and a target of 2105030.
  it('rejects numeric strings rather than coercing them', () => {
    expect(calcTargetPrice('long', 21050, '30')).toBeNull()
    expect(calcStopPrice('long', 21050, '30')).toBeNull()
  })
})
