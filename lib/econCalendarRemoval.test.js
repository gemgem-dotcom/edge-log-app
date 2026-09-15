import { describe, it, expect } from 'vitest'
import {
  removalAllowance,
  isFeedWritten,
  vanishedRows,
  withinCoveredDays,
  planRemoval,
  MIN_REMOVAL_ALLOWANCE,
  MAX_REMOVAL_ABSOLUTE,
} from '@/lib/econCalendarRemoval.mjs'

const RUN = '2026-09-14T12:00:00.000Z'

// Page-written rows: they carry FF's own event id, which is what subjects
// them to the allowance. A fixture without one is a JSON-feed row, and the
// two are judged by different rules - so every helper here is explicit
// about which kind it makes.
const fresh = (n) => Array.from({ length: n }, (_, i) => ({
  event_key: `ff|${1000 + i}`, ff_event_id: String(1000 + i), fetched_at: '2026-09-14T12:00:01.000Z',
}))
const stale = (n) => Array.from({ length: n }, (_, i) => ({
  event_key: `ff|${9000 + i}`, ff_event_id: String(9000 + i), fetched_at: '2026-09-13T04:00:00.000Z',
}))
const staleFeedRows = (n) => Array.from({ length: n }, (_, i) => ({
  event_key: `2026-09-13|USD|Fed Speech|#${i}`, ff_event_id: null, fetched_at: '2026-09-13T04:00:00.000Z',
}))

describe('removalAllowance', () => {
  it('scales with the size of the range, up to the cap', () => {
    expect(removalAllowance(60)).toBe(6)
    expect(removalAllowance(105)).toBe(10)
  })

  // A thin range - a quiet week, a legitimately sparse month - must not be
  // held to an allowance of zero, or a single genuine cancellation could
  // never be acted on.
  it('never falls below the floor, however small the range', () => {
    expect(removalAllowance(0)).toBe(MIN_REMOVAL_ALLOWANCE)
    expect(removalAllowance(3)).toBe(MIN_REMOVAL_ALLOWANCE)
    expect(removalAllowance(49)).toBe(MIN_REMOVAL_ALLOWANCE)
  })

  // The end the proportion gets wrong. A month page holds ~400 rows, and a
  // tenth of that is forty - enough for a parse regression that misses one
  // impact class to destroy forty real events per page per day while
  // staying under the fraction, logged the whole time as legitimate
  // removals.
  it('stops growing at the absolute cap, however large the range', () => {
    expect(removalAllowance(400)).toBe(MAX_REMOVAL_ABSOLUTE)
    expect(removalAllowance(1000)).toBe(MAX_REMOVAL_ABSOLUTE)
    expect(removalAllowance(100000)).toBe(MAX_REMOVAL_ABSOLUTE)
  })

  it('is monotonic and never exceeds the cap at any size', () => {
    let prev = 0
    for (let n = 0; n <= 1200; n += 7) {
      const a = removalAllowance(n)
      expect(a).toBeGreaterThanOrEqual(prev)
      expect(a).toBeLessThanOrEqual(MAX_REMOVAL_ABSOLUTE)
      prev = a
    }
  })
})

