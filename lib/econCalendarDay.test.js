import { describe, it, expect } from 'vitest'
import {
  localDayOf,
  ffDayFromInstant,
  ffDayFromKey,
  isAllDay,
  displayDayFor,
  compareForDisplay,
  eventInRange,
} from '@/lib/econCalendarDay'

// An all-day row as the fetchers actually store it: anchored to midnight in
// FF's own display zone, which is US Mountain for the runners that write it.
// 06:00Z is Monday the 14th in Denver and Sunday the 13th in Los Angeles -
// the whole reason this module exists.
const allDay = {
  // An id key, which is what production stores. These fixtures used to
  // carry day-based keys, and that is exactly why the suite stayed green
  // when the key format changed and displayDayFor quietly stopped working.
  event_key: 'ff|150002',
  event_time: '2026-09-14T06:00:00.000Z',
  time_precision: 'all_day',
}
const tentative = { ...allDay, event_key: 'ff|150003', time_precision: 'tentative' }
const timed = {
  event_key: 'ff|150001',
  event_time: '2026-09-14T12:30:00.000Z',
  time_precision: 'exact',
}

// The regression this module was rewritten for. displayDayFor used to read
// the day off the front of event_key; the key then became `ff|<id>` and
// stopped carrying a day, so it fell back to the viewer's local day and
// all-day rows went back to showing a day early west of FF - silently, and
// with the whole suite still green, because these fixtures were the only
// place day-based keys still existed.
describe('ffDayFromInstant', () => {
  it('reads FF\'s day off the instant, with no key involved', () => {
    // 06:00Z is midnight in Mountain, which is what the fetchers write.
    expect(ffDayFromInstant('2026-09-14T06:00:00.000Z')).toBe('2026-09-14')
  })

  it('works for a zone ahead of UTC, where midnight is the previous UTC day', () => {
    // Midnight on the 14th in a UTC+1 zone is 23:00Z on the 13th.
    expect(ffDayFromInstant('2026-09-13T23:00:00.000Z')).toBe('2026-09-14')
  })

  it('works at the far end of the zones FF can serve', () => {
    expect(ffDayFromInstant('2026-09-14T12:00:00.000Z')).toBe('2026-09-15') // UTC-12
    expect(ffDayFromInstant('2026-09-13T12:00:00.000Z')).toBe('2026-09-14') // UTC+12
  })

  it('returns null rather than a bogus day for an unparseable instant', () => {
    expect(ffDayFromInstant('nope')).toBeNull()
    expect(ffDayFromInstant(null)).toBeNull()
  })
})

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

  // The key is no longer consulted for a row that has an instant, which is
  // the whole point - a key format change must not be able to move an
  // event again.
  it('ignores the key entirely when the row has an instant', () => {
    for (const key of ['not-a-key', '', null, 'ff|150002', '2026-01-01|X|Y']) {
      expect(displayDayFor({ ...allDay, event_key: key })).toBe('2026-09-14')
    }
  })

  // ...and a feed-written row with no usable instant still places by its
  // day-based key rather than nowhere.
  it('falls back to the key when there is no instant to read', () => {
    expect(displayDayFor({
      event_key: '2026-09-14|EUR|German Prelim CPI m/m',
      event_time: null,
      time_precision: 'all_day',
    })).toBe('2026-09-14')
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

// The Date column used to run backwards. The query returns rows by
// instant; the card labels each row with displayDayFor. For a viewer west
// of FF those disagree, because an all-day row is filed under FF's day and
// a timed row under the viewer's.
describe('compareForDisplay', () => {
  // 06:00Z is FF-local midnight (Mountain). 07:00Z is a timed overnight
  // print - and in Honolulu that is still the PREVIOUS local day.
  const allDay = { event_key: 'ff|1', event_time: '2026-09-18T06:00:00.000Z', time_precision: 'all_day' }
  const overnight = { event_key: 'ff|2', event_time: '2026-09-18T07:00:00.000Z', time_precision: 'exact' }
  const morning = { event_key: 'ff|3', event_time: '2026-09-18T11:00:00.000Z', time_precision: 'exact' }

  it('never lets the day go backwards, in any zone', () => {
    const sorted = [allDay, overnight, morning].sort(compareForDisplay)
    const days = sorted.map(displayDayFor)
    expect([...days].sort()).toEqual(days)
  })

  it('puts an all-day row at the top of its own day, the way FF does', () => {
    const sameDay = { event_key: 'ff|4', event_time: '2026-09-18T14:30:00.000Z', time_precision: 'exact' }
    const sorted = [sameDay, allDay].sort(compareForDisplay)
    // Both are FF's 18th; the all-day one leads.
    expect(displayDayFor(sorted[0])).toBe(displayDayFor(allDay))
    expect(sorted[0].event_key).toBe('ff|1')
  })

  it('orders timed rows within a day by their instant', () => {
    const a = { event_key: 'ff|a', event_time: '2026-09-18T14:00:00.000Z', time_precision: 'exact' }
    const b = { event_key: 'ff|b', event_time: '2026-09-18T15:00:00.000Z', time_precision: 'exact' }
    expect([b, a].sort(compareForDisplay).map((e) => e.event_key)).toEqual(['ff|a', 'ff|b'])
  })

  // A block of simultaneous releases - 08:30 is half a dozen prints at
  // once - must keep one order rather than shuffling between renders.
  it('is stable for releases sharing an instant', () => {
    const at = (k) => ({ event_key: k, event_time: '2026-09-18T14:30:00.000Z', time_precision: 'exact' })
    const once = [at('ff|9'), at('ff|3'), at('ff|5')].sort(compareForDisplay).map((e) => e.event_key)
    const twice = [at('ff|5'), at('ff|9'), at('ff|3')].sort(compareForDisplay).map((e) => e.event_key)
    expect(once).toEqual(twice)
  })

  it('does not throw on a row with no usable day', () => {
    const broken = { event_key: 'ff|x', event_time: 'nope', time_precision: 'exact' }
    expect(() => [broken, allDay].sort(compareForDisplay)).not.toThrow()
  })
})
