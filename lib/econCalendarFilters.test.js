import { describe, it, expect } from 'vitest'
import { IMPACT_LEVELS, EVENT_TYPES, CURRENCIES } from '@/lib/econCalendarEvents.mjs'
import {
  DEFAULT_FILTERS,
  FILTER_STORAGE_KEY,
  normaliseFilters,
  readStoredFilters,
  writeStoredFilters,
  isNarrowed,
  activeSectionCount,
} from '@/lib/econCalendarFilters'

// A stand-in for window.localStorage. `failOn` makes it throw the way a
// real one does when site data is blocked or the quota is full - the case
// that used to take the filter panel down with it.
function fakeStorage(initial = {}, failOn = null) {
  const store = { ...initial }
  return {
    getItem(k) {
      if (failOn === 'get' || failOn === 'both') throw new DOMException('blocked')
      return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null
    },
    setItem(k, v) {
      if (failOn === 'set' || failOn === 'both') throw new DOMException('quota')
      store[k] = String(v)
    },
    _store: store,
  }
}

describe('DEFAULT_FILTERS', () => {
  it('starts at USD alone', () => {
    expect(DEFAULT_FILTERS.currencies).toEqual(['USD'])
  })

  it('starts with every impact level, including the non-economic one', () => {
    expect(DEFAULT_FILTERS.impacts).toEqual(IMPACT_LEVELS.map((i) => i.value))
    expect(DEFAULT_FILTERS.impacts).toContain('holiday')
  })

  it('starts with every event type', () => {
    expect(DEFAULT_FILTERS.types).toEqual(EVENT_TYPES)
  })

  // The Filter button's count is what tells a trader something is hidden
  // before they open the panel. On a fresh install exactly one section is
  // narrowed - currencies - so a 0 here would be a silent filter and a 2
  // would mean impact or type had quietly stopped showing everything.
  it('reports exactly one narrowed section on a fresh install', () => {
    expect(activeSectionCount(DEFAULT_FILTERS)).toBe(1)
  })
})

describe('isNarrowed', () => {
  it('is false when every option is selected', () => {
    expect(isNarrowed(['a', 'b'], ['a', 'b'])).toBe(false)
  })

  it('is true when one is missing', () => {
    expect(isNarrowed(['a'], ['a', 'b'])).toBe(true)
  })

  // The historical bug: a stored value with the right LENGTH but stale
  // names read as "nothing narrowed", so the button said nothing while the
  // card said "No events match these filters".
  it('is true for a right-sized selection holding names that are not options', () => {
    expect(isNarrowed(['a', 'ancient-type'], ['a', 'b'])).toBe(true)
  })
})

describe('normaliseFilters', () => {
  it('keeps arrays it is given', () => {
    const out = normaliseFilters({ impacts: ['high'], types: ['Growth'], currencies: ['EUR'] })
    expect(out).toEqual({ impacts: ['high'], types: ['Growth'], currencies: ['EUR'] })
  })

  it('falls back per field rather than wholesale', () => {
    const out = normaliseFilters({ impacts: ['high'] })
    expect(out.impacts).toEqual(['high'])
    expect(out.types).toEqual(DEFAULT_FILTERS.types)
    expect(out.currencies).toEqual(DEFAULT_FILTERS.currencies)
  })

  it.each([null, undefined, 42, 'nope', { impacts: 'high' }])(
    'never leaves a section undefined for %p',
    (input) => {
      const out = normaliseFilters(input)
      expect(Array.isArray(out.impacts)).toBe(true)
      expect(Array.isArray(out.types)).toBe(true)
      expect(Array.isArray(out.currencies)).toBe(true)
    },
  )
})

describe('readStoredFilters', () => {
  it('returns the defaults when nothing is stored', () => {
    expect(readStoredFilters(fakeStorage())).toEqual(DEFAULT_FILTERS)
  })

  it('restores what was stored', () => {
    const saved = { impacts: ['high'], types: ['Inflation'], currencies: ['GBP', 'USD'] }
    const storage = fakeStorage({ [FILTER_STORAGE_KEY]: JSON.stringify(saved) })
    expect(readStoredFilters(storage)).toEqual(saved)
  })

  it('falls back to the defaults on malformed JSON', () => {
    const storage = fakeStorage({ [FILTER_STORAGE_KEY]: '{not json' })
    expect(readStoredFilters(storage)).toEqual(DEFAULT_FILTERS)
  })

  it('falls back to the defaults when storage access throws', () => {
    expect(readStoredFilters(fakeStorage({}, 'get'))).toEqual(DEFAULT_FILTERS)
  })

  it('falls back to the defaults when there is no storage at all', () => {
    expect(readStoredFilters(null)).toEqual(DEFAULT_FILTERS)
  })
})

describe('writeStoredFilters', () => {
  it('persists a change so the next read restores it', () => {
    const storage = fakeStorage()
    const next = { impacts: ['high', 'medium'], types: ['Growth'], currencies: ['JPY'] }
    expect(writeStoredFilters(next, storage)).toBe(true)
    expect(readStoredFilters(storage)).toEqual(next)
  })

  // The point of the guard: a blocked write must cost the trader the
  // setting between visits, never the ability to change a filter.
  it('reports failure instead of throwing when the write is refused', () => {
    const storage = fakeStorage({}, 'set')
    expect(() => writeStoredFilters(DEFAULT_FILTERS, storage)).not.toThrow()
    expect(writeStoredFilters(DEFAULT_FILTERS, storage)).toBe(false)
  })

  it('reports failure when there is no storage at all', () => {
    expect(writeStoredFilters(DEFAULT_FILTERS, null)).toBe(false)
  })
})

describe('activeSectionCount', () => {
  it('is 0 when nothing is narrowed', () => {
    expect(activeSectionCount({
      impacts: IMPACT_LEVELS.map((i) => i.value),
      types: EVENT_TYPES,
      currencies: CURRENCIES,
    })).toBe(0)
  })

  it('counts each narrowed section once', () => {
    expect(activeSectionCount({ impacts: ['high'], types: ['Growth'], currencies: ['USD'] })).toBe(3)
  })
})