describe('isFeedWritten', () => {
  it('is true only for a row with no FF event id', () => {
    expect(isFeedWritten({ ff_event_id: null })).toBe(true)
    expect(isFeedWritten({ ff_event_id: '' })).toBe(true)
    expect(isFeedWritten({})).toBe(true)
    expect(isFeedWritten(null)).toBe(true)
  })

  it('is false for a row the page wrote', () => {
    expect(isFeedWritten({ ff_event_id: '145821' })).toBe(false)
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
    expect(plan.removable).toHaveLength(3)
  })

  // The case this guard exists for: a markup change that makes the parser
  // miss a whole row type looks exactly like a mass cancellation. A table
  // missing a third of its events is far worse than one holding a few
  // stale rows, so the answer is to refuse and be noisy.
  it('refuses when a whole page-worth has apparently vanished', () => {
    const plan = planRemoval(stale(300), RUN)
    expect(plan.vanished).toHaveLength(300)
    expect(plan.allowed).toBe(false)
    expect(plan.removable).toEqual([])
  })

  // The regression the cap exists for, stated as the numbers that let it
  // through before: forty stale rows out of four hundred is exactly the
  // fraction, and forty real events is not a cancellation.
  it('refuses forty vanished out of a four-hundred-row month page', () => {
    const plan = planRemoval([...fresh(360), ...stale(40)], RUN)
    expect(plan.inRangeCount).toBe(400)
    expect(plan.allowance).toBe(MAX_REMOVAL_ABSOLUTE)
    expect(plan.allowed).toBe(false)
  })

  it('refuses one row past the allowance, and permits one at it', () => {
    const atLimit = planRemoval([...fresh(95), ...stale(10)], RUN)
    expect(atLimit.allowance).toBe(10)
    expect(atLimit.allowed).toBe(true)

    const over = planRemoval([...fresh(94), ...stale(11)], RUN)
    expect(over.allowance).toBe(10)
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
    expect(plan.removable).toEqual([])
  })

  it('does nothing on an empty range rather than treating it as total loss', () => {
    expect(planRemoval([], RUN).allowed).toBe(false)
    expect(planRemoval(null, RUN).vanished).toEqual([])
  })
})

// A feed row absent from the page is not evidence the page is wrong - it
// was never from the page. Gating them was what let a day-long HTML outage
// wedge the removal pass permanently: the feed writes ~100 orphans under
// the old day-based key, the page recovers under `ff|<id>`, and from then
// on every run computes the same hundred, exceeds every allowance, and
// refuses forever.
describe('planRemoval: JSON-feed orphans', () => {
  it('removes orphans even when far past any allowance', () => {
    const plan = planRemoval([...fresh(50), ...staleFeedRows(100)], RUN)
    expect(plan.orphans).toHaveLength(100)
    expect(plan.gated).toEqual([])
    expect(plan.allowed).toBe(false)
    expect(plan.removable).toHaveLength(100)
  })

  it('does not let orphans consume the allowance owed to page rows', () => {
    const plan = planRemoval([...fresh(95), ...staleFeedRows(100), ...stale(10)], RUN)
    expect(plan.allowance).toBe(MAX_REMOVAL_ABSOLUTE)
    // 110 rows vanished, but only the 10 page-written ones are judged.
    expect(plan.gated).toHaveLength(10)
    expect(plan.allowed).toBe(true)
    expect(plan.removable).toHaveLength(110)
  })

  // The other half of the exemption: a refusal about page rows must not
  // take the orphans down with it, or the wedge comes back by another
  // route.
  it('still clears orphans when the page rows are refused', () => {
    const plan = planRemoval([...staleFeedRows(20), ...stale(300)], RUN)
    expect(plan.allowed).toBe(false)
    expect(plan.removable).toHaveLength(20)
    expect(plan.removable.every(isFeedWritten)).toBe(true)
  })

  it('counts orphans in the denominator like any other row in range', () => {
    const plan = planRemoval([...fresh(20), ...staleFeedRows(40)], RUN)
    expect(plan.inRangeCount).toBe(60)
  })
})

// The bug the original suite could not see, because its fixtures spelled
// both sides the same way. `since` is JavaScript's toISOString; fetched_at
// is what PostgREST returns, which Postgres renders with a numeric offset
// and a trimmed fraction. Compared as strings, '+' (0x2B) sorts before
// 'Z' (0x5A), so every row written in the same millisecond as `since` read
// as older than it - which is most of the first 200-row chunk.
describe('vanishedRows: the two timestamp spellings', () => {
  const SINCE = '2026-09-14T12:00:00.123Z'

  it.each([
    ['2026-09-14T12:00:00.123+00:00', 'same instant, full fraction'],
    ['2026-09-14T12:00:00.25+00:00', 'later, trimmed fraction'],
    ['2026-09-14T12:00:00.2+00:00', 'later, single-digit fraction'],
    ['2026-09-14T12:00:01+00:00', 'later, no fraction at all'],
  ])('does not call %s vanished (%s)', (fetched) => {
    expect(vanishedRows([{ event_key: 'ff|1', fetched_at: fetched }], SINCE)).toHaveLength(0)
  })

  it('still catches a genuinely older row in the same spelling', () => {
    expect(vanishedRows([{ event_key: 'ff|1', fetched_at: '2026-09-13T04:00:00+00:00' }], SINCE)).toHaveLength(1)
  })

  it('treats an unparseable stamp as stale rather than as fresh', () => {
    expect(vanishedRows([{ event_key: 'ff|1', fetched_at: 'not a date' }], SINCE)).toHaveLength(1)
  })

  it('does nothing at all when since itself is unusable', () => {
    expect(vanishedRows([{ event_key: 'ff|1', fetched_at: null }], 'nonsense')).toEqual([])
  })
})

