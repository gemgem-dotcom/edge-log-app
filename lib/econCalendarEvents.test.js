import { describe, it, expect } from 'vitest'
import {
  EVENT_TYPES,
  CURRENCIES,
  GLOBAL_CURRENCY,
  detailUrlFor,
  classifyEventType,
  normalizeImpact,
  cleanFigure,
  eventKey,
  normalizeFeedEvent,
  normalizeFeed,
} from './econCalendarEvents.mjs'

describe('classifyEventType', () => {
  it('always returns a type that exists in the filter list', () => {
    for (const title of ['GDP q/q', 'Something Nobody Has Ever Released', '', 'ADP Non-Farm Employment Change']) {
      expect(EVENT_TYPES).toContain(classifyEventType(title))
    }
  })

  it.each([
    ['CPI m/m', 'Inflation'],
    ['Core PCE Price Index m/m', 'Inflation'],
    ['Non-Farm Employment Change', 'Employment'],
    ['Unemployment Claims', 'Employment'],
    ['Average Hourly Earnings m/m', 'Employment'],
    ['GDP q/q', 'Growth'],
    ['Retail Sales m/m', 'Growth'],
    ['Building Permits', 'Housing'],
    ['Existing Home Sales', 'Housing'],
    ['30-y Bond Auction', 'Bonds'],
    ['CB Consumer Confidence', 'Consumer Surveys'],
    ['UoM Consumer Sentiment', 'Consumer Surveys'],
    ['ISM Manufacturing PMI', 'Business Surveys'],
    ['ZEW Economic Sentiment', 'Business Surveys'],
    ['Federal Funds Rate', 'Central Bank'],
    ['FOMC Statement', 'Central Bank'],
    ['Crude Oil Inventories', 'Misc'],
    ['Bank Holiday', 'Misc'],
    // Both spellings FF actually ships - the plural was falling into Misc
    // until a real payload showed it up.
    ['Leading Indicators', 'Growth'],
    ['Leading Index', 'Growth'],
  ])('classifies %s as %s', (title, expected) => {
    expect(classifyEventType(title)).toBe(expected)
  })

  // The two ordering traps the pattern list is deliberately sequenced
  // around - both of these classify wrongly if the order is ever shuffled,
  // which is exactly why they have their own test rather than sitting in
  // the table above.
  it('reads a speech as a speech even though its title names a central bank', () => {
    expect(classifyEventType('FOMC Member Williams Speaks')).toBe('Speeches')
    expect(classifyEventType('BOE Gov Bailey Speaks')).toBe('Speeches')
    expect(classifyEventType('Fed Chair Powell Testifies')).toBe('Speeches')
  })

  it('does not mistake a price index for a consumer survey', () => {
    expect(classifyEventType('Consumer Price Index y/y')).toBe('Inflation')
    // Neither a survey nor inflation - the survey patterns are whole
    // phrases precisely so this lands elsewhere.
    expect(classifyEventType('Consumer Credit m/m')).toBe('Misc')
  })
})

describe('normalizeImpact', () => {
  it.each([
    ['High', 'high'],
    ['medium', 'medium'],
    ['LOW', 'low'],
    ['Holiday', 'holiday'],
    ['Non-Economic', 'holiday'],
  ])('maps %s to %s', (raw, expected) => {
    expect(normalizeImpact(raw)).toBe(expected)
  })

  it('treats an unrecognised level as non-economic rather than market-moving', () => {
    expect(normalizeImpact(undefined)).toBe('holiday')
    expect(normalizeImpact('Catastrophic')).toBe('holiday')
  })
})

describe('cleanFigure', () => {
  it('collapses every "no figure" spelling to null', () => {
    expect(cleanFigure('')).toBeNull()
    expect(cleanFigure('   ')).toBeNull()
    expect(cleanFigure('N/A')).toBeNull()
    expect(cleanFigure(null)).toBeNull()
    expect(cleanFigure(undefined)).toBeNull()
  })

  it('keeps a real figure, trimmed', () => {
    expect(cleanFigure(' 0.3% ')).toBe('0.3%')
    expect(cleanFigure('-1.2M')).toBe('-1.2M')
    // A genuine zero is a real reading, not an empty one.
    expect(cleanFigure('0')).toBe('0')
  })
})

describe('detailUrlFor', () => {
  it('builds FF\'s own day URL in its own format', () => {
    expect(detailUrlFor(new Date('2026-03-11T12:30:00Z'))).toBe('https://www.forexfactory.com/calendar?day=mar11.2026')
    // No zero padding, and single-digit days stay single-digit - that's
    // the form forexfactory.com itself uses.
    expect(detailUrlFor(new Date('2026-09-07T01:30:00Z'))).toBe('https://www.forexfactory.com/calendar?day=sep7.2026')
  })

  it('agrees with eventKey about which day a row belongs to', () => {
    // Late-UTC-evening instant: both must resolve the same calendar day,
    // or a row's key and its link point at different dates.
    const at = new Date('2026-12-31T23:45:00Z')
    expect(detailUrlFor(at)).toContain('dec31.2026')
    expect(eventKey({ eventTime: at, currency: 'USD', title: 'x' }).startsWith('2026-12-31')).toBe(true)
  })

  it('returns null rather than a nonsense url for an unparseable date', () => {
    expect(detailUrlFor('not a date')).toBeNull()
  })
})

