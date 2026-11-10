import { describe, it, expect } from 'vitest'
import { parseCalendarHtml, readPageAnchor } from './econCalendarHtml.mjs'

// WHAT FOREX FACTORY ACTUALLY SENDS around a clock change.
//
// Every (label, dateline, first row) below is copied from a live fetch on
// 2026-11-10 by scripts/probe-forexfactory-datelines.js, from a runner FF
// served US Eastern time. Nothing here is built to behave the way a
// dateline ought to. That is the point: the tests this file replaces in
// spirit were synthetic pages with tidy 23- and 25-hour gaps, FF has never
// emitted one, and the parser they passed had been storing the wrong time
// in production for both changeover weeks of the year.
//
// The row markup is the real shape (see the `raw first day` line the probe
// prints): the dateline and the rowspan'd date cell on a day's first row.

let id = 500000
const day = (label, datelineIso, rows) => {
  const [weekday, ...rest] = label.split(' ')
  const dateline = Date.parse(datelineIso) / 1000
  return rows.map(([time, currency, title], i) => (
    `<tr data-event-id="${++id}"${i === 0 ? ` data-day-dateline="${dateline}"` : ''} class="calendar__row${i === 0 ? ' calendar__row--new-day' : ''} "> `
    + (i === 0 ? `<td class="calendar__cell calendar__date" rowspan="${rows.length}"><span class="date">${weekday} <span>${rest.join(' ')}</span></span></td> ` : '')
    + `<td class="calendar__cell calendar__time">${time}</td> `
    + `<td class="calendar__cell calendar__currency">${currency}</td> `
    + '<td class="calendar__cell calendar__impact"><span class="icon icon--ff-impact-yel"></span></td> '
    + `<td class="calendar__cell calendar__event"><span class="calendar__event-title">${title}</span></td> `
    + '<td class="calendar__cell calendar__actual"><span></span></td> '
    + '<td class="calendar__cell calendar__forecast"><span></span></td> '
    + '<td class="calendar__cell calendar__previous"><span></span></td> </tr>'
  )).join('\n')
}
// A weekend day FF renders with no events on it still has its dateline
// row; the probe shows them as first="". One untitled row stands in.
const emptyDay = (label, datelineIso) => {
  const [weekday, ...rest] = label.split(' ')
  return `<tr data-day-dateline="${Date.parse(datelineIso) / 1000}" class="calendar__row calendar__row--new-day "> `
    + `<td class="calendar__cell calendar__date" rowspan="1"><span class="date">${weekday} <span>${rest.join(' ')}</span></span></td> </tr>`
}

const at = (page, title) => page.events.find((e) => e.title === title)?.event_time

// ?week=nov1.2026 - the week the US clocks go back. EVERY dateline is a
// whole day late: "Sun Nov 1" beside 2026-11-02T04:00Z.
const AUTUMN_WEEK = [
  day('Sun Nov 1', '2026-11-02T04:00:00Z', [['2:00am', 'CAD', 'Daylight Saving Time Shift'], ['8:30pm', 'AUD', 'Evening Print']]),
  day('Mon Nov 2', '2026-11-03T04:00:00Z', [['12:30am', 'AUD', 'Commodity Prices y/y'], ['All Day', 'JPY', 'Bank Holiday']]),
  day('Tue Nov 3', '2026-11-04T04:00:00Z', [['2:30am', 'CHF', 'CPI m/m']]),
  day('Wed Nov 4', '2026-11-05T04:00:00Z', [['3:00am', 'EUR', 'Spanish Unemployment Change']]),
  day('Thu Nov 5', '2026-11-06T04:00:00Z', [['1:45am', 'AUD', 'RBA Deputy Gov Hauser Speaks']]),
  day('Fri Nov 6', '2026-11-07T04:00:00Z', [['2:00am', 'EUR', 'German Industrial Production m/m'], ['8:30am', 'USD', 'Non-Farm Employment Change']]),
  emptyDay('Sat Nov 7', '2026-11-08T04:00:00Z'),
].join('\n')

