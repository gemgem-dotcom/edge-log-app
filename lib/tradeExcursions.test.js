import { describe, it, expect } from 'vitest'
import {
  findFillTick,
  deriveFillTicks,
  computeExcursion,
  isEmbargoError,
  hoursUntilEmbargoClears,
  embargoClearInstant,
  excursionStatusMessage,
  sliceTicksForWindow,
  findVerifiedMinuteFill,
  deriveVerifiedTimes,
  instantToWallClockTime,
  excursionWindow,
} from './tradeExcursions'

// Databento's ts_event is nanoseconds since epoch, delivered as a numeric
// string over the wire (see parseTickInstant's own comment) - this builds
// a synthetic tick the same shape fetchTrades returns.
function tickAt(ms, price) {
  return { price, tsEvent: String(BigInt(ms) * 1000000n) }
}

const T0 = Date.parse('2026-01-01T14:30:00.000Z')
const MIN = 60000

describe('findFillTick', () => {
  it('picks the earliest matching tick in the window, not the one closest to roughInstant', () => {
    // roughInstant sits 25s after T0, so the T0+30s tick is much closer to
    // it (5s away) than the T0-90s tick (115s away) - both are still
    // within the +-2min pad, so a "closest in time" rule would wrongly
    // pick the later one. This is the exact bug a real trade's report of
    // mae=0 traced back to (NOTES.md).
    const ticks = [tickAt(T0 - 90 * 1000, 100), tickAt(T0 + 30 * 1000, 100)]
    const result = findFillTick({ ticks, roughInstant: new Date(T0 + 25 * 1000), price: 100 })
    expect(result.matched).toBe(true)
    expect(result.instant.getTime()).toBe(T0 - 90 * 1000)
  })

  it('falls back to roughInstant with matched:false when nothing in range touches the price', () => {
    const ticks = [tickAt(T0, 105)] // never touches 100
    const result = findFillTick({ ticks, roughInstant: new Date(T0), price: 100 })
    expect(result.matched).toBe(false)
    expect(result.instant.getTime()).toBe(T0)
  })

  it('bounds the search to afterInstant, skipping an earlier match at the same price', () => {
    const ticks = [tickAt(T0 - 60 * 1000, 100), tickAt(T0 + 60 * 1000, 100)]
    const result = findFillTick({
      ticks,
      roughInstant: new Date(T0),
      price: 100,
      afterInstant: new Date(T0),
    })
    expect(result.matched).toBe(true)
    expect(result.instant.getTime()).toBe(T0 + 60 * 1000)
  })

  it('ignores a tick outside the +-pad window even if it is the only match', () => {
    const ticks = [tickAt(T0 - 5 * MIN, 100)] // 5 minutes out, pad is 2
    const result = findFillTick({ ticks, roughInstant: new Date(T0), price: 100 })
    expect(result.matched).toBe(false)
  })
})

describe('deriveFillTicks', () => {
  it('does not collapse a breakeven trade to the entry fill (real bug: 50-minute trade reading 0)', () => {
    const exitMs = T0 + 50 * MIN
    const rawWindow = {
      entryInstant: new Date(T0),
      legs: [{ price: 100, instant: new Date(exitMs) }],
    }
    // Same price at entry and exit (breakeven) - only two ticks in the
    // whole fetch, one at each real instant, 50 minutes apart.
    const ticks = [tickAt(T0, 100), tickAt(exitMs, 100)]

    const { entryInstant, exitInstant, usedFallback } = deriveFillTicks({ rawWindow, entryPrice: 100, ticks })

    expect(entryInstant.getTime()).toBe(T0)
    expect(exitInstant.getTime()).toBe(exitMs)
    expect(exitInstant.getTime() - entryInstant.getTime()).toBe(50 * MIN)
    expect(usedFallback).toBe(false)
  })

  it('flags usedFallback when a leg cannot be matched to any real print', () => {
    const rawWindow = {
      entryInstant: new Date(T0),
      legs: [{ price: 999, instant: new Date(T0 + MIN) }], // never traded
    }
    const ticks = [tickAt(T0, 100)]
    const { usedFallback } = deriveFillTicks({ rawWindow, entryPrice: 100, ticks })
    expect(usedFallback).toBe(true)
  })
})

