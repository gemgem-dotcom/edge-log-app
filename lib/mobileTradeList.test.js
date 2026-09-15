import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { hasResult } from '@/lib/tradeMath'

// MobileTradeList is a component, and this runner cannot parse JSX - so
// these assert the two invariants that have now each been violated once,
// by reading the source. Crude, but a crude test that catches a shipped
// bug beats an elegant one that cannot run.
const SRC = readFileSync(resolve(process.cwd(), 'components/mobile/MobileTradeList.js'), 'utf8')

describe('MobileTradeList: result classification', () => {
  // The mobile list must decide win/loss/breakeven/open the same way the
  // desktop table does - via hasResult (r_multiple non-null), NOT via
  // exit_price. CLAUDE.md is explicit that r_multiple stays nullable for
  // rows predating the mandatory-exit rule, and the first version of this
  // component read a legacy row as 'breakeven' while desktop read 'Open'.
  it('keys off hasResult, not exit_price', () => {
    const fn = /function resultOf\(trade\) \{[\s\S]*?\n\}/.exec(SRC)
    expect(fn, 'resultOf should exist').not.toBeNull()
    expect(fn[0]).toContain('hasResult(trade)')
    expect(fn[0]).not.toContain('exit_price')
  })

  // The rule it has to agree with, pinned here so a change to hasResult
  // shows up as a failure in both places rather than silently diverging.
  it('agrees with hasResult about a legacy row', () => {
    expect(hasResult({ r_multiple: null, exit_price: 21000 })).toBe(false)
    expect(hasResult({ r_multiple: 0 })).toBe(true)
  })
})

describe('MobileTradeList: filtering to zero results', () => {
  // The empty state is for "no trades at all". Returning it for "no
  // trades MATCHING" too removed the toolbar that holds the Filter
  // button - the only way back to the sheet - stranding the trader on a
  // screen that also claimed they had never logged a trade.
  it('only shows the empty state when nothing is filtered', () => {
    expect(SRC).toMatch(/if \(!trades\.length && !filtered\)/)
  })

  it('has a distinct message for a filtered-to-empty list', () => {
    expect(SRC).toContain('No trades match these filters.')
  })
})

describe('MobileTradeList: links', () => {
  // A link that resolves to nothing is the one navigation failure a user
  // cannot work around. The all-instruments log has no page-level symbol,
  // so the edit href must come from the row and be omitted when neither
  // is available - never interpolated blindly.
  it('never interpolates a symbol into an edit href without a guard', () => {
    const fn = /function editHrefFor\([\s\S]*?\n\}/.exec(SRC)
    expect(fn).not.toBeNull()
    expect(fn[0]).toMatch(/return s \?/)
  })
})


// FIELD PARITY with the desktop expanded row.
//
// This is the test that should have existed first. The mobile card
// replaced a desktop table whose failing was that it HID DATA at 390px -
// and then shipped showing six of the desktop's nine fields, so MFE, MAE,
// time in drawdown, realised R, the entry time, the stop and target
// distances, the per-leg R and every screenshot were invisible on a
// phone. Replacing a table that hides data with a card that hides a
// different subset is not a fix, and nothing caught it because both
// surfaces "looked fine".
//
// Source-scanned rather than rendered, for the reason at the top of this
// file: the runner cannot parse JSX. It reads the labels out of each
// component's own expanded block, so adding a field to the desktop
// without adding it here fails.
const TABLE_SRC = readFileSync(resolve(process.cwd(), 'components/TradeLogTable.js'), 'utf8')

// The desktop's expanded block, from its detail grid to the closing of
// the expand row - so labels elsewhere in that large file (filters,
// column headers) are not swept in.
function desktopExpandedBlock() {
  const start = TABLE_SRC.indexOf('trade-expand-grid')
  const end = TABLE_SRC.indexOf('screenshot-grid', start)
  expect(start, 'desktop expand grid should exist').toBeGreaterThan(-1)
  expect(end, 'desktop screenshot grid should exist').toBeGreaterThan(start)
  return TABLE_SRC.slice(start, end)
}

function labelsIn(src, re) {
  return [...src.matchAll(re)].map((m) => m[1].trim()).filter(Boolean)
}

describe('MobileTradeList: expanded-row field parity', () => {
  it('shows every field the desktop expanded row shows', () => {
    const desktop = labelsIn(desktopExpandedBlock(), /<label>([^<{]+)<\/label>/g)
    // The desktop wraps two of them in a tooltip row rather than a plain
    // label, so pick those up too.
    const tooltipped = labelsIn(desktopExpandedBlock(), /field-label-row"><label>([^<]+)<\/label>/g)
    const expected = [...new Set([...desktop, ...tooltipped])]
    expect(expected.length, 'expected to find the desktop labels').toBeGreaterThanOrEqual(8)

    const mobile = labelsIn(SRC, /<dt>([^<{]*)/g).map((l) => l.trim()).filter(Boolean)
    // Mobile renders the exit label conditionally, so it appears as an
    // expression rather than as text - assert both of its forms directly.
    expect(SRC).toContain("multiExit ? 'Exit legs' : 'Exit price'")

    for (const label of expected) {
      if (label === 'Exit legs' || label === 'Exit price') continue
      expect(
        mobile.some((m) => m === label),
        `mobile expanded row is missing the desktop field "${label}" (has: ${mobile.join(', ')})`,
      ).toBe(true)
    }
  })

  // The three blocks below the grid, and the screenshots - all of which
  // the desktop has and the first mobile version did not.
  it.each([
    ['discipline tags', 'discipline_tags'],
    ['tags', 'trade.tags'],
    ['notes', 'trade.reasoning'],
    ['screenshots', 'ScreenshotThumb'],
  ])('renders %s', (_name, needle) => {
    expect(SRC).toContain(needle)
  })

  // Both row actions the desktop has. Mobile shipped with only Edit, so
  // there was no way to delete a trade from a phone at all.
  it('offers both Edit and Delete', () => {
    expect(SRC).toContain('m-trade-edit')
    expect(SRC).toContain('m-trade-delete')
  })

  // Every R figure routes through lib/tradeMath, per CLAUDE.md, so a
  // displayed number cannot drift from the stored one.
  it('computes per-leg R through the shared implementation', () => {
    expect(SRC).toContain('calcRMultiple(')
    expect(SRC).toContain('calcRiskReward(')
  })

  // Excursion cells go through the one shared helper rather than a second
  // copy of its fallback rules - which is why it was moved out of
  // TradeLogTable into lib/tradeExcursions.js.
  it('uses the shared excursionCell rather than reimplementing it', () => {
    expect(SRC).toContain('excursionCell(')
    expect(SRC).not.toMatch(/function excursionCell/)
  })
})

// The day column. The desktop puts the weekday in its own fixed-width
// column; the mobile row shares a sub-line with the time, where a
// full name makes every row a different shape.
describe('MobileTradeList: weekday abbreviation', () => {
  it('uses three-letter days', () => {
    const arr = /const SHORT_DAYS = \[([^\]]+)\]/.exec(SRC)
    expect(arr, 'SHORT_DAYS should exist').not.toBeNull()
    const days = arr[1].split(',').map((d) => d.trim().replace(/'/g, ''))
    expect(days).toHaveLength(7)
    for (const d of days) expect(d, `${d} should be 3 letters`).toHaveLength(3)
    expect(days[0]).toBe('SUN')
  })
})