// What the following week's page says about its own first day - correct,
// as the first day of every measured page is.
const NOV_8 = { date: '2026-11-08', dateline: Date.parse('2026-11-08T05:00:00Z') / 1000 }

describe('the week the clocks go back, as FF really serves it', () => {
  // German Industrial Production is published at 08:00 in Berlin, which is
  // 07:00Z and 2:00am in New York once the clocks have changed. That is
  // what FF prints. dateline + 2h is 2026-11-07T06:00Z - the wrong day AND
  // the wrong hour - and it is what was stored.
  it('places a release where FF printed it, not where the dateline points', () => {
    const page = parseCalendarHtml(AUTUMN_WEEK, { anchors: [NOV_8] })
    expect(at(page, 'German Industrial Production m/m')).toBe('2026-11-06T07:00:00.000Z')
    expect(at(page, 'Non-Farm Employment Change')).toBe('2026-11-06T13:30:00.000Z')
    expect(at(page, 'Commodity Prices y/y')).toBe('2026-11-02T05:30:00.000Z')
  })

  it('files every row under the day FF printed', () => {
    const page = parseCalendarHtml(AUTUMN_WEEK, { anchors: [NOV_8] })
    expect(page.events.find((e) => e.title === 'German Industrial Production m/m').detail_url)
      .toBe('https://www.forexfactory.com/calendar?day=nov6.2026')
    expect(page.untrustedDays).toEqual([])
    expect(page.untrustedRows).toBe(0)
  })

  // The changeover day itself runs 25 hours. Midnight is still EDT
  // (04:00Z); an evening row is EST.
  it('uses the real length of the 25-hour day', () => {
    const page = parseCalendarHtml(AUTUMN_WEEK, { anchors: [NOV_8] })
    expect(at(page, 'Evening Print')).toBe('2026-11-02T01:30:00.000Z')
    expect(page.dstDays).toBe(1)
    expect(page.coveredDays[0]).toEqual(['2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z'])
  })

  it('anchors an all-day row to the start of the day FF printed', () => {
    const page = parseCalendarHtml(AUTUMN_WEEK, { anchors: [NOV_8] })
    expect(at(page, 'Bank Holiday')).toBe('2026-11-02T05:00:00.000Z')
  })

  // THE SAFETY PROPERTY. On its own this page cannot say whether it was
  // rendered in New York or Puerto Rico: both are UTC-4 on the Sunday and
  // only one of them changes its clocks. The two answers differ by an
  // hour from Monday on, so nothing is stored - an unknown time is a gap,
  // a wrong one is a lie - and the caller is told which page settles it.
  it('stores nothing on a guess when the page alone cannot say which zone it is', () => {
    const page = parseCalendarHtml(AUTUMN_WEEK)
    expect(page.zoneAmbiguous).toBe(true)
    expect(page.events).toEqual([])
    expect(page.untrustedDays).toHaveLength(7)
    expect(page.untrustedDays.every((d) => d.reason === 'ambiguous')).toBe(true)
    expect(page.untrustedRows).toBe(9)
    expect(page.anchorAfter).toBe('2026-11-08')
  })

  // A page that cannot place its days must not be allowed to say which
  // events are ABSENT from them: every stored row on those days went
  // unrefreshed, and each one would read as "FF removed this".
  it('speaks for no day it could not place', () => {
    expect(parseCalendarHtml(AUTUMN_WEEK).coveredDays).toEqual([])
    expect(parseCalendarHtml(AUTUMN_WEEK).coveredFrom).toBeNull()
  })
})

