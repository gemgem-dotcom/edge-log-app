import { describe, it, expect } from 'vitest'
import { fetchAllRows } from './fetchAllRows'

// Simulates PostgREST: returns at most one page per call, sliced from a
// fixed table, and records the ranges it was asked for.
function fakeTable(rowCount) {
  const rows = Array.from({ length: rowCount }, (_, i) => ({ id: i }))
  const ranges = []
  return {
    ranges,
    query: async (from, to) => {
      ranges.push([from, to])
      return { data: rows.slice(from, to + 1), error: null }
    },
  }
}

describe('fetchAllRows', () => {
  it('returns everything when it fits in one page', async () => {
    const t = fakeTable(42)
    const { data, error } = await fetchAllRows(t.query)
    expect(error).toBeNull()
    expect(data).toHaveLength(42)
    expect(t.ranges).toHaveLength(1)
  })

  // The whole point: an unpaged select stops at 1000 with no error, so the
  // journal silently loses every trade past it.
  it('keeps going past the 1000-row cap', async () => {
    const t = fakeTable(2500)
    const { data } = await fetchAllRows(t.query)
    expect(data).toHaveLength(2500)
    expect(data[0].id).toBe(0)
    expect(data[2499].id).toBe(2499)
  })

  it('requests contiguous, non-overlapping ranges', async () => {
    const t = fakeTable(2500)
    await fetchAllRows(t.query)
    expect(t.ranges).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
  })

  // An exactly-full page is ambiguous, so it costs one extra request to
  // learn there is nothing after it.
  it('handles an exact multiple of the page size without dropping or duplicating', async () => {
    const t = fakeTable(2000)
    const { data } = await fetchAllRows(t.query)
    expect(data).toHaveLength(2000)
    expect(new Set(data.map((r) => r.id)).size).toBe(2000)
    expect(t.ranges).toHaveLength(3)
  })

  it('returns an empty array for an empty table', async () => {
    const { data, error } = await fetchAllRows(fakeTable(0).query)
    expect(data).toEqual([])
    expect(error).toBeNull()
  })

  // A partial result is worse than none here - the caller would treat it as
  // the complete set.
  it('surfaces an error instead of returning the rows read so far', async () => {
    let call = 0
    const { data, error } = await fetchAllRows(async (from, to) => {
      call += 1
      if (call === 2) return { data: null, error: { message: 'timeout' } }
      return { data: Array.from({ length: 1000 }, (_, i) => ({ id: from + i })), error: null }
    })
    expect(error).toEqual({ message: 'timeout' })
    expect(data).toBeNull()
  })

  it('stops rather than looping forever if a backend ignores the range', async () => {
    let calls = 0
    const { data } = await fetchAllRows(async () => {
      calls += 1
      return { data: Array.from({ length: 1000 }, (_, i) => ({ id: i })), error: null }
    })
    expect(calls).toBe(200)
    expect(data).toHaveLength(200000)
  })
})
