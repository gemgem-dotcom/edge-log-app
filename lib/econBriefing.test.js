import { describe, it, expect } from 'vitest'
import { buildTodaysBrief, meaningFor, framingFor, figureValue } from './econBriefing'

// A local-day clock, so the "today" boundary tests mean what they say
// regardless of the machine's zone.
const NOON = new Date(2026, 9, 26, 12, 0, 0)
const at = (h, m = 0) => new Date(2026, 9, 26, h, m, 0).toISOString()
const dayBefore = (h) => new Date(2026, 9, 25, h, 0, 0).toISOString()
const dayAfter = (h) => new Date(2026, 9, 27, h, 0, 0).toISOString()

const ev = (over = {}) => ({
  event_key: 'ff|1',
  title: 'CPI m/m',
  currency: 'USD',
  impact: 'high',
  event_type: 'Inflation',
  event_time: at(8, 30),
  forecast: '0.3%',
  previous: '0.2%',
  ...over,
})

describe('buildTodaysBrief - what is allowed to appear', () => {
  it('returns null when there is nothing high or medium today', () => {
    expect(buildTodaysBrief({ events: [], now: NOON })).toBeNull()
    expect(buildTodaysBrief({ events: [ev({ impact: 'low' })], now: NOON })).toBeNull()
    expect(buildTodaysBrief({ events: [ev({ impact: 'holiday' })], now: NOON })).toBeNull()
  })

  it('drops low and no-impact releases while keeping high and medium', () => {
    const brief = buildTodaysBrief({
      events: [
        ev({ event_key: 'a', impact: 'low', title: 'Retail Sales' }),
        ev({ event_key: 'b', impact: 'medium', title: 'PPI m/m' }),
        ev({ event_key: 'c', impact: 'high' }),
      ],
      now: NOON,
    })
    expect(brief.events.map((e) => e.event.event_key)).toEqual(['b', 'c'])
    expect(brief.highCount).toBe(1)
  })

  it('drops non-USD releases', () => {
    expect(buildTodaysBrief({ events: [ev({ currency: 'EUR' })], now: NOON })).toBeNull()
  })

  // The bug this guards: a rolling 24-hour window puts TOMORROW's early
  // release into "today's brief" once the evening comes round.
  it('is a local day, not a rolling 24 hours', () => {
    const brief = buildTodaysBrief({
      events: [
        ev({ event_key: 'yesterday', event_time: dayBefore(22) }),
        ev({ event_key: 'today', event_time: at(8, 30) }),
        ev({ event_key: 'tomorrow', event_time: dayAfter(7) }),
      ],
      now: NOON,
    })
    expect(brief.events.map((e) => e.event.event_key)).toEqual(['today'])
  })

  it('keeps a release that has already printed today', () => {
    // 08:30 with a noon clock - still today's news, and the actual is what
    // the trader wants to see.
    const brief = buildTodaysBrief({ events: [ev({ actual: '0.4%' })], now: NOON })
    expect(brief.events).toHaveLength(1)
  })

  it('orders by time, soonest first', () => {
    const brief = buildTodaysBrief({
      events: [ev({ event_key: 'late', event_time: at(14) }), ev({ event_key: 'early', event_time: at(8, 30) })],
      now: NOON,
    })
    expect(brief.events.map((e) => e.event.event_key)).toEqual(['early', 'late'])
  })
})