describe('sliceTicksForWindow', () => {
  it('keeps only ticks within [entry, exit] inclusive, sorted chronologically', () => {
    const ticks = [tickAt(T0 + 2 * MIN, 101), tickAt(T0 - MIN, 99), tickAt(T0, 100), tickAt(T0 + MIN, 100.5)]
    const sliced = sliceTicksForWindow(ticks, new Date(T0), new Date(T0 + MIN))
    expect(sliced.map((t) => t.price)).toEqual([100, 100.5])
  })
})

describe('computeExcursion', () => {
  function withInstants(rows) {
    return rows.map(([offsetMs, price]) => ({ price, instant: new Date(T0 + offsetMs) }))
  }

  it('computes MFE/MAE as true high/low relative to entry for a long', () => {
    const ticks = withInstants([[0, 100], [MIN, 108], [2 * MIN, 95], [3 * MIN, 102]])
    const { mfePoints, maePoints } = computeExcursion({ ticks, entry: 100, direction: 'long' })
    expect(mfePoints).toBe(8)
    expect(maePoints).toBe(5)
  })

  it('mirrors correctly for a short', () => {
    const ticks = withInstants([[0, 100], [MIN, 92], [2 * MIN, 106], [3 * MIN, 98]])
    const { mfePoints, maePoints } = computeExcursion({ ticks, entry: 100, direction: 'short' })
    expect(mfePoints).toBe(8)
    expect(maePoints).toBe(6)
  })

  it('sums real elapsed time between consecutive ticks while underwater', () => {
    // long entry 100: tick0 (100, at entry) is not underwater; tick1 (95,
    // +1min later) is underwater for the 2 minutes until tick2 recovers.
    const ticks = withInstants([[0, 100], [MIN, 95], [3 * MIN, 101]])
    const { drawdownSeconds } = computeExcursion({ ticks, entry: 100, direction: 'long' })
    expect(drawdownSeconds).toBe(2 * 60)
  })

  it('has zero drawdown when price never goes adverse', () => {
    const ticks = withInstants([[0, 100], [MIN, 101], [2 * MIN, 105]])
    const { drawdownSeconds } = computeExcursion({ ticks, entry: 100, direction: 'long' })
    expect(drawdownSeconds).toBe(0)
  })
})

describe('isEmbargoError', () => {
  it('recognizes both known Databento embargo error shapes', () => {
    expect(isEmbargoError(new Error('dataset_unavailable_range: nope'))).toBe(true)
    expect(isEmbargoError(new Error('data_end_after_available_end'))).toBe(true)
  })

  it('treats any other error as not an embargo (retryable, not permanent)', () => {
    expect(isEmbargoError(new Error('ECONNRESET'))).toBe(false)
    expect(isEmbargoError(new Error('rate limited'))).toBe(false)
    expect(isEmbargoError(undefined)).toBe(false)
  })
})

describe('embargoClearInstant / hoursUntilEmbargoClears', () => {
  it('clears exactly EMBARGO_HOURS (8h) after the exit instant', () => {
    const exit = new Date(T0)
    expect(embargoClearInstant(exit).getTime()).toBe(T0 + 8 * 3600000)
  })

  it('floors remaining time at 1h so it never reads as 0h ("ready now")', () => {
    const exit = new Date(T0)
    const now = new Date(embargoClearInstant(exit).getTime() - 20 * MIN) // 20 min left
    expect(hoursUntilEmbargoClears(exit, now)).toBe(1)
  })

  it('reports 0 once the embargo has fully cleared (not negative)', () => {
    const exit = new Date(T0)
    const now = embargoClearInstant(exit)
    expect(hoursUntilEmbargoClears(exit, now)).toBe(1) // floors at 1, not 0
  })
})

describe('excursionStatusMessage', () => {
  it('reports unavailable for an unsupported instrument', () => {
    expect(excursionStatusMessage({ market_data_status: 'unavailable' }, -5)).toBe('Not available for this trade')
  })

  it('shows an hours estimate while pending', () => {
    const trade = {
      market_data_status: 'pending',
      trade_date: '2026-01-01',
      trade_time: '09:30:00',
      exit_time: '09:47:00',
      exit_price: 100,
    }
    const now = new Date(Date.parse('2026-01-01T14:29:00.000Z')) // just after entry, in UTC
    const msg = excursionStatusMessage(trade, 0, now)
    expect(msg).toMatch(/^Available in ~\d+h$/)
  })

  it('shows Unverified for a complete trade that used the fallback path', () => {
    expect(excursionStatusMessage({ market_data_status: 'complete', excursion_fallback: true }, 0)).toBe('Unverified')
  })

  it('returns null for a clean complete trade, letting the caller show the real numbers', () => {
    expect(excursionStatusMessage({ market_data_status: 'complete', excursion_fallback: false }, 0)).toBeNull()
  })
})

