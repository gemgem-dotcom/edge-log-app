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
