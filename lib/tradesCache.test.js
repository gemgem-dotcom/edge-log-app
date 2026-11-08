import { describe, it, expect, beforeEach } from 'vitest'
import {
  tradesKey, readTrades, writeTrades, invalidateTrades,
  readTradePage, writeTradePage, onTradesInvalidated,
} from './tradesCache'

const rows = (...ids) => ids.map((id) => ({ id }))

beforeEach(() => {
  invalidateTrades()
})

describe('tradesKey', () => {
  it('is the same for the same set in a different order', () => {
    expect(tradesKey(['b', 'a'])).toBe(tradesKey(['a', 'b']))
  })

  it('is different for different sets', () => {
    expect(tradesKey(['a'])).not.toBe(tradesKey(['a', 'b']))
    expect(tradesKey(['a'])).not.toBe(tradesKey(['b']))
  })

  it('survives an empty or missing list', () => {
    expect(tradesKey([])).toBe(tradesKey(undefined))
    expect(tradesKey([])).toBe(tradesKey(null))
  })

  it('does not confuse a numeric id with its string form', () => {
    // Both pages read ids straight off a row, so one may hand over
    // numbers and another strings for the same instrument.
    expect(tradesKey([1, 2])).toBe(tradesKey(['1', '2']))
  })
})

// THE HAZARD, as a test. The Overview orders every trade by `id`; the
// strategies index orders the same trades, of the same instruments, by
// `trade_date`. On the instrument set alone those two collide, and the
// rows come back in the other page's order with nothing failing to say
// so - a strategies index silently drawing its curve in insertion order.
describe('variant separates callers whose queries differ in shape', () => {
  it('keys the same instruments separately per variant', () => {
    expect(tradesKey(['a'], 'by-date')).not.toBe(tradesKey(['a']))
    expect(tradesKey(['a'], 'by-date')).not.toBe(tradesKey(['a'], 'by-id'))
  })

  it('does not serve one variant to the other', () => {
    writeTrades(['a'], rows(1, 2), 'by-date')
    expect(readTrades(['a'], 'by-date')).toEqual(rows(1, 2))
    expect(readTrades(['a'])).toBeNull()
    expect(readTrades(['a'], 'by-id')).toBeNull()
  })

  it('keeps both variants at once rather than overwriting', () => {
    writeTrades(['a'], rows(1), '')
    writeTrades(['a'], rows(2), 'by-date')
    expect(readTrades(['a'], '')).toEqual(rows(1))
    expect(readTrades(['a'], 'by-date')).toEqual(rows(2))
  })

  // A variant must not be able to collide with a different set of
  // instruments - the separator has to be unambiguous.
  it('cannot be forged by an instrument id containing the separator', () => {
    expect(tradesKey(['a'], 'x')).not.toBe(tradesKey(['x|a']))
  })
})

describe('readTrades / writeTrades', () => {
  it('is a miss before anything is written', () => {
    expect(readTrades(['a'])).toBeNull()
  })

  it('round-trips', () => {
    writeTrades(['a', 'b'], rows(1, 2))
    expect(readTrades(['b', 'a'])).toEqual(rows(1, 2))
  })

  // An empty journal is a real answer, not a miss - otherwise a user
  // with no trades refetches on every single visit.
  it('treats an empty array as a hit', () => {
    writeTrades(['a'], [])
    expect(readTrades(['a'])).toEqual([])
  })

  it('ignores a write that is not an array', () => {
    writeTrades(['a'], null)
    writeTrades(['a'], undefined)
    writeTrades(['a'], { 0: { id: 1 } })
    expect(readTrades(['a'])).toBeNull()
  })
})