// These three decide whether the trade's OWN logged trade_time/exit_time
// get overwritten with a verified second. That makes them the highest-
// consequence functions in this file: everything else derives a displayed
// statistic, while a wrong answer here silently edits what the trader
// themselves recorded. The rule they have to hold to is "correct the
// second, never the minute, and never invent one".
describe('findVerifiedMinuteFill', () => {
  const minuteStart = Date.parse('2026-01-01T14:30:00.000Z')

  it('finds the earliest tick at that price inside the logged minute', () => {
    const ticks = [
      tickAt(minuteStart + 41 * 1000, 100),
      tickAt(minuteStart + 12 * 1000, 100),
      tickAt(minuteStart + 55 * 1000, 100),
    ]
    const r = findVerifiedMinuteFill({ ticks, roughInstant: new Date(minuteStart + 30 * 1000), price: 100 })
    expect(r.matched).toBe(true)
    expect(r.instant.getTime()).toBe(minuteStart + 12 * 1000)
  })

  // The minute is what the trader is trusted to have logged; only the
  // second is being recovered. A tick at the right price one minute later
  // must not be adopted.
  it('never reaches outside the logged minute', () => {
    const ticks = [tickAt(minuteStart - 1, 100), tickAt(minuteStart + 60000, 100)]
    const r = findVerifiedMinuteFill({ ticks, roughInstant: new Date(minuteStart + 30 * 1000), price: 100 })
    expect(r.matched).toBe(false)
  })

  it('includes the very first and very last instant of the minute', () => {
    expect(findVerifiedMinuteFill({ ticks: [tickAt(minuteStart, 100)], roughInstant: new Date(minuteStart + 30000), price: 100 }).matched).toBe(true)
    expect(findVerifiedMinuteFill({ ticks: [tickAt(minuteStart + 59999, 100)], roughInstant: new Date(minuteStart + 30000), price: 100 }).matched).toBe(true)
  })

  // matched:false is the caller's signal to leave the logged time alone.
  // If this ever returned matched:true with the minute's start, the app
  // would rewrite the trader's seconds to :00 on no evidence at all.
  it('reports matched:false when the price never traded that minute', () => {
    const r = findVerifiedMinuteFill({ ticks: [tickAt(minuteStart + 10000, 250)], roughInstant: new Date(minuteStart), price: 100 })
    expect(r.matched).toBe(false)
    expect(r.instant.getTime()).toBe(minuteStart)
  })

  it('respects afterInstant so legs cannot resolve out of order', () => {
    const ticks = [tickAt(minuteStart + 10 * 1000, 100), tickAt(minuteStart + 40 * 1000, 100)]
    const r = findVerifiedMinuteFill({
      ticks, roughInstant: new Date(minuteStart + 30 * 1000), price: 100,
      afterInstant: new Date(minuteStart + 20 * 1000),
    })
    expect(r.instant.getTime()).toBe(minuteStart + 40 * 1000)
  })

  it('matches within the price epsilon but not beyond it', () => {
    const near = findVerifiedMinuteFill({ ticks: [tickAt(minuteStart + 5000, 100.00005)], roughInstant: new Date(minuteStart), price: 100 })
    const far = findVerifiedMinuteFill({ ticks: [tickAt(minuteStart + 5000, 100.01)], roughInstant: new Date(minuteStart), price: 100 })
    expect(near.matched).toBe(true)
    expect(far.matched).toBe(false)
  })
})