// ?month=nov.2026 - the same disease across thirty days. This is the page
// that put 214 of November's 411 events on the wrong day in production.
describe('the month that starts on the changeover', () => {
  const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const NOVEMBER = Array.from({ length: 30 }, (_, i) => {
    const dom = i + 1
    // Measured: label "Nov <d>" beside 2026-11-<d+1>T04:00Z, all month.
    const dateline = new Date(Date.UTC(2026, 10, dom + 1, 4)).toISOString()
    const label = `${labels[new Date(Date.UTC(2026, 10, dom)).getUTCDay()]} Nov ${dom}`
    return day(label, dateline, [['8:30am', 'USD', `Release ${dom}`]])
  }).join('\n')

  // The daily sweep fetches the months either side in the same run, from
  // the same runner, so their first days are lent as anchors.
  const NEIGHBOURS = [
    { date: '2026-10-01', dateline: Date.parse('2026-10-01T04:00:00Z') / 1000 },
    { date: '2026-12-01', dateline: Date.parse('2026-12-01T05:00:00Z') / 1000 },
  ]

  it('places all thirty days, with no second request', () => {
    const page = parseCalendarHtml(NOVEMBER, { anchors: NEIGHBOURS })
    expect(page.untrustedDays).toEqual([])
    expect(page.events).toHaveLength(30)
    expect(page.zoneAmbiguous).toBe(false)
  })

  // 8:30am Eastern is 12:30Z on the Sunday (still EDT at midnight, EST by
  // 8:30) and 13:30Z on every day after it.
  it('puts every release on its own day at its own hour', () => {
    const page = parseCalendarHtml(NOVEMBER, { anchors: NEIGHBOURS })
    expect(at(page, 'Release 1')).toBe('2026-11-01T13:30:00.000Z')
    expect(at(page, 'Release 2')).toBe('2026-11-02T13:30:00.000Z')
    expect(at(page, 'Release 30')).toBe('2026-11-30T13:30:00.000Z')
    for (const e of page.events) {
      const dom = Number(e.title.split(' ')[1])
      expect(e.event_time.slice(0, 10)).toBe(`2026-11-${String(dom).padStart(2, '0')}`)
    }
  })

  // The symptom that surfaced all this: November's rows landing in
  // December's range and being reported as "17 rows FF has removed".
  it('keeps November out of December', () => {
    const page = parseCalendarHtml(NOVEMBER, { anchors: NEIGHBOURS })
    expect(page.events.every((e) => e.event_time < '2026-12-01T05:00:00.000Z')).toBe(true)
    expect(page.coveredTo).toBe('2026-11-30T05:00:00.000Z')
  })
})

// ?week=mar8.2026 - the other direction. No whole-day error here, which
// is what makes it the dangerous one: every dateline is plausible. FF
// stamps the Sunday's offset (05:00Z, EST) on all seven days; from Monday
// the true local midnight is 04:00Z.
describe('the week the clocks go forward, as FF really serves it', () => {
  const SPRING_WEEK = [
    day('Sun Mar 8', '2026-03-08T05:00:00Z', [['3:00am', 'CAD', 'Daylight Saving Time Shift'], ['5:00pm', 'NZD', 'Sunday Evening Print']]),
    day('Mon Mar 9', '2026-03-09T05:00:00Z', [['1:00am', 'JPY', 'Leading Indicators']]),
    day('Tue Mar 10', '2026-03-10T05:00:00Z', [['2:00am', 'JPY', 'Prelim Machine Tool Orders y/y']]),
    day('Wed Mar 11', '2026-03-11T05:00:00Z', [['3:00am', 'EUR', 'German Final CPI m/m']]),
    day('Thu Mar 12', '2026-03-12T05:00:00Z', [['5:00am', 'EUR', 'Italian Quarterly Unemployment Rate']]),
    day('Fri Mar 13', '2026-03-13T05:00:00Z', [['3:00am', 'EUR', 'German WPI m/m']]),
    emptyDay('Sat Mar 14', '2026-03-14T05:00:00Z'),
  ].join('\n')
  const MAR_15 = { date: '2026-03-15', dateline: Date.parse('2026-03-15T04:00:00Z') / 1000 }

  // Japan's Leading Indicators come out at 14:00 in Tokyo: 05:00Z, which
  // is 1:00am in New York on daylight time. dateline + 1h says 06:00Z.
  it('is not an hour late for the rest of the week', () => {
    const page = parseCalendarHtml(SPRING_WEEK, { anchors: [MAR_15] })
    expect(at(page, 'Leading Indicators')).toBe('2026-03-09T05:00:00.000Z')
    expect(at(page, 'German WPI m/m')).toBe('2026-03-13T07:00:00.000Z')
    expect(page.untrustedDays).toEqual([])
  })

  it('uses the real length of the 23-hour day', () => {
    const page = parseCalendarHtml(SPRING_WEEK, { anchors: [MAR_15] })
    // 5:00pm EDT on a day whose midnight was EST.
    expect(at(page, 'Sunday Evening Print')).toBe('2026-03-08T21:00:00.000Z')
    expect(page.coveredDays[0]).toEqual(['2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z'])
  })

  it('withholds the week rather than store it an hour out', () => {
    const page = parseCalendarHtml(SPRING_WEEK)
    expect(page.zoneAmbiguous).toBe(true)
    expect(page.events).toEqual([])
    expect(page.anchorAfter).toBe('2026-03-15')
  })
})

