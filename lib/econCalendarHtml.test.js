import { describe, it, expect } from 'vitest'
import { parseCalendarHtml, parseClockMinutes, weekUrl, monthUrl } from './econCalendarHtml.mjs'

// Real markup, copied verbatim out of a live fetch of
// forexfactory.com/calendar?week=aug28.2026 (printed by
// scripts/probe-forexfactory-sources.js). Trimmed only of the sub/detail/
// graph cells, which carry no data this parser reads. Every quirk below is
// FF's, not invented for the test:
//   - the day-breaker row, which is a heading and not an event
//   - the first row of a day carrying data-day-dateline and a rowspan'd
//     date cell, and later rows carrying neither
//   - blank time cells on rows that share the time above them
//   - actual spans classed better/worse, and an unclassed one
//   - a previous span classed "revised"
const FIXTURE = `
<tr class="calendar__row calendar__row--day-breaker "> <td colspan="10" class="calendar__cell">Fri <span>Aug 28</span></td> </tr>
<tr data-event-id="151185" data-day-dateline="1787893200" class="calendar__row calendar__row--new-day   calendar__row--grey  "> <td class="calendar__cell calendar__date" rowspan="18"><span class="date">Fri <span>Aug 28</span></span></td> <td class="calendar__cell calendar__time">1:00am</td> <td class="calendar__cell calendar__currency">EUR</td> <td class="calendar__cell calendar__impact"><span class="icon icon--ff-impact-yel"></span></td> <td class="calendar__cell calendar__event"> <div class="calendar__event-wrapper"> <span class="calendar__event-title-wrapper fadeout-end"> <span class="calendar__event-title">German Import Prices m/m</span> </span> </div> </td> <td class="calendar__cell calendar__actual"><span class="worse">0.2%</span></td> <td class="calendar__cell calendar__forecast"><span>0.3%</span></td> <td class="calendar__cell calendar__previous"> <span>-0.7%</span> </td> </tr>
<tr data-event-id="147580"  class="calendar__row    calendar__row--grey  "> <td class="calendar__cell calendar__time">1:45am</td> <td class="calendar__cell calendar__currency">EUR</td> <td class="calendar__cell calendar__impact"><span class="icon icon--ff-impact-yel"></span></td> <td class="calendar__cell calendar__event"> <div class="calendar__event-wrapper"> <span class="calendar__event-title-wrapper fadeout-end"> <span class="calendar__event-title">French Consumer Spending m/m</span> </span> </div> </td> <td class="calendar__cell calendar__actual"><span class="better">0.5%</span></td> <td class="calendar__cell calendar__forecast"><span>0.1%</span></td> <td class="calendar__cell calendar__previous"> <span class="revised better">0.6%<img class="svg-img" width="5" height="7" src="x.svg"></span> </td> </tr>
<tr data-event-id="151730"  class="calendar__row   calendar__row--no-grid calendar__row--grey  "> <td class="calendar__cell calendar__time"></td> <td class="calendar__cell calendar__currency">EUR</td> <td class="calendar__cell calendar__impact"><span class="icon icon--ff-impact-yel"></span></td> <td class="calendar__cell calendar__event"> <div class="calendar__event-wrapper"> <span class="calendar__event-title-wrapper fadeout-end"> <span class="calendar__event-title">French Final Private Payrolls q/q</span> </span> </div> </td> <td class="calendar__cell calendar__actual"><span class="">-0.1%</span></td> <td class="calendar__cell calendar__forecast"><span>-0.1%</span></td> <td class="calendar__cell calendar__previous"> <span>-0.1%</span> </td> </tr>
<tr data-event-id="150001"  class="calendar__row  "> <td class="calendar__cell calendar__time">8:30am</td> <td class="calendar__cell calendar__currency">USD</td> <td class="calendar__cell calendar__impact"><span class="icon icon--ff-impact-red"></span></td> <td class="calendar__cell calendar__event"> <div class="calendar__event-wrapper"> <span class="calendar__event-title-wrapper fadeout-end"> <span class="calendar__event-title">Core PCE Price Index m/m</span> </span> </div> </td> <td class="calendar__cell calendar__actual"><span class="">0.3%</span></td> <td class="calendar__cell calendar__forecast"><span>0.3%</span></td> <td class="calendar__cell calendar__previous"> <span>0.2%</span> </td> </tr>
<tr data-event-id="150002"  class="calendar__row  "> <td class="calendar__cell calendar__time">All Day</td> <td class="calendar__cell calendar__currency">EUR</td> <td class="calendar__cell calendar__impact"><span class="icon icon--ff-impact-gra"></span></td> <td class="calendar__cell calendar__event"> <div class="calendar__event-wrapper"> <span class="calendar__event-title-wrapper fadeout-end"> <span class="calendar__event-title">German Prelim CPI m/m</span> </span> </div> </td> <td class="calendar__cell calendar__actual"><span></span></td> <td class="calendar__cell calendar__forecast"><span>0.1%</span></td> <td class="calendar__cell calendar__previous"> <span>0.3%</span> </td> </tr>
`

const parsed = () => parseCalendarHtml(FIXTURE)
const byTitle = (t) => parsed().events.find((e) => e.title === t)

