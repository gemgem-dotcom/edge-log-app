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
      event_key: 'ff|151185',
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
  // Each synthetic row gets its own FF event id, the way a real page does.
  // These fixtures used to share `data-event-id="1"`, which was harmless
  // while the key was day|currency|title and silently collapsed every row
  // of a page into one once the id became the key. A fixture that cannot
  // tell two rows apart cannot test a parser whose whole job is telling
  // two rows apart, so the id is explicit and unique here, and pinned by
  // hand in the two cases that turn on it.
  let nextId = 1000
  const row = (dateline, time, title, currency = 'USD', eventCell = '', id = null) =>
    `<tr data-event-id="${id || ++nextId}" data-day-dateline="${dateline}" class="calendar__row calendar__row--new-day"> `
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
  //
  // The correction now comes from the page's own shape: a changeover day
  // is simply a day whose dateline is 23 or 25 hours from the next day's,
  // so these fixtures carry the following day the way a real page does.
  // A single-day fixture has nothing to measure against and is correctly
  // left alone - which is why these cases are built as two days.
  const twoDayPage = (d1, time, title, d2) => row(dateline(d1), time, title) + row(dateline(d2), '8:00am', 'Filler')

  it('stores the time FF printed on a day the clocks go back', () => {
    // 2026-11-01 in Chicago: midnight is CDT, 8:30am is CST. The day runs
    // 25 hours, so the naive sum lands an hour early.
    const html = twoDayPage('2026-11-01T05:00:00Z', '8:30am', 'Nonfarm Payrolls', '2026-11-02T06:00:00Z')
    const e = parseCalendarHtml(html).events.find((x) => x.title === 'Nonfarm Payrolls')
    expect(inFfZone(e.event_time)).toBe('8:30 AM')
    expect(e.event_time).toBe('2026-11-01T14:30:00.000Z')
  })

  it('stores the time FF printed on a day the clocks go forward', () => {
    // 2026-03-08 in Chicago: midnight is CST, 5:00pm is CDT. 23-hour day.
    const html = twoDayPage('2026-03-08T06:00:00Z', '5:00pm', 'Flash PMI', '2026-03-09T05:00:00Z')
    const e = parseCalendarHtml(html).events.find((x) => x.title === 'Flash PMI')
    expect(inFfZone(e.event_time)).toBe('5:00 PM')
    expect(e.event_time).toBe('2026-03-08T22:00:00.000Z')
  })

  // The reason the correction is derived rather than looked up. FF picks
  // its display zone from the client's IP - a GitHub runner in Wyoming is
  // served America/Denver, confirmed live - so the old named-zone check
  // never matched and the correction above never actually ran in
  // production. These are the same two days on a Denver page: nothing in
  // the parser knows which zone it is, and both still come out right.
  const inDenver = (iso) => new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver', hour12: true, hour: 'numeric', minute: '2-digit',
  }).format(new Date(iso))

  it('corrects a clocks-go-back day on a page served in a different zone', () => {
    // Midnight MDT -> 8:30am MST, 25-hour day.
    const html = twoDayPage('2026-11-01T06:00:00Z', '8:30am', 'Nonfarm Payrolls', '2026-11-02T07:00:00Z')
    const e = parseCalendarHtml(html).events.find((x) => x.title === 'Nonfarm Payrolls')
    expect(inDenver(e.event_time)).toBe('8:30 AM')
    expect(e.event_time).toBe('2026-11-01T15:30:00.000Z')
  })

  it('corrects a clocks-go-forward day on a page served in a different zone', () => {
    // Midnight MST -> 5:00pm MDT, 23-hour day.
    const html = twoDayPage('2026-03-08T07:00:00Z', '5:00pm', 'Flash PMI', '2026-03-09T06:00:00Z')
    const e = parseCalendarHtml(html).events.find((x) => x.title === 'Flash PMI')
    expect(inDenver(e.event_time)).toBe('5:00 PM')
    expect(e.event_time).toBe('2026-03-08T23:00:00.000Z')
  })

  // FF lists one title twice in a day whenever the same official speaks
  // morning and evening. Two ids, two events - and now two keys that share
  // nothing, rather than two that differ only by a sequence suffix.
  it('keeps two same-day releases of one title apart', () => {
    const d = dateline('2026-08-28T05:00:00Z')
    const html = row(d, '9:00am', 'FOMC Member Bowman Speaks', 'USD', '', '11')
      + row(d, '7:30pm', 'FOMC Member Bowman Speaks', 'USD', '', '22')
    const { events } = parseCalendarHtml(html)
    expect(events).toHaveLength(2)
    expect(events.map((e) => e.event_key).sort()).toEqual(['ff|11', 'ff|22'])
  })

  // ...while a month page listing one event twice is still one event.
  // Same FF id is the test, which is what makes this distinguishable from
  // the case above at all.
  it('still collapses one event that the page lists twice', () => {
    const d = dateline('2026-08-28T05:00:00Z')
    const html = row(d, '9:00am', 'Core PCE', 'USD', '', '33')
      + row(d, '9:30am', 'Core PCE', 'USD', '', '33')
    const { events } = parseCalendarHtml(html)
    expect(events).toHaveLength(1)
    expect(events[0].event_key).toBe('ff|33')
  })

  // What a page is allowed to speak for. The removal pass only deletes
  // rows a page did NOT mention inside these windows, so getting this
  // wrong is the difference between dropping a cancelled speech and
  // dropping a real day of events.
  it('covers each day it parsed, and stops before the last one', () => {
    const html = twoDayPage('2026-08-28T05:00:00Z', '8:30am', 'Core PCE', '2026-08-29T05:00:00Z')
    const { coveredDays, coveredFrom, coveredTo, days } = parseCalendarHtml(html)
    expect(days).toBe(2)
    // One window: the first day. The LAST rendered day is deliberately
    // excluded - it is the one a truncated response leaves half-rendered,
    // so its missing tail would look removed on every cut-short fetch.
    expect(coveredDays).toEqual([['2026-08-28T05:00:00.000Z', '2026-08-29T05:00:00.000Z']])
    expect(coveredFrom).toBe('2026-08-28T05:00:00.000Z')
    expect(coveredTo).toBe('2026-08-29T05:00:00.000Z')
  })

  // A day the page skipped is not a day the page spoke for. Three things
  // make a day go missing - FF dropped its events, its dateline failed to
  // parse, or the response was cut - and only the first makes deleting its
  // rows correct.
  it('excludes a day the page skipped over', () => {
    const d = (iso) => dateline(iso)
    const html = row(d('2026-08-28T05:00:00Z'), '8:30am', 'A')
      + row(d('2026-08-29T05:00:00Z'), '8:30am', 'B')
      + row(d('2026-09-01T05:00:00Z'), '8:30am', 'C')
      + row(d('2026-09-02T05:00:00Z'), '8:30am', 'D')
    const { coveredDays } = parseCalendarHtml(html)
    expect(coveredDays).toEqual([
      ['2026-08-28T05:00:00.000Z', '2026-08-29T05:00:00.000Z'],
      ['2026-09-01T05:00:00.000Z', '2026-09-02T05:00:00.000Z'],
    ])
    // A row stored on the omitted 30th falls in NO window.
    const inAny = coveredDays.some(([a, b]) => '2026-08-30T18:30:00.000Z' >= a && '2026-08-30T18:30:00.000Z' < b)
    expect(inAny).toBe(false)
  })

  // A changeover day is 23 or 25 hours, and the window is the real length.
  // A fixed 24h would reach an hour past a 23-hour day and swallow the
  // next day's all-day rows, which sit exactly on their dateline.
  it('uses the real length of a clock-change day', () => {
    const html = twoDayPage('2026-03-08T06:00:00Z', '5:00pm', 'Flash PMI', '2026-03-09T05:00:00Z')
    const { coveredDays } = parseCalendarHtml(html)
    expect(coveredDays).toEqual([['2026-03-08T06:00:00.000Z', '2026-03-09T05:00:00.000Z']])
    // The next day's local midnight is the window's exclusive end.
    expect(coveredDays[0][1]).toBe('2026-03-09T05:00:00.000Z')
  })

  // One day gives no consecutive pair, so the page speaks for nothing and
  // the removal pass has nothing to act on. Safe by construction.
  it('speaks for no day at all when it parsed only one', () => {
    const one = parseCalendarHtml(row(dateline('2026-08-28T05:00:00Z'), '8:30am', 'Core PCE'))
    expect(one.coveredDays).toEqual([])
    expect(one.coveredFrom).toBeNull()
    expect(one.coveredTo).toBeNull()
  })

  it('reports no range at all for a page with no datelines', () => {
    const { coveredFrom, coveredTo, coveredDays } = parseCalendarHtml('<table><tr class="calendar__row"></tr></table>')
    expect(coveredFrom).toBeNull()
    expect(coveredTo).toBeNull()
    expect(coveredDays).toEqual([])
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
    // Two ids, so two keys, with nothing in common to collide over. The
    // day still has to be right - it drives the link - so that is checked
    // where the day actually lives now.
    expect(new Set(events.map((e) => e.event_key)).size).toBe(2)
    expect(events.map((e) => e.detail_url)).toEqual([
      'https://www.forexfactory.com/calendar?day=aug28.2026',
      'https://www.forexfactory.com/calendar?day=aug29.2026',
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
    // The key is FF's id now, which says nothing about the dateline - so
    // the day is checked through detail_url and event_time, which are
    // what the dateline actually feeds.
    expect(events[0].event_key).toBe('ff|7')
    expect(events[0].detail_url).toBe('https://www.forexfactory.com/calendar?day=aug29.2026')
    expect(events[0].event_time).toBe('2026-08-29T14:00:00.000Z')
  })

  // FF does not always serve the calendar in the same timezone, and the
  // day a row belongs to must not depend on which one it picked. A zone
  // AHEAD of UTC puts the dateline at 23:00Z on the PREVIOUS UTC day, and
  // reading the UTC date straight off it filed every row on that page a
  // day early - key and detail_url both - while event_time stayed right.
  // Caught in production by scripts/inspect-economic-calendar.js: 181 of
  // 1503 backfilled rows, this being one of them verbatim.
  it('files a row under FF\'s day when FF serves a zone ahead of UTC', () => {
    // Midnight on 2 July in a UTC+1 zone is 23:00Z on 1 July.
    const html = row(dateline('2026-07-01T23:00:00Z'), '7:30am', 'CPI m/m', 'CHF')
    const e = parseCalendarHtml(html).events[0]
    expect(e.event_time).toBe('2026-07-02T06:30:00.000Z')
    expect(e.detail_url).toBe('https://www.forexfactory.com/calendar?day=jul2.2026')
  })

  it('still files correctly when FF serves a zone behind UTC', () => {
    // Midnight on 2 July in Chicago is 05:00Z on 2 July.
    const html = row(dateline('2026-07-02T05:00:00Z'), '7:30am', 'CPI m/m', 'CHF')
    const e = parseCalendarHtml(html).events[0]
    expect(e.detail_url).toBe('https://www.forexfactory.com/calendar?day=jul2.2026')
  })

  // The two must agree: one release fetched from pages served in different
  // zones has to keep one identity, or the second fetch inserts a duplicate
  // instead of updating the first.
  it('gives one release the same key from either zone', () => {
    // The same release, so the same FF event id on both pages - that is
    // the premise, not a convenience. Only the ZONE differs, which is what
    // moves the day and used to move the key with it.
    const id = '147316'
    const ahead = parseCalendarHtml(row(dateline('2026-07-01T23:00:00Z'), '7:30am', 'CPI m/m', 'CHF', '', id)).events[0]
    const behind = parseCalendarHtml(row(dateline('2026-07-02T05:00:00Z'), '1:30am', 'CPI m/m', 'CHF', '', id)).events[0]
    expect(ahead.event_key).toBe(behind.event_key)
    expect(ahead.event_key).toBe(`ff|${id}`)
    expect(ahead.event_time).toBe(behind.event_time)
  })

  // Why the id had to replace the day rather than the day being derived
  // better. Both of these pages are RIGHT: 06:00Z is midnight in Mountain
  // and 11pm the previous evening in Pacific, and FF showed each caller
  // its own day. There is no single correct day to derive, so a day-based
  // key had two answers and stored two rows. Measured in production as 174
  // duplicated releases, climbing by ~16 per fetch.
  it('survives FF filing one release under two different days', () => {
    const id = '151175'
    const mountain = parseCalendarHtml(
      row(dateline('2026-08-03T06:00:00Z'), '12:00am', 'German Retail Sales m/m', 'EUR', '', id),
    ).events[0]
    const pacific = parseCalendarHtml(
      row(dateline('2026-08-02T07:00:00Z'), '11:00pm', 'German Retail Sales m/m', 'EUR', '', id),
    ).events[0]

    expect(mountain.event_time).toBe(pacific.event_time)
    expect(mountain.event_key).toBe(pacific.event_key)
    // ...while each still links to the day its own page filed it under.
    expect(mountain.detail_url).toContain('aug3.2026')
    expect(pacific.detail_url).toContain('aug2.2026')
  })

  // FF writes apostrophes as &#039;. The old named-entity list missed the
  // numeric forms, so the raw entity ended up in the title AND in the
  // event key built from it.
  it('decodes numeric entities in a title', () => {
    const e = parseCalendarHtml(row(dateline('2026-08-28T05:00:00Z'), '9:00am', 'Moody&#039;s Rating Review')).events[0]
    expect(e.title).toBe("Moody's Rating Review")
    // The key no longer carries the title, so a stray entity can no longer
    // reach it from this path - but normalizeFeedEvent still builds a
    // day|currency|title key, and that one still can. Covered there.
    expect(e.event_key).not.toContain('&#')
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
