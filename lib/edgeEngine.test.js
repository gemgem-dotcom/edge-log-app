import { describe, it, expect } from 'vitest'
import { queryPerformance, SINGLE_DIMENSIONS } from './edgeEngine'

function trade(overrides) {
  return { r_multiple: null, ...overrides }
}

describe('queryPerformance - ungrouped aggregate', () => {
  it('excludes open trades (no r_multiple) entirely', () => {
    const trades = [trade({ r_multiple: 1 }), trade({ r_multiple: null })]
    const result = queryPerformance({ trades })
    expect(result.n).toBe(1)
  })

  it('win rate excludes breakeven trades from its denominator but they still count toward n', () => {
    const trades = [trade({ r_multiple: 1 }), trade({ r_multiple: -1 }), trade({ r_multiple: 0 })]
    const result = queryPerformance({ trades })
    expect(result.n).toBe(3)
    expect(result.winRate).toBe(50) // 1 win / (1 win + 1 loss), breakeven excluded
  })

  it('expectancy is the plain average R including breakevens, matching avgR', () => {
    const trades = [trade({ r_multiple: 2 }), trade({ r_multiple: -1 }), trade({ r_multiple: 0 })]
    const result = queryPerformance({ trades })
    expect(result.avgR).toBeCloseTo(1 / 3)
    expect(result.expectancy).toBe(result.avgR)
  })

  it('profit factor is gross win / gross loss', () => {
    const trades = [trade({ r_multiple: 3 }), trade({ r_multiple: 1 }), trade({ r_multiple: -2 })]
    const result = queryPerformance({ trades })
    expect(result.profitFactor).toBe(2) // (3+1) / 2
  })

  it('profit factor is Infinity with wins and zero losses', () => {
    const trades = [trade({ r_multiple: 2 })]
    expect(queryPerformance({ trades }).profitFactor).toBe(Infinity)
  })

  it('profit factor is null with no wins and no losses (all breakeven)', () => {
    const trades = [trade({ r_multiple: 0 }), trade({ r_multiple: 0 })]
    expect(queryPerformance({ trades }).profitFactor).toBeNull()
  })

  it('returns null-valued fields (not zeros) for an empty slice', () => {
    const result = queryPerformance({ trades: [] })
    expect(result).toMatchObject({ n: 0, winRate: null, expectancy: null, avgR: null, profitFactor: null })
  })
})

describe('queryPerformance - confidence tiers', () => {
  it('buckets n<20 as too_early, 20-49 as early_signal, 50+ as trustworthy', () => {
    const many = (n) => Array.from({ length: n }, () => trade({ r_multiple: 1 }))
    expect(queryPerformance({ trades: many(19) }).confidenceTier).toBe('too_early')
    expect(queryPerformance({ trades: many(20) }).confidenceTier).toBe('early_signal')
    expect(queryPerformance({ trades: many(49) }).confidenceTier).toBe('early_signal')
    expect(queryPerformance({ trades: many(50) }).confidenceTier).toBe('trustworthy')
  })
})

describe('queryPerformance - groupBy', () => {
  it('groups by day_of_week, converting trade_date at local midnight', () => {
    const trades = [
      trade({ r_multiple: 1, trade_date: '2026-01-05' }), // a Monday
      trade({ r_multiple: -1, trade_date: '2026-01-05' }),
      trade({ r_multiple: 1, trade_date: '2026-01-06' }), // a Tuesday
    ]
    const rows = queryPerformance({ trades, groupBy: 'day_of_week' })
    const monday = rows.find((r) => r.key === 'Monday')
    const tuesday = rows.find((r) => r.key === 'Tuesday')
    expect(monday.n).toBe(2)
    expect(tuesday.n).toBe(1)
  })

  it('leaves a trade out of the grouped result when its dimension is null, rather than a "null" group', () => {
    const trades = [trade({ r_multiple: 1, session: 'NY AM' }), trade({ r_multiple: 1, session: null })]
    const rows = queryPerformance({ trades, groupBy: 'session' })
    expect(rows).toHaveLength(1)
    expect(rows[0].key).toBe('NY AM')
  })

  it('discipline groups into exactly clean / flagged / unreviewed', () => {
    const trades = [
      trade({ r_multiple: 1, reviewed_no_issues: true }),
      trade({ r_multiple: 1, discipline_tags: ['fomo'] }),
      trade({ r_multiple: 1 }),
    ]
    const rows = queryPerformance({ trades, groupBy: 'discipline' })
    const keys = rows.map((r) => r.key).sort()
    expect(keys).toEqual(['clean', 'flagged', 'unreviewed'])
  })

  it('throws on an unsupported groupBy dimension rather than silently returning nothing', () => {
    expect(() => queryPerformance({ trades: [trade({ r_multiple: 1 })], groupBy: 'not_a_real_dimension' })).toThrow()
  })

  it('every SINGLE_DIMENSIONS key is actually queryable without throwing', () => {
    const trades = [trade({ r_multiple: 1, trade_date: '2026-01-05', session: 'NY AM', strategy_id: 's1', instrument_id: 'i1' })]
    for (const dim of SINGLE_DIMENSIONS) {
      expect(() => queryPerformance({ trades, groupBy: dim })).not.toThrow()
    }
  })
})

describe('queryPerformance - compareTo / deltaVsBaseline', () => {
  it('computes a delta against the baseline for winRate and expectancy', () => {
    const trades = [trade({ r_multiple: 2 })] // 100% win rate, avgR 2
    const baseline = [trade({ r_multiple: 1 }), trade({ r_multiple: -1 })] // 50% win rate, avgR 0
    const result = queryPerformance({ trades, compareTo: baseline })
    expect(result.deltaVsBaseline.winRate).toBe(50)
    expect(result.deltaVsBaseline.expectancy).toBe(2)
  })

  it('a delta against a missing metric is null, not 0', () => {
    const trades = [trade({ r_multiple: 0 })] // no wins/losses -> winRate null
    const baseline = [trade({ r_multiple: 1 })]
    const result = queryPerformance({ trades, compareTo: baseline })
    expect(result.deltaVsBaseline.winRate).toBeNull()
  })
})

describe('queryPerformance - memoization', () => {
  it('returns the identical cached result object for the same trades array + args', () => {
    const trades = [trade({ r_multiple: 1 })]
    const first = queryPerformance({ trades })
    const second = queryPerformance({ trades })
    expect(second).toBe(first)
  })

  it('recomputes for a different array even with equal contents', () => {
    const a = [trade({ r_multiple: 1 })]
    const b = [trade({ r_multiple: 1 })]
    expect(queryPerformance({ trades: a })).not.toBe(queryPerformance({ trades: b }))
  })
})
