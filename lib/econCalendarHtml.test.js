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

// Each case below reproduced a real bug before the fix that follows it.
// The fixtures are built rather than copied because they describe days
// that don't appear in the captured page - DST transitions, an evening
// row, markup FF could plausibly move to.
describe('parseCalendarHtml: days that broke it', () => {
  const row = (dateline, time, title, currency = 'USD', eventCell = '') =>
    `<tr data-event-id="1" data-day-dateline="${dateline}" class="calendar__row calendar__row--new-day"> `
    + `<td class="calendar__cell calendar__time">${time}</td> `
    + `<td class="calendar__cell calendar__currency">${currency}</td> `
    + '<td class="calendar__cell calendar__impact"><span class="icon icon--ff-impact-red"></span></td> '
    + `<td class="calendar__cell calendar__event">${eventCell || `<span class="calendar__event-title">${title}</span>`}</td> `
    + '<td class="calendar__cell calendar__actual"><span></span></td> '
    + '<td class="calendar__cell calendar__forecast"><span></span></td> '
    + '<td class="calendar__cell calendar__previous"><span></span></td> </tr>'

  const dateline = (iso) => Math.floor(Date.parse(iso) / 1000)
  // What an instant reads as on FF's own clock - the only check that
  // matters, since the whole job is "store what the page said".
  const inFfZone = (iso) => new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour12: true, hour: 'numeric', minute: '2-digit',
  }).format(new Date(iso))

  // Midnight + wall-clock minutes is only the right instant when the
  // offset doesn't change in between. On the two days a year it does,
  // every row after the transition was an hour out - silently, and in
  // opposite directions in spring and autumn.
  it('stores the time FF printed on a day the clocks go back', () => {
    // 2026-11-01: Chicago midnight is CDT, 8:30am is CST.
    const e = parseCalendarHtml(row(dateline('2026-11-01T05:00:00Z'), '8:30am', 'Nonfarm Payrolls')).events[0]
    expect(inFfZone(e.event_time)).toBe('8:30 AM')
    expect(e.event_time).toBe('2026-11-01T14:30:00.000Z')
  })

  it('stores the time FF printed on a day the clocks go forward', () => {
    // 2026-03-08: Chicago midnight is CST, 5:00pm is CDT.
    const e = parseCalendarHtml(row(dateline('2026-03-08T06:00:00Z'), '5:00pm', 'Flash PMI')).events[0]
    expect(inFfZone(e.event_time)).toBe('5:00 PM')
    expect(e.event_time).toBe('2026-03-08T22:00:00.000Z')
  })

  it('leaves an ordinary day untouched', () => {
    const e = parseCalendarHtml(row(dateline('2026-08-28T05:00:00Z'), '8:30am', 'Core PCE')).events[0]
    expect(e.event_time).toBe('2026-08-28T13:30:00.000Z')
  })

  // An evening row is already the next day in UTC. Keying on the UTC day
  // gave a Thursday-evening speech and a Friday-morning one by the same
  // speaker one identity, and the batch's own de-duplication then dropped
  // the earlier of the two before it ever reached the database.
  it('keeps two same-titled events a day apart distinct', () => {
    const html = row(dateline('2026-08-28T05:00:00Z'), '7:30pm', 'BOJ Gov Ueda Speaks', 'JPY')
      + row(dateline('2026-08-29T05:00:00Z'), '10:00am', 'BOJ Gov Ueda Speaks', 'JPY')
    const { events } = parseCalendarHtml(html)
    expect(events).toHaveLength(2)
    expect(events.map((e) => e.event_key)).toEqual([
      '2026-08-28|JPY|BOJ Gov Ueda Speaks',
      '2026-08-29|JPY|BOJ Gov Ueda Speaks',
    ])
  })

  it('links an evening row to the FF day it was listed under', () => {
    const e = parseCalendarHtml(row(dateline('2026-08-28T05:00:00Z'), '7:30pm', 'BOJ Press Conference', 'JPY')).events[0]
    // The instant is already Aug 29 in UTC; the page had it under Aug 28.
    expect(e.event_time.slice(0, 10)).toBe('2026-08-29')
    expect(e.detail_url).toBe('https://www.forexfactory.com/calendar?day=aug28.2026')
  })

  // A tag inside the title span ended the old non-greedy match early,
  // giving an empty title - and the row was then dropped by a `continue`
  // that never incremented `skipped`, so a run losing events still
  // reported a clean zero.
  it('reads a title that contains nested markup', () => {
    const html = row(dateline('2026-08-28T05:00:00Z'), '2:00pm', null, 'USD',
      '<span class="calendar__event-title"><span class="icon flag"></span>FOMC Statement</span>')
    const { events, skipped } = parseCalendarHtml(html)
    expect(events).toHaveLength(1)
    expect(events[0].title).toBe('FOMC Statement')
    expect(skipped).toBe(0)
  })

  it('counts a title span it cannot read rather than dropping it silently', () => {
    const html = row(dateline('2026-08-28T05:00:00Z'), '2:00pm', null, 'USD',
      '<span class="calendar__event-title"></span>')
    const { events, skipped } = parseCalendarHtml(html)
    expect(events).toHaveLength(0)
    expect(skipped).toBe(1)
  })

  // If FF ever moves the attribute onto the day-breaker heading, reading
  // it only on non-breaker rows would stamp every later day with the
  // previous day's date.
  it('reads a dateline carried on a day-breaker row', () => {
    const html = '<tr class="calendar__row calendar__row--day-breaker" data-day-dateline="'
      + dateline('2026-08-29T05:00:00Z') + '"> <td colspan="10" class="calendar__cell">Sat <span>Aug 29</span></td> </tr>'
      + '<tr data-event-id="7" class="calendar__row"> <td class="calendar__cell calendar__time">9:00am</td> '
      + '<td class="calendar__cell calendar__currency">USD</td> '
      + '<td class="calendar__cell calendar__impact"><span class="icon icon--ff-impact-red"></span></td> '
      + '<td class="calendar__cell calendar__event"><span class="calendar__event-title">Some Release</span></td> '
      + '<td class="calendar__cell calendar__actual"><span></span></td> '
      + '<td class="calendar__cell calendar__forecast"><span></span></td> '
      + '<td class="calendar__cell calendar__previous"><span></span></td> </tr>'
    const { events } = parseCalendarHtml(html)
    expect(events).toHaveLength(1)
    expect(events[0].event_key).toBe('2026-08-29|USD|Some Release')
  })

  // FF writes apostrophes as &#039;. The old named-entity list missed the
  // numeric forms, so the raw entity ended up in the title AND in the
  // event key built from it.
  it('decodes numeric entities in a title', () => {
    const e = parseCalendarHtml(row(dateline('2026-08-28T05:00:00Z'), '9:00am', 'Moody&#039;s Rating Review')).events[0]
    expect(e.title).toBe("Moody's Rating Review")
    expect(e.event_key).toBe("2026-08-28|USD|Moody's Rating Review")
  })

  // A chain of .replace() calls decoded its own output: &amp;lt; became
  // &lt; on the &amp; pass and then a literal < on the &lt; pass,
  // inventing markup the source never contained.
  it('does not decode an entity twice', () => {
    const e = parseCalendarHtml(row(dateline('2026-08-28T05:00:00Z'), '9:00am', 'Rate &amp;lt;test&amp;gt;')).events[0]
    expect(e.title).toBe('Rate &lt;test&gt;')
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