describe('withinCoveredDays', () => {
  const windows = [
    ['2026-08-28T05:00:00.000Z', '2026-08-29T05:00:00.000Z'],
    ['2026-09-01T05:00:00.000Z', '2026-09-02T05:00:00.000Z'],
  ]
  const at = (t) => ({ event_key: `ff|${t}`, ff_event_id: t, event_time: t })

  it('keeps rows inside a rendered day', () => {
    expect(withinCoveredDays([at('2026-08-28T13:30:00.000Z')], windows)).toHaveLength(1)
  })

  // The gap case. A day the page skipped is not a day it spoke for.
  it('drops rows on a day the page skipped over', () => {
    expect(withinCoveredDays([at('2026-08-30T18:30:00.000Z')], windows)).toHaveLength(0)
  })

  it('is inclusive at the start of a day and exclusive at the end', () => {
    expect(withinCoveredDays([at('2026-08-28T05:00:00.000Z')], windows)).toHaveLength(1)
    // Exactly the next day's midnight - where an all-day row sits.
    expect(withinCoveredDays([at('2026-08-29T05:00:00.000Z')], windows)).toHaveLength(0)
  })

  it('qualifies nothing when the page spoke for no day', () => {
    expect(withinCoveredDays([at('2026-08-28T13:30:00.000Z')], [])).toEqual([])
    expect(withinCoveredDays([at('2026-08-28T13:30:00.000Z')], null)).toEqual([])
  })
})

describe('planRemoval with covered days', () => {
  const windows = [['2026-08-28T05:00:00.000Z', '2026-08-29T05:00:00.000Z']]
  const stale = (t) => ({
    event_key: `ff|${t}`, ff_event_id: t, event_time: t, fetched_at: '2026-08-01T00:00:00+00:00',
  })

  it('ignores stale rows outside the days the page rendered', () => {
    const plan = planRemoval([stale('2026-08-30T18:30:00.000Z')], '2026-09-14T12:00:00.000Z', windows)
    expect(plan.vanished).toEqual([])
    expect(plan.allowed).toBe(false)
  })

  it('acts on stale rows inside them', () => {
    const plan = planRemoval([stale('2026-08-28T13:30:00.000Z')], '2026-09-14T12:00:00.000Z', windows)
    expect(plan.vanished).toHaveLength(1)
    expect(plan.allowed).toBe(true)
  })

  // An orphan outside the rendered days is still outside them. The
  // exemption is from the allowance, not from the window.
  it('does not remove a feed orphan on a day the page never rendered', () => {
    const orphan = { event_key: '2026-08-30|USD|CPI', ff_event_id: null, event_time: '2026-08-30T18:30:00.000Z', fetched_at: '2026-08-01T00:00:00+00:00' }
    const plan = planRemoval([orphan], '2026-09-14T12:00:00.000Z', windows)
    expect(plan.removable).toEqual([])
  })

  // The denominator has to be what the page spoke for too, or a wide span
  // of untouched days would inflate the allowance.
  it('sizes the allowance from the covered rows, not the whole scan', () => {
    const outside = Array.from({ length: 500 }, (_, i) => stale(`2026-08-30T${String(i % 24).padStart(2, '0')}:00:00.000Z`))
    const plan = planRemoval([...outside, stale('2026-08-28T13:30:00.000Z')], '2026-09-14T12:00:00.000Z', windows)
    expect(plan.inRangeCount).toBe(1)
    expect(plan.allowance).toBe(MIN_REMOVAL_ALLOWANCE)
  })
})
