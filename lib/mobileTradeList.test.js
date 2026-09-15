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
