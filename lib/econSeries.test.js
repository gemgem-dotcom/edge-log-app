import { describe, it, expect } from 'vitest'
import {
  seriesFor, isMonthly, periodKey, monthlyDesc, monthOverMonth,
  isPreliminary, revisionsBetween, parseSeriesResponse,
} from './econSeries.mjs'

// The figures below are the ones the live API actually returned on
// 2026-10-28 (scripts/probe-econ-sources.js, run from a GitHub runner),
// not invented numbers that happen to divide nicely.
const LIVE_SHELTER = [
  { year: '2026', period: 'M09', periodName: 'September', value: '431.908', footnotes: [] },
  { year: '2026', period: 'M08', periodName: 'August', value: '430.227', footnotes: [] },
]
const LIVE_OER = [
  { year: '2026', period: 'M09', periodName: 'September', value: '445.265', footnotes: [] },
  { year: '2026', period: 'M08', periodName: 'August', value: '443.713', footnotes: [] },
]
const LIVE_NFP = [
  { year: '2026', period: 'M09', periodName: 'September', value: '159044', footnotes: [{ code: 'P', text: 'preliminary' }] },
  { year: '2026', period: 'M08', periodName: 'August', value: '159015', footnotes: [{ code: 'P', text: 'preliminary' }] },
]

describe('seriesFor', () => {
  it('sends core CPI to the two shelter series', () => {
    expect(seriesFor('Core CPI m/m')).toEqual(['CUSR0000SAH1', 'CUSR0000SEHC'])
  })
  it('matches core BEFORE headline, or every core print gets the headline list', () => {
    expect(seriesFor('Core CPI m/m')).not.toContain('CUUR0000SA0')
    expect(seriesFor('CPI m/m')).toContain('CUUR0000SA0')
  })
  it('matches payrolls by any of the names FF uses', () => {
    for (const t of ['Non-Farm Employment Change', 'NFP', 'ADP Non-Farm Employment Change']) {
      expect(seriesFor(t)).toEqual(['CES0000000001'])
    }
  })
  it('returns nothing for a release it has no series for', () => {
    expect(seriesFor('Unemployment Claims')).toEqual([])
    expect(seriesFor('')).toEqual([])
    expect(seriesFor(null)).toEqual([])
  })
})

describe('isMonthly', () => {
  it('accepts M01 through M12', () => {
    for (let i = 1; i <= 12; i++) expect(isMonthly(`M${String(i).padStart(2, '0')}`)).toBe(true)
  })
  // M13 is an ANNUAL AVERAGE. Treated as a month it sorts after December
  // and becomes "the latest print", which would quietly turn a yearly
  // mean into this month's number.
  it('rejects M13, the annual average', () => {
    expect(isMonthly('M13')).toBe(false)
  })
  it('rejects quarters, junk and nothing', () => {
    for (const p of ['Q01', 'A01', 'M00', 'M1', '', null, undefined]) expect(isMonthly(p)).toBe(false)
  })
})

describe('periodKey / monthlyDesc', () => {
  it('orders across a year boundary', () => {
    expect(periodKey({ year: '2026', period: 'M01' })).toBeGreaterThan(periodKey({ year: '2025', period: 'M12' }))
  })
  it('sorts newest first and drops annual averages', () => {
    const rows = [
      { year: '2026', period: 'M13', value: '1' },
      { year: '2025', period: 'M12', value: '2' },
      { year: '2026', period: 'M09', value: '3' },
    ]
    expect(monthlyDesc(rows).map((r) => r.period)).toEqual(['M09', 'M12'])
  })
  it('drops rows whose value is not a number', () => {
    const rows = [{ year: '2026', period: 'M09', value: '-' }, { year: '2026', period: 'M08', value: '2' }]
    expect(monthlyDesc(rows)).toHaveLength(1)
  })
})

describe('monthOverMonth', () => {
  it('computes the live shelter and OER rates', () => {
    expect(monthOverMonth(LIVE_SHELTER).percent).toBe(0.39)
    expect(monthOverMonth(LIVE_OER).percent).toBe(0.35)
  })
  // The whole point of the OER line: it is not moving with shelter
  // overall, and the difference is the story.
  it('shows OER running cooler than shelter in the live month', () => {
    expect(monthOverMonth(LIVE_OER).percent).toBeLessThan(monthOverMonth(LIVE_SHELTER).percent)
  })
  it('carries the preliminary flag through from the latest row', () => {
    expect(monthOverMonth(LIVE_NFP).preliminary).toBe(true)
    expect(monthOverMonth(LIVE_SHELTER).preliminary).toBe(false)
  })
  // null, not 0 - a caller must not be able to print "unchanged" for
  // "there was nothing to compare".
  it('returns null rather than zero when it cannot compare', () => {
    expect(monthOverMonth([LIVE_SHELTER[0]])).toBeNull()
    expect(monthOverMonth([])).toBeNull()
    expect(monthOverMonth(null)).toBeNull()
  })
  it('returns null rather than dividing by a zero prior', () => {
    expect(monthOverMonth([
      { year: '2026', period: 'M09', value: '5' },
      { year: '2026', period: 'M08', value: '0' },
    ])).toBeNull()
  })
  it('ignores an annual average sitting at the top of the list', () => {
    const withAnnual = [{ year: '2026', period: 'M13', value: '999' }, ...LIVE_SHELTER]
    expect(monthOverMonth(withAnnual).percent).toBe(0.39)
  })
})

