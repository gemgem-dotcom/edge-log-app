import { describe, it, expect } from 'vitest'
import { selectUpcoming } from '@/lib/useUpcomingEconEvents'

// Local noon, so "today" and "tomorrow" are unambiguous in whatever zone
// the test runner happens to sit in - the selection is deliberately
// viewer-relative, so pinning it to a UTC instant would test the runner's
// timezone rather than the logic.
const NOW = new Date(2026, 8, 15, 12, 0, 0)
const at = (hoursFromNow) => new Date(NOW.getTime() + hoursFromNow * 3600 * 1000).toISOString()

let nextId = 0
const timed = (hoursFromNow, over = {}) => ({
  event_key: `ff|${++nextId}`,
  title: `Release ${nextId}`,
  currency: 'USD',
  impact: 'high',
  time_precision: 'exact',
  event_time: at(hoursFromNow),
  ...over,
})

// An all-day row is stored at midnight in FF's own zone, not the viewer's.
// Building it that way - rather than at the viewer's midnight - is what
// makes these tests able to see the bug they exist for.
const allDayOn = (localDay, ffOffsetHours = -6, over = {}) => ({
  event_key: `ff|${++nextId}`,
  title: `Holiday ${nextId}`,
  currency: 'USD',
  impact: 'high',
  time_precision: 'all_day',
  event_time: new Date(Date.parse(`${localDay}T00:00:00Z`) - ffOffsetHours * 3600 * 1000).toISOString(),
  ...over,
})

const titles = (rows) => rows.map((r) => r.event.title)

describe('selectUpcoming: what reaches the card', () => {
  it('keeps a USD high-impact release inside the window', () => {
    expect(selectUpcoming([timed(3)], NOW)).toHaveLength(1)
  })

  it('keeps medium impact and drops low and holiday', () => {
    const rows = selectUpcoming([
      timed(1, { impact: 'medium', title: 'Medium' }),
      timed(2, { impact: 'low', title: 'Low' }),
      timed(3, { impact: 'holiday', title: 'Grey' }),
    ], NOW)
    expect(titles(rows)).toEqual(['Medium'])
  })

  // Every instrument in the catalog is a US-listed future, so a non-USD
  // print is not what moves the chart this card sits beside.
  it('drops every currency but USD', () => {
    const rows = selectUpcoming([
      timed(1, { currency: 'EUR', title: 'German CPI' }),
      timed(2, { currency: 'GBP', title: 'BOE' }),
      timed(3, { currency: 'USD', title: 'Core PCE' }),
    ], NOW)
    expect(titles(rows)).toEqual(['Core PCE'])
  })

  it('drops an event that has already happened', () => {
    expect(selectUpcoming([timed(-1)], NOW)).toEqual([])
  })

  it('drops an event past the far edge of the window', () => {
    expect(selectUpcoming([timed(25)], NOW)).toEqual([])
    expect(selectUpcoming([timed(23)], NOW)).toHaveLength(1)
  })

  it('orders soonest first', () => {
    const rows = selectUpcoming([
      timed(8, { title: 'Later' }),
      timed(1, { title: 'Sooner' }),
      timed(4, { title: 'Middle' }),
    ], NOW)
    expect(titles(rows)).toEqual(['Sooner', 'Middle', 'Later'])
  })

  it('returns nothing rather than throwing on junk input', () => {
    expect(selectUpcoming(null, NOW)).toEqual([])
    expect(selectUpcoming([null, {}, { currency: 'USD' }], NOW)).toEqual([])
    expect(selectUpcoming([timed(1, { event_time: 'not a date' })], NOW)).toEqual([])
  })
})

// The case that makes all-day rows worth handling separately at all. They
// are stored at midnight in FF's zone, so for any viewer west of FF the
// instant has ALREADY PASSED while the day is still ahead - a plain
// "event_time > now" would drop today's bank holiday for every trader on
// the Pacific coast, which is the same class of bug lib/econCalendarDay
// exists to settle.
describe('selectUpcoming: all-day rows', () => {
  it('keeps today\'s all-day row even though its instant is in the past', () => {
    const rows = selectUpcoming([allDayOn('2026-09-15')], NOW)
    expect(rows).toHaveLength(1)
    expect(rows[0].allDay).toBe(true)
    expect(rows[0].timestamp).toBeNull()
  })

  it('keeps tomorrow\'s', () => {
    expect(selectUpcoming([allDayOn('2026-09-16')], NOW)).toHaveLength(1)
  })

  it('drops one from yesterday and one three days out', () => {
    expect(selectUpcoming([allDayOn('2026-09-14')], NOW)).toEqual([])
    expect(selectUpcoming([allDayOn('2026-09-18')], NOW)).toEqual([])
  })

  // The layout wanting a countdown is not a reason to hide a market
  // holiday - see selectUpcoming's comment.
  it('marks it rather than dropping it for having no time', () => {
    const rows = selectUpcoming([allDayOn('2026-09-15'), timed(2)], NOW)
    expect(rows).toHaveLength(2)
    expect(rows.filter((r) => r.allDay)).toHaveLength(1)
  })

  // FF puts the day's no-time rows at the top of that day.
  it('sorts an all-day row to the start of its own day', () => {
    const rows = selectUpcoming([
      timed(2, { title: 'This afternoon' }),
      allDayOn('2026-09-16', -6, { title: 'Tomorrow all day' }),
      allDayOn('2026-09-15', -6, { title: 'Today all day' }),
    ], NOW)
    expect(titles(rows)).toEqual(['Today all day', 'This afternoon', 'Tomorrow all day'])
  })

  // A row written before time_precision existed, or by the JSON fallback
  // feed, has a null precision and is treated as exact - matching what
  // isAllDay and the calendar card already do.
  it('treats a null time_precision as a timed row', () => {
    const rows = selectUpcoming([timed(3, { time_precision: null })], NOW)
    expect(rows).toHaveLength(1)
    expect(rows[0].allDay).toBe(false)
  })

  // The row is filed under FF's day, so the same release must be picked up
  // whichever zone the fetcher was served - the thing that has broken this
  // pipeline twice.
  it.each([
    ['Mountain', -6],
    ['Pacific', -7],
    ['Eastern', -5],
  ])('finds today\'s holiday stored from a %s-served fetch', (_label, offset) => {
    expect(selectUpcoming([allDayOn('2026-09-15', offset)], NOW)).toHaveLength(1)
  })
})
