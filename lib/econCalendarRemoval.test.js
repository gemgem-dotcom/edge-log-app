import { describe, it, expect } from 'vitest'
import {
  removalAllowance,
  vanishedRows,
  planRemoval,
  MIN_REMOVAL_ALLOWANCE,
} from '@/lib/econCalendarRemoval.mjs'

const RUN = '2026-09-14T12:00:00.000Z'
const fresh = (n) => Array.from({ length: n }, (_, i) => ({
  event_key: `ff|${1000 + i}`, fetched_at: '2026-09-14T12:00:01.000Z',
}))
const stale = (n) => Array.from({ length: n }, (_, i) => ({
  event_key: `ff|${9000 + i}`, fetched_at: '2026-09-13T04:00:00.000Z',
}))

describe('removalAllowance', () => {
  it('scales with the size of the range', () => {
    expect(removalAllowance(400)).toBe(40)
    expect(removalAllowance(1000)).toBe(100)
  })

  // A thin range - a quiet week, a legitimately sparse month - must not be
  // held to an allowance of zero, or a single genuine cancellation could
  // never be acted on.
  it('never falls below the floor, however small the range', () => {
    expect(removalAllowance(0)).toBe(MIN_REMOVAL_ALLOWANCE)
    expect(removalAllowance(3)).toBe(MIN_REMOVAL_ALLOWANCE)
    expect(removalAllowance(49)).toBe(MIN_REMOVAL_ALLOWANCE)
  })
})

describe('vanishedRows', () => {
  it('picks out only rows the run did not touch', () => {
    const rows = [...fresh(3), ...stale(2)]
    expect(vanishedRows(rows, RUN)).toHaveLength(2)
  })

  it('treats a row stamped exactly at the run boundary as fresh', () => {
    expect(vanishedRows([{ event_key: 'ff|1', fetched_at: RUN }], RUN)).toHaveLength(0)
  })

  // A row with no stamp would otherwise survive every sweep forever, which
  // is the invisible staleness this whole module exists to end.
  it('counts a row with no fetched_at as vanished, not as fresh', () => {
    expect(vanishedRows([{ event_key: 'ff|1', fetched_at: null }], RUN)).toHaveLength(1)
    expect(vanishedRows([{ event_key: 'ff|2' }], RUN)).toHaveLength(1)
  })

  it('returns nothing rather than throwing on junk input', () => {
    expect(vanishedRows(null, RUN)).toEqual([])
    expect(vanishedRows([{ fetched_at: null }], null)).toEqual([])
  })
})

describe('planRemoval', () => {
  it('allows a handful of genuine removals out of a full page', () => {
    const plan = planRemoval([...fresh(400), ...stale(3)], RUN)
    expect(plan.vanished).toHaveLength(3)
    expect(plan.allowed).toBe(true)
  })

  // The case this guard exists for: a markup change that makes the parser
  // miss a whole row type looks exactly like a mass cancellation. A table
  // missing a third of its events is far worse than one holding a few
  // stale rows, so the answer is to refuse and be noisy.
  it('refuses when a whole page-worth has apparently vanished', () => {
    const plan = planRemoval(stale(300), RUN)
    expect(plan.vanished).toHaveLength(300)
    expect(plan.allowed).toBe(false)
  })

  it('refuses one row past the allowance, and permits one at it', () => {
    const atLimit = planRemoval([...fresh(100), ...stale(10)], RUN)
    expect(atLimit.allowance).toBe(11)
    expect(atLimit.allowed).toBe(true)

    const over = planRemoval([...fresh(90), ...stale(20)], RUN)
    expect(over.allowance).toBe(11)
    expect(over.allowed).toBe(false)
  })

  // Refusing must not silently trim. Deleting "as many as are allowed"
  // would destroy data on a bad parse AND hide the signal, by never
  // looking unusual.
  it('reports the whole set when refusing rather than a trimmed one', () => {
    const plan = planRemoval(stale(300), RUN)
    expect(plan.allowed).toBe(false)
    expect(plan.vanished).toHaveLength(300)
  })

  it('does nothing when the page matched what is stored', () => {
    const plan = planRemoval(fresh(200), RUN)
    expect(plan.vanished).toEqual([])
    expect(plan.allowed).toBe(false)
  })

  it('does nothing on an empty range rather than treating it as total loss', () => {
    expect(planRemoval([], RUN).allowed).toBe(false)
    expect(planRemoval(null, RUN).vanished).toEqual([])
  })
})
