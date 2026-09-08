import { describe, it, expect } from 'vitest'
import {
  atrSeries,
  vwapSeries,
  rollingExtremes,
  openingRange,
  resolveTrade,
  scoreTrades,
  trueRanges,
  makeRng,
} from './strategy-core.js'

function bar(open, high, low, close, volume = 100) {
  return { open, high, low, close, volume }
}

// A deterministic ramp with known extremes, used wherever the exact numbers
// matter more than realism.
function ramp(n, start = 100, step = 1) {
  return Array.from({ length: n }, (_, i) => {
    const o = start + i * step
    return bar(o, o + 0.5, o - 0.5, o + step * 0.25)
  })
}

describe('trueRanges', () => {
  it('uses the prior close, not just the bar range, after the first bar', () => {
    const bars = [bar(100, 101, 99, 100), bar(110, 111, 109, 110)]
    // Second bar gapped: |111 - 100| = 11 beats its own 2 point range.
    expect(trueRanges(bars)).toEqual([2, 11])
  })
})

describe('atrSeries', () => {
  it('is null until a full period is available, then averages true range', () => {
    const bars = Array.from({ length: 5 }, () => bar(100, 102, 98, 100))
    const atr = atrSeries(bars, 3)
    expect(atr.slice(0, 2)).toEqual([null, null])
    expect(atr[2]).toBeCloseTo(4, 10)
    expect(atr[4]).toBeCloseTo(4, 10)
  })

  it('never reads a future bar', () => {
    const bars = ramp(30)
    const full = atrSeries(bars, 5)
    // Recomputing on a truncated series must give the same value at the cut.
    for (const cut of [10, 17, 25]) {
      const partial = atrSeries(bars.slice(0, cut + 1), 5)
      expect(partial[cut]).toBeCloseTo(full[cut], 10)
    }
  })
})

describe('vwapSeries', () => {
  it('equals the price when every bar is identical', () => {
    const bars = Array.from({ length: 4 }, () => bar(100, 100, 100, 100))
    const { vwap, sigma } = vwapSeries(bars)
    expect(vwap[3]).toBeCloseTo(100, 10)
    expect(sigma[3]).toBeCloseTo(0, 10)
  })

  it('weights by volume', () => {
    const bars = [bar(100, 100, 100, 100, 1), bar(200, 200, 200, 200, 3)]
    // (100*1 + 200*3) / 4 = 175
    expect(vwapSeries(bars).vwap[1]).toBeCloseTo(175, 10)
  })

  it('never reads a future bar', () => {
    const bars = ramp(40)
    const full = vwapSeries(bars).vwap
    for (const cut of [5, 20, 33]) {
      expect(vwapSeries(bars.slice(0, cut + 1)).vwap[cut]).toBeCloseTo(full[cut], 10)
    }
  })
})

describe('rollingExtremes', () => {
  it('excludes the current bar so a breakout is possible at all', () => {
    const bars = [bar(1, 5, 0, 1), bar(1, 6, 0, 1), bar(1, 99, 0, 1)]
    const { high } = rollingExtremes(bars, 2)
    // At index 2 the window is bars 0..1, so the 99 high can exceed it.
    expect(high[2]).toBe(6)
    expect(bars[2].high).toBeGreaterThan(high[2])
  })

  it('is null before a full window exists', () => {
    expect(rollingExtremes(ramp(5), 3).high.slice(0, 3)).toEqual([null, null, null])
  })
})

describe('openingRange', () => {
  it('spans exactly the first N bars and is ready only afterwards', () => {
    const bars = [bar(1, 10, 5, 6), bar(1, 12, 2, 6), bar(1, 99, 0, 6)]
    const or = openingRange(bars, 2)
    expect(or).toEqual({ high: 12, low: 2, readyIndex: 2 })
  })

  it('returns null when the session is shorter than the range', () => {
    expect(openingRange(ramp(3), 5)).toBeNull()
  })
})

