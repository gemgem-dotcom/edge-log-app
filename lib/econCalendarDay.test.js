import { describe, it, expect } from 'vitest'
import {
  localDayOf,
  ffDayFromKey,
  isAllDay,
  displayDayFor,
  eventInRange,
} from '@/lib/econCalendarDay'

// An all-day row as the fetchers actually store it: anchored to midnight in
// FF's own display zone, which is US Mountain for the runners that write it.
// 06:00Z is Monday the 14th in Denver and Sunday the 13th in Los Angeles -
// the whole reason this module exists.
const allDay = {
  event_key: '2026-09-14|EUR|German Prelim CPI m/m',
  event_time: '2026-09-14T06:00:00.000Z',
  time_precision: 'all_day',
}
const tentative = { ...allDay, event_key: '2026-09-14|CNY|Trade Balance', time_precision: 'tentative' }
const timed = {
  event_key: '2026-09-14|USD|CPI m/m',
  event_time: '2026-09-14T12:30:00.000Z',
  time_precision: 'exact',
}

describe('ffDayFromKey', () => {
  it('reads the day off the front of a key', () => {
    expect(ffDayFromKey('2026-09-14|USD|CPI m/m')).toBe('2026-09-14')
  })

  // The sequenced keys PR #221 introduced still lead with the day.
  it('reads it off a same-day-repeat key too', () => {
    expect(ffDayFromKey('2026-09-14|USD|FOMC Member Bowman Speaks|#1')).toBe('2026-09-14')
  })

  it('returns null rather than a slice of something unexpected', () => {
    expect(ffDayFromKey('nonsense')).toBeNull()
    expect(ffDayFromKey('')).toBeNull()
    expect(ffDayFromKey(null)).toBeNull()
    expect(ffDayFromKey(undefined)).toBeNull()
  })
})

describe('isAllDay', () => {
  it.each([['all_day', true], ['tentative', true], ['exact', false]])(
    'treats %s as all-day=%s', (precision, expected) => {
      expect(isAllDay({ time_precision: precision })).toBe(expected)
    },
  )

  // Null precision is treated as timed, matching what the card renders.
  it('treats an absent precision as timed rather than guessing', () => {
    expect(isAllDay({ time_precision: null })).toBe(false)
    expect(isAllDay({})).toBe(false)
    expect(isAllDay(null)).toBe(false)
  })
})

describe('displayDayFor', () => {
  // The bug, pinned. Run the suite under TZ=America/Los_Angeles and the
  // instant reads as the 13th; the answer must still be the 14th.
  it('files an all-day row under FF\'s day, whatever the viewer\'s zone', () => {
    expect(displayDayFor(allDay)).toBe('2026-09-14')
    expect(displayDayFor(tentative)).toBe('2026-09-14')
  })

  it('files a timed release under the viewer\'s own day', () => {
    expect(displayDayFor(timed)).toBe(localDayOf('2026-09-14T12:30:00.000Z'))
  })

  it('falls back to the instant when the key carries no usable day', () => {
    const broken = { ...allDay, event_key: 'not-a-key' }
    expect(displayDayFor(broken)).toBe(localDayOf(allDay.event_time))
  })
})

describe('eventInRange', () => {
  // The second half of the bug: a single-day range dropped all-day rows
  // outright, because the row's INSTANT fell outside the viewer's own
  // local-day window even though its day was the one being asked for.
  it('keeps an all-day row in a single-day range for its own day', () => {
    expect(eventInRange(allDay, '2026-09-14', '2026-09-14')).toBe(true)
  })

  it('keeps it out of the neighbouring day', () => {
    expect(eventInRange(allDay, '2026-09-13', '2026-09-13')).toBe(false)
    expect(eventInRange(allDay, '2026-09-15', '2026-09-15')).toBe(false)
  })

  it('includes both ends of a span', () => {
    expect(eventInRange(allDay, '2026-09-14', '2026-09-20')).toBe(true)
    expect(eventInRange(allDay, '2026-09-08', '2026-09-14')).toBe(true)
  })

  it('accepts a reversed range rather than returning nothing', () => {
    expect(eventInRange(allDay, '2026-09-20', '2026-09-08')).toBe(true)
  })

  it('drops a row whose day cannot be determined at all', () => {
    expect(eventInRange({ event_key: 'x', event_time: 'nope' }, '2026-09-14', '2026-09-14')).toBe(false)
  })
})
