import { describe, it, expect } from 'vitest'
import { midnightUtc, candidateZones, resolveDay, narrowByDay, addDays } from './econCalendarZone.mjs'

const iso = (ms) => new Date(ms).toISOString()
const dl = (s) => Date.parse(s) / 1000

describe('midnightUtc', () => {
  it('finds local midnight either side of both US clock changes', () => {
    expect(iso(midnightUtc('America/New_York', 2026, 10, 1))).toBe('2026-11-01T04:00:00.000Z')
    expect(iso(midnightUtc('America/New_York', 2026, 10, 2))).toBe('2026-11-02T05:00:00.000Z')
    expect(iso(midnightUtc('America/New_York', 2026, 2, 8))).toBe('2026-03-08T05:00:00.000Z')
    expect(iso(midnightUtc('America/New_York', 2026, 2, 9))).toBe('2026-03-09T04:00:00.000Z')
  })

  // Havana moves its clocks AT midnight, so 00:00 on 2026-03-08 does not
  // exist there and the day starts at 01:00. An implementation that
  // insists on finding 00:00 returns the previous day's 23:00 instead.
  it('returns the start of a day whose midnight does not exist', () => {
    expect(iso(midnightUtc('America/Havana', 2026, 2, 8))).toBe('2026-03-08T05:00:00.000Z')
  })

  it('handles offsets that are not whole hours, and ones ahead of UTC', () => {
    expect(iso(midnightUtc('Asia/Kathmandu', 2026, 6, 1))).toBe('2026-06-30T18:15:00.000Z')
    expect(iso(midnightUtc('Pacific/Tongatapu', 2026, 0, 14))).toBe('2026-01-13T11:00:00.000Z')
  })
})

describe('candidateZones', () => {
  it('is empty with nothing to go on', () => {
    expect(candidateZones([])).toEqual([])
    expect(candidateZones(null)).toEqual([])
    expect(candidateZones([{ date: '2026-11-01' }])).toEqual([])
  })

  it('keeps the zone that produced the observation', () => {
    const c = candidateZones([{ date: '2026-11-30', dateline: dl('2026-11-30T05:00:00Z') }])
    expect(c).toContain('America/New_York')
    expect(c).not.toContain('America/Chicago')
  })

  // The order anchors arrive in is an accident of which page was fetched
  // first. It must not change the answer.
  it('does not depend on the order of the anchors', () => {
    const a = { date: '2026-11-01', dateline: dl('2026-11-02T04:00:00Z') }
    const b = { date: '2026-11-08', dateline: dl('2026-11-08T05:00:00Z') }
    expect(candidateZones([a, b]).sort()).toEqual(candidateZones([b, a]).sort())
  })

  // FF's autumn stamp: a whole day late, and no zone anywhere has its
  // midnight there. It has to be tolerated or this page matches nothing.
  it('accepts a whole-day-late dateline when nothing fits it exactly', () => {
    const c = candidateZones([{ date: '2026-11-01', dateline: dl('2026-11-02T04:00:00Z') }])
    expect(c).toContain('America/New_York')
  })

  // ...but UTC+13 and UTC-11 are exactly a day apart, so tolerating it
  // unconditionally makes Tonga's page indistinguishable from Pago Pago's
  // a day late. A dateline that IS some zone's midnight needs no bug to
  // explain it.
  it('does not entertain a day-off fit when an exact one exists', () => {
    const tonga = candidateZones([{ date: '2026-01-15', dateline: dl('2026-01-14T11:00:00Z') }])
    expect(tonga).toContain('Pacific/Tongatapu')
    expect(tonga).not.toContain('Pacific/Pago_Pago')
    const pago = candidateZones([{ date: '2026-01-14', dateline: dl('2026-01-14T11:00:00Z') }])
    expect(pago).toContain('Pacific/Pago_Pago')
    expect(pago).not.toContain('Pacific/Tongatapu')
  })
})

describe('resolveDay', () => {
  it('refuses with no candidates', () => {
    expect(resolveDay([], '2026-11-02')).toBeNull()
    expect(resolveDay(null, '2026-11-02')).toBeNull()
  })

  it('answers when every candidate agrees', () => {
    const r = resolveDay(['America/New_York', 'America/Toronto', 'America/Detroit'], '2026-11-01')
    expect(iso(r.start)).toBe('2026-11-01T04:00:00.000Z')
    expect(r.lengthSeconds).toBe(90000)
  })

  // THE SAFETY PROPERTY. New York and Puerto Rico are both UTC-4 until
  // 2026-11-01 and an hour apart afterwards. Evidence that cannot tell
  // them apart cannot place the Monday.
  it('refuses when two candidates disagree about the day', () => {
    expect(resolveDay(['America/New_York', 'America/Puerto_Rico'], '2026-10-30')).not.toBeNull()
    expect(resolveDay(['America/New_York', 'America/Puerto_Rico'], '2026-11-02')).toBeNull()
  })

  // They agree where the Sunday STARTS and disagree how long it runs,
  // which misplaces every row after 2am. Agreeing on the start alone is
  // not agreeing on the day.
  it('refuses when candidates agree on the start but not the length', () => {
    expect(resolveDay(['America/New_York', 'America/Puerto_Rico'], '2026-11-01')).toBeNull()
  })
})

describe('narrowByDay', () => {
  const both = ['America/New_York', 'America/Puerto_Rico']

  it('eliminates a zone the day rules out', () => {
    expect(narrowByDay(both, '2026-11-02', dl('2026-11-02T05:00:00Z'))).toEqual(['America/New_York'])
  })

  // Evidence nothing fits says something is wrong with that DAY. Obeying
  // it would leave no zone at all and withhold the whole page for one bad
  // row.
  it('ignores evidence that no candidate fits', () => {
    expect(narrowByDay(both, '2026-11-02', dl('2026-11-02T09:17:00Z'))).toEqual(both)
  })
})

describe('addDays', () => {
  it('crosses month and year ends', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })
})