describe('eventKey', () => {
  it('is stable when only the scheduled time moves', () => {
    const morning = eventKey({ eventTime: new Date('2026-03-11T12:30:00Z'), currency: 'USD', title: 'CPI m/m' })
    const shifted = eventKey({ eventTime: new Date('2026-03-11T13:00:00Z'), currency: 'USD', title: 'CPI m/m' })
    expect(shifted).toBe(morning)
  })

  it('separates the same release on different days, currencies or titles', () => {
    const base = { eventTime: new Date('2026-03-11T12:30:00Z'), currency: 'USD', title: 'CPI m/m' }
    expect(eventKey({ ...base, eventTime: new Date('2026-03-12T12:30:00Z') })).not.toBe(eventKey(base))
    expect(eventKey({ ...base, currency: 'EUR' })).not.toBe(eventKey(base))
    expect(eventKey({ ...base, title: 'Core CPI m/m' })).not.toBe(eventKey(base))
  })
})

describe('normalizeFeedEvent', () => {
  const raw = {
    title: 'CPI m/m',
    country: 'USD',
    date: '2026-03-11T08:30:00-04:00',
    impact: 'High',
    forecast: '0.3%',
    previous: '0.2%',
    url: 'https://www.forexfactory.com/calendar?day=mar11.2026',
  }

  it('maps a full record onto the stored row shape', () => {
    expect(normalizeFeedEvent(raw)).toEqual({
      event_key: '2026-03-11|USD|CPI m/m',
      title: 'CPI m/m',
      currency: 'USD',
      event_time: '2026-03-11T12:30:00.000Z',
      impact: 'high',
      event_type: 'Inflation',
      forecast: '0.3%',
      previous: '0.2%',
      actual: null,
      detail_url: 'https://www.forexfactory.com/calendar?day=mar11.2026',
    })
  })

  // The live feed carries no url field, so this is the normal path, not
  // the fallback - every stored row's detail_url is built, not read.
  it('builds a detail url when the feed carries none', () => {
    const { url, ...withoutUrl } = raw
    expect(normalizeFeedEvent(withoutUrl).detail_url)
      .toBe('https://www.forexfactory.com/calendar?day=mar11.2026')
  })

  // FF files global events (OPEC, G20) under country "All". It normalises
  // like any other code, but is deliberately kept OUT of the checkbox list
  // - the card exempts it from currency filtering instead, so it stays
  // visible without a checkbox that reads like a select-all toggle.
  it('normalises the feed\'s "All" currency to the global marker', () => {
    const row = normalizeFeedEvent({ ...raw, country: 'All', title: 'OPEC-JMMC Meetings' })
    expect(row.currency).toBe(GLOBAL_CURRENCY)
    expect(CURRENCIES).not.toContain(GLOBAL_CURRENCY)
  })

  it('reads the currency under either field name the feed has used', () => {
    const { country, ...withoutCountry } = raw
    expect(normalizeFeedEvent({ ...withoutCountry, currency: 'eur' }).currency).toBe('EUR')
  })

  it('picks up an actual once the release is out', () => {
    expect(normalizeFeedEvent({ ...raw, actual: '0.4%' }).actual).toBe('0.4%')
  })

  it('rejects a record with no title or no usable date', () => {
    expect(normalizeFeedEvent({ ...raw, title: '   ' })).toBeNull()
    expect(normalizeFeedEvent({ ...raw, date: 'not a date' })).toBeNull()
    expect(normalizeFeedEvent(null)).toBeNull()
  })
})

describe('normalizeFeed', () => {
  const at = (date, title) => ({ title, country: 'USD', date, impact: 'Low' })

  it('counts the unusable records instead of failing the whole batch', () => {
    const { events, skipped } = normalizeFeed([
      at('2026-03-11T08:30:00Z', 'CPI m/m'),
      { title: 'Broken', country: 'USD', date: 'nonsense' },
      at('2026-03-12T08:30:00Z', 'Retail Sales m/m'),
    ])
    expect(events).toHaveLength(2)
    expect(skipped).toBe(1)
  })

  // The overlapping week feeds really do repeat events at their edges, and
  // Postgres rejects an upsert batch naming the same key twice.
  it('collapses duplicate keys so one upsert batch can never name a key twice', () => {
    const { events } = normalizeFeed([
      at('2026-03-11T08:30:00Z', 'CPI m/m'),
      at('2026-03-11T09:00:00Z', 'CPI m/m'),
    ])
    expect(events).toHaveLength(1)
    // Last one in wins, so a refetch carries the newer scheduled time.
    expect(events[0].event_time).toBe('2026-03-11T09:00:00.000Z')
  })

  it('returns an empty batch rather than throwing on a non-array payload', () => {
    expect(normalizeFeed(null)).toEqual({ events: [], skipped: 0 })
  })
})