describe('parseCalendarHtml', () => {
  it('reads every event row and ignores the day-breaker heading', () => {
    const { events, skipped, days } = parsed()
    expect(events).toHaveLength(5)
    expect(skipped).toBe(0)
    expect(days).toBe(1)
    // The day-breaker's text must not have become an event.
    expect(events.some((e) => /Aug 28/.test(e.title))).toBe(false)
  })

  it('maps a full row onto the stored shape', () => {
    expect(byTitle('German Import Prices m/m')).toEqual({
      event_key: '2026-08-28|EUR|German Import Prices m/m',
      ff_event_id: '151185',
      title: 'German Import Prices m/m',
      currency: 'EUR',
      // 1:00am on a day whose midnight is 1787893200 (= 05:00Z).
      event_time: '2026-08-28T06:00:00.000Z',
      impact: 'low',
      event_type: 'Inflation',
      forecast: '0.3%',
      previous: '-0.7%',
      actual: '0.2%',
      actual_status: 'worse',
      previous_revised: false,
      time_precision: 'exact',
      detail_url: 'https://www.forexfactory.com/calendar?day=aug28.2026',
    })
  })

  // The whole point of the HTML source: the JSON feed has no actual at all.
  it('reads actual values, including FF\'s own beat/miss marking', () => {
    expect(byTitle('German Import Prices m/m').actual).toBe('0.2%')
    expect(byTitle('German Import Prices m/m').actual_status).toBe('worse')
    expect(byTitle('French Consumer Spending m/m').actual_status).toBe('better')
    // An unclassed actual is a real value that simply matched forecast.
    expect(byTitle('French Final Private Payrolls q/q').actual).toBe('-0.1%')
    expect(byTitle('French Final Private Payrolls q/q').actual_status).toBeNull()
  })

  it('reads an empty actual as null rather than an empty string', () => {
    expect(byTitle('German Prelim CPI m/m').actual).toBeNull()
  })

  it('flags a previous figure FF marks as revised', () => {
    expect(byTitle('French Consumer Spending m/m').previous_revised).toBe(true)
    expect(byTitle('French Consumer Spending m/m').previous).toBe('0.6%')
    expect(byTitle('German Import Prices m/m').previous_revised).toBe(false)
  })

  // FF prints the clock once for a group of simultaneous releases; the
  // rows under it have an empty time cell and belong at the same instant.
  it('carries the time forward onto a row with a blank time cell', () => {
    expect(byTitle('French Final Private Payrolls q/q').event_time)
      .toBe(byTitle('French Consumer Spending m/m').event_time)
    expect(byTitle('French Final Private Payrolls q/q').time_precision).toBe('exact')
  })

  it('keeps an All Day row, marked rather than given a fake midnight time', () => {
    const allDay = byTitle('German Prelim CPI m/m')
    expect(allDay.time_precision).toBe('all_day')
    // Anchored to the day's own midnight so it still sorts into the right
    // day, which is the only thing its time can honestly say.
    expect(allDay.event_time).toBe('2026-08-28T05:00:00.000Z')
  })

  it('maps FF\'s impact icons onto the four levels', () => {
    expect(byTitle('Core PCE Price Index m/m').impact).toBe('high')
    expect(byTitle('German Import Prices m/m').impact).toBe('low')
    expect(byTitle('German Prelim CPI m/m').impact).toBe('holiday')
  })

  it('keeps FF\'s own event id', () => {
    expect(byTitle('Core PCE Price Index m/m').ff_event_id).toBe('150001')
    expect(byTitle('German Import Prices m/m').ff_event_id).toBe('151185')
  })

  it('classifies as the shared classifier does, not separately', () => {
    expect(byTitle('Core PCE Price Index m/m').event_type).toBe('Inflation')
  })

  it('returns nothing rather than throwing on markup that is not a calendar', () => {
    expect(parseCalendarHtml('<html><body>Just a moment...</body></html>'))
      .toEqual({ events: [], skipped: 0, days: 0 })
    expect(parseCalendarHtml(null)).toEqual({ events: [], skipped: 0, days: 0 })
  })

  // A day's first row must not inherit the last time of the previous day -
  // that would silently place an early release at the previous evening's
  // hour.
  it('does not carry a time across a day boundary', () => {
    const twoDays = FIXTURE + `
<tr data-event-id="160001" data-day-dateline="1787979600" class="calendar__row calendar__row--new-day "> <td class="calendar__cell calendar__time"></td> <td class="calendar__cell calendar__currency">GBP</td> <td class="calendar__cell calendar__impact"><span class="icon icon--ff-impact-ora"></span></td> <td class="calendar__cell calendar__event"> <span class="calendar__event-title">Nationwide HPI m/m</span> </td> <td class="calendar__cell calendar__actual"><span></span></td> <td class="calendar__cell calendar__forecast"><span>0.2%</span></td> <td class="calendar__cell calendar__previous"> <span>0.1%</span> </td> </tr>`
    const next = parseCalendarHtml(twoDays).events.find((e) => e.title === 'Nationwide HPI m/m')
    expect(next.time_precision).toBe('all_day')
    expect(next.event_time).toBe('2026-08-29T05:00:00.000Z')
    expect(parseCalendarHtml(twoDays).days).toBe(2)
  })
})

describe('parseClockMinutes', () => {
  it.each([
    ['12:00am', 0],
    ['1:00am', 60],
    ['1:45am', 105],
    ['12:30pm', 750],
    ['8:30am', 510],
    ['11:59pm', 1439],
  ])('parses %s', (text, expected) => {
    expect(parseClockMinutes(text)).toBe(expected)
  })

  it('rejects anything that is not a clock time', () => {
    for (const text of ['All Day', 'Tentative', '', 'Day 1', '24h']) {
      expect(parseClockMinutes(text)).toBeNull()
    }
  })
})

describe('url builders', () => {
  it('use FF\'s own date spelling', () => {
    expect(weekUrl(new Date('2026-08-28T12:00:00Z'))).toBe('https://www.forexfactory.com/calendar?week=aug28.2026')
    expect(monthUrl(new Date('2026-09-03T12:00:00Z'))).toBe('https://www.forexfactory.com/calendar?month=sep.2026')
  })
})