// ?week=nov29.2026 - an ordinary week, which is fifty of the fifty-two.
// Nothing above may cost it anything: no second request, no withheld day.
describe('an ordinary week', () => {
  const ORDINARY = [
    day('Sun Nov 29', '2026-11-29T05:00:00Z', [['All Day', 'ALL', 'OPEC-JMMC Meetings']]),
    day('Mon Nov 30', '2026-11-30T05:00:00Z', [['12:00am', 'JPY', 'Housing Starts y/y'], ['8:45am', 'USD', 'Chicago PMI']]),
    day('Tue Dec 1', '2026-12-01T05:00:00Z', [['12:30am', 'AUD', 'Commodity Prices y/y']]),
    day('Wed Dec 2', '2026-12-02T05:00:00Z', [['12:00am', 'JPY', 'Consumer Confidence']]),
    day('Thu Dec 3', '2026-12-03T05:00:00Z', [['3:15am', 'EUR', 'Spanish Services PMI']]),
    day('Fri Dec 4', '2026-12-04T05:00:00Z', [['2:45am', 'EUR', 'French Industrial Production m/m']]),
    emptyDay('Sat Dec 5', '2026-12-05T05:00:00Z'),
  ].join('\n')

  it('needs nothing but itself', () => {
    const page = parseCalendarHtml(ORDINARY)
    expect(page.zoneAmbiguous).toBe(false)
    expect(page.untrustedDays).toEqual([])
    expect(page.events).toHaveLength(7)
    expect(page.dstDays).toBe(0)
  })

  // Chicago PMI: the row this whole investigation started from. Stored at
  // 2026-12-01T13:45Z by the November page; it is released on the 30th.
  it('puts Chicago PMI on November 30', () => {
    expect(at(parseCalendarHtml(ORDINARY), 'Chicago PMI')).toBe('2026-11-30T13:45:00.000Z')
  })

  it('covers every day but the last', () => {
    const { coveredDays } = parseCalendarHtml(ORDINARY)
    expect(coveredDays).toHaveLength(6)
    expect(coveredDays[0]).toEqual(['2026-11-29T05:00:00.000Z', '2026-11-30T05:00:00.000Z'])
    expect(coveredDays[5]).toEqual(['2026-12-04T05:00:00.000Z', '2026-12-05T05:00:00.000Z'])
  })

  // An anchor lent by another page is the same caller in the same run, so
  // it should agree. If it flatly does not - a different egress IP mid-run
  // - the page is judged on its own evidence rather than left with no
  // zone at all.
  it('ignores a lent anchor that contradicts it', () => {
    const fromDenver = { date: '2026-11-22', dateline: Date.parse('2026-11-22T07:00:00Z') / 1000 }
    const page = parseCalendarHtml(ORDINARY, { anchors: [fromDenver] })
    expect(page.untrustedDays).toEqual([])
    expect(at(page, 'Chicago PMI')).toBe('2026-11-30T13:45:00.000Z')
  })
})