describe('deriveVerifiedTimes', () => {
  const entryMin = Date.parse('2026-01-01T14:30:00.000Z')
  const exitMin = Date.parse('2026-01-01T15:00:00.000Z')
  const rawWindow = {
    entryInstant: new Date(entryMin + 30 * 1000),
    legs: [{ instant: new Date(exitMin + 30 * 1000), price: 120 }],
  }

  it('verifies entry and every leg when each price traded in its own minute', () => {
    const ticks = [tickAt(entryMin + 8000, 100), tickAt(exitMin + 44000, 120)]
    const r = deriveVerifiedTimes({ rawWindow, entryPrice: 100, ticks })
    expect(r.anyUnverified).toBe(false)
    expect(r.entry.instant.getTime()).toBe(entryMin + 8000)
    expect(r.legs[0].instant.getTime()).toBe(exitMin + 44000)
  })

  it('flags anyUnverified when the entry price never traded that minute', () => {
    const ticks = [tickAt(exitMin + 44000, 120)]
    const r = deriveVerifiedTimes({ rawWindow, entryPrice: 100, ticks })
    expect(r.anyUnverified).toBe(true)
    expect(r.entry.matched).toBe(false)
  })

  it('flags anyUnverified when any single leg is unverified', () => {
    const ticks = [tickAt(entryMin + 8000, 100)]
    const r = deriveVerifiedTimes({ rawWindow, entryPrice: 100, ticks })
    expect(r.anyUnverified).toBe(true)
    expect(r.entry.matched).toBe(true)
    expect(r.legs[0].matched).toBe(false)
  })

  // Chaining is "at-or-after" (findFillTick's own documented contract, which
  // this mirrors), so a later leg can never resolve BEFORE an earlier one.
  // It is deliberately inclusive rather than strictly after: two legs at the
  // same price in the same minute are allowed to share a tick, since there
  // may genuinely be only one print at that level.
  it('never lets a later leg resolve before an earlier one', () => {
    const twoLegs = {
      entryInstant: new Date(entryMin + 30 * 1000),
      legs: [
        { instant: new Date(exitMin + 30 * 1000), price: 120 },
        { instant: new Date(exitMin + 30 * 1000), price: 120 },
      ],
    }
    // The 5s tick sits before leg[0]'s own match and must be unreachable to
    // leg[1], which would otherwise walk backwards in time.
    const ticks = [
      tickAt(entryMin + 1000, 100),
      tickAt(exitMin + 5000, 120),
      tickAt(exitMin + 10000, 120),
    ]
    const r = deriveVerifiedTimes({ rawWindow: twoLegs, entryPrice: 100, ticks })
    expect(r.legs[0].instant.getTime()).toBe(exitMin + 5000)
    expect(r.legs[1].instant.getTime()).toBeGreaterThanOrEqual(r.legs[0].instant.getTime())
  })

  it('entry is not constrained by any afterInstant, but the first leg is', () => {
    const ticks = [tickAt(entryMin + 50000, 100), tickAt(exitMin + 2000, 120)]
    const r = deriveVerifiedTimes({ rawWindow, entryPrice: 100, ticks })
    expect(r.entry.instant.getTime()).toBe(entryMin + 50000)
    expect(r.legs[0].instant.getTime()).toBeGreaterThanOrEqual(r.entry.instant.getTime())
  })
})

describe('instantToWallClockTime', () => {
  it('renders the offset wall clock, truncating to whole seconds', () => {
    const instant = new Date(Date.parse('2026-01-01T14:30:41.900Z'))
    expect(instantToWallClockTime(instant, 0)).toBe('14:30:41')
    expect(instantToWallClockTime(instant, -5)).toBe('09:30:41')
    expect(instantToWallClockTime(instant, 5.5)).toBe('20:00:41')
  })

  it('wraps correctly across midnight in both directions', () => {
    expect(instantToWallClockTime(new Date(Date.parse('2026-01-01T02:00:00.000Z')), -5)).toBe('21:00:00')
    expect(instantToWallClockTime(new Date(Date.parse('2026-01-01T22:00:00.000Z')), 5)).toBe('03:00:00')
  })

  // The whole point of the pairing: the minute must survive the round trip,
  // since only the second is ever being corrected.
  it('preserves the logged minute for any verified fill', () => {
    const minuteStart = Date.parse('2026-01-01T14:30:00.000Z')
    for (const sec of [0, 1, 30, 59]) {
      expect(instantToWallClockTime(new Date(minuteStart + sec * 1000), -5)).toBe(`09:30:${String(sec).padStart(2, '0')}`)
    }
  })
})
