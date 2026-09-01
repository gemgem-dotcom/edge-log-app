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