describe('datelines this parser does not understand', () => {
  // Neither a whole number of days from the day's start nor the first
  // day's stamp carried forward. Whatever it means, it is not something to
  // build an instant on - and one bad day must not take its neighbours
  // with it.
  it('withholds one inexplicable day and keeps the rest', () => {
    const html = [
      day('Mon Nov 30', '2026-11-30T05:00:00Z', [['8:45am', 'USD', 'Chicago PMI']]),
      day('Tue Dec 1', '2026-12-01T09:17:00Z', [['10:00am', 'USD', 'ISM Manufacturing PMI']]),
      day('Wed Dec 2', '2026-12-02T05:00:00Z', [['8:15am', 'USD', 'ADP Non-Farm Employment Change']]),
      day('Thu Dec 3', '2026-12-03T05:00:00Z', [['8:30am', 'USD', 'Unemployment Claims']]),
    ].join('\n')
    const page = parseCalendarHtml(html)
    expect(page.untrustedDays).toEqual([{ date: '2026-12-01', label: 'Tue Dec 1', reason: 'dateline-mismatch', rows: 1 }])
    expect(page.events.map((e) => e.title)).toEqual(['Chicago PMI', 'ADP Non-Farm Employment Change', 'Unemployment Claims'])
    // The withheld day gets no window, and neither does the day before a
    // window would have to end on it... the day before is still covered:
    // its own start and end are known. The withheld one is not.
    expect(page.coveredDays.map(([from]) => from.slice(0, 10))).toEqual(['2026-11-30', '2026-12-02'])
  })

  // A dateline that is midnight in no timezone on Earth.
  it('withholds everything when no zone fits at all', () => {
    const html = day('Mon Nov 30', '2026-11-30T05:07:13Z', [['8:45am', 'USD', 'Chicago PMI']])
    const page = parseCalendarHtml(html)
    expect(page.events).toEqual([])
    expect(page.untrustedDays[0].reason).toBe('no-zone')
    expect(page.oddDatelines).toBe(1)
    // Not "ambiguous": another page would not help, so none is asked for.
    expect(page.zoneAmbiguous).toBe(false)
  })

  // No readable date beside the dateline. The row is still stored - on an
  // ordinary day the arithmetic is right, and dropping every row because
  // a label moved would turn a cosmetic markup change into an outage -
  // but it has not been cross-checked, so it is counted, and the page may
  // not speak for what is absent from that day.
  it('stores an unlabelled day but will not vouch for it', () => {
    const labelled = day('Mon Nov 30', '2026-11-30T05:00:00Z', [['8:45am', 'USD', 'Chicago PMI']])
    const unlabelled = day('Tue Dec 1', '2026-12-01T05:00:00Z', [['10:00am', 'USD', 'ISM Manufacturing PMI']])
      .replace(/<td class="calendar__cell calendar__date"[\s\S]*?<\/td> /, '')
    const tail = day('Wed Dec 2', '2026-12-02T05:00:00Z', [['8:15am', 'USD', 'ADP']])
      + day('Thu Dec 3', '2026-12-03T05:00:00Z', [['8:30am', 'USD', 'Claims']])
    const page = parseCalendarHtml([labelled, unlabelled, tail].join('\n'))
    expect(at(page, 'ISM Manufacturing PMI')).toBe('2026-12-01T15:00:00.000Z')
    expect(page.unlabelledDays).toBe(1)
    expect(page.coveredDays.map(([from]) => from.slice(0, 10))).toEqual(['2026-11-30', '2026-12-02'])
  })
})

describe('readPageAnchor', () => {
  it('reads the first day FF rendered', () => {
    expect(readPageAnchor(AUTUMN_WEEK)).toEqual({
      date: '2026-11-01',
      dateline: Date.parse('2026-11-02T04:00:00Z') / 1000,
    })
  })

  // An anchor is lent to OTHER pages as evidence. One placed by dateline
  // arithmetic alone could be the whole-day-late dateline itself, which
  // is not evidence worth lending.
  it('lends nothing from a day with no printed date', () => {
    const bare = day('Mon Nov 30', '2026-11-30T05:00:00Z', [['8:45am', 'USD', 'Chicago PMI']])
      .replace(/<td class="calendar__cell calendar__date"[\s\S]*?<\/td> /, '')
    expect(readPageAnchor(bare)).toBeNull()
  })

  it('survives anything that is not a calendar', () => {
    expect(readPageAnchor('<html>Just a moment...</html>')).toBeNull()
    expect(readPageAnchor(null)).toBeNull()
  })
})