describe('resolveTrade', () => {
  const flat = (n) => Array.from({ length: n }, () => bar(100, 100.1, 99.9, 100))

  it('enters at the open of the entry bar, not the signal close', () => {
    const bars = [bar(100, 100, 100, 100), bar(50, 50, 50, 50)]
    expect(resolveTrade(bars, 1, 'long', 10, 10, 5).entryPrice).toBe(50)
  })

  it('calls a win when only the target is reached', () => {
    const bars = [bar(100, 100, 100, 100), bar(100, 105, 99.5, 104)]
    expect(resolveTrade(bars, 1, 'long', 2, 4, 5).result).toBe('win')
  })

  it('calls a loss when only the stop is reached', () => {
    const bars = [bar(100, 100, 100, 100), bar(100, 101, 97, 98)]
    expect(resolveTrade(bars, 1, 'long', 2, 4, 5).result).toBe('loss')
  })

  it('refuses to guess when one bar spans both levels', () => {
    const bars = [bar(100, 100, 100, 100), bar(100, 106, 97, 100)]
    expect(resolveTrade(bars, 1, 'long', 2, 4, 5).result).toBe('ambiguous')
  })

  it('mirrors correctly for shorts', () => {
    const bars = [bar(100, 100, 100, 100), bar(100, 100.5, 96, 96)]
    expect(resolveTrade(bars, 1, 'short', 2, 4, 5).result).toBe('win')
    const stopped = [bar(100, 100, 100, 100), bar(100, 103, 99.5, 103)]
    expect(resolveTrade(stopped, 1, 'short', 2, 4, 5).result).toBe('loss')
  })

  it('reports open when nothing is reached inside the window', () => {
    const r = resolveTrade(flat(10), 1, 'long', 5, 5, 4)
    expect(r.result).toBe('open')
    expect(r.bars).toBe(4)
  })

  it('stops looking after maxBars even when the target comes later', () => {
    const bars = [...flat(3), bar(100, 200, 99, 199)]
    expect(resolveTrade(bars, 1, 'long', 5, 5, 2).result).toBe('open')
    expect(resolveTrade(bars, 1, 'long', 5, 5, 4).result).toBe('win')
  })
})

describe('scoreTrades', () => {
  const trade = (result, extra = {}) => ({ result, stopPoints: 10, targetPoints: 20, ...extra })

  it('charges costs against every trade, winners included', () => {
    const s = scoreTrades([trade('win')], { costPoints: 1 })
    expect(s.expectancyPoints).toBeCloseTo(19, 10)
  })

  it('charges ambiguous bars as losses and counts them separately', () => {
    const s = scoreTrades([trade('ambiguous')], { costPoints: 0 })
    expect(s.expectancyPoints).toBeCloseTo(-10, 10)
    expect(s.ambiguous).toBe(1)
    // Ambiguous is not a loss for win-rate purposes - it is not a decided trade.
    expect(s.losses).toBe(0)
  })

  it('closes unresolved trades at their mark instead of dropping them', () => {
    const s = scoreTrades([trade('open', { exitPoints: -3 })], { costPoints: 0 })
    expect(s.n).toBe(1)
    expect(s.unresolved).toBe(1)
    expect(s.expectancyPoints).toBeCloseTo(-3, 10)
  })

  it('computes win rate over decided trades only', () => {
    const s = scoreTrades(
      [trade('win'), trade('win'), trade('loss'), trade('open', { exitPoints: 0 })],
      { costPoints: 0 }
    )
    expect(s.winRate).toBeCloseTo(2 / 3, 10)
    expect(s.n).toBe(4)
  })

  it('reports a t-stat that shrinks as dispersion grows', () => {
    const tight = scoreTrades([trade('win'), trade('win'), trade('win'), trade('loss')], { costPoints: 0 })
    const wide = scoreTrades(
      [trade('win'), trade('loss'), trade('win'), trade('loss')],
      { costPoints: 0 }
    )
    expect(tight.tStat).toBeGreaterThan(wide.tStat)
  })
})

describe('makeRng', () => {
  it('is deterministic for a given seed and differs across seeds', () => {
    const a = makeRng(42)
    const b = makeRng(42)
    const c = makeRng(43)
    const draw = (rng) => [rng(), rng(), rng()]
    expect(draw(a)).toEqual(draw(b))
    expect(draw(makeRng(42))).not.toEqual(draw(c))
  })

  it('stays inside [0, 1)', () => {
    const rng = makeRng(7)
    for (let i = 0; i < 1000; i++) {
      const v = rng()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})