describe('framingFor - both sides, every time', () => {
  // The whole point of the feature. If this test ever fails, the card has
  // started taking a side.
  it('states the hawkish and the dovish reading for every framed release', () => {
    for (const title of ['CPI m/m', 'Core PPI m/m', 'Non-Farm Employment Change', 'Retail Sales m/m', 'Unemployment Claims']) {
      const text = framingFor(ev({ title, forecast: '0.3%', previous: '0.2%' }))
      expect(text, title).toBeTruthy()
      expect(text, title).toContain('restrictive')
      expect(text, title).toContain('policy easing sooner')
    }
  })

  it('gives the two sides equal weight, not just equal presence', () => {
    // Generated from one template with the direction flipped, so neither
    // clause can quietly grow more hedging or more words than the other.
    const text = framingFor(ev())
    const [, hawk, dove] = text.match(/A print above it ([^;]+); below it ([^.]+)\./)
    expect(hawk.split(' ').length).toBe(dove.split(' ').length)
  })

  it('flips which direction is hawkish for claims, where higher is weaker', () => {
    const cpi = framingFor(ev({ title: 'CPI m/m' }))
    const claims = framingFor(ev({ title: 'Unemployment Claims', event_type: 'Employment' }))
    expect(cpi).toContain('A print above it strengthens the case for policy staying restrictive')
    expect(claims).toContain('A print above it strengthens the case for policy easing sooner')
  })

  it('reports the forecast against the previous print in both directions', () => {
    expect(framingFor(ev({ forecast: '0.3%', previous: '0.2%' }))).toContain('above the previous 0.2%')
    expect(framingFor(ev({ forecast: '0.1%', previous: '0.2%' }))).toContain('below the previous 0.2%')
    expect(framingFor(ev({ forecast: '0.2%', previous: '0.2%' }))).toContain('level with the previous print')
  })

  it('returns null rather than guessing when there is no forecast', () => {
    expect(framingFor(ev({ forecast: null }))).toBeNull()
    expect(framingFor(ev({ forecast: 'n/a' }))).toBeNull()
  })

  it('frames sentiment and activity surveys, which do carry a forecast', () => {
    const text = framingFor(ev({ title: 'CB Consumer Confidence', event_type: 'Consumer Surveys', forecast: '98.5', previous: '97.2' }))
    expect(text).toContain('A print above it strengthens the case for policy staying restrictive')
  })

  it('returns null for releases whose direction does not map onto policy', () => {
    expect(framingFor(ev({ title: '10-y Bond Auction', event_type: 'Bonds', forecast: '4.2%' }))).toBeNull()
    expect(framingFor(ev({ title: 'FOMC Member Williams Speaks', event_type: 'Speeches', forecast: '1.0' }))).toBeNull()
    // Housing cuts both ways - see hawkishOnHigher's comment.
    expect(framingFor(ev({ title: 'New Home Sales', event_type: 'Housing', forecast: '640K', previous: '620K' }))).toBeNull()
  })

  it('never predicts the print', () => {
    const text = framingFor(ev())
    expect(text).not.toMatch(/\bwill (be|come|print|rise|fall)\b/i)
    expect(text).toContain('Both readings are live until the number lands')
  })
})

describe('meaningFor', () => {
  it('prefers the more specific title over the headline one', () => {
    expect(meaningFor({ title: 'Core CPI m/m' }).what).toContain('food and energy stripped out')
    expect(meaningFor({ title: 'CPI m/m' }).what).toContain('basket of goods')
  })

  it('explains what the release moves, not just what it is', () => {
    const m = meaningFor({ title: 'Non-Farm Employment Change' })
    expect(m.what).toBeTruthy()
    expect(m.affects).toBeTruthy()
  })

  it('falls back to the event type for a release it has never seen', () => {
    const m = meaningFor({ title: 'Some Novel Index q/q', event_type: 'Growth' })
    expect(m.what).toBe('a growth reading')
  })

  it('always returns something, even with no type at all', () => {
    expect(meaningFor({ title: '' }).what).toBeTruthy()
    expect(meaningFor({}).what).toBeTruthy()
  })
})

describe('figureValue', () => {
  it('reads FF figures in the forms the table actually stores', () => {
    expect(figureValue('0.3%')).toBe(0.3)
    expect(figureValue('-0.2%')).toBe(-0.2)
    expect(figureValue('250K')).toBe(250)
    expect(figureValue('1,250K')).toBe(1250)
    expect(figureValue('4.2')).toBe(4.2)
  })

  it('is null for the empty forms, not 0', () => {
    expect(figureValue(null)).toBeNull()
    expect(figureValue('')).toBeNull()
    expect(figureValue('n/a')).toBeNull()
    expect(figureValue('—')).toBeNull()
  })
})