describe('invalidateTrades', () => {
  it('clears every set, not just one key', () => {
    writeTrades(['a'], rows(1))
    writeTrades(['b'], rows(2))
    writeTrades(['a'], rows(3), 'by-date')
    invalidateTrades()
    expect(readTrades(['a'])).toBeNull()
    expect(readTrades(['b'])).toBeNull()
    expect(readTrades(['a'], 'by-date')).toBeNull()
  })

  // Both caches, because a trade write invalidates the whole-set answer
  // and the paged answer alike. Clearing only one would leave the trade
  // log showing a deleted row.
  it('clears the paged cache too', () => {
    const args = { instrumentIds: ['a'], page: 0, pageSize: 25, filters: {} }
    writeTradePage(args, rows(1), 1)
    invalidateTrades()
    expect(readTradePage(args)).toBeNull()
  })
})

describe('readTradePage / writeTradePage', () => {
  const base = { instrumentIds: ['a'], page: 0, pageSize: 25, filters: {} }

  it('round-trips the rows and the total count', () => {
    writeTradePage(base, rows(1, 2), 97)
    expect(readTradePage(base)).toEqual({ trades: rows(1, 2), totalCount: 97 })
  })

  it('is a miss for a different page or page size', () => {
    writeTradePage(base, rows(1), 1)
    expect(readTradePage({ ...base, page: 1 })).toBeNull()
    expect(readTradePage({ ...base, pageSize: 50 })).toBeNull()
  })

  it('is a miss for a different instrument set', () => {
    writeTradePage(base, rows(1), 1)
    expect(readTradePage({ ...base, instrumentIds: ['a', 'b'] })).toBeNull()
  })

  // THE HAZARD this key exists for: painting the previous filter's rows
  // as though they matched the new one.
  it('is a miss once any filter changes', () => {
    writeTradePage(base, rows(1), 1)
    for (const filters of [
      { direction: 'long' },
      { result: 'win' },
      { days: ['mon'] },
      { tags: ['revenge'] },
      { strategyKeys: ['unclassified'] },
    ]) {
      expect(readTradePage({ ...base, filters })).toBeNull()
    }
  })

  // The same filter reached two ways has to be one key, or a cache that
  // is never hit is just dead weight. Array order and key order are both
  // incidental: the trader picked a set of days, not a sequence.
  it('is a hit for the same filter written differently', () => {
    writeTradePage({ ...base, filters: { days: ['mon', 'tue'], direction: 'long' } }, rows(1), 1)
    expect(readTradePage({ ...base, filters: { direction: 'long', days: ['tue', 'mon'] } }))
      .toEqual({ trades: rows(1), totalCount: 1 })
  })

  // An absent filter field and its "no filter" value select the same
  // trades, so EMPTY_FILTERS and {} have to agree - the pages seed from
  // one and query with the other.
  it('treats an absent field as its default', () => {
    writeTradePage({ ...base, filters: {} }, rows(1), 1)
    expect(readTradePage({
      ...base,
      filters: { days: [], strategyKeys: [], direction: 'all', result: 'all', tags: [] },
    })).toEqual({ trades: rows(1), totalCount: 1 })
  })

  it('distinguishes two filters that differ only in which field is set', () => {
    writeTradePage({ ...base, filters: { days: ['mon'] } }, rows(1), 1)
    expect(readTradePage({ ...base, filters: { tags: ['mon'] } })).toBeNull()
  })

  it('ignores a write that is not an array', () => {
    writeTradePage(base, null, 0)
    expect(readTradePage(base)).toBeNull()
  })
})

// The registry is what makes "a new write to `trades` calls
// invalidateTrades()" a complete rule rather than a partial one, so it is
// worth pinning rather than trusting.
describe('onTradesInvalidated', () => {
  it('runs every registered listener on invalidation', () => {
    let a = 0
    let b = 0
    onTradesInvalidated(() => { a += 1 })
    onTradesInvalidated(() => { b += 1 })
    invalidateTrades()
    expect(a).toBe(1)
    expect(b).toBe(1)
  })

  it('clears the caches that register through it', async () => {
    const { peekDashboard, writeDashboard } = await import('./dashboardCache')
    writeDashboard('NQ', { allTrades: rows(1) })
    expect(peekDashboard('NQ')).not.toBeNull()
    invalidateTrades()
    expect(peekDashboard('NQ')).toBeNull()
  })
})