describe('isPreliminary', () => {
  it('reads BLS footnote code P', () => {
    expect(isPreliminary(LIVE_NFP[0])).toBe(true)
  })
  it('is false for an empty or missing footnote list', () => {
    expect(isPreliminary({ footnotes: [] })).toBe(false)
    expect(isPreliminary({})).toBe(false)
    // the live API sends [{}] - an empty object - on unfootnoted rows
    expect(isPreliminary({ footnotes: [{}] })).toBe(false)
  })
})

describe('revisionsBetween', () => {
  it('reports a value that moved, with both numbers', () => {
    const before = [{ year: '2026', period: 'M08', periodName: 'August', value: '159015' }]
    const after = [{ year: '2026', period: 'M08', periodName: 'August', value: '158880' }]
    expect(revisionsBetween(before, after)).toEqual([
      { year: '2026', period: 'M08', periodName: 'August', from: 159015, to: 158880, delta: -135 },
    ])
  })
  // A NEW month is not a revision. Without this the first fetch after a
  // release would report the whole print as "revised".
  it('does not call a newly arrived month a revision', () => {
    const before = [{ year: '2026', period: 'M08', value: '159015' }]
    const after = [{ year: '2026', period: 'M09', value: '159044' }, { year: '2026', period: 'M08', value: '159015' }]
    expect(revisionsBetween(before, after)).toEqual([])
  })
  it('ignores a period that has fallen out of the fetch window', () => {
    const before = [{ year: '2025', period: 'M01', value: '1' }, { year: '2026', period: 'M08', value: '2' }]
    const after = [{ year: '2026', period: 'M08', value: '2' }]
    expect(revisionsBetween(before, after)).toEqual([])
  })
  it('reports several revisions newest first', () => {
    const before = [
      { year: '2026', period: 'M08', value: '100' },
      { year: '2026', period: 'M07', value: '200' },
    ]
    const after = [
      { year: '2026', period: 'M08', value: '101' },
      { year: '2026', period: 'M07', value: '199' },
    ]
    expect(revisionsBetween(before, after).map((r) => r.period)).toEqual(['M08', 'M07'])
  })
  it('is empty when nothing moved', () => {
    expect(revisionsBetween(LIVE_NFP, LIVE_NFP)).toEqual([])
  })
})

describe('parseSeriesResponse', () => {
  // Shape copied from the live response, including the [{}] footnote.
  const live = {
    status: 'REQUEST_SUCCEEDED',
    responseTime: 113,
    message: [],
    Results: {
      series: [{
        seriesID: 'CUUR0000SA0',
        data: [
          { year: '2026', period: 'M09', periodName: 'September', latest: 'true', value: '336.940', footnotes: [{}] },
          { year: '2026', period: 'M08', periodName: 'August', value: '334.980', footnotes: [{}] },
        ],
      }],
    },
  }

  it('flattens to seriesId -> rows', () => {
    const out = parseSeriesResponse(live)
    expect(Object.keys(out)).toEqual(['CUUR0000SA0'])
    expect(out.CUUR0000SA0).toHaveLength(2)
    expect(out.CUUR0000SA0[0].value).toBe('336.940')
  })
  it('drops the empty footnote objects the API pads with', () => {
    expect(parseSeriesResponse(live).CUUR0000SA0[0].footnotes).toEqual([])
  })
  // null, not {} - "the request failed" and "the series is empty" are
  // different facts and the caller has to be able to tell them apart.
  it('returns null on a failed request', () => {
    expect(parseSeriesResponse({ status: 'REQUEST_NOT_PROCESSED' })).toBeNull()
    expect(parseSeriesResponse({ status: 'REQUEST_SUCCEEDED' })).toBeNull()
    expect(parseSeriesResponse(null)).toBeNull()
  })
  it('survives a series entry with no data array', () => {
    const out = parseSeriesResponse({ status: 'REQUEST_SUCCEEDED', Results: { series: [{ seriesID: 'X' }] } })
    expect(out).toEqual({ X: [] })
  })
})

describe('seriesFor refuses non-US titles', () => {
  it('does not hand a German or UK CPI print the US series', () => {
    for (const t of ['German Prelim CPI m/m', 'UK CPI y/y', 'Spanish Flash CPI y/y', 'Canadian Employment Change']) {
      expect(seriesFor(t)).toEqual([])
    }
  })
})
