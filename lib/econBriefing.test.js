import { describe, it, expect } from 'vitest'
import { buildTodaysBrief, meaningFor, framingFor, figureValue, nextEventSentence, consensusBias } from './econBriefing'

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

describe('nextEventSentence - never states a time it has not read', () => {
  // The whole reason this exists: the card hardcoded "CPI drops at 08:30"
  // and printed it on days CPI was nowhere near the calendar.
  it('names the real next release and its real time', () => {
    const events = [ev({ title: 'Retail Sales m/m', event_time: at(14, 0) })]
    expect(nextEventSentence(events, NOON)).toMatch(/^Retail Sales m\/m lands at /)
  })

  it('returns null when there is no upcoming release, rather than inventing one', () => {
    expect(nextEventSentence([], NOON)).toBeNull()
    // Today's only release already printed this morning.
    expect(nextEventSentence([ev({ event_time: at(8, 30) })], NOON)).toBeNull()
    // Low impact does not qualify.
    expect(nextEventSentence([ev({ impact: 'low', event_time: at(14) })], NOON)).toBeNull()
    // Nor does a non-USD release.
    expect(nextEventSentence([ev({ currency: 'EUR', event_time: at(14) })], NOON)).toBeNull()
  })

  it('picks the soonest upcoming release, not the first in the list', () => {
    const events = [
      ev({ title: 'Later', event_time: at(16) }),
      ev({ title: 'Sooner', event_time: at(13) }),
    ]
    expect(nextEventSentence(events, NOON)).toMatch(/^Sooner lands at /)
  })

  it('says so when the next one is not today', () => {
    expect(nextEventSentence([ev({ title: 'CPI m/m', event_time: dayAfter(8) })], NOON))
      .toMatch(/^CPI m\/m lands tomorrow at /)
  })

  it('does not quote a clock time for an all-day row', () => {
    const midnight = new Date(2026, 9, 27, 0, 0, 0).toISOString()
    expect(nextEventSentence([ev({ title: 'Bank Holiday', event_time: midnight })], NOON))
      .toBe('Bank Holiday is on the calendar tomorrow.')
  })
})

describe('consensusBias - real record, not a forecast of the forecast', () => {
  const print = (actual, forecast) => ({ actual, forecast })

  it('reports a run of upside surprises', () => {
    const bias = consensusBias([print('0.4%', '0.3%'), print('0.5%', '0.3%'), print('0.4%', '0.2%')])
    expect(bias.above).toBe(3)
    expect(bias.verdict).toBe('all 3 came in above forecast')
  })

  it('reports a mixed record honestly rather than rounding to a narrative', () => {
    const bias = consensusBias([print('0.4%', '0.3%'), print('0.1%', '0.3%'), print('0.3%', '0.3%')])
    expect(bias.verdict).toBe('1 above, 1 below, 1 on forecast')
  })

  it('needs at least three prints before it claims a pattern', () => {
    expect(consensusBias([print('0.4%', '0.3%'), print('0.5%', '0.3%')])).toBeNull()
    expect(consensusBias([])).toBeNull()
    expect(consensusBias(null)).toBeNull()
  })

  it('ignores prints with nothing to compare', () => {
    const bias = consensusBias([
      print('0.4%', '0.3%'), print('0.5%', '0.3%'), print('0.4%', '0.3%'),
      print(null, '0.3%'), print('0.2%', null),
    ])
    expect(bias.prints).toBe(3)
  })

  it('reads at most the bias window, so it describes the current regime', () => {
    const many = Array.from({ length: 12 }, () => print('0.4%', '0.3%'))
    expect(consensusBias(many).prints).toBe(6)
  })
})

describe('buildTodaysBrief attaches each release its own history', () => {
  it('keys history by title, since event_key changes every month', () => {
    const brief = buildTodaysBrief({
      events: [ev({ title: 'CPI m/m' }), ev({ event_key: 'b', title: 'PPI m/m', impact: 'medium', event_time: at(10) })],
      now: NOON,
      history: [
        { title: 'CPI m/m', actual: '0.4%', forecast: '0.3%' },
        { title: 'CPI m/m', actual: '0.5%', forecast: '0.3%' },
        { title: 'CPI m/m', actual: '0.4%', forecast: '0.2%' },
        { title: 'PPI m/m', actual: '0.1%', forecast: '0.3%' },
      ],
    })
    const cpi = brief.events.find((e) => e.event.title === 'CPI m/m')
    const ppi = brief.events.find((e) => e.event.title === 'PPI m/m')
    expect(cpi.bias.verdict).toBe('all 3 came in above forecast')
    // One print is not a record.
    expect(ppi.bias).toBeNull()
  })

  it('works with no history at all', () => {
    const brief = buildTodaysBrief({ events: [ev()], now: NOON })
    expect(brief.events[0].bias).toBeNull()
  })
})
